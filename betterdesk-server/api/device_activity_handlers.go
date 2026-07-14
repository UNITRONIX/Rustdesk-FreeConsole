package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/unitronix/betterdesk-server/db"
)

const (
	deviceActivityDateLayout = "2006-01-02"
	deviceActivityMaxDays    = 366
	deviceActivityMaxDevices = 1000
)

type deviceActivityRequest struct {
	FromDate  string   `json:"from_date"`
	ToDate    string   `json:"to_date"`
	Timezone  string   `json:"timezone"`
	DeviceIDs []string `json:"device_ids"`
	Operators []string `json:"operators"`
}

type remoteSessionInterval struct {
	SessionID        int64      `json:"session_id"`
	PeerID           string     `json:"peer_id"`
	Operator         string     `json:"operator"`
	ControllerID     string     `json:"controller_id"`
	ControllerName   string     `json:"controller_name"`
	ConnectionType   int        `json:"connection_type"`
	Source           string     `json:"source"`
	StartedAt        time.Time  `json:"started_at"`
	EndedAt          *time.Time `json:"ended_at,omitempty"`
	ConnectedSeconds int64      `json:"connected_seconds"`
	ActualSeconds    int64      `json:"actual_connected_seconds"`
	Ongoing          bool       `json:"ongoing"`
}

type remoteActivityDay struct {
	Date             string `json:"date"`
	ConnectedSeconds int64  `json:"connected_seconds"`
	SessionCount     int    `json:"session_count"`
}

type remoteActivityOperatorDevice struct {
	PeerID           string                  `json:"peer_id"`
	DisplayName      string                  `json:"display_name"`
	Hostname         string                  `json:"hostname"`
	ConnectedSeconds int64                   `json:"connected_seconds"`
	SessionCount     int                     `json:"session_count"`
	ActiveDays       int                     `json:"active_days"`
	Live             bool                    `json:"live"`
	Days             []remoteActivityDay     `json:"days"`
	Intervals        []remoteSessionInterval `json:"intervals"`
}

type remoteActivityOperator struct {
	Username                string                          `json:"username"`
	ConnectedSeconds        int64                           `json:"connected_seconds"`
	CurrentSessionSeconds   int64                           `json:"current_session_seconds"`
	CurrentSessionStartedAt *time.Time                      `json:"current_session_started_at,omitempty"`
	SessionCount            int                             `json:"session_count"`
	DeviceCount             int                             `json:"device_count"`
	ActiveDays              int                             `json:"active_days"`
	Live                    bool                            `json:"live"`
	Devices                 []*remoteActivityOperatorDevice `json:"devices"`
}

type remoteActivityDevice struct {
	PeerID           string                  `json:"peer_id"`
	DisplayName      string                  `json:"display_name"`
	Hostname         string                  `json:"hostname"`
	AssignedUser     string                  `json:"assigned_user"`
	ConnectedSeconds int64                   `json:"connected_seconds"`
	SessionCount     int                     `json:"session_count"`
	ActiveDays       int                     `json:"active_days"`
	Live             bool                    `json:"live"`
	ActiveOperators  []string                `json:"active_operators"`
	Days             []remoteActivityDay     `json:"days"`
	Intervals        []remoteSessionInterval `json:"intervals"`
}

type remoteActivityTotals struct {
	Operators        int   `json:"operators"`
	Devices          int   `json:"devices"`
	LiveSessions     int   `json:"live_sessions"`
	Sessions         int   `json:"sessions"`
	ConnectedSeconds int64 `json:"connected_seconds"`
}

type deviceActivityReport struct {
	From        time.Time                 `json:"from"`
	ToExclusive time.Time                 `json:"to_exclusive"`
	FromDate    string                    `json:"from_date"`
	ToDate      string                    `json:"to_date"`
	Timezone    string                    `json:"timezone"`
	GeneratedAt time.Time                 `json:"generated_at"`
	Totals      remoteActivityTotals      `json:"totals"`
	Operators   []*remoteActivityOperator `json:"operators"`
	Devices     []*remoteActivityDevice   `json:"devices"`
}

