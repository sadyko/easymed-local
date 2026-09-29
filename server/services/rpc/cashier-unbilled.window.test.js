// REFBILL_REVIEW_V1 (2026-09-29) — ревью REFERRAL_BILL_V1, M1: «ЖДУТ СЧЁТА»
// НЕ ТОНЕТ В ЗАПИСЯХ, А ПАЦИЕНТ С НАПРАВЛЕНИЕМ НАХОДИТСЯ.
//
// Каждая запись колл-центра заводит невыставленные строки с ценой
// (booking_lines_add), а прошлые записи, которых никто не отметил «Не
// пришёл», висели вечно. Пробы ревьюера: 320 записей вперёд + 1 направление —
// список (первые 300) направления не содержал, а поиск кассы шёл в браузере по
// этим 300 — «Рахимов» не находился.
//
// Теперь:
//   • по умолчанию — СЕГОДНЯ и 30 дней назад; сначала сегодня, затем прошлые
//     дни от новых к старым (в дне — по самой свежей строке); будущие записи
//     по умолчанию не показываются — они придут в свой день;
//   • поиск (q) — НА СЕРВЕРЕ, по ФИО, телефону и номеру карты, за 30 дней
//     назад и все будущие дни; порядок: сегодня, будущие от ближних, прошлые
//     от новых;
//   • totals — число и сумма визитов своего охвата: без поиска это число
//     плашки «ЖДУТ СЧЁТА · N».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';

const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const cc = { id: 5, role: 'callcenter' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles) VALUES (1,'adm','x','admin','A',0,'[]'), (5,'cc','x','callcenter','Оператор',0,'[]'), (9,'cash','x','cashier','Кассир',0,'[]'), (20,'doc','x','doctor','Врач',1,'[]')").run();
  const CONS = Number(db.prepare("INSERT INTO services (name, price, type) VALUES ('Приём кардиолога', 150000, 'consultation')").run().lastInsertRowid);
  const LAB = Number(db.prepare("INSERT INTO services (name, price, type) VALUES ('Анализ', 40000, 'lab')").run().lastInsertRowid);
  return { db, CONS, LAB };
}
const at = (db, off, hh = '10:00') => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now','localtime', ?) || ' ' || ? || ':00', 'utc') t")
  .get(`${off >= 0 ? '+' : ''}${off} days`, hh).t;
