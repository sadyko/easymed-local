// CRM_BOOKINGS_TAB_V1 — «Записи CRM» НА БОЛЬШОЙ БАЗЕ И В СЕТИ ЗДАНИЙ.
//
// Новые чтения статусов «Оформлены» / «Не пришли» / «Отменены» (визиты периода, их строки, отменённые
// строки заявок, отпущенные стойкой анализы) держат индексы на пустой статистике и после ANALYZE —
// как планы «Ждут» (registrar-waiting-plan.test.js); время здесь не меряется (цифры — в отчёте и в
// скрипте замера). count_only при любых фильтрах — ровно число строк полного ответа. Правило здания
// (ревью M5) действует и на новые статусы: запись в чужое здание не видна у автора ни в одном статусе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmBookingsQueryPlans, registrarWaiting } from './registrar-waiting.js';
import { calendarBook } from './calendar.js';
import { exportCatalogue, applyCatalogue } from '../branch-sync/catalogue.js';
import { becomeSecondary } from '../branch-sync/identity.js';

const pad = (n) => String(n).padStart(2, '0');
const localDay = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (dayIso, hh, mm = 0) => { const [y, m, d] = dayIso.split('-').map(Number); return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString(); };
const TODAY = localDay(0);
const reg = { id: 2, role: 'registrar', extra_roles: [] };

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
    const statuses = ['scheduled', 'confirmed', 'arrived', 'cancelled', 'no_show'];
    for (let back = 30; back >= -6; back--) {
      const day = localDay(-back);
      for (let k = 0; k < (back === 0 ? 300 : 60); k++) {
        const st = back > 0 ? (k % 4 ? 'arrived' : statuses[r(5)]) : statuses[r(5)];
        const vid = Number(vIns.run(1 + r(3000), 10 + r(6), at(day, 8 + r(10), r(60)), st, k % 3 ? 2 : 3, at(day, 7)).lastInsertRowid);
        lIns.run(vid, 30, 10 + r(6), back > 0 && st === 'arrived' ? 'completed' : 'added', k % 3 ? 2 : 3, at(day, 9 + r(8)));
        if (k % 2) lIns.run(vid, 40, null, 'added', 10 + r(6), at(day, 0));
      }
    }
    const lead = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид', '+998', ?, ?)");
    const line = db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, 40, ?, ?)");
    for (let k = 0; k < 6000; k++) {
      const rid = Number(lead.run(k % 50 === 0 ? 'came' : 'in_process', 1 + r(3000)).lastInsertRowid);
      line.run(rid, k % 40 === 0 ? TODAY : localDay(r(200) - 100), k % 7 === 0 ? 'cancelled' : 'pending');
    }
    const log = db.prepare("INSERT INTO invoice_audit_log (visit_id, action, reason, notes, created_at) VALUES (?, ?, ?, ?, ?)");
    for (let k = 0; k < 4000; k++) log.run(k % 5 ? 1 + r(2000) : null, k % 9 ? 'invoice_created' : 'line_wish_released', 'x', 'Услуга «Анализ крови» заявки № ' + (1 + r(6000)) + ' снята', at(localDay(-r(40)), 10));
  })();
  return db;
}

const hasScanOf = (plan, table) => plan.some((d) => new RegExp('^SCAN ' + table + '\\b').test(d));
const FILTERS = [
  {}, { sources: ['crm'] }, { status: 'all' }, { status: 'registered' }, { status: 'no_show' }, { status: 'cancelled' },
  { from: TODAY, to: localDay(6) }, { from: TODAY, to: localDay(6), status: 'all' }, { day: localDay(-3), status: 'no_show' },
  { doctor_id: 12, status: 'all' }, { q: '90 000', status: 'all' }, { q: 'Пациент 1', from: localDay(-6), to: TODAY, status: 'all', sources: ['calendar', 'crm'] },
];

for (const analyze of [false, true]) {
  test(`CRM_BOOKINGS_TAB_V1: планы статусов держат индексы ${analyze ? 'после ANALYZE' : 'на пустой статистике'}; count_only = строки полного ответа`, () => {
    const db = seeded();
    try {
      if (analyze) db.exec('ANALYZE');
      const vids = db.prepare('SELECT id FROM visits ORDER BY id DESC LIMIT 50').all().map((x) => x.id);
      const p = crmBookingsQueryPlans(db, { visitIds: vids, from: TODAY, to: localDay(6) });
      assert.ok(p.settled.some((d) => /idx_visits_date/.test(d)), 'визиты периода не по индексу дня: ' + p.settled.join(' | '));
      assert.ok(p.settledLines.some((d) => /visit/.test(d) && /^SEARCH/.test(d)), 'строки визитов не по индексу визита: ' + p.settledLines.join(' | '));
      assert.ok(p.crmCancelled.some((d) => /idx_crm_req_services_date/.test(d)), 'отменённые строки заявок не по индексу даты: ' + p.crmCancelled.join(' | '));
      assert.ok(p.released.some((d) => /idx_invoice_audit_log_visit/.test(d)), 'журнал отпущенных не по индексу визита: ' + p.released.join(' | '));
      assert.ok(p.releasedNoVisit.some((d) => /idx_invoice_audit_log_visit/.test(d)), 'журнал без визита не по индексу: ' + p.releasedNoVisit.join(' | '));
      for (const [name, plan] of Object.entries(p)) {
        for (const t of ['crm_request_services', 'l', 'visits', 'v', 'visit_services', 'vs', 'invoice_audit_log', 'a', 'patients', 'pt']) {
          assert.equal(hasScanOf(plan, t), false, `${name}: обход ${t}: ${plan.join(' | ')}`);
        }
      }
      for (const f of FILTERS) {
        const full = registrarWaiting(db, f, reg);
        assert.equal(registrarWaiting(db, { ...f, count_only: true }, reg).count, full.rows.length, JSON.stringify(f));
        assert.equal(full.count, full.rows.length, JSON.stringify(f));
        const want = f.status || 'waiting';
        assert.ok(full.rows.every((r) => want === 'all' || r.status === want), 'статус строки не тот: ' + JSON.stringify(f));
        if (f.sources) assert.ok(full.rows.every((r) => r.sources.some((s) => f.sources.includes(s.kind))), 'источник строки не тот: ' + JSON.stringify(f));
      }
      // «Ждут» на сегодня — прежний ответ без фильтров.
      assert.deepEqual(registrarWaiting(db, { status: 'waiting', day: TODAY }, reg).rows, registrarWaiting(db, {}, reg).rows);
    } finally { db.close(); }
  });
}

