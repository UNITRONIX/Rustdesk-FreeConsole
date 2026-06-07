package main

import (
	"fmt"
	"net/http"

	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
)

type deviceTOTPStatus struct {
	Enabled bool   `json:"enabled"`
	URI     string `json:"otpauth_uri,omitempty"`
	Secret  string `json:"secret,omitempty"`
}

func (u *ui) fetchTOTPStatus() (deviceTOTPStatus, error) {
	st := u.state
	st.mu.Lock()
	deviceID := st.DeviceID
	token := st.DeviceToken
	st.mu.Unlock()
	url := fmt.Sprintf("%s/devices/self/totp?device_id=%s&device_token=%s", apiBaseURL(u.brand), deviceID, token)
	var resp deviceTOTPStatus
	code, err := apiJSON(http.MethodGet, url, nil, &resp)
	if err != nil {
		return resp, err
	}
	if code != http.StatusOK {
		return resp, fmt.Errorf("HTTP %d", code)
	}
	return resp, nil
}

func (u *ui) showTOTPSettings() {
	status, err := u.fetchTOTPStatus()
	if err != nil {
		u.notify(err.Error())
		return
	}
	statusLbl := widget.NewLabel("")
	if status.Enabled {
		statusLbl.SetText(t("totp_enabled"))
	} else {
		statusLbl.SetText(t("totp_disabled"))
	}
	enableBtn := widget.NewButton(t("totp_setup"), func() {
		u.setupTOTP()
	})
	disableBtn := widget.NewButton(t("totp_disable"), func() {
		u.disableTOTP()
	})
	if status.Enabled {
		enableBtn.Hide()
	} else {
		disableBtn.Hide()
	}
	body := container.NewVBox(statusLbl, enableBtn, disableBtn)
	d := dialog.NewCustom(t("totp_title"), t("close"), body, u.win)
	d.Show()
}

func (u *ui) setupTOTP() {
	st := u.state
	st.mu.Lock()
	payload := map[string]any{
		"device_id": st.DeviceID, "device_token": st.DeviceToken, "action": "setup",
	}
	st.mu.Unlock()
	var resp deviceTOTPStatus
	code, err := apiJSON(http.MethodPost, apiBaseURL(u.brand)+"/devices/self/totp", payload, &resp)
	if err != nil || code != http.StatusOK {
		u.notify(t("totp_setup_failed"))
		return
	}
	secretLbl := widget.NewLabel(resp.Secret)
	uriLbl := widget.NewLabel(resp.URI)
	codeEntry := widget.NewEntry()
	codeEntry.SetPlaceHolder(t("totp_enter_code"))
	dialog.NewCustomConfirm(t("totp_title"), t("totp_verify_enable"), t("cancel"),
		container.NewVBox(
			widget.NewLabel(t("totp_manual_key")),
			secretLbl,
			widget.NewLabel(t("totp_step2")),
			uriLbl,
			codeEntry,
		), func(ok bool) {
			if !ok {
				return
			}
			u.enableTOTP(codeEntry.Text)
		}, u.win).Show()
}

func (u *ui) enableTOTP(code string) {
	st := u.state
	st.mu.Lock()
	payload := map[string]any{
		"device_id": st.DeviceID, "device_token": st.DeviceToken,
		"action": "enable", "code": code,
	}
	st.mu.Unlock()
	var resp deviceTOTPStatus
	httpCode, err := apiJSON(http.MethodPost, apiBaseURL(u.brand)+"/devices/self/totp", payload, &resp)
	if err != nil || httpCode != http.StatusOK {
		u.notify(t("totp_invalid_code"))
		return
	}
	u.notify(t("totp_enabled_success"))
}

func (u *ui) disableTOTP() {
	entry := widget.NewEntry()
	entry.SetPlaceHolder(t("totp_enter_code"))
	dialog.NewCustomConfirm(t("totp_disable"), t("save"), t("cancel"), entry, func(ok bool) {
		if !ok {
			return
		}
		st := u.state
		st.mu.Lock()
		payload := map[string]any{
			"device_id": st.DeviceID, "device_token": st.DeviceToken,
			"action": "disable", "code": entry.Text,
		}
		st.mu.Unlock()
		var resp deviceTOTPStatus
		httpCode, err := apiJSON(http.MethodPost, apiBaseURL(u.brand)+"/devices/self/totp", payload, &resp)
		if err != nil || httpCode != http.StatusOK {
			u.notify(t("totp_invalid_code"))
			return
		}
		u.notify(t("totp_disabled_success"))
	}, u.win).Show()
}
