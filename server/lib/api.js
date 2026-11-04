// API «Мікро-консультацій». Кожна дія перевіряє сесію і право на запис. Браузер бачить лише свої дані.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const R = require('./rules');
const demo = require('./demo');
const docs = require('./docs');
const notify = require('./notify');
const search = require('../ai/search');

const COOKIE = 'mc_session';
const UPLOADS = path.join(store.DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const QUAL_KEEP = 30 * 86400000;      // кваліфікаційні документи чекають модератора 30 днів
const DRAFT_KEEP = 24 * 3600000;      // файли незавершеної реєстрації видаляються через добу

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };

/* ---------- Що бачить користувач ---------- */
const BOOKABLE = ['approved', 'auto_approved'];
const cleanUser = u => u && ({ id: u.id, type: u.type, name: u.name, email: u.email, about: u.about || '', emailVerified: !!u.emailVerified,
  emailConfirmed: !!u.emailVerified, clientId: u.clientId || null, expertId: u.expertId || null, createdAt: u.createdAt, pendingEmail: u.pendingEmail || null });
// Публічна анкета: без пошти, телефону, пароля і документів
const publicExpert = e => ({ id: e.id, name: e.name, cat: e.cat, secondary: e.secondary || null, tags: e.tags || [], about: e.about, position: e.position,
  years: e.years, level: e.level, price: e.price, days: e.days, from: e.from, to: e.to, tz: e.tz, status: e.status, submittedAt: e.submittedAt,
  docsChecked: !!(e.docs && e.docs.allOk), rating: e.rating || null, reviews: e.reviews || 0, test: !!e.test });
const ownExpert = e => ({ ...publicExpert(e), email: e.email, phone: e.phone, education: e.education, link: e.link,
  docs: (e.docs && e.docs.list || []).map(d => ({ kind: d.kind, name: d.name, ok: d.ok })) });

function linkedOf(u) {
  if (!u) return null;
  const id = u.type === 'expert' ? u.clientId : u.expertId;
  return id ? store.get('users', id) : null;
}
function stateFor(sess) {
  const u = sess && sess.user;
  const linked = linkedOf(u);
  const ids = [u && u.id, linked && linked.id].filter(Boolean);
  const expertId = u && (u.type === 'expert' ? u.id : u.expertId);
  const clientId = u && (u.type === 'client' ? u.id : u.clientId);
  const experts = store.all('experts', "status IN ('approved','auto_approved')").map(publicExpert);
  const mine = expertId && store.get('experts', expertId);
  if (mine) { const i = experts.findIndex(e => e.id === mine.id); const own = ownExpert(mine); if (i >= 0) experts[i] = own; else experts.push(own); }
  const bookings = u ? store.all('bookings', 'client_id = ? OR expert_id = ?', clientId || '-', expertId || '-') : [];
  const busy = store.raw.prepare("SELECT expert_id AS expertId, at FROM bookings WHERE at > ?").all(auth.now() - 3600000);
  const email = u && u.email;
  return {
    currentUserId: u ? u.id : null,
    expertSession: u && u.type === 'expert' ? u.id : null,
    users: [u, linked].filter(Boolean).map(cleanUser),
    experts, demoExperts: demo.list(), busy, bookings,
    subscriptions: u ? store.all('subscriptions').filter(s => ids.includes(s.userId)) : [],
    outbox: email ? store.all('outbox').filter(m => m.email === email) : [],
    mailEvents: u ? store.all('mail_events').filter(e => ids.includes(e.userId)) : [],
    server: { mail: mail.MODE, demo: demo.ON, model: search.info, now: auth.now(), test: process.env.TEST_MODE === '1' },
  };
}

