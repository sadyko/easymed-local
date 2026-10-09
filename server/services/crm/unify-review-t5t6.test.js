// CRM_UNIFY_V1 — РЕВЬЮ ЗАДАЧ 5 И 6 (ba05de5, 43d42ab): находки проверяющего
// (A1–A7, W1–W7, H1, R9) как настоящие тесты, с решениями контролёра:
//   I-1 — самоисправление карточки с записью: приход того же дня поднимает «Не
//         пришёл» правилом прихода (Р8), даже если у неё остались ждущие строки;
//   I-2 — «Не пришёл» только в ясных случаях: не ставится, если в тот день есть
//         приход у пациента с тем же основным номером (дубль карты), госпитализация
//         или любой счёт по визиту пациента (в том числе нулевой);
//   I-3 — «Не пришёл» — не закрытая карточка: запись и звонок в окне берут её,
//         после окна она возвращается в начало, как любая открытая;
//   I-4 — карточка, которая ждёт будущий день, звонком в начало не возвращается;
//   I-5 — переходы, которые делает сервер сам («Не пришёл», отмена записи,
//         неявка по календарю), — не движение карточки: updated_at не меняется,
//         и давняя карточка не выглядит свежей для окна повторного обращения;
//   M-1 — отмена записи симметрична приходу и неявке: и для карточки,
//         привязанной только записью (crm_booking_links).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmVisitStatus, crmInvoiceEvidence } from './visit-status.js';
import { crmNoShowSweep } from './no-show.js';
import { crmLinkVisit } from './visit-link.js';
import { recordCall } from '../telephony/poller.js';
import { contactDecision } from './contact-window.js';

const pad = (n) => String(n).padStart(2, '0');
const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (ymd, hh = 10, mm = 0) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString(); };
const Y = day(-1), T0 = day(0), T = day(1), T2 = day(2);
const OLD = '2026-01-01T00:00:00Z';
const agoIso = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (1,'П','+998 90 961 00 04')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (2,'Дубль П','+998 90 961 00 04')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (3,'Чужой','+998 91 111 22 33')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Рег','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'cc','x','Оп','callcenter')").run();
  return db;
}
const REG = { id: 2, role: 'registrar' };
const CC = { id: 3, role: 'callcenter' };
const visit = (db, d, { status = 'scheduled', patient = 1, origin = null, hh = 10, mm = 0 } = {}) =>
  Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (?, ?, ?, ?)').run(patient, at(d, hh, mm), status, origin).lastInsertRowid);
