// CRM_UNIFY_V1 — «НЕ ПРИШЁЛ» СТАВИТ СЕРВЕР (Р11): запись прошла, визит не начат,
// не оплачен, не отмечен. Обход в браузере удалён: он не видел оплаты, уносил
// «Перезвонить» с прошедшей датой звонка и пропускал записи календаря без строк.
//
// Правило проверяется на настоящей базе (все миграции), без сервера: проход
// зовут при запуске и раз в час (server/index.js), людей у него нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { saveConfig } from './config.js';
import { crmVisitStatus } from './visit-status.js';
import { crmNoShowSweep, scheduleCrmNoShow } from './no-show.js';

const pad = (n) => String(n).padStart(2, '0');
/** Местный день со сдвигом: 'YYYY-MM-DD'. */
const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Местное время дня → ISO (UTC): визит в 10:00 по местному. */
const at = (ymd, hh = 10) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, hh, 0, 0, 0).toISOString(); };
const Y = day(-1), Y2 = day(-2), T0 = day(0), T = day(1);
const OLD = '2026-01-01T00:00:00Z';

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  return db;
}
const visit = (db, d, { status = 'scheduled', patient = 1, origin = null } = {}) =>
  Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (?, ?, ?, ?)').run(patient, at(d), status, origin).lastInsertRowid);
