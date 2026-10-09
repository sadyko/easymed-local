// CRM_UNIFY_V1 — ФИНАЛЬНОЕ РЕВЬЮ ВСЕЙ СБОРКИ (экспорт af07609): статус, «Не пришёл»
// и зеркало записи. Находки проверяющего (P1, P3, P4, P5, Q1-a2) — настоящими
// тестами через настоящие двери, с решениями контролёра:
//   A-C2 — сверка зеркала (booking-mirror.js шаг 3, касса — mirrorCashierLine)
//          берёт ждущую строку карточки той же услуги, а не заводит вторую:
//          иначе исходная строка оставалась ждать и садилась в следующий визит;
//   A-I3 — поздний приход по давнему визиту (результат анализа сегодня) не
//          закрывает карточку, заведённую ПОСЛЕ дня визита;
//   A-I4 — отменённая запись без другой живой записи стирает дату карточки в
//          любой открытой колонке: отменённый приём не становится «Не пришёл»;
//   A-P4 — пациент в стационаре в день записи (поступил раньше и ещё лежит) —
//          не «Не пришёл»;
//   A-P5 — опоздание на день — приход на назначенную запись через ЛЮБУЮ дверь
//          (мастер визита, касса), то же правило, что у стойки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { crmNoShowSweep } from '../services/crm/no-show.js';
import { mirrorCashierLine } from '../services/crm/booking-mirror.js';

const TODAY = localDay(0);
const nowIso = () => new Date().toISOString();
const agoIso = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const vsOf = (db, vid) => db.prepare('SELECT id, service_id, doctor_id, status, invoice_item_id FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const linesOfReq = (db, rid) => db.prepare('SELECT id, service_id, scheduled_date, status, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);
const oldVisit = (db, ymd, { patient = 77, status = 'scheduled', hh = 10, mm = 0 } = {}) =>
  Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (?, 10, ?, ?, 2)').run(patient, at(ymd, hh, mm), status).lastInsertRowid);

// ── A-I3 ────────────────────────────────────────────────────────────────────

