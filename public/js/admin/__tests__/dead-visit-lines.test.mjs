// LIVE_AUDIT_FIX_V1 (C7) — строки отменённого / несостоявшегося визита не
// живут в кабинете врача: пациента не будет, а очередь врача его показывала.
// (Доску очереди проверяет server/services/rpc/queue-board.test.js — там
// фильтр стоит в самом запросе сервера.)
//
// Кабинет (consultation.js) проверяется исходником: живого стенда у кабинета
// нет (модуль тянет печать, хранилище и карту пациента — см. соседние пины
// service-workspace-add.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../views/consultation.js', import.meta.url), 'utf8');

test('кабинет врача: визит спрашивается со статусом, отменённые и неявки отфильтрованы', () => {
  const fn = (SRC.match(/async function loadServices\(\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(fn, 'loadServices кабинета не найден');
  assert.match(fn, /visits\(visit_date, patient_id, status,/, 'статус визита не спрашивается');
  assert.match(fn, /!\['cancelled', 'no_show'\]\.includes\(r\.visits\?\.status\)/, 'строки отменённых визитов снова в кабинете');
});

test('подписи ступеней лаборатории есть на трёх языках', async () => {
  const { STRINGS } = await import('../i18n-strings.js');
  const ui = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  for (const [code, key] of [['collected', 'Sample collected'], ['resulted', 'Results entered']]) {
    assert.ok(ui.includes(code + ":") && ui.includes("text: '" + key + "'"), code + ' без подписи в STATUS_MAP');
    for (const lang of ['ru', 'uz', 'en']) assert.ok(STRINGS[key] && STRINGS[key][lang], key + ': нет ' + lang);
  }
});
