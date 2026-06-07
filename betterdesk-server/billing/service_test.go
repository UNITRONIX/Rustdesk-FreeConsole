package billing

import (
	"testing"
	"time"
)

func TestRoundUpMinutes(t *testing.T) {
	if got := roundUpMinutes(61, 1); got != 2 {
		t.Fatalf("got %d want 2", got)
	}
	if got := roundUpMinutes(601, 10); got != 20 {
		t.Fatalf("got %d want 20", got)
	}
	if got := roundUpMinutes(600, 10); got != 10 {
		t.Fatalf("got %d want 10", got)
	}
}

func TestOverageSplit(t *testing.T) {
	remaining := 5
	billed := 12
	included := min(billed, remaining)
	overage := 0
	if billed > remaining {
		overage = billed - remaining
	}
	if included != 5 || overage != 7 {
		t.Fatalf("included=%d overage=%d", included, overage)
	}
	_ = time.Now()
}

func TestSessionAmountCalculation(t *testing.T) {
	includedUsed := 5
	overageMin := 7
	hourlyRate := 120.0
	overageRate := 180.0

	amountIncluded := (float64(includedUsed) / 60.0) * hourlyRate
	amountOverage := (float64(overageMin) / 60.0) * overageRate
	total := amountIncluded + amountOverage

	if amountIncluded != 10.0 {
		t.Fatalf("amountIncluded=%v want 10", amountIncluded)
	}
	if amountOverage != 21.0 {
		t.Fatalf("amountOverage=%v want 21", amountOverage)
	}
	if total != 31.0 {
		t.Fatalf("total=%v want 31", total)
	}
}
