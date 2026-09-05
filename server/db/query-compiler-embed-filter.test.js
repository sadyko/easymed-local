// ═══════════════════════════════════════════════════════════════════════════
// EMBED_INNER_V1 + EMBED_FILTER_V1 (2026-09-05) — ФИЛЬТР ПО КОЛОНКЕ
// ПРИСОЕДИНЁННОЙ ТАБЛИЦЫ.
//
// ПОЧЕМУ ЭТО НЕ УКРАШЕНИЕ. В public/js/admin/branch-filter.js записано, как
// экран ограничивается «своим корпусом»: у rooms/beds/payments/invoice_items/
// visit_services своего branch_id нет, и филиал у них берётся через родителя —
// `.in('invoices.branch_id', ids)`, а вид обязан вклеить `invoices!inner(...)`.
// Компилятор не понимал НИ ТОГО, НИ ДРУГОГО: `!inner` не проходил регулярное
// выражение embed'а, а точка не проходила ни один allow-list. Значит, у каждого
// сотрудника, ограниченного филиалом, эти пять экранов отвечали 400 — а вид
// пишет `(data || [])` и рисует пустой список. «Ничего не найдено» вместо
// «сервер отказал»: ровно тот класс, ради которого заведён db-query-schema.
//
// Эти запросы СОБИРАЮТСЯ ВО ВРЕМЯ РАБОТЫ (branchScope дописывает условие к
// чужому запросу), поэтому в BASELINE того сторожа их нет и быть не могло —
// он читает исходный текст. Проверяются они здесь.
//
// ГЛАВНОЕ ПРАВИЛО ФАЙЛА — ДВЕ ДВЕРИ. Право фильтровать по `rel.col` требует
// обоих разрешений сразу: колонка должна быть в `columns` этой связи И в
// `filters` присоединённой таблицы. Реестр намеренно различает «видно» и «по
// чему можно искать»; фильтр через embed не должен становиться обходом этого
// различия.
// ═══════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { compile, CompileError } from './query-compiler.js';
import { REGISTRY } from './schema-registry.js';

const ADMIN = { role: 'admin', extra_roles: [] };
const fails = (desc, user = ADMIN) => {
  try { compile(desc, user); return null; }
  catch (e) { assert.ok(e instanceof CompileError, String(e)); return e; }
};
const sel = (table, columns, filters = []) => compile({ table, op: 'select', columns, filters }, ADMIN);

// Один мигрированный экземпляр на файл: запросы не только компилируются, но и
// ИСПОЛНЯЮТСЯ. Проверять только текст SQL — это та ошибка, из-за которой в
// компиляторе когда-то жил «ambiguous column name» (см. parseColumns).
const db = openDb(':memory:');
migrate(db);
const run = (q) => db.prepare(q.sql).all(...q.params);

// ─── `!inner` ───────────────────────────────────────────────────────────────
test('!inner делает соединение внутренним, !left — внешним, без модификатора — внешним', () => {
  assert.match(sel('visit_services', 'id, visits!inner(visit_date)').sql, /INNER JOIN "visits" AS "visits"/);
  assert.match(sel('visit_services', 'id, visits!left(visit_date)').sql, /LEFT JOIN "visits" AS "visits"/);
  assert.match(sel('visit_services', 'id, visits(visit_date)').sql, /LEFT JOIN "visits" AS "visits"/);
});

test('!inner не расширяет allow-list: несуществующая колонка внутри него всё так же отвергается', () => {
  // Модификатор меняет ВИД соединения, и только его. Если бы `!inner` заодно
  // ослаблял проверку колонок, он стал бы дырой в реестре.
  const e = fails({ table: 'visit_services', op: 'select', columns: 'id, visits!inner(unicorn)', filters: [] });
  assert.equal(e.message, 'unknown embed column');
  assert.equal(e.status, 400);
  const e2 = fails({ table: 'visit_services', op: 'select', columns: 'id, unicorns!inner(id)', filters: [] });
  assert.equal(e2.message, 'unknown embed');
  assert.equal(e2.status, 403);
});

