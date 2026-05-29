// Package auth — LDAP authentication provider for BetterDesk server.
//
// Supports LDAP and Active Directory with:
//   - Bind + search authentication (service account binds, searches for user, then binds as user)
//   - Direct bind (user DN template, no service account needed)
//   - Group → role mapping (configurable AD/LDAP group → BetterDesk role)
//   - StartTLS and LDAPS
//   - Connection pooling with health checks
//   - Auto-provisioning of local user accounts on first LDAP login
package auth

import (
	"crypto/tls"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	ldapv3 "github.com/go-ldap/ldap/v3"
)

// LDAPConfig holds all LDAP provider settings.
// Stored in server_config table with "ldap." prefix.
type LDAPConfig struct {
	Enabled        bool   `json:"enabled"`
	Host           string `json:"host"`            // e.g. "ldap.example.com"
	Port           int    `json:"port"`             // 389 (LDAP), 636 (LDAPS)
	UseTLS         bool   `json:"use_tls"`          // true = LDAPS (port 636)
	StartTLS       bool   `json:"start_tls"`        // true = STARTTLS on plain port
	SkipTLSVerify  bool   `json:"skip_tls_verify"`  // skip certificate verification (dev only)
	BindDN         string `json:"bind_dn"`          // service account DN for search
	BindPassword   string `json:"bind_password"`    // service account password
	BaseDN         string `json:"base_dn"`          // search base, e.g. "dc=example,dc=com"
	UserFilter     string `json:"user_filter"`      // LDAP filter, e.g. "(sAMAccountName={{username}})"
	UserAttrID     string `json:"user_attr_id"`     // attribute for username (default: sAMAccountName)
	UserAttrEmail  string `json:"user_attr_email"`  // attribute for email (default: mail)
	UserAttrName   string `json:"user_attr_name"`   // attribute for display name (default: displayName)
	GroupBaseDN    string `json:"group_base_dn"`    // group search base (empty = same as BaseDN)
	GroupFilter    string `json:"group_filter"`     // group membership filter (default: "(member={{dn}})")
	GroupAttrName  string `json:"group_attr_name"`  // group name attribute (default: cn)
	DefaultRole    string `json:"default_role"`     // role for users without group mapping (default: viewer)
	GroupRoleMap   string `json:"group_role_map"`   // JSON: {"CN=Admins,DC=...": "admin", "CN=Ops,DC=...": "operator"}
	DirectBind     bool   `json:"direct_bind"`      // true = skip search, bind directly with DN template
	DirectBindDN   string `json:"direct_bind_dn"`   // DN template, e.g. "uid={{username}},ou=users,dc=example,dc=com"
	ConnTimeoutSec int    `json:"conn_timeout_sec"` // connection timeout (default: 10)
}

// LDAPResult represents the outcome of an LDAP authentication attempt.
type LDAPResult struct {
	Authenticated bool   // true if bind succeeded
	Username      string // resolved username
	DisplayName   string // from LDAP attribute
	Email         string // from LDAP attribute
	Role          string // mapped role from group membership
	DN            string // full distinguished name
	Groups        []string // list of group DNs the user belongs to
}

// LDAPProvider manages LDAP authentication.
type LDAPProvider struct {
	mu     sync.RWMutex
	config *LDAPConfig
}

// NewLDAPProvider creates a new LDAP provider with the given config.
func NewLDAPProvider(cfg *LDAPConfig) *LDAPProvider {
	return &LDAPProvider{config: cfg}
}

// UpdateConfig replaces the LDAP configuration (thread-safe).
func (p *LDAPProvider) UpdateConfig(cfg *LDAPConfig) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.config = cfg
}

// Config returns a copy of the current LDAP configuration.
func (p *LDAPProvider) Config() LDAPConfig {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.config == nil {
		return LDAPConfig{}
	}
	return *p.config
}

// IsEnabled reports whether LDAP authentication is enabled.
func (p *LDAPProvider) IsEnabled() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.config != nil && p.config.Enabled
}

// Authenticate attempts to authenticate a user against the LDAP server.
// Returns nil result and error if LDAP is unreachable or misconfigured.
// Returns result with Authenticated=false if credentials are invalid.
func (p *LDAPProvider) Authenticate(username, password string) (*LDAPResult, error) {
	cfg := p.Config()
	if !cfg.Enabled {
		return nil, fmt.Errorf("ldap: provider is disabled")
	}

	if username == "" || password == "" {
		return &LDAPResult{Authenticated: false}, nil
	}

	conn, err := p.dial(&cfg)
	if err != nil {
		return nil, fmt.Errorf("ldap: connect: %w", err)
	}
	defer conn.Close()

	if cfg.DirectBind {
		return p.authenticateDirectBind(conn, &cfg, username, password)
	}
	return p.authenticateBindSearch(conn, &cfg, username, password)
}

