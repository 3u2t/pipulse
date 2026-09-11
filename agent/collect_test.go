package main

import "testing"

func TestParseCpuStat(t *testing.T) {
	idle, total := ParseCpuStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0\n")
	if total != 1000 {
		t.Fatalf("total=%d want 1000", total)
	}
	if idle != 850 {
		t.Fatalf("idle=%d want 850", idle)
	}
}

func TestParseMeminfo(t *testing.T) {
	total, avail := ParseMeminfo("MemTotal:        8096000 kB\nMemAvailable:    4000000 kB\n")
	if total != 8096000 || avail != 4000000 {
		t.Fatalf("got %d %d", total, avail)
	}
}
