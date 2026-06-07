package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// AccessMode controls how inbound remote-desktop sessions are authorized.
const (
	// AccessSupervised prompts the local user to accept each session.
	AccessSupervised = "supervised"
	// AccessUnattended lets the operator connect with the access password,
	// no local prompt.
	AccessUnattended = "unattended"
	// AccessDisabled refuses every inbound desktop session.
	AccessDisabled = "disabled"
)

// AppState is the support agent's local persistent state. It is distinct from
// the baked Branding (connection + appearance): it stores only per-device,
// user-mutable settings that must survive restarts.
//
// The state file is encrypted at rest with a machine-bound key (see crypto.go)
// so the device identity and access password cannot be read directly from disk
// or copied to another machine to impersonate this device. The access password
// is still exposed to the local user through the UI, where it is decrypted in
// memory on demand. The file is additionally written with 0600 permissions.
type AppState struct {
	DeviceID            string `json:"device_id"`
	InstallationSecret  string `json:"installation_secret,omitempty"`
	MachineUUID         string `json:"machine_uuid,omitempty"`
	AccessMode          string `json:"access_mode"`
	AccessPassword      string `json:"access_password"`
	CustomPassword      bool   `json:"custom_password"`
	Language            string `json:"language"`
	TOTPEnabled         bool   `json:"totp_enabled,omitempty"`
	TOTPSecret          string `json:"totp_secret,omitempty"`
	DeviceToken         string `json:"device_token,omitempty"`
	EnrollmentStatus    string `json:"enrollment_status,omitempty"`
	EnrollmentMessage   string `json:"enrollment_message,omitempty"`

	mu   sync.Mutex `json:"-"`
	path string     `json:"-"`
}

// stateDir returns the directory holding the persistent state file. Portable
// builds keep state in a writable location (USB-friendly tar/portable binary,
// or beside the .AppImage file). Detection order:
//  1. BETTERDESK_AGENT_DATA_DIR env override
//  2. AppImage: APPIMAGE env → betterdesk-support-data/ next to the .AppImage
//  3. portable marker ("portable" or ".portable") next to the executable → data/
//  4. default per-user config directory
func stateDir() string {
	if d := os.Getenv("BETTERDESK_AGENT_DATA_DIR"); d != "" {
		return d
	}
	if dir, ok := portableDataDir(); ok {
		return dir
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base, _ = os.UserHomeDir()
		base = filepath.Join(base, ".config")
	}
	return filepath.Join(base, "betterdesk-support")
}

// portableDataDir reports a writable data directory for portable distributions.
func portableDataDir() (string, bool) {
	if dir, ok := appImagePortableDir(); ok {
		return dir, true
	}
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	dir := filepath.Dir(exe)
	for _, marker := range []string{"portable", ".portable"} {
		if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
			return filepath.Join(dir, "data"), true
		}
	}
	return "", false
}

// appImagePortableDir stores state beside the .AppImage on disk. The runtime
// mount at usr/bin/ is read-only, so data cannot live next to the binary.
func appImagePortableDir() (string, bool) {
	appImage := strings.TrimSpace(os.Getenv("APPIMAGE"))
	if appImage == "" {
		return "", false
	}
	return filepath.Join(filepath.Dir(appImage), "betterdesk-support-data"), true
}

// IsPortable reports portable distribution (AppImage, or marker beside binary).
func IsPortable() bool {
	if os.Getenv("BETTERDESK_AGENT_DATA_DIR") != "" {
		return false
	}
	_, ok := portableDataDir()
	return ok
}