/* ---------- Допоміжне ---------- */
function cookies(req) {
  const out = {};
  for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function setSession(res, token) {
  const secure = String(process.env.BASE_URL || '').startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', token
    ? `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`
    : `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) fail(413, 'Запит завеликий'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function json(req) {
  const b = await readBody(req, 64 * 1024);
  if (!b.length) return {};
  try { const o = JSON.parse(b.toString('utf8')); return o && typeof o === 'object' ? o : {}; } catch { fail(400, 'Неправильний формат запиту'); }
}
const ipOf = req => (req.socket && req.socket.remoteAddress) || 'ip';
function need(sess, type) {
  if (!sess) fail(401, 'Увійдіть, щоб продовжити');
  if (type && sess.user.type !== type) fail(403, type === 'client' ? 'Ця дія доступна в режимі клієнта' : 'Ця дія доступна фахівцю');
  return sess.user;
}
const findExpertAny = id => demo.find(id) || store.get('experts', id);

// Фахівець отримує пов'язану анкету клієнта на ту саму пошту (помилка 4)
function linkClient(ex) {
  let c = ex.clientId && store.get('users', ex.clientId);
  if (!c) c = store.all('users', 'type = ? AND email = ?', 'client', ex.email).find(x => !x.expertId) || null;
  if (!c) { c = { id: R.uid('u'), type: 'client', name: ex.name, email: ex.email, emailVerified: true, about: '', createdAt: auth.now() }; }
  c.expertId = ex.id; c.emailVerified = true; ex.clientId = c.id;
  store.put('users', c); store.put('users', ex);
}

/* ---------- Маршрути ---------- */
const routes = {};
const on = (method, pattern, fn) => { routes[method + ' ' + pattern] = fn; };

on('GET', '/api/state', async ({ sess }) => stateFor(sess));

// Вхід і реєстрація клієнта, підтвердження пошти фахівця, зміна пошти: спершу код на пошту
on('POST', '/api/auth/start', async ({ req, sess }) => {
  const b = await json(req);
  const mode = String(b.mode || '');
  const email = R.normEmail(b.email);
  const bad = R.emailProblem(email); if (bad) fail(400, bad, { field: 'email' });
  let payload = null;
  if (mode === 'login') {
    if (!store.all('users', 'type = ? AND email = ?', 'client', email).length) {
      const isExpert = store.all('users', 'type = ? AND email = ?', 'expert', email).length;
      fail(404, isExpert ? 'Для цієї пошти є акаунт фахівця. Оберіть «Фахівець» і введіть пароль.' : 'Акаунт з такою поштою не знайдено', { field: 'email' });
    }
  } else if (mode === 'signup') {
    const name = R.clip(b.name, 80), about = R.clip(b.about, 300);
    if (!name) fail(400, 'Вкажіть, як до вас звертатися', { field: 'name' });
    if (store.all('users', 'type = ? AND email = ?', 'client', email).length) fail(409, 'Профіль з такою поштою вже є. Увійдіть за посиланням нижче.', { field: 'email' });
    payload = { name, about };
  } else if (mode === 'expert_email') {
    if (store.all('users', 'type = ? AND email = ?', 'expert', email).length) fail(409, 'Фахівець з такою поштою вже зареєстрований', { field: 'email' });
  } else if (mode === 'change_email') {
    const u = need(sess);
    const mineIds = [u.id, u.clientId, u.expertId].filter(Boolean);
    if (email === u.email) fail(400, 'Це ваша поточна пошта', { field: 'email' });
    if (store.all('users', 'email = ?', email).some(x => !mineIds.includes(x.id))) fail(409, 'Ця пошта вже зайнята іншим акаунтом', { field: 'email' });
    payload = { userId: u.id };
  } else fail(400, 'Невідома дія');
  const r = await auth.issueCode(email, mode, payload, ipOf(req));
  if (r.error) fail(r.status, r.error, { retryIn: r.retryIn });
  return { ok: true, sentTo: email, resendIn: r.resendIn, mail: mail.MODE };
});

on('POST', '/api/auth/verify', async ({ req, res, sess }) => {
  const b = await json(req);
  const email = R.normEmail(b.email), purpose = String(b.mode || '');
  if (!['login', 'signup', 'expert_email', 'change_email'].includes(purpose)) fail(400, 'Невідома дія');
  if (auth.limited('verify:' + ipOf(req), 30, 600000)) fail(429, 'Забагато спроб. Зачекайте 10 хвилин.');
  const r = auth.checkCode(email, purpose, String(b.code || '').trim());
  if (r.error) fail(400, r.error, { field: 'code' });
  if (purpose === 'expert_email') return { ok: true, proof: auth.issueProof(email), email };
  let user;
  if (purpose === 'login') {
    user = store.all('users', 'type = ? AND email = ?', 'client', email)[0];
    if (!user) fail(404, 'Акаунт з такою поштою не знайдено');
    if (!user.emailVerified) { user.emailVerified = true; store.put('users', user); }
  } else if (purpose === 'signup') {
    if (store.all('users', 'type = ? AND email = ?', 'client', email).length) fail(409, 'Профіль з такою поштою вже є. Увійдіть.');
    user = store.put('users', { id: R.uid('u'), type: 'client', name: r.payload.name, about: r.payload.about, email, emailVerified: true, createdAt: auth.now() });
  } else {
    const u = need(sess);
    if (!r.payload || r.payload.userId !== u.id) fail(403, 'Код виданий для іншого акаунта');
    // Нова пошта підтверджена: міняємо її в акаунті, пов'язаному акаунті і анкеті фахівця
    store.tx(() => {
      for (const x of [u, linkedOf(u)].filter(Boolean)) { x.email = email; x.emailVerified = true; delete x.pendingEmail; store.put('users', x); }
      const exId = u.type === 'expert' ? u.id : u.expertId; const rec = exId && store.get('experts', exId);
      if (rec) { rec.email = email; store.put('experts', rec); }
    });
    return stateFor(auth.sessionUser(cookies(req)[COOKIE]));
  }
  const token = auth.createSession(user.id);
  setSession(res, token);
  return stateFor({ user });
});

on('POST', '/api/auth/expert-login', async ({ req, res }) => {
  const b = await json(req);
  const email = R.normEmail(b.email);
  if (auth.limited('xlogin:' + email, 5, 15 * 60000) || auth.limited('xlogin-ip:' + ipOf(req), 20, 15 * 60000)) fail(429, 'Забагато спроб входу. Зачекайте 15 хвилин.');
  const user = store.all('users', 'type = ? AND email = ?', 'expert', email)[0];
  if (!user) fail(404, store.all('users', 'type = ? AND email = ?', 'client', email).length ? 'Для цієї пошти немає акаунта фахівця. Якщо ви клієнт, оберіть «Клієнт».' : 'Акаунт з такою поштою не знайдено', { field: 'email' });
  if (!b.pass) fail(400, 'Введіть пароль фахівця', { field: 'pass' });
  if (!auth.checkPassword(String(b.pass), user.passHash)) fail(401, 'Невірний пароль', { field: 'pass' });
  const token = auth.createSession(user.id, true);
  setSession(res, token);
  return stateFor({ user });
});

on('POST', '/api/auth/logout', async ({ req, res }) => {
  auth.endSession(cookies(req)[COOKIE]);
  setSession(res, null);
  return stateFor(null);
});

// Перемикач «Фахівець / Клієнт»: лише між власними пов'язаними акаунтами
on('POST', '/api/auth/switch', async ({ req, sess }) => {
  const u = need(sess);
  const b = await json(req);
  const other = linkedOf(u);
  if (!other || other.type !== b.to) fail(403, 'Немає такого режиму для вашого акаунта');
  // У режим фахівця без пароля пускаємо, лише якщо в цій сесії фахівець уже входив з паролем
  if (other.type === 'expert' && !sess.expertOk) fail(403, 'Увійдіть як фахівець з паролем', { code: 'need_password' });
  auth.switchSession(sess.tokenHash, other.id);
  return stateFor({ user: other, tokenHash: sess.tokenHash, expertOk: sess.expertOk });
});

on('POST', '/api/profile', async ({ req, sess }) => {
  const u = need(sess);
  const b = await json(req);
  const name = R.clip(b.name, 80), about = R.clip(b.about, 300);
  if (!name) fail(400, 'Вкажіть, як до вас звертатися', { field: 'name' });
  store.tx(() => {
    u.name = name; u.about = about; store.put('users', u);
    const exId = u.type === 'expert' ? u.id : u.expertId; const rec = exId && store.get('experts', exId);
    if (rec) { rec.name = name; store.put('experts', rec); const xu = store.get('users', exId); if (xu && xu.id !== u.id) { xu.name = name; store.put('users', xu); } }
  });
  return stateFor({ user: store.get('users', u.id) });
});

// AI-аналіз запиту і ранжування фахівців власною моделлю
on('POST', '/api/analyze', async ({ req, sess }) => {
  const who = sess ? sess.user.id : auth.proofEmail(req.headers['x-proof']);
  if (!who) fail(401, 'Увійдіть, щоб продовжити');
  if (auth.limited('analyze:' + who, 60, 600000)) fail(429, 'Забагато запитів. Зачекайте кілька хвилин.');
  const b = await json(req);
  const text = R.clip(b.text, 4000);
  if (R.noEmoji(text).length < 10) fail(400, 'Опис закороткий');
  const excluded = Array.isArray(b.excluded) ? b.excluded.filter(x => typeof x === 'string').slice(0, 8) : [];
  const pool = [...demo.list(), ...store.all('experts', "status IN ('approved','auto_approved')").map(e => ({ ...publicExpert(e), bio: e.about, focus: (e.tags || []).map(t => [t, t]) }))];
  const a = search.analyze(text, pool, excluded);
  a.ranking = search.rank(text, pool);
  return a;
});

// Фахівці для головної. Є профіль чи історія: найближчі за змістом (власна модель). Немає: найкращі за рейтингом.
on('GET', '/api/recommendations', async ({ sess }) => {
  const u = sess && sess.user;
  const clientId = u && (u.type === 'client' ? u.id : u.clientId);
  const ownExpertId = u && (u.type === 'expert' ? u.id : u.expertId);
  const pool = [...demo.list(), ...store.all('experts', "status IN ('approved','auto_approved')").map(e => ({ ...publicExpert(e), bio: e.about, focus: (e.tags || []).map(t => [t, t]) }))]
    .filter(e => e.id !== ownExpertId);
  // Рейтинг з поправкою на кількість відгуків: 5.0 з одного відгуку не обганяє 4.8 з п'ятдесяти
  const stars = e => ((e.rating || 0) * (e.reviews || 0) + 4.3 * 5) / ((e.reviews || 0) + 5);
  const past = clientId ? store.all('bookings', 'client_id = ?', clientId).sort((a, b) => b.at - a.at) : [];
  const subs = u ? store.all('subscriptions').filter(s => s.userId === clientId) : [];
  const parts = [];
  if (u && u.about) parts.push(u.about);
  for (const b of past.slice(0, 5)) parts.push(b.request.text, b.summaryText || '');
  for (const s of subs.slice(0, 3)) parts.push(s.text);
  const text = parts.filter(Boolean).join('. ');
  const seen = new Set(past.map(b => b.expertId));
  let items, mode = 'best';
  if (R.realWords(text).length >= 3) {
    mode = past.length || subs.length ? 'history' : 'profile';
    const rk = new Map(search.rank(text, pool).map(r => [r.id, r]));
    // Лише фахівці з тем, які справді близькі до запитів людини
    items = pool.map(e => {
      const r = rk.get(e.id);
      return { e, r, score: r.score * 0.8 + (stars(e) - 4) * 20 };
    }).filter(x => x.r.topicP >= 15).sort((a, b) => b.score - a.score).slice(0, 4).map(({ e }) => ({
      id: e.id,
      reason: `${mode === 'history' ? 'Схоже на ваші минулі питання' : 'Підходить до вашого профілю'}: ${search.CAT_NAMES[e.cat].toLowerCase()}`,
      before: seen.has(e.id),
    }));
    if (!items.length) mode = 'best';
  }
  if (mode === 'best') {
    const perCat = {};
    items = pool.sort((a, b) => stars(b) - stars(a))
      .filter(e => (perCat[e.cat] = (perCat[e.cat] || 0) + 1) <= 1)
      .slice(0, 4).map(e => ({ id: e.id, reason: `Найвищий рейтинг у темі «${search.CAT_NAMES[e.cat]}»`, before: seen.has(e.id) }));
  }
  return { mode, items };
});

on('POST', '/api/subscriptions', async ({ req, sess }) => {
  const u = need(sess, 'client');
  const b = await json(req);
  if (!search.CAT_NAMES[b.cat]) fail(400, 'Невідома тема');
  const existing = store.all('subscriptions').find(s => s.userId === u.id && s.cat === b.cat);
  if (!existing) {
    const budget = Number.isInteger(b.budget) && b.budget >= 50 && b.budget <= 100000 ? b.budget : null;
    store.put('subscriptions', { id: R.uid('s'), userId: u.id, cat: b.cat, budget, text: R.clip(b.text, 4000), createdAt: auth.now(), notifiedExpertIds: [] });
  }
  return stateFor(sess);
});

// Бронювання: лише клієнт з підтвердженою поштою, лише вільний слот з графіка фахівця
on('POST', '/api/bookings', async ({ req, sess }) => {
  const u = need(sess, 'client');
  if (!u.emailVerified) fail(403, 'Підтвердіть пошту, щоб бронювати консультації');
  if (auth.limited('book:' + u.id, 10, 3600000)) fail(429, 'Забагато бронювань за годину');
  const b = await json(req);
  if (b.agree !== true) fail(400, 'Позначте згоду з умовами, щоб продовжити', { field: 'agree' });
  const ex = findExpertAny(String(b.expertId || ''));
  if (!ex || (!ex.demo && !BOOKABLE.includes(ex.status))) fail(404, 'Фахівця не знайдено');
  if (ex.id === u.expertId) fail(400, 'Не можна бронювати консультацію в самого себе');
  const at = Number(b.at);
  if (!Number.isInteger(at) || !R.slotMoments(ex, auth.now()).includes(at)) fail(409, 'Цей час недоступний. Оберіть інший.', { code: 'slot' });
  const text = R.clip(b.text, 4000);
  if (R.realWords(text).length < 4) fail(400, 'Опишіть питання словами');
  const a = search.analyze(text, demo.list());
  const booking = {
    id: R.uid('b'), clientId: u.id, clientName: u.name, expertId: ex.id, expertName: ex.name, expertMock: !!ex.demo,
    price: ex.price, at, status: 'booked', createdAt: auth.now(),
    request: { text, question: a.question, cat: search.CAT_NAMES[b.cat] ? b.cat : (a.primary || ex.cat) },
  };
  try { store.put('bookings', booking); }
  catch (e) { if (String(e.message).includes('UNIQUE')) fail(409, 'Цей час щойно зайняли. Оберіть, будь ласка, інший.', { code: 'slot' }); throw e; }
  return { booking, state: stateFor(sess) };
});

function myBooking(sess, id) {
  const u = need(sess);
  const b = store.get('bookings', id);
  const clientId = u.type === 'client' ? u.id : u.clientId, expertId = u.type === 'expert' ? u.id : u.expertId;
  // Чужий id поводиться так само, як неіснуючий: нічого не розкриваємо
  if (!b || (b.clientId !== clientId && b.expertId !== expertId)) fail(404, 'Консультацію не знайдено');
  return { b, u, asClient: b.clientId === clientId, asExpert: b.expertId === expertId };
}
on('POST', '/api/bookings/:id/end', async ({ sess, params }) => {
  const { b } = myBooking(sess, params.id);
  if (b.status !== 'done') {
    b.status = 'done'; b.endedAt = auth.now();
    if (b.expertMock && !b.summaryText) b.summaryText = (demo.SUMMARY_POINTS[b.request.cat] || ['Розібрали ситуацію.', 'Визначили наступні кроки.']).join('\n');
    store.put('bookings', b);
  }
  return stateFor(sess);
});
on('POST', '/api/bookings/:id/review', async ({ req, sess, params }) => {
  const { b, asClient } = myBooking(sess, params.id);
  if (!asClient || sess.user.type !== 'client') fail(403, 'Відгук залишає клієнт');
  if (b.status !== 'done') fail(400, 'Консультація ще не завершена');
  if (b.review) fail(409, 'Відгук уже залишено');
  const r = await json(req);
  const rating = Number(r.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Поставте оцінку', { field: 'rating' });
  if (!['yes', 'partly', 'no'].includes(r.resolved)) fail(400, 'Оберіть варіант', { field: 'resolved' });
  b.review = { rating, resolved: r.resolved, comment: R.clip(r.comment, 500) };
  store.put('bookings', b);
  return stateFor(sess);
});
on('POST', '/api/bookings/:id/summary', async ({ req, sess, params }) => {
  const { b, asExpert } = myBooking(sess, params.id);
  if (!asExpert || sess.user.type !== 'expert') fail(403, 'Підсумок пише фахівець');
  if (b.status !== 'done') fail(400, 'Консультація ще не завершена');
  if (b.summaryText) fail(409, 'Підсумок уже надіслано');
  const text = R.clip((await json(req)).text, 4000);
  if (text.length < 20) fail(400, 'Напишіть хоча б кілька речень', { field: 'summary' });
  b.summaryText = text; b.summaryAt = auth.now();
  store.put('bookings', b);
  return stateFor(sess);
});

// Документи фахівця: файл приходить тілом запиту. Перевірка на сервері, текст документа назовні не віддаємо.
on('POST', '/api/documents', async ({ req, sess, query }) => {
  const kind = query.get('kind');
  if (!['qual', 'id'].includes(kind)) fail(400, 'Невідомий тип документа');
  const proofEmail = auth.proofEmail(req.headers['x-proof']);
  const owner = proofEmail || (sess && sess.user.type === 'expert' && sess.user.email);
  if (!owner) fail(401, 'Спершу підтвердіть пошту на кроці 1');
  if (auth.limited('docs:' + owner, 30, 3600000)) fail(429, 'Забагато файлів за годину');
  const name = R.clip(decodeURIComponent(String(req.headers['x-file-name'] || 'file')), 120).replace(/[\\/:*?"<>|]/g, '_');
  const buf = await readBody(req, 10 * 1024 * 1024 + 1);
  const verdict = await docs.check(buf, name, kind, req.headers['x-person'] ? decodeURIComponent(String(req.headers['x-person'])) : '');
  const id = 'd' + crypto.randomBytes(9).toString('hex');
  let file = null;
  // Посвідчення особи не зберігаємо зовсім: лише результат перевірки. Кваліфікацію зберігаємо для модератора.
  if (verdict.ok && kind === 'qual') { file = id + '.' + verdict.type; fs.writeFileSync(path.join(UPLOADS, file), buf, { mode: 0o600 }); }
  const rec = { id, kind, name, size: buf.length, ok: verdict.ok, type: verdict.type, problems: verdict.problems, checks: verdict.checks, createdAt: auth.now() };
  store.raw.prepare('INSERT INTO documents (id, owner, kind, json, file, delete_after) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, owner, kind, JSON.stringify(rec), file, auth.now() + DRAFT_KEEP);
  return { id, name, size: buf.length, ok: verdict.ok, problems: verdict.problems.map(p => p.msg), nameFound: verdict.checks ? verdict.checks.nameFound : null };
});

// Реєстрація фахівця: усі перевірки майстра ще раз на сервері
on('POST', '/api/experts', async ({ req, res }) => {
  const d = await json(req);
  const email = auth.proofEmail(d.proof);
  if (!email) fail(401, 'Підтвердження пошти застаріло. Поверніться на крок 1 і отримайте новий код.', { step: 1 });
  const errs = [];
  const err = (step, field, msg) => errs.push({ step, field, msg });
  const name = R.clip(d.name, 100);
  if (!R.NAME_RE.test(name)) err(1, 'w_name', "Вкажіть прізвище та ім'я повністю");
  if (store.all('users', 'type = ? AND email = ?', 'expert', email).length) err(1, 'w_email', 'Фахівець з такою поштою вже зареєстрований');
  if (!R.phoneOk(d.phone)) err(1, 'w_phone', 'Вкажіть номер у форматі +380XXXXXXXXX або 0XXXXXXXXX');
  if (!R.passStrong(d.pass)) err(1, 'w_pass', 'Пароль має містити щонайменше 8 символів, літери й цифри');
  const about = R.clip(d.about, 2000), position = R.clip(d.position, 120);
  if (R.noEmoji(about).length < 80 || R.realWords(about).length < 10) err(2, 'w_about', 'Опишіть детальніше: щонайменше 80 символів');
  if (position.length < 3) err(2, 'w_position', 'Вкажіть посаду і місце роботи');
  const years = Number(d.years);
  if (!Number.isInteger(years) || years < 0 || years > 60) err(2, 'w_years', 'Вкажіть ціле число років від 0 до 60');
  const ea = search.analyze(about + ' ' + position);
  if (ea.sensitive) err(2, 'w_about', 'Медичні та психологічні консультації на першому етапі не підключені');
  else if (!ea.primary) err(2, 'w_about', 'AI не зміг визначити напрям. Напишіть конкретніше, з якими задачами ви допомагаєте клієнтам.');
  const education = R.clip(d.education, 200);
  if (!R.eduOk(education)) err(3, 'w_edu', 'Не схоже на освіту. Приклад: «КНЕУ, магістр економіки»');
  const link = R.clip(d.link, 500);
  if (link) { const lp = R.linkProblem(link, name); if (lp) err(3, 'w_link', lp); }
  const docRows = id => store.raw.prepare('SELECT * FROM documents WHERE id = ? AND owner = ?').get(id, email);
  const qual = (Array.isArray(d.qualIds) ? d.qualIds : []).slice(0, 10).map(docRows).filter(Boolean).map(r => ({ ...JSON.parse(r.json), file: r.file }));
  if (!qual.length) err(3, 'w_qual', 'Додайте хоча б один документ про кваліфікацію');
  else if (!qual.some(q => q.ok)) err(3, 'w_qual', 'Жоден документ про кваліфікацію не пройшов перевірку. Завантажте інший файл.');
  const idDoc = d.idId && docRows(d.idId);
  if (!idDoc) err(3, 'w_id', 'Додайте документ, що посвідчує особу');
  else if (!JSON.parse(idDoc.json).ok) err(3, 'w_id', 'Документ, що посвідчує особу, не пройшов перевірку. Завантажте інший файл.');
  const price = Number(d.price);
  if (!Number.isInteger(price) || price < 50 || price > 5000) err(4, 'w_price', 'Вкажіть ціну цілим числом від 50 до 5000 грн');
  const days = Array.isArray(d.days) ? [...new Set(d.days.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))] : [];
  if (!days.length) err(4, 'w_days', 'Оберіть хоча б один день');
  const okT = t => /^\d{2}:\d{2}$/.test(String(t || ''));
  if (!okT(d.from) || !okT(d.to) || R.toMin(d.to) - R.toMin(d.from) < 60) err(4, 'w_time', 'Проміжок має бути щонайменше годину, і «до» пізніше за «з»');
  if (d.agree !== true) err(5, 'a_terms', 'Щоб надіслати заявку, позначте всі умови');
  if (errs.length) fail(400, errs[0].msg, { errors: errs });
  const tz = R.validTz(d.tz) ? d.tz : R.KYIV_TZ;
  const user = { id: R.uid('x'), type: 'expert', name, email, phone: String(d.phone).trim(), passHash: auth.hashPassword(d.pass), emailVerified: true, createdAt: auth.now() };
  const okQual = qual.filter(q => q.ok);
  const rec = {
    id: user.id, name, email, phone: user.phone, cat: ea.primary, secondary: ea.secondary, tags: ea.words.slice(0, 8),
    about, position, years, education, link, level: R.LEVEL_OF(years), price, days, from: d.from, to: d.to, tz,
    // Модератора ще немає, тому в демо схвалюємо одразу з позначкою «без перевірки»
    status: 'auto_approved', submittedAt: auth.now(),
    docs: { allOk: true, list: [...okQual.map(q => ({ id: q.id, kind: 'qual', name: q.name, ok: true, nameFound: q.checks && q.checks.nameFound })), { id: d.idId, kind: 'id', name: JSON.parse(idDoc.json).name, ok: true }] },
  };
  store.tx(() => {
    store.put('users', user); store.put('experts', rec); linkClient(user);
    for (const q of okQual) store.raw.prepare('UPDATE documents SET delete_after = ? WHERE id = ?').run(auth.now() + QUAL_KEEP, q.id);
  });
  const token = auth.createSession(user.id, true);
  setSession(res, token);
  return stateFor({ user: store.get('users', user.id) });
});

/* ---------- Лише для автоматичних тестів (TEST_MODE=1) ---------- */
if (process.env.TEST_MODE === '1') {
  on('POST', '/api/test/reset', async () => {
    for (const t of ['users', 'experts', 'bookings', 'subscriptions', 'mail_events', 'outbox', 'sessions', 'codes', 'proofs', 'documents', 'meta']) store.raw.exec(`DELETE FROM ${t}`);
    mail.captured.length = 0; globalThis.__timeShift = 0; return { ok: true };
  });
  on('POST', '/api/test/seed', async ({ req }) => {
    const b = await json(req);
    store.tx(() => {
      for (const u of b.users || []) { const x = { emailVerified: true, createdAt: auth.now(), ...u, email: R.normEmail(u.email) }; if (x.pass) { x.passHash = auth.hashPassword(x.pass); delete x.pass; } store.put('users', x); }
      for (const e of b.experts || []) { const x = { ...e }; delete x.pass; store.put('experts', x); }
      for (const bk of b.bookings || []) store.put('bookings', bk);
      for (const s of b.subscriptions || []) store.put('subscriptions', s);
    });
    return { ok: true };
  });
  on('POST', '/api/test/login', async ({ req, res }) => { const b = await json(req); const token = auth.createSession(b.userId, !!b.expertOk); setSession(res, token); return stateFor({ user: store.get('users', b.userId) }); });
  on('GET', '/api/test/mail', async () => mail.captured);
  on('POST', '/api/test/time', async ({ req }) => { const b = await json(req); globalThis.__timeShift = (globalThis.__timeShift || 0) + Number(b.shift || 0); return { now: auth.now() }; });
  on('POST', '/api/test/notify', async () => { await notify.run(); return { ok: true }; });
  on('POST', '/api/test/sql', async ({ req }) => { const b = await json(req); return store.raw.prepare(b.sql).all(...(b.args || [])); });
}

/* ---------- Розбір запиту ---------- */
function match(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [m, pat] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([\\w-]+)'; }) + '$');
    const mm = pathname.match(re);
    if (mm) return { fn: routes[key], params: Object.fromEntries(names.map((n, i) => [n, mm[i + 1]])) };
  }
  return null;
}
async function handle(req, res, url) {
  const send = (status, obj) => {
    // Завеликий запит ще передається: закриваємо з'єднання, щоб клієнт не використав його повторно
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}) };
    res.writeHead(status, h); res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'POST') {
      // Захист від підробки запитів з чужих сайтів: свій заголовок і той самий Origin
      if (req.headers['x-requested-with'] !== 'mc') return send(403, { error: 'Заборонено' });
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && new URL(origin).host !== req.headers.host) return send(403, { error: 'Заборонено' });
    }
    if (auth.limited('all:' + ipOf(req), 600, 60000)) return send(429, { error: 'Забагато запитів' });
    const m = match(req.method, url.pathname);
    if (!m) return send(404, { error: 'Не знайдено' });
    const sess = auth.sessionUser(cookies(req)[COOKIE]);
    const out = await m.fn({ req, res, sess, params: m.params, query: url.searchParams });
    if (req.method === 'POST' && !url.pathname.startsWith('/api/test/')) notify.run().catch(e => console.error('[notify]', e.name));
    return send(200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[api] помилка', req.method, url.pathname, e.name, e.message && e.message.slice(0, 120));
    return send(500, { error: 'Щось пішло не так на сервері. Спробуйте ще раз.' });
  }
}

// Прибирання: прострочені сесії, коди, підтвердження і файли незавершених реєстрацій
function cleanup() {
  const t = auth.now();
  store.raw.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  store.raw.prepare('DELETE FROM codes WHERE created_at < ?').run(t - 86400000);
  store.raw.prepare('DELETE FROM proofs WHERE expires_at < ?').run(t);
  for (const r of store.raw.prepare('SELECT id, file FROM documents WHERE delete_after < ?').all(t)) {
    if (r.file) fs.rmSync(path.join(UPLOADS, r.file), { force: true });
    store.raw.prepare('UPDATE documents SET file = NULL WHERE id = ?').run(r.id);
  }
}

module.exports = { handle, cleanup, stateFor };
