// WALK_IN_BOOKING_V1 — РЕГИСТРАЦИЯ «ПРИШЁЛ СЕЙЧАС» ПРОВЕРЯЕТСЯ НАСТОЯЩИМ СЕРВЕРОМ.
//
// Модуль сам ничего не считает: он ведёт пациента и список строк «услуга + врач»
// по той же цепочке, что мастер визита, — ensure_visit → service_price_quote →
// visit_services → create_invoice_for_visit → issue_queue_numbers. Значит и
// проверять его заглушками нечего: заглушённый ответ подтвердит только то, что
// мы сами же и написали. Поэтому стенд, как у wizard-booking.test.mjs, пускает
// вызовы модуля через НАСТОЯЩИЙ реестр RPC, НАСТОЯЩИЙ компилятор /api/db и
// НАСТОЯЩУЮ SQLite в памяти, прошедшую миграции.
//
// Проверяется:
//   • две услуги с врачом: визит СЕГОДНЯ, строки с врачом и ценой каталога,
//     счёт на сумму, номера очереди на обе строки;
//   • повторный визит: цену берёт тариф второго визита, а не каталог, и слово
//     тарифа ложится В СТРОКУ — по нему касса пересчитывает сама;
//   • услуга требует врача, врача нет — отказ ДО первой записи в базу;
//   • сбой вставки строки — визит остаётся, счёта НЕТ, ошибка наружу;
//   • направление доезжает до самой записи визита.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальные глобалы браузера ───────────────────────────────────────────
// Модуль безоконный, но по дороге к нему грузятся i18n.js (ставит lang на
// documentElement при загрузке) и db-client.js (плашка схемы). Больше ничего
// от DOM здесь не нужно — на то он и headless.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {}, body: null, createElement: () => ({ style: {}, appendChild() {} }) };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: e.status || 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'select') {
        const rows = DB.prepare(sql).all(...params);
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
      }
      if (meta.op === 'insert') {
        // Та же отдача, что у настоящего маршрута (routes/db.js): строка
        // перечитывается по rowid колонками реестра — именно из неё экран
        // берёт id вставленной услуги.
        const info = DB.prepare(sql).run(...params);
        if (!meta.returning) return ok(null);
        const row = DB.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        if (meta.single === 'single') return ok(row);
        if (meta.single === 'maybe') return ok(row ?? null);
        return ok([row]);
      }
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      // DB_CONSTRAINT_ERRORS_V1 — нарушенное ограничение возвращается вызывающему
      // его же словами, как это делает настоящий маршрут.
      const code = e && e.code;
      if (String(code || '').startsWith('SQLITE_CONSTRAINT')) {
        return { ok: false, status: 409, json: async () => ({ error: { code: 'conflict', message: e.message } }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { registerWalkIn } = await import('../views/walk-in-booking.js');

// ─── посев ──────────────────────────────────────────────────────────────────
// Филиал «Main Branch» и строка branch_identity (буква счёта) приезжают самими
// миграциями — их здесь не заводят намеренно: номер счёта должен получаться так
// же, как у свежей установки клиники.
const CONSULT = 21;   // требует врача
const LAB = 22;       // лаборатория, врач не нужен
const TIERED = 23;    // услуга с ценой второго визита
const NEEDS_DOC = 24; // требует врача, врача в тесте не дадут
const DOCTOR = 7;
const PATIENT = 3;
const SOURCE = 5;

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
  // У врача есть своя ставка по консультации (процент, БЕЗ своей цены) — именно
  // так заведено большинство: доля считается, а цену берёт каталог.
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, service_rates) VALUES (?,'doc','x','Петров Пётр','doctor',1,'терапевт',?)")
    .run(DOCTOR, JSON.stringify([{ service_id: CONSULT, pct: 40 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (?, 'Иванов Иван')").run(PATIENT);
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (?, 'Сайт клиники')").run(SOURCE);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type) VALUES (?,'Консультация терапевта',100000,0,30,1,'consultation')").run(CONSULT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type, is_lab) VALUES (?,'Общий анализ крови',40000,0,15,0,'lab',1)").run(LAB);
  db.prepare("INSERT INTO services (id, name, price, price_secondary, secondary_days_from, tax_rate, duration_minutes, requires_doctor, type) VALUES (?,'Приём кардиолога',200000,60000,0,0,20,0,'consultation')").run(TIERED);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type) VALUES (?,'Приём невролога',150000,0,20,1,'consultation')").run(NEEDS_DOC);
  if (DB) DB.close();
  DB = db;
  return db;
}

const svc = (id) => DB.prepare('SELECT id, name, price, requires_doctor FROM services WHERE id = ?').get(id);
const one = (sql, ...p) => DB.prepare(sql).get(...p);
const all = (sql, ...p) => DB.prepare(sql).all(...p);
const countOf = (table) => one(`SELECT COUNT(*) c FROM ${table}`).c;

// ═══════════════════════════════════════════════════════════════════════════

test('ДВЕ УСЛУГИ С ВРАЧОМ: визит сегодня, строки с врачом и ценой, счёт на сумму, номера очереди', async () => {
  seed();
  const out = await registerWalkIn({
    patientId: PATIENT,
    lines: [
      { service: svc(CONSULT), doctorId: DOCTOR },
      { service: svc(LAB), doctorId: DOCTOR },
    ],
    createdBy: USER.id,
  });

  // ВИЗИТ: один, сегодняшний по МЕСТНОМУ дню клиники, амбулаторный.
  assert.equal(countOf('visits'), 1);
  const visit = one('SELECT * FROM visits WHERE id = ?', out.visit.id);
  assert.equal(visit.patient_id, PATIENT);
  assert.equal(visit.visit_type, 'outpatient');
  assert.equal(visit.doctor_id, DOCTOR);
  assert.equal(one("SELECT COUNT(*) c FROM visits WHERE date(visit_date,'localtime') = date('now','localtime')").c, 1);

  // СТРОКИ: врач, цена каталога, первый визит.
  const rows = all('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id', visit.id);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'added');
    assert.equal(r.quantity, 1);
    assert.equal(r.doctor_id, DOCTOR);
    assert.equal(r.price_tier, 'primary');
    assert.equal(r.created_by, USER.id);
  }
  assert.equal(rows[0].unit_price, 100000);
  assert.equal(rows[1].unit_price, 40000);
  assert.deepEqual(out.lines.map((l) => l.serviceId), [CONSULT, LAB]);
  assert.deepEqual(out.lines.map((l) => l.unitPrice), [100000, 40000]);
  assert.equal(out.quoteError, undefined);

  // СЧЁТ: один, на сумму строк, привязан к визиту, две позиции — и каждая
  // строка визита знает свою позицию (иначе касса её не найдёт).
  assert.equal(countOf('invoices'), 1);
  assert.equal(out.invoice.visit_id, visit.id);
  assert.equal(out.invoice.total_amount, 140000);
  assert.equal(out.invoice.subtotal, 140000);
  assert.equal(out.items.length, 2);
  assert.equal(one('SELECT COUNT(*) c FROM invoice_items WHERE invoice_id = ?', out.invoice.id).c, 2);
  assert.equal(one('SELECT COUNT(*) c FROM visit_services WHERE visit_id = ? AND invoice_item_id IS NOT NULL', visit.id).c, 2);

  // ОЧЕРЕДЬ: талон на каждую строку, и номер записан В САМУ СТРОКУ.
  assert.equal(out.queue.size, 2);
  assert.equal(out.queueError, undefined);
  for (const r of rows) {
    const ticket = out.queue.get(r.id);
    assert.ok(ticket, 'нет талона для строки ' + r.id);
    assert.ok(ticket.number >= 1);
    const after = one('SELECT queue_key, queue_no FROM visit_services WHERE id = ?', r.id);
    assert.equal(after.queue_key, ticket.queue_key);
    assert.equal(after.queue_no, ticket.number);
  }
  // Консультация встаёт в линию врача, забор крови — в лабораторию: разные
  // двери, поэтому и ключи разные.
  assert.notEqual(out.queue.get(rows[0].id).queue_key, out.queue.get(rows[1].id).queue_key);
});

test('ПОВТОРНЫЙ ВИЗИТ: цена по тарифу второго визита, и слово тарифа — в строке', async () => {
  seed();
  // Вчерашний визит той же услуги для того же пациента: с него сервер и
  // считает окно второго визита (secondary_days_from = 0).
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  DB.prepare("INSERT INTO visits (id, patient_id, visit_date, visit_type, status) VALUES (90, ?, ?, 'outpatient', 'arrived')").run(PATIENT, yesterday);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (90, ?, 1, 200000, 200000, 'completed')").run(TIERED);

  const out = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(TIERED), doctorId: null }] });

  const row = one('SELECT * FROM visit_services WHERE visit_id = ?', out.visit.id);
  assert.equal(row.unit_price, 60000);
  assert.equal(row.total, 60000);
  assert.equal(row.price_tier, 'secondary');
  assert.equal(out.lines[0].tier, 'secondary');
  assert.equal(out.lines[0].unitPrice, 60000);
  // Касса пересчитывает по слову тарифа — и приходит к той же цене.
  assert.equal(out.invoice.total_amount, 60000);
});

