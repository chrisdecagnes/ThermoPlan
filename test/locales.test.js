'use strict';

// Les 4 langues (fr, en, nl, de) doivent avoir les mêmes clés et les mêmes jetons
// (__x__, [[x]], !{{…|…}}) que l'anglais. Générées par `npm run compose`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const load = (l) => require(path.join(__dirname, '..', 'locales', `${l}.json`));
const tokens = (s) => (String(s).match(/__\w+?__|\[\[\w+\]\]|!\{\{/g) || []).sort();

function flat(node, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

const en = flat(load('en'));

for (const lang of ['fr', 'nl', 'de']) {
  test(`locales/${lang}.json : mêmes clés et mêmes jetons que l'anglais`, () => {
    const other = flat(load(lang));
    assert.deepStrictEqual(Object.keys(other).sort(), Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) {
      if (k === 'settings.locale') continue;
      assert.deepStrictEqual(tokens(other[k]), tokens(v), `${lang} ${k}`);
    }
  });
}

test('nl et de sont réellement traduits (pas un simple repli sur l’anglais)', () => {
  const nl = flat(load('nl'));
  const de = flat(load('de'));
  assert.strictEqual(nl['settings.locale'], 'nl-NL');
  assert.strictEqual(de['settings.locale'], 'de-DE');
  const same = (o) => Object.keys(en).filter((k) => o[k] === en[k] && /[a-z]{4,}/.test(en[k])).length;
  assert.ok(same(nl) < 15, `nl : ${same(nl)} textes identiques à l'anglais`);
  assert.ok(same(de) < 15, `de : ${same(de)} textes identiques à l'anglais`);
});

test('app.json : chaque texte fr/en a aussi nl et de', () => {
  const app = require(path.join(__dirname, '..', 'app.json'));
  const missing = [];
  (function walk(n, p) {
    if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (n && typeof n === 'object') {
      if (typeof n.en === 'string' && typeof n.fr === 'string' && (!n.nl || !n.de)) missing.push(p);
      else Object.entries(n).forEach(([k, v]) => walk(v, `${p}.${k}`));
    }
  })(app, 'app');
  assert.deepStrictEqual(missing, []);
});
