package main

import (
	"encoding/base64"
	"encoding/json"
	_ "embed"
	"os"
	"strings"
	"sync"
)

//go:embed resources/branding.json
var brandingJSON []byte

type ServerBranding struct {
	Address     string `json:"address"`
	APIURL      string `json:"api_url"`
	PublicKey   string `json:"public_key"`
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
	UseHTTPS         bool            `json:"use_https"`
	Server           *ServerBranding `json:"server,omitempty"`
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
		var b Branding
		if err := json.Unmarshal(raw, &b); err != nil {
			b = brandingDefaults()
		}
		brandingVal = b.normalize()
	})
	return brandingVal
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