test('!inner исполняется и действительно выбрасывает строки без родителя', () => {
  const d = openDb(':memory:');
  migrate(d);
  d.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'M1','Иванов И.')").run();
  d.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (10, 1, '2026-09-01', 'confirmed')").run();
  d.prepare("INSERT INTO services (id, name, price, type) VALUES (5, 'Приём', 100, 'consultation')").run();
  d.prepare("INSERT INTO products (id, name, unit) VALUES (7, 'Бинт', 'шт')").run();
  // Строка со списанным товаром и строка без него: clinic_item_id обнуляем —
  // это и есть «нет родителя».
  d.prepare('INSERT INTO visit_services (id, visit_id, service_id, clinic_item_id, quantity, unit_price, total) VALUES (100, 10, 5, 7, 1, 100, 100)').run();
  d.prepare('INSERT INTO visit_services (id, visit_id, service_id, clinic_item_id, quantity, unit_price, total) VALUES (101, 10, 5, NULL, 1, 100, 100)').run();

  const inner = compile({ table: 'visit_services', op: 'select', columns: 'id, products!inner(name)', filters: [] }, ADMIN);
  const left = compile({ table: 'visit_services', op: 'select', columns: 'id, products(name)', filters: [] }, ADMIN);
  assert.match(inner.sql, /INNER JOIN "products"/);
  assert.deepEqual(d.prepare(inner.sql).all(...inner.params).map((r) => r.id), [100]);
  assert.deepEqual(d.prepare(left.sql).all(...left.params).map((r) => r.id), [100, 101]);
});

// ─── точечные фильтры ───────────────────────────────────────────────────────
test('фильтр по колонке присоединённой таблицы компилируется в квалификатор этой таблицы', () => {
  const q = sel('visit_services', 'id, visits!inner(visit_date, patient_id)',
    [{ col: 'visits.patient_id', op: 'eq', val: 1 }]);
  assert.match(q.sql, /WHERE "visits"\."patient_id" = \?/);
  assert.deepEqual(q.params, [1]);
  assert.doesNotThrow(() => run(q));
});

test('соединение переиспользуется, а не добавляется вторым', () => {
  // Связь уже в проекции — фильтр обязан сесть на неё, иначе SQLite получил бы
  // два JOIN'а с одним псевдонимом и запрос упал бы уже на prepare().
  const q = sel('visit_services', 'id, visits!inner(visit_date)', [{ col: 'visits.visit_date', op: 'gte', val: '2026-01-01' }]);
  assert.equal((q.sql.match(/JOIN "visits"/g) || []).length, 1);
  assert.doesNotThrow(() => run(q));
});

test('связи нет в проекции — компилятор добавляет ВНУТРЕННЕЕ соединение сам', () => {
  // branchScope дописывает условие к чужому запросу и не может добавить embed в
  // его .select(). Условие на колонку родителя осмысленно только там, где
  // родитель есть, поэтому соединение именно внутреннее.
  const q = sel('payments', 'id, amount', [{ col: 'invoices.branch_id', op: 'in', val: [7] }]);
  assert.match(q.sql, /INNER JOIN "invoices" AS "invoices" ON "payments"\."invoice_id" = "invoices"\."id"/);
  assert.match(q.sql, /WHERE "invoices"\."branch_id" IN \(\?\)/);
  assert.doesNotThrow(() => run(q));
});

test('ДВЕ ДВЕРИ: колонка видна через связь, но не фильтруется у самой таблицы — отказ', () => {
  // invoice_items.embed.invoices отдаёт total_amount на ЧТЕНИЕ, но
  // invoices.filters его не содержит. Фильтр через embed не должен становиться
  // обходом различия «видно» / «по чему можно искать».
  assert.ok(REGISTRY.invoice_items.embed.invoices.columns.includes('total_amount'));
  assert.ok(!REGISTRY.invoices.filters.includes('total_amount'));
  const e = fails({ table: 'invoice_items', op: 'select', columns: 'id', filters: [{ col: 'invoices.total_amount', op: 'gt', val: 0 }] });
  assert.equal(e.message, 'unknown filter column');
  assert.equal(e.status, 400);
});

