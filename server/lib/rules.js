// Спільні правила: часові пояси, слоти, перевірки полів. Ті самі, що в prototype.html, але тут вони вирішальні.
'use strict';
const crypto = require('crypto');

const uid = p => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const pad = n => String(n).padStart(2, '0');
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const fromMin = n => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const KYIV_TZ = 'Europe/Kyiv';

const _fmt = {};
function tzParts(ms, tz) {
  const f = _fmt[tz] || (_fmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function tzOffsetMin(ms, tz) {
  const p = tzParts(ms, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let at = guess - tzOffsetMin(guess, tz) * 60000;
  at = guess - tzOffsetMin(at, tz) * 60000;
  return at;
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
const expertTz = ex => (ex && ex.tz && validTz(ex.tz) ? ex.tz : KYIV_TZ);

const MOCK_TIMES = ['09:00', '09:30', '10:00', '11:15', '12:00', '13:30', '15:00', '16:45', '18:00', '19:30', '20:30', '21:15'];
// Можливі моменти консультацій фахівця на найближчі дні (без перевірки зайнятості)
function slotMoments(ex, now = Date.now()) {
  const tz = expertTz(ex), today = tzParts(now, tz);
  const horizon = ex.demo ? 3 : 7, all = [];
  for (let d = 0; d < horizon; d++) {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + d));
    const y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, da = base.getUTCDate(), wd = (base.getUTCDay() + 6) % 7;
    let times;
    if (ex.demo) {
      const seed = parseInt(String(ex.id).slice(1), 10);
      times = MOCK_TIMES.filter((t, i) => (i + seed + d * 2) % 3 === 0);
    } else {
      times = [];
      if ((ex.days || []).includes(wd)) for (let t = toMin(ex.from); t + 15 <= toMin(ex.to); t += 60) times.push(fromMin(t));
    }
    for (const t of times) {
      const [h, mi] = t.split(':').map(Number);
      const at = zonedToUtc(y, mo, da, h, mi, tz);
      if (at > now + 30 * 60000) all.push(at);
    }
  }
  return all.sort((a, b) => a - b);
}

/* ---------- Перевірки полів ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Пошта: формат, довжина, домен з крапкою і без подвійних крапок. Чи існує скринька, показує лише код з листа.
function emailProblem(email) {
  const e = String(email || '').trim();
  if (!e) return 'Вкажіть адресу пошти';
  if (e.length > 254 || !EMAIL_RE.test(e)) return 'Перевірте адресу пошти';
  const [local, domain] = [e.slice(0, e.lastIndexOf('@')), e.slice(e.lastIndexOf('@') + 1).toLowerCase()];
  if (local.length > 64 || /\.\./.test(e) || local.startsWith('.') || local.endsWith('.')) return 'Перевірте адресу пошти';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || domain.split('.').some(p => !p || p.startsWith('-') || p.endsWith('-'))) return 'Перевірте адресу пошти';
  if (/^(gmail|googlemail)\.com$/.test(domain)) {
    const l = local.split('+')[0].replace(/\./g, '');
    if (!/^[a-z0-9]{6,30}$/i.test(l)) return 'Такої адреси Gmail не буває: від 6 до 30 літер і цифр';
  }
  return null;
}
const normEmail = e => String(e || '').trim().toLowerCase();
const NAME_RE = /^[\p{L}'’ʼ-]{2,}(\s+[\p{L}'’ʼ-]{2,})+$/u;
const phoneOk = p => /^(\+?380|0)\d{9}$/.test(String(p || '').replace(/[\s()-]/g, ''));
const passStrong = p => typeof p === 'string' && p.length >= 8 && p.length <= 200 && /\p{L}/u.test(p) && /\d/.test(p);

const noEmoji = t => String(t || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, ' ').replace(/\s+/g, ' ').trim();
const realWords = t => (noEmoji(t).toLowerCase().match(/\p{L}{2,}/gu) || []).filter(w => !/(\p{L})\1\1/u.test(w));

const EDU_RE = /(універс|університ|інститут|академі|коледж|технікум|училищ|ліце|гімназі|школ|факультет|кафедр|бакалавр|магістр|спеціаліст|аспірант|докторант|кандидат|доктор|ступін|ступен|диплом|сертиф|курс|освіт|спеціальн|университет|институт|академи|колледж|universit|college|institut|academy|school|faculty|bachelor|master|degree|diploma|certif|course|phd|mba|bsc|msc)/u;
function eduOk(t) {
  const c = noEmoji(t);
  if (c.length < 3 || !realWords(c).length) return false;
  return EDU_RE.test(c.toLowerCase()) || /(?<!\p{L})\p{Lu}{2,6}(?!\p{L})/u.test(c);
}
const PROFILE_HOSTS = ['linkedin.com', 'github.com', 'gitlab.com', 'behance.net', 'dribbble.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  't.me', 'youtube.com', 'tiktok.com', 'threads.net', 'medium.com', 'upwork.com', 'djinni.co', 'work.ua', 'robota.ua', 'scholar.google.com', 'orcid.org'];
const PROFILE_SUBS = ['medium.com', 'substack.com'];
const NOT_HANDLE = ['', 'search', 'explore', 'home', 'feed', 'login', 'signup', 'watch', 'results', 'jobs', 'hashtag'];
const SEARCH_HOST = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|startpage)\.[a-z.]+$/;
const TR_A = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '' };
const TR_B = { ...TR_A, г: 'g', х: 'h', й: 'y', є: 'ye', ї: 'yi', ю: 'yu', я: 'ya' };
const translit = (w, tr) => [...w.toLowerCase()].map(ch => tr[ch] ?? ch).join('').replace(/[^a-z]/g, '');
function nameInHost(host, name) {
  const h = host.replace(/[^a-z]/g, '');
  return String(name).split(/[\s'’ʼ-]+/).some(part => [TR_A, TR_B].some(tr => { const l = translit(part, tr); return l.length >= 4 && h.includes(l.slice(0, 6)); }));
}
function linkProblem(link, name) {
  if (!/^https?:\/\/[^\s.]+\.\S+$/i.test(link) || link.length > 500) return 'Посилання має починатися з http:// або https://';
  let u; try { u = new URL(link); } catch { return 'Посилання має починатися з http:// або https://'; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const segs = u.pathname.split('/').filter(Boolean).map(x => x.toLowerCase());
  if (PROFILE_HOSTS.includes(host)) {
    if (host === 'linkedin.com' ? ['in', 'company', 'pub'].includes(segs[0]) && segs[1] : !NOT_HANDLE.includes(segs[0] || '') || (host === 'scholar.google.com' && u.searchParams.get('user'))) return null;
  } else if (PROFILE_SUBS.some(p => host.endsWith('.' + p))) return null;
  if (SEARCH_HOST.test(host) || segs[0] === 'search') return 'Це посилання на пошук. Потрібен ваш профіль або сайт.';
  if (!PROFILE_HOSTS.includes(host) && nameInHost(host, name)) return null;
  return 'Це не схоже на ваш профіль чи сайт';
}

const LEVEL_OF = years => (+years < 2 ? 'student' : +years < 8 ? 'practitioner' : 'expert');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

module.exports = { uid, pad, toMin, fromMin, tzParts, zonedToUtc, expertTz, validTz, slotMoments, KYIV_TZ,
  emailProblem, normEmail, NAME_RE, phoneOk, passStrong, noEmoji, realWords, eduOk, linkProblem, LEVEL_OF, clip };
