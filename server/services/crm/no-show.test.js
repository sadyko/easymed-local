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
import { crmNoShowSweep, scheduleCrmNoShow, crmArrivalCatchUp } from './no-show.js';   // CRM_UNIFY_V1 (2026-10-10) — догоняющий проход

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
  // CRM_UNIFY_V1 (ревью задач 5–6, I-5) — ОБНОВЛЕНО НАМЕРЕННО: «Не пришёл», поставленный
  // сервером, — не контакт; updated_at прежний (окно повторного обращения не освежается).
  assert.equal(db.prepare('SELECT updated_at FROM crm_requests WHERE id = ?').get(rid).updated_at, OLD, 'проход освежил карточку');
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

// CRM_UNIFY_V1 (ревью задач 5–6, I-2) — ОБНОВЛЕНО НАМЕРЕННО: счёт по визиту того дня —
// любой, и неоплаченный, и нулевой — значит, что отсутствие неясно: «Не пришёл» не ставится.
test('выставленный, но не оплаченный счёт по визиту того дня — «Не пришёл» неясен, не ставится', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  invoice(db, vid);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.equal(st(db, rid), 'scheduled');
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

// CRM_UNIFY_V1 (финальное ревью, A-I4) — ОБНОВЛЕНО НАМЕРЕННО: отменённый визит записью
// по-прежнему не считается, но отменённый в тот день приём — не неявка: «на дату» не метится.
test('отменённый визит записью не считается; отменённый в тот день приём — не «Не пришёл»', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  line(db, rid, visit(db, Y, { status: 'cancelled' }), Y);
  assert.deepEqual(crmNoShowSweep(db), []);
  const db2 = freshDb();
  const r2 = lead(db2, { date: Y });
  line(db2, r2, visit(db2, Y2, { status: 'cancelled' }), Y2);   // отменён другой день — день карточки ясен
  assert.deepEqual(crmNoShowSweep(db2), [r2]);
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
  // CRM_UNIFY_V1 (финальное ревью, A-P5) — ОБНОВЛЕНО НАМЕРЕННО: опоздание в пределах окна
  // (3 дня) — тоже приход; «другой день» здесь — за окном.
  const other = lead(db, { date: day(-6) });
  assert.deepEqual(sorted(crmNoShowSweep(db)), sorted([rid, other]));
  const vid = visit(db, Y, { origin: 'branch-2' });
  crmVisitStatus(db, { visitId: vid, from: null, to: 'arrived' });
  assert.equal(st(db, rid), 'came', 'карточка дня прихода осталась «Не пришёл»');
  assert.equal(st(db, other), 'no_show', 'приход поднял карточку ДРУГОГО дня');
});

// ─── CRM_UNIFY_V1 (2026-10-10) — ДОГОНЯЮЩИЙ ПРОХОД ПРИХОДА ────────────────
//
// Замечание владельца: запись из карточки на завтра, пациент пришёл сегодня —
// оплата, подпись врача, а карточка осталась ждать (прежний сторож «будущий
// визит не приход» не пропустил и работу над услугой). Правило прихода теперь
// принимает работу и отметку «Пришёл» в любой день визита своего здания, а
// проход раз в час (и при запуске) догоняет карточки, чьё доказательство
// когда-то пропустили: открытая карточка (или сидовая «Не пришёл»), которую
// держит живой визит своего здания — ждущей строкой или привязкой записи, — а у
// визита есть работа над услугой или отметка «Пришёл».

/** Строка визита со статусом работы; строку заявки можно привязать к ней. */
const work = (db, vid, status = 'completed') => Number(db.prepare(
  'INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 1000, 1000, ?)').run(vid, status).lastInsertRowid);
