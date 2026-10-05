# Optional operations

## Backups

`deploy/backup.py` uses SQLite's online backup API and retains seven days of
private snapshots. The service/timer templates run it daily. Back up gallery
files separately. Never put snapshots or CSV exports in the source repository.

## Application metrics and Ganglia

`metrics.mjs` provides 66 aggregate metrics through a mode-0600 Unix socket when
`METRICS_SOCKET` is set. Its parent must exist and be private. There is no public
HTTP metrics endpoint. The allowlisted catalog is `metrics-catalog.json`.

`deploy/app-metrics/collector.py` reads that socket and local application
health every 15 seconds, then publishes to local gmond using shell-free gmetric
arguments. The supplied service is isolated and uses localhost only. Install
its catalog alongside it, its gmetric config under `/etc/fantasytales/`, and
adapt paths in the unit. Existing Ganglia collectors/frontends are separate
installations. The application dashboard is supported by the separate
`ganglia-simple-web` project.

Request counts, latency means, and histogram p95 use rolling 60-second windows.
Historical RRD consolidation averages already-computed window percentiles,
not raw request samples. Unexpired sessions are not online users. Page events
are not unique people. HTTP metrics exclude Nginx-blocked requests and PHP
monitoring requests. Data starts when collection is enabled. No names, contact
numbers, credentials, message text, or raw URLs are exported as metrics.

## Log enrichment

The optional scripts under `deploy/logwatch` enrich Nginx access lines with
visit date/day/time in Asia/Kolkata, country, outcome, device, and IP address.
The installation script installs its own services and country database updater;
review paths and data-provider downloads before running it. The output is
sensitive operational data, not an open-source artifact. Retain it privately.

## Fail2ban

`deploy/fail2ban` contains a conservative application-probe filter and jail
configuration template. Adapt log paths, local management allowlists, and
thresholds. Review matches before enabling a jail. Do not classify ordinary
successful traffic, all 404s, or every authentication failure as an attack.
Fail2ban is not a substitute for upstream DDoS protection.
