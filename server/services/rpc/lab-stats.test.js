// LAB_STATS_V1 — «Статистика» лаборатории: СКОЛЬКО РАЗ панели и лабораторные
// услуги заказывались и сколько дошло до выдачи. Счётчики, НИКАКИХ денег:
// выручка живёт в «Отчётах» со своими правами, а этот экран видит каждый, у
// кого есть раздел Лаборатория — лаборант включительно.
//
// Правило двойного счёта (partition, не пересечение): заказ услуги, к которой
// привязана АКТИВНАЯ панель, считается ТОЛЬКО в блоке «Панели»; блок
// «Лабораторные услуги» получает лабораторные услуги БЕЗ активной панели.
// Одна строка visit_services попадает ровно в один блок.
//
// «Выполнено» = status='completed' — терминальное состояние машины статусов
// миграции 041 (проверено и ВЫДАНО пациенту). 'resulted' («Результаты
// внесены») выполненным не считается: результат ещё не проверен и пациенту
// не выдан.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { labUsageStats } from './lab-stats.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';

const admin     = { id: 1, role: 'admin' };
const lab       = { id: 2, role: 'lab' };
const doctor    = { id: 3, role: 'doctor' };
const nurse     = { id: 4, role: 'nurse' };
const registrar = { id: 5, role: 'registrar' };
const cashier   = { id: 6, role: 'cashier' };

// created_at хранится в UTC; экран и отчёты считают ЛОКАЛЬНЫЕ дни (CLINIC_DAY_V1).
// Фикстура кладёт строку на локальный день «сегодня минус N дней», конвертируя
// локальный полдень в UTC средствами самой SQLite — тест не зависит от пояса
// машины, на которой идёт прогон.
function utcAtLocalNoon(db, daysAgo) {
  return db.prepare(
    "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now','localtime', ?) || ' 12:00:00', 'utc') t"
  ).get('-' + daysAgo + ' days').t;
}

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'boss','x','Админ','admin')").run();
  const patient = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(patient).lastInsertRowid;

  // Услуга с АКТИВНОЙ панелью — считается в блоке «Панели». Цена задана
  // нарочно: тест «нет денег в ответе» должен проверять на непустых данных.
  const sPanel = db.prepare("INSERT INTO services (name, price, type) VALUES ('ОАК', 50000, 'lab')").run().lastInsertRowid;
  const panel = db.prepare("INSERT INTO lab_panels (name, code, service_id, active) VALUES ('Общий анализ крови', 'CBC', ?, 1)").run(sPanel).lastInsertRowid;

  // Лабораторная услуга БЕЗ панели — блок «Лабораторные услуги».
  const sBare = db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('Д-димер', 90000, 1)").run().lastInsertRowid;

  // НЕ лабораторная услуга — не должна появиться нигде.
  const sCons = db.prepare("INSERT INTO services (name, price, type) VALUES ('Приём терапевта', 70000, 'consultation')").run().lastInsertRowid;

  const addVs = (serviceId, status, daysAgo) => db.prepare(
    'INSERT INTO visit_services (visit_id, service_id, status, created_at) VALUES (?,?,?,?)'
  ).run(visit, serviceId, status, utcAtLocalNoon(db, daysAgo)).lastInsertRowid;

  return { db, visit, patient, sPanel, sBare, sCons, panel, addVs };
}

const panelRow = (res, name) => (res.panels || []).find((p) => p.name === name);
const serviceRow = (res, name) => (res.services || []).find((s) => s.name === name);

