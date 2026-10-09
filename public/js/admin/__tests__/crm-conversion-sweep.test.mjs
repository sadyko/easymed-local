// CRM_UNIFY_V1 — ОБХОД «НЕ ПРИШЁЛ» В БРАУЗЕРЕ (views/crm.js load()) ПОСЛЕ СМЕНЫ
// «КОЛОНКИ КОНВЕРСИИ». Ревью задачи 4: перенос вида won оставлял карточки
// прежней «Пришёл» в колонке, ставшей открытой, и обход уносил историю
// конверсий в «Не пришёл» (по 500 за загрузку, без возврата).
//
// Теперь конвертированные карточки идут за ролью (services/crm/config.js
// saveCrmSettings). Настройки и сама карточка берутся из НАСТОЯЩЕГО серверного
// кода (saveConfig + crmConfig на базе в памяти), доска — настоящая crm.js.
//
// CRM_UNIFY_V1 (задача 5) — ОБНОВЛЕНО НАМЕРЕННО: обхода в браузере больше нет
// («Не пришёл» ставит сервер, services/crm/no-show.js — его тест проверяет и
// историю конверсии после смены колонки). Здесь остаётся сторож: доска при
// загрузке не пишет в карточки ничего, при любой конверсии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, mk, tick } from './crm-harness.mjs';
import { openDb } from '../../../../server/db/connection.js';
import { migrate } from '../../../../server/db/migrate.js';
import { saveConfig, saveStages, crmConfig } from '../../../../server/services/crm/config.js';

const { renderCrm } = await import('../views/crm.js');

/** Историческая, КОНВЕРТИРОВАННАЯ карточка: пациент пришёл 2025-05-01. Конфигурация и карточка — как их отдаёт сервер после setup. */
function serverState(setup) {
  const db = openDb(':memory:');
  migrate(db);
  const id = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, scheduled_date, created_at, updated_at)
                                VALUES ('Старый пациент', '998901112233', 'call', 'came', '2025-05-01', '2025-04-30T09:00:00Z', '2025-05-01T10:00:00Z')`)
    .run().lastInsertRowid);
  setup(db);
  const cfg = crmConfig(db);
  const card = db.prepare('SELECT id, status, source, full_name, phone, patient_id, scheduled_date, created_at FROM crm_requests WHERE id = ?').get(id);
  db.close();
  return { cfg, card };
}
async function boardSweep({ cfg, card }) {
  S.config = cfg; S.leads = [card]; CALLS.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'update');   // CRM_UNIFY_V1 — любая правка
}
/** CRM_UNIFY_V1 — доска не пишет в карточки вовсе: ни обхода, ни правки статуса истории. */
function assertNotSwept(writes, card) {
  assert.deepEqual(writes, [], 'доска при загрузке правит карточки (' + card.status + '): ' + JSON.stringify(writes));
}

test('без смены конверсии: карточка «Пришёл» не попадает под обход', async () => {
  const s = serverState(() => {});
  assert.equal(s.card.status, 'came');
  assertNotSwept(await boardSweep(s), s.card);
});

test('сидовая воронка, конверсия — «Подтверждён»: история переехала в неё и под обход не попадает', async () => {
  const s = serverState((db) => saveConfig(db, { settings: { won_stage: 'approved' } }));
  assert.equal(s.card.status, 'approved', 'конвертированная карточка не пошла за конверсией');
  assertNotSwept(await boardSweep(s), s.card);
});

test('воронка клиники, конверсия — «Успешно»: история переехала в неё и под обход не попадает', async () => {
  const st = (key, label, kind) => ({ key, label, color: '', kind, is_active: 1 });
  const s = serverState((db) => {
    saveStages(db, [
      st('in_process', 'Новый лид', 'open'), st('recall', 'Перезвонить', 'open'), st('dozhim', 'Дожим', 'open'),
      st('approved', 'Подтверждён (амбулатор)', 'open'), st('approved_in', 'Подтверждён (стационар)', 'open'),
      st('no_show', 'Не пришёл', 'lost'), st('uspeshno', 'Успешно', 'open'), st('came', 'Пришёл', 'won'),
      st('stopped', 'Отказ', 'lost'),
    ]);
    saveConfig(db, { settings: { won_stage: 'uspeshno' } });
  });
  assert.equal(s.card.status, 'uspeshno');
  assertNotSwept(await boardSweep(s), s.card);
});