test('P1 (A-I3): поздний результат анализа по визиту четырёхдневной давности не закрывает карточку, заведённую сегодня', async () => {
  const t = await startCrmApp();
  try {
    const d4 = localDay(-4);
    const v = oldVisit(t.db, d4);
    const vs = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 40000, 40000, 'queued')").run(v).lastInsertRowid);
    const inv = Number(t.db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status, created_at) VALUES (?, 77, 40000, 40000, 'paid', ?)").run(v, at(d4, 10, 30)).lastInsertRowid);
    t.db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 40000, 'cash', ?)").run(inv, at(d4, 10, 30));
    const rid = addLead(t.db, { status: 'in_process', patient: 77, assigned: 3, name: 'МРТ' });   // позвонил сегодня
    const r = await t.rpc('save_lab_results', 'boss', { visit_service_id: vs, rows: [{ parameter: 'HGB', value: '140' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'in_process', 'новую заявку объявили конверсией по давнему визиту');
  } finally { t.close(); }
});

test('A-I3: карточка, заведённая в день визита или раньше, поздним доказательством закрывается (как было)', async () => {
  const t = await startCrmApp();
  try {
    const d4 = localDay(-4);
    const v = oldVisit(t.db, d4);
    const vs = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 40000, 40000, 'queued')").run(v).lastInsertRowid);
    const rid = addLead(t.db, { status: 'in_process', patient: 77, date: d4, updated: agoIso(6) });
    const r = await t.rpc('save_lab_results', 'boss', { visit_service_id: vs, rows: [{ parameter: 'HGB', value: '140' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// ── A-I4 ────────────────────────────────────────────────────────────────────

test('P3 (A-I4): отменённая запись карточки в «Подтверждён» — дата стёрта, проход «Не пришёл» её не трогает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'approved', patient: 77, assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: localDay(1), doctor: 10 });
    const start = at(localDay(1), 10);
    const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: start, doctor_id: 10, book: { doctor_id: 10, service_id: 30, start, duration_minutes: 30 } });
    assert.equal(b.status, 200, b.text);
    const before = t.lead(rid).updated_at;
    const c = await t.rpc('calendar_book', 'reg', { visit_id: b.json.data.visit.id, start, status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['approved', null], 'дата отменённой записи осталась на карточке');
    assert.equal(t.lead(rid).updated_at, before, 'отмена — не движение карточки (I-5)');
    assert.deepEqual(crmNoShowSweep(t.db, { day: localDay(2) }), []);
    assert.equal(t.lead(rid).status, 'approved', 'отменённый приём объявлен неявкой');
  } finally { t.close(); }
});

test('A-I4: «Отказ» и «Пришёл» отмена записи не трогает — ни ступень, ни дату', async () => {
  const t = await startCrmApp();
  try {
    const start = at(localDay(1), 10);
    const b = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: start, doctor_id: 10, book: { doctor_id: 10, start, duration_minutes: 30 } });
    const vid = b.json.data.visit.id;
    const won = addLead(t.db, { status: 'came', patient: 77, date: localDay(1) });
    const lost = addLead(t.db, { status: 'stopped', patient: 77, date: localDay(1) });
    for (const rid of [won, lost]) t.db.prepare("INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    await t.rpc('calendar_book', 'reg', { visit_id: vid, start, status: 'cancelled' });
    assert.deepEqual([won, lost].map((id) => [t.lead(id).status, t.lead(id).scheduled_date]),
      [['came', localDay(1)], ['stopped', localDay(1)]]);
  } finally { t.close(); }
});

// ── A-P4 ────────────────────────────────────────────────────────────────────

test('P4 (A-P4): пациент поступил в стационар накануне и ещё лежит — не «Не пришёл» на амбулаторный день', async () => {
  const t = await startCrmApp();
  try {
    const y = localDay(-1);
    const rid = addLead(t.db, { status: 'scheduled', patient: 77, date: y, updated: agoIso(5) });
    addLine(t.db, rid, { svc: 30, day: y, doctor: 10, visit: oldVisit(t.db, y) });
    t.db.prepare("INSERT INTO admissions (patient_id, admitted_at, status) VALUES (77, ?, 'active')").run(at(localDay(-2), 15));
    assert.deepEqual(crmNoShowSweep(t.db), []);
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

test('A-P4: выписан ДО дня записи или госпитализация отменена — «Не пришёл» ставится', async () => {
  for (const adm of [
    { admitted: localDay(-5), discharged: localDay(-3), status: 'discharged' },
    { admitted: localDay(-5), discharged: null, status: 'cancelled' },
  ]) {
    const t = await startCrmApp();
    try {
      const y = localDay(-1);
      const rid = addLead(t.db, { status: 'scheduled', patient: 77, date: y, updated: agoIso(5) });
      addLine(t.db, rid, { svc: 30, day: y, doctor: 10, visit: oldVisit(t.db, y) });
      t.db.prepare('INSERT INTO admissions (patient_id, admitted_at, discharged_at, status) VALUES (77, ?, ?, ?)')
        .run(at(adm.admitted, 15), adm.discharged ? at(adm.discharged, 12) : null, adm.status);
      assert.deepEqual(crmNoShowSweep(t.db), [rid], JSON.stringify(adm));
    } finally { t.close(); }
  }
});

// ── A-P5 ────────────────────────────────────────────────────────────────────

test('P5 (A-P5): записан пять дней назад на вчера, пришёл сегодня — «Пришёл» и через стойку, и через мастер визита с оплатой', async () => {
  for (const viaDesk of [true, false]) {
    const t = await startCrmApp();
    try {
      const y = localDay(-1);
      const rid = addLead(t.db, { status: 'scheduled', patient: 77, date: y, updated: agoIso(5) });
      addLine(t.db, rid, { svc: 30, day: y, doctor: 10, visit: oldVisit(t.db, y) });
      assert.deepEqual(crmNoShowSweep(t.db), [rid]);
      const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', ...(viaDesk ? { desk: true } : {}) });
      assert.equal(e.status, 200, e.text);
      const vid = e.json.data.visit.id;
      const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
        values: { visit_id: vid, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
      assert.equal(ins.status, 200, ins.text);
      const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [ins.json.data.id], discount_amount: 0, payer_id: null });
      assert.equal(inv.status, 200, inv.text);
      const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: 100000, method: 'cash' });
      assert.equal(pay.status, 200, pay.text);
      assert.equal(t.lead(rid).status, 'came', `viaDesk=${viaDesk}: опоздавший на день остался «Не пришёл»`);
    } finally { t.close(); }
  }
});

test('A-P5: пропущенный день давнее окна — поздний приход через мастер визита карточку не поднимает', async () => {
  const t = await startCrmApp();
  try {
    const d = localDay(-10);
    const rid = addLead(t.db, { status: 'scheduled', patient: 77, date: d, updated: agoIso(12) });
    addLine(t.db, rid, { svc: 30, day: d, doctor: 10, visit: oldVisit(t.db, d) });
    assert.deepEqual(crmNoShowSweep(t.db), [rid]);
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient' });
    const vid = e.json.data.visit.id;
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [ins.json.data.id], discount_amount: 0, payer_id: null });
    await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: 40000, method: 'cash' });
    assert.equal(t.lead(rid).status, 'no_show');
  } finally { t.close(); }
});

