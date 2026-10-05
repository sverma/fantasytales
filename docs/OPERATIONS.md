# Optional operations

## Featured profile requests

Members without a published profile see **Want to be featured?** on Discover
and Account. **Request a featured profile** opens an editable hello asking
Admin for the email address where they can send their description, photos,
and other profile details. Members must complete WhatsApp onboarding before
contacting Admin. Opening the draft does not send it.

The recipient is resolved from an active administrator account linked to a
published profile, not from a display name. Pending hellos are reused; an
accepted connection offers the same draft in the existing conversation.
An unavailable or blocked administrator is not offered as a recipient.

Admin receives the hello in Connections, accepts it, and replies with the
submission email address. This workflow sends no email and publishes no
profile automatically. The operator reviews the submitted materials and
uses the existing private profile-import and account-linking workflow.
Hidden profile owners can also request featuring; already featured owners
and administrators do not see the invitation.

## Public static asset cache

The supplied Nginx configuration caches only `/app.js`, `/styles.css`,
`/landing.js`, `/landing.css`, `/favicon.svg`, and single-file SVG/WOFF2 assets
under `/assets/`. Successful responses retain the application's one-hour
browser cache policy and can be served from Nginx without contacting Node.
The cache is bounded to 64 MB, with 2 MB of shared metadata; unused entries
expire after two hours. Cache locking coalesces simultaneous misses.

Nginx removes cookies and Authorization only on these public asset requests.
It respects upstream `no-store`, `private`, and `Set-Cookie` protections.
HTML, APIs, private media, and the separate authenticated monitoring panels
do not use this cache. Avoid a general extension rule such as `*.jpg` that
would accidentally match protected profile photos or API URLs. Access logs
still record cache hits; the Node request metrics count only requests that
actually reach the application.

CSS, JavaScript, and larger SVGs are compressed with gzip when accepted by
the browser, with `Vary: Accept-Encoding`. WOFF2 is already compressed.
Inspect two successive requests to an asset: `X-Static-Cache` should change
from `MISS` to `HIT`; `Cache-Control` should remain `public, max-age=3600`.
Missing files must stay uncached. The application shell, APIs, and profile
photos must retain `Cache-Control: no-store` and their authorization checks.

After changing code or rolling back a release, clear only this regenerable
cache as root, after the app is serving the intended release:

```sh
find /var/cache/nginx/fantasytales-static -type f -delete
```

Update changed assets' URL versions as described in [Deployment](DEPLOYMENT.md)
to invalidate browser caches. Always run `nginx -t` before `systemctl reload
nginx`. A graceful Nginx reload applies configuration without restarting the
application. See the [Nginx proxy-cache documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache).

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
