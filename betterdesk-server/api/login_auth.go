package api

import (
	"log"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

// passwordLoginStatus classifies the outcome of username+password authentication.
type passwordLoginStatus int

const (
	passwordLoginOK passwordLoginStatus = iota
	passwordLoginInvalid
	passwordLoginOIDC
	passwordLoginInternal
)

// passwordLoginResult holds the resolved user after provider-bound authentication
// (Issue #148). Used by panel /api/auth/login and RustDesk client /api/login.
type passwordLoginResult struct {
	User       *db.User
	Status     passwordLoginStatus
	AuthMethod string // "ldap" when authenticated via LDAP; empty for local
}

// authenticatePasswordLogin validates credentials using the same provider-bound
// rules as the web panel: OIDC accounts reject password login; LDAP-bound and
// unknown users authenticate via LDAP when enabled; local accounts use local
// hash only (no LDAP fallthrough).
func (s *Server) authenticatePasswordLogin(username, password, clientIP string) passwordLoginResult {
	user, err := s.db.GetUser(username)
	if err != nil {
		return passwordLoginResult{Status: passwordLoginInternal}
	}

	provider := db.AuthProviderLocal
	if user != nil && user.AuthProvider != "" {
		provider = user.AuthProvider
	}

	if user != nil && provider == db.AuthProviderOIDC {
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, username, map[string]string{"reason": "oidc_account_password_login"})
		}
		return passwordLoginResult{Status: passwordLoginOIDC}
	}

	ldapEnabled := s.ldapProvider != nil && s.ldapProvider.IsEnabled()

	if ldapEnabled && (user == nil || provider == db.AuthProviderLDAP) {
		ldapResult, ldapErr := s.ldapProvider.Authenticate(username, password)
		if ldapErr != nil {
			log.Printf("[LDAP] Auth error for %s: %v", username, ldapErr)
			ldapResult = nil
		}

		if ldapResult != nil && ldapResult.Authenticated {
			role := ldapResult.Role
			if role == "" {
				role = auth.RoleViewer
			}

			if user == nil {
				randomSecret, randErr := auth.GenerateRandomString(32)
				if randErr != nil {
					return passwordLoginResult{Status: passwordLoginInternal}
				}
				unusable, hashErr := auth.HashPassword(randomSecret)
				if hashErr != nil {
					return passwordLoginResult{Status: passwordLoginInternal}
				}
				newUser := &db.User{
					Username:     username,
					PasswordHash: unusable,
					Role:         role,
					AuthProvider: db.AuthProviderLDAP,
				}
				if createErr := s.db.CreateUser(newUser); createErr != nil {
					log.Printf("[LDAP] Failed to auto-create user %s: %v", username, createErr)
					return passwordLoginResult{Status: passwordLoginInternal}
				}
				user, _ = s.db.GetUser(username)
				if user == nil {
					return passwordLoginResult{Status: passwordLoginInternal}
				}
				log.Printf("[LDAP] Auto-provisioned user %s with role %s", username, role)
			} else {
				changed := false
				if ldapResult.Role != "" && ldapResult.Role != user.Role {
					user.Role = ldapResult.Role
					changed = true
					log.Printf("[LDAP] Updated role for %s to %s", username, ldapResult.Role)
				}
				if user.AuthProvider != db.AuthProviderLDAP {
					user.AuthProvider = db.AuthProviderLDAP
					changed = true
				}
				if changed {
					_ = s.db.UpdateUser(user)
				}
			}

			if s.auditLog != nil {
				s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username, map[string]string{"method": "ldap"})
			}
			return passwordLoginResult{User: user, Status: passwordLoginOK, AuthMethod: "ldap"}
		}

		if user != nil && provider == db.AuthProviderLDAP {
			if s.auditLog != nil {
				s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, username, map[string]string{"method": "ldap"})
			}
			return passwordLoginResult{Status: passwordLoginInvalid}
		}
	}

	if user == nil || provider != db.AuthProviderLocal || !auth.VerifyPassword(user.PasswordHash, password) {
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, username, nil)
		}
		return passwordLoginResult{Status: passwordLoginInvalid}
	}

	if auth.NeedsRehash(user.PasswordHash) {
		if newHash, hashErr := auth.HashPassword(password); hashErr == nil {
			user.PasswordHash = newHash
			_ = s.db.UpdateUser(user)
			log.Printf("[auth] Rehashed password for %s (migrated to PBKDF2)", user.Username)
		}
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username, nil)
	}

	return passwordLoginResult{User: user, Status: passwordLoginOK}
}
