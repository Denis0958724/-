# Навчання власної моделі тем для «Мікро-консультацій».
# Запуск: python3 train.py   (потрібні numpy, scipy, scikit-learn)
# Результат: ../model.json. Сервер читає його через ai/model.js, ознаки рахуються тим самим способом.
import json, math, os, re, sys
from collections import Counter
import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from data_train import build, HAND
from data_test import TEST
from data_test2 import TEST2
from data_extra import LEXICON, MORE
import random

CLASSES = ['tax', 'legal', 'career', 'strategy', 'marketing', 'tech', 'finance', 'education', 'medical', 'other']
NON_LETTER = re.compile(r"[^\w']+", re.U)

def norm(s):
    s = s.lower().replace('ё', 'е').replace('’', "'").replace('ʼ', "'").replace('`', "'").replace('´', "'")
    s = NON_LETTER.sub(' ', s).replace('_', ' ')
    return ' '.join(s.split())

def feats(s):
    words = norm(s).split()
    out = Counter()
    for w in words:
        out['w:' + w] += 1
        p = '<' + w + '>'
        for n in (3, 4, 5):
            for i in range(len(p) - n + 1):
                out['c:' + p[i:i + n]] += 1
    for a, b in zip(words, words[1:]):
        out['b:' + a + ' ' + b] += 1
    return out

def vectorize(docs, vocab, idf):
    rows, cols, vals = [], [], []
    for r, d in enumerate(docs):
        f = feats(d); vec = {}
        for k, c in f.items():
            j = vocab.get(k)
            if j is not None: vec[j] = (1 + math.log(c)) * idf[j]
        nrm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        for j, v in vec.items(): rows.append(r); cols.append(j); vals.append(v / nrm)
    return csr_matrix((vals, (rows, cols)), shape=(len(docs), len(vocab)))

def fit(X, y, C):
    df = Counter()
    for d in X: df.update(set(feats(d)))
    keys = sorted(k for k, c in df.items() if c >= 2)
    vocab = {k: i for i, k in enumerate(keys)}
    N = len(X)
    idf = [math.log((1 + N) / (1 + df[k])) + 1 for k in keys]
    M = vectorize(X, vocab, idf)
    clf = LogisticRegression(C=C, max_iter=3000)
    clf.fit(M, [CLASSES.index(c) for c in y])
    return vocab, idf, clf

def main():
    X, y = build()
    rnd = random.Random(11)
    from data_train import PREFIX, SUFFIX, typo
    for cat, items in MORE.items():
        for s in items:
            X.append(s); y.append(cat)
            for _ in range(5):
                t = rnd.choice(PREFIX) + s + rnd.choice(SUFFIX)
                if rnd.random() < 0.35: t = typo(t, rnd)
                if rnd.random() < 0.2: t = t.lower()
                X.append(t); y.append(cat)
    FRAMES = ['{}', '{}', 'Питання про {}', 'Потрібна консультація: {}', 'Вопрос про {}', 'Допоможіть з темою {}', '{}, що робити?']
    for cat, terms in LEXICON.items():
        for t in terms:
            for f in rnd.sample(FRAMES, 3): X.append(f.format(t)); y.append(cat)
    print(f'Навчальних прикладів: {len(X)} (вручну {sum(len(v) for v in HAND.values())})')
    # Підбір C перехресною перевіркою на ручних прикладах (без їхніх копій, щоб не підглядати)
    base = [(s, c) for c, v in HAND.items() for s in v] + [(s, c) for c, v in MORE.items() for s in v]
    best = None
    for C in (2, 5, 10, 20, 40):
        skf = StratifiedKFold(5, shuffle=True, random_state=1); acc = []
        bx = [s for s, _ in base]; by = [c for _, c in base]
        for tr, te in skf.split(bx, by):
            from data_train import PREFIX, SUFFIX
            trX = [bx[i] for i in tr]; trY = [by[i] for i in tr]
            vocab, idf, clf = fit(trX + [p + s for s in trX for p in PREFIX[3:6]], trY + [c for c in trY for _ in PREFIX[3:6]], C)
            pred = clf.predict(vectorize([bx[i] for i in te], vocab, idf))
            acc.append(np.mean([CLASSES[p] == by[i] for p, i in zip(pred, te)]))
        a = float(np.mean(acc)); print(f'C={C}: перехресна точність {a:.3f}')
        if not best or a > best[1]: best = (C, a)
    C = best[0]
    vocab, idf, clf = fit(X, y, C)
    for name, T in (('тест 1 (бачив помилки v1)', TEST), ('тест 2 (свіжий)', TEST2)):
        tx = [t for _, t in T]; ty = [c for c, _ in T]
        P = clf.predict_proba(vectorize(tx, vocab, idf)); pr = [CLASSES[i] for i in P.argmax(1)]
        ok = [a == b for a, b in zip(pr, ty)]
        conf = P.max(1) >= 0.45
        print(f'{name}: {sum(ok)}/{len(ok)} = {np.mean(ok):.3f}; впевнених {conf.sum()}, з них правильних {sum(o for o, c in zip(ok, conf) if c)}; уточнення {(~conf).sum()}')
        if T is TEST2:
            for (c, t), p_, pp in zip(T, pr, P):
                if p_ != c: print(f'  ПОМИЛКА очік={c} модель={p_} {pp.max():.2f}  {t}')
    tx = [t for _, t in TEST2]; ty = [c for c, _ in TEST2]
    P = clf.predict_proba(vectorize(tx, vocab, idf))
    pred = [CLASSES[i] for i in P.argmax(1)]
    acc = np.mean([a == b for a, b in zip(pred, ty)])
    print(f'Обрано C={C}. Тест 2: {acc:.3f} ({sum(a == b for a, b in zip(pred, ty))}/{len(ty)})')

    # Обрізаємо ознаки з майже нульовою вагою, щоб файл був меншим
    W = clf.coef_
    keep = [j for j in range(W.shape[1]) if np.abs(W[:, j]).max() >= 0.02]
    remap = {old: new for new, old in enumerate(keep)}
    inv = {i: k for k, i in vocab.items()}
    model = {
        'version': 1, 'classes': CLASSES, 'C': C, 'trainedOn': len(X), 'testAccuracy': round(float(acc), 3),
        'features': [inv[j] for j in keep], 'idf': [round(idf[j], 5) for j in keep],
        'coef': [[round(float(W[c, j]), 4) for j in keep] for c in range(len(CLASSES))],
        'intercept': [round(float(b), 4) for b in clf.intercept_],
    }
    # Перевірка, що обрізання не змінило відповідей на тесті
    v2 = {k: i for i, k in enumerate(model['features'])}
    M2 = vectorize(tx, v2, model['idf']).toarray()
    logits = M2 @ np.array(model['coef']).T + np.array(model['intercept'])
    pred2 = [CLASSES[i] for i in logits.argmax(1)]
    print(f'Ознак: {len(vocab)} -> {len(keep)} після обрізання; збіг відповідей {np.mean([a == b for a, b in zip(pred, pred2)]):.3f}')
    out = os.path.join(HERE, '..', 'model.json')
    json.dump(model, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    json.dump([{'text': t, 'probs': [round(float(v), 6) for v in (np.exp(l - l.max()) / np.exp(l - l.max()).sum())]} for t, l in zip(tx, logits)],
              open(os.path.join(HERE, 'parity.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print('Збережено', os.path.normpath(out), f'{os.path.getsize(out) // 1024} КБ')

if __name__ == '__main__':
    main()
