# Optional operations

## Messenger contact options

Members provide at least one WhatsApp number, Telegram username, or LINE ID to
browse profiles and photos. Onboarding asks for one messenger; Account supports
all three and permits replacing a number with a username. Empty contacts cannot
bypass the server gate. Only basic text/length formatting is checked; the app
performs no ownership, existence, OTP, or messenger API verification.

Startup adds `users.telegram`, `users.line`, and `connections.share_messengers`
without changing existing data. Admin member search includes all three contacts.
Private connection CSVs append Telegram and LINE columns after the existing
columns, and contact edits refresh existing export rows. Contact values are not
included in activity logs, public profiles, aggregate metrics, or AI assessments.

Sharing stays optional and requires an accepted introduction. New clients send
`shareMessengerContacts: true` with `shareContact: true` only after the user opts
in to sharing all provided messenger contacts. Existing WhatsApp-only permissions
retain their scope. The legacy `contact` response field remains a WhatsApp string;
`contacts` contains the authorized messenger fields or is null when not shared.

Rollbacks preserve the added columns. A release predating this feature cannot
unlock profiles for members who provided only Telegram or LINE, so prefer a
forward fix after those members start registering.

## Featured profile requests

Members without a published profile see **Want to be featured?** on Discover
and Account. **Request a featured profile** opens an editable hello asking
Admin for the email address where they can send their description, photos,
and other profile details. Members must add WhatsApp, Telegram, or LINE contact information before
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

## Optional objkt NFT profile link

Members can add, update, or clear an optional objkt URL in **Account → Your NFT
profile**. Signup and contact onboarding do not ask for it, and the link does not
replace the required WhatsApp, Telegram, or LINE detail. When an account is linked
to a published featured profile, its URL appears in that profile's details for
signed-in members. Hidden profiles and ordinary member accounts do not expose it
through Discover. Existing blocking and contact gates still apply.

Startup adds `users.objkt_url` with an empty default and preserves existing data.
`PATCH /api/me` accepts only HTTPS `objkt.com` profile URLs: short `/@name` links,
current `/users/address` links (including profile tabs), and legacy `/profile/address`
links. Clearing the field removes the displayed link. URLs are not fetched and
ownership is not verified; they are not included in AI assessments or contact CSVs.
Activity logs record only whether a link was provided, not the URL itself.

The profile link opens a new tab with `noopener noreferrer nofollow`. Changed app
assets use a new URL version. A rollback preserves the extra database column and
saved URLs, though an earlier application will not display them.

Run `node tests/objkt-browser.mjs` with `PLAYWRIGHT_MODULE` set when Playwright is
not available as a local dependency. It uses fictional local profiles and intercepts
the external navigation without making requests to objkt.

## Excluding a profile from AI ratings

The private `profiles.rating_enabled` flag defaults to `1` for existing and new
profiles. An operator can set it to `0` during a private profile import to prohibit
scoring that profile. Both scheduled and manually queued workers exclude it before
reading photos or making API requests, and check the flag again before publishing
an in-flight result. Existing scores are hidden from members, and the administrator
sees the status `disabled`. Discover cards and profile details omit the rating panel.
Editing profile text or photos does not reset the preference.

Keep this flag and the supporting worker code when deploying future releases.
Do not roll back to a worker that predates rating exclusions while an excluded
profile is published; stop the rating timer, path watcher, and worker first.

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
