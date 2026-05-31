package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config holds all agent configuration.
type Config struct {
	Server      string   `json:"server"`      // ws://host:21122/cdap
	AuthMethod  string   `json:"auth_method"` // api_key, device_token, user_password
	APIKey      string   `json:"api_key,omitempty"`
	DeviceToken string   `json:"device_token,omitempty"`
	Username    string   `json:"username,omitempty"`
	Password    string   `json:"password,omitempty"`
	DeviceID    string   `json:"device_id,omitempty"`
	DeviceName  string   `json:"device_name,omitempty"`
	DeviceType  string   `json:"device_type,omitempty"` // os_agent, desktop, custom
	Tags        []string `json:"tags,omitempty"`

	Terminal    bool `json:"terminal"`
	FileBrowser bool `json:"file_browser"`
	Clipboard   bool `json:"clipboard"`
	Screenshot  bool `json:"screenshot"`
	// RequireConsent: when true the agent prints CONSENT_REQUEST to stdout
	// and waits for CONSENT_GRANTED / CONSENT_DENIED from stdin before
	// starting a desktop session. The Tauri wrapper shows a dialog to the user.
	RequireConsent bool `json:"require_consent"`

	FileRoot     string `json:"file_root,omitempty"` // root dir for file browser (default: /)
	HeartbeatSec int    `json:"heartbeat_sec"`       // default 15
	ReconnectSec int    `json:"reconnect_sec"`       // base reconnect delay
	MaxReconnect int    `json:"max_reconnect"`       // max reconnect delay
	LogLevel     string `json:"log_level"`           // debug, info, warning, error
	DataDir      string `json:"data_dir"`

	// VideoCodec pins the desktop-stream encoder. "" or "auto" lets the agent
	// pick the most efficient codec the operator can decode (probe-driven).
	// Concrete values: mjpeg, webp, h264, vp9, av1.
	VideoCodec string `json:"video_codec,omitempty"`
	// HwAccel pins the hardware encode back-end. "" or "auto" lets the probe
	// choose; "none" forces software. Concrete: vaapi, nvenc, qsv, amf,
	// videotoolbox.
	HwAccel string `json:"hw_accel,omitempty"`
}

// DefaultConfig returns sensible defaults for all platforms.
func DefaultConfig() *Config {
	hostname, _ := os.Hostname()

	// BD-2026-004: Platform-specific safe default for file browser root
	fileRoot := "/var/lib/betterdesk-agent/files"
	if runtime.GOOS == "windows" {
		fileRoot = filepath.Join(os.Getenv("ProgramData"), "BetterDesk", "AgentFiles")
		if fileRoot == filepath.Join("", "BetterDesk", "AgentFiles") {
			fileRoot = `C:\ProgramData\BetterDesk\AgentFiles`
		}
	}

	return &Config{
		Server:       "ws://localhost:21122/cdap",
		AuthMethod:   "api_key",
		DeviceType:   "os_agent",
		DeviceName:   hostname,
		Terminal:     true,
		FileBrowser:  true,
		Clipboard:    true,
		Screenshot:   true,
		FileRoot:     fileRoot,
		HeartbeatSec: 15,
		ReconnectSec: 5,
		MaxReconnect: 300,
		LogLevel:     "info",
		DataDir:      defaultDataDir(),
		VideoCodec:   CodecAuto,
		HwAccel:      HwAuto,
	}
}

// LoadConfig reads config from file (if path provided) then overlays env vars.
func LoadConfig(path string) (*Config, error) {
	cfg := DefaultConfig()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config: %w", err)
		}
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}
	cfg.loadEnv()
	return cfg, nil
}

