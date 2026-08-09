//go:build windows

package agent

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Native GDI capture — PowerShell-per-frame opened visible consoles and could
// flood the desktop during screenshot fallback / PeerInfo probing.

var (
	screenshotUser32 = windows.NewLazySystemDLL("user32.dll")
	screenshotGdi32  = windows.NewLazySystemDLL("gdi32.dll")

	procGetDC                  = screenshotUser32.NewProc("GetDC")
	procReleaseDC              = screenshotUser32.NewProc("ReleaseDC")
	procScreenshotMetrics      = screenshotUser32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC     = screenshotGdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = screenshotGdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = screenshotGdi32.NewProc("SelectObject")
	procBitBlt                 = screenshotGdi32.NewProc("BitBlt")
	procDeleteObject           = screenshotGdi32.NewProc("DeleteObject")
	procDeleteDC               = screenshotGdi32.NewProc("DeleteDC")
	procGetDIBits              = screenshotGdi32.NewProc("GetDIBits")
)

const (
	smCxscreen     = 0
	smCyscreen     = 1
	srcCopy        = 0x00CC0020
	biRGB          = 0
	dibRGBColors   = 0
	screenshotJPEG = 75
)

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

// captureScreenshotPlatform captures the primary screen via GDI and returns JPEG bytes.
func captureScreenshotPlatform() ([]byte, error) {
	width, _, _ := procScreenshotMetrics.Call(uintptr(smCxscreen))
	height, _, _ := procScreenshotMetrics.Call(uintptr(smCyscreen))
	if width == 0 || height == 0 {
		return nil, fmt.Errorf("invalid screen size %dx%d", width, height)
	}

	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(hdcMem)

	hbmp, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, width, height)
	if hbmp == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(hbmp)

	prev, _, _ := procSelectObject.Call(hdcMem, hbmp)
	if prev == 0 {
		return nil, fmt.Errorf("SelectObject failed")
	}
	defer procSelectObject.Call(hdcMem, prev)

	ok, _, _ := procBitBlt.Call(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, srcCopy)
	if ok == 0 {
		return nil, fmt.Errorf("BitBlt failed")
	}

	w, h := int(width), int(height)
	bgra := make([]byte, w*h*4)
	hdr := bitmapInfoHeader{
		biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		biWidth:       int32(w),
		biHeight:      -int32(h), // top-down
		biPlanes:      1,
		biBitCount:    32,
		biCompression: biRGB,
	}
	n, _, _ := procGetDIBits.Call(
		hdcMem,
		hbmp,
		0,
		uintptr(h),
		uintptr(unsafe.Pointer(&bgra[0])),
		uintptr(unsafe.Pointer(&hdr)),
		dibRGBColors,
	)
	if n == 0 {
		return nil, fmt.Errorf("GetDIBits failed")
	}

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i+3 < len(bgra) && i+3 < len(img.Pix); i += 4 {
		img.Pix[i+0] = bgra[i+2] // R
		img.Pix[i+1] = bgra[i+1] // G
		img.Pix[i+2] = bgra[i+0] // B
		img.Pix[i+3] = 255
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: screenshotJPEG}); err != nil {
		return nil, fmt.Errorf("jpeg encode: %w", err)
	}
	if out.Len() == 0 {
		return nil, fmt.Errorf("screenshot returned empty data")
	}
	return out.Bytes(), nil
}
