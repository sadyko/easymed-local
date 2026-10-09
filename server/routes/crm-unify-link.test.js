// CRM_UNIFY_V1 — ОДНА ТОЧКА СВЯЗИ ВИЗИТА С CRM, проверенная через настоящие двери
// (/api/rpc под настоящими ролями): calendar_book, ensure_visit, booking_lines_add.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';

const D = localDay(3);
const D2 = localDay(5);

test('calendar_book: строки заявки этого дня берут визит — без дублей ни в заявке, ни в визите', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    addLine(t.db, rid, { svc: 40, day: D });
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 12), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, vid], [40, vid]],
      'строки дня не взяли визит: зеркало заведёт дубли, а наутро оплатившего унесёт в «Не пришёл»');
    const vs = t.db.prepare('SELECT service_id FROM visit_services WHERE visit_id = ? ORDER BY service_id').all(vid).map((r) => r.service_id);
    assert.deepEqual(vs, [30, 40], 'строки визита задвоились или не появились: ' + JSON.stringify(vs));
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

test('по телефону: лид из звонка без пациента получает пациента — и только его; строки и визит не трогаются', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4, name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: D });   // оператор Б уже назвал анализ на этот день
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    assert.equal(t.lead(rid).patient_id, 77, 'лид из звонка не узнал пациента по номеру');
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null], 'совпадение по телефону привязало строку к визиту');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(vid).n, 0,
      'совпадение по телефону поставило услугу в счёт');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_booking_links WHERE visit_id = ?').get(vid).n, 0);
  } finally { t.close(); }
});

test('по телефону — только если номер у ОДНОЙ карты: общий номер (и второй номер карты) не привязывает ничего', async () => {
  for (const seed of [
    (db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','998909092638')").run(),
    (db) => db.prepare("INSERT INTO patients (id, full_name, phone, phone_secondary) VALUES (78,'Мама','+998 91 000 00 00','0909092638')").run(),
  ]) {
    const t = await startCrmApp(seed);
    try {
      const rid = addLead(t.db, { patient: null, phone: '+998 90 909 26 38' });
      const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
      assert.equal(b.status, 200, b.text);
      assert.equal(t.lead(rid).patient_id, null, 'номер двух карт привязал лид к одной из них');
      assert.equal(t.lead(rid).status, 'in_process');
    } finally { t.close(); }
  }
});

// CRM_UNIFY_V1 (ревью задачи 1) — карточке 60 дней: прежний attachVisitToCrm брал
// у колл-центра только заявку моложе 30 дней и заводил дубль; шаг C берёт
// открытую карточку пациента, ждущую этот день, любой давности. CRM_UNIFY_V1
// (проверка ревью задачи 3, P3) — у карточки дата этого дня: без строк и без
// даты она ждала бы прихода только в окне повторного обращения (72 ч).
test('запись оператора Б двигает карточку оператора А на сервере, но ответ записи о ней молчит', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, name: 'Секретная Карточка', date: D, updated: daysAgoIso(60) });
    const b = await t.rpc('calendar_book', 'cc2', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(rid).status, 'scheduled', 'карточка не узнала о записи, потому что её ведёт другой оператор');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1, 'оператор Б завёл дубль карточки');
    assert.ok(!b.text.includes('Секретная'), 'ответ записи раскрыл чужую карточку: ' + b.text);
    assert.ok(!Object.keys(b.json.data).some((k) => /request|crm|lead/i.test(k)), 'в ответе записи появились сведения о заявке');
  } finally { t.close(); }
});

test('карточку, ждущую ДРУГОЙ день, сегодняшняя запись не двигает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { date: D2 });
    addLine(t.db, rid, { svc: 40, day: D2 });
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(rid).status, 'in_process');
    assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null]);
  } finally { t.close(); }
});

test('колл-центр без карточки у пациента заводит её: «Звонок», оператор — он же, «Записан», привязка created_request', async () => {
  const t = await startCrmApp();
  try {
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    const r = t.db.prepare('SELECT * FROM crm_requests').all();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].source, r[0].assigned_to, r[0].status, r[0].scheduled_date], ['call', 3, 'scheduled', D]);
    const link = t.db.prepare('SELECT * FROM crm_booking_links WHERE visit_id = ?').get(b.json.data.visit.id);
    assert.deepEqual([link.request_id, link.source, link.created_request], [r[0].id, 'callcenter', 1]);
  } finally { t.close(); }
});

test('регистратура: пациент без карточки карточку не получает (решение 2)', async () => {
  const t = await startCrmApp();
  try {
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 0);
  } finally { t.close(); }
});

test('booking_lines_add колл-центра к записи регистратуры находит открытую карточку пациента', async () => {
  const t = await startCrmApp();
  try {
    // CRM_UNIFY_V1 (P3) — карточка этого дня: давняя без строк и даты прихода не ждёт.
    const old = addLead(t.db, { date: D, updated: daysAgoIso(60) });
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 40 }] });
    assert.equal(add.status, 200, add.text);
    assert.equal(t.db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ?').get(vid).request_id, old);
    assert.deepEqual(linesOf(t.db, old).map((l) => [l.service_id, l.visit_id]), [[40, vid]], 'строка визита не отразилась в карточке');
  } finally { t.close(); }
});

// CRM_UNIFY_V1 (ревью задачи 1) — запись врача: та же дверь, то же правило, что у
// регистратуры (случай врача из прежнего R-I3 crm-calendar-mirror.test.js).
test('запись врача: пациент без карточки её не получает; открытая карточка без строк едет в «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const b1 = await t.rpc('calendar_book', 'doc', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b1.status, 200, b1.text);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 0, 'врач завёл карточку пришедшему без звонка');
    // CRM_UNIFY_V1 (P3) — карточка этого дня: давняя без строк и даты прихода не ждёт.
    const old = addLead(t.db, { date: D2, updated: daysAgoIso(60) });
    const b2 = await t.rpc('calendar_book', 'doc', { patient_id: 77, doctor_id: 10, start: at(D2, 9), duration_minutes: 30 });
    assert.equal(b2.status, 200, b2.text);
    assert.deepEqual([t.lead(old).status, t.lead(old).scheduled_date], ['scheduled', D2]);
    const link = t.db.prepare('SELECT request_id, source, created_request FROM crm_booking_links WHERE visit_id = ?').get(b2.json.data.visit.id);
    assert.deepEqual(link, { request_id: old, source: 'match', created_request: 0 });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1);
  } finally { t.close(); }
});

// CRM_UNIFY_V1 (ревью задачи 1) — шаг E: колл-центр берёт свежую (не старше
// CALLCENTER_ATTACH_DAYS) открытую карточку пациента, даже ждущую другой день;
// старше — заводит новую. Задача 6 заменит этот срок окном повторного обращения.
test('колл-центр: карточка, ждущая другой день, моложе 30 дней — та же; старше — новая', async () => {
  for (const [age, cards, same] of [[10, 1, true], [40, 2, false]]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { assigned: 3, date: D2, updated: daysAgoIso(age) });
      addLine(t.db, rid, { svc: 40, day: D2 });
      const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
      assert.equal(b.status, 200, b.text);
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, cards, `карточке ${age} дн.`);
      const link = t.db.prepare('SELECT request_id, source, created_request FROM crm_booking_links WHERE visit_id = ?').get(b.json.data.visit.id);
      assert.equal(link.request_id === rid, same, `карточке ${age} дн.: привязка ${JSON.stringify(link)}`);
      assert.equal(link.source, 'callcenter');
      assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null], 'строка другого дня взяла визит');
    } finally { t.close(); }
  }
});
