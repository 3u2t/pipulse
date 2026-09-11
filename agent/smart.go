// SMART collection on the host (runs as root via systemd, so it can read
// /dev/sd* directly — no privileged container needed). Stdlib only: shells
// out to smartctl, passes raw JSON through to the backend for parsing.
package main

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

var (
	smartCache   []string
	smartCacheTs time.Time
)

// CollectSmart returns raw `smartctl -j` documents, refreshed at most every 10
// minutes. Returns nil when smartmontools is missing — never an error.
func CollectSmart() []string {
	if time.Since(smartCacheTs) < 10*time.Minute && smartCacheTs.After(time.Now().Add(-time.Hour)) {
		return smartCache
	}
	if _, err := exec.LookPath("smartctl"); err != nil {
		return nil
	}
	devs := scanDrives()
	out := make([]string, 0, len(devs))
	for _, d := range devs {
		if doc := readDrive(d, ""); doc != "" {
			out = append(out, doc)
			continue
		}
		// SAT fallback for common USB/SATA bridges.
		if doc := readDrive(d, "sat"); doc != "" {
			out = append(out, doc)
		}
	}
	smartCache, smartCacheTs = out, time.Now()
	return out
}

func scanDrives() []string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "smartctl", "--scan-open").Output()
	if err != nil {
		return nil
	}
	var devs []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(line)
		if len(f) > 0 && strings.HasPrefix(f[0], "/dev/") && !seen[f[0]] {
			seen[f[0]] = true
			devs = append(devs, f[0])
		}
		if len(devs) >= 8 {
			break
		}
	}
	return devs
}

func readDrive(dev, dtype string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	args := []string{"-j", "-H", "-A", "-i", dev}
	if dtype != "" {
		args = []string{"-j", "-H", "-A", "-i", "-d", dtype, dev}
	}
	raw, err := exec.CommandContext(ctx, "smartctl", args...).Output()
	if err != nil && len(raw) == 0 {
		return ""
	}
	s := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(s, "{") || len(s) > 64*1024 {
		return ""
	}
	return s
}
