// AI-пошук фахівців: тема запиту, уточнення, ранжування за змістом, найближчі теми.
'use strict';
const model = require('./model');

const CAT_NAMES = {
  tax: 'Податки і облік', legal: 'Договори й юридичні питання', career: "Кар'єра і резюме", strategy: 'Бізнес-стратегія',
  marketing: 'Маркетинг', tech: 'AI та технології', finance: 'Фінансова грамотність', education: 'Освіта і навчання за кордоном',
};
// Що покриває тема. Потрібно, щоб пояснити різницю, коли пропонуємо найближчу.
const CAT_ABOUT = {
  tax: 'податки, ФОП, звітність, каса, бухгалтерія',
  legal: 'договори, суди, оренда, спадщина, права працівника і споживача',
  career: 'пошук роботи, резюме, співбесіди, зміна професії, підвищення',
  strategy: 'як рости бізнесу: план, ціни, прибуток, інвестори, нові ринки',
  marketing: 'як про бізнес дізнаються клієнти: реклама, соцмережі, бренд, сайт',
  tech: 'сайти, CRM, боти, автоматизація, штучний інтелект, захист даних',
  finance: 'особисті гроші: бюджет, борги, кредити, заощадження, інвестиції',
  education: 'вступ і навчання, зокрема за кордоном, мовні іспити, гранти',
};
// Страховка поверх моделі: медичні і психологічні питання на першому етапі не беремо
const SENSITIVE = /лікар(?!нян)|(?<!\p{L})лік(и|ів|ами)(?!\p{L})|діагноз|хвороб|симптом|аналіз.{0,6}кров|психолог|психотерап|психіатр|депрес|панічн|врач|болезн|таблетк/iu;

function urgencyOf(t) {
  if (/(?<!\p{L})(сьогодні|терміново|негайно|якнайшвидше|зараз|до вечора|asap|срочно|сегодня)/iu.test(t)) return 'today';
  if (/(?<!\p{L})(завтра|цього тижня|на тижні|до кінця тижня|до (понеділка|вівторка|середи|четверга|п'ятниці|суботи|неділі))/iu.test(t)) return 'week';
  return null;
}
function budgetOf(t) {
  const m = t.match(/(\d[\d\s]{1,6})\s*(?:грн|гривень|гривні|гривня|₴)/u) || t.match(/бюджет\D{0,20}(\d{2,5})/u);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\s/g, ''), 10);
  return n >= 50 && n <= 100000 ? n : null;
}
const noEmoji = t => String(t).replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, ' ').replace(/\s+/g, ' ').trim();
function questionOf(text) {
  const clean = noEmoji(text);
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const q = sentences.find(s => s.endsWith('?')) || sentences[0] || clean;
  return q.length > 180 ? q.slice(0, 179) + '…' : q;
}

// Службові слова не пояснюють тему
const STOP = new Set(('як що це щоб якщо треба мені мене мій моя моє мої вже ще так там тут який яка яке які чи або але для про при без від '
  + 'його її їх вони ми ви він вона воно хочу можна потрібно потрібна потрібен треба коли де куди чому тому дуже просто зараз було буде є '
  + 'как что это чтобы если мне меня мой моя мое мои уже еще так там тут какой какая какие или но для про при без от его ее их они мы вы '
  + 'он она хочу можно нужно нужна нужен когда где куда почему очень просто сейчас было будет есть перед після после через').split(' '));
// Слова запиту, які найбільше штовхнули модель до теми. Це і є пояснення «чому ця тема».
function keyWords(text, cls, limit = 5) {
  const words = [...new Set(model.norm(text).split(' ').filter(w => w.length > 2 && !STOP.has(w)))];
  const scored = words.map(w => {
    const p = model.probs(w);
    return { w, s: p[cls] };
  }).filter(x => x.s > 0.35).sort((a, b) => b.s - a.s);
  const orig = noEmoji(text).split(/\s+/).map(x => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, ''));
  return scored.slice(0, limit).map(x => orig.find(o => model.norm(o) === x.w) || x.w);
}

