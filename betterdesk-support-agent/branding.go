package main

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-support-agent/internal/brandprofile"
)

//go:embed resources/branding.json
var brandingJSON []byte

//go:embed resources/branding.pub
var brandingPublicKey []byte

type ServerBranding struct {
	Address     string `json:"address"`
	APIURL      string `json:"api_url"`
	PublicKey   string `json:"public_key"`
	CertPin     string `json:"cert_pin,omitempty"`
	CDAPPort    int    `json:"cdap_port,omitempty"`
	ConsolePort int    `json:"console_port,omitempty"`
	CDAPURL     string `json:"cdap_url,omitempty"`
	ConsoleURL  string `json:"console_url,omitempty"`
}

type Branding struct {
	ProductName      string          `json:"product_name"`
	CompanyName      string          `json:"company_name"`
	Tagline          string          `json:"tagline"`
	TaglineAlt       string          `json:"short_text"`
	SupportEmail     string          `json:"support_email"`
	SupportEmailAlt  string          `json:"contact_email"`
	SupportPhone     string          `json:"support_phone"`
	SupportPhoneAlt  string          `json:"contact_phone"`
	ContactURL       string          `json:"contact_url"`
	PrimaryColor     string          `json:"primary_color"`
	AccentColor      string          `json:"accent_color"`
	BackgroundColor  string          `json:"background_color"`
	SurfaceColor     string          `json:"surface_color"`
	TextColor        string          `json:"text_color"`
	TextMutedColor   string          `json:"text_muted_color"`
	StatusReadyColor string          `json:"status_ready_color"`
	HeaderTextColor  string          `json:"header_text_color"`
	LogoDataURL      string          `json:"logo_data_url"`
	DefaultLanguage  string          `json:"default_language"`
	DefaultLangAlt   string          `json:"default_lang"`
	AllowUnattended  bool            `json:"allow_unattended"`
	ServerAddress    string          `json:"server_address"`
	ServerKey        string          `json:"server_key"`
	APIKey           string          `json:"api_key"`
	BundleID         string          `json:"bundle_id"`
	ProfileIssuedAt  string          `json:"profile_issued_at,omitempty"`
	ProfileExpiresAt string          `json:"profile_expires_at,omitempty"`
	AllowedEndpoints []string        `json:"allowed_endpoints,omitempty"`
	UseHTTPS         bool            `json:"use_https"`
	Server           *ServerBranding `json:"server,omitempty"`
	// Incoming host capability policy. Desktop remains enabled by default for
	// existing bundles; all other capabilities require both a profile opt-in
	// and a locally enforceable implementation before they can be exposed.
	Capabilities *CapabilityFlags `json:"capabilities,omitempty"`
}

// CapabilityFlags gates incoming session features for Support Agent builds.
type CapabilityFlags struct {
	Desktop      *bool `json:"desktop,omitempty"`
	Files        *bool `json:"files,omitempty"`
	Clipboard    *bool `json:"clipboard,omitempty"`
	Audio        *bool `json:"audio,omitempty"`
	Terminal     *bool `json:"terminal,omitempty"`
	Chat         *bool `json:"chat,omitempty"`
	MultiMonitor *bool `json:"multi_monitor,omitempty"`
	PrivacyMode  *bool `json:"privacy_mode,omitempty"`
	BlockInput   *bool `json:"block_input,omitempty"`
	Restart      *bool `json:"restart,omitempty"`
	Recording    *bool `json:"recording,omitempty"`
}

func capEnabled(flag *bool, defaultOn bool) bool {
	if flag == nil {
		return defaultOn
	}
	return *flag
}

var (
	brandingOnce sync.Once
	brandingVal  Branding
)

func brandingDefaults() Branding {
	return Branding{
		ProductName:      "BetterDesk Support",
		CompanyName:      "BetterDesk",
		Tagline:          "Quick remote help",
		PrimaryColor:     "#2563eb",
		AccentColor:      "#1e293b",
		BackgroundColor:  "#0f172a",
		SurfaceColor:     "#1e293b",
		TextColor:        "#e2e8f0",
		TextMutedColor:   "#94a3b8",
		StatusReadyColor: "#22c55e",
		HeaderTextColor:  "#ffffff",
		DefaultLanguage:  "en",
	}
}

