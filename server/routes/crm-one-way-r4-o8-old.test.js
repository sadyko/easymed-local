// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-o8-old.test.js» (scratchpad crm-link-review), перенесён в
// клон: разовое исправление O8 на базах, которые построил НАСТОЯЩИЙ прежний код (c20fb960^, сборщик ревью
// r4/old/server/routes/zz-old-build.test.js). Каждая база копируется во временный каталог (em-o8-*), проходит
// миграции ЭТОГО дерева (246, 248), исправление CRM_UNIFY_V1 и O8 (crmOneWayRepair) — и дальше её ведёт новое
// приложение. Решение контролёра по ревью r4 (п. 1, 5, 6): исправление НИЧЕГО не удаляет.
//
// Базы в репозиторий не входят (по 6 МБ): каталог задаёт CRM_O8_OLD_DB (old-A.db … old-D.db); нет каталога
// или файла — тест пропускается с причиной. Даты баз — дни их сборки: если сборка была не сегодня, все дни
// базы сдвигаются на разницу (визиты, строки карточек, карточки, следы), чтобы «через три дня» осталось им.
//   CRM_O8_OLD_DB=…/r4/olddb  node --test server/routes/crm-one-way-r4-o8-old.test.js
//   CRM_O8_OLD_DB=…/r4/v316db node --test server/routes/crm-one-way-r4-o8-old.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { USERS, localDay, at } from '../test-helpers/crm-unify-app.js';
import { calendarBook } from '../test-helpers/crm-link-all.js';
import { crmOneWayRepair } from '../services/crm/one-way-repair.js';
import { crmUnifyRepair } from '../services/crm/unify-repair.js';
import { localDate } from '../services/domain/day.js';

const OLD = process.env.CRM_O8_OLD_DB || '';
const D3 = localDay(3);
const missing = (name) => (!OLD ? 'CRM_O8_OLD_DB не задан (каталог старых баз ревью r4)'
  : (fs.existsSync(path.join(OLD, name + '.db')) ? false : `нет ${name}.db в ${OLD}`));

/** Дни базы — на разницу между днём сборки (визит 1 — «через три дня» сборки) и сегодняшним «через три дня». */
function shiftDays(db) {
  const v1 = db.prepare(`SELECT ${localDate('visit_date')} AS d FROM visits WHERE id = 1`).get();
  if (!v1 || !v1.d) return 0;
  const delta = Math.round((Date.parse(D3 + 'T00:00:00Z') - Date.parse(v1.d + 'T00:00:00Z')) / 86400000);
  if (!delta) return 0;
  const n = `'${delta >= 0 ? '+' : ''}${delta} days'`;
  db.transaction(() => {
    db.exec(`UPDATE visits SET visit_date = strftime('%Y-%m-%dT%H:%M:%fZ', visit_date, ${n})`);
    db.exec(`UPDATE crm_request_services SET scheduled_date = date(scheduled_date, ${n}) WHERE scheduled_date IS NOT NULL AND scheduled_date <> ''`);
    db.exec(`UPDATE crm_requests SET scheduled_date = date(scheduled_date, ${n}) WHERE scheduled_date IS NOT NULL AND scheduled_date <> ''`);
    try { db.exec(`UPDATE crm_booking_undo SET prev_scheduled_date = date(prev_scheduled_date, ${n}) WHERE prev_scheduled_date IS NOT NULL AND prev_scheduled_date <> ''`); } catch { /* */ }
  })();
  return delta;
}

