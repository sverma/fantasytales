# Deployment

Run the application as a dedicated unprivileged service user behind an HTTPS
reverse proxy. The `deploy/` Nginx and systemd templates use the service name
`fantasytales`, code under `/opt/fantasytales/current`, private data under
`/var/lib/fantasytales`, and Node at `/usr/local/bin/node`. Adapt these paths
and the domain to your installation. Obtain a valid TLS certificate before
using the HTTPS Nginx configuration.

## Fresh installation

1. Install Node.js 24+, Nginx, and Python 3 for the supplied backup helper.
2. Create a dedicated `fantasytales` system user, a root-owned release directory
   readable by that group (0750), and a service-owned data directory (0700).
3. Copy the repository into a new release directory, excluding `.git`, tests,
   local environment files, credentials, and developer output. Do not serve
   the repository as an unrestricted static document root.
4. Configure the private data/media locations. Import profiles through the
   private manifest tool if needed, then run the account seed tool as the
   service user. Read the generated handoff file privately.
5. Point `/opt/fantasytales/current` to the release. Install the service,
   backup timer, and optional AI timer/path units from `deploy/`.
6. Adapt and install the Nginx site. For a fresh installation, create the
   included monitoring-location directory even if it is initially empty.
   Create `/var/cache/nginx/fantasytales-static` owned by the Nginx worker user
   (`www-data` on Ubuntu), mode 0700, for the bounded public-asset cache.
   Its parent `/var/cache/nginx` must be traversable (root-owned, mode 0755).
   The proxy must overwrite X-Real-IP; do not expose Node directly to the
   internet when `TRUST_PROXY=1` is enabled.
7. Validate `nginx -t` and the systemd unit files. Enable/start the app and
   desired timers, reload Nginx, and verify `/health`, public pages, sign-in,
   media authorization, and private-file denials.

Use `EnvironmentFile=-/etc/fantasytales/site.env` in a service drop-in for
operator settings and optional Google verification. Keep the file root-owned
and mode 0600. It is not part of source control.

## Existing installations

Back up SQLite with its backup API, record the existing release symlink, and
copy the current release into a new directory before overlaying updated code.
Preserve `private/media`, the data directory, and external operator settings.
Never replace a live release with a clean Git checkout that omits its galleries.
The repository starts with no profiles; existing profile/account rows remain
in SQLite and are not reseeded or removed by startup.

Run syntax/tests before switching. Switch the symlink atomically, restart the
app, and check `/health`, `/sitemap.xml`, authentication, and application metrics.
If checks fail, restore the previous code symlink and restart. Do not restore
an older database merely to roll back code: that could discard recent activity.
Keep current Nginx monitoring includes and collector services intact.

After changing public assets, update their `?v=` references (or rename the
files and update every reference), including font/artwork references in CSS.
The complete query string is part of the Nginx cache key. Existing asset URLs
are deliberately cached for only one hour, without `immutable`. Clear the
server cache after switching releases using the command in
[Operations](OPERATIONS.md#public-static-asset-cache); this does not clear a
visitor's browser cache, so changed asset URLs are still necessary for
immediate updates and rollbacks.

A full user-data restore, a credential reset, and a gallery import are separate
operator actions. They are not implicit parts of updating the application code.
