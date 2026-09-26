// ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности I3) — карта «что дают ворота
// ненастроенного ключа» совпадает с самими воротами. Карта — копия списков
// ролей из services/rpc; этот тест находит каждый вызов requireGrant /
// grantAllows с ключом справочника и сверяет его список с картой. Новые ворота
// без строки в карте или разошедшийся список — красный тест, а не защита
// «Ролей», которая молча судит по устаревшей копии.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_FALLBACK } from './gate-fallbacks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RPC = path.join(HERE, 'rpc');
const norm = (list) => JSON.stringify([...list].sort());

function parseList(src, file) {
  const m = src.match(/^\[([^\]]*)\]$/);
  if (!m) throw new Error('не список: ' + src + ' в ' + file);
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

function callSites() {
  const out = [];
  for (const f of fs.readdirSync(RPC)) {
    if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
    const text = fs.readFileSync(path.join(RPC, f), 'utf8');
    const re = /(?:requireGrant|grantAllows)\(db, user, '([a-z_.]+)', '(view|edit|delete)', (\w+|\[[^\]]*\])/g;
    let m;
    while ((m = re.exec(text))) {
      let list;
      if (m[3].startsWith('[')) list = parseList(m[3], f);
      else {
        const c = text.match(new RegExp('const ' + m[3] + ' = (\\[[^\\]]*\\])'));
        assert.ok(c, f + ': не найден список ' + m[3]);
        list = parseList(c[1], f);
      }
      out.push({ file: f, key: m[1], need: m[2], list });
    }
  }
  return out;
}

test('каждые ворота ключа справочника — строкой в карте, с тем же списком ролей', () => {
  const sites = callSites();
  assert.ok(sites.length >= 20, 'сканер не видит ворот: ' + sites.length);
  for (const s of sites) {
    const lists = (GATE_FALLBACK[s.key] || {})[s.need] || [];
    assert.ok(lists.some((l) => norm(l) === norm(s.list)), `${s.file}: ${s.key}/${s.need} ${JSON.stringify(s.list)} — нет в gate-fallbacks.js`);
  }
  // И в карте нет выдуманных ворот (кроме двух, что живут не в rpc: row-scope и реестр).
  for (const [key, byNeed] of Object.entries(GATE_FALLBACK)) {
    if (key === 'crm.all' || key === 'crm.convert') continue;
    for (const [need, lists] of Object.entries(byNeed)) {
      for (const l of lists) {
        assert.ok(sites.some((s) => s.key === key && s.need === need && norm(s.list) === norm(l)), `${key}/${need} ${JSON.stringify(l)} — таких ворот нет`);
      }
    }
  }
});