const heldBy = (db, lid, vs) => db.prepare('UPDATE crm_request_services SET visit_service_id = ? WHERE id = ?').run(vs, lid);
const lineSt = (db, id) => db.prepare('SELECT status FROM crm_request_services WHERE id = ?').get(id).status;
const stamp = (db, id) => db.prepare('SELECT updated_at FROM crm_requests WHERE id = ?').get(id).updated_at;
/** Деньги и записи: визиты, счета, платежи, строки визита. */
const moneySnap = (db) => JSON.stringify({
  visits: db.prepare('SELECT * FROM visits ORDER BY id').all(),
  invoices: db.prepare('SELECT * FROM invoices ORDER BY id').all(),
  payments: db.prepare('SELECT * FROM payments ORDER BY id').all(),
  visit_services: db.prepare('SELECT * FROM visit_services ORDER BY id').all(),
});
/** Строки заявок — без статуса (закрытие строк — дело самого правила прихода). */
const linesSnap = (db) => JSON.stringify(db.prepare(
  'SELECT id, request_id, service_id, scheduled_date, visit_id, visit_service_id, visit_service_auto FROM crm_request_services ORDER BY id').all());
const crmSnap = (db) => JSON.stringify({
  requests: db.prepare('SELECT * FROM crm_requests ORDER BY id').all(),
  lines: db.prepare('SELECT * FROM crm_request_services ORDER BY id').all(),
});

test('догоняющий проход: визит на завтра уже с выполненной услугой, карточка открыта — «Пришёл» одним проходом; второй ничего не меняет', () => {
  const db = freshDb();
  const vid = visit(db, T);
  const rid = lead(db, { status: 'approved', date: T });
  const lid = line(db, rid, vid, T);
  heldBy(db, lid, work(db, vid));
  paid(db, vid);
  const bystander = lead(db, { status: 'recall', date: T0 });   // чужая открытая карточка — не трогается
  const money0 = moneySnap(db); const lines0 = linesSnap(db);

  assert.deepEqual(crmArrivalCatchUp(db), [vid]);
  assert.equal(st(db, rid), 'came', 'услуга выполнена, а карточка так и ждёт завтрашнего дня');
  assert.equal(lineSt(db, lid), 'done', 'строка с услугой в визите не закрыта правилом прихода');
  assert.equal(stamp(db, rid), OLD, 'проход освежил закрытую карточку — переход сервера не контакт (I-5)');
  assert.equal(stamp(db, bystander), OLD, 'проход освежил карточку, которую не двигал');
  assert.equal(st(db, bystander), 'recall');
  assert.equal(moneySnap(db), money0, 'проход изменил визиты, счета, платежи или строки визита');
  assert.equal(linesSnap(db), lines0, 'проход изменил строки заявок (кроме закрытия)');

  const once = crmSnap(db);
  assert.deepEqual(crmArrivalCatchUp(db), [], 'второй проход снова нашёл работу');
  assert.equal(crmSnap(db), once, 'второй проход что-то изменил');
  assert.equal(moneySnap(db), money0);
});

test('догоняющий проход: отметка «Пришёл» у визита, привязка записи без строк, сидовая «Не пришёл» — закрываются', () => {
  const db = freshDb();
  // Отметка «Пришёл» на визите завтрашнего дня, карточка — по строке.
  const v1 = visit(db, T, { status: 'arrived' });
  const byMark = lead(db, { status: 'scheduled', date: T }); line(db, byMark, v1, T);
  // Привязка записи (crm_booking_links), работа начата.
  const v2 = visit(db, T);
  work(db, v2, 'in_progress');
  const byLink = lead(db, { status: 'scheduled', date: T }); link(db, v2, byLink);
  // Сидовая «Не пришёл»: вчерашняя запись, проба взята.
  const v3 = visit(db, Y);
  work(db, v3, 'collected');
  const missed = lead(db, { status: 'no_show', date: Y }); line(db, missed, v3, Y);
  const money0 = moneySnap(db);

  assert.deepEqual(sorted(crmArrivalCatchUp(db)), sorted([v1, v2, v3]));
  assert.deepEqual([st(db, byMark), st(db, byLink), st(db, missed)], ['came', 'came', 'came']);
  assert.equal(moneySnap(db), money0, 'проход изменил деньги или записи');
  assert.deepEqual(crmArrivalCatchUp(db), []);
});

