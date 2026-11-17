// WAIT_REG_V1 (ревью M6) — «Ждут регистрации» НА БОЛЬШОЙ БАЗЕ: планы запросов держатся и после
// ANALYZE, а пакетный шаг A (stepALinesForDay) даёт ровно то, что stepALines по каждому пациенту.
//
// Ревью измерило на 70 000 пациентах и 3000 визитах в день ~330 мс на вызов (шаг A по пациенту: N+1),
// а после ANALYZE — 10,5 с: статистика crm_request_services.visit_id (почти все строки заявок без
// визита) уводила планировщик в обход всех строк заявок на каждую строку визита. Время здесь не
// меряется (оно зависит от машины; цифры — в отчёте и в скрипте замера) — проверяется ПЛАН: строки дня
// по индексу дня, признаки визитов по индексу visit_id, строки заявок дня по индексу даты, без SCAN
// больших таблиц, на пустой статистике и после ANALYZE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { waitingQueryPlans, registrarWaiting } from './registrar-waiting.js';
import { stepALines, stepALinesForDay } from '../crm/visit-link.js';
import { dayVisitOf } from './visits.js';

const pad = (n) => String(n).padStart(2, '0');
const localDay = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (dayIso, hh, mm = 0) => { const [y, m, d] = dayIso.split('-').map(Number); return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString(); };
const TODAY = localDay(0);
const reg = { id: 2, role: 'registrar', extra_roles: [] };

/** База «как у большой клиники», уменьшенная: история, сегодняшние визиты, много строк заявок без визита. */
function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2,'reg','x','Рег','registrar',0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (3,'cc','x','КЦ','callcenter',0)").run();
  for (let d = 10; d < 16; d++) db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,'x',?,'doctor',1)").run(d, 'doc' + d, 'Врач ' + d);
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (30,'Консультация',100000,'consultation',1,30)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  let rnd = 7;
  const r = (n) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd % n; };
  db.transaction(() => {
    const p = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
    for (let i = 1; i <= 3000; i++) p.run(i, 'Пациент ' + i, '+998 90 ' + String(i).padStart(7, '0'));
    const vIns = db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, booked_at) VALUES (?,?,?,?,?,?)');
    const lIns = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, scheduled_at) VALUES (?,?,?,1,100000,100000,?,?,?)");
    for (let back = 60; back >= 1; back--) {
      const day = localDay(-back);
      for (let k = 0; k < 60; k++) {
        const vid = Number(vIns.run(1 + r(3000), 10 + r(6), at(day, 9 + r(8)), 'arrived', 2, at(day, 7)).lastInsertRowid);
        lIns.run(vid, 30, 10 + r(6), 'completed', 2, at(day, 10));
      }
    }
    const statuses = ['scheduled', 'confirmed', 'arrived', 'cancelled'];
    for (let k = 0; k < 300; k++) {
      const vid = Number(vIns.run(1 + r(3000), 10 + r(6), at(TODAY, 8 + r(10), r(60)), statuses[r(4)], k % 3 ? 2 : 3, at(TODAY, 7)).lastInsertRowid);
      lIns.run(vid, 30, 10 + r(6), 'added', k % 3 ? 2 : 3, at(TODAY, 9 + r(8)));
      if (k % 2) lIns.run(vid, 40, null, 'added', 10 + r(6), at(TODAY, 0));
    }
    const lead = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид', '+998', ?, ?)");
    const line = db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, 40, ?, 'pending')");
    for (let k = 0; k < 6000; k++) {
      const rid = Number(lead.run(k % 50 === 0 ? 'came' : 'in_process', 1 + r(3000)).lastInsertRowid);
      line.run(rid, k % 40 === 0 ? TODAY : localDay(r(200) - 100));
    }
  })();
  return db;
}

const hasScanOf = (plan, table) => plan.some((d) => new RegExp('^SCAN ' + table + '\\b').test(d));

