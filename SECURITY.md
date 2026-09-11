# Security

PiPulse manages real servers, so: never expose it directly to the internet without a reverse proxy + TLS. Set long `AGENT_TOKEN` and `SESSION_SECRET`. Report vulnerabilities via GitHub private advisory — I'll fix auth/RCE issues first. The app never runs arbitrary shell/docker/systemctl from user input; only allowlisted start/stop/restart actions exist.
