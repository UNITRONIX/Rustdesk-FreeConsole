package main

import (
	"encoding/base64"
	"encoding/json"
	_ "embed"
	"os"
	"strings"
	"sync"
)

// brandingJSON is the deployment branding profile baked into the binary at
// build time. The Console "Generator agenta" overwrites resources/branding.json
// before compiling, so every produced binary ships hardcoded branding plus the
// server connection details. An unbranded developer build embeds the checked-in
// defaults.
//
//go:embed resources/branding.json
var brandingJSON []byte

// ServerBranding mirrors the nested `server` object emitted by the Console
// generator schema. Flattened into Branding.ServerAddress / ServerKey on load.
type ServerBranding struct {
	Address   string `json:"address"`
	APIURL    string `json:"api_url"`
	PublicKey string `json:"public_key"`
}

// Branding is the subset of the Console branding schema the support agent
// consumes. Field aliases keep the same branding.json loading regardless of
// whether the agent-client or the Console generator produced it.
type Branding struct {
	ProductName     string          `json:"product_name"`
	CompanyName     string          `json:"company_name"`
	Tagline         string          `json:"tagline"`
	TaglineAlt      string          `json:"short_text"`
	SupportEmail    string          `json:"support_email"`
	SupportEmailAlt string          `json:"contact_email"`
	SupportPhone    string          `json:"support_phone"`
	SupportPhoneAlt string          `json:"contact_phone"`
	ContactURL      string          `json:"contact_url"`
	PrimaryColor    string          `json:"primary_color"`
	AccentColor     string          `json:"accent_color"`
	LogoDataURL     string          `json:"logo_data_url"`
	DefaultLanguage string          `json:"default_language"`
	DefaultLangAlt  string          `json:"default_lang"`
	AllowUnattended bool            `json:"allow_unattended"`
	ServerAddress   string          `json:"server_address"`
	ServerKey       string          `json:"server_key"`
	APIKey          string          `json:"api_key"`
	BundleID        string          `json:"bundle_id"`
	Server          *ServerBranding `json:"server,omitempty"`
}

var (
	brandingOnce sync.Once
	brandingVal  Branding
)

// brandingDefaults returns the built-in fallback values used when the embedded
// or override branding leaves a field empty.
func brandingDefaults() Branding {
	return Branding{
		ProductName:     "BetterDesk Support",
		CompanyName:     "BetterDesk",
		Tagline:         "Quick remote help",
		PrimaryColor:    "#2563eb",
		AccentColor:     "#0ea5e9",
		DefaultLanguage: "en",
	}
}

// GetBranding resolves and caches the branding for this process. The embedded
// profile is used by default; the BETTERDESK_AGENT_BRANDING environment
// variable points to an alternate JSON file for testing.
func GetBranding() Branding {
	brandingOnce.Do(func() {
		raw := brandingJSON
		if p := os.Getenv("BETTERDESK_AGENT_BRANDING"); p != "" {
			if data, err := os.ReadFile(p); err == nil {
				raw = data
			}
		}
		var b Branding
		if err := json.Unmarshal(raw, &b); err != nil {
			b = brandingDefaults()
		}
		brandingVal = b.normalize()
	})
	return brandingVal
}

// normalize flattens aliases + the nested server object and applies defaults.
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
	if b.DefaultLanguage == "" {
		b.DefaultLanguage = d.DefaultLanguage
	}
	return b
}

// LogoBytes decodes the embedded logo data URL into raw image bytes. Returns
// nil when no logo is configured or the data URL is malformed.
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
	// Non-base64 data URLs are URL-encoded text; treat as raw bytes.
	return []byte(payload)
}

// HasConnection reports whether the branding includes a usable server address.
func (b Branding) HasConnection() bool {
	return strings.TrimSpace(b.ServerAddress) != ""
}
