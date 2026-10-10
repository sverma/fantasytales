# Changelog

## 0.2.0 — 2026-10-10

First tagged public release of Fantasy Tales, collecting the application and
updates already available on the main branch. Earlier package version values
were development metadata; this release establishes the public 0.2 version line.

### Highlights

- Private Admin Activity page with successful sign-ins, new accounts, introduction
  statuses, IST timestamps, recipient/status filters, pagination, and 30-second
  refresh. Authentication history is retained for 30 days, with an idempotent
  importer for available historical visit logs.
- Contact onboarding accepts at least one WhatsApp number, Telegram username,
  or LINE ID. Contacts remain optional to share with an accepted introduction.
- Members can request featured status by introducing themselves to Admin.
- Optional objkt NFT profile URLs can be managed in Account and displayed on
  published featured profiles.
- Configurable AI profile ratings, daily reassessment of changed profiles,
  private API-key storage, and per-profile rating exclusions.
- Six-digit PIN access, private galleries, saved profiles, mutual introductions,
  messaging, blocking, reporting, and member account management.
- Public indexable pages, self-hosting documentation, private application
  metrics, Nginx caching examples, backups, and optional operations tooling.

### Upgrade notes

Requires Node.js 24 or later. Back up the database, preserve the existing private
media/data and environment settings, and follow [Deployment](docs/DEPLOYMENT.md).
Do not seed over an existing installation. Database initialization adds missing
fields and tables without resetting accounts or profile visibility.

Operators upgrading older installations can import retained login history with
`scripts/import-login-history.mjs`; see [Admin activity](docs/OPERATIONS.md#admin-activity).
History before server-side recording may be incomplete when visit tracking was
absent. Keep rating-exclusion support when rolling back an installation with
profiles excluded from AI assessment.

The release contains application source and synthetic tests. It does not include
production profiles, photos, member data, logs, credentials, or API keys. AI scores
are subjective, and browser screenshot prevention cannot be guaranteed.
