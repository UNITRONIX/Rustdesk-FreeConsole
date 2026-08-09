package signalhost

import "testing"

func TestAuthorizeOperatorFailsClosedWithoutSupervisedConsent(t *testing.T) {
	host := New(Config{
		Unattended: func() bool { return false },
	})
	if host.authorizesOperator("operator") {
		t.Fatal("supervised relay must reject when no consent callback is available")
	}
}

func TestAuthorizeOperatorReevaluatesUnattendedPolicy(t *testing.T) {
	unattended := false
	host := New(Config{
		Unattended: func() bool { return unattended },
		Consent:    func(string) bool { return false },
	})
	if host.authorizesOperator("operator") {
		t.Fatal("denied supervised policy must reject the operator")
	}

	unattended = true
	if !host.authorizesOperator("operator") {
		t.Fatal("current unattended policy should allow the operator")
	}
}