func GetBranding() Branding {
	brandingOnce.Do(func() {
		raw := brandingJSON
		if !isReleaseBuild() {
			if p := os.Getenv("BETTERDESK_AGENT_BRANDING"); p != "" {
				if data, err := os.ReadFile(p); err == nil {
					raw = data
				}
			}
		}
		b, err := decodeBrandingProfile(raw, brandingPublicKey, isReleaseBuild())
		if err != nil {
			// Do not substitute a default endpoint after integrity verification
			// fails. A release binary must be signed by its bundle issuer.
			brandingVal = rejectedBranding()
			return
		}
		brandingVal = b.normalize()
	})
	return brandingVal
}

func rejectedBranding() Branding {
	b := brandingDefaults()
	b.ServerAddress = ""
	return b
}

// decodeBrandingProfile validates the profile that is embedded in a binary.
// Release builds accept only authenticated profiles. Development builds may
// deliberately load a plaintext or legacy-sealed local profile to preserve the
// supported developer workflow, but never silently downgrade a signed profile.
func decodeBrandingProfile(raw, publicKeyResource []byte, requireSigned bool) (Branding, error) {
	if brandprofile.IsSigned(raw) {
		publicKey, err := brandprofile.DecodePublicKey(strings.TrimSpace(string(publicKeyResource)))
		if err != nil {
			return Branding{}, fmt.Errorf("decode branding public key: %w", err)
		}
		plain, err := brandprofile.Verify(raw, publicKey)
		if err != nil {
			return Branding{}, fmt.Errorf("verify branding profile: %w", err)
		}
		raw = plain
	} else {
		if requireSigned {
			return Branding{}, fmt.Errorf("unsigned branding profile in release build")
		}
		if isSealedBranding(raw) {
			plain, err := unsealBranding(raw)
			if err != nil {
				return Branding{}, fmt.Errorf("unseal branding profile: %w", err)
			}
			raw = plain
		}
	}

	var branding Branding
	if err := json.Unmarshal(raw, &branding); err != nil {
		return Branding{}, fmt.Errorf("decode branding profile: %w", err)
	}
	if requireSigned {
		if err := branding.validateReleaseProfile(time.Now()); err != nil {
			return Branding{}, err
		}
	}
	return branding, nil
}

func (b Branding) validateReleaseProfile(now time.Time) error {
	if strings.TrimSpace(b.BundleID) == "" {
		return fmt.Errorf("release branding profile is missing bundle ID")
	}
	if b.Server == nil || strings.TrimSpace(b.Server.Address) == "" ||
		strings.TrimSpace(b.Server.APIURL) == "" || strings.TrimSpace(b.Server.CDAPURL) == "" {
		return fmt.Errorf("release branding profile has incomplete server endpoints")
	}
	if strings.TrimSpace(b.ServerKey) == "" && strings.TrimSpace(b.Server.PublicKey) == "" {
		return fmt.Errorf("release branding profile is missing server signing key")
	}
	if strings.TrimSpace(b.ProfileExpiresAt) == "" {
		return fmt.Errorf("release branding profile is missing expiry")
	}
	if strings.TrimSpace(b.ProfileIssuedAt) == "" {
		return fmt.Errorf("release branding profile is missing issue time")
	}
	issuedAt, err := time.Parse(time.RFC3339, strings.TrimSpace(b.ProfileIssuedAt))
	if err != nil {
		return fmt.Errorf("parse release branding profile issue time: %w", err)
	}
	expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(b.ProfileExpiresAt))
	if err != nil {
		return fmt.Errorf("parse release branding profile expiry: %w", err)
	}
	if issuedAt.After(now.UTC().Add(5*time.Minute)) || !expiresAt.After(issuedAt) {
		return fmt.Errorf("release branding profile has invalid validity period")
	}
	if !expiresAt.After(now.UTC()) {
		return fmt.Errorf("release branding profile has expired")
	}
	if !allEndpointsAllowed(b.AllowedEndpoints, b.Server.Address, b.Server.APIURL, b.Server.CDAPURL) {
		return fmt.Errorf("release branding profile has unauthorized endpoint")
	}
	if b.Server.CertPin != "" && normalizeServerCertPin(b.Server.CertPin) == "" {
		return fmt.Errorf("release branding profile has invalid certificate pin")
	}
	return nil
}