func (c *Config) loadEnv() {
	envStr := func(key string, target *string) {
		if v := os.Getenv(key); v != "" {
			*target = v
		}
	}
	envBool := func(key string, target *bool) {
		v := strings.ToUpper(os.Getenv(key))
		if v == "Y" || v == "TRUE" || v == "1" {
			*target = true
		} else if v == "N" || v == "FALSE" || v == "0" {
			*target = false
		}
	}

	envStr("BDAGENT_SERVER", &c.Server)
	envStr("BDAGENT_AUTH_METHOD", &c.AuthMethod)
	envStr("BDAGENT_API_KEY", &c.APIKey)
	envStr("BDAGENT_DEVICE_TOKEN", &c.DeviceToken)
	envStr("BDAGENT_USERNAME", &c.Username)
	envStr("BDAGENT_PASSWORD", &c.Password)
	envStr("BDAGENT_DEVICE_ID", &c.DeviceID)
	envStr("BDAGENT_DEVICE_NAME", &c.DeviceName)
	envStr("BDAGENT_DEVICE_TYPE", &c.DeviceType)
	envStr("BDAGENT_LOG_LEVEL", &c.LogLevel)
	envStr("BDAGENT_DATA_DIR", &c.DataDir)
	envStr("BDAGENT_FILE_ROOT", &c.FileRoot)
	envStr("BDAGENT_VIDEO_CODEC", &c.VideoCodec)
	envStr("BDAGENT_HW_ACCEL", &c.HwAccel)
	envBool("BDAGENT_TERMINAL", &c.Terminal)
	envBool("BDAGENT_FILE_BROWSER", &c.FileBrowser)
	envBool("BDAGENT_CLIPBOARD", &c.Clipboard)
	envBool("BDAGENT_SCREENSHOT", &c.Screenshot)
}

// Validate checks required fields and clamps values to safe ranges.
func (c *Config) Validate() error {
	if c.Server == "" {
		return fmt.Errorf("server URL is required")
	}
	if !strings.HasPrefix(c.Server, "ws://") && !strings.HasPrefix(c.Server, "wss://") {
		return fmt.Errorf("server URL must start with ws:// or wss://")
	}
	// NATIVE-H1: warn when using plaintext ws:// against non-local hosts. API key
	// and terminal/file payloads would be transmitted unencrypted.
	if strings.HasPrefix(c.Server, "ws://") {
		host := strings.TrimPrefix(c.Server, "ws://")
		if i := strings.IndexAny(host, "/:"); i >= 0 {
			host = host[:i]
		}
		isLocal := host == "localhost" || host == "127.0.0.1" || host == "::1"
		if !isLocal {
			log.Printf("WARNING: server URL uses plaintext ws:// (%s). API key and CDAP payloads will be transmitted unencrypted. Use wss:// in production.", c.Server)
		}
	}
	switch c.AuthMethod {
	case "api_key":
		if c.APIKey == "" {
			return fmt.Errorf("api_key required for api_key auth")
		}
	case "device_token":
		if c.DeviceToken == "" {
			return fmt.Errorf("device_token required for device_token auth")
		}
	case "user_password":
		if c.Username == "" || c.Password == "" {
			return fmt.Errorf("username and password required for user_password auth")
		}
	default:
		return fmt.Errorf("unknown auth method: %s (expected: api_key, device_token, user_password)", c.AuthMethod)
	}
	if c.HeartbeatSec < 5 {
		c.HeartbeatSec = 5
	}
	if c.HeartbeatSec > 300 {
		c.HeartbeatSec = 300
	}
	if c.ReconnectSec < 1 {
		c.ReconnectSec = 1
	}
	if c.MaxReconnect < c.ReconnectSec {
		c.MaxReconnect = c.ReconnectSec * 60
	}
	c.VideoCodec = normalizeCodecValue(c.VideoCodec)
	c.HwAccel = normalizeHwAccelValue(c.HwAccel)
	return nil
}

// normalizeCodecValue lowercases and validates a configured codec, falling
// back to "auto" for empty or unknown values.
func normalizeCodecValue(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case CodecMJPEG, CodecWebP, CodecH264, CodecVP9, CodecAV1:
		return strings.ToLower(strings.TrimSpace(v))
	default:
		return CodecAuto
	}
}

// normalizeHwAccelValue lowercases and validates a configured hw back-end,
// falling back to "auto" for empty or unknown values.
func normalizeHwAccelValue(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case HwNone, HwVAAPI, HwNVENC, HwQSV, HwAMF, HwVideoToolbox:
		return strings.ToLower(strings.TrimSpace(v))
	default:
		return HwAuto
	}
}

func defaultDataDir() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("ProgramData"), "BetterDesk", "Agent")
	}
	return "/var/lib/betterdesk-agent"
}
