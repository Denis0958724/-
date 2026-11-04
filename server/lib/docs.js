// Перевірка документів: тип за вмістом, розмір, якість зображення, розпізнавання тексту (OCR), відповідність типу.
// Результат не доводить справжність документа чи особу. Він лише відсіює те, що точно не документ або не читається.
'use strict';
const path = require('path');
const Jimp = require('jimp');

const MAX = 10 * 1024 * 1024, MIN = 200;
const LANG_DIR = path.dirname(require.resolve('@tesseract.js-data/ukr/package.json'));
const LANG_DIR_ENG = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));

/* ---------- Тип за вмістом ---------- */
function sniff(buf) {
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}
const EXT = { pdf: ['pdf'], jpg: ['jpg', 'jpeg'], png: ['png'] };

/* ---------- OCR: один процес на весь сервер ---------- */
let workerP = null;
async function worker() {
  if (!workerP) {
    workerP = (async () => {
      const { createWorker } = require('tesseract.js');
      const fs = require('fs');
      // Мовні дані лежать у node_modules. Tesseract шукає обидві мови в одній теці, тож збираємо їх у data/tessdata.
      const dir = path.join(require('./db').DATA, 'tessdata');
      fs.mkdirSync(dir, { recursive: true });
      for (const [l, d] of [['ukr', LANG_DIR], ['eng', LANG_DIR_ENG]]) {
        const dst = path.join(dir, `${l}.traineddata.gz`);
        if (!fs.existsSync(dst)) fs.copyFileSync(path.join(d, '4.0.0', `${l}.traineddata.gz`), dst);
      }
      return createWorker(['ukr', 'eng'], 1, { langPath: dir, cachePath: dir, gzip: true, logger: () => {} });
    })();
  }
  return workerP;
}

/* ---------- Якість зображення ---------- */
function grayStats(img) {
  const { width: w, height: h, data } = img.bitmap;
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) { const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; g[p] = v; sum += v; }
  const mean = sum / g.length;
  let sq = 0; for (const v of g) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / g.length);
  // Різкість: дисперсія лапласіана. Розмите фото дає малі перепади між сусідніми пікселями.
  let ls = 0, ls2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    ls += l; ls2 += l * l; n++;
  }
  const lapVar = n ? ls2 / n - (ls / n) ** 2 : 0;
  return { mean, std, lapVar };
}

/* ---------- Чи схожий текст на документ потрібного типу ---------- */
const TYPE_RE = {
  qual: /(диплом|сертиф|свідоцтв|посвідчен|ліценз|атестат|кваліфікац|бакалавр|магістр|спеціаліст|університет|академі|інститут|коледж|курс|ступ[еі]н|освіт|certificat|diploma|degree|universit|college|academy|institute|course|bachelor|master|licen[cs]e|qualification)/iu,
  id: /(паспорт|passport|громадян|україна|ukraine|посвідчення|id-?карт|identity|прізвище|surname|ім['’ʼ]?я|given name|дата народження|date of birth|рнокпп|документ\s*№|record no)/iu,
};
const TYPE_NAME = { qual: 'диплом, сертифікат, свідоцтво чи ліцензію', id: 'паспорт чи ID-картку' };

// Сканований PDF: картинки сторінок зазвичай лежать усередині як готові JPEG
function jpegsInPdf(buf) {
  const out = []; let i = 0;
  while ((i = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), i)) !== -1) {
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), i + 3);
    if (end === -1) break;
    // Беремо до останнього маркера кінця перед наступним «endstream»
    const es = buf.indexOf('endstream', i);
    const stop = es !== -1 ? buf.lastIndexOf(Buffer.from([0xff, 0xd9]), es) : end;
    if (stop > i) out.push(buf.slice(i, stop + 2));
    i = (stop > i ? stop : end) + 2;
  }
  return out.sort((a, b) => b.length - a.length);
}
async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  let text = '';
  for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    text += c.items.map(x => x.str).join(' ') + '\n';
  }
  return { text, pages: doc.numPages };
}

async function checkImage(buf) {
  let img;
  try { img = await Jimp.read(buf); } catch { return { problems: [P('broken', 'Файл пошкоджений або це не зображення. Збережіть фото ще раз і завантажте.')] }; }
  const { width, height } = img.bitmap;
  const problems = [];
  if (Math.min(width, height) < 600 || width * height < 600 * 800) {
    problems.push(P('small', `Зображення замале (${width}×${height}). Потрібно щонайменше 600×800 пікселів: сфотографуйте ближче або завантажте скан.`));
    return { problems };
  }
  const probe = img.clone().resize(width >= height ? 900 : Jimp.AUTO, width >= height ? Jimp.AUTO : 900);
  const st = grayStats(probe);
  if (st.std < 8) problems.push(P('blank', 'Зображення порожнє: на ньому майже нічого немає. Сфотографуйте сам документ.'));
  else if (st.mean < 45) problems.push(P('dark', 'Фото занадто темне. Сфотографуйте при кращому освітленні.'));
  else if (st.mean > 250) problems.push(P('bright', 'Фото пересвічене. Приберіть спалах або яскраве світло.'));
  else if (st.lapVar < 25) problems.push(P('blurry', 'Фото розмите, текст не прочитати. Тримайте телефон рівно і сфокусуйтесь на документі.'));
  if (problems.length) return { problems, quality: round(st) };
  // Для OCR: сірий, до 2000 пікселів по довшій стороні
  const ocrImg = img.clone().greyscale();
  if (Math.max(width, height) > 2000) ocrImg.scaleToFit(2000, 2000);
  const png = await ocrImg.getBufferAsync(Jimp.MIME_PNG);
  const w = await worker();
  const r = await w.recognize(png);
  return { quality: round(st), ocr: r.data };
}
const P = (code, msg) => ({ code, msg });
const round = st => ({ mean: Math.round(st.mean), std: Math.round(st.std), sharp: Math.round(st.lapVar) });