func isAllowedTransportEndpoint(endpoint string) bool {
	lower := strings.ToLower(strings.TrimSpace(endpoint))
	return strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "wss://") ||
		strings.HasPrefix(lower, "ws://")
}

// allEndpointsAllowed requires every baked endpoint to appear in the signed
// allowlist. HTTPS/WSS and HTTP/WS are both accepted (LAN / RustDesk-style).
func allEndpointsAllowed(allowed []string, endpoints ...string) bool {
	if len(allowed) == 0 {
		return false
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, endpoint := range allowed {
		endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
		if isAllowedTransportEndpoint(endpoint) {
			allowedSet[endpoint] = struct{}{}
		}
	}
	for _, endpoint := range endpoints {
		endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
		if _, ok := allowedSet[endpoint]; !ok {
			return false
		}
	}
	return true
}

func isReleaseBuild() bool {
	return releaseBuild
}

func (b Branding) normalize() Branding {
	if b.Tagline == "" {
		b.Tagline = b.TaglineAlt
	}
	if b.SupportEmail == "" {
		b.SupportEmail = b.SupportEmailAlt
	}
	if b.SupportPhone == "" {
		b.SupportPhone = b.SupportPhoneAlt
	}
	if b.DefaultLanguage == "" {
		b.DefaultLanguage = b.DefaultLangAlt
	}
	if b.Server != nil {
		if b.ServerAddress == "" {
			b.ServerAddress = b.Server.Address
		}
		if b.ServerKey == "" {
			b.ServerKey = b.Server.PublicKey
		}
		if !b.UseHTTPS {
			for _, u := range []string{b.Server.Address, b.Server.ConsoleURL, b.Server.APIURL, b.Server.CDAPURL} {
				if strings.HasPrefix(strings.TrimSpace(u), "https://") || strings.HasPrefix(strings.TrimSpace(u), "wss://") {
					b.UseHTTPS = true
					break
				}
			}
		}
	}

	d := brandingDefaults()
	if b.ProductName == "" {
		b.ProductName = d.ProductName
	}
	if b.CompanyName == "" {
		b.CompanyName = d.CompanyName
	}
	if b.PrimaryColor == "" {
		b.PrimaryColor = d.PrimaryColor
	}
	if b.AccentColor == "" {
		b.AccentColor = d.AccentColor
	}
	if b.BackgroundColor == "" {
		b.BackgroundColor = d.BackgroundColor
	}
	if b.SurfaceColor == "" {
		b.SurfaceColor = d.SurfaceColor
	}
	if b.TextColor == "" {
		b.TextColor = d.TextColor
	}
	if b.TextMutedColor == "" {
		b.TextMutedColor = d.TextMutedColor
	}
	if b.StatusReadyColor == "" {
		b.StatusReadyColor = d.StatusReadyColor
	}
	if b.HeaderTextColor == "" {
		b.HeaderTextColor = d.HeaderTextColor
	}
	if b.DefaultLanguage == "" {
		b.DefaultLanguage = d.DefaultLanguage
	}
	return b
}

// brandingEmbedHasLegacyToken reports whether the baked branding.json still
// carries a non-empty enrollment_token (shared bundle key — must not be used).
func brandingEmbedHasLegacyToken() bool {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(brandingJSON, &probe); err != nil {
		return false
	}
	raw, ok := probe["enrollment_token"]
	if !ok {
		return false
	}
	return strings.Trim(string(raw), `" \t\n\r`) != ""
}

func (b Branding) LogoBytes() []byte {
	if b.LogoDataURL == "" {
		return nil
	}
	idx := strings.Index(b.LogoDataURL, ",")
	if idx < 0 {
		return nil
	}
	meta, payload := b.LogoDataURL[:idx], b.LogoDataURL[idx+1:]
	if strings.Contains(meta, "base64") {
		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return nil
		}
		return data
	}
	return []byte(payload)
}

func (b Branding) HasConnection() bool {
	return strings.TrimSpace(b.ServerAddress) != ""
}