function patient(db, name, extra = {}) {
  const cols = ['full_name', ...Object.keys(extra)];
  return Number(db.prepare(`INSERT INTO patients (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(name, ...Object.values(extra)).lastInsertRowid);
}
/**
 * Запись колл-центра: визит дня и его строка через booking_lines_add — как в
 * жизни. Прошедший день RPC уже не правит («Приём уже прошёл») — там строка
 * лежит такой, какой её оставила запись, никем не отмеченная «Не пришёл».
 */
function booking(db, CONS, pid, off) {
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (?, 20, ?, 'scheduled', 5)").run(pid, at(db, off)).lastInsertRowid);
  if (off >= 0) RPC.booking_lines_add(db, { visit_id: vid, patient_id: pid, lines: [{ service_id: CONS, doctor_id: 20 }] }, cc);
  else db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 20, 1, 150000, 150000, 'added', 5)").run(vid, CONS);
  return vid;
}
/** Направление врача сегодня: строка без счёта. */
function referral(db, LAB, pid, { off = 0, hh = '09:00' } = {}) {
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, ?, 'scheduled', 20)").run(pid, at(db, off, hh)).lastInsertRowid);
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 1, 40000, 40000, 'added', 20)").run(vid, LAB);
  return vid;
}
const unbilled = (db, args = {}) => RPC.cashier_unbilled(db, args, cashier);

test('M1 (probe-bookings): по умолчанию — сегодня и 30 дней назад; будущих записей нет; сначала сегодня, затем прошлые от новых', () => {
  const { db, CONS } = seed();
  const made = {};
  for (const off of [5, 12, 40, 0, -10, -3, -31]) made[off] = booking(db, CONS, patient(db, 'Записан на ' + off), off);
  const out = unbilled(db);
  assert.deepEqual(out.rows.map((r) => r.visit_id), [made[0], made[-3], made[-10]],
    'сегодня, 3 дня назад, 10 дней назад — будущие и старше 30 дней не показываются');
  assert.deepEqual(out.totals, { n: 3, sum: 450000 }, 'плашка считает только то, что в списке по умолчанию');
});

test('M1: в одном дне — по самой свежей строке; сегодня всегда выше вчерашнего, даже если вчерашнему добавили строку позже', () => {
  const { db, LAB } = seed();
  const yesterday = referral(db, LAB, patient(db, 'Вчерашний'), { off: -1 });
  const morning = referral(db, LAB, patient(db, 'Утренний'), { hh: '08:00' });
  const noon = referral(db, LAB, patient(db, 'Дневной'), { hh: '12:00' });
  const setAt = (vid, iso) => db.prepare('UPDATE visit_services SET created_at = ? WHERE visit_id = ?').run(iso, vid);
  setAt(morning, '2026-01-01T05:00:00Z');
  setAt(noon, '2026-01-01T04:00:00Z');
  setAt(yesterday, '2026-01-01T06:00:00Z');   // самая свежая строка — у вчерашнего визита
  assert.deepEqual(unbilled(db).rows.map((r) => r.visit_id), [morning, noon, yesterday]);
});

test('M1 (probe-cap): 320 невыставленных записей за месяц + направление сегодня — направление первым; поиск на сервере находит и того, кто за 300', () => {
  const { db, CONS, LAB } = seed();
  const rakhimov = patient(db, 'Рахимов Жасур', { phone: '+998 90 111-22-33', mrn: 'A-000015' });
  const ref = referral(db, LAB, rakhimov);
  const booked = [];
  db.transaction(() => {
    for (let i = 0; i < 320; i++) booked.push(booking(db, CONS, patient(db, 'Записан ' + i), -1 - (i % 29)));
  })();
  const out = unbilled(db);
  assert.equal(out.rows.length, 300, 'список — не больше 300 визитов');
  assert.equal(out.totals.n, 321, 'плашка — все ждущие окна');
  assert.equal(out.rows[0].visit_id, ref, 'направление сегодня — первым');
  for (const q of ['рахимов', 'РАХИМОВ ЖАС', 'a-000015', '901112233', '90 111 22 33', '+998 90 111-22-33']) {
    const found = unbilled(db, { q });
    assert.deepEqual(found.rows.map((r) => r.visit_id), [ref], 'поиск «' + q + '»');
    assert.deepEqual(found.totals, { n: 1, sum: 40000 });
    assert.equal(found.q, q.trim());
  }
  // Тот, кто в списке по умолчанию за 300-й строкой, находится поиском.
  const shown = new Set(out.rows.map((r) => r.visit_id));
  const hidden = booked.find((v) => !shown.has(v));
  assert.ok(hidden, 'посев не довёл список до обрезки');
  const name = db.prepare('SELECT p.full_name n FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?').get(hidden).n;
  assert.ok(unbilled(db, { q: name }).rows.some((r) => r.visit_id === hidden), 'визит за 300-й строкой не нашёлся поиском');
});

test('M1: поиск — и будущие дни; порядок: сегодня, будущие от ближних, прошлые от новых; старше 30 дней — нет', () => {
  const { db, CONS } = seed();
  const pid = patient(db, 'Каримова Нигора', { phone: '+998907776655', mrn: 'A-000016' });
  const v = {};
  for (const off of [-40, -5, 0, 3, 12, -1]) v[off] = booking(db, CONS, pid, off);
  assert.deepEqual(unbilled(db).rows.map((r) => r.visit_id), [v[0], v[-1], v[-5]], 'по умолчанию будущих нет');
  const found = unbilled(db, { q: 'каримова' });
  assert.deepEqual(found.rows.map((r) => r.visit_id), [v[0], v[3], v[12], v[-1], v[-5]]);
  assert.deepEqual(found.totals, { n: 5, sum: 750000 });
});

test('M1: строка поиска — текст до 200 знаков; % и _ — буквы, а не шаблон; пустая — список по умолчанию', () => {
  const { db, LAB } = seed();
  referral(db, LAB, patient(db, 'Иванов Иван'));
  referral(db, LAB, patient(db, 'Пётр_100%'));
  assert.equal(unbilled(db, { q: '%' }).rows.length, 1, '«%» нашёл всех');
  assert.equal(unbilled(db, { q: '_' }).rows.length, 1, '«_» нашёл всех');
  assert.equal(unbilled(db, { q: '   ' }).rows.length, 2, 'пустой поиск — список по умолчанию');
  assert.equal(unbilled(db, { q: '   ' }).q, null);
  for (const bad of [{ a: 1 }, ['x'], 'я'.repeat(201)]) {
    assert.throws(() => unbilled(db, { q: bad }), (e) => e.status === 400);
  }
});
