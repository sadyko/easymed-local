// PUBLIC_SERVER_V1 — ревью 8b, C13: DEPLOY.md ставит зависимости службы
// командой `npm ci --omit=dev` внутри public-server/, а npm ci без своего
// package-lock.json не работает (корневой lock npm здесь не берёт — в корне нет
// workspaces). Lock службы выводится из корневого package-lock.json (те же
// версии, что прогнаны тестами), без сети: public-server/scripts/lock-from-root.mjs.
// Страж: lock есть, совпадает с выводом из корневого, его корень — ровно
// зависимости package.json, у каждого пакета есть адрес и отпечаток, и каждая
// зависимость находится внутри lock тем же поиском, что у Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockFromRoot } from '../scripts/lock-from-root.mjs';

const SERVICE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(SERVICE);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('у службы свой package-lock.json — тот, что выводится из корневого (без сети)', () => {
  const file = path.join(SERVICE, 'package-lock.json');
  assert.ok(fs.existsSync(file), 'public-server/package-lock.json — без него `npm ci --omit=dev` из DEPLOY.md падает (EUSAGE)');
  const lock = read(file);
  const pkg = read(path.join(SERVICE, 'package.json'));
  const root = read(path.join(REPO, 'package-lock.json'));
  assert.deepEqual(lock, lockFromRoot(root, pkg), 'lock устарел — node public-server/scripts/lock-from-root.mjs');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const name of Object.keys(pkg.dependencies)) {
    assert.equal(lock.packages['node_modules/' + name].version, root.packages['node_modules/' + name].version, name + ' — та же версия, что в корне');
  }
});

test('каждый пакет lock — с адресом и отпечатком; каждая его зависимость находится внутри lock', () => {
  const lock = read(path.join(SERVICE, 'package-lock.json'));
  const has = (p) => Object.prototype.hasOwnProperty.call(lock.packages, p);
  for (const [p, e] of Object.entries(lock.packages)) {
    if (p === '') continue;
    assert.ok(e.version && e.resolved && e.integrity, p);
    assert.ok(!e.dev && !e.devOptional, p + ': в службе нет пакетов для разработки');
    for (const dep of Object.keys(e.dependencies || {})) {
      let dir = p;
      let found = false;
      for (;;) {
        if (has(dir + '/node_modules/' + dep)) { found = true; break; }
        const i = dir.lastIndexOf('/node_modules/');
        if (i < 0) break;
        dir = dir.slice(0, i);
      }
      assert.ok(found || has('node_modules/' + dep) || (e.optionalDependencies && dep in e.optionalDependencies), p + ' → ' + dep);
    }
  }
});