test('ДВЕ ДВЕРИ: колонка фильтруется у таблицы, но эта связь её не отдаёт — отказ', () => {
  assert.ok(REGISTRY.patients.filters.includes('phone'));
  assert.ok(!REGISTRY.invoice_items.embed.invoices.columns.includes('phone'));
  const e = fails({ table: 'invoice_items', op: 'select', columns: 'id', filters: [{ col: 'invoices.phone', op: 'eq', val: '998' }] });
  assert.equal(e.message, 'unknown filter column');
});

test('несуществующая связь в фильтре отвергается, а не подставляется в SQL', () => {
  const e = fails({ table: 'payments', op: 'select', columns: 'id', filters: [{ col: 'unicorns.id', op: 'eq', val: 1 }] });
  assert.equal(e.message, 'unknown filter column');
});

test('точечный фильтр не проходит в UPDATE и DELETE — они соединений не строят', () => {
  const upd = fails({ table: 'visit_services', op: 'update', values: { status: 'done' }, filters: [{ col: 'visits.patient_id', op: 'eq', val: 1 }] });
  assert.equal(upd.message, 'unknown filter column');
  const del = fails({ table: 'visit_services', op: 'delete', filters: [{ col: 'visits.patient_id', op: 'eq', val: 1 }] });
  assert.equal(del.message, 'unknown filter column');
});

test('.not() над точечной колонкой отрицает условие и добавляет ровно одно соединение', () => {
  const q = sel('payments', 'id', [{ col: 'invoices.status', op: 'not.eq', val: 'void' }]);
  assert.equal((q.sql.match(/JOIN "invoices"/g) || []).length, 1);
  assert.match(q.sql, /WHERE NOT \("invoices"\."status" = \?\)/);
  assert.doesNotThrow(() => run(q));
});

// ─── ФИЛИАЛ: то, ради чего всё это ──────────────────────────────────────────
test('branch-filter: каждый embed-путь из BRANCH_PATHS теперь компилируется, а не отвечает 400', () => {
  // Пути взяты из public/js/admin/branch-filter.js (BRANCH_PATHS, kind:'embed').
  // Это ЕДИНСТВЕННЫЙ способ ограничить эти пять экранов филиалом, и до
  // EMBED_FILTER_V1 каждый из них отвечал 400 сотруднику, привязанному к зданию.
  const paths = [
    ['rooms', 'floors', 'branch_id'],
    ['beds', 'wards', 'branch_id'],
    ['payments', 'invoices', 'branch_id'],
    ['invoice_items', 'invoices', 'branch_id'],
    ['visit_services', 'visits', 'branch_id'],
  ];
  for (const [table, rel, col] of paths) {
    const q = sel(table, 'id', [{ col: `${rel}.${col}`, op: 'in', val: [1, 2] }]);
    assert.doesNotThrow(() => run(q), `${table} -> ${rel}.${col}`);
  }
});

test('филиала нет в локальной схеме — условие ОТБРАСЫВАЕТСЯ, а не роняет запрос', () => {
  // floors и wards здесь не привязаны к зданию (колонки branch_id у них нет).
  // Это тот же случай, что TENANCY_NOOP_V1: сотрудник филиала должен увидеть
  // список целиком, а не пустой экран из-за 400.
  const cols = (t) => db.prepare(`PRAGMA table_xinfo("${t}")`).all().map((c) => c.name);
  for (const t of ['floors', 'wards']) assert.ok(!cols(t).includes('branch_id'), t);
  for (const [table, rel] of [['rooms', 'floors'], ['beds', 'wards']]) {
    const q = sel(table, 'id', [{ col: `${rel}.branch_id`, op: 'in', val: [1, 2] }]);
    assert.ok(!q.sql.includes('WHERE'), `${table}: условие должно быть отброшено — ${q.sql}`);
    assert.ok(!q.sql.includes('JOIN'), `${table}: отброшенное условие не должно тянуть соединение`);
  }
});