async function upgrade(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-o8-'));
  const file = path.join(dir, name + '.db');
  fs.copyFileSync(path.join(OLD, name + '.db'), file);
  const db = openDb(file);
  migrate(db);
  const shifted = shiftDays(db);
  try { crmUnifyRepair(db); } catch { /* как server/index.js */ }
  const rowsBefore = db.prepare('SELECT COUNT(*) AS n FROM crm_request_services').get().n;
  const repair = crmOneWayRepair(db);
  const rowsAfter = db.prepare('SELECT COUNT(*) AS n FROM crm_request_services').get().n;
  const server = await new Promise((resolve) => { const s = createApp(db, { dataDir: licensedDataDir() }).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const [, login] of USERS) {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(login)) continue;
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: login, password: 'password1' }) });
    assert.equal(res.status, 200);
    cookies[login] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (p, who, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] }, body: JSON.stringify(body) });
    const text = await res.text(); let json = {}; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, text, json };
  };
  return {
    db, repair, shifted, rowsBefore, rowsAfter, rpc: (n, who, a) => call('/api/rpc/' + n, who, a), dbq: (who, d) => call('/api/db', who, d),
    close: () => new Promise((r) => server.close(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); r(); })),
  };
}
const lines = (t) => t.db.prepare('SELECT id, service_id, doctor_id, scheduled_date, status, visit_id, visit_service_id, released_from_visit_id, legacy_copy FROM crm_request_services ORDER BY id').all().map((x) => ({ ...x }));
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
async function billOf(t, vid) {
  const ids = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((r) => r.id);
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}
const nothingDeleted = (t) => {
  assert.equal(t.repair.failed, false, 'исправление упало');
  assert.equal(t.rowsAfter, t.rowsBefore, 'исправление удалило строки карточек');
  const log = t.db.prepare('SELECT COUNT(*) AS n FROM crm_one_way_repair_log').get().n;
  const decided = Object.values(t.repair.counts || {}).reduce((a, b) => a + b, 0);
  assert.equal(log, decided, 'не каждая строка, о которой принято решение, записана в журнал');
};
const say = (t, tag) => console.log(`${tag} (${path.basename(OLD)}${t.shifted ? `, дни +${t.shifted}` : ''}) repair:`, JSON.stringify(t.repair.counts), 'lines:', JSON.stringify(lines(t)));

test('CRM_ONE_WAY_V1 (повтор r4, O8-A): запись колл-центра в календаре на старой базе — строка записи карточки остаётся (R2), отмена после установки возвращает её без дня', { skip: missing('old-A') }, async () => {
  const t = await upgrade('old-A');
  try {
    say(t, 'O8-A');
    nothingDeleted(t);
    assert.equal(lines(t).length, 1, 'исправление удалило строку записи колл-центра');
    const c = await t.rpc('calendar_book', 'reg', { visit_id: 1, start: at(D3, 12), status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(lines(t).map((l) => [l.service_id, l.scheduled_date, l.visit_id]), [[30, null, null]]);
  } finally { await t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r4, O8-B): желание, записанное колл-центром и отменённое до установки (прежняя «голая» отмена оставила день), — после установки запись регистратуры того дня к другому врачу держит ОДНУ консультацию (M1)', { skip: missing('old-B') }, async () => {
  const t = await upgrade('old-B');
  try {
    say(t, 'O8-B');
    nothingDeleted(t);
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15, svc: 30, doctor: 11 });
    console.log('O8-B new visit lines:', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => [x.service_id, x.doctor_id]), [[30, 11]], 'отменённая консультация врача 10 села в запись к врачу 11');
    assert.equal(await billOf(t, v2), 100000);
  } finally { await t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r4, O8-C): консультация колл-центра в календаре, отменённая до установки (прежний «перенос»), — отпущенное желание; запись регистратуры того дня держит ОДНУ консультацию', { skip: missing('old-C') }, async () => {
  const t = await upgrade('old-C');
  try {
    say(t, 'O8-C');
    nothingDeleted(t);
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15, svc: 30, doctor: 11 });
    console.log('O8-C new visit lines:', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => [x.service_id, x.doctor_id]), [[30, 11]]);
    assert.equal(await billOf(t, v2), 100000);
  } finally { await t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r4, O8-D): оператор сохранил желание анализа через ~1 с после строки регистратуры, прежнее зеркало указало им на неё — строка оператора остаётся', { skip: missing('old-D') }, async () => {
  const t = await upgrade('old-D');
  try {
    say(t, 'O8-D');
    nothingDeleted(t);
    console.log('O8-D log:', JSON.stringify(t.db.prepare('SELECT line_id, action, detail FROM crm_one_way_repair_log ORDER BY id').all()));
    assert.ok(lines(t).some((l) => l.id === 3), 'исправление удалило желание оператора (строка 3)');
  } finally { await t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r4, O8-B2): те же данные — после установки запись регистратуры того дня только на анализ держит только анализ (M2)', { skip: missing('old-B') }, async () => {
  const t = await upgrade('old-B');
  try {
    nothingDeleted(t);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v2 = b.json.data.visit.id;
    const p = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: v2, service_id: 40, doctor_id: null, quantity: 1, unit_price: 40000, total: 40000, price_tier: 'primary', status: 'added' } });
    assert.equal(p.status, 200, p.text);
    console.log('O8-B2 analysis visit lines:', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => x.service_id), [40], 'призрачная консультация в записи на анализ');
    assert.equal(await billOf(t, v2), 40000);
  } finally { await t.close(); }
});
