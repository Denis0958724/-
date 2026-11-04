// SQLite (вбудований у Node 22). Об'єкти зберігаються як JSON, ключові поля дублюються в колонках для пошуку і обмежень.
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'app.sqlite'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, type TEXT NOT NULL, email TEXT NOT NULL, json TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS users_type_email ON users(type, email);
CREATE TABLE IF NOT EXISTS experts (id TEXT PRIMARY KEY, status TEXT NOT NULL, cat TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, expert_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot ON bookings(expert_id, at);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (id TEXT PRIMARY KEY, email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER, payload TEXT);
CREATE INDEX IF NOT EXISTS codes_email ON codes(email, purpose);
CREATE TABLE IF NOT EXISTS proofs (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, file TEXT, delete_after INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);
// Нова колонка: чи входив фахівець у цій сесії з паролем
try { db.exec('ALTER TABLE sessions ADD COLUMN expert_ok INTEGER NOT NULL DEFAULT 0'); } catch { /* уже є */ }

const COLS = {
  users: o => ({ id: o.id, type: o.type, email: o.email.toLowerCase() }),
  experts: o => ({ id: o.id, status: o.status, cat: o.cat || null }),
  bookings: o => ({ id: o.id, client_id: o.clientId, expert_id: o.expertId, at: o.at }),
  subscriptions: o => ({ id: o.id, user_id: o.userId }),
  mail_events: o => ({ id: o.id, user_id: o.userId }),
  outbox: o => ({ id: o.id, user_id: o.userId }),
};
const parse = r => (r ? JSON.parse(r.json) : null);

function get(table, id) { return parse(db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id)); }
function all(table, where = '', ...args) { return db.prepare(`SELECT json FROM ${table} ${where ? 'WHERE ' + where : ''}`).all(...args).map(parse); }
function put(table, obj) {
  const c = COLS[table](obj);
  const keys = Object.keys(c);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}, json) VALUES (${keys.map(() => '?').join(',')}, ?)
    ON CONFLICT(id) DO UPDATE SET ${keys.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(', ')}${keys.length > 1 ? ',' : ''} json = excluded.json`)
    .run(...keys.map(k => c[k]), JSON.stringify(obj));
  return obj;
}
function del(table, id) { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); }
// Кілька змін разом: або всі, або жодної
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function meta(key, value) {
  if (value === undefined) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = { raw: db, get, all, put, del, tx, meta, DATA };
