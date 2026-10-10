// CLINIC_API_STEP7_V1 — живой ключ подключения или секрет вебхука не должен
// лежать в исходниках (тот же урок, что NO_REAL_TOKENS_V1 у Telegram). Тесты
// выпускают ключи во время прогона; строка-образец обязана нести TESTONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const KEY_LIKE = /\bem_(?:live|whsec)_[A-Za-z0-9]{32}\b/g;
const SKIP = new Set(['node_modules', '.git', 'data', 'releases', 'versions', 'dist']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.html', '.css']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

test('ни одного живого на вид ключа API или секрета вебхука в исходниках', () => {
  const offenders = [];
  for (const f of walk(ROOT)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const hit of text.match(KEY_LIKE) || []) {
      if (!hit.includes('TESTONLY')) offenders.push(path.relative(ROOT, f) + ': ' + hit.slice(0, 14) + '…');
    }
  }
  assert.deepEqual(offenders, [], 'похоже на настоящий ключ — замените образцом с TESTONLY:\n  ' + offenders.join('\n  '));
});