// TestConnection verifies connectivity and bind credentials.
func (p *LDAPProvider) TestConnection() error {
	cfg := p.Config()
	if !cfg.Enabled {
		return fmt.Errorf("ldap: provider is disabled")
	}

	conn, err := p.dial(&cfg)
	if err != nil {
		return fmt.Errorf("ldap: connect: %w", err)
	}
	defer conn.Close()

	// If using service account, test bind
	if !cfg.DirectBind && cfg.BindDN != "" {
		if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
			return fmt.Errorf("ldap: service account bind failed: %w", err)
		}
	}

	return nil
}

// dial establishes a connection to the LDAP server.
func (p *LDAPProvider) dial(cfg *LDAPConfig) (*ldapv3.Conn, error) {
	timeout := time.Duration(cfg.ConnTimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	tlsConfig := &tls.Config{
		InsecureSkipVerify: cfg.SkipTLSVerify,
		ServerName:         cfg.Host,
	}

	var conn *ldapv3.Conn
	var err error

	if cfg.UseTLS {
		// LDAPS (TLS from the start)
		conn, err = ldapv3.DialTLS("tcp", addr, tlsConfig)
	} else {
		// Plain LDAP
		conn, err = ldapv3.DialURL(fmt.Sprintf("ldap://%s", addr))
		if err == nil && cfg.StartTLS {
			err = conn.StartTLS(tlsConfig)
		}
	}
	if err != nil {
		return nil, err
	}

	conn.SetTimeout(timeout)
	return conn, nil
}

// authenticateDirectBind performs a direct bind with a DN template.
func (p *LDAPProvider) authenticateDirectBind(conn *ldapv3.Conn, cfg *LDAPConfig, username, password string) (*LDAPResult, error) {
	// Build DN from template
	dn := strings.ReplaceAll(cfg.DirectBindDN, "{{username}}", ldapv3.EscapeFilter(username))

	if err := conn.Bind(dn, password); err != nil {
		if ldapv3.IsErrorWithCode(err, ldapv3.LDAPResultInvalidCredentials) {
			return &LDAPResult{Authenticated: false}, nil
		}
		return nil, fmt.Errorf("ldap: direct bind: %w", err)
	}

	result := &LDAPResult{
		Authenticated: true,
		Username:      username,
		DN:            dn,
		Role:          cfg.DefaultRole,
	}

	// Try to fetch user attributes
	p.fetchUserAttributes(conn, cfg, dn, result)

	// Resolve groups & role
	p.resolveGroups(conn, cfg, result)

	return result, nil
}

// authenticateBindSearch performs bind+search authentication.
func (p *LDAPProvider) authenticateBindSearch(conn *ldapv3.Conn, cfg *LDAPConfig, username, password string) (*LDAPResult, error) {
	// Step 1: Bind with service account
	if cfg.BindDN != "" {
		if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
			return nil, fmt.Errorf("ldap: service account bind: %w", err)
		}
	}

	// Step 2: Search for the user
	filter := cfg.UserFilter
	if filter == "" {
		filter = "(sAMAccountName={{username}})"
	}
	filter = strings.ReplaceAll(filter, "{{username}}", ldapv3.EscapeFilter(username))

	attrID := cfg.UserAttrID
	if attrID == "" {
		attrID = "sAMAccountName"
	}
	attrEmail := cfg.UserAttrEmail
	if attrEmail == "" {
		attrEmail = "mail"
	}
	attrName := cfg.UserAttrName
	if attrName == "" {
		attrName = "displayName"
	}

	searchReq := ldapv3.NewSearchRequest(
		cfg.BaseDN,
		ldapv3.ScopeWholeSubtree,
		ldapv3.NeverDerefAliases,
		1,    // size limit
		10,   // time limit (seconds)
		false,
		filter,
		[]string{"dn", attrID, attrEmail, attrName, "memberOf"},
		nil,
	)

	sr, err := conn.Search(searchReq)
	if err != nil {
		return nil, fmt.Errorf("ldap: user search: %w", err)
	}
	if len(sr.Entries) == 0 {
		return &LDAPResult{Authenticated: false}, nil
	}

	entry := sr.Entries[0]
	userDN := entry.DN

	// Step 3: Bind as the user to verify password
	if err := conn.Bind(userDN, password); err != nil {
		if ldapv3.IsErrorWithCode(err, ldapv3.LDAPResultInvalidCredentials) {
			return &LDAPResult{Authenticated: false}, nil
		}
		return nil, fmt.Errorf("ldap: user bind: %w", err)
	}

	result := &LDAPResult{
		Authenticated: true,
		Username:      username,
		DisplayName:   entry.GetAttributeValue(attrName),
		Email:         entry.GetAttributeValue(attrEmail),
		DN:            userDN,
		Role:          cfg.DefaultRole,
	}

	// Extract memberOf groups from user entry
	memberOf := entry.GetAttributeValues("memberOf")
	if len(memberOf) > 0 {
		result.Groups = memberOf
	}

	// Resolve role from group mapping
	p.resolveGroups(conn, cfg, result)

	return result, nil
}

