package meshcentral

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha512"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
)

// AgentCredentials holds the MeshCentral agent-server RSA certificate used
// for binary handshake (separate from public web TLS).
type AgentCredentials struct {
	PrivateKey  *rsa.PrivateKey
	CertDER     []byte // ASN.1 DER certificate for AuthVerify response
	ServerID    string // hex SHA-384 of cert public key (for .msh ServerID=)
	ServerIDBin []byte // 48-byte binary hash
}

// LoadOrCreateAgentCredentials loads RSA-3072 agent-server credentials or generates new ones.
func LoadOrCreateAgentCredentials(certFile string) (*AgentCredentials, error) {
	if certFile != "" {
		if cred, err := loadAgentCredentials(certFile); err == nil {
			return cred, nil
		}
	}
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return nil, fmt.Errorf("mesh: generate rsa key: %w", err)
	}
	return credentialsFromKey(key, certFile)
}

func loadAgentCredentials(path string) (*AgentCredentials, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("mesh: invalid pem")
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		k, err2 := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err2 != nil {
			return nil, fmt.Errorf("mesh: parse key: %w", err)
		}
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("mesh: not rsa private key")
		}
		key = rk
	}
	return credentialsFromKey(key, path)
}

func credentialsFromKey(key *rsa.PrivateKey, savePath string) (*AgentCredentials, error) {
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("mesh: create cert: %w", err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	hash := sha512.Sum384(pubDER)
	serverIDHex := strings.ToUpper(fmt.Sprintf("%x", hash))
	cred := &AgentCredentials{
		PrivateKey:  key,
		CertDER:     certDER,
		ServerID:    serverIDHex,
		ServerIDBin: hash[:],
	}
	if savePath != "" {
		if err := saveAgentKey(savePath, key); err != nil {
			return nil, err
		}
	}
	return cred, nil
}

func saveAgentKey(path string, key *rsa.PrivateKey) error {
	dir := filepath.Dir(path)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	return os.WriteFile(path, pemBytes, 0600)
}

// WebCertHash returns SHA-384 hash (48 bytes) of a TLS certificate DER, or nil.
func WebCertHash(certDER []byte) []byte {
	if len(certDER) == 0 {
		return nil
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		h := sha512.Sum384(certDER)
		return h[:]
	}
	pubDER, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		h := sha512.Sum384(certDER)
		return h[:]
	}
	h := sha512.Sum384(pubDER)
	return h[:]
}

// SignServerAuth signs serverHash+serverNonce for MeshCommand AuthVerify response.
func (c *AgentCredentials) SignServerAuth(serverHash, serverNonce []byte) ([]byte, error) {
	data := make([]byte, 0, len(serverHash)+len(serverNonce))
	data = append(data, serverHash...)
	data = append(data, serverNonce...)
	sum := sha512.Sum384(data)
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.PrivateKey, crypto.SHA384, sum[:])
	if err != nil {
		return nil, err
	}
	return sig, nil
}

// VerifyAgentSignature verifies agent signature over webHash+serverNonce+agentNonce.
func VerifyAgentSignature(certDER, signature, webHash, serverNonce, agentNonce []byte) (string, error) {
	if len(webHash) != sha384Size || len(serverNonce) != sha384Size || len(agentNonce) != sha384Size {
		return "", errors.New("mesh: invalid nonce/hash length")
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return "", fmt.Errorf("mesh: parse agent cert: %w", err)
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return "", errors.New("mesh: agent cert not rsa")
	}
	data := make([]byte, 0, sha384Size*3)
	data = append(data, webHash...)
	data = append(data, serverNonce...)
	data = append(data, agentNonce...)
	sum := sha512.Sum384(data)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA384, sum[:], signature); err != nil {
		return "", fmt.Errorf("mesh: bad signature: %w", err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	h := sha512.Sum384(pubDER)
	// MeshCentral nodeid: base64 of hash with + -> @ and / -> $
	nodeID := base64NodeID(h[:])
	return nodeID, nil
}

func base64NodeID(hash []byte) string {
	s := encodeBase64(hash)
	s = strings.ReplaceAll(s, "+", "@")
	s = strings.ReplaceAll(s, "/", "$")
	return s
}

func encodeBase64(b []byte) string {
	const enc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	out := make([]byte, 0, (len(b)+2)/3*4)
	for i := 0; i < len(b); i += 3 {
		var n uint32
		rem := len(b) - i
		if rem >= 3 {
			n = uint32(b[i])<<16 | uint32(b[i+1])<<8 | uint32(b[i+2])
			out = append(out, enc[n>>18&63], enc[n>>12&63], enc[n>>6&63], enc[n&63])
		} else if rem == 2 {
			n = uint32(b[i])<<16 | uint32(b[i+1])<<8
			out = append(out, enc[n>>18&63], enc[n>>12&63], enc[n>>6&63], '=')
		} else {
			n = uint32(b[i]) << 16
			out = append(out, enc[n>>18&63], enc[n>>12&63], '=', '=')
		}
	}
	return string(out)
}

// NodeIDFromCertDER derives MeshCentral nodeid from agent certificate DER.
func NodeIDFromCertDER(certDER []byte) (string, error) {
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return "", err
	}
	pubDER, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		return "", err
	}
	h := sha512.Sum384(pubDER)
	return base64NodeID(h[:]), nil
}