// ── A-C2 ────────────────────────────────────────────────────────────────────

test('Q1-a2 (A-C2): запись календарём при строке «когда придёт» — регистратура ставит ту же услугу: строка карточки занята, второй нет; следующая запись консультацию не получает', async () => {
  const t = await startCrmApp();
  try {
    const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status: 'in_process', source: 'call' } });
    assert.equal(r.status, 200, r.text);
    const rid = r.json.data.id;
    await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: [{ request_id: rid, service_id: 30, scheduled_date: null, doctor_id: 10, status: 'pending' }] });
    const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
    const start = (d.getDate() === new Date().getDate()) ? d.toISOString() : at(TODAY, 8);
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start, duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    const v1 = b.json.data.visit.id;
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: v1, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    const own = linesOfReq(t.db, rid);
    assert.equal(own.length, 1, 'сверка завела вторую строку той же услуги: ' + JSON.stringify(own));
    assert.deepEqual([own[0].visit_id, own[0].visit_service_id], [v1, ins.json.data.id], 'строка «когда придёт» не взяла строку визита');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v1, visit_service_ids: vsOf(t.db, v1).map((x) => x.id), discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(inv.json.data.invoice.total_amount), 100000, 'одна консультация — один счёт');
    await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: 100000, method: 'cash' });
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(linesOfReq(t.db, rid).map((l) => l.status), ['done']);
    const s2 = at(localDay(7), 11);
    const e2 = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: s2, doctor_id: 10, book: { doctor_id: 10, start: s2, duration_minutes: 30 } });
    assert.equal(e2.status, 200, e2.text);
    assert.deepEqual(vsOf(t.db, e2.json.data.visit.id), [], 'оплаченная консультация снова встала в следующую запись');
  } finally { t.close(); }
});

test('A-C2: строка без врача берёт строку визита с врачом (тот же двойник); строка ДРУГОГО дня не берётся — заводится своя', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'scheduled', patient: 77, assigned: 3 });
    const undated = addLine(t.db, rid, { svc: 30, day: null, doctor: null });
    const later = addLine(t.db, rid, { svc: 40, day: localDay(5) });
    const start = at(localDay(1), 10);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start, duration_minutes: 30 });
    const vid = b.json.data.visit.id;
    t.db.prepare("INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    const consult = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    const lab = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
    const rows = linesOfReq(t.db, rid);
    const byId = new Map(rows.map((l) => [l.id, l]));
    assert.deepEqual([byId.get(undated).visit_id, byId.get(undated).visit_service_id, byId.get(undated).scheduled_date],
      [vid, consult.json.data.id, localDay(1)], 'строка «когда придёт» без врача не взяла консультацию');
    assert.deepEqual([byId.get(later).visit_id, byId.get(later).visit_service_id], [null, null], 'строка другого дня уехала в этот визит');
    assert.equal(rows.length, 3, 'анализ этого визита не отражён своей строкой');
    assert.equal(rows.find((l) => ![undated, later].includes(l.id)).visit_service_id, lab.json.data.id);
  } finally { t.close(); }
});

