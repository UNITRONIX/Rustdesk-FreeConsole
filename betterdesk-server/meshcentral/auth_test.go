package meshcentral

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha512"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

func TestCookieCodecRoundTrip(t *testing.T) {
	c, err := NewCookieCodec("test-secret-key-for-mesh-cookies")
	if err != nil {
		t.Fatal(err)
	}
	data := &RelayCookieData{
		RUserID:   "user/admin",
		NodeID:    "node@test",
		Rights:    0xFFFFFFFF,
		ExpireMin: 60,
	}
	cookie, err := c.Encode(data, 60)
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.Decode(cookie, 60)
	if err != nil {
		t.Fatal(err)
	}
	if out.RUserID != data.RUserID || out.NodeID != data.NodeID {
		t.Fatalf("mismatch: %+v", out)
	}
}

func TestAgentCredentialsServerID(t *testing.T) {
	cred, err := LoadOrCreateAgentCredentials("")
	if err != nil {
		t.Fatal(err)
	}
	if len(cred.ServerID) != 96 { // hex sha384
		t.Fatalf("server id len %d", len(cred.ServerID))
	}
	if len(cred.ServerIDBin) != sha384Size {
		t.Fatalf("server id bin len %d", len(cred.ServerIDBin))
	}
}

func TestWebCertHashPEMAndDERMatch(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	hDER := WebCertHash(der)
	hPEM := WebCertHash(pemBytes)
	if len(hDER) != sha384Size || len(hPEM) != sha384Size {
		t.Fatalf("hash lengths der=%d pem=%d", len(hDER), len(hPEM))
	}
	if !bytes.Equal(hDER, hPEM) {
		t.Fatal("PEM and DER web cert hashes must match")
	}
	// Raw PEM bytes must NOT be hashed as opaque (legacy bug)
	if bytes.Equal(hPEM, sha384Raw(pemBytes)) {
		t.Fatal("WebCertHash must not hash raw PEM bytes")
	}
}

func TestWebCertHashFullchainUsesLeaf(t *testing.T) {
	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := x509.Certificate{
		SerialNumber:          big.NewInt(2),
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, &caTmpl, &caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	leafTmpl := x509.Certificate{
		SerialNumber: big.NewInt(3),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, &leafTmpl, &caTmpl, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	fullchain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	hFull := WebCertHash(fullchain)
	hLeaf := WebCertHash(leafDER)
	hCA := WebCertHash(caDER)
	if !bytes.Equal(hFull, hLeaf) {
		t.Fatal("fullchain must hash leaf (first CERTIFICATE)")
	}
	if bytes.Equal(hFull, hCA) {
		t.Fatal("fullchain must not hash CA")
	}
}

func TestWebCertHashInvalidReturnsNil(t *testing.T) {
	if WebCertHash(nil) != nil {
		t.Fatal("nil input")
	}
	if WebCertHash([]byte{}) != nil {
		t.Fatal("empty input")
	}
	if WebCertHash([]byte("not-a-cert")) != nil {
		t.Fatal("garbage must return nil (no opaque hash fallback)")
	}
	onlyKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: []byte{1, 2, 3}})
	if WebCertHash(onlyKey) != nil {
		t.Fatal("PEM without CERTIFICATE must return nil")
	}
}

func sha384Raw(b []byte) []byte {
	h := sha512.Sum384(b)
	return h[:]
}

func TestBuildCoreModulePacket(t *testing.T) {
	core := []byte("console.log('test');")
	pkt := BuildCoreModulePacket(core)
	if readU16(pkt, 0) != cmdCoreModule {
		t.Fatalf("cmd %d", readU16(pkt, 0))
	}
	if string(pkt[4:]) != string(core) {
		t.Fatal("core payload mismatch")
	}
}

func TestMeshPeerIDSanitize(t *testing.T) {
	id := meshPeerID("abc@def$ghi")
	if id == "" || len(id) < 6 {
		t.Fatalf("bad id %s", id)
	}
}
