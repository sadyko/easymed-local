// BRANCH_SYNC_HOURLY_V1 — кто может нажать «Синхронизация» и что при этом
// происходит.
//
// Решение владельца 2026-09-02: кнопка появляется в окне регистратуры и
// лаборатории. Это люди без прав администратора, и делать их администраторами
// ради подтягивания данных соседнего филиала было бы куда хуже, чем открыть им
// одно безопасное действие.
//
// Действие безопасно не потому, что «ну, наверное»: ровно то же самое каждый
// час выполняют часы (schedule-pull.js) вообще без человека. Кнопка не даёт
// новых возможностей — она лишь избавляет от ожидания до следующего часа.
// Здесь это и закреплено, вместе с двумя границами: анонимный запрос всё-таки
// отклоняется, а повторное нажатие не превращается во второе скачивание
// справочника по узкому каналу.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { branchSyncNow, runBranchSync } from './branch-sync.js';

const dirs = [];
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsync-now-'));
  dirs.push(dir);
  setDataDir(dir);
  const db = openDb(':memory:');
  migrate(db);
  return { db, dir };
}
test.after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Синхронизация, которая ничего не нашла: pullCatalogue отвечает «нет связи».
// Этого достаточно — проверяется допуск и частота, а не применение справочника
// (оно покрыто catalogue.test.js и sync-e2e.test.js).
const offline = { pullImpl: async () => ({ ok: false, reason: 'offline' }),
                  relayImpl: async () => ({ ok: false, reason: 'offline' }) };

const REGISTRAR = { id: 7, role: 'registrar', roles: ['registrar'] };
const LABORANT = { id: 8, role: 'laborant', roles: ['laborant'] };

test('регистратура может запустить синхронизацию', async () => {
  const { db } = harness();
  const res = await branchSyncNow(db, {}, REGISTRAR, offline);
  // Важен не успех (сети в тесте нет), а отсутствие 403.
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'offline');
});

test('лаборатория может запустить синхронизацию', async () => {
  const { db } = harness();
  const res = await branchSyncNow(db, {}, LABORANT, offline);
  assert.equal(res.reason, 'offline', 'лаборанту не нужен админ, чтобы подтянуть данные');
});

test('анонимный запрос отклоняется', async () => {
  const { db } = harness();
  await assert.rejects(
    () => branchSyncNow(db, {}, null, offline),
    (e) => e.status === 401,
    'открыть всем вошедшим — не то же самое, что открыть всем');
});

test('два нажатия одновременно — одно скачивание и два ЧЕСТНЫХ ответа', async () => {
  const { db } = harness();
  let pulls = 0;
  const slow = {
    pullImpl: async () => {
      pulls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: false, reason: 'offline' };
    },
    relayImpl: async () => ({ ok: false, reason: 'offline' }),
  };

  // Регистратор и лаборант нажали почти одновременно.
  const [a, b] = await Promise.all([
    branchSyncNow(db, {}, REGISTRAR, slow),
    branchSyncNow(db, {}, LABORANT, slow),
  ]);

  assert.equal(pulls, 1, 'справочник по узкому каналу качается один раз');
  // И это ГЛАВНОЕ: оба видят настоящий результат, а не «подождите» и не чужой
  // прошлый ответ. Пауза с отдачей прошлого результата показывала бы второму
  // бодрое «обновлено» там, где его собственная попытка ничего бы не дала.
  assert.equal(a.reason, 'offline');
  assert.equal(b.reason, 'offline');
});

test('после завершения следующий запуск идёт в сеть заново', async () => {
  const { db } = harness();
  let pulls = 0;
  const counting = {
    pullImpl: async () => { pulls += 1; return { ok: false, reason: 'offline' }; },
    relayImpl: async () => ({ ok: false, reason: 'offline' }),
  };
  await branchSyncNow(db, {}, REGISTRAR, counting);
  await branchSyncNow(db, {}, REGISTRAR, counting);
  // Склейка — только на время полёта. Иначе починивший связь администратор
  // жал бы кнопку и получал старый отказ.
  assert.equal(pulls, 2, 'последовательные нажатия — настоящие попытки');
});
test('часам пользователь не нужен вообще', async () => {
  const { db } = harness();
  // runBranchSync — то, что вызывает scheduleBranchPull: без user, без прав.
  // Если однажды сюда вернут проверку прав, часы молча перестанут работать,
  // и заметит это владелец по устаревшим отчётам, а не тест.
  const res = await runBranchSync(db, offline);
  assert.equal(res.reason, 'offline');
});
