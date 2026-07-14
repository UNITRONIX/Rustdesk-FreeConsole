package api

import (
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

func TestBuildDeviceActivityReportSplitsActualSessionByLocalDayAndOperator(t *testing.T) {
	location, err := time.LoadLocation("Europe/Bratislava")
	if err != nil {
		t.Fatal(err)
	}
	from := time.Date(2026, 6, 1, 0, 0, 0, 0, location)
	to := from.AddDate(0, 0, 3)
	startedAt := time.Date(2026, 6, 1, 21, 30, 0, 0, time.UTC) // 23:30 local
	endedAt := time.Date(2026, 6, 2, 0, 30, 0, 0, time.UTC)    // 02:30 local
	report := buildDeviceActivityReport(
		map[string]*db.Peer{"WORKPC1": {ID: "WORKPC1", DisplayName: "Accounting PC", Hostname: "acct-01"}},
		[]*db.RemoteAccessSession{{
			ID: 1, SessionKey: "native:1", TargetID: "WORKPC1", OperatorUsername: "support.alice",
			ControllerID: "HELPPC1", StartedAt: startedAt, LastSeenAt: endedAt, EndedAt: &endedAt,
		}}, from, to, location, endedAt.Add(time.Hour),
	)
	if len(report.Operators) != 1 || report.Operators[0].Username != "support.alice" {
		t.Fatalf("operators = %+v", report.Operators)
	}
	operator := report.Operators[0]
	if operator.ConnectedSeconds != 3*60*60 || operator.DeviceCount != 1 || operator.SessionCount != 1 {
		t.Fatalf("operator totals = %+v", operator)
	}
	if len(operator.Devices) != 1 || len(operator.Devices[0].Days) != 2 {
		t.Fatalf("operator devices = %+v", operator.Devices)
	}
	days := operator.Devices[0].Days
	if days[0].Date != "2026-06-01" || days[0].ConnectedSeconds != 30*60 {
		t.Fatalf("first day = %+v", days[0])
	}
	if days[1].Date != "2026-06-02" || days[1].ConnectedSeconds != 150*60 {
		t.Fatalf("second day = %+v", days[1])
	}
	if report.Totals.ConnectedSeconds != 10800 || report.Totals.Operators != 1 || report.Totals.Devices != 1 {
		t.Fatalf("report totals = %+v", report.Totals)
	}
}

func TestBuildDeviceActivityReportCountsOpenSessionAsLiveToNow(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	startedAt := now.Add(-2 * time.Hour)
	from := now.Add(-30 * time.Minute)
	report := buildDeviceActivityReport(
		map[string]*db.Peer{"LIVEPC01": {ID: "LIVEPC01"}},
		[]*db.RemoteAccessSession{{
			ID: 1, SessionKey: "web:1", TargetID: "LIVEPC01", OperatorUsername: "bob",
			StartedAt: startedAt, LastSeenAt: now.Add(-time.Minute), Source: "web_console",
		}}, from, now.Add(24*time.Hour), time.UTC, now,
	)
	if len(report.Operators) != 1 || !report.Operators[0].Live {
		t.Fatalf("operators = %+v", report.Operators)
	}
	operator := report.Operators[0]
	if operator.ConnectedSeconds != 30*60 || operator.CurrentSessionSeconds != 2*60*60 {
		t.Fatalf("filtered and current duration = %+v", operator)
	}
	if operator.CurrentSessionStartedAt == nil || !operator.CurrentSessionStartedAt.Equal(startedAt) {
		t.Fatalf("current session start = %v, want %v", operator.CurrentSessionStartedAt, startedAt)
	}
	device := report.Devices[0]
	if !device.Live || device.ConnectedSeconds != 30*60 {
		t.Fatalf("device = %+v", device)
	}
	if len(device.Intervals) != 1 || !device.Intervals[0].Ongoing || device.Intervals[0].EndedAt != nil {
		t.Fatalf("intervals = %+v", device.Intervals)
	}
	if !device.Intervals[0].StartedAt.Equal(startedAt) || device.Intervals[0].ConnectedSeconds != 30*60 || device.Intervals[0].ActualSeconds != 2*60*60 {
		t.Fatalf("evidence interval = %+v", device.Intervals[0])
	}
	if report.Totals.LiveSessions != 1 {
		t.Fatalf("live sessions = %d", report.Totals.LiveSessions)
	}
}
