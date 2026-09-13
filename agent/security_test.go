package main

import (
	"testing"
	"time"
)

func TestParseSshFailed(t *testing.T) {
	now := time.Date(2026, 9, 13, 20, 5, 0, 0, time.UTC)
	line := "2026-09-13T20:01:22+0200 tompi sshd[1234]: Failed password for invalid user admin from 1.2.3.4 port 5678 ssh2"
	a, ok := parseSshLine(line, now)
	if !ok || a.Ok || a.User != "admin" || a.IP != "1.2.3.4" {
		t.Fatalf("got %+v ok=%v", a, ok)
	}
	if a.Ts != time.Date(2026, 9, 13, 18, 1, 22, 0, time.UTC).Unix() {
		t.Fatalf("ts=%d", a.Ts)
	}
}

func TestParseSshAcceptedAuthLog(t *testing.T) {
	now := time.Date(2026, 9, 13, 20, 5, 0, 0, time.UTC)
	line := "Sep 13 20:01:22 tompi sshd[1234]: Accepted publickey for tompi from 192.168.178.10 port 51234 ssh2"
	a, ok := parseSshLine(line, now)
	if !ok || !a.Ok || a.User != "tompi" || a.IP != "192.168.178.10" {
		t.Fatalf("got %+v ok=%v", a, ok)
	}
}

func TestParseSshNoiseIgnored(t *testing.T) {
	now := time.Now()
	for _, l := range []string{
		"Sep 13 20:01:22 tompi sshd[1234]: pam_unix(sshd:auth): authentication failure",
		"Sep 13 20:01:22 tompi sshd[1234]: Connection closed by 1.2.3.4",
		"",
	} {
		if _, ok := parseSshLine(l, now); ok {
			t.Fatalf("should ignore %q", l)
		}
	}
}

func TestParseProcNetTcp(t *testing.T) {
	text := "  sl  local_address rem_address   st\n" +
		"   0: 0100007F:0035 00000000:0000 0A\n" +
		"   1: 00000000:0016 00000000:0000 0A\n" +
		"   2: 0100007F:1F90 0200007F:0016 01\n"
	ports := parseProcNet(text, "tcp")
	if len(ports) != 2 {
		t.Fatalf("got %+v", ports)
	}
	if ports[0].Port != 53 || ports[0].Addr != "127.0.0.1" || ports[0].Exposed {
		t.Fatalf("localhost wrong: %+v", ports[0])
	}
	if ports[1].Port != 22 || !ports[1].Exposed {
		t.Fatalf("exposed ssh wrong: %+v", ports[1])
	}
}

func TestParseProcNetTcp6(t *testing.T) {
	text := "  sl  local_address rem_address   st\n" +
		"   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A\n" +
		"   1: 00000000000000000000000001000000:0016 00000000000000000000000000000000:0000 0A\n"
	ports := parseProcNet(text, "tcp6")
	if len(ports) != 2 {
		t.Fatalf("got %+v", ports)
	}
	if ports[0].Port != 80 || !ports[0].Exposed {
		t.Fatalf("exposed http wrong: %+v", ports[0])
	}
	if ports[1].Port != 22 || ports[1].Addr != "::1" || ports[1].Exposed {
		t.Fatalf("loopback wrong: %+v", ports[1])
	}
}

func TestRestrictiveIptables(t *testing.T) {
	dockerOnly := "-P INPUT ACCEPT\n-P FORWARD DROP\n-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n-A FORWARD -j DOCKER-USER\n"
	if restrictiveIptables(dockerOnly) {
		t.Fatal("docker chains must not count as a firewall")
	}
	ufw := "-P INPUT DROP\n-P FORWARD DROP\n-A INPUT -j ufw-before-input\n"
	if !restrictiveIptables(ufw) {
		t.Fatal("ufw-style INPUT DROP should count")
	}
}

func TestRestrictiveNft(t *testing.T) {
	open := "table inet filter {\n chain input {\n type filter hook input priority 0; policy accept;\n }\n}\n"
	if restrictiveNft(open) {
		t.Fatal("accept policy must not count")
	}
	closed := "table inet filter {\n chain input {\n type filter hook input priority 0; policy drop;\n }\n}\n"
	if !restrictiveNft(closed) {
		t.Fatal("drop policy should count")
	}
}
