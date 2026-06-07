package billing

import (
	"testing"
	"time"
)

func TestWriteReportsCSV(t *testing.T) {
	data, err := WriteReportsCSV([]ReportExportRow{{
		SessionID: "s1", DeviceID: "dev", Summary: "Fixed issue", CreatedAt: time.Now().UTC(),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || data[0] != 's' {
		t.Fatalf("unexpected csv: %q", string(data[:20]))
	}
}

func TestSimpleTextPDF(t *testing.T) {
	pdf := simpleTextPDF([]string{"BetterDesk billing report", "Line 2"})
	if len(pdf) < 100 || pdf[0] != '%' {
		t.Fatal("invalid pdf header")
	}
}

func TestEscapePDFString(t *testing.T) {
	got := escapePDFString(`test (parens) and \ backslash`)
	if got == "" {
		t.Fatal("empty")
	}
}
