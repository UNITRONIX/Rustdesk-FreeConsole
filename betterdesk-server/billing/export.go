package billing

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

// ReportExportRow is a flattened work report for export.
type ReportExportRow struct {
	SessionID   string
	DeviceID    string
	OrgID       string
	OperatorID  string
	Summary     string
	Category    string
	TicketRef   string
	BilledMin   int
	Amount      float64
	Currency    string
	CreatedAt   time.Time
}

// SessionExportRow is a flattened billing session for export.
type SessionExportRow struct {
	ID            string
	OrgID         string
	DeviceID      string
	OperatorID    string
	Status        string
	BillingPhase  string
	BilledMinutes int
	AmountOverage float64
	Currency      string
	StartedAt     time.Time
	EndedAt       *time.Time
}

// WriteReportsCSV writes work reports as CSV bytes.
func WriteReportsCSV(rows []ReportExportRow) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"session_id", "device_id", "org_id", "operator_id", "summary", "category", "ticket_ref", "billed_minutes", "amount", "currency", "created_at"})
	for _, r := range rows {
		_ = w.Write([]string{
			r.SessionID, r.DeviceID, r.OrgID, r.OperatorID, r.Summary, r.Category, r.TicketRef,
			strconv.Itoa(r.BilledMin), fmt.Sprintf("%.2f", r.Amount), r.Currency, r.CreatedAt.Format(time.RFC3339),
		})
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// WriteSessionsCSV writes billing sessions as CSV bytes.
func WriteSessionsCSV(rows []SessionExportRow) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"id", "org_id", "device_id", "operator_id", "status", "billing_phase", "billed_minutes", "amount_overage", "currency", "started_at", "ended_at"})
	for _, r := range rows {
		ended := ""
		if r.EndedAt != nil {
			ended = r.EndedAt.Format(time.RFC3339)
		}
		_ = w.Write([]string{
			r.ID, r.OrgID, r.DeviceID, r.OperatorID, r.Status, r.BillingPhase,
			strconv.Itoa(r.BilledMinutes), fmt.Sprintf("%.2f", r.AmountOverage), r.Currency,
			r.StartedAt.Format(time.RFC3339), ended,
		})
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// WriteReportsPDF writes a minimal text PDF with report lines.
func WriteReportsPDF(rows []ReportExportRow, title string) []byte {
	var lines []string
	lines = append(lines, title)
	lines = append(lines, fmt.Sprintf("Generated: %s", time.Now().UTC().Format(time.RFC3339)))
	lines = append(lines, "")
	for i, r := range rows {
		lines = append(lines, fmt.Sprintf("#%d  Session: %s", i+1, r.SessionID))
		lines = append(lines, fmt.Sprintf("Device: %s  Org: %s  Operator: %s", r.DeviceID, r.OrgID, r.OperatorID))
		lines = append(lines, fmt.Sprintf("Time: %s  Billed: %d min  Amount: %.2f %s", r.CreatedAt.Format(time.RFC3339), r.BilledMin, r.Amount, r.Currency))
		if r.Category != "" {
			lines = append(lines, "Category: "+r.Category)
		}
		if r.TicketRef != "" {
			lines = append(lines, "Ticket: "+r.TicketRef)
		}
		lines = append(lines, "Summary: "+sanitizePDFText(r.Summary))
		lines = append(lines, "")
	}
	return simpleTextPDF(lines)
}

func sanitizePDFText(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}

// simpleTextPDF builds a minimal valid PDF 1.4 document with Helvetica text.
func simpleTextPDF(lines []string) []byte {
	var content strings.Builder
	content.WriteString("BT\n/F1 10 Tf\n")
	y := 770
	for _, line := range lines {
		if y < 40 {
			break
		}
		escaped := escapePDFString(line)
		content.WriteString(fmt.Sprintf("1 0 0 1 40 %d Tm (%s) Tj\n", y, escaped))
		y -= 14
	}
	content.WriteString("ET\n")
	stream := content.String()

	var buf bytes.Buffer
	w := func(s string) { buf.WriteString(s) }
	w("%PDF-1.4\n")
	offs := []int{0}
	offs = append(offs, buf.Len())
	w("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n")
	offs = append(offs, buf.Len())
	w("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n")
	offs = append(offs, buf.Len())
	w("3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>endobj\n")
	offs = append(offs, buf.Len())
	w(fmt.Sprintf("4 0 obj<< /Length %d >>stream\n%s\nendstream\nendobj\n", len(stream), stream))
	offs = append(offs, buf.Len())
	w("5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n")
	xref := buf.Len()
	w("xref\n")
	w(fmt.Sprintf("0 %d\n", len(offs)))
	w("0000000000 65535 f \n")
	for i := 1; i < len(offs); i++ {
		w(fmt.Sprintf("%010d 00000 n \n", offs[i]))
	}
	w("trailer<< /Size 6 /Root 1 0 R >>\n")
	w(fmt.Sprintf("startxref\n%d\n%%EOF\n", xref))
	return buf.Bytes()
}

func escapePDFString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `(`, `\(`)
	s = strings.ReplaceAll(s, `)`, `\)`)
	r := []rune(s)
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}

// BuildReportExportRows joins reports with session billing data.
func BuildReportExportRows(reports []*db.BillingWorkReport, sessions map[string]*db.BillingSession) []ReportExportRow {
	out := make([]ReportExportRow, 0, len(reports))
	for _, r := range reports {
		row := ReportExportRow{
			SessionID:  r.SessionID,
			OperatorID: r.OperatorID,
			Summary:    r.Summary,
			Category:   r.Category,
			TicketRef:  r.TicketRef,
			CreatedAt:  r.CreatedAt,
		}
		if sess, ok := sessions[r.SessionID]; ok && sess != nil {
			row.DeviceID = sess.DeviceID
			row.OrgID = sess.OrgID
			row.BilledMin = sess.BilledMinutes
			row.Amount = sess.AmountIncluded + sess.AmountOverage
			row.Currency = sess.Currency
		}
		out = append(out, row)
	}
	return out
}
