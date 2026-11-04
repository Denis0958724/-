// Сповіщення на пошту за ТЗ «Email-сповіщення»: нові фахівці за підпискою і зміна стану консультації.
// Лише на підтверджену пошту, не частіше одного листа на добу, події за добу разом, без старих записів і дублікатів.
'use strict';
const store = require('./db');
const mail = require('./mail');
const { uid } = require('./rules');
const { now } = require('./auth');

const DAY = 86400000;
const CONSULT_STATUS = { action: 'Потребує дії', planned: 'Заплановано', done: 'Завершено' };
const CAT_NAMES = require('../ai/search').CAT_NAMES;
const consultStatus = b => (b.status === 'done' ? 'done' : b.at > now() ? 'planned' : 'action');

function start() {
  if (store.meta('notifyStartedAt')) return;
  // Запуск: усе, що вже існує, вважаємо відомим. Про старі записи листів не буде.
  store.tx(() => {
    for (const b of store.all('bookings')) { b.notifiedStatus = consultStatus(b); store.put('bookings', b); }
    store.meta('notifyStartedAt', now());
  });
}
function queue(userId, key, ev) {
  const dup = store.raw.prepare("SELECT 1 FROM mail_events WHERE json LIKE ? LIMIT 1").get(`%"key":${JSON.stringify(key)}%`)
    || store.raw.prepare("SELECT 1 FROM outbox WHERE json LIKE ? LIMIT 1").get(`%${JSON.stringify(key)}%`);
  if (dup) return;
  store.put('mail_events', { id: uid('e'), userId, key, createdAt: now(), ...ev });
}
function subject(evs) {
  if (evs.length === 1) {
    const e = evs[0];
    if (e.type === 'expert') return 'Знайдено нового фахівця для вас';
    return { planned: 'Ваша консультація запланована', done: 'Консультацію завершено', action: 'Оновлення статусу вашої консультації' }[e.status];
  }
  if (evs.every(e => e.type === 'expert')) return 'Знайдено нових фахівців для вас';
  if (evs.every(e => e.type === 'status')) return 'Оновлення статусу вашої консультації';
  return 'Нові фахівці і оновлення ваших консультацій';
}
const kyiv = at => new Date(at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function body(evs) {
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const lines = evs.map(e => e.type === 'expert'
    ? `Новий фахівець: ${e.expertName}, тема «${CAT_NAMES[e.cat] || e.cat}», ${e.price} грн за 15 хв.\nПодивитись: ${base}/#/sub/${e.subId}`
    : `Консультація з фахівцем ${e.expertName}: статус «${CONSULT_STATUS[e.status]}»${e.at ? `, ${kyiv(e.at)} (час Києва)` : ''}.\nСторінка консультації: ${base}/#/consult/${e.bookingId}`);
  return lines.join('\n\n') + '\n\nНе більше одного листа на добу. Мікро-консультації';
}

let running = false;
async function run() {
  if (running) return false;
  running = true;
  try {
    start();
    const users = new Map(store.all('users').map(u => [u.id, u]));
    const experts = store.all('experts');
    // 1. Нові фахівці за підписками
    for (const sb of store.all('subscriptions')) {
      sb.notifiedExpertIds = sb.notifiedExpertIds || [];
      const owner = users.get(sb.userId) || {};
      let changed = false;
      for (const rec of experts) {
        if ((rec.submittedAt || 0) <= sb.createdAt || sb.notifiedExpertIds.includes(rec.id) || rec.id === owner.expertId) continue;
        if (!['approved', 'auto_approved'].includes(rec.status) || rec.cat !== sb.cat || (sb.budget && rec.price > sb.budget)) continue;
        sb.notifiedExpertIds.push(rec.id); changed = true;
        queue(sb.userId, `expert:${sb.id}:${rec.id}`, { type: 'expert', subId: sb.id, expertId: rec.id, expertName: rec.name, cat: rec.cat, price: rec.price });
      }
      if (changed) store.put('subscriptions', sb);
    }
    // 2. Консультації: лише зміна стану
    for (const b of store.all('bookings')) {
      const st = consultStatus(b);
      if (b.notifiedStatus === st) continue;
      b.notifiedStatus = st; store.put('bookings', b);
      queue(b.clientId, `status:${b.id}:${st}`, { type: 'status', bookingId: b.id, expertName: b.expertName, status: st, at: b.at });
    }
    // 3. Відправлення
    const byUser = {};
    for (const e of store.all('mail_events')) (byUser[e.userId] = byUser[e.userId] || []).push(e);
    for (const [userId, evs] of Object.entries(byUser)) {
      const u = users.get(userId);
      if (!u || !u.emailVerified) continue;
      const last = store.all('outbox').filter(m => m.email === u.email).reduce((mx, m) => Math.max(mx, m.sentAt), 0);
      if (last && now() - last < DAY) continue;
      evs.sort((a, b) => a.createdAt - b.createdAt);
      const subj = subject(evs);
      try { await mail.send({ to: u.email, subject: subj, text: body(evs) }); }
      catch (e) { if (e.code !== 'MAIL_OFF') console.error('[notify] лист не відправлено:', e.code || e.name); continue; }
      store.tx(() => {
        store.put('outbox', { id: uid('m'), userId, email: u.email, sentAt: now(), subject: subj, items: evs.map(e => ({ ...e })), keys: evs.map(e => e.key) });
        for (const e of evs) store.del('mail_events', e.id);
      });
    }
    return true;
  } finally { running = false; }
}

module.exports = { run, consultStatus, DAY };