for (const analyze of [false, true]) {
  test(`WAIT_REG_V1 (ревью M6): планы списка держат индексы ${analyze ? 'после ANALYZE' : 'на пустой статистике'}`, () => {
    const db = seeded();
    try {
      if (analyze) db.exec('ANALYZE');
      const ids = db.prepare("SELECT id FROM visits ORDER BY id DESC LIMIT 50").all().map((x) => x.id);
      const p = waitingQueryPlans(db, { visitIds: ids });
      assert.ok(p.lines.some((d) => /idx_visits_date/.test(d)), 'строки дня не по индексу дня: ' + p.lines.join(' | '));
      assert.ok(p.bare.some((d) => /idx_visits_date/.test(d)), 'записи без услуги не по индексу дня: ' + p.bare.join(' | '));
      assert.ok(p.facts.some((d) => /idx_crm_req_services_visit/.test(d)), 'признак записи CRM не по индексу visit_id: ' + p.facts.join(' | '));
      assert.ok(p.wishes.some((d) => /idx_crm_req_services_date/.test(d)), 'строки заявок дня не по индексу даты: ' + p.wishes.join(' | '));
      for (const [name, plan] of Object.entries(p)) {
        for (const t of ['crm_request_services', 'cl', 'l', 'visits', 'v', 'visit_services', 'vs']) {
          assert.equal(hasScanOf(plan, t), false, `${name}: обход ${t}: ${plan.join(' | ')}`);
        }
      }
      // И сам список отвечает (count_only — то же число).
      const full = registrarWaiting(db, {}, reg);
      assert.equal(registrarWaiting(db, { count_only: true }, reg).count, full.count);
    } finally { db.close(); }
  });
}

test('WAIT_REG_V1 (ревью M6): пакетный шаг A = stepALines по каждому пациенту (визит дня, держащая строка, мёртвый визит, отменённая запись дня, телефон, проигрышная карточка, другой день)', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2,'reg','x','Рег','registrar',0)").run();
    db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1), (41,'Анализ мочи',30000,'lab',1)").run();
    for (let i = 1; i <= 9; i++) db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(i, 'П' + i);
    const lead = (pid, status = 'in_process') => Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид', '', ?, ?)").run(status, pid).lastInsertRowid);
    const line = (rid, { svc = 40, day = TODAY, visit = null, vs = null } = {}) => Number(db.prepare(`INSERT INTO crm_request_services
      (request_id, service_id, scheduled_date, status, visit_id, visit_service_id) VALUES (?, ?, ?, 'pending', ?, ?)`).run(rid, svc, day, visit, vs).lastInsertRowid);
    const visit = (pid, status = 'scheduled', day = TODAY) => Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, ?, ?, 2)").run(pid, at(day, 10), status).lastInsertRowid);
    const vline = (vid) => Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 40000, 40000, 'added')").run(vid).lastInsertRowid);
    line(lead(1));                                           // 1: желание без визита
    const v2 = visit(2); line(lead(2), { visit: v2 });       // 2: держит визит дня без строки
    const v3 = visit(3); line(lead(3), { visit: v3, vs: vline(v3) });   // 3: уже в визите — не берётся
    const v4 = visit(4, 'no_show'); line(lead(4), { visit: v4 });       // 4: мёртвый визит — берётся
    const v5 = visit(5, 'cancelled'); line(lead(5), { visit: v5 });     // 5: строка отменённой записи того же дня — нет
    const v6 = visit(6); const r6 = lead(6); line(r6);       // 6: карточка по телефону визита дня — нет
    db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'phone')").run(v6, r6);
    line(lead(7, 'stopped'));                                // 7: проигрышная карточка — нет
    line(lead(8), { day: localDay(1) });                     // 8: другой день — нет
    const r9 = lead(9, 'came'); line(r9); line(r9, { svc: 41, day: null });   // 9: конверсия — строка дня да, без даты — нет
    const batch = stepALinesForDay(db, TODAY).map((l) => [l.patient_id, l.id]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const one = [];
    for (let pid = 1; pid <= 9; pid++) {
      const dv = dayVisitOf(db, pid, TODAY);
      for (const { lines } of stepALines(db, { patientId: pid, day: TODAY, visitId: dv ? dv.id : null, undated: false })) {
        for (const l of lines) one.push([pid, l.id]);
      }
    }
    one.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepEqual(batch, one);
    assert.deepEqual([...new Set(batch.map((x) => x[0]))], [1, 2, 4, 9], 'сам шаг A изменился: ' + JSON.stringify(batch));
  } finally { db.close(); }
});
