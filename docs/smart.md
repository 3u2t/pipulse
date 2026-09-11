# SMART drive monitoring

PiPulse reads drive health with `smartctl` from
[smartmontools](https://www.smartmontools.org/). This is strictly read-only:
it never runs self-tests, never writes to the drive.

## What you need on the Raspberry Pi host

```bash
sudo apt install smartmontools
```

No SMART daemon config needed. Verify manually first:

```bash
sudo smartctl -H -A -i /dev/sda
```

Replace `/dev/sda` with your USB HDD (check `lsblk`).

## Two collection paths (in order)

1. **PiPulse Agent (recommended).** The agent runs on the host as root via
   systemd, so it can read `/dev/sd*` directly. It shells out to `smartctl`,
   retries USB drives with `-d sat`, and pushes raw JSON to the backend.
   Nothing extra to configure — if `smartmontools` is installed, it works.
2. **Inside the PiPulse container.** Used only for drives the agent didn't
   report. Requires the device node mapped into the container (see below).

## Container permissions — safest approach

Do NOT run the container `--privileged`. Map only the drives you want:

```yaml
services:
  pipulse:
    devices:
      - "/dev/sda:/dev/sda"   # your USB HDD; add more lines for more drives
```

The device node needs read access. On Raspberry Pi OS the node is usually
`root:disk` `brw-rw----`, so either:

- run the agent path (recommended, no container device access at all), or
- add a udev rule giving the container's group read access, e.g.
  `KERNEL=="sd[a-z]", GROUP="disk", MODE="0660"` and run the container with
  `group_add: ["disk"]` — least privilege, no root, no `--privileged`.

If the collector gets "Permission denied", the dashboard says so explicitly —
it never reports that as a disk failure.

## USB bridges

PiPulse tries normal detection first, then `-d sat` (covers common
JMicron/ASMedia USB/SATA bridges). Some cheap enclosures block SMART
entirely; then the drive shows:

> SMART unavailable through this USB connection

That means "can't see inside", not "drive is failing". "SMART unavailable"
and "SMART reports a problem" are different states everywhere in the UI.

Honesty note: the parser and alert rules are covered by tests with realistic
`smartctl` JSON, but I haven't run this against a real USB HDD yet — if your
enclosure needs a different `-d` type, please open an issue with the
`smartctl --scan-open` output.

## How health is judged

A drive is Healthy only if: overall-health self-assessment passes AND
reallocated, pending, offline-uncorrectable and reported-uncorrectable counts
are all zero AND temperature is under the warning threshold (default 50°C,
critical 60°C — changeable in Settings). Any pending sector is a warning;
10+ reallocated sectors is critical. Every alert names the attribute and the
count, e.g. "SMART critical: 12 reallocated sectors".

## NVMe drives

NVMe drives don't have ATA attributes — they report a health log instead, so
PiPulse keeps it separate rather than squeezing it into sector counters:

- **Percentage used** — share of rated endurance consumed. Warns at 90%.
- **Available spare** vs threshold — critical when spare hits the threshold
  (also covered by the critical warning bit below).
- **Media errors** — failed flash reads. Any count warns; 100+ is critical.
  These used to land in the ATA "error log" counter, which was misleading.
- **Data read/written** — lifetime totals, shown in the drive details.
- **Unsafe shutdowns** — shown, never alerted. Common on Pis without a UPS;
  alerting on it would just be noise.
- **Critical warning bitmask** — decoded to words ("available spare below
  threshold", "temperature above threshold", …). Any set bit is critical.

No smartmontools config needed; `smartctl -j` on `/dev/nvme0n1` works out of
the box on Raspberry Pi OS, through the agent like everything else.

## Privacy

Drive serial numbers are masked in the UI (`••••••1234`) unless you click
Reveal on that drive. Full serials never leave your server.