test('отбор по филиалу действительно отсекает чужой корпус, а не просто компилируется', () => {
  const d = openDb(':memory:');
  migrate(d);
  // Филиал 1 заводит сама миграция — добавляем только второй корпус.
  d.prepare("INSERT INTO branches (id, name) VALUES (2,'Корпус Б')").run();
  d.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'M1','Иванов И.')").run();
  d.prepare("INSERT INTO invoices (id, invoice_number, patient_id, branch_id, status) VALUES (1,'INV-1',1,1,'paid'),(2,'INV-2',1,2,'paid')").run();
  d.prepare("INSERT INTO payments (id, invoice_id, amount, method) VALUES (10,1,500,'cash'),(11,2,700,'cash')").run();

  const q = compile({ table: 'payments', op: 'select', columns: 'id, amount', filters: [{ col: 'invoices.branch_id', op: 'in', val: [1] }] }, ADMIN);
  assert.deepEqual(d.prepare(q.sql).all(...q.params), [{ id: 10, amount: 500 }]);
});

// ─── границы прав не сдвинулись ─────────────────────────────────────────────
test('новые связи не расширяют круг ролей: чужая роль по-прежнему получает 403', () => {
  // head_doctor — настоящая роль (INPATIENT_CARE_ROLES), но не из ALL_STAFF:
  // денежные таблицы ей не читаются, и связь к счёту этого не меняет.
  for (const table of ['payments', 'invoice_items', 'invoices']) {
    assert.ok(!REGISTRY[table].read.roles.includes('head_doctor'), table);
    const e = fails({ table, op: 'select', columns: 'id', filters: [] }, { role: 'head_doctor', extra_roles: [] });
    assert.equal(e.status, 403, table);
    assert.equal(e.message, 'not allowed', table);
    // и через фильтр по связи — тоже 403, а не «сначала присоединим, потом проверим»
    const e2 = fails({ table, op: 'select', columns: 'id', filters: [{ col: 'invoices.branch_id', op: 'in', val: [1] }] },
      { role: 'head_doctor', extra_roles: [] });
    assert.equal(e2.status, 403, table);
  }
});

test('связь не отдаёт колонку, которой сама таблица-цель не отдаёт', () => {
  // Инвариант для ВСЕГО реестра: embed — это проекция чужой таблицы, и он не
  // может показать больше, чем та отдаёт на чтение.
  for (const [table, entry] of Object.entries(REGISTRY)) {
    for (const [rel, emb] of Object.entries(entry.embed || {})) {
      const target = REGISTRY[emb.table];
      assert.ok(target, `${table}.${rel} -> ${emb.table} не зарегистрирована`);
      for (const c of emb.columns) {
        assert.ok(target.read.columns.includes(c), `${table}.${rel}: ${emb.table}.${c} не читается у самой таблицы`);
      }
    }
  }
});

test('добавленные связи не открывают таблицу тем, кто её не читает', () => {
  // Для связей, заведённых здесь (EMBED_FILTER_V1), проверяем сильное условие:
  // всякий, кто читает хозяина связи, читает и цель. Тогда embed ничего не
  // открывает — он лишь избавляет от второго запроса.
  //
  // ОГОВОРКА, ЧЕСТНО. По всему реестру это условие сегодня НЕ выполняется:
  // treatment_orders читают head_doctor и senior_nurse, а services — нет, и
  // название услуги приезжает им через связь. Это существующее решение чужих
  // таблиц, и трогать его здесь не место; новые связи под него не подпадают.
  const added = [
    ['payments', 'invoices'], ['invoice_items', 'invoices'], ['invoices', 'branches'],
    ['purchase_order_items', 'purchase_orders'], ['patients', 'created_by'],
    ['visit_services', 'created_by'], ['stock_movements', 'created_by'], ['visits', 'doctor_id'],
  ];
  for (const [table, rel] of added) {
    const emb = REGISTRY[table].embed[rel];
    assert.ok(emb, `${table}.${rel} не заведена`);
    for (const r of REGISTRY[table].read.roles) {
      assert.ok(REGISTRY[emb.table].read.roles.includes(r),
        `${table}.${rel}: роль ${r} читает ${table}, но не ${emb.table} — связь была бы обходом`);
    }
  }
});