function textVerdict(text, conf, kind, name) {
  const words = (String(text).match(/\p{L}{3,}/gu) || []);
  const problems = [];
  if (words.length < 6 || (conf != null && conf < 55)) {
    problems.push(P('no_text', `На зображенні не видно документа з текстом. Завантажте ${TYPE_NAME[kind]}: увесь документ у кадрі, текст читається.`));
    return { problems, words: words.length };
  }
  if (!TYPE_RE[kind].test(text)) problems.push(P('wrong_type', `Текст є, але це не схоже на ${TYPE_NAME[kind]}. Перевірте, що завантажуєте потрібний документ.`));
  // Збіг імені: лише позначка для модератора, не причина відмови
  const parts = String(name || '').toLowerCase().split(/\s+/).filter(x => x.length >= 3);
  const low = String(text).toLowerCase();
  const nameFound = parts.length ? parts.some(p => low.includes(p)) : null;
  return { problems, words: words.length, nameFound };
}

/**
 * Перевірка файлу. kind: 'qual' (кваліфікація) або 'id' (посвідчення особи).
 * Повертає { ok, type, problems[], checks{} }. Текст документа назовні не віддаємо.
 */
async function check(buf, fileName, kind, name) {
  const problems = [];
  if (!Buffer.isBuffer(buf) || buf.length < MIN) return { ok: false, problems: [P('empty', 'Файл порожній або пошкоджений.')] };
  if (buf.length > MAX) return { ok: false, problems: [P('too_big', 'Файл більший за 10 МБ.')] };
  const type = sniff(buf);
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (!type) return { ok: false, problems: [P('format', 'Непідтримуваний формат. Потрібен PDF, JPG або PNG.')] };
  if (!EXT[type].includes(ext)) return { ok: false, type, problems: [P('mismatch', `Розширення .${ext} не відповідає вмісту файлу (${type.toUpperCase()}). Збережіть файл у правильному форматі.`)] };
  const checks = { type };
  try {
    if (type === 'pdf') {
      if (buf.includes('/Encrypt')) return { ok: false, type, problems: [P('encrypted', 'PDF захищений паролем. Завантажте файл без пароля.')] };
      if (/\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(buf.toString('latin1'))) return { ok: false, type, problems: [P('unsafe', 'PDF містить скрипти або вкладені файли. Збережіть документ як звичайний PDF чи фото.')] };
      const { text, pages } = await pdfText(buf);
      checks.pages = pages;
      if ((text.match(/\p{L}{3,}/gu) || []).length >= 6) {
        const v = textVerdict(text, null, kind, name); problems.push(...v.problems); checks.words = v.words; checks.nameFound = v.nameFound; checks.source = 'pdf_text';
      } else {
        const jpg = jpegsInPdf(buf)[0];
        if (!jpg) problems.push(P('pdf_no_text', 'У PDF немає тексту, який можна прочитати. Завантажте фото або скан документа у JPG чи PNG.'));
        else {
          const r = await checkImage(jpg); checks.quality = r.quality; checks.source = 'pdf_scan';
          if (r.problems) problems.push(...r.problems);
          else { const v = textVerdict(r.ocr.text, r.ocr.confidence, kind, name); problems.push(...v.problems); checks.words = v.words; checks.ocrConf = Math.round(r.ocr.confidence); checks.nameFound = v.nameFound; }
        }
      }
    } else {
      const r = await checkImage(buf); checks.quality = r.quality; checks.source = 'image';
      if (r.problems) problems.push(...r.problems);
      else { const v = textVerdict(r.ocr.text, r.ocr.confidence, kind, name); problems.push(...v.problems); checks.words = v.words; checks.ocrConf = Math.round(r.ocr.confidence); checks.nameFound = v.nameFound; }
    }
  } catch (e) {
    console.error('[docs] помилка перевірки:', e.name);
    return { ok: false, type, problems: [P('check_failed', 'Не вдалося перевірити файл. Спробуйте ще раз або завантажте інший формат.')] };
  }
  return { ok: problems.length === 0, type, problems, checks };
}

module.exports = { check, sniff, worker };
