// Host security signals for PiPulse. Runs on the host as root via systemd,
// so it can read the SSH journal, /proc/net/tcp* and firewall state —
// things the container can never see reliably (own net namespace, no
// journal). Stdlib only. Read-only: never blocks IPs, never changes rules.
//
// Reliability rules: every source degrades to "unknown"/empty instead of
// guessing, collection is cached (60s) and every external command has a
// timeout, so a stuck journalctl can never stall the push loop.
package main

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type SshAttempt struct {
	Ts   int64  `json:"ts"`
	User string `json:"user"`
	IP   string `json:"ip"`
	Ok   bool   `json:"ok"`
}

type ListenPort struct {
	Proto   string `json:"proto"` // tcp | tcp6
	Port    int    `json:"port"`
	Addr    string `json:"addr"`
	Exposed bool   `json:"exposed"` // bound to all interfaces, reachable from LAN/WAN
}

type Security struct {
	Ssh            []SshAttempt `json:"ssh,omitempty"`
	SshLog         bool         `json:"sshLog"`
	Ports          []ListenPort `json:"ports,omitempty"`
	Firewall       string       `json:"firewall"` // ufw | nft | iptables | none | unknown
	FirewallDetail string       `json:"firewallDetail,omitempty"`
	Fail2ban       string       `json:"fail2ban"` // active | inactive | missing
	SecUpdates     *int         `json:"secUpdates,omitempty"`
	RebootRequired bool         `json:"rebootRequired"`
}

var (
	secCache   *Security
	secCacheTs time.Time
)

// CollectSecurityCached refreshes at most every 60s. Never returns nil —
// callers always get a usable struct, with "unknown" where detection failed.
func CollectSecurityCached() *Security {
	if secCache != nil && time.Since(secCacheTs) < time.Minute {
		return secCache
	}
	s := CollectSecurity()
	secCache, secCacheTs = s, time.Now()
	return s
}

func CollectSecurity() *Security {
	s := &Security{Firewall: "unknown", Fail2ban: "missing"}
	s.Ssh, s.SshLog = collectSshAttempts()
	s.Ports = collectListenPorts()
	s.Firewall, s.FirewallDetail = detectFirewall()
	s.Fail2ban = detectFail2ban()
	s.SecUpdates = countSecurityUpdates()
	s.RebootRequired = fileExists("/var/run/reboot-required")
	return s
}

