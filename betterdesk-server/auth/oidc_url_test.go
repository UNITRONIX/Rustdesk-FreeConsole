package auth

import (
	"context"
	"testing"
)

func TestValidateOIDCFetchURL(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "https issuer", raw: "https://accounts.google.com/.well-known/openid-configuration", wantErr: false},
		{name: "http issuer", raw: "http://idp.example.com/.well-known/openid-configuration", wantErr: false},
		{name: "file scheme", raw: "file:///etc/passwd", wantErr: true},
		{name: "metadata IP", raw: "http://169.254.169.254/latest", wantErr: false},
		{name: "private IP", raw: "http://10.0.0.1/.well-known/openid-configuration", wantErr: false},
		{name: "localhost", raw: "http://localhost/.well-known/openid-configuration", wantErr: false},
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

func TestValidateOIDCFetchHost(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		host    string
		wantErr bool
	}{
		{name: "metadata IP", host: "169.254.169.254", wantErr: true},
		{name: "private IP", host: "10.0.0.1", wantErr: true},
		{name: "localhost", host: "localhost", wantErr: true},
		{name: "loopback IP", host: "127.0.0.1", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := resolveOIDCFetchHost(ctx, tc.host)
			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
