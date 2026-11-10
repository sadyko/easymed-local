// CRM_LINKS_V1 / CRM_REAL_BOOKING_V1 — «ЧТО ЖДЁТ ЭТОГО ПАЦИЕНТА В ЭТОТ ДЕНЬ».
//
// Модуль crm-lines.js — единственное чтение строк заявки колл-центра на весь
// продукт: его зовут мастер визита и каталог услуг, и ради этого оно из них и
// вынуто (две копии уже расходились — у одной в выборке не было doctor_id, и
// услуга с requires_doctor не доходила до сметы).
//
// Здесь же прибито то, чего в модуле БОЛЬШЕ НЕТ. До 2026-09-21 рядом жило
// закрытие строк — closeCrmLines(lineIds, requestIds): строки → 'done',
// родитель → «Пришёл». Владелец: «Пришёл» значит, что пациент ФИЗИЧЕСКИ
// пришёл, и доказывает это событие, а не нажатие в окне. Закрытие целиком
// переехало на сервер (server/services/crm/visit-status.js), и экспорт обязан
// остаться удалённым: вернувшись, он станет ВТОРЫМ писателем одной таблицы, а
// два писателя дают заявке две разные истории — молча.
//
// CRM_DAY_LINES_V1 (3.23.0) — ПЕРЕПИСАНО НАМЕРЕННО. Чтение больше не идёт двумя запросами
// /api/db (там действует ограничение CRM по хозяину: карточку, взятую оператором «в работу», и
// карточку в «Не пришёл» регистратура не видела, а сервер их строки в визит сажал). Модуль
// спрашивает RPC crm_day_lines — правило шага связи сервера; выбор строк этого приёма и «одна
// услуга — одна строка» теперь общие (public/js/shared/crm-day-lines.test.js), а сервер
// проверен в server/routes/crm-day-lines.test.js.
//
// Стенд: настоящий модуль за фальшивым fetch. DOM не нужен вовсе.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CALLS = [];
let LINES = [];
let FAIL = false;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (data) => ({ ok: true, json: async () => ({ data }) });
  const bad = (message) => ({ ok: false, json: async () => ({ error: { message } }) });
  CALLS.push({ url: u, body });
  if (u.startsWith('/api/rpc/crm_day_lines')) return FAIL ? bad('строки не отданы') : ok(LINES);
  if (u.startsWith('/api/rpc/crm_config_get')) return ok({ stages: [], sources: [], routing: [] });
  return ok([]);
};

const mod = await import('../crm-lines.js');
const { pendingCrmLines } = mod;
const { stageKeysFrom } = await import('../crm-stages.js');

const DAY = '2026-10-05';
const lineOf = (over) => Object.assign(
  { id: 901, service_id: 10, consultation_type_id: null, scheduled_date: DAY, doctor_id: null, visit_id: null },
  over,
);
const reset = () => { CALLS.length = 0; FAIL = false; };
const dbCalls = () => CALLS.filter((c) => c.url === '/api/db');
const dayCalls = () => CALLS.filter((c) => c.url.startsWith('/api/rpc/crm_day_lines'));

test('закрытия строк в модуле больше нет — приход объявляет сервер', () => {
  assert.equal(mod.closeCrmLines, undefined,
    'closeCrmLines вернулся: экран снова объявляет заявку дошедшей по собственному нажатию, '
    + 'вторым писателем рядом с server/services/crm/visit-status.js');
  assert.equal(mod.closeCrmLinesForPatient, undefined, 'вернулось и закрытие «по пациенту и дню»');
  assert.deepEqual(Object.keys(mod).sort(), ['pendingCrmLines'],
    'у модуля появился новый экспорт — проверьте, не переехало ли закрытие обратно: ' + Object.keys(mod).join(', '));
});

test('CRM_DAY_LINES_V1: один вызов crm_day_lines с пациентом, днём и визитом — и ни одного /api/db', async () => {
  reset();
  LINES = [lineOf({ id: 901, doctor_id: 3, visit_id: 555 })];
  const out = await pendingCrmLines(7, DAY + 'T10:00:00Z', 555);
  assert.deepEqual(out, LINES, 'ответ сервера изменён по дороге');
  assert.deepEqual(dayCalls().map((c) => c.body), [{ patient_id: 7, day: DAY, visit_id: 555 }]);
  assert.deepEqual(dbCalls(), [], 'строки заявок снова читаются через /api/db — там ограничение по хозяину');
  // CRM_LINE_DOCTOR_V1 — без doctor_id услуга с requires_doctor не доходит до сметы;
  // CRM_REAL_BOOKING_V1 — без visit_id нельзя выбрать строки ЭТОГО приёма.
  assert.equal(out[0].doctor_id, 3);
  assert.equal(out[0].visit_id, 555);
});

test('визит не назван — уходит visit_id: null', async () => {
  reset();
  LINES = [];
  await pendingCrmLines(7, DAY);
  assert.deepEqual(dayCalls().map((c) => c.body), [{ patient_id: 7, day: DAY, visit_id: null }]);
});

test('без дня или пациента не спрашиваем ничего: сверять дату строки не с чем', async () => {
  reset();
  assert.deepEqual(await pendingCrmLines(7, ''), []);
  assert.deepEqual(await pendingCrmLines(null, DAY), []);
  assert.deepEqual(CALLS, [], 'ушёл запрос, на который нечем ответить');
});

// Пустая смета неотличима от «записей нет» — и именно это стоило трёх кругов
// отладки. Отказ обязан быть слышен, и обязан назвать, ЧТО отказало.
test('отказ сервера бросается и называет, что именно не ответило', async () => {
  reset();
  FAIL = true;
  await assert.rejects(() => pendingCrmLines(7, DAY), (e) => e.where === 'lines' && /строки не отданы/.test(e.message));
  reset();
});

// CRM_STAGE_ROLES_V1 — «Не пришёл» доски — колонка с ролью; сервер без ролей — прежняя догадка.
test('CRM_STAGE_ROLES_V1: stageKeysFrom — «Не пришёл» по роли колонки', () => {
  const stages = [
    { key: 'in_process', label: 'Новый', kind: 'open', position: 1, is_active: 1, role: null },
    { key: 'scheduled', label: 'Записан', kind: 'open', position: 2, is_active: 1, role: 'booked' },
    { key: 'came', label: 'Пришёл', kind: 'won', position: 3, is_active: 1, role: null },
    { key: 'no_show', label: 'Не пришёл', kind: 'lost', position: 4, is_active: 1, role: null },
    { key: 'gone', label: 'Не дошёл', kind: 'lost', position: 5, is_active: 1, role: 'no_show' },
  ];
  assert.equal(stageKeysFrom({ stages }).noShow, 'gone');
  assert.equal(stageKeysFrom({ stages: stages.map((s) => ({ ...s, role: null })) }).noShow, null, 'без роли «Не пришёл» колонки нет');
  assert.equal(stageKeysFrom({ stages: stages.map(({ role, ...s }) => s) }).noShow, 'no_show', 'сервер без ролей — сидовый ключ');
  assert.equal(stageKeysFrom(null).noShow, 'no_show', 'запасная воронка — роли миграции 284');
});