const lead = (db, { status = 'scheduled', date = null, patient = 1, phone = '998909610004', updated = OLD } = {}) => {
  const id = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES ('Л',?,?,?,?)")
    .run(phone, status, patient, date).lastInsertRowid);
  db.prepare('UPDATE crm_requests SET updated_at = ?, created_at = ? WHERE id = ?').run(updated, updated, id);
  return id;
};
const line = (db, rid, vid, d, status = 'pending') => Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id)
  VALUES (?, 40, ?, ?, ?)`).run(rid, d, status, vid).lastInsertRowid);
const link = (db, vid, rid) => db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'callcenter')").run(vid, rid);
const row = (db, id) => db.prepare('SELECT status, scheduled_date, updated_at FROM crm_requests WHERE id = ?').get(id);
const st = (db, id) => row(db, id).status;
const cards = (db) => db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n;
const paidInv = (db, vid, patient = 1, amt = 1000, total = 1000, status = 'paid') => {
  const inv = Number(db.prepare('INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, ?, ?, ?, ?)').run(vid, patient, total, amt, status).lastInsertRowid);
  if (amt > 0) db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, ?, 'cash')").run(inv, amt);
  return inv;
};
const call = (id) => ({ generalCallID: id, startTime: Math.floor(Date.now() / 1000), callType: 0, internalNumber: '901',
  externalNumber: '+998909610004', waitsec: '5', billsec: '30', disposition: 'ANSWER', isNewCall: '1' });

// ── I-1: САМОИСПРАВЛЕНИЕ КАРТОЧКИ С ЗАПИСЬЮ ─────────────────────────────────

test('A1 (I-1): приход того дня другим визитом (порция соседнего здания после прохода) поднимает «Не пришёл» карточки с записью', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  const v2 = visit(db, Y, { origin: 'branch-b' });
  crmInvoiceEvidence(db, paidInv(db, v2));   // то, что делает crmFromSync
  assert.equal(st(db, rid), 'came', 'пришедший в тот день остался «Не пришёл»');
  assert.equal(db.prepare('SELECT status FROM crm_request_services WHERE request_id = ?').get(rid).status, 'pending',
    'строка чужого визита закрыта без услуги в визите');
});

test('A1b (I-1): карточка «на дату» с незаписанной строкой того дня тоже поднимается', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y }); line(db, rid, null, Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmInvoiceEvidence(db, paidInv(db, visit(db, Y, { origin: 'branch-b' })));
  assert.equal(st(db, rid), 'came');
});

test('A1c: карточка «на дату» без строк поднимается (как было)', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmInvoiceEvidence(db, paidInv(db, visit(db, Y, { origin: 'branch-b' })));
  assert.equal(st(db, rid), 'came');
});

test('I-1: приход в ДРУГОЙ день карточку с записью не поднимает', () => {
  const db = freshDb();
  const v1 = visit(db, day(-3)); const rid = lead(db, { date: day(-3) }); line(db, rid, v1, day(-3));
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmInvoiceEvidence(db, paidInv(db, visit(db, Y)));
  assert.equal(st(db, rid), 'no_show');
});

test('H1: другой пациент на том же номере и предоплата будущего визита — не поднимают', () => {
  const db = freshDb();
  const rid = lead(db, { date: Y });
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmInvoiceEvidence(db, paidInv(db, visit(db, Y, { patient: 2 }), 2));
  assert.equal(st(db, rid), 'no_show', 'приход другого пациента поднял карточку');
  const fut = lead(db, { status: 'no_show', date: T });
  crmInvoiceEvidence(db, paidInv(db, visit(db, T)));
  assert.equal(st(db, fut), 'no_show', 'предоплата будущего визита подняла карточку');
});

// ── I-2: «НЕ ПРИШЁЛ» ТОЛЬКО В ЯСНЫХ СЛУЧАЯХ ────────────────────────────────

test('A2 (I-2): пациент пришёл под дублем карты (тот же основной номер) и заплатил там — не «Не пришёл»', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  paidInv(db, visit(db, Y, { patient: 2 }), 2);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.equal(st(db, rid), 'scheduled');
});

test('I-2: приход пациента с ДРУГИМ номером в тот день «Не пришёл» не отменяет', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  paidInv(db, visit(db, Y, { patient: 3 }), 3);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
});

test('A3 (I-2): госпитализация в день записи — не «Не пришёл»', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  const inv = Number(db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (NULL, 1, 5000, 5000, 'paid')").run().lastInsertRowid);
  db.prepare("INSERT INTO admissions (patient_id, status, admitted_at, invoice_id) VALUES (1, 'active', ?, ?)").run(at(Y, 11), inv);
  assert.deepEqual(crmNoShowSweep(db), []);
  // и у карточки «на дату»
  const db2 = freshDb();
  const r2 = lead(db2, { date: Y });
  db2.prepare("INSERT INTO admissions (patient_id, status, admitted_at) VALUES (1, 'active', ?)").run(at(Y, 11));
  assert.deepEqual(crmNoShowSweep(db2), []);
  assert.equal(st(db2, r2), 'scheduled');
});

test('A4: предоплата визита записи мешает «Не пришёл» (держится)', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  paidInv(db, v1, 1, 300, 1000, 'partial');
  assert.deepEqual(crmNoShowSweep(db), []);
});

test('A5 (I-2): бесплатный повторный приём — нулевой счёт; любой счёт по визиту того дня — не «Не пришёл»', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  paidInv(db, v1, 1, 0, 0, 'paid');
  assert.deepEqual(crmNoShowSweep(db), []);
  const db2 = freshDb();
  const v2 = visit(db2, Y); const r2 = lead(db2, { date: Y }); line(db2, r2, v2, Y);
  paidInv(db2, visit(db2, Y), 1, 0, 1000, 'unpaid');   // другой визит того дня, счёт не оплачен
  assert.deepEqual(crmNoShowSweep(db2), []);
  assert.equal(st(db2, r2), 'scheduled');
});

test('A6: около полуночи по местному: визит в 00:20 сегодня — не прошлое; 23:50 вчера, оплачено — держится', () => {
  const db = freshDb();
  const v0 = visit(db, T0, { hh: 0, mm: 20 }); const r0 = lead(db, { date: T0 }); line(db, r0, v0, T0);
  const v1 = visit(db, Y, { hh: 23, mm: 50 }); const r1 = lead(db, { date: Y }); line(db, r1, v1, Y);
  paidInv(db, v1);
  assert.deepEqual(crmNoShowSweep(db), []);
  assert.deepEqual([st(db, r0), st(db, r1)], ['scheduled', 'scheduled']);
});

test('A7: визит «Пришёл» со строками, оставшимися ждать (инвариант b3ebc2d), — не «Не пришёл»', () => {
  const db = freshDb();
  const v1 = visit(db, Y, { status: 'arrived' }); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  assert.deepEqual(crmNoShowSweep(db), []);
});

// ── I-5: ПЕРЕХОДЫ СЕРВЕРА — НЕ ДВИЖЕНИЕ КАРТОЧКИ ───────────────────────────

test('I-5: проход «Не пришёл», неявка по календарю и отмена записи updated_at не меняют', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const swept = lead(db, { date: Y }); line(db, swept, v1, Y);
  assert.deepEqual(crmNoShowSweep(db), [swept]);
  const v2 = visit(db, T); const marked = lead(db, { date: T, patient: 3 }); line(db, marked, v2, T);
  db.prepare('UPDATE visits SET patient_id = 3 WHERE id = ?').run(v2);
  crmVisitStatus(db, { visitId: v2, from: 'scheduled', to: 'no_show' });
  const v3 = visit(db, T, { patient: 3 }); const cancelled = lead(db, { date: T, patient: 3 }); line(db, cancelled, v3, T);
  crmVisitStatus(db, { visitId: v3, from: 'scheduled', to: 'cancelled' });
  assert.deepEqual([st(db, swept), st(db, marked), st(db, cancelled)], ['no_show', 'no_show', 'in_process']);
  for (const id of [swept, marked, cancelled]) assert.equal(row(db, id).updated_at, OLD, 'серверный переход сдвинул updated_at карточки ' + id);
});

test('W1 (I-5, I-3): проход «Не пришёл» по карточке 200-дневной давности — звонок через час возвращает её в начало, а не глотается', () => {
  const db = freshDb();
  const old = agoIso(200); const oldDay = old.slice(0, 10);
  const v1 = visit(db, oldDay); const rid = lead(db, { date: oldDay, updated: old }); line(db, rid, v1, oldDay);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  assert.equal(row(db, rid).updated_at, old, 'проход освежил давнюю карточку');
  recordCall(db, call('GC-W1'), 'poll');
  assert.equal(cards(db), 1);
  assert.equal(st(db, rid), 'in_process', 'звонок после окна не вернул «Не пришёл» в начало воронки');
  assert.ok(row(db, rid).updated_at > old, 'новое обращение не отмечено движением');
});

test('W1b (I-5): давняя карточка после прохода — посторонний приход на стойку её не закрывает', () => {
  const db = freshDb();
  const old = agoIso(200); const oldDay = old.slice(0, 10);
  const v1 = visit(db, oldDay); const rid = lead(db, { date: oldDay, updated: old }); line(db, rid, v1, oldDay);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmLinkVisit(db, visit(db, T0), REG, { desk: true });
  assert.equal(st(db, rid), 'no_show', 'приход сегодня закрыл карточку двухсотдневной давности');
});

test('I-5: пришёл на день позже записи (проход уже поставил «Не пришёл») — стойка закрывает карточку', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y, updated: agoIso(21) }); line(db, rid, v1, Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  crmLinkVisit(db, visit(db, T0), REG, { desk: true });
  assert.equal(st(db, rid), 'came', 'опоздавший на день остался «Не пришёл»');
});

// ── I-3: «НЕ ПРИШЁЛ» — НЕ ЗАКРЫТАЯ КАРТОЧКА ───────────────────────────────

test('W2 (I-3): колл-центр перезаписывает после неявки — та же карточка, привязка, «Записан»; приход закрывает её', () => {
  const db = freshDb();
  const v1 = visit(db, Y); const rid = lead(db, { date: Y }); line(db, rid, v1, Y);
  assert.deepEqual(crmNoShowSweep(db), [rid]);
  const v3 = visit(db, T);
  crmLinkVisit(db, v3, CC);
  assert.equal(cards(db), 1, 'перезапись после неявки завела дубль');
  assert.equal(db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ?').get(v3)?.request_id, rid, 'запись не привязана к карточке');
  assert.equal(st(db, rid), 'scheduled');
  db.prepare('UPDATE visits SET visit_date = ? WHERE id = ?').run(at(T0, 9), v3);
  crmVisitStatus(db, { visitId: v3, from: 'scheduled', to: 'arrived' });
  assert.equal(st(db, rid), 'came');
});

test('I-3: «Не пришёл» в окне — запись (не колл-центр) берёт её и переводит в «Колонку записи»; звонок — та же карточка', () => {
  const db = freshDb();
  const rid = lead(db, { status: 'no_show', date: Y, updated: agoIso(1) });
  crmLinkVisit(db, visit(db, T), REG);
  assert.equal(st(db, rid), 'scheduled');
  assert.equal(row(db, rid).scheduled_date, T);
  const db2 = freshDb();
  const r2 = lead(db2, { status: 'no_show', date: Y, updated: agoIso(1) });
  recordCall(db2, call('GC-I3'), 'poll');
  assert.equal(cards(db2), 1, 'звонок в окне после неявки завёл дубль');
  assert.equal(st(db2, r2), 'no_show');
  assert.deepEqual(contactDecision(db2, [r2]).action, 'same');
});

test('I-3: «Не пришёл» за окном — запись колл-центра возвращает её в начало и записывает; давний «Не пришёл» запись регистратуры не трогает', () => {
  const db = freshDb();
  const rid = lead(db, { status: 'no_show', date: day(-20), updated: agoIso(20) });
  crmLinkVisit(db, visit(db, T), CC);
  assert.equal(cards(db), 1);
  assert.equal(st(db, rid), 'scheduled');
  const db2 = freshDb();
  const r2 = lead(db2, { status: 'no_show', date: day(-20), updated: agoIso(20) });
  crmLinkVisit(db2, visit(db2, T), REG);
  assert.equal(st(db2, r2), 'no_show');
});

test('I-3: «Отказ» и «Пришёл» по-прежнему закрыты: звонок в окне — без дубля, карточка не тронута', () => {
  for (const status of ['came', 'stopped']) {
    const db = freshDb();
    const rid = lead(db, { status, updated: agoIso(1) });
    const before = row(db, rid);
    recordCall(db, call('GC-' + status), 'poll');
    assert.equal(cards(db), 1, status);
    assert.deepEqual(row(db, rid), before, status);
  }
});

// ── W3–W7 ──────────────────────────────────────────────────────────────────

test('W3: общий семейный номер — закрытая карточка одного в окне: звонок другого карточку не заводит (Р5, как решено)', () => {
  const db = freshDb();
  lead(db, { status: 'came', patient: 1, updated: agoIso(1) });
  recordCall(db, call('GC-W3'), 'poll');
  assert.equal(cards(db), 1);
});

test('W4: правило «не создавать» давнюю открытую карточку не возвращает (держится)', () => {
  const db = freshDb();
  const rid = lead(db, { status: 'recall', updated: agoIso(21) });
  db.prepare("UPDATE crm_call_routing SET action = 'ignore', stage_key = NULL").run();
  recordCall(db, call('GC-W4'), 'poll');
  assert.equal(st(db, rid), 'recall');
});

test('W5 (M-2): форматы времени сравниваются одинаково; граница окна — как есть', () => {
  const db = freshDb();
  const r = db.prepare(`SELECT julianday('2026-10-09 07:00:00') = julianday('2026-10-09T07:00:00Z') a,
                               julianday('2026-10-09T07:00:00.000Z') = julianday('2026-10-09T07:00:00Z') b,
                               julianday('2026-10-09T12:00:00+05:00') = julianday('2026-10-09T07:00:00Z') c`).get();
  assert.deepEqual(r, { a: 1, b: 1, c: 1 });
  const a = lead(db, { status: 'recall', updated: '' });
  db.prepare("UPDATE crm_requests SET created_at = strftime('%Y-%m-%d %H:%M:%S','now','-71 hours') WHERE id = ?").run(a);
  assert.equal(contactDecision(db, [a]).action, 'same');
  db.prepare("UPDATE crm_requests SET created_at = strftime('%Y-%m-%d %H:%M:%S','now','-73 hours') WHERE id = ?").run(a);
  assert.equal(contactDecision(db, [a]).action, 'reopen');
});

test('W6 (I-4): звонок после окна по карточке, записанной три недели назад на послезавтра, — карточка не двигается', () => {
  const db = freshDb();
  const v = visit(db, T2); const rid = lead(db, { status: 'scheduled', date: T2, updated: agoIso(21) }); line(db, rid, v, T2);
  recordCall(db, call('GC-W6'), 'poll');
  assert.deepEqual([st(db, rid), row(db, rid).scheduled_date], ['scheduled', T2], 'записанная на будущее карточка возвращена в начало');
  assert.equal(cards(db), 1);
  assert.deepEqual(crmNoShowSweep(db, { day: day(3) }), [rid], 'проход после дня записи не видит её');
});

test('I-4: ждёт будущее — ждущая строка, живая будущая запись по привязке, дата карточки сегодня — «та же», любой давности', () => {
  const db = freshDb();
  const a = lead(db, { status: 'recall', updated: agoIso(30) }); line(db, a, null, T2);
  const b = lead(db, { status: 'recall', updated: agoIso(30), patient: 2 }); link(db, visit(db, T2, { patient: 2 }), b);
  const c = lead(db, { status: 'recall', date: T0, updated: agoIso(30), patient: 3 });
  const d = lead(db, { status: 'recall', date: Y, updated: agoIso(30), patient: 3 });   // прошлая дата — не ждёт
  assert.deepEqual([a, b, c].map((id) => contactDecision(db, [id]).action), ['same', 'same', 'same']);
  assert.equal(contactDecision(db, [d]).action, 'reopen');
});

test('W7: приход на стойку на запись, сделанную три недели назад, закрывает карточку (держится)', () => {
  const db = freshDb();
  const v = visit(db, T0); const rid = lead(db, { status: 'scheduled', date: T0, updated: agoIso(21) }); line(db, rid, v, T0);
  crmLinkVisit(db, v, REG, { desk: true });
  assert.equal(st(db, rid), 'came');
});

// ── M-1: ОТМЕНА ЗАПИСИ СИММЕТРИЧНА ─────────────────────────────────────────

test('R9 (M-1): отмена записи, привязанной только записью, — карточка из «Записан» в начало, как со строками; проход её не уносит', () => {
  const db = freshDb();
  const v = visit(db, Y); const rid = lead(db, { status: 'scheduled', date: Y }); link(db, v, rid);
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v);
  crmVisitStatus(db, { visitId: v, from: 'scheduled', to: 'cancelled' });
  assert.equal(st(db, rid), 'in_process', 'отмена записи без строк оставила карточку «Записан»');
  assert.equal(row(db, rid).scheduled_date, null);
  const v2 = visit(db, Y); const r2 = lead(db, { status: 'scheduled', date: Y }); line(db, r2, v2, Y);
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v2);
  crmVisitStatus(db, { visitId: v2, from: 'scheduled', to: 'cancelled' });
  assert.equal(st(db, r2), 'in_process');
  assert.deepEqual(crmNoShowSweep(db), []);
});

test('M-1: отмена одной записи из двух по привязке — карточка остаётся записанной; закрытые не трогаются', () => {
  const db = freshDb();
  const rid = lead(db, { status: 'scheduled', date: T });
  const v1 = visit(db, T); const v2 = visit(db, T2);
  link(db, v1, rid); link(db, v2, rid);
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v1);
  crmVisitStatus(db, { visitId: v1, from: 'scheduled', to: 'cancelled' });
  assert.equal(st(db, rid), 'scheduled');
  const won = lead(db, { status: 'came', date: T, patient: 3 }); const v3 = visit(db, T, { patient: 3 }); link(db, v3, won);
  const lost = lead(db, { status: 'stopped', date: T, patient: 3 }); const v4 = visit(db, T, { patient: 3 }); link(db, v4, lost);
  for (const v of [v3, v4]) {
    db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v);
    crmVisitStatus(db, { visitId: v, from: 'scheduled', to: 'cancelled' });
  }
  assert.deepEqual([st(db, won), st(db, lost)], ['came', 'stopped']);
});

// ── ОБЪЁМ (zz-perf ревью): 20 000 карточек / 45 000 пациентов ──────────────

test('объём: проход «Не пришёл» — первый метит, второй и третий ничего не меняют; updated_at не шевелится', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (40,'S',1000,'lab')").run();
  const P = 45000, CARDS = 20000;
  db.transaction(() => {
    const ip = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
    for (let i = 1; i <= P; i++) ip.run(i, 'P' + i, '99890' + String(1000000 + i));
    const iv = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')");
    const ii = db.prepare('INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, ?, 1000, ?, ?)');
    const ivs = db.prepare('INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, 40, ?)');
    const ir = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date, created_at, updated_at) VALUES ('L', ?, ?, ?, ?, ?, ?)");
    const il = db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?, 40, ?, 'pending', ?)");
    for (let i = 1; i <= P; i++) {
      for (let k = 0; k < 2; k++) {
        const d = day(-((i * 7 + k * 131) % 400) - 1);
        const vid = Number(iv.run(i, d + 'T05:00:00Z').lastInsertRowid);
        if ((i + k) % 2 === 0) { ii.run(vid, i, 1000, 'paid'); ivs.run(vid, 'completed'); } else ivs.run(vid, 'added');
      }
    }
    for (let c = 1; c <= CARDS; c++) {
      const pid = ((c * 13) % P) + 1;
      const d = day(-((c % 300) + 1));
      const kind = c % 10;
      if (kind < 5) { ir.run('99890' + (1000000 + pid), ['came', 'stopped', 'no_show'][c % 3], pid, d, OLD, OLD); continue; }
      if (kind === 5) { ir.run('99890' + (1000000 + pid), 'recall', pid, d, OLD, OLD); continue; }
      const rid = Number(ir.run('99890' + (1000000 + pid), 'scheduled', pid, d, OLD, OLD).lastInsertRowid);
      const vid = Number(iv.run(pid, d + 'T05:00:00Z').lastInsertRowid);
      il.run(rid, d, vid);
      if (kind !== 9) ii.run(vid, pid, 1000, 'paid');
    }
  })();
  const snap = () => new Map(db.prepare('SELECT id, status, updated_at FROM crm_requests').all().map((r) => [r.id, r]));
  const runs = [];
  for (let run = 1; run <= 3; run++) {
    const before = snap();
    const t0 = Date.now();
    const moved = crmNoShowSweep(db);
    const ms = Date.now() - t0;
    let changed = 0;
    for (const [id, r] of snap()) {
      const b = before.get(id);
      if (b.updated_at !== r.updated_at) assert.fail('updated_at карточки ' + id + ' сдвинут проходом');
      if (b.status !== r.status) changed++;
    }
    runs.push({ ms, moved: moved.length, changed });
  }
  console.log('[no-show perf] ' + runs.map((r, i) => `проход ${i + 1}: ${r.ms} мс, помечено ${r.moved}, изменено ${r.changed}`).join('; '));
  assert.ok(runs[0].moved > 0, 'первый проход ничего не пометил — проверка пустая');
  assert.equal(runs[0].changed, runs[0].moved);
  assert.deepEqual([runs[1].moved, runs[1].changed, runs[2].moved, runs[2].changed], [0, 0, 0, 0], 'повторный проход что-то меняет');
  assert.ok(runs.every((r) => r.ms < 20000), 'проход слишком долгий');
  db.close();
});