test('счётчики: панельная услуга — в «Панелях», безпанельная — в «Услугах», не-лабораторная — нигде', () => {
  const { db, sPanel, sBare, sCons, addVs } = seed();
  // Панельная услуга: 3 заказа, из них 1 выдан, 1 с внесёнными результатами.
  addVs(sPanel, 'completed', 1);
  addVs(sPanel, 'resulted', 2);
  addVs(sPanel, 'queued', 3);
  // Безпанельная лабораторная: 2 заказа, 1 выдан.
  addVs(sBare, 'completed', 1);
  addVs(sBare, 'added', 2);
  // Не-лаборатория: не должна появиться, сколько бы её ни заказывали.
  addVs(sCons, 'completed', 1);

  const res = labUsageStats(db, { period: '30d' }, lab);

  const p = panelRow(res, 'Общий анализ крови');
  assert.ok(p, 'панель в блоке «Панели»: ' + JSON.stringify(res.panels));
  assert.equal(p.ordered, 3, 'заказано считает ВСЕ статусы жизненного цикла');
  assert.equal(p.completed, 1, "выполнено = только status='completed' (выдан); 'resulted' ещё не выдан");

  const s = serviceRow(res, 'Д-димер');
  assert.ok(s, 'безпанельная лабораторная услуга в блоке «Услуги»');
  assert.equal(s.ordered, 2);
  assert.equal(s.completed, 1);

  // Правило двойного счёта: услуга с активной панелью НЕ повторяется в услугах.
  assert.equal(serviceRow(res, 'ОАК'), undefined, 'панельная услуга не дублируется в блоке услуг');
  // Не-лаборатория отсутствует в обоих блоках.
  assert.equal(serviceRow(res, 'Приём терапевта'), undefined);
  assert.ok(!(res.panels || []).some((x) => x.name === 'Приём терапевта'));
  db.close();
});

test('границы периода: 30d берёт ровно 30 локальных дней включая сегодня, today — только сегодня, all — всё', () => {
  const { db, sBare, addVs } = seed();
  addVs(sBare, 'completed', 0);    // сегодня
  addVs(sBare, 'queued', 29);      // ровно на границе окна 30 дней
  addVs(sBare, 'queued', 30);      // за границей — в 30d не входит
  addVs(sBare, 'queued', 6);       // граница окна 7 дней
  addVs(sBare, 'queued', 7);       // за границей 7 дней

  const d30 = serviceRow(labUsageStats(db, { period: '30d' }, lab), 'Д-димер');
  assert.equal(d30.ordered, 4, '30d: сегодня + день-29 входят, день-30 нет');

  const d7 = serviceRow(labUsageStats(db, { period: '7d' }, lab), 'Д-димер');
  assert.equal(d7.ordered, 2, '7d: сегодня + день-6 входят, день-7 нет');

  const dToday = serviceRow(labUsageStats(db, { period: 'today' }, lab), 'Д-димер');
  assert.equal(dToday.ordered, 1);
  assert.equal(dToday.completed, 1);

  const dAll = serviceRow(labUsageStats(db, { period: 'all' }, lab), 'Д-димер');
  assert.equal(dAll.ordered, 5);
  db.close();
});

test('period валидируется на сервере: пустой = 30d, чужое значение — 400', () => {
  const { db, sBare, addVs } = seed();
  addVs(sBare, 'queued', 40);   // за пределами 30 дней
  addVs(sBare, 'queued', 1);

  const byDefault = labUsageStats(db, {}, lab);
  assert.equal(byDefault.period, '30d', 'период по умолчанию — 30 дней');
  assert.equal(serviceRow(byDefault, 'Д-димер').ordered, 1);

  for (const bad of ['90d', 'week', 42, '', null]) {
    if (bad === null || bad === '') continue;   // пустое = умолчание, не ошибка
    assert.throws(() => labUsageStats(db, { period: bad }, lab), (e) => e.status === 400,
      'период ' + JSON.stringify(bad) + ' должен быть отвергнут');
  }
  db.close();
});

test('пустые блоки честно пустые, нулевые строки скрыты (услуга без заказов не перечисляется)', () => {
  const { db } = seed();
  const res = labUsageStats(db, { period: '30d' }, lab);
  assert.deepEqual(res.panels, [], 'ни одного заказа — блок панелей пуст');
  assert.deepEqual(res.services, [], 'и блок услуг пуст — нулевые строки не перечисляются');
  db.close();
});

test('сортировка по числу заказов по убыванию', () => {
  const { db, sBare, addVs } = seed();
  const sSecond = db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('Глюкоза', 30000, 1)").run().lastInsertRowid;
  addVs(sBare, 'queued', 1);
  addVs(sSecond, 'queued', 1);
  addVs(sSecond, 'queued', 2);

  const res = labUsageStats(db, { period: '30d' }, lab);
  assert.deepEqual(res.services.map((s) => s.name), ['Глюкоза', 'Д-димер'],
    'больше заказов — выше в списке');
  db.close();
});

