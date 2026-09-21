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
// Стенд: настоящий модуль за фальшивым fetch. DOM не нужен вовсе — модуль о
// экранах не знает (в этом и был смысл его выделения).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CALLS = [];
let STAGES = { stages: [
  { key: 'in_process', label: 'В обработке', position: 1, is_active: 1, kind: 'open' },
  { key: 'scheduled',  label: 'Записан',     position: 2, is_active: 1, kind: 'open' },
  { key: 'came',       label: 'Пришёл',      position: 3, is_active: 1, kind: 'won' },
  { key: 'no_show',    label: 'Не пришёл',   position: 4, is_active: 1, kind: 'lost' },
], sources: [], routing: [] };
let REQUESTS = [{ id: 501 }];
let LINES = [];
let FAIL = null;   // 'requests' | 'lines' — пусть сервер откажет

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (data) => ({ ok: true, json: async () => ({ data }) });
  const bad = (message) => ({ ok: false, json: async () => ({ error: { message } }) });
  if (u.startsWith('/api/rpc/crm_config_get')) return ok(STAGES);
  if (u.startsWith('/api/rpc/')) return ok({});
  if (u === '/api/db') {
    CALLS.push(body);
    if (body.table === 'crm_requests') {
      return FAIL === 'requests' ? bad('заявки не отданы') : ok(REQUESTS);
    }
    if (body.table === 'crm_request_services') {
      return FAIL === 'lines' ? bad('строки не отданы') : ok(LINES);
    }
  }
  return ok([]);
};

const mod = await import('../crm-lines.js');
const { pendingCrmLines } = mod;
const { invalidateCrmStages } = await import('../crm-stages.js');

const DAY = '2026-10-05';
const lineOf = (over) => Object.assign(
  { id: 901, request_id: 501, service_id: 10, scheduled_date: DAY, status: 'pending', doctor_id: null, visit_id: null },
  over,
);
const reset = () => { CALLS.length = 0; FAIL = null; invalidateCrmStages(); };

test('закрытия строк в модуле больше нет — приход объявляет сервер', () => {
  assert.equal(mod.closeCrmLines, undefined,
    'closeCrmLines вернулся: экран снова объявляет заявку дошедшей по собственному нажатию, '
    + 'вторым писателем рядом с server/services/crm/visit-status.js');
  assert.equal(mod.closeCrmLinesForPatient, undefined, 'вернулось и закрытие «по пациенту и дню»');
  assert.deepEqual(Object.keys(mod).sort(), ['pendingCrmLines'],
    'у модуля появился новый экспорт — проверьте, не переехало ли закрытие обратно: ' + Object.keys(mod).join(', '));
});

test('спрашиваются ЖДУЩИЕ строки этого пациента именно на этот день', async () => {
  reset();
  LINES = [lineOf({})];
  const out = await pendingCrmLines(7, DAY);
  assert.equal(out.length, 1);

  const reqQ = CALLS.find((c) => c.table === 'crm_requests');
  assert.ok(reqQ, 'живые заявки пациента не спрошены вовсе');
  assert.deepEqual((reqQ.filters || []).find((f) => f.col === 'patient_id'), { col: 'patient_id', op: 'eq', val: 7 });

  const lineQ = CALLS.find((c) => c.table === 'crm_request_services');
  assert.ok(lineQ, 'строки заявок не спрошены');
  assert.deepEqual((lineQ.filters || []).find((f) => f.col === 'scheduled_date'), { col: 'scheduled_date', op: 'eq', val: DAY });
  assert.deepEqual((lineQ.filters || []).find((f) => f.col === 'status'), { col: 'status', op: 'eq', val: 'pending' });
  // CRM_LINE_DOCTOR_V1 — без doctor_id услуга с requires_doctor не доходит до
  // сметы; CRM_REAL_BOOKING_V1 — без visit_id нельзя выбрать строки ЭТОГО приёма.
  assert.ok(String(lineQ.columns).includes('doctor_id'), 'из выборки пропал врач строки');
  assert.ok(String(lineQ.columns).includes('visit_id'), 'из выборки пропал визит строки');
});

test('без дня не спрашиваем ничего: сверять дату строки не с чем', async () => {
  reset();
  LINES = [lineOf({})];
  assert.deepEqual(await pendingCrmLines(7, ''), []);
  assert.deepEqual(CALLS, [], 'ушёл запрос, на который нечем ответить');
});

// CRM_REAL_BOOKING_V1 — окно, открытое НА КОНКРЕТНОМ визите, подставляет строки
// ИМЕННО этого приёма. У пациента, записанного в один день к двум врачам, визит
// дня один, а строк две: вторая ждёт своей сметы, а не этой.
test('визит известен — берутся строки ЭТОГО приёма, а не весь день пациента', async () => {
  reset();
  LINES = [lineOf({ id: 901, visit_id: 555 }), lineOf({ id: 902, service_id: 11, visit_id: 777 })];
  const out = await pendingCrmLines(7, DAY, 555);
  assert.deepEqual(out.map((l) => l.id), [901],
    'в смету одного приёма подставились строки другого: пациент заплатит за услугу, которую ждёт в другом кабинете');
});

test('визит известен, но ни одна строка на него не ссылается — отдаём весь день', async () => {
  reset();
  LINES = [lineOf({ id: 901 }), lineOf({ id: 902, service_id: 11 })];
  const out = await pendingCrmLines(7, DAY, 555);
  assert.deepEqual(out.map((l) => l.id), [901, 902],
    'сузили до пустоты: строку, записанную без слота, регистратура не увидит никогда');
});

test('визит не назван — день целиком, как и было до слотов', async () => {
  reset();
  LINES = [lineOf({ id: 901, visit_id: 555 }), lineOf({ id: 902, service_id: 11, visit_id: 777 })];
  const out = await pendingCrmLines(7, DAY);
  assert.deepEqual(out.map((l) => l.id), [901, 902]);
});

// Пустая смета неотличима от «записей нет» — и именно это стоило трёх кругов
// отладки. Отказ обязан быть слышен, и обязан назвать, ЧТО отказало.
test('отказ сервера бросается и называет, что именно не ответило', async () => {
  reset();
  FAIL = 'requests';
  await assert.rejects(() => pendingCrmLines(7, DAY), (e) => e.where === 'requests');

  reset();
  FAIL = 'lines';
  await assert.rejects(() => pendingCrmLines(7, DAY), (e) => e.where === 'lines');
  reset();
});