// LoadState reads the persistent state, creating defaults (including a stable
// device ID and a random access password) on first run.
func LoadState() (*AppState, error) {
	dir := stateDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	path := filepath.Join(dir, "state.json")

	s := &AppState{path: path}
	legacyPlaintext := false
	if data, err := os.ReadFile(path); err == nil {
		plain, derr := loadStateBytes(data)
		if derr == nil {
			_ = json.Unmarshal(plain, s)
			legacyPlaintext = !isEncryptedState(data)
		}
		// On decrypt failure (file from another machine or corrupted) the
		// fields stay zero and are regenerated below — a copied identity is
		// never reused, which is the anti-impersonation guarantee.
		s.path = path
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read state: %w", err)
	}

	changed := legacyPlaintext // force re-encryption of legacy files
	if s.InstallationSecret == "" {
		s.InstallationSecret = newInstallationSecret()
		changed = true
	}
	if s.MachineUUID == "" {
		if s.DeviceID != "" {
			// Preserve uuid anchor for devices enrolled before v2 fingerprinting.
			s.MachineUUID = legacyMachineSeed()
			if s.MachineUUID == "" {
				s.MachineUUID = machineFingerprint()
			}
		} else {
			s.MachineUUID = machineFingerprint()
		}
		changed = true
	}
	if s.DeviceID == "" {
		s.DeviceID = generateDeviceID(s.InstallationSecret)
		changed = true
	}
	if s.AccessMode == "" {
		s.AccessMode = AccessSupervised
		changed = true
	}
	if s.AccessPassword == "" {
		s.AccessPassword = randomPassword()
		s.CustomPassword = false
		changed = true
	}
	if s.Language == "" {
		s.Language = resolveInitialLanguage(GetBranding().DefaultLanguage)
		changed = true
	} else {
		s.Language = normalizeLocale(s.Language)
	}
	if changed {
		if err := s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// save persists the state atomically with 0600 permissions, encrypted with the
// machine-bound key. Caller must hold the mutex (or be in a single-threaded
// init path).
func (s *AppState) save() error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	blob, err := encryptState(data)
	if err != nil {
		return fmt.Errorf("encrypt state: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// loadStateBytes returns the decrypted JSON for a stored state file. Encrypted
// files are opened with the machine key; legacy plaintext JSON (written by
// older builds) is accepted once and re-encrypted on the next save.
func loadStateBytes(data []byte) ([]byte, error) {
	if isEncryptedState(data) {
		return decryptState(data)
	}
	if len(data) > 0 && (data[0] == '{' || data[0] == '[') {
		return data, nil // legacy plaintext, migrate on next save
	}
	return nil, fmt.Errorf("unrecognized state format")
}

// SetAccessMode updates the access policy and persists it.
func (s *AppState) SetAccessMode(mode string) error {
	switch mode {
	case AccessSupervised, AccessUnattended, AccessDisabled:
	default:
		return fmt.Errorf("invalid access mode: %q", mode)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.AccessMode = mode
	return s.save()
}

// SetCustomPassword stores a user-chosen access password. An empty value
// reverts to a freshly generated random password.
func (s *AppState) SetCustomPassword(pw string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pw = strings.TrimSpace(pw)
	if pw == "" {
		s.AccessPassword = randomPassword()
		s.CustomPassword = false
	} else {
		if len(pw) < 6 {
			return fmt.Errorf("password must be at least 6 characters")
		}
		s.AccessPassword = pw
		s.CustomPassword = true
	}
	return s.save()
}

// RegeneratePassword replaces the access password with a fresh random one.
func (s *AppState) RegeneratePassword() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.AccessPassword = randomPassword()
	s.CustomPassword = false
	return s.save()
}

// SetLanguage persists the UI language preference.
func (s *AppState) SetLanguage(lang string) error {
	lang = normalizeLocale(lang)
	if !hasLocale(lang) {
		lang = "en"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Language = lang
	return s.save()
}

// SetTOTP persists local 2FA state used by the relay host.
func (s *AppState) SetTOTP(enabled bool, secret string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.TOTPEnabled = enabled
	s.TOTPSecret = secret
	return s.save()
}

// TOTPSnapshot returns device 2FA settings.
func (s *AppState) TOTPSnapshot() (enabled bool, secret string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.TOTPEnabled, s.TOTPSecret
}

// Snapshot returns a copy of the user-facing fields without exposing the mutex.
func (s *AppState) Snapshot() (deviceID, mode, password string, custom bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.DeviceID, s.AccessMode, s.AccessPassword, s.CustomPassword
}

// EnrollmentSnapshot returns enrollment-related fields.
func (s *AppState) EnrollmentSnapshot() (status, token, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.EnrollmentStatus, s.DeviceToken, s.EnrollmentMessage
}

// SetEnrollment persists enrollment outcome and optional device token.
func (s *AppState) SetEnrollment(status, deviceID, token, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if deviceID != "" {
		s.DeviceID = deviceID
	}
	s.EnrollmentStatus = status
	if token != "" {
		s.DeviceToken = token
	}
	s.EnrollmentMessage = message
	return s.save()
}

// SetEnrollmentMessage updates the pending/rejected message only.
func (s *AppState) SetEnrollmentMessage(message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.EnrollmentMessage = message
	return s.save()
}

// ResetEnrollmentState clears enrollment fields so the next run registers fresh.
func ResetEnrollmentState() error {
	st, err := LoadState()
	if err != nil {
		return err
	}
	st.mu.Lock()
	st.EnrollmentStatus = ""
	st.DeviceToken = ""
	st.EnrollmentMessage = ""
	st.mu.Unlock()
	return st.save()
}

// IsEnrolled reports whether the device has an approved token.
func (s *AppState) IsEnrolled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.EnrollmentStatus == EnrollmentApproved && s.DeviceToken != ""
}

// GetMachineUUID returns the fingerprint sent to the server during enrollment.
func (s *AppState) GetMachineUUID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.MachineUUID
}

// SetDeviceID updates the device identifier after a server-suggested collision
// resolution and clears enrollment so the agent re-registers.
func (s *AppState) SetDeviceID(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.DeviceID = id
	s.EnrollmentStatus = ""
	s.DeviceToken = ""
	s.EnrollmentMessage = ""
	return s.save()
}

func newInstallationSecret() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte("betterdesk-fallback-secret"))
	}
	return hex.EncodeToString(buf)
}

// generateDeviceID derives a stable per-installation identifier. The
// installation secret ensures two fresh installs on the same hardware get
// different IDs; the machine fingerprint anchors uuid sent to the server.
func generateDeviceID(installationSecret string) string {
	fp := machineFingerprint()
	if fp == "" {
		fp = legacyMachineSeed()
	}
	if fp == "" {
		buf := make([]byte, 8)
		_, _ = rand.Read(buf)
		fp = hex.EncodeToString(buf)
	}
	material := "betterdesk-support-v2|" + fp + "|" + installationSecret
	sum := sha256.Sum256([]byte(material))
	return "BD-" + strings.ToUpper(hex.EncodeToString(sum[:5]))
}

// deriveDeviceIDWithSuffix appends a server-suggested suffix for collision resolution.
func deriveDeviceIDWithSuffix(baseID, suffix string) string {
	baseID = strings.TrimSpace(baseID)
	suffix = strings.TrimSpace(suffix)
	if baseID == "" || suffix == "" {
		return baseID
	}
	if strings.HasSuffix(baseID, suffix) {
		return baseID
	}
	return baseID + suffix
}

// randomPassword returns a short, human-typable access password.
func randomPassword() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	const n = 8
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "betterdesk"
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out)
}
