//go:build fyneui

package main

import (
	"fmt"
	"image/color"
	"strings"
	"unicode"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

func (u *ui) brandedTheme() *brandedTheme {
	if th, ok := u.app.Settings().Theme().(*brandedTheme); ok {
		return th
	}
	if th, ok := newBrandedTheme(u.brand).(*brandedTheme); ok {
		return th
	}
	return &brandedTheme{base: theme.DefaultTheme()}
}

// newInfoBox renders a large branded ID/password box matching the generator preview.
func (u *ui) newInfoBox(title string, value any, monospace bool, onCopy func()) fyne.CanvasObject {
	th := u.brandedTheme()
	bg := canvas.NewRectangle(th.surface)
	bg.CornerRadius = 10

	titleLbl := widget.NewLabelWithStyle(strings.ToUpper(title), fyne.TextAlignLeading, fyne.TextStyle{})
	titleLbl.Importance = widget.LowImportance

	var valueWidget fyne.CanvasObject
	if lbl, ok := value.(*widget.Label); ok {
		valueWidget = lbl
	} else if s, ok := value.(string); ok {
		style := fyne.TextStyle{Bold: true}
		if monospace {
			style.Monospace = true
		}
		valueWidget = widget.NewLabelWithStyle(s, fyne.TextAlignLeading, style)
	} else if co, ok := value.(fyne.CanvasObject); ok {
		valueWidget = co
	} else {
		valueWidget = widget.NewLabel(fmt.Sprint(value))
	}

	copyBtn := widget.NewButtonWithIcon("", theme.ContentCopyIcon(), func() {
		if onCopy != nil {
			onCopy()
		}
	})
	copyBtn.Importance = widget.LowImportance

	valueRow := container.NewBorder(nil, nil, nil, copyBtn, valueWidget)
	inner := container.NewVBox(titleLbl, valueRow)
	return container.NewStack(bg, container.NewPadded(inner))
}

func (u *ui) buildBrandedHeaderBar() fyne.CanvasObject {
	th := u.brandedTheme()
	bg := canvas.NewRectangle(th.primary)

	name := u.brand.CompanyName
	if name == "" {
		name = u.brand.ProductName
	}
	tagline := u.brand.Tagline
	if tagline == "" {
		tagline = u.brand.ProductName
	}

	headerText := parseHexColor(u.brand.HeaderTextColor, color.RGBA{R: 255, G: 255, B: 255, A: 255})
	titleCol := canvas.NewText(name, headerText)
	titleCol.TextStyle = fyne.TextStyle{Bold: true}
	titleCol.TextSize = 16
	subCol := canvas.NewText(tagline, headerText)
	subCol.TextStyle = fyne.TextStyle{Italic: true}
	subCol.TextSize = 12

	inner := container.NewVBox(titleCol, subCol)
	return container.NewStack(bg, container.NewPadded(inner))
}

func (u *ui) buildFooterBar() fyne.CanvasObject {
	th := u.brandedTheme()
	bg := canvas.NewRectangle(th.surface)
	bg.SetMinSize(fyne.NewSize(0, 44))

	settingsBtn := widget.NewButtonWithIcon("", theme.SettingsIcon(), u.showSettings)
	settingsBtn.Importance = widget.LowImportance

	contactLbl := widget.NewLabelWithStyle(u.contactLine(), fyne.TextAlignCenter, fyne.TextStyle{})
	contactLbl.Importance = widget.LowImportance
	contactLbl.Truncation = fyne.TextTruncateClip

	quitBtn := widget.NewButtonWithIcon("", theme.CancelIcon(), func() { u.app.Quit() })
	quitBtn.Importance = widget.LowImportance

	center := container.NewCenter(contactLbl)
	row := container.NewBorder(nil, nil, settingsBtn, quitBtn, center)
	return container.NewStack(bg, container.NewPadded(row))
}

func (u *ui) contactLine() string {
	email := strings.TrimSpace(u.brand.SupportEmail)
	if email == "" {
		email = strings.TrimSpace(u.brand.SupportEmailAlt)
	}
	phone := strings.TrimSpace(u.brand.SupportPhone)
	if phone == "" {
		phone = strings.TrimSpace(u.brand.SupportPhoneAlt)
	}
	var parts []string
	if email != "" {
		parts = append(parts, email)
	}
	if phone != "" {
		parts = append(parts, phone)
	}
	if url := strings.TrimSpace(u.brand.ContactURL); url != "" {
		parts = append(parts, url)
	}
	return strings.Join(parts, " • ")
}

func (u *ui) shouldShowPasswordBox(mode string, custom bool) bool {
	if mode == AccessDisabled {
		return false
	}
	// Supervised and unattended sessions both use the access password —
	// operators need it to connect; the user may still get a consent prompt.
	return true
}

func newPrimaryButton(label string, icon fyne.Resource, tapped func()) *widget.Button {
	btn := widget.NewButtonWithIcon(label, icon, tapped)
	btn.Importance = widget.HighImportance
	return btn
}

func newSecondaryButton(label string, icon fyne.Resource, tapped func()) *widget.Button {
	btn := widget.NewButtonWithIcon(label, icon, tapped)
	btn.Importance = widget.MediumImportance
	return btn
}

func isPrintableASCII(s string) bool {
	for _, r := range s {
		if r > unicode.MaxASCII || !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}
