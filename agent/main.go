// PiPulse Agent — runs on the Raspberry Pi host, pushes real metrics to the backend.
// Stdlib only: no external deps, tiny binary, minimal RAM.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"
)

var version = "0.1.0"

type Push struct {
	AgentID  string   `json:"agentId"`
	Hostname string   `json:"hostname"`
	Arch     string   `json:"arch"`
	Version  string   `json:"version"`
	Metrics  Metrics  `json:"metrics"`
	Smart    []string `json:"smart,omitempty"`
}

func main() {
	backend := flag.String("backend", getenv("PIPULSE_BACKEND", "http://localhost:8080"), "backend base URL")
	token := flag.String("token", os.Getenv("PIPULSE_TOKEN"), "agent token")
	agentID := flag.String("id", getenv("PIPULSE_AGENT_ID", defaultAgentID()), "unique agent id")
	interval := flag.Duration("interval", 5*time.Second, "push interval")
	flag.Parse()

	if *token == "" {
		fmt.Fprintln(os.Stderr, "pipulse-agent: missing token (use -token or PIPULSE_TOKEN)")
		os.Exit(1)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	for {
		m := Collect()
		p := Push{AgentID: *agentID, Hostname: hostname(), Arch: arch(), Version: version, Metrics: m, Smart: CollectSmart()}
		if err := push(client, *backend, *token, p); err != nil {
			fmt.Fprintln(os.Stderr, "pipulse-agent: push failed:", err)
		}
		time.Sleep(*interval)
	}
}

func push(client *http.Client, backend, token string, p Push) error {
	body, _ := json.Marshal(p)
	req, _ := http.NewRequest("POST", backend+"/api/agent/push", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("backend returned %s", resp.Status)
	}
	return nil
}

func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
