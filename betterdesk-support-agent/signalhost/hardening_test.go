package signalhost

import (
	"net"
	"testing"
	"time"
)

func TestValidLoginPasswordRejectsEmptyLocalPassword(t *testing.T) {
	salt, challenge := "salt", "challenge"
	emptyHash := hashPassword("", salt, challenge)
	if validLoginPassword("", salt, challenge, emptyHash[:]) {
		t.Fatal("empty local password must never authenticate")
	}

	password := "secret12"
	expected := hashPassword(password, salt, challenge)
	if !validLoginPassword(password, salt, challenge, expected[:]) {
		t.Fatal("configured password should authenticate its matching hash")
	}
}

func TestHostDoesNotStartWhenAccessIsDisabled(t *testing.T) {
	host := New(Config{
		SignalAddr:     "127.0.0.1:21116",
		DeviceID:       "BD-TEST",
		DesktopEnabled: true,
		AccessAllowed: func() bool {
			return false
		},
	})
	if host.Start() {
		t.Fatal("host started despite disabled access policy")
	}
	if host.Running() {
		t.Fatal("host reports running despite disabled access policy")
	}
}

func TestDisconnectSessionsClosesActiveRelay(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()

	host := New(Config{})
	host.sessions = map[net.Conn]struct{}{server: {}}
	host.DisconnectSessions()

	readDone := make(chan error, 1)
	go func() {
		_, err := client.Read(make([]byte, 1))
		readDone <- err
	}()
	select {
	case err := <-readDone:
		if err == nil {
			t.Fatal("relay read succeeded after local disconnect")
		}
	case <-time.After(time.Second):
		t.Fatal("relay connection was not closed by local disconnect")
	}
}
