//go:build !linux

package timesync

func readOSClockSynced() *bool {
	return nil
}
