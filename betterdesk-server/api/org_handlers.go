// Organization management REST API handlers (v3.0.0).
//
// Endpoints:
//   POST   /api/org                  — create organization
//   GET    /api/org                  — list organizations
//   GET    /api/org/{id}             — get organization details
//   PUT    /api/org/{id}             — update organization
//   DELETE /api/org/{id}             — delete organization
//   GET    /api/org/{id}/users       — list org users
//   POST   /api/org/{id}/users       — add user to org
//   PUT    /api/org/{id}/users/{uid} — update user
//   DELETE /api/org/{id}/users/{uid} — remove user
//   POST   /api/org/{id}/invite      — generate invitation
//   GET    /api/org/{id}/invitations — list invitations
//   POST   /api/org/{id}/devices     — assign device to org
//   GET    /api/org/{id}/devices     — list org devices
//   DELETE /api/org/{id}/devices/{did} — unassign device
//   GET    /api/org/{id}/settings    — list org settings
//   PUT    /api/org/{id}/settings    — update org setting
//   GET    /api/org/{id}/address-book — get shared org address book
//   PUT    /api/org/{id}/address-book — update shared org address book
//   POST   /api/org/login            — org user login (returns JWT)

package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

var slugRegexp = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$`)

type orgIDInput string

func (id *orgIDInput) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*id = ""
		return nil
	}

	if data[0] == '"' {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		*id = orgIDInput(strings.TrimSpace(value))
		return nil
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value json.Number
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("org_id must be a string or number")
	}
	*id = orgIDInput(value.String())
	return nil
}

// ---------------------------------------------------------------------------
//  Organizations
// ---------------------------------------------------------------------------

// POST /api/org
func (s *Server) handleCreateOrg(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		Slug     string `json:"slug"`
		LogoURL  string `json:"logo_url"`
		Settings string `json:"settings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Slug = strings.TrimSpace(strings.ToLower(body.Slug))

	if body.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}
	if !slugRegexp.MatchString(body.Slug) {
		http.Error(w, `{"error":"slug must be 3-64 lowercase alphanumeric characters with optional hyphens"}`, http.StatusBadRequest)
		return
	}

	// Check slug uniqueness
	existing, _ := s.db.GetOrganizationBySlug(body.Slug)
	if existing != nil {
		http.Error(w, `{"error":"slug already in use"}`, http.StatusConflict)
		return
	}

	if body.Settings == "" {
		body.Settings = "{}"
	}

	org := &db.Organization{
		ID:        uuid.New().String(),
		Name:      body.Name,
		Slug:      body.Slug,
		LogoURL:   body.LogoURL,
		Settings:  body.Settings,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.db.CreateOrganization(org); err != nil {
		log.Printf("[org] CreateOrganization error: %v", err)
		http.Error(w, `{"error":"failed to create organization"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(org)
}

// GET /api/org
func (s *Server) handleListOrgs(w http.ResponseWriter, r *http.Request) {
	userRole := getRoleFromCtx(r)
	username := getUsernameFromCtx(r)

	orgs, err := s.db.ListOrganizations()
	if err != nil {
		log.Printf("[org] ListOrganizations error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if orgs == nil {
		orgs = []*db.Organization{}
	}

	// Data scoping: non-admin users only see orgs they belong to
	if userRole != auth.RoleAdmin {
		var filtered []*db.Organization
		for _, org := range orgs {
			member, err := s.db.GetOrgUserByUsername(org.ID, username)
			if err == nil && member != nil {
				filtered = append(filtered, org)
			}
		}
		if filtered == nil {
			filtered = []*db.Organization{}
		}
		orgs = filtered
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"organizations": orgs})
}

// GET /api/org/{id}
func (s *Server) handleGetOrg(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
		return
	}

	org, err := s.db.GetOrganization(id)
	if err != nil {
		log.Printf("[org] GetOrganization error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if org == nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(org)
}

// PUT /api/org/{id}
func (s *Server) handleUpdateOrg(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
		return
	}

	org, err := s.db.GetOrganization(id)
	if err != nil || org == nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		Name     *string `json:"name"`
		Slug     *string `json:"slug"`
		LogoURL  *string `json:"logo_url"`
		Settings *string `json:"settings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.Name != nil {
		org.Name = strings.TrimSpace(*body.Name)
	}
	if body.Slug != nil {
		slug := strings.TrimSpace(strings.ToLower(*body.Slug))
		if !slugRegexp.MatchString(slug) {
			http.Error(w, `{"error":"invalid slug"}`, http.StatusBadRequest)
			return
		}
		// Check slug uniqueness (if changed)
		if slug != org.Slug {
			existing, _ := s.db.GetOrganizationBySlug(slug)
			if existing != nil {
				http.Error(w, `{"error":"slug already in use"}`, http.StatusConflict)
				return
			}
		}
		org.Slug = slug
	}
	if body.LogoURL != nil {
		org.LogoURL = *body.LogoURL
	}
	if body.Settings != nil {
		org.Settings = *body.Settings
	}

	if err := s.db.UpdateOrganization(org); err != nil {
		log.Printf("[org] UpdateOrganization error: %v", err)
		http.Error(w, `{"error":"failed to update"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(org)
}

// DELETE /api/org/{id}
func (s *Server) handleDeleteOrg(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.DeleteOrganization(id); err != nil {
		log.Printf("[org] DeleteOrganization error: %v", err)
		http.Error(w, `{"error":"failed to delete"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
//  Org Users
// ---------------------------------------------------------------------------

// POST /api/org/{id}/users
func (s *Server) handleCreateOrgUser(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	// Verify org exists
	org, _ := s.db.GetOrganization(orgID)
	if org == nil {
		http.Error(w, `{"error":"organization not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
		Password    string `json:"password"`
		Role        string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		http.Error(w, `{"error":"username and password are required"}`, http.StatusBadRequest)
		return
	}
	if body.Role == "" {
		body.Role = db.OrgRoleUser
	}
	if !db.ValidOrgRole(body.Role) {
		http.Error(w, `{"error":"invalid role (owner, admin, operator, user)"}`, http.StatusBadRequest)
		return
	}

	// Org role boundary: check caller's authority within this org.
	callerRole := getRoleFromCtx(r)
	callerUsername := getUsernameFromCtx(r)

	// Super/global admins can assign any org role.
	if !auth.IsSuperAdminRole(callerRole) && callerRole != auth.RoleGlobalAdmin {
		callerOrgUser, _ := s.db.GetOrgUserByUsername(orgID, callerUsername)
		if callerOrgUser == nil {
			http.Error(w, `{"error":"you are not a member of this organization"}`, http.StatusForbidden)
			return
		}
		if !db.OrgCanAssignRole(callerOrgUser.Role, body.Role) {
			http.Error(w, `{"error":"cannot assign a role higher than your org-level authority"}`, http.StatusForbidden)
			return
		}
	}

	// Check duplicate
	existing, _ := s.db.GetOrgUserByUsername(orgID, body.Username)
	if existing != nil {
		http.Error(w, `{"error":"username already exists in this organization"}`, http.StatusConflict)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		http.Error(w, `{"error":"password hashing failed"}`, http.StatusInternalServerError)
		return
	}

	user := &db.OrgUser{
		ID:           uuid.New().String(),
		OrgID:        orgID,
		Username:     body.Username,
		DisplayName:  body.DisplayName,
		Email:        body.Email,
		PasswordHash: string(hash),
		Role:         body.Role,
		CreatedAt:    time.Now().UTC(),
	}

	if err := s.db.CreateOrgUser(user); err != nil {
		log.Printf("[org] CreateOrgUser error: %v", err)
		http.Error(w, `{"error":"failed to create user"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(user)
}

// GET /api/org/{id}/users
func (s *Server) handleListOrgUsers(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	users, err := s.db.ListOrgUsers(orgID)
	if err != nil {
		log.Printf("[org] ListOrgUsers error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []*db.OrgUser{}
	}

	// Org User scope: can only see themselves.
	callerRole := getRoleFromCtx(r)
	if !auth.IsSuperAdminRole(callerRole) && callerRole != auth.RoleGlobalAdmin {
		callerUsername := getUsernameFromCtx(r)
		callerOrgUser, _ := s.db.GetOrgUserByUsername(orgID, callerUsername)
		if callerOrgUser != nil && callerOrgUser.Role == db.OrgRoleUser {
			filtered := []*db.OrgUser{}
			for _, u := range users {
				if u.Username == callerUsername {
					filtered = append(filtered, u)
					break
				}
			}
			users = filtered
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"users": users})
}

// PUT /api/org/{id}/users/{uid}
func (s *Server) handleUpdateOrgUser(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if uid == "" {
		http.Error(w, `{"error":"user id required"}`, http.StatusBadRequest)
		return
	}

	user, err := s.db.GetOrgUser(uid)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		DisplayName *string `json:"display_name"`
		Email       *string `json:"email"`
		Role        *string `json:"role"`
		Password    *string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.DisplayName != nil {
		user.DisplayName = *body.DisplayName
	}
	if body.Email != nil {
		user.Email = *body.Email
	}
	if body.Role != nil {
		if !db.ValidOrgRole(*body.Role) {
			http.Error(w, `{"error":"invalid role"}`, http.StatusBadRequest)
			return
		}

		// Self-modification block: cannot change own org role.
		callerUsername := getUsernameFromCtx(r)
		if user.Username == callerUsername {
			http.Error(w, `{"error":"cannot modify your own org role"}`, http.StatusForbidden)
			return
		}

		// Org role boundary: check caller's authority.
		callerRole := getRoleFromCtx(r)
		if !auth.IsSuperAdminRole(callerRole) && callerRole != auth.RoleGlobalAdmin {
			callerOrgUser, _ := s.db.GetOrgUserByUsername(user.OrgID, callerUsername)
			if callerOrgUser == nil {
				http.Error(w, `{"error":"you are not a member of this organization"}`, http.StatusForbidden)
				return
			}
			// Cannot promote higher than own org role.
			if !db.OrgCanAssignRole(callerOrgUser.Role, *body.Role) {
				http.Error(w, `{"error":"cannot assign a role higher than your org-level authority"}`, http.StatusForbidden)
				return
			}
			// Cannot demote someone at or above own level.
			if db.OrgRoleLevel(user.Role) >= db.OrgRoleLevel(callerOrgUser.Role) {
				http.Error(w, `{"error":"cannot modify a user at or above your org-level authority"}`, http.StatusForbidden)
				return
			}
		}

		user.Role = *body.Role
	}

	if err := s.db.UpdateOrgUser(user); err != nil {
		log.Printf("[org] UpdateOrgUser error: %v", err)
		http.Error(w, `{"error":"failed to update user"}`, http.StatusInternalServerError)
		return
	}

	// Handle password change separately (requires re-hashing)
	if body.Password != nil && *body.Password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(*body.Password), bcrypt.DefaultCost)
		if err == nil {
			user.PasswordHash = string(hash)
			s.db.UpdateOrgUser(user)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(user)
}

// DELETE /api/org/{id}/users/{uid}
func (s *Server) handleDeleteOrgUser(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if uid == "" {
		http.Error(w, `{"error":"user id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.DeleteOrgUser(uid); err != nil {
		log.Printf("[org] DeleteOrgUser error: %v", err)
		http.Error(w, `{"error":"failed to delete user"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
//  Org Devices
// ---------------------------------------------------------------------------

// POST /api/org/{id}/devices
func (s *Server) handleAssignOrgDevice(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	var body struct {
		DeviceID       string `json:"device_id"`
		AssignedUserID string `json:"assigned_user_id"`
		Department     string `json:"department"`
		Location       string `json:"location"`
		Building       string `json:"building"`
		Tags           string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.DeviceID == "" {
		http.Error(w, `{"error":"device_id is required"}`, http.StatusBadRequest)
		return
	}

	d := &db.OrgDevice{
		OrgID:          orgID,
		DeviceID:       body.DeviceID,
		AssignedUserID: body.AssignedUserID,
		Department:     body.Department,
		Location:       body.Location,
		Building:       body.Building,
		Tags:           body.Tags,
	}

	if err := s.db.AssignDeviceToOrg(d); err != nil {
		log.Printf("[org] AssignDeviceToOrg error: %v", err)
		http.Error(w, `{"error":"failed to assign device"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(d)
}

// GET /api/org/{id}/devices
func (s *Server) handleListOrgDevices(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	devices, err := s.db.ListOrgDevices(orgID)
	if err != nil {
		log.Printf("[org] ListOrgDevices error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if devices == nil {
		devices = []*db.OrgDevice{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
}

// DELETE /api/org/{id}/devices/{did}
func (s *Server) handleUnassignOrgDevice(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	deviceID := r.PathValue("did")
	if deviceID == "" {
		http.Error(w, `{"error":"device_id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.UnassignDeviceFromOrg(orgID, deviceID); err != nil {
		log.Printf("[org] UnassignDeviceFromOrg error: %v", err)
		http.Error(w, `{"error":"failed to unassign device"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
//  Org Invitations
// ---------------------------------------------------------------------------

// POST /api/org/{id}/invite
func (s *Server) handleCreateOrgInvitation(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	var body struct {
		Email     string `json:"email"`
		Role      string `json:"role"`
		ExpiresIn int    `json:"expires_in_hours"` // default 72 hours
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.Role == "" {
		body.Role = db.OrgRoleUser
	}
	if body.ExpiresIn <= 0 {
		body.ExpiresIn = 72
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		http.Error(w, `{"error":"token generation failed"}`, http.StatusInternalServerError)
		return
	}
	token := hex.EncodeToString(tokenBytes)

	inv := &db.OrgInvitation{
		ID:        uuid.New().String(),
		OrgID:     orgID,
		Token:     token,
		Email:     body.Email,
		Role:      body.Role,
		ExpiresAt: time.Now().UTC().Add(time.Duration(body.ExpiresIn) * time.Hour),
	}

	if err := s.db.CreateOrgInvitation(inv); err != nil {
		log.Printf("[org] CreateOrgInvitation error: %v", err)
		http.Error(w, `{"error":"failed to create invitation"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(inv)
}

// GET /api/org/{id}/invitations
func (s *Server) handleListOrgInvitations(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	invs, err := s.db.ListOrgInvitations(orgID)
	if err != nil {
		log.Printf("[org] ListOrgInvitations error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if invs == nil {
		invs = []*db.OrgInvitation{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"invitations": invs})
}

// ---------------------------------------------------------------------------
//  Org Settings
// ---------------------------------------------------------------------------

// GET /api/org/{id}/settings
func (s *Server) handleListOrgSettings(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	settings, err := s.db.ListOrgSettings(orgID)
	if err != nil {
		log.Printf("[org] ListOrgSettings error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if settings == nil {
		settings = []*db.OrgSetting{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"settings": settings})
}

// PUT /api/org/{id}/settings
func (s *Server) handleSetOrgSetting(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	var body struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.Key == "" {
		http.Error(w, `{"error":"key is required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.SetOrgSetting(orgID, body.Key, body.Value); err != nil {
		log.Printf("[org] SetOrgSetting error: %v", err)
		http.Error(w, `{"error":"failed to save setting"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// GET /api/org/{id}/address-book
func (s *Server) handleGetOrgAddressBook(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	data, err := s.db.GetOrgAddressBook(orgID, "legacy")
	if err != nil {
		log.Printf("[org] GetOrgAddressBook error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	enabled := s.orgSharedAddressBookEnabled(orgID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"data":    data,
		"enabled": enabled,
	})
}

// PUT /api/org/{id}/address-book
func (s *Server) handleSetOrgAddressBook(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	username := getUsernameFromCtx(r)

	var body struct {
		Data    json.RawMessage `json:"data"`
		Enabled *bool           `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.Enabled != nil {
		value := "true"
		if !*body.Enabled {
			value = "false"
		}
		if err := s.db.SetOrgSetting(orgID, orgSharedAddressBookEnabledKey, value); err != nil {
			log.Printf("[org] SetOrgSetting(shared_address_book_enabled) error: %v", err)
			http.Error(w, `{"error":"failed to save setting"}`, http.StatusInternalServerError)
			return
		}
	}

	if len(body.Data) > 0 && string(body.Data) != "null" {
		dataStr := normalizeAbDataField(body.Data)
		if len(dataStr) > 512*1024 {
			http.Error(w, `{"error":"address book too large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		if err := s.db.SaveOrgAddressBook(orgID, "legacy", dataStr, username); err != nil {
			log.Printf("[org] SaveOrgAddressBook error: %v", err)
			http.Error(w, `{"error":"failed to save address book"}`, http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ---------------------------------------------------------------------------
//  Org User Login
// ---------------------------------------------------------------------------

// POST /api/org/login
func (s *Server) handleOrgLogin(w http.ResponseWriter, r *http.Request) {
	clientIP := s.remoteIP(r)
	if s.loginLimiter != nil && !s.loginLimiter.Allow(clientIP) {
		http.Error(w, `{"error":"too many login attempts"}`, http.StatusTooManyRequests)
		return
	}

	var body struct {
		OrgSlug  string `json:"org_slug"`
		OrgID    string `json:"org_id"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		http.Error(w, `{"error":"username and password are required"}`, http.StatusBadRequest)
		return
	}

	// Resolve org
	var orgID string
	if body.OrgID != "" {
		orgID = body.OrgID
	} else if body.OrgSlug != "" {
		org, _ := s.db.GetOrganizationBySlug(body.OrgSlug)
		if org == nil {
			http.Error(w, `{"error":"organization not found"}`, http.StatusNotFound)
			return
		}
		orgID = org.ID
	} else {
		http.Error(w, `{"error":"org_id or org_slug is required"}`, http.StatusBadRequest)
		return
	}

	user, _ := s.db.GetOrgUserByUsername(orgID, body.Username)
	if user == nil {
		// Timing-safe: compare against dummy hash
		bcrypt.CompareHashAndPassword(
			[]byte("$2a$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
			[]byte(body.Password),
		)
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	// Update last login
	s.db.UpdateOrgUserLogin(user.ID)

	// Generate JWT with org context
	if s.jwtManager == nil {
		http.Error(w, `{"error":"JWT not configured"}`, http.StatusInternalServerError)
		return
	}

	token, err := s.jwtManager.GenerateOrgToken(user.Username, user.Role, orgID, s.jwtManager.Expiry())
	if err != nil {
		log.Printf("[org] JWT generation error: %v", err)
		http.Error(w, `{"error":"token generation failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":  token,
		"user":   user,
		"org_id": orgID,
		"type":   "org_user",
	})
}

// ---------------------------------------------------------------------------
//  Organization Policies
// ---------------------------------------------------------------------------

// policyCategories are the valid policy category names
var policyCategories = []string{"connection", "features", "security", "network", "update"}

// isPolicyCategory checks if category is valid
func isPolicyCategory(category string) bool {
	for _, c := range policyCategories {
		if c == category {
			return true
		}
	}
	return false
}

// GET /api/org/{id}/policy
func (s *Server) handleGetOrgPolicy(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	result := make(map[string]interface{})

	for _, category := range policyCategories {
		key := "policy_" + category
		value, err := s.db.GetOrgSetting(orgID, key)
		if err != nil || value == "" {
			result[category] = map[string]interface{}{}
			continue
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(value), &parsed); err != nil {
			result[category] = map[string]interface{}{}
			continue
		}
		result[category] = parsed
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// PUT /api/org/{id}/policy/{category}
func (s *Server) handleSetOrgPolicy(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	category := r.PathValue("category")

	if !isPolicyCategory(category) {
		http.Error(w, `{"error":"invalid policy category"}`, http.StatusBadRequest)
		return
	}

	// Read body as raw JSON to preserve
	var body interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	// Serialize back to string for storage
	encoded, err := json.Marshal(body)
	if err != nil {
		http.Error(w, `{"error":"failed to encode policy"}`, http.StatusInternalServerError)
		return
	}

	// Store as org setting
	key := "policy_" + category
	if err := s.db.SetOrgSetting(orgID, key, string(encoded)); err != nil {
		log.Printf("[org] SetOrgPolicy error: %v", err)
		http.Error(w, `{"error":"failed to save policy"}`, http.StatusInternalServerError)
		return
	}

	// Record audit
	if s.auditLog != nil {
		s.auditLog.Log("org_policy_changed", s.remoteIP(r), getUsernameFromCtx(r), map[string]string{
			"org_id":   orgID,
			"category": category,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "ok",
		"category": category,
	})
}

// GET /api/org/{id}/policy/effective/{deviceId}
func (s *Server) handleGetEffectivePolicy(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	deviceID := r.PathValue("deviceId")

	// Get org policies
	orgPolicies := make(map[string]interface{})
	for _, category := range policyCategories {
		key := "policy_" + category
		value, err := s.db.GetOrgSetting(orgID, key)
		if err != nil || value == "" {
			continue
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(value), &parsed); err != nil {
			continue
		}
		orgPolicies[category] = parsed
	}

	// For now, return org policies + device ID (future: merge with device-specific overrides)
	result := map[string]interface{}{
		"device_id": deviceID,
		"org_id":    orgID,
		"policies":  orgPolicies,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// GET /api/org/{id}/policy/audit
func (s *Server) handleGetPolicyAudit(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	// Get recent audit entries for this org's policies
	var filtered []audit.Event
	if s.auditLog != nil {
		allEntries := s.auditLog.Recent(500)
		for _, e := range allEntries {
			if e.Action != audit.Action("org_policy_changed") {
				continue
			}
			if e.Details != nil && e.Details["org_id"] == orgID {
				filtered = append(filtered, e)
			}
		}
	}

	// Limit to 100 entries
	if len(filtered) > 100 {
		filtered = filtered[:100]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"entries": filtered})
}

// GET /api/peers/{id}/policy — effective org policy for a device (agent-facing).
func (s *Server) handleGetPeerPolicy(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	if deviceID == "" {
		http.Error(w, `{"error":"device id required"}`, http.StatusBadRequest)
		return
	}

	orgID, _ := s.db.GetDeviceOrgID(deviceID)
	orgPolicies := make(map[string]interface{})
	if orgID != "" {
		for _, category := range policyCategories {
			key := "policy_" + category
			value, err := s.db.GetOrgSetting(orgID, key)
			if err != nil || value == "" {
				continue
			}
			var parsed interface{}
			if err := json.Unmarshal([]byte(value), &parsed); err != nil {
				continue
			}
			orgPolicies[category] = parsed
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"device_id": deviceID,
		"org_id":    orgID,
		"policies":  orgPolicies,
	})
}

// ---------------------------------------------------------------------------
//  User-Org Linking (Issue #106)
// ---------------------------------------------------------------------------

// POST /api/org/{id}/members
// Links an existing server-level user to an organization.
func (s *Server) handleLinkUserToOrg(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	// Verify org exists
	org, _ := s.db.GetOrganization(orgID)
	if org == nil {
		http.Error(w, `{"error":"organization not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		UserID int64  `json:"user_id"`
		Role   string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.UserID <= 0 {
		http.Error(w, `{"error":"user_id is required"}`, http.StatusBadRequest)
		return
	}
	if body.Role == "" {
		body.Role = db.OrgRoleUser
	}
	if !db.ValidOrgRole(body.Role) {
		http.Error(w, `{"error":"invalid role (owner, admin, operator, user)"}`, http.StatusBadRequest)
		return
	}

	// Org role boundary: check caller's authority within this org.
	callerRole := getRoleFromCtx(r)
	callerUsername := getUsernameFromCtx(r)

	if !auth.IsSuperAdminRole(callerRole) && callerRole != auth.RoleGlobalAdmin {
		callerOrgUser, _ := s.db.GetOrgUserByUsername(orgID, callerUsername)
		if callerOrgUser == nil {
			http.Error(w, `{"error":"you are not a member of this organization"}`, http.StatusForbidden)
			return
		}
		if !db.OrgCanAssignRole(callerOrgUser.Role, body.Role) {
			http.Error(w, `{"error":"cannot assign a role higher than your org-level authority"}`, http.StatusForbidden)
			return
		}
	}

	// Link user
	orgUser, err := s.db.LinkUserToOrg(orgID, body.UserID, body.Role)
	if err != nil {
		log.Printf("[org] LinkUserToOrg error: %v", err)
		if strings.Contains(err.Error(), "already linked") {
			http.Error(w, `{"error":"user already linked to this organization"}`, http.StatusConflict)
			return
		}
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"server user not found"}`, http.StatusNotFound)
			return
		}
		if strings.Contains(err.Error(), "username already exists") {
			http.Error(w, `{"error":"username already exists in this organization"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"failed to link user"}`, http.StatusInternalServerError)
		return
	}

	// Audit
	if s.auditLog != nil {
		s.auditLog.Log("org_user_linked", s.remoteIP(r), callerUsername, map[string]string{
			"org_id":  orgID,
			"user_id": fmt.Sprintf("%d", body.UserID),
			"role":    body.Role,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(orgUser)
}

// DELETE /api/org/{id}/members/{userId}
// Unlinks a server-level user from an organization.
func (s *Server) handleUnlinkUserFromOrg(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	userIDStr := r.PathValue("userId")

	if orgID == "" || userIDStr == "" {
		http.Error(w, `{"error":"org_id and user_id required"}`, http.StatusBadRequest)
		return
	}

	var userID int64
	if _, err := fmt.Sscanf(userIDStr, "%d", &userID); err != nil || userID <= 0 {
		http.Error(w, `{"error":"invalid user_id"}`, http.StatusBadRequest)
		return
	}

	// Check authority: super/global admin can always unlink
	callerRole := getRoleFromCtx(r)
	callerUsername := getUsernameFromCtx(r)

	if !auth.IsSuperAdminRole(callerRole) && callerRole != auth.RoleGlobalAdmin {
		callerOrgUser, _ := s.db.GetOrgUserByUsername(orgID, callerUsername)
		if callerOrgUser == nil {
			http.Error(w, `{"error":"you are not a member of this organization"}`, http.StatusForbidden)
			return
		}
		// Only owner/admin can unlink
		if callerOrgUser.Role != db.OrgRoleOwner && callerOrgUser.Role != db.OrgRoleAdmin {
			http.Error(w, `{"error":"insufficient permissions to unlink users"}`, http.StatusForbidden)
			return
		}
	}

	if err := s.db.UnlinkUserFromOrg(orgID, userID); err != nil {
		log.Printf("[org] UnlinkUserFromOrg error: %v", err)
		if strings.Contains(err.Error(), "not linked") {
			http.Error(w, `{"error":"user not linked to this organization"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to unlink user"}`, http.StatusInternalServerError)
		return
	}

	// Audit
	if s.auditLog != nil {
		s.auditLog.Log("org_user_unlinked", s.remoteIP(r), callerUsername, map[string]string{
			"org_id":  orgID,
			"user_id": userIDStr,
		})
	}

	w.WriteHeader(http.StatusNoContent)
}

// GET /api/org/{id}/available-users
// Returns server-level users not yet linked to this organization.
func (s *Server) handleListAvailableUsers(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	users, err := s.db.ListUsersNotInOrg(orgID)
	if err != nil {
		log.Printf("[org] ListUsersNotInOrg error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []*db.User{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"users": users})
}

// GET /api/users/{id}/organizations
// Returns all organizations a server user is linked to.
func (s *Server) handleListUserOrganizations(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.PathValue("id")
	if userIDStr == "" {
		http.Error(w, `{"error":"user_id required"}`, http.StatusBadRequest)
		return
	}

	var userID int64
	if _, err := fmt.Sscanf(userIDStr, "%d", &userID); err != nil || userID <= 0 {
		http.Error(w, `{"error":"invalid user_id"}`, http.StatusBadRequest)
		return
	}

	orgs, err := s.db.ListUserOrganizations(userID)
	if err != nil {
		log.Printf("[org] ListUserOrganizations error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if orgs == nil {
		orgs = []*db.Organization{}
	}

	type userOrgView struct {
		ID        string    `json:"id"`
		OrgID     string    `json:"org_id"`
		Name      string    `json:"name"`
		OrgName   string    `json:"org_name"`
		Slug      string    `json:"slug"`
		LogoURL   string    `json:"logo_url,omitempty"`
		Settings  string    `json:"settings,omitempty"`
		Role      string    `json:"role,omitempty"`
		CreatedAt time.Time `json:"created_at"`
	}

	views := make([]userOrgView, 0, len(orgs))
	for _, org := range orgs {
		view := userOrgView{
			ID:        org.ID,
			OrgID:     org.ID,
			Name:      org.Name,
			OrgName:   org.Name,
			Slug:      org.Slug,
			LogoURL:   org.LogoURL,
			Settings:  org.Settings,
			CreatedAt: org.CreatedAt,
		}
		if membership, err := s.db.GetOrgUserByServerUserID(org.ID, userID); err == nil && membership != nil {
			view.Role = membership.Role
		}
		views = append(views, view)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"organizations": views})
}

// POST /api/users/{id}/organizations
// Links a server user to an organization (alternative endpoint).
func (s *Server) handleAssignUserToOrg(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.PathValue("id")
	if userIDStr == "" {
		http.Error(w, `{"error":"user_id required"}`, http.StatusBadRequest)
		return
	}

	var userID int64
	if _, err := fmt.Sscanf(userIDStr, "%d", &userID); err != nil || userID <= 0 {
		http.Error(w, `{"error":"invalid user_id"}`, http.StatusBadRequest)
		return
	}

	var body struct {
		OrgID orgIDInput `json:"org_id"`
		Role  string     `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	orgID := string(body.OrgID)
	if orgID == "" {
		http.Error(w, `{"error":"org_id is required"}`, http.StatusBadRequest)
		return
	}
	if body.Role == "" {
		body.Role = db.OrgRoleUser
	}
	if !db.ValidOrgRole(body.Role) {
		http.Error(w, `{"error":"invalid role (owner, admin, operator, user)"}`, http.StatusBadRequest)
		return
	}

	// Verify org exists
	org, _ := s.db.GetOrganization(orgID)
	if org == nil {
		http.Error(w, `{"error":"organization not found"}`, http.StatusNotFound)
		return
	}

	// Auth check (same logic as handleLinkUserToOrg)
	callerRole := getRoleFromCtx(r)
	callerUsername := getUsernameFromCtx(r)

	if !auth.IsSuperAdminRole(callerRole) && callerRole != auth.RoleGlobalAdmin {
		callerOrgUser, _ := s.db.GetOrgUserByUsername(orgID, callerUsername)
		if callerOrgUser == nil {
			http.Error(w, `{"error":"you are not a member of this organization"}`, http.StatusForbidden)
			return
		}
		if !db.OrgCanAssignRole(callerOrgUser.Role, body.Role) {
			http.Error(w, `{"error":"cannot assign a role higher than your org-level authority"}`, http.StatusForbidden)
			return
		}
	}

	orgUser, err := s.db.LinkUserToOrg(orgID, userID, body.Role)
	if err != nil {
		log.Printf("[org] LinkUserToOrg (from users) error: %v", err)
		if strings.Contains(err.Error(), "already linked") {
			http.Error(w, `{"error":"user already linked to this organization"}`, http.StatusConflict)
			return
		}
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"server user not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to link user"}`, http.StatusInternalServerError)
		return
	}

	// Audit
	if s.auditLog != nil {
		s.auditLog.Log("user_org_assigned", s.remoteIP(r), callerUsername, map[string]string{
			"user_id": userIDStr,
			"org_id":  orgID,
			"role":    body.Role,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(orgUser)
}
