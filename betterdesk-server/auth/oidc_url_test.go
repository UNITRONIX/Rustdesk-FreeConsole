package auth

import "testing"

func TestValidateOIDCFetchURL(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "https issuer", raw: "https://accounts.google.com/.well-known/openid-configuration", wantErr: false},
		{name: "http issuer", raw: "http://idp.example.com/.well-known/openid-configuration", wantErr: false},
		{name: "file scheme", raw: "file:///etc/passwd", wantErr: true},
		{name: "metadata IP", raw: "http://169.254.169.254/latest", wantErr: true},
		{name: "credentials", raw: "https://user:pass@idp.example.com/", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateOIDCFetchURL(tc.raw)
			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
