#!/bin/bash
# Install PiPulse Agent on the Raspberry Pi host as a systemd service.
set -euo pipefail
BACKEND="${1:-http://localhost:8080}"
TOKEN="${PIPULSE_TOKEN:-}"
if [ -z "$TOKEN" ]; then echo "Set PIPULSE_TOKEN env var to your agent token."; exit 1; fi
sudo cp pipulse-agent /usr/local/bin/pipulse-agent
sudo chmod +x /usr/local/bin/pipulse-agent
sudo tee /etc/systemd/system/pipulse-agent.service > /dev/null <<EOF
[Unit]
Description=PiPulse Agent
After=network-online.target
[Service]
ExecStart=/usr/local/bin/pipulse-agent -backend $BACKEND
Environment=PIPULSE_TOKEN=$TOKEN
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now pipulse-agent
echo "PiPulse Agent installed and running."