test('догоняющий проход: строки, которых нет в визите, в визит НЕ ставит (деньги не трогаются) — строка ждёт, карточка закрыта', () => {
  const db = freshDb();
  const vid = visit(db, T);
  work(db, vid);
  const rid = lead(db, { status: 'scheduled', date: T });
  const lid = line(db, rid, vid, T);   // строка держит визит, а её услуги в визите нет
  const money0 = moneySnap(db);
  crmArrivalCatchUp(db);
  assert.equal(st(db, rid), 'came');
  assert.equal(lineSt(db, lid), 'pending', 'строка закрыта без услуги в визите (инвариант)');
  assert.equal(moneySnap(db), money0, 'проход поставил услугу в визит — у кассы новая строка «Ждут счёта»');
});

test('догоняющий проход никогда: «Отказ» и прочие закрытые, визит соседнего здания, мёртвый визит, одна оплата, нет работы, строка уже закрыта', () => {
  const db = freshDb();
  const ev = (d, opts) => { const v = visit(db, d, opts); work(db, v); return v; };
  // Закрытые карточки — даже если их визит с работой.
  const lostV = ev(T); const lost = lead(db, { status: 'stopped', date: T }); line(db, lost, lostV, T);
  const unqV = ev(T); const unq = lead(db, { status: 'not_qualified', date: T }); link(db, unqV, unq);
  const wonV = ev(Y); const won = lead(db, { status: 'came', date: Y }); line(db, won, wonV, Y);
  // Визит соседнего здания — правила crmFromSync, проход их не трогает.
  const syncV = ev(Y, { origin: 'B' }); const viaSync = lead(db, { status: 'scheduled', date: Y }); line(db, viaSync, syncV, Y);
  const syncV2 = ev(T, { origin: 'B' }); const viaSync2 = lead(db, { status: 'scheduled', date: T }); link(db, syncV2, viaSync2);
  // Мёртвый визит доказательством не бывает.
  const cancV = ev(Y, { status: 'cancelled' }); const canc = lead(db, { status: 'scheduled', date: Y }); line(db, canc, cancV, Y);
  const nsV = ev(Y, { status: 'no_show' }); const ns = lead(db, { status: 'no_show', date: Y }); line(db, ns, nsV, Y);
  // Одна оплата завтрашнего визита — предоплата.
  const preV = visit(db, T); paid(db, preV); const pre = lead(db, { status: 'scheduled', date: T }); line(db, pre, preV, T);
  // Услуга в смете ('added', 'queued') — не работа.
  const addV = visit(db, T); work(db, addV, 'added'); work(db, addV, 'queued');
  const added = lead(db, { status: 'scheduled', date: T }); line(db, added, addV, T);
  // Строка этого визита уже закрыта приходом, а карточку человек вернул в работу.
  const backV = ev(Y); const back = lead(db, { status: 'recall', date: Y }); line(db, back, backV, Y, 'done');
  const crm0 = crmSnap(db); const money0 = moneySnap(db);

  assert.deepEqual(crmArrivalCatchUp(db), []);
  assert.equal(crmSnap(db), crm0, 'проход тронул карточку или строку, которую трогать нельзя');
  assert.equal(moneySnap(db), money0);
});

test('догоняющий проход не бросается: сломанная база — пустой ответ', () => {
  const db = freshDb();
  db.close();
  assert.deepEqual(crmArrivalCatchUp(db), []);
});

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────

test('scheduleCrmNoShow: проход сразу и таймер, который не держит процесс', () => {
  const db = freshDb();
  const vid = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, vid, Y);
  const h = scheduleCrmNoShow(db, { everyMs: 3600000 });
  try { assert.equal(st(db, rid), 'no_show'); assert.equal(h.hasRef(), false); }
  finally { clearInterval(h); }
});

// CRM_UNIFY_V1 (2026-10-10) — тот же запуск (при старте сервера — после
// разового исправления) и тот же часовой таймер догоняют и приход.
test('scheduleCrmNoShow: догоняющий проход прихода — сразу при запуске', () => {
  const db = freshDb();
  const vid = visit(db, T); work(db, vid);
  const rid = lead(db, { status: 'approved', date: T }); line(db, rid, vid, T);
  const h = scheduleCrmNoShow(db, { everyMs: 3600000 });
  try { assert.equal(st(db, rid), 'came', 'запуск не догнал приход'); }
  finally { clearInterval(h); }
});

test('проход не бросается: сломанная база — пустой ответ', () => {
  const db = freshDb();
  db.close();
  assert.deepEqual(crmNoShowSweep(db), []);
});