/**
 * Аналіз запиту. experts потрібні, щоб знати, у яких темах хтось є.
 * Повертає те саме, що раніше давав analyzeRequest у браузері, плюс уточнення і найближчі теми.
 */
function analyze(text, experts = [], excluded = []) {
  const p = model.probs(text);
  const ranked = model.TOPICS.filter(c => !excluded.includes(c)).map(c => ({ cat: c, p: p[c] })).sort((a, b) => b.p - a.p);
  const [t1, t2] = ranked;
  const topicMass = ranked.reduce((s, x) => s + x.p, 0);
  const sensitive = SENSITIVE.test(text) || (p.medical > 0.5);
  let primary = null;
  // Тема певна, якщо модель упевнена і друга тема помітно слабша. Інакше перепитуємо.
  if (t1 && t1.p >= 0.42 && t1.p - (t2 ? t2.p : 0) >= 0.12 && p.other < t1.p) primary = t1.cat;
  const secondary = primary && t2 && t2.p >= 0.2 && t2.p >= t1.p * 0.45 ? t2.cat : null;
  const has = c => experts.some(e => e.cat === c);
  // Варіанти для уточнення: теми з помітною ймовірністю
  const candidates = ranked.filter(x => x.p >= 0.1).slice(0, 3).map(x => ({ cat: x.cat, name: CAT_NAMES[x.cat], p: Math.round(x.p * 100), hasExperts: has(x.cat) }));
  // Найближчі теми з фахівцями, якщо в основній нікого немає. Лише ті, що справді схожі.
  let nearest = [];
  if (primary && !has(primary)) {
    nearest = ranked.filter(x => x.cat !== primary && has(x.cat) && x.p >= 0.08).slice(0, 2)
      .map(x => ({ cat: x.cat, name: CAT_NAMES[x.cat], p: Math.round(x.p * 100), about: CAT_ABOUT[x.cat] }));
  }
  return {
    primary, secondary,
    confidence: primary ? Math.round(t1.p * 100) : 0,
    candidates, nearest,
    primaryAbout: primary ? CAT_ABOUT[primary] : null,
    words: primary ? keyWords(text, primary) : [],
    urgency: urgencyOf(text), budget: budgetOf(text), question: questionOf(text),
    sensitive, offTopic: !sensitive && p.other >= 0.45,
    model: { name: 'власна модель тем', version: model.info.version, topicShare: Math.round(topicMass * 100) },
  };
}

// Текст профілю фахівця, з яким порівнюємо запит
function profileText(e) {
  return [CAT_NAMES[e.cat], e.bio, e.position, e.about, (e.tags || []).join(' '), (e.focus || []).map(f => f[1]).join(' ')].filter(Boolean).join('. ');
}
const vecCache = new Map();
function profileVec(e) {
  const key = e.id + '|' + profileText(e);
  if (!vecCache.has(key)) vecCache.set(key, model.vectorize(profileText(e)));
  return vecCache.get(key);
}

/** Ранжування: ймовірність теми фахівця + схожість його опису на запит. */
function rank(text, experts) {
  const p = model.probs(text);
  const q = model.vectorize(text);
  const qWords = [...new Set(model.norm(text).split(' ').filter(w => w.length > 3 && !STOP.has(w)))];
  return experts.map(e => {
    const sim = model.cosine(q, profileVec(e));
    const pt = model.norm(profileText(e));
    const why = qWords.filter(w => pt.includes(w.slice(0, Math.max(4, w.length - 2)))).slice(0, 4);
    const score = Math.round(70 * (p[e.cat] || 0) + 30 * Math.min(1, sim / 0.3));
    return { id: e.id, score, sim: Math.round(sim * 1000) / 1000, topicP: Math.round((p[e.cat] || 0) * 100), why };
  }).sort((a, b) => b.score - a.score);
}

module.exports = { analyze, rank, CAT_NAMES, CAT_ABOUT, info: model.info };
