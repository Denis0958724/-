// Коди з листа, сесії, паролі, обмеження частоти.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./db');
const mail = require('./mail');

// Секрет для хешів кодів і сесій. Створюється один раз і лежить у data/secret.
const SECRET = (() => {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const f = path.join(store.DATA, 'secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
})();
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const now = () => Date.now() + (globalThis.__timeShift || 0);

const CODE_TTL = 10 * 60000, CODE_ATTEMPTS = 5, RESEND_AFTER = 60000, CODES_PER_HOUR = 5;
const SESSION_TTL = 30 * 86400000;

/* ---------- Обмеження частоти (у пам'яті) ---------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = now(), b = buckets.get(key) || [];
  const fresh = b.filter(x => t - x < windowMs);
  if (fresh.length >= max) { buckets.set(key, fresh); return true; }
  fresh.push(t); buckets.set(key, fresh); return false;
}

/* ---------- Коди ---------- */
const PURPOSE_SUBJECT = { login: 'Код для входу', signup: 'Підтвердження пошти', change_email: 'Підтвердження нової пошти', expert_email: 'Підтвердження пошти фахівця' };
async function issueCode(email, purpose, payload, ip) {
  const t = now();
  if (limited('ip:' + ip, 20, 3600000)) return { error: 'Забагато запитів. Спробуйте за годину.', status: 429 };
  const recent = store.raw.prepare('SELECT created_at, purpose FROM codes WHERE email = ? AND created_at > ? ORDER BY created_at DESC').all(email, t - 3600000);
  // Повторно той самий код не частіше разу на хвилину. Ліміт на годину спільний для всіх дій.
  const same = recent.find(r => r.purpose === purpose);
  if (same && t - same.created_at < RESEND_AFTER) {
    return { error: `Новий код можна отримати через ${Math.ceil((RESEND_AFTER - (t - same.created_at)) / 1000)} с`, status: 429, retryIn: RESEND_AFTER - (t - same.created_at) };
  }
  if (recent.length >= CODES_PER_HOUR) return { error: 'Забагато кодів за годину. Спробуйте пізніше.', status: 429 };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Старі коди цієї пошти і мети більше не діють
  store.raw.prepare('UPDATE codes SET used_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL').run(t, email, purpose);
  const id = 'c' + crypto.randomBytes(8).toString('hex');
  store.raw.prepare('INSERT INTO codes (id, email, purpose, code_hash, created_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, email, purpose, hmac(email + '|' + purpose + '|' + code), t, t + CODE_TTL, payload ? JSON.stringify(payload) : null);
  try {
    await mail.send({
      to: email, subject: `${PURPOSE_SUBJECT[purpose]}: ${code}`,
      text: `Ваш код: ${code}\n\nВін діє 10 хвилин і лише один раз. Якщо це були не ви, просто проігноруйте лист.\n\nAskly`,
      html: `<p>Ваш код:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>Він діє 10 хвилин і лише один раз. Якщо це були не ви, просто проігноруйте лист.</p><p>Askly</p>`,
    });
  } catch (e) {
    store.raw.prepare('DELETE FROM codes WHERE id = ?').run(id);
    if (e.code === 'MAIL_OFF') return { error: 'Пошту на сервері ще не налаштовано, тому код не надіслано. Див. server/README.md, розділ «Пошта».', status: 503 };
    console.error('[mail] помилка відправки:', e.code || e.name);
    return { error: 'Не вдалося відправити лист. Перевірте адресу або спробуйте пізніше.', status: 502 };
  }
  return { ok: true, resendIn: RESEND_AFTER };
}
// Перевірка коду. Прострочений, використаний або після 5 помилок код не приймається.
function checkCode(email, purpose, code) {
  const t = now();
  const row = store.raw.prepare('SELECT * FROM codes WHERE email = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(email, purpose);
  if (!row) return { error: 'Код недійсний. Отримайте новий.' };
  if (row.expires_at < t) { store.raw.prepare('UPDATE codes SET used_at = ? WHERE id = ?').run(t, row.id); return { error: 'Строк дії коду минув. Отримайте новий.' }; }
  if (row.attempts >= CODE_ATTEMPTS) return { error: 'Забагато спроб. Отримайте новий код.' };
  const ok = /^\d{6}$/.test(String(code || '')) && crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hmac(email + '|' + purpose + '|' + code)));
  if (!ok) {
    store.raw.prepare('UPDATE codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = CODE_ATTEMPTS - row.attempts - 1;
    if (left <= 0) store.raw.prepare('UPDATE codes SET used_at = ? WHERE id = ?').run(t, row.id);
    return { error: left > 0 ? `Невірний код. Залишилось спроб: ${left}` : 'Забагато спроб. Отримайте новий код.' };
  }
  store.raw.prepare('UPDATE codes SET used_at = ? WHERE id = ?').run(t, row.id);
  return { ok: true, payload: row.payload ? JSON.parse(row.payload) : null };
}

/* ---------- Підтвердження пошти фахівця до реєстрації ---------- */
function issueProof(email) {
  const token = crypto.randomBytes(24).toString('base64url');
  store.raw.prepare('INSERT INTO proofs (token_hash, email, expires_at) VALUES (?, ?, ?)').run(hmac('proof|' + token), email, now() + 2 * 3600000);
  return token;
}
function proofEmail(token) {
  if (!token) return null;
  const r = store.raw.prepare('SELECT email, expires_at FROM proofs WHERE token_hash = ?').get(hmac('proof|' + token));
  return r && r.expires_at > now() ? r.email : null;
}

/* ---------- Сесії ---------- */
function createSession(userId, expertOk = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  store.raw.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, expert_ok) VALUES (?, ?, ?, ?, ?, ?)').run(hmac('s|' + token), userId, t, t + SESSION_TTL, t, expertOk ? 1 : 0);
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const h = hmac('s|' + token);
  const r = store.raw.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
  if (!r) return null;
  if (r.expires_at < now()) { store.raw.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h); return null; }
  const u = store.get('users', r.user_id);
  if (!u) return null;
  if (now() - r.last_seen > 60000) store.raw.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), h);
  return { user: u, tokenHash: h, expertOk: !!r.expert_ok };
}
function switchSession(tokenHash, userId) { store.raw.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(userId, tokenHash); }
function endSession(token) { if (token) store.raw.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hmac('s|' + token)); }
function endAllSessions(userIds) { for (const id of userIds) store.raw.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }

/* ---------- Паролі ---------- */
function hashPassword(p) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(p, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPassword(p, stored) {
  if (!stored || !stored.startsWith('scrypt$') || typeof p !== 'string') return false;
  const [, salt, h] = stored.split('$');
  const got = crypto.scryptSync(p, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
}

module.exports = { issueCode, checkCode, issueProof, proofEmail, createSession, sessionUser, switchSession, endSession, endAllSessions, hashPassword, checkPassword, limited, now };
