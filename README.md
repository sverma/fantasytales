# Fantasy Tales

**Free, open-source, AI-powered dating.**

Fantasy Tales is an adults-only dating community with a dark burgundy and gold
interface, member-only profiles, mutual introductions, and optional AI profile
ratings. The public site is [fantasytales.org](https://fantasytales.org).

## Features

- Responsive public homepage, About, Open Source, Privacy, and Community Guidelines.
- Separate `/app` with six-digit PIN sign-in, account onboarding, and required
  WhatsApp contact information before profiles can be viewed.
- Private photo galleries, saved profiles, introductions, and messaging after
  acceptance. Contact sharing is optional and follows acceptance.
- Profile-owner biography editing; member blocking and reporting.
- Administrator member search, suspension/reactivation, PIN resets, audit
  history, profile publishing, AI configuration, and private CSV exports.
- Daily AI reassessment when profile text or photos change; unchanged profiles
  retain their scores. Ratings combine profile quality and a subjective visual
  impression. They do not verify identity or predict compatibility.
- SQLite persistence, scrypt credential hashes, CSRF checks, rate limits,
  private activity logs, backups, and a private application-metrics socket.
- Optional Ganglia metrics collector, Nginx log enrichment, and conservative
  Fail2ban configuration.

The repository includes the complete application source, schema, worker,
frontend, administration, operational examples, and synthetic tests. **It does
not include member photos, profiles, accounts, phone numbers, conversations,
production databases, logs, CSV exports, credentials, or API keys.** New
installations begin with no member profiles.

## Quick start

Requires **Node.js 24+**. The application uses built-in Node modules and SQLite;
there are no runtime npm dependencies.

```sh
git clone https://github.com/sverma/fantasytales.git
cd fantasytales
cp .env.example .env
node --env-file=.env scripts/accounts.mjs seed
node --env-file=.env server.mjs
```

Open `http://localhost:3000/` for the public site or `/app` for sign-in. The seed
command creates an administrator with a random PIN and saves the handoff in
`data/initial-credentials.txt` (mode 0600). Read it locally and change the PIN.
Never commit or distribute that file publicly. Existing users are not reset.

The operator can import profiles of consenting adults from a private manifest:

```sh
node --env-file=.env scripts/import-photos.mjs /private/path/profiles.json
CREDENTIALS_FILE=/private/path/new-account-handoff.txt node --env-file=.env scripts/accounts.mjs seed
```

Use [`examples/profiles.example.json`](examples/profiles.example.json) as a
schema. Supply your own consented photos and details. `adultConsent` must be
explicitly true. Source folders are resolved relative to the manifest.
Existing galleries are retained privately with a `.previous` suffix on import;
review those backups before another import. Photo content is not open-source
code and must not be added to this repository.

## AI ratings

An administrator can enable AI ratings and save an OpenAI API key in the Admin
panel after confirming their own PIN and authorization to send profile text
and photos for assessment. Optional API usage is billed to the operator. The
code and community membership do not require a paid software license.

Run `npm run rate-profiles` to process changes, or install the included systemd
timer and queue watcher. The key is stored in the private data directory,
never returned by the settings API, and excluded from logs and Git. AI requests
exclude account contact numbers, credentials, conversations, and visit logs.

## Configuration and deployment

See [deployment](docs/DEPLOYMENT.md), [indexing](docs/INDEXING.md), and
[operations](docs/OPERATIONS.md). `.env.example` lists the main settings. Node
does not automatically load `.env`; use `--env-file=.env` or an environment
manager. `TRUST_PROXY=1` is appropriate only behind a trusted proxy that replaces
forwarded client IP headers.

The provided Nginx/systemd files are examples for Ubuntu and this application’s
standard service paths. Set your own domain, certificates, private directories,
and Node executable path before using them on another host.

The separate monitoring interface is maintained in
[sverma/ganglia-simple-web](https://github.com/sverma/ganglia-simple-web). Its
PHP UI and the classic Ganglia frontend are separate projects; this repository
contains the application instrumentation and collector integration.

## Tests

```sh
npm run check
npm test
python3 tests/app-metrics-collector.py
python3 tests/logwatch.py
```

Tests use temporary databases, fictional profiles, synthetic media, and mocked
AI responses. They do not call the paid AI API or use production accounts.
Browser tests require Playwright:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

CI runs the application tests and browser checks on Node.js 24. Test outputs,
local environment files, private data, and supplied photos are gitignored.

## Privacy and limitations

Profiles and media require authentication and contact onboarding. Browser
restrictions can discourage copying but cannot prevent screenshots or
photographs of a screen. WhatsApp numbers are required but not verified.
AI ratings are subjective. Administrator exports are sensitive and should
remain private. A six-digit PIN needs the included online attempt limits;
operators may require stronger authentication for their deployment.

Application source is available under the [MIT license](LICENSE). Bundled
Cormorant and Manrope fonts retain their SIL Open Font License notices in
`public/assets/`. Private profile content is excluded from this license and
repository. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