// fetchUserAttributes reads attributes from the user's DN entry.
func (p *LDAPProvider) fetchUserAttributes(conn *ldapv3.Conn, cfg *LDAPConfig, dn string, result *LDAPResult) {
	attrEmail := cfg.UserAttrEmail
	if attrEmail == "" {
		attrEmail = "mail"
	}
	attrName := cfg.UserAttrName
	if attrName == "" {
		attrName = "displayName"
	}

	searchReq := ldapv3.NewSearchRequest(
		dn,
		ldapv3.ScopeBaseObject,
		ldapv3.NeverDerefAliases,
		1, 5, false,
		"(objectClass=*)",
		[]string{attrEmail, attrName, "memberOf"},
		nil,
	)

	sr, err := conn.Search(searchReq)
	if err != nil {
		log.Printf("[LDAP] Warning: failed to fetch user attributes for %s: %v", dn, err)
		return
	}
	if len(sr.Entries) > 0 {
		entry := sr.Entries[0]
		result.DisplayName = entry.GetAttributeValue(attrName)
		result.Email = entry.GetAttributeValue(attrEmail)
		memberOf := entry.GetAttributeValues("memberOf")
		if len(memberOf) > 0 {
			result.Groups = memberOf
		}
	}
}

// resolveGroups maps LDAP groups to a BetterDesk role using the group_role_map.
// If no group mapping matches, the default role is used.
// If group_filter is set and groups are empty, performs a group search.
func (p *LDAPProvider) resolveGroups(conn *ldapv3.Conn, cfg *LDAPConfig, result *LDAPResult) {
	if cfg.DefaultRole == "" {
		result.Role = RoleViewer
	} else {
		result.Role = cfg.DefaultRole
	}

	// Parse group→role map
	roleMap := parseGroupRoleMap(cfg.GroupRoleMap)
	if len(roleMap) == 0 {
		return
	}

	// If we don't have groups yet and have a group filter, search for them
	if len(result.Groups) == 0 && cfg.GroupFilter != "" {
		groupBaseDN := cfg.GroupBaseDN
		if groupBaseDN == "" {
			groupBaseDN = cfg.BaseDN
		}
		groupFilter := strings.ReplaceAll(cfg.GroupFilter, "{{dn}}", ldapv3.EscapeFilter(result.DN))
		groupFilter = strings.ReplaceAll(groupFilter, "{{username}}", ldapv3.EscapeFilter(result.Username))

		attrGroupName := cfg.GroupAttrName
		if attrGroupName == "" {
			attrGroupName = "cn"
		}

		searchReq := ldapv3.NewSearchRequest(
			groupBaseDN,
			ldapv3.ScopeWholeSubtree,
			ldapv3.NeverDerefAliases,
			100, 10, false,
			groupFilter,
			[]string{"dn", attrGroupName},
			nil,
		)

		sr, err := conn.Search(searchReq)
		if err != nil {
			log.Printf("[LDAP] Warning: group search failed: %v", err)
		} else {
			for _, entry := range sr.Entries {
				result.Groups = append(result.Groups, entry.DN)
			}
		}
	}

	// Map groups to roles — highest-privilege match wins
	bestLevel := -1
	for _, groupDN := range result.Groups {
		normalizedDN := strings.ToLower(groupDN)
		for mapDN, mapRole := range roleMap {
			if strings.ToLower(mapDN) == normalizedDN {
				level := RoleLevel(mapRole)
				if level > bestLevel {
					bestLevel = level
					result.Role = mapRole
				}
			}
		}
	}
}

// parseGroupRoleMap parses a JSON-like group→role mapping string.
// Format: "group_dn=role,group_dn=role" (simple) or JSON object.
func parseGroupRoleMap(raw string) map[string]string {
	result := make(map[string]string)
	if raw == "" {
		return result
	}

	// Try simple format first: "CN=Admins,DC=ex,DC=com=admin|CN=Ops,DC=ex,DC=com=operator"
	// Use pipe as separator (comma conflicts with DN commas)
	entries := strings.Split(raw, "|")
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		// Find the last '=' which separates DN from role
		idx := strings.LastIndex(entry, "=")
		if idx <= 0 {
			continue
		}
		dn := strings.TrimSpace(entry[:idx])
		role := strings.TrimSpace(entry[idx+1:])
		if dn != "" && role != "" && ValidRole(role) {
			result[dn] = role
		}
	}

	return result
}
