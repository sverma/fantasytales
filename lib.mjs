import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { initRatings } from './ratings.mjs';

export const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
export const db = new DatabaseSync(join(dataDir, 'fantasytales.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '', whatsapp TEXT NOT NULL DEFAULT '', contact_done INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','owner','admin')),
    profile_id TEXT UNIQUE, created_at TEXT NOT NULL, consent_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, bio TEXT NOT NULL,
    prompt TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY, file TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT REFERENCES profiles(id), PRIMARY KEY (user_id,profile_id)
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES profiles(id), message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','withdrawn')),
    share_contact INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_connection ON connections(user_id,profile_id)
    WHERE status IN ('pending','accepted');
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(blocker_id,blocked_id)
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    profile_id TEXT REFERENCES profiles(id), reason TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL
  );
`);
// Existing hashes remain usable only for the one-time migration to a PIN.
if (!db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='auth_kind')) {
  db.exec("ALTER TABLE users ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password' CHECK(auth_kind IN ('password','pin'))");
}
for (const [name,definition] of [
  ['suspended',"INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1))"],
  ['suspension_reason',"TEXT NOT NULL DEFAULT ''"],
  ['suspended_at','TEXT']
]) if (!db.prepare('PRAGMA table_info(users)').all().some(column=>column.name===name)) {
  db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT NOT NULL, target_username TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
)`);
// Additive migrations preserve existing accounts and optional profile details.
for (const name of ['telegram','line','objkt_url']) {
  if (!db.prepare('PRAGMA table_info(users)').all().some(column=>column.name===name))
    db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
}
if (!db.prepare('PRAGMA table_info(connections)').all().some(column=>column.name==='share_messengers'))
  db.exec('ALTER TABLE connections ADD COLUMN share_messengers INTEGER NOT NULL DEFAULT 0 CHECK(share_messengers IN (0,1))');
chmodSync(join(dataDir, 'fantasytales.sqlite'), 0o600);
initRatings(db);

const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString('base64url');
export const hashToken = value => createHash('sha256').update(value).digest('hex');
export const validWhatsApp = value => typeof value==='string' && /^\+[1-9]\d{6,14}$/.test(value);
export const validMessenger = value => typeof value==='string' && value.length<=100 && /^[^\s\u0000-\u001F\u007F]+$/u.test(value) && value!=='@';
export function normalizeObjktUrl(value) {
  if(typeof value!=='string')return null;
  const input=value.trim();
  if(!input)return '';
  if(input.length>500 || /[\s\u0000-\u001f\u007f\\]/u.test(input))return null;
  try {
    const url=new URL(input);
    if(url.protocol!=='https:' || url.hostname!=='objkt.com' || url.username || url.password || url.port)return null;
    if(/%(?:2f|5c)/i.test(url.pathname))return null;
    const path=decodeURIComponent(url.pathname);
    if(/[\u0000-\u001f\u007f]/u.test(path))return null;
    if(!/^\/(?:@[^/\s<>"'?#\\]+|(?:users|profile)\/[^/\s<>"'?#\\]+)(?:\/[a-zA-Z0-9_-]+)*\/?$/u.test(path))return null;
    return url.href.length<=500?url.href:null;
  } catch {return null;}
}
export const hasContact = user => validWhatsApp(user.whatsapp) || validMessenger(user.telegram) || validMessenger(user.line);
export const validPIN = value => typeof value==='string' && /^[0-9]{6}$/.test(value);
export const generatePIN = () => String(randomInt(0,1000000)).padStart(6,'0');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password, stored) {
  const [,salt,hash] = stored.split(':');
  const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
export function exportCSV() {
  const rows = db.prepare(`SELECT u.name, u.username, u.whatsapp, u.telegram, u.line, p.name AS profile, c.created_at, c.status, c.id
    FROM connections c JOIN users u ON u.id=c.user_id JOIN profiles p ON p.id=c.profile_id ORDER BY c.created_at,c.id`).all();
  const lines = [['User','Username','WhatsApp','Profile','Date (UTC)','Time (UTC)','Status','Connection ID','Telegram','LINE'].map(csvCell).join(',')];
  for (const r of rows) lines.push([r.name,r.username,r.whatsapp,r.profile,r.created_at.slice(0,10),r.created_at.slice(11,19),r.status,r.id,r.telegram,r.line].map(csvCell).join(','));
  const tmp = join(dataDir, 'connections.csv.tmp');
  writeFileSync(tmp, '\uFEFF' + lines.join('\r\n') + '\r\n', { mode: 0o600 });
  renameSync(tmp, join(dataDir, 'connections.csv'));
}
