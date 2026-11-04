// Власна модель тем «Мікро-консультацій». Працює всередині сервера, без зовнішніх API.
// Ваги в model.json, навчання в ai/train/train.py. Ознаки рахуються так само, як у train.py.
'use strict';
const fs = require('fs');
const path = require('path');

const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
const INDEX = new Map(M.features.map((f, i) => [f, i]));
const TOPICS = ['tax', 'legal', 'career', 'strategy', 'marketing', 'tech', 'finance', 'education'];

function norm(s) {
  s = String(s).toLowerCase().replace(/ё/g, 'е').replace(/[’ʼ`´]/g, "'");
  s = s.replace(/[^\p{L}\p{N}\p{M}_']+/gu, ' ').replace(/_/g, ' ');
  return s.split(/\s+/).filter(Boolean).join(' ');
}

function feats(s) {
  const words = norm(s).split(' ').filter(Boolean);
  const out = new Map();
  const add = k => out.set(k, (out.get(k) || 0) + 1);
  for (const w of words) {
    add('w:' + w);
    const p = Array.from('<' + w + '>');
    for (const n of [3, 4, 5]) for (let i = 0; i + n <= p.length; i++) add('c:' + p.slice(i, i + n).join(''));
  }
  for (let i = 0; i + 1 < words.length; i++) add('b:' + words[i] + ' ' + words[i + 1]);
  return out;
}

// Розріджений вектор: Map(індекс ознаки -> вага), нормований
function vectorize(s) {
  const vec = new Map();
  for (const [k, c] of feats(s)) {
    const j = INDEX.get(k);
    if (j !== undefined) vec.set(j, (1 + Math.log(c)) * M.idf[j]);
  }
  let n = 0; for (const v of vec.values()) n += v * v; n = Math.sqrt(n) || 1;
  for (const [j, v] of vec) vec.set(j, v / n);
  return vec;
}

function probs(s) {
  const v = vectorize(s);
  const logits = M.coef.map((row, c) => { let z = M.intercept[c]; for (const [j, x] of v) z += row[j] * x; return z; });
  const mx = Math.max(...logits);
  const e = logits.map(z => Math.exp(z - mx)); const sum = e.reduce((a, b) => a + b, 0);
  const out = {}; M.classes.forEach((c, i) => { out[c] = e[i] / sum; });
  return out;
}

function cosine(a, b) {
  let s = 0; const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [j, x] of small) { const y = big.get(j); if (y) s += x * y; }
  return s;
}

module.exports = { probs, vectorize, cosine, norm, feats, TOPICS, info: { version: M.version, classes: M.classes, trainedOn: M.trainedOn, testAccuracy: M.testAccuracy, features: M.features.length } };