test('неактивная панель не считается панелью: её лабораторная услуга уходит в блок услуг', () => {
  const { db, addVs } = seed();
  const sOld = db.prepare("INSERT INTO services (name, price, type) VALUES ('Коагулограмма', 40000, 'lab')").run().lastInsertRowid;
  db.prepare("INSERT INTO lab_panels (name, service_id, active) VALUES ('Старая панель', ?, 0)").run(sOld);
  addVs(sOld, 'queued', 1);

  const res = labUsageStats(db, { period: '30d' }, lab);
  assert.ok(!(res.panels || []).some((p) => p.name === 'Старая панель'), 'неактивная панель не в блоке панелей');
  assert.ok(serviceRow(res, 'Коагулограмма'), 'услуга сама по себе лабораторная (type=lab) — блок услуг её видит');
  db.close();
});

test('в ответе НЕТ денежных ключей — ни на одном уровне', () => {
  const { db, sPanel, sBare, addVs } = seed();
  addVs(sPanel, 'completed', 1);
  addVs(sBare, 'queued', 1);
  const res = labUsageStats(db, { period: 'all' }, lab);

  const MONEY = /price|amount|revenue|total|sum|cost|money|paid|fee|salar/i;
  const offending = [];
  (function scan(v, path) {
    if (Array.isArray(v)) { v.forEach((x, i) => scan(x, path + '[' + i + ']')); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (MONEY.test(k)) offending.push(path + '.' + k);
        scan(x, path + '.' + k);
      }
    }
  })(res, '$');
  assert.deepEqual(offending, [], 'счётчики без денег — выручка живёт в «Отчётах» со своими правами');
  assert.ok(res.panels.length && res.services.length, 'проверка шла по непустому ответу');
  db.close();
});

test('роль-гейт как у записей панелей: все четыре лабораторные роли проходят, остальные — 403', () => {
  const { db, sBare, addVs } = seed();
  addVs(sBare, 'queued', 1);
  for (const u of [admin, doctor, lab, nurse]) {
    const res = labUsageStats(db, { period: '30d' }, u);
    assert.ok(serviceRow(res, 'Д-димер'), u.role + ' держит раздел labs и должен читать статистику');
  }
  for (const u of [registrar, cashier, null]) {
    assert.throws(() => labUsageStats(db, { period: '30d' }, u), (e) => e.status === 403,
      (u ? u.role : 'аноним') + ' не держит раздел labs и должен быть отвергнут');
  }
  db.close();
});

// ---------------------------------------------------------------------------
// Настоящий HTTP: те же ворота через живой маршрут /api/rpc/lab_usage_stats —
// та же схема, что в lab-panels-role.test.js (порт 0, licensed fixture).
// ---------------------------------------------------------------------------
const LABS_ROLES = ['admin', 'doctor', 'lab', 'nurse'];
const NO_LABS_ROLES = ['registrar', 'cashier'];

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  for (const role of [...LABS_ROLES, ...NO_LABS_ROLES]) {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
      .run('u_' + role, hashPassword('password1'), 'Тест ' + role, role);
  }
  const sBare = db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('Ферритин', 80000, 1)").run().lastInsertRowid;
  const patient = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(patient).lastInsertRowid;
  db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?,?, 'completed')").run(visit, sBare);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, role) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'u_' + role, password: 'password1' }),
  });
  assert.equal(res.status, 200, `login as ${role} failed`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

test('по HTTP: четыре лабораторные роли читают статистику, регистратура и касса получают 403', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  for (const role of LABS_ROLES) {
    const res = await fetch(base + '/api/rpc/lab_usage_stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await login(base, role) },
      body: JSON.stringify({ period: 'all' }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, role + ' must read lab stats: ' + JSON.stringify(json));
    assert.equal(json.data.services[0].name, 'Ферритин', role + ' видит счётчики');
    assert.equal(json.data.services[0].ordered, 1);
    assert.equal(json.data.services[0].completed, 1);
  }

  for (const role of NO_LABS_ROLES) {
    const res = await fetch(base + '/api/rpc/lab_usage_stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await login(base, role) },
      body: JSON.stringify({ period: 'all' }),
    });
    assert.equal(res.status, 403, role + ' has no labs section and must stay refused');
  }
});
