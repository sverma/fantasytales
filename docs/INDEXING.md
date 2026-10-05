# Public search visibility

The five public paths `/`, `/about`, `/open-source`, `/privacy`, and `/guidelines`
are rendered into HTML on the server. Each has a descriptive title and meta
description, a canonical URL, social metadata, and index/follow instructions.
The public pages do not fetch member profiles or create authenticated sessions.
Their schema describes the website, not fabricated reviews or ratings.

`/robots.txt` permits the public pages and their assets, blocks private API/media
and monitoring paths, and advertises `/sitemap.xml`. The sitemap lists only
public canonical URLs. `/app` has both an HTML noindex directive and an
X-Robots-Tag header. It remains crawlable so crawlers can read that directive;
member APIs and photos are still protected by authentication. Unknown routes
return 404. HTTP and www redirect to the canonical HTTPS hostname in Nginx.

Legacy links such as `/#discover` are redirected in the browser to
`/app#discover`. Fragments are not treated as public sitemap entries.

## Google Search Console

1. Sign into the Google account that should own the site property.
2. Add the URL-prefix property `https://YOUR_DOMAIN/` (or a domain property
   verified through the active DNS provider).
3. For HTML file verification, put the exact file Google supplies under
   `DATA_DIR/site-verification/`. Only filenames matching `google[hex].html`
   are served at the root. Keep the file in private operator configuration,
   not the source repository. Alternatively set `GOOGLE_SITE_VERIFICATION`
   to the supplied meta-tag token and restart the application.
4. Complete verification in Search Console. Submit `sitemap.xml` under Sitemaps.
5. Inspect the homepage URL, test the live URL, and request indexing. The
   verification file/token must remain installed to retain ownership.

A sitemap and successful live test make pages discoverable; they do not
force Google to index or rank them. Search Console is the authoritative place
to check actual Google crawl/index status. The application does not use the
Indexing API, which is not intended for ordinary dating/homepage URLs.