test('ТОТ ЖЕ ДЕНЬ, ТА ЖЕ УСЛУГА: строка, уже лежащая на сегодняшнем визите, не делает новую «повторной»', async () => {
  seed();
  // Пациент уже приходил СЕГОДНЯ, и услуга с тарифом второго визита уже стоит
  // на этом визите. ensure_visit переиспользует визит дня, значит новая строка
  // ложится в ТОТ ЖЕ визит — а сам себе «предыдущим визитом» он быть не может:
  // иначе вторая услуга того же дня продавалась бы по цене повторного приёма,
  // которого не было. service_price_quote умеет исключать правимый визит —
  // спрашивать надо С НИМ.
  const todayIso = new Date().toISOString();
  DB.prepare("INSERT INTO visits (id, patient_id, visit_date, visit_type, status) VALUES (91, ?, ?, 'outpatient', 'arrived')").run(PATIENT, todayIso);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (91, ?, 1, 200000, 200000, 'added')").run(TIERED);

  const out = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(TIERED), doctorId: null }] });

  assert.equal(out.visit.id, 91, 'визит дня не переиспользован — тогда проверяется не то');
  assert.equal(out.lines[0].tier, 'primary', 'строка того же визита посчиталась предыдущим визитом');
  assert.equal(out.lines[0].unitPrice, 200000, 'цена уехала на тариф повторного приёма');
  assert.equal(out.quoteError, undefined);
  const row = one('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id DESC LIMIT 1', 91);
  assert.equal(row.price_tier, 'primary');
  assert.equal(row.unit_price, 200000);
});