const lead = (db, { status = 'scheduled', date = null, patient = 1 } = {}) => {
  const id = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES ('Л','998900000000',?,?,?)")
    .run(status, patient, date).lastInsertRowid);
  db.prepare('UPDATE crm_requests SET updated_at = ?, created_at = ? WHERE id = ?').run(OLD, OLD, id);
  return id;
};
const line = (db, rid, vid, d, status = 'pending') => Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id)
                                                                        VALUES (?, 40, ?, ?, ?)`).run(rid, d, status, vid).lastInsertRowid);
const link = (db, vid, rid) => db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
const st = (db, id) => db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(id).status;
const invoice = (db, vid, { paid = 0, status = 'unpaid', payer = null } = {}) =>
  Number(db.prepare('INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status, payer_id) VALUES (?, 1, 1000, ?, ?, ?)')
    .run(vid, paid, status, payer).lastInsertRowid);
const paid = (db, vid) => {
  const inv = invoice(db, vid, { paid: 1000, status: 'paid' });
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, 1000, 'cash')").run(inv);
};
const sorted = (a) => [...a].sort((x, y) => x - y);

// ─── КАРТОЧКА С ЗАПИСЬЮ ───────────────────────────────────────────────────

test('запись вчера, ни отметки, ни денег, ни работы — «Не пришёл»; визит и строки не меняются', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); const lid = line(db, rid, vid, Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  assert.equal(st(db, rid), 'no_show');
  assert.ok(db.prepare('SELECT updated_at FROM crm_requests WHERE id = ?').get(rid).updated_at > OLD, 'серверный переход не отмечен движением карточки');
  assert.equal(db.prepare('SELECT status FROM visits WHERE id = ?').get(vid).status, 'scheduled', 'статус визита изменён');
  assert.deepEqual(db.prepare('SELECT status, visit_id FROM crm_request_services WHERE id = ?').get(lid), { status: 'pending', visit_id: vid },
    'неявка стёрла строку заявки');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
});

test('оплативший вчера — не «Не пришёл» (ошибка, которую делал обход в браузере)', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y); paid(db, vid);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.equal(st(db, rid), 'scheduled');
});

test('долг у кассы и счёт по акту — тоже доказательство: человек стоял у окна', () => {
  for (const inv of [{ status: 'debt' }, { payer: 1 }]) {
    const db = freshDb();
    if (inv.payer) db.prepare("INSERT INTO payers (id, name) VALUES (1, 'Страховая')").run();
    const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
    invoice(db, vid, inv);
    assert.deepEqual(crmNoShowSweep(db), [], JSON.stringify(inv));
    assert.equal(st(db, rid), 'scheduled');
  }
});

test('выставленный, но не оплаченный счёт приходом не является — «Не пришёл»', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  invoice(db, vid);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

test('отметка «Пришёл» у визита записи — не «Не пришёл»', () => {
  const db = freshDb();
  const vid = visit(db, Y, { status: 'arrived' }); const rid = lead(db, { date: Y });
  link(db, vid, rid);
  assert.deepEqual(crmNoShowSweep(db), []);
});

test('пациент в тот день пришёл ДРУГИМ визитом (оплата) — не «Не пришёл»', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  paid(db, visit(db, Y));   // второй визит того же дня оплачен
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.equal(st(db, rid), 'scheduled');
});

test('пациент пришёл в соседнее здание (визит соседа, оплачен) — не «Не пришёл»', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  paid(db, visit(db, Y, { origin: 'branch-2' }));
  assert.deepEqual(crmNoShowSweep(db), []);
});

test('оплата по ОТМЕНЁННОМУ визиту того дня приходом не считается', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  paid(db, visit(db, Y, { status: 'cancelled' }));
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

test('запись через календарь без строк (только привязка) тоже проверяется', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y });
  link(db, vid, rid);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

test('одна из записей ещё впереди или сегодня — ждём', () => {
  for (const ahead of [T, T0]) {
    const db = freshDb();
    const rid = lead(db, { date: Y });
    line(db, rid, visit(db, Y), Y); link(db, visit(db, ahead), rid);
    assert.deepEqual(crmNoShowSweep(db), [], ahead);
  }
});

test('две прошедшие записи, у одной — доказательство: не «Не пришёл»', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  line(db, rid, visit(db, Y2), Y2);
  const v2 = visit(db, Y); line(db, rid, v2, Y); paid(db, v2);
  assert.deepEqual(crmNoShowSweep(db), []);
});

test('отменённый визит записью не считается: остаётся правило «на дату»', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  line(db, rid, visit(db, Y, { status: 'cancelled' }), Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

test('визит держит только ЖДУЩАЯ строка: отменённая строка со ссылкой записью не считается', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y });
  line(db, rid, vid, Y, 'cancelled');
  // записи нет → правило «на дату»: «Записан», пациент есть, в тот день не приходил
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

test('карточка ещё ждёт: дата карточки сегодня или позже, ждущая строка на сегодня или позже — не трогается', () => {
  const db = freshDb();
  const a = lead(db, { date: T0 }); line(db, a, visit(db, Y), Y);
  const b = lead(db, { date: Y }); line(db, b, visit(db, Y), Y); line(db, b, null, T);
  const c = lead(db, { date: Y }); line(db, c, null, T0);
  assert.deepEqual(crmNoShowSweep(db), []);
});

// ─── ЧТО НЕ ТРОГАЕТСЯ НИКОГДА ─────────────────────────────────────────────

test('«Перезвонить» и всё до «Колонки записи» не трогается — ни с датой, ни с записью', () => {
  const db = freshDb();
  const a = lead(db, { status: 'recall', date: Y });
  const b = lead(db, { status: 'recall', date: Y }); line(db, b, visit(db, Y), Y);
  const c = lead(db, { status: 'in_process', date: Y }); link(db, visit(db, Y), c);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.deepEqual([st(db, a), st(db, b), st(db, c)], ['recall', 'recall', 'in_process']);
});

test('карточка без пациента не трогается — ни «на дату», ни с записью', () => {
  const db = freshDb();
  const a = lead(db, { date: Y, patient: null });
  const b = lead(db, { date: Y, patient: null }); line(db, b, visit(db, Y), Y);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.deepEqual([st(db, a), st(db, b)], ['scheduled', 'scheduled']);
});

test('закрытые карточки не трогаются; повторный проход ничего не меняет', () => {
  const db = freshDb();
  const won = lead(db, { status: 'came', date: Y }); line(db, won, visit(db, Y), Y);
  const lost = lead(db, { status: 'stopped', date: Y });
  const rid = lead(db, { date: Y }); line(db, rid, visit(db, Y), Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.deepEqual([st(db, won), st(db, lost)], ['came', 'stopped']);
});

test('без сидовой «Не пришёл» — ничего: первая проигрышная может быть «Отказ»', () => {
  const db = freshDb();
  db.pragma('foreign_keys = OFF');
  db.prepare("DELETE FROM crm_stages WHERE key = 'no_show'").run();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.equal(st(db, rid), 'scheduled');
});

// ─── КАРТОЧКА «НА ДАТУ» (БЕЗ ЗАПИСИ) ──────────────────────────────────────

test('карточка «на дату» без записи: из «Колонки записи» и дальше, с пациентом, без прихода в тот день', () => {
  const db = freshDb();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('waiting_pay','Ждёт оплаты','info',4,1,'open')").run();
  const a = lead(db, { status: 'scheduled', date: Y });
  const b = lead(db, { status: 'waiting_pay', date: Y });
  const c = lead(db, { status: 'approved', date: Y });
  const noDate = lead(db, { status: 'scheduled' });
  const future = lead(db, { status: 'scheduled', date: T });
  assert.deepEqual(sorted(crmNoShowSweep(db)), [a, b, c]);
  assert.deepEqual([st(db, noDate), st(db, future)], ['scheduled', 'scheduled']);
});

test('карточка «на дату»: у пациента в тот день визит с доказательством (оплата, долг, отметка) — не «Не пришёл»', () => {
  for (const proof of ['paid', 'debt', 'arrived', 'work']) {
    const db = freshDb();
    const rid = lead(db, { date: Y });
    const vid = visit(db, Y, { status: proof === 'arrived' ? 'arrived' : 'scheduled' });
    if (proof === 'paid') paid(db, vid);
    if (proof === 'debt') invoice(db, vid, { status: 'debt' });
    if (proof === 'work') db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 1, 1, 'collected')").run(vid);
    assert.deepEqual(crmNoShowSweep(db), [], proof);
  }
});

test('карточка «на дату»: визит того дня без доказательства (записали, не пришёл) — «Не пришёл»', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  visit(db, Y);   // визит дня без связи с карточкой и без прихода
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

// ─── «КОЛОНКА ЗАПИСИ» И «КОЛОНКА КОНВЕРСИИ» — ИЗ НАСТРОЕК ─────────────────

test('«Колонка записи» — выбор клиники: до неё ничего не трогается', () => {
  const db = freshDb();
  saveConfig(db, { settings: { booked_stage: 'approved' } });
  const before = lead(db, { status: 'scheduled', date: Y }); line(db, before, visit(db, Y), Y);
  const from = lead(db, { status: 'approved', date: Y }); line(db, from, visit(db, Y), Y);
  assert.deepEqual(crmNoShowSweep(db), [from]);
  assert.equal(st(db, before), 'scheduled');
});

test('смена «Колонки конверсии»: история идёт за ролью и под проход не попадает; прежняя конверсия — пустая', () => {
  const db = freshDb();
  const hist = lead(db, { status: 'came', date: Y2 }); line(db, hist, visit(db, Y2), Y2);
  const histDated = lead(db, { status: 'came', date: Y2 });
  saveConfig(db, { settings: { won_stage: 'approved' } });
  assert.deepEqual([st(db, hist), st(db, histDated)], ['approved', 'approved'], 'история не пошла за ролью');
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.deepEqual([st(db, hist), st(db, histDated)], ['approved', 'approved']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status = 'came'").get().n, 0);
});

// ─── САМОИСПРАВЛЕНИЕ: ДОКАЗАТЕЛЬСТВО, ПРИШЕДШЕЕ ПОЗЖЕ ─────────────────────

test('оплата вчерашнего визита приходит сегодня — карточка с записью поднимается в «Пришёл»', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmVisitStatus(db, { visitId: vid, from: null, to: 'arrived' });
  assert.equal(st(db, rid), 'came');
});

test('карточка «на дату»: приход того дня, доехавший позже (порция соседнего здания), поднимает «Не пришёл» в «Пришёл»', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  const other = lead(db, { date: Y2 });
  assert.deepEqual(sorted(crmNoShowSweep(db)), sorted([rid, other]));
  const vid = visit(db, Y, { origin: 'branch-2' });
  crmVisitStatus(db, { visitId: vid, from: null, to: 'arrived' });
  assert.equal(st(db, rid), 'came', 'карточка дня прихода осталась «Не пришёл»');
  assert.equal(st(db, other), 'no_show', 'приход поднял карточку ДРУГОГО дня');
});

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────

test('scheduleCrmNoShow: проход сразу и таймер, который не держит процесс', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  const h = scheduleCrmNoShow(db, { everyMs: 3600000 });
  try { assert.equal(st(db, rid), 'no_show'); assert.equal(h.hasRef(), false); }
  finally { clearInterval(h); }
});

test('проход не бросается: сломанная база — пустой ответ', () => {
  const db = freshDb();
  db.close();
  assert.deepEqual(crmNoShowSweep(db), []);
});
