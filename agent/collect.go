// Host metric collection from /proc and /sys. Linux-only; returns zero values elsewhere.
package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
)

type Metrics struct {
	CPUUsage float64 `json:"cpuUsage"`
	TempC    float64 `json:"tempC"`
	MemUsed  uint64  `json:"memUsedKb"`
	MemTotal uint64  `json:"memTotalKb"`
	Load1    float64 `json:"load1"`
	Uptime   uint64  `json:"uptimeSec"`
}

var prevIdle, prevTotal uint64
var havePrev bool

// ParseCpuStat parses /proc/stat content.
func ParseCpuStat(text string) (idle, total uint64) {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "cpu ") {
			f := strings.Fields(line)[1:]
			var t uint64
			for i, s := range f {
				v, _ := strconv.ParseUint(s, 10, 64)
				t += v
				if i == 3 || i == 4 {
					idle += v
				}
			}
			total = t
			return idle, total
		}
	}
	return 0, 0
}

// ParseMeminfo parses /proc/meminfo content.
func ParseMeminfo(text string) (total, avail uint64) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseUint(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	return total, avail
}

func readFile(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}

func Collect() Metrics {
	m := Metrics{}
	idle, total := ParseCpuStat(readFile("/proc/stat"))
	if havePrev && total > prevTotal {
		m.CPUUsage = (1 - float64(idle-prevIdle)/float64(total-prevTotal)) * 100
	}
	prevIdle, prevTotal, havePrev = idle, total, true

	tot, avail := ParseMeminfo(readFile("/proc/meminfo"))
	m.MemTotal = tot
	if tot >= avail {
		m.MemUsed = tot - avail
	}
	if la := strings.Fields(readFile("/proc/loadavg")); len(la) > 0 {
		m.Load1, _ = strconv.ParseFloat(la[0], 64)
	}
	if up := strings.Fields(readFile("/proc/uptime")); len(up) > 0 {
		f, _ := strconv.ParseFloat(up[0], 64)
		m.Uptime = uint64(f)
	}
	m.TempC = readTemp()
	return m
}

func readTemp() float64 {
	for _, z := range []string{"thermal_zone0", "thermal_zone1"} {
		b := readFile("/sys/class/thermal/" + z + "/temp")
		if v, err := strconv.ParseFloat(strings.TrimSpace(b), 64); err == nil && v > 0 {
			return v / 1000
		}
	}
	return 0
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

func arch() string { return runtime.GOARCH }

func defaultAgentID() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return "agent-" + h
	}
	return "agent-01"
}