func runCmd(timeout time.Duration, name string, args ...string) (string, bool) {
	if _, err := exec.LookPath(name); err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---------- SSH logins ----------

var (
	reFailed   = regexp.MustCompile(`Failed \S+ for (?:invalid user )?(\S+) from (\S+) port`)
	reAccepted = regexp.MustCompile(`Accepted \S+ for (\S+) from (\S+) port`)
)

func parseSshLine(line string, now time.Time) (SshAttempt, bool) {
	var a SshAttempt
	if m := reFailed.FindStringSubmatch(line); m != nil {
		a.User, a.IP = m[1], m[2]
	} else if m := reAccepted.FindStringSubmatch(line); m != nil {
		a.User, a.IP, a.Ok = m[1], m[2], true
	} else {
		return a, false
	}
	a.Ts = sshLineTime(line, now)
	return a, true
}

// journalctl short-iso starts with 2026-09-13T20:01:22+0200,
// auth.log with "Sep 13 20:01:22". Unparseable -> now (the source window is
// recent anyway, and backend re-filters by age).
func sshLineTime(line string, now time.Time) int64 {
	if f := strings.Fields(line); len(f) > 0 {
		if t, err := time.Parse("2006-01-02T15:04:05-0700", f[0]); err == nil {
			return t.Unix()
		}
		if len(f) >= 3 {
			if t, err := time.Parse("Jan _2 15:04:05", strings.Join(f[0:3], " ")); err == nil {
				return time.Date(now.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, t.Location()).Unix()
			}
		}
	}
	return now.Unix()
}

func readTail(path string, maxBytes int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	off := int64(0)
	if st.Size() > maxBytes {
		off = st.Size() - maxBytes
	}
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && len(buf) == 0 {
		return ""
	}
	return string(buf)
}

func collectSshAttempts() ([]SshAttempt, bool) {
	now := time.Now()
	cutoff := now.Add(-60 * time.Minute).Unix()
	var text string
	if out, ok := runCmd(8*time.Second, "journalctl", "-u", "ssh", "-u", "sshd", "--since", "60 minutes ago", "--no-pager", "--no-hostname", "-o", "short-iso", "-q"); ok && strings.TrimSpace(out) != "" {
		text = out
	} else if tail := readTail("/var/log/auth.log", 256*1024); tail != "" {
		text = tail
	} else {
		return nil, false
	}
	var out []SshAttempt
	for _, line := range strings.Split(text, "\n") {
		a, ok := parseSshLine(line, now)
		if !ok || a.Ts < cutoff {
			continue
		}
		out = append(out, a)
		if len(out) >= 100 {
			break
		}
	}
	return out, true
}

// ---------- listening ports (from /proc, no `ss` needed) ----------

func hexPort(s string) (int, bool) {
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil || v == 0 || v > 65535 {
		return 0, false
	}
	return int(v), true
}

// /proc prints IPv4 little-endian per byte ("0100007F" = 127.0.0.1),
// IPv6 as four little-endian 32-bit words.
func decodeProcIP(hex string) (string, bool) {
	if len(hex) == 8 {
		b := make([]string, 4)
		any := true
		for i := 0; i < 4; i++ {
			v, err := strconv.ParseUint(hex[2*i:2*i+2], 16, 8)
			if err != nil {
				return "", false
			}
			b[3-i] = strconv.FormatUint(v, 10)
			if v != 0 {
				any = false
			}
		}
		return strings.Join(b, "."), any
	}
	if len(hex) == 32 {
		// four little-endian 32-bit words: reverse bytes per word first,
		// then read eight 16-bit groups in order.
		var norm strings.Builder
		for w := 0; w < 4; w++ {
			word := hex[8*w : 8*w+8]
			for b := 3; b >= 0; b-- {
				norm.WriteString(word[2*b : 2*b+2])
			}
		}
		s := norm.String()
		groups := make([]string, 8)
		any := true
		for i := 0; i < 8; i++ {
			v, err := strconv.ParseUint(s[4*i:4*i+4], 16, 16)
			if err != nil {
				return "", false
			}
			if v != 0 {
				any = false
			}
			groups[i] = strconv.FormatUint(v, 16)
		}
		return compressIPv6(groups), any
	}
	return "", false
}

func compressIPv6(g []string) string {
	// longest run of "0" becomes "::"
	best, cur, bi := 0, 0, -1
	for i, x := range g {
		if x == "0" {
			cur++
			if cur > best {
				best, bi = cur, i-cur+1
			}
		} else {
			cur = 0
		}
	}
	if best < 2 {
		return strings.Join(g, ":")
	}
	var b strings.Builder
	for i := 0; i < len(g); {
		if i == bi {
			b.WriteString("::")
			i += best
			continue
		}
		if b.Len() > 0 && !strings.HasSuffix(b.String(), ":") {
			b.WriteString(":")
		}
		b.WriteString(g[i])
		i++
	}
	return b.String()
}

func parseProcNet(text, proto string) []ListenPort {
	var out []ListenPort
	seen := map[int]bool{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[0] == "sl" {
			continue
		}
		if f[3] != "0A" { // LISTEN
			continue
		}
		addr := strings.SplitN(f[1], ":", 2)
		if len(addr) != 2 {
			continue
		}
		port, ok := hexPort(addr[1])
		if !ok || seen[port] {
			continue
		}
		ip, any := decodeProcIP(addr[0])
		if ip == "" {
			continue
		}
		seen[port] = true
		out = append(out, ListenPort{Proto: proto, Port: port, Addr: ip, Exposed: any})
		if len(out) >= 64 {
			break
		}
	}
	return out
}

func collectListenPorts() []ListenPort {
	out := parseProcNet(readFile("/proc/net/tcp"), "tcp")
	out = append(out, parseProcNet(readFile("/proc/net/tcp6"), "tcp6")...)
	return out
}

// ---------- firewall / fail2ban / updates ----------

func detectFirewall() (string, string) {
	if out, ok := runCmd(5*time.Second, "ufw", "status"); ok {
		if strings.Contains(out, "Status: active") {
			return "ufw", firstLine(out)
		}
		// ufw installed but off: host INPUT may still be filtered, keep looking.
	}
	if out, ok := runCmd(5*time.Second, "nft", "list", "ruleset"); ok && restrictiveNft(out) {
		return "nft", "input policy drop/reject"
	}
	if out, ok := runCmd(5*time.Second, "iptables", "-S"); ok && restrictiveIptables(out) {
		return "iptables", "restrictive INPUT chain"
	}
	if _, err := exec.LookPath("ufw"); err != nil {
		if _, err := exec.LookPath("iptables"); err != nil {
			if _, err := exec.LookPath("nft"); err != nil {
				return "unknown", "no firewall tool found"
			}
		}
	}
	return "none", "no active firewall rules detected"
}

func firstLine(s string) string {
	if i := strings.Index(s, "\n"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// True when the ruleset actually filters inbound traffic — plain Docker
// FORWARD chains must NOT count (every docker host has those).
func restrictiveNft(out string) bool {
	lower := strings.ToLower(out)
	return strings.Contains(lower, "type filter hook input") &&
		(strings.Contains(lower, "policy drop") || strings.Contains(lower, "policy reject"))
}

func restrictiveIptables(out string) bool {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "-P INPUT DROP") || strings.HasPrefix(line, "-P INPUT REJECT") {
			return true
		}
		if strings.HasPrefix(line, "-A INPUT") && (strings.Contains(line, " -j REJECT") || strings.Contains(line, " -j DROP")) {
			// a final catch-all REJECT/DROP on INPUT, not a port-scoped rule
			if !strings.Contains(line, "--dport") && !strings.Contains(line, "--sport") {
				return true
			}
		}
	}
	return false
}

func detectFail2ban() string {
	out, ok := runCmd(5*time.Second, "fail2ban-client", "ping")
	if !ok {
		if _, err := exec.LookPath("fail2ban-client"); err != nil {
			return "missing"
		}
		return "inactive"
	}
	if strings.Contains(strings.ToLower(out), "pong") {
		return "active"
	}
	return "inactive"
}

// apt-check prints "total;security" from the cached lists — cheap, no refresh.
func countSecurityUpdates() *int {
	out, ok := runCmd(10*time.Second, "/usr/lib/update-notifier/apt-check")
	if !ok {
		return nil
	}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) == 0 {
			continue
		}
		parts := strings.Split(f[0], ";")
		if len(parts) != 2 {
			continue
		}
		if n, err := strconv.Atoi(parts[1]); err == nil {
			return &n
		}
	}
	return nil
}
