// CRM_LINK_ALL_V1 (2026-10-16) — R5 (решение владельца D4, дефект G3): КАРТОЧКА ПО ТЕЛЕФОНУ
// ВИДИТ ВИЗИТ. Шаг D (visit-link.js) нашёл единственную карточку без пациента на основной
// номер записанного: теперь — и привязка записи (source 'phone'), и услуги визита строками
// карточки (визит → карточка). Её прежние строки в визит и счёт этой записью не идут
// (общий семейный номер — не общий счёт).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';

const D = localDay(3);

test('CRM_LINK_ALL_V1 R5: календарь регистратуры — карточка по телефону получает пациента, привязку и услугу визита; её строка в визит не идёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(t.lead(rid).patient_id, 77);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'phone' });
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.status, l.visit_id]), [[40, 'pending', null], [30, 'pending', vid]],
      'карточка не показывает услугу визита или её строка взяла визит');
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30], 'строка карточки по телефону попала в визит (общий номер — не общий счёт)');
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R5: стойка — карточка по телефону закрывается «Пришёл» с привязкой; её строка на сегодня в визит и счёт не идёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '+998 90 909 26 38', name: '' });
    addLine(t.db, rid, { svc: 40, day: localDay(0) });
    const { vid, ids } = await deskRegister(t, 'reg');
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'phone' });
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30], 'анализ карточки по телефону встал в визит');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 100000, 'в счёт попало чужое');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R5: номер у двух карт (семья) — ни пациента, ни привязки, ни строк', async () => {
  const t = await startCrmApp();
  try {
    t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Мама Тест', '+998 90 909 26 38')").run();
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(t.lead(rid).patient_id, null);
    assert.equal(link(t, vid), null);
    assert.deepEqual(linesOf(t.db, rid), []);
  } finally { t.close(); }
});