test('УСЛУГА ТРЕБУЕТ ВРАЧА, ВРАЧА НЕТ: отказ ДО первой записи в базу', async () => {
  seed();
  await assert.rejects(
    () => registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(NEEDS_DOC), doctorId: null }] }),
    (e) => {
      assert.match(e.message, /Укажите врача для услуги/);
      assert.match(e.message, /Приём невролога/);
      return true;
    },
  );
  // Ни визита, ни строки, ни счёта: отказ не должен оставлять следов.
  assert.equal(countOf('visits'), 0);
  assert.equal(countOf('visit_services'), 0);
  assert.equal(countOf('invoices'), 0);
});

test('СБОЙ ВСТАВКИ СТРОКИ: визит остаётся без счёта, ошибка уходит наружу', async () => {
  seed();
  // Вторая строка ссылается на несуществующую услугу — внешний ключ её не
  // пропустит. Это настоящий отказ базы, а не подмена ответа.
  const ghost = { id: 999, price: 50000, name: 'Услуга-призрак', requires_doctor: 0 };
  await assert.rejects(
    () => registerWalkIn({
      patientId: PATIENT,
      lines: [{ service: svc(CONSULT), doctorId: DOCTOR }, { service: ghost, doctorId: null }],
    }),
    (e) => {
      assert.match(e.message, /Услуга-призрак/);
      return true;
    },
  );
  assert.equal(countOf('visits'), 1);          // визит заведён — пациент у стойки
  assert.equal(countOf('visit_services'), 1);  // прошла только первая строка
  assert.equal(countOf('invoices'), 0);        // счёта на половину визита не бывает
});

test('НАПРАВЛЕНИЕ: источник записывается в сам визит', async () => {
  seed();
  const out = await registerWalkIn({
    patientId: PATIENT,
    lines: [{ service: svc(LAB), doctorId: null }],
    referralSourceId: SOURCE,
  });
  assert.equal(one('SELECT referral_source_id r FROM visits WHERE id = ?', out.visit.id).r, SOURCE);
  assert.equal(out.visit.referral_source_id, SOURCE);
});