// ─── сеть зданий (ревью M5): правило здания — и у новых статусов ───
const MINE = 'B';
function mainClinic() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE branches SET name = 'Главный корпус' WHERE letter = 'A'").run();
  db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Второй корпус', MINE);
  const aId = db.prepare("SELECT id FROM branches WHERE letter = 'A'").get().id;
  const bId = db.prepare('SELECT id FROM branches WHERE letter = ?').get(MINE).id;
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, working_hours, branch_id) VALUES ('doc','x','Петров П.П.','doctor',1,'',?)").run(bId);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, working_hours, branch_id) VALUES ('doc2','x','Каримов Р.','doctor',1,'',?)").run(aId);
  return db;
}
function branchB() {
  const db = openDb(':memory:');
  migrate(db);
  becomeSecondary(db, { letter: MINE, name: 'Второй корпус' });
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (7,'doc','x','Петров П.П.','doctor',1,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (8,'doc2','x','Каримов Р.','doctor',1,'')").run();
  for (const [id, name] of [[3, 'Иванов Иван'], [4, 'Сидорова Мария'], [5, 'Каримова Нигора'], [6, 'Свой Олег']]) {
    db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(id, name);
  }
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, code) VALUES (21,'Консультация',100000,30,'C-21')").run();
  const main = mainClinic();
  db.transaction(() => applyCatalogue(db, exportCatalogue(main)))();
  main.close();
  return db;
}
function foreignBooking(db, { uid, patient, doctor, hour, status = 'scheduled' }) {
  const vid = Number(db.prepare(`INSERT INTO visits (uid, sync_origin, patient_id, doctor_id, visit_date, duration_minutes, status, booked_at)
                                 VALUES (?, 'A', ?, ?, ?, 30, ?, ?)`).run(uid, patient, doctor, at(TODAY, hour), status, at(TODAY, 8)).lastInsertRowid);
  db.prepare(`INSERT INTO visit_services (uid, sync_origin, visit_id, service_id, quantity, unit_price, total, status)
              VALUES (?, 'A', ?, 21, 1, 100000, 100000, 'added')`).run(uid + '-l', vid);
  return vid;
}

test('CRM_BOOKINGS_TAB_V1 (ревью M5): здание приёма — и в «Не пришли», «Отменены», «Все»; запись в чужое здание у автора не видна ни в одном статусе', async () => {
  const db = branchB();
  try {
    const registrar = { id: 1, role: 'registrar', extra_roles: [] };
    const out = await calendarBook(db, { patient_id: 3, doctor_id: 8, service_id: 21, start: at(TODAY, 13), duration_minutes: 30 }, registrar,
      { publishImpl: async () => ({ ok: true }), dataDir: '/tmp/none' });
    assert.equal(out.visit.cross_branch, 'A', 'подготовка: запись не помечена зданием приёма');
    db.prepare("UPDATE visits SET status = 'no_show' WHERE id = ?").run(out.visit.id);
    const own = await calendarBook(db, { patient_id: 6, doctor_id: 7, service_id: 21, start: at(TODAY, 11), duration_minutes: 30 }, registrar,
      { publishImpl: async () => ({ ok: true }), dataDir: '/tmp/none' });
    db.prepare("UPDATE visits SET status = 'no_show' WHERE id = ?").run(own.visit.id);
    foreignBooking(db, { uid: 'uid-a-for-b', patient: 4, doctor: 7, hour: 15, status: 'cancelled' });   // к нашему врачу — наша
    foreignBooking(db, { uid: 'uid-a-for-a', patient: 5, doctor: 8, hour: 16, status: 'cancelled' });   // к их врачу — их
    const all = registrarWaiting(db, { status: 'all' }, registrar);
    assert.deepEqual(all.rows.map((r) => [r.patient_id, r.status]).sort((a, b) => a[0] - b[0]), [[4, 'cancelled'], [6, 'no_show']],
      'здание приёма: ' + JSON.stringify(all.rows.map((r) => [r.patient_id, r.status])));
    assert.equal(registrarWaiting(db, { status: 'all', count_only: true }, registrar).count, 2);
  } finally { db.close(); }
});