func (s *Server) handleDeviceActivityReport(w http.ResponseWriter, r *http.Request) {
	var request deviceActivityRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid report request"})
		return
	}
	if len(request.DeviceIDs) > deviceActivityMaxDevices {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many devices selected"})
		return
	}

	locationName := strings.TrimSpace(request.Timezone)
	if locationName == "" {
		locationName = "UTC"
	}
	location, err := time.LoadLocation(locationName)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid timezone"})
		return
	}
	now := time.Now().UTC()
	localNow := now.In(location)
	if request.FromDate == "" {
		request.FromDate = time.Date(localNow.Year(), localNow.Month(), 1, 0, 0, 0, 0, location).Format(deviceActivityDateLayout)
	}
	if request.ToDate == "" {
		request.ToDate = localNow.Format(deviceActivityDateLayout)
	}
	from, err := time.ParseInLocation(deviceActivityDateLayout, request.FromDate, location)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "from_date must use YYYY-MM-DD"})
		return
	}
	toDay, err := time.ParseInLocation(deviceActivityDateLayout, request.ToDate, location)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "to_date must use YYYY-MM-DD"})
		return
	}
	toExclusive := toDay.AddDate(0, 0, 1)
	if !toExclusive.After(from) || toExclusive.After(from.AddDate(0, 0, deviceActivityMaxDays)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "report range must be between 1 and 366 days"})
		return
	}

	peers, peerIDs, err := s.activityReportPeers(r, request.DeviceIDs)
	if err != nil {
		writeInternalError(w, err, "DeviceActivityPeers")
		return
	}
	operatorFilter := cleanStrings(request.Operators)
	if _, err := s.db.CloseStaleWebRemoteAccessSessions(now.Add(-3*time.Minute), time.Minute); err != nil {
		writeInternalError(w, err, "CloseStaleWebRemoteAccessSessions")
		return
	}
	var sessions []*db.RemoteAccessSession
	if len(peerIDs) > 0 {
		sessions, err = s.db.ListRemoteAccessSessions(db.RemoteAccessSessionFilter{
			TargetIDs: peerIDs, Operators: operatorFilter, From: from.UTC(), To: toExclusive.UTC(),
		})
		if err != nil {
			writeInternalError(w, err, "ListRemoteAccessSessions")
			return
		}
	}
	report := buildDeviceActivityReport(peers, sessions, from, toExclusive, location, now)
	writeJSON(w, http.StatusOK, report)
}

func cleanStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func (s *Server) activityReportPeers(r *http.Request, requested []string) (map[string]*db.Peer, []string, error) {
	requestedSet := make(map[string]struct{}, len(requested))
	for _, id := range requested {
		if id = strings.TrimSpace(id); id != "" {
			requestedSet[id] = struct{}{}
		}
	}
	orgID := getOrgIDFromCtx(r)
	if orgID != "" {
		orgPeers, err := s.db.ListPeersForOrg(orgID, false)
		if err != nil {
			return nil, nil, err
		}
		result := make(map[string]*db.Peer)
		for _, peer := range orgPeers {
			if len(requestedSet) > 0 {
				if _, ok := requestedSet[peer.ID]; !ok {
					continue
				}
			}
			result[peer.ID] = peer
		}
		return result, sortedPeerIDs(result), nil
	}
	if len(requestedSet) > 0 {
		ids := make([]string, 0, len(requestedSet))
		for id := range requestedSet {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		peers, err := s.db.GetPeersByIDs(ids)
		return peers, sortedPeerIDs(peers), err
	}
	all, err := s.db.ListPeers(false)
	if err != nil {
		return nil, nil, err
	}
	peers := make(map[string]*db.Peer, len(all))
	for _, peer := range all {
		peers[peer.ID] = peer
	}
	return peers, sortedPeerIDs(peers), nil
}

func sortedPeerIDs(peers map[string]*db.Peer) []string {
	ids := make([]string, 0, len(peers))
	for id := range peers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

type activityDayAccumulator struct {
	seconds  int64
	sessions map[int64]struct{}
}

func addActivityDay(days map[string]*activityDayAccumulator, date string, sessionID int64, seconds int64) {
	day := days[date]
	if day == nil {
		day = &activityDayAccumulator{sessions: make(map[int64]struct{})}
		days[date] = day
	}
	day.seconds += seconds
	day.sessions[sessionID] = struct{}{}
}

func dayRows(days map[string]*activityDayAccumulator) []remoteActivityDay {
	rows := make([]remoteActivityDay, 0, len(days))
	for date, day := range days {
		rows = append(rows, remoteActivityDay{Date: date, ConnectedSeconds: day.seconds, SessionCount: len(day.sessions)})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Date < rows[j].Date })
	return rows
}

func splitSessionDays(start, end time.Time, location *time.Location, visit func(date string, seconds int64)) {
	cursor := start
	for cursor.Before(end) {
		localCursor := cursor.In(location)
		nextMidnight := time.Date(localCursor.Year(), localCursor.Month(), localCursor.Day()+1, 0, 0, 0, 0, location)
		segmentEnd := end
		if nextMidnight.Before(segmentEnd) {
			segmentEnd = nextMidnight
		}
		visit(localCursor.Format(deviceActivityDateLayout), int64(segmentEnd.Sub(cursor)/time.Second))
		cursor = segmentEnd
	}
}

func buildDeviceActivityReport(peers map[string]*db.Peer, sessions []*db.RemoteAccessSession, from, toExclusive time.Time, location *time.Location, now time.Time) deviceActivityReport {
	report := deviceActivityReport{
		From: from.UTC(), ToExclusive: toExclusive.UTC(),
		FromDate: from.In(location).Format(deviceActivityDateLayout),
		ToDate:   toExclusive.In(location).AddDate(0, 0, -1).Format(deviceActivityDateLayout),
		Timezone: location.String(), GeneratedAt: now.UTC(),
		Operators: []*remoteActivityOperator{}, Devices: []*remoteActivityDevice{},
	}
	operatorRows := make(map[string]*remoteActivityOperator)
	deviceRows := make(map[string]*remoteActivityDevice)
	operatorDevices := make(map[string]map[string]*remoteActivityOperatorDevice)
	operatorDays := make(map[string]map[string]*activityDayAccumulator)
	deviceDays := make(map[string]map[string]*activityDayAccumulator)
	operatorDeviceDays := make(map[string]map[string]*activityDayAccumulator)

	for _, session := range sessions {
		start := session.StartedAt
		if start.Before(from) {
			start = from
		}
		end := now
		ongoing := session.EndedAt == nil
		if session.EndedAt != nil {
			end = *session.EndedAt
		}
		if end.After(toExclusive) {
			end = toExclusive
		}
		if end.After(now) {
			end = now
		}
		if !end.After(start) {
			continue
		}
		operator := strings.TrimSpace(session.OperatorUsername)
		if operator == "" {
			operator = strings.TrimSpace(session.ControllerName)
		}
		if operator == "" {
			operator = session.ControllerID
		}
		if operator == "" {
			operator = "unknown"
		}
		seconds := int64(end.Sub(start) / time.Second)
		actualEnd := now
		if session.EndedAt != nil {
			actualEnd = *session.EndedAt
		}
		if actualEnd.After(now) {
			actualEnd = now
		}
		actualSeconds := int64(actualEnd.Sub(session.StartedAt) / time.Second)
		if actualSeconds < 0 {
			actualSeconds = 0
		}
		interval := remoteSessionInterval{
			SessionID: session.ID, PeerID: session.TargetID, Operator: operator,
			ControllerID: session.ControllerID, ControllerName: session.ControllerName,
			ConnectionType: session.ConnectionType, Source: session.Source,
			StartedAt: session.StartedAt.UTC(), ConnectedSeconds: seconds, ActualSeconds: actualSeconds, Ongoing: ongoing,
		}
		if !ongoing {
			intervalEnd := session.EndedAt.UTC()
			interval.EndedAt = &intervalEnd
		}

		operatorRow := operatorRows[operator]
		if operatorRow == nil {
			operatorRow = &remoteActivityOperator{Username: operator, Devices: []*remoteActivityOperatorDevice{}}
			operatorRows[operator] = operatorRow
			operatorDevices[operator] = make(map[string]*remoteActivityOperatorDevice)
			operatorDays[operator] = make(map[string]*activityDayAccumulator)
		}
		device := deviceRows[session.TargetID]
		if device == nil {
			peer := peers[session.TargetID]
			device = &remoteActivityDevice{PeerID: session.TargetID, Days: []remoteActivityDay{}, Intervals: []remoteSessionInterval{}, ActiveOperators: []string{}}
			if peer != nil {
				device.DisplayName, device.Hostname, device.AssignedUser = peer.DisplayName, peer.Hostname, peer.User
			}
			deviceRows[session.TargetID] = device
			deviceDays[session.TargetID] = make(map[string]*activityDayAccumulator)
		}
		operatorDevice := operatorDevices[operator][session.TargetID]
		if operatorDevice == nil {
			operatorDevice = &remoteActivityOperatorDevice{PeerID: device.PeerID, DisplayName: device.DisplayName, Hostname: device.Hostname, Days: []remoteActivityDay{}, Intervals: []remoteSessionInterval{}}
			operatorDevices[operator][session.TargetID] = operatorDevice
			operatorRow.Devices = append(operatorRow.Devices, operatorDevice)
			operatorRow.DeviceCount++
			operatorDeviceDays[operator+"\x00"+session.TargetID] = make(map[string]*activityDayAccumulator)
		}

		operatorRow.ConnectedSeconds += seconds
		operatorRow.SessionCount++
		device.ConnectedSeconds += seconds
		device.SessionCount++
		device.Intervals = append(device.Intervals, interval)
		operatorDevice.ConnectedSeconds += seconds
		operatorDevice.SessionCount++
		operatorDevice.Intervals = append(operatorDevice.Intervals, interval)
		if ongoing {
			operatorRow.Live, device.Live, operatorDevice.Live = true, true, true
			currentSessionSeconds := int64(now.Sub(session.StartedAt) / time.Second)
			if currentSessionSeconds < 0 {
				currentSessionSeconds = 0
			}
			if operatorRow.CurrentSessionStartedAt == nil || currentSessionSeconds > operatorRow.CurrentSessionSeconds {
				currentSessionStartedAt := session.StartedAt.UTC()
				operatorRow.CurrentSessionSeconds = currentSessionSeconds
				operatorRow.CurrentSessionStartedAt = &currentSessionStartedAt
			}
			device.ActiveOperators = appendUnique(device.ActiveOperators, operator)
			report.Totals.LiveSessions++
		}
		splitSessionDays(start, end, location, func(date string, segmentSeconds int64) {
			addActivityDay(operatorDays[operator], date, session.ID, segmentSeconds)
			addActivityDay(deviceDays[session.TargetID], date, session.ID, segmentSeconds)
			addActivityDay(operatorDeviceDays[operator+"\x00"+session.TargetID], date, session.ID, segmentSeconds)
		})
		report.Totals.ConnectedSeconds += seconds
		report.Totals.Sessions++
	}

	for operator, row := range operatorRows {
		row.ActiveDays = len(operatorDays[operator])
		for _, device := range row.Devices {
			device.Days = dayRows(operatorDeviceDays[operator+"\x00"+device.PeerID])
			device.ActiveDays = len(device.Days)
			sort.Slice(device.Intervals, func(i, j int) bool { return device.Intervals[i].StartedAt.Before(device.Intervals[j].StartedAt) })
		}
		sort.Slice(row.Devices, func(i, j int) bool {
			if row.Devices[i].ConnectedSeconds == row.Devices[j].ConnectedSeconds {
				return row.Devices[i].PeerID < row.Devices[j].PeerID
			}
			return row.Devices[i].ConnectedSeconds > row.Devices[j].ConnectedSeconds
		})
		report.Operators = append(report.Operators, row)
	}
	for id, row := range deviceRows {
		row.Days = dayRows(deviceDays[id])
		row.ActiveDays = len(row.Days)
		sort.Strings(row.ActiveOperators)
		sort.Slice(row.Intervals, func(i, j int) bool { return row.Intervals[i].StartedAt.Before(row.Intervals[j].StartedAt) })
		report.Devices = append(report.Devices, row)
	}
	sort.Slice(report.Operators, func(i, j int) bool {
		if report.Operators[i].ConnectedSeconds == report.Operators[j].ConnectedSeconds {
			return report.Operators[i].Username < report.Operators[j].Username
		}
		return report.Operators[i].ConnectedSeconds > report.Operators[j].ConnectedSeconds
	})
	sort.Slice(report.Devices, func(i, j int) bool {
		if report.Devices[i].ConnectedSeconds == report.Devices[j].ConnectedSeconds {
			return report.Devices[i].PeerID < report.Devices[j].PeerID
		}
		return report.Devices[i].ConnectedSeconds > report.Devices[j].ConnectedSeconds
	})
	report.Totals.Operators = len(report.Operators)
	report.Totals.Devices = len(report.Devices)
	return report
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