test('A-C2: строка, добавленная кассой сразу в счёт, тоже берёт ждущую строку карточки', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'scheduled', patient: 77, assigned: 3 });
    const undated = addLine(t.db, rid, { svc: 40, day: null });
    const start = at(TODAY, 18);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start, duration_minutes: 30 });
    const vid = b.json.data.visit.id;
    t.db.prepare("INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    const inv = Number(t.db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, 77, 40000, 0, 'unpaid')").run(vid).lastInsertRowid);
    const item = Number(t.db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price) VALUES (?, 40, 'Анализ', 1, 40000)").run(inv).lastInsertRowid);
    const x = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, invoice_item_id) VALUES (?, 40, 1, 40000, 40000, 'queued', ?)").run(vid, item).lastInsertRowid);
    const id = mirrorCashierLine(t.db, x);
    assert.equal(id, undated, 'касса завела вторую строку заявки');
    const rows = linesOfReq(t.db, rid);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].visit_id, rows[0].visit_service_id], [vid, x]);
  } finally { t.close(); }
});

// ── «Не пришёл»: родственник на том же номере (итоговая проверка, N1) ───────
// CRM_UNIFY_V1 — строгий ключ связи (phoneMatchKey) не даёт ключа номерам +7 и
// номерам с пометкой буквами, и проверка «в тот день пришёл кто-то с этого
// номера» пропускалась — карточку метили «Не пришёл». У прохода свой МЯГКИЙ
// ключ (цифры, буквы не мешают, 7–12 цифр, последние 9) по всем номерам карты:
// лишнее совпадение значит только «не ставить», а это безопасно.
for (const [label, phone] of [['+7 family number', '+7 916 123 45 67'], ['number with a note', '+998 90 909 26 38 (мама)'], ['uz number (control)', '+998 90 909 26 38']]) {
  test(`N1 no-show: relative on the same number (${label}) came on the booked day — card is not «Не пришёл»`, async () => {
    const t = await startCrmApp((db) => {
      db.prepare('UPDATE patients SET phone = ? WHERE id = 77').run(phone);
      db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Сын', ?)").run(phone);
    });
    try {
      const y = localDay(-1);
      const rid = addLead(t.db, { status: 'scheduled', patient: 77, date: y, updated: agoIso(5) });
      const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (78, 10, ?, 'arrived', 2)").run(at(y, 10)).lastInsertRowid);
      t.db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, 78, 100000, 100000, 'paid')").run(v);
      assert.deepEqual(crmNoShowSweep(t.db), [], 'family member came that day, card marked «Не пришёл»');
      assert.equal(t.lead(rid).status, 'scheduled');
    } finally { t.close(); }
  });
}

test('N1: номер семьи — во втором номере или в экстренном контакте любой из карт; посторонний номер — «Не пришёл»', async () => {
  for (const [p77, p78, want] of [
    [{ phone: '+998 90 909 26 38' }, { phone: '+998 91 000 00 01', phone_secondary: '909092638' }, 'scheduled'],
    [{ phone: '+998 91 000 00 02', emergency_contact_phone: '8 (90) 909-26-38' }, { phone: '90 909 26 38 мама' }, 'scheduled'],
    [{ phone: '+998 90 909 26 38' }, { phone: '+998 93 333 33 33' }, 'no_show'],
  ]) {
    const t = await startCrmApp((db) => {
      db.prepare('UPDATE patients SET phone = ?, phone_secondary = ?, emergency_contact_phone = ? WHERE id = 77')
        .run(p77.phone, p77.phone_secondary ?? '', p77.emergency_contact_phone ?? '');
      db.prepare("INSERT INTO patients (id, full_name, phone, phone_secondary) VALUES (78, 'Сын', ?, ?)").run(p78.phone, p78.phone_secondary ?? '');
    });
    try {
      const y = localDay(-1);
      const rid = addLead(t.db, { status: 'scheduled', patient: 77, date: y, updated: agoIso(5) });
      const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (78, 10, ?, 'arrived', 2)").run(at(y, 10)).lastInsertRowid);
      t.db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, paid_amount, status) VALUES (?, 78, 100000, 100000, 'paid')").run(v);
      crmNoShowSweep(t.db);
      assert.equal(t.lead(rid).status, want, JSON.stringify([p77, p78]));
    } finally { t.close(); }
  }
});
