// CRM_UNIFY_V1 (ревью задачи 1) — СТОРОЖА ШАГА СВЯЗИ ВИЗИТА С CRM (crm/visit-link.js),
// найденные атакой ревью: телефон и чужой счёт, отмеченный приход, прошедшая
// дата, строки «без даты», повтор, сбой и ответ двери. Всё — через настоящие
// двери /api/rpc под настоящими ролями.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { crmLinkVisit } from '../services/crm/visit-link.js';

const D = localDay(3);
const D2 = localDay(5);
const TODAY = localDay(0);
const vsOf = (db, vid) => db.prepare('SELECT service_id, doctor_id, status FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const book = (t, who, day, hh, extra = {}) =>
  t.rpc('calendar_book', who, { patient_id: 77, doctor_id: 10, start: at(day, hh), duration_minutes: 30, ...extra });
const followUp = (t, door, vid, day) => (door === 'ensure_visit'
  ? t.rpc('ensure_visit', 'reg', { patient_id: 77, date: day, doctor_id: 10 })
  : t.rpc('booking_lines_add', 'reg', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] }));

// ── Телефон. Совпадение по номеру пишет только patient_id; следующая дверь уже
//    видит карточку пациента и ведёт её строки в запись. Поэтому «номер у ОДНОЙ
//    карты» и есть защита денег: ошибка в нём ставит услуги в чужой счёт.

for (const door of ['ensure_visit', 'booking_lines_add']) {
  test(`по телефону, номер у одной карты: следующая дверь (${door}) ведёт строки карточки в запись`, async () => {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4, name: '909092638' });
      addLine(t.db, rid, { svc: 40, day: D });
      const b = await book(t, 'reg', D, 9);
      assert.equal(b.status, 200, b.text);
      const vid = b.json.data.visit.id;
      assert.equal(t.lead(rid).patient_id, 77);
      assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null], 'первая дверь: совпадение по телефону взяло строку');
      const r = await followUp(t, door, vid, D);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(linesOf(t.db, rid).filter((l) => l.service_id === 40).map((l) => l.visit_id), [vid]);
      assert.ok(vsOf(t.db, vid).some((x) => x.service_id === 40), 'строка карточки не встала в запись');
    } finally { t.close(); }
  });
}

for (const [label, seed] of [
  ['два номера в одном поле у брата', (db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','+998 90 909 26 38, +998 91 111 11 11')").run()],
  ['второй номер карты мамы', (db) => db.prepare("INSERT INTO patients (id, full_name, phone, phone_secondary) VALUES (78,'Мама','+998 91 000 00 00','0909092638')").run()],
  // CRM_UNIFY_V1 (ревью 2, F1) — у карты ребёнка своего номера нет (поле не
  // обязательное), номер мамы — только экстренный контакт или номер опекуна.
  ['номер мамы — экстренный контакт карты ребёнка', (db) => db.prepare("INSERT INTO patients (id, full_name, phone, emergency_contact_phone) VALUES (78,'Ребёнок','','+998 90 909 26 38')").run()],
  ['номер мамы — номер опекуна карты ребёнка', (db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Ребёнок','')").run();
    db.prepare("INSERT INTO patient_guardians (patient_id, name, relationship, phone) VALUES (78,'Мама','мать','+998 90 909 26 38')").run();
  }],
]) {
  for (const door of ['ensure_visit', 'booking_lines_add']) {
    test(`по телефону, общий номер (${label}): ни первая дверь, ни следующая (${door}) не цепляют карточку`, async () => {
      const t = await startCrmApp(seed);
      try {
        const rid = addLead(t.db, { patient: null, phone: '+998 90 909 26 38', assigned: 4 });
        addLine(t.db, rid, { svc: 40, day: D });
        const b = await book(t, 'reg', D, 9);
        assert.equal(b.status, 200, b.text);
        const vid = b.json.data.visit.id;
        const r = await followUp(t, door, vid, D);
        assert.equal(r.status, 200, r.text);
        assert.deepEqual([t.lead(rid).patient_id, t.lead(rid).status], [null, 'in_process'], 'общий номер привязал карточку к одной из карт');
        assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null]);
        assert.ok(!vsOf(t.db, vid).some((x) => x.service_id === 40), 'услуга чужой карточки встала в счёт пациента 77');
      } finally { t.close(); }
    });
  }
}

// CRM_UNIFY_V1 (ревью 2, F4) — основной номер записанного записан не по образцу:
// «8 90 …» (междугородняя восьмёрка) или два номера в одном поле. Ключи берутся
// у КАЖДОГО номера поля, приведённого к местным девяти цифрам, и у каждого
// считаются владельцы; хоть у одного есть второй владелец — совпадения нет.
for (const [label, own, sibling, leads] of [
  ['«8 90 …» у записанного, брат «90 …»', '8 90 909 26 38', '90 909 26 38', ['8 90 909 26 38', '909092638']],
  ['два номера в поле записанного, брат на втором', '+998 90 909 26 38, +998 91 111 11 11', '+998 91 111 11 11',
    ['909092638', '+998 90 909 26 38, +998 91 111 11 11']],
]) {
  test(`по телефону, ${label}: номер не одной карты — заявки не трогаются`, async () => {
    const t = await startCrmApp((db) => {
      db.prepare('UPDATE patients SET phone = ? WHERE id = 77').run(own);
      db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат',?)").run(sibling);
    });
    try {
      const ids = leads.map((phone) => addLead(t.db, { patient: null, phone, assigned: 4 }));
      const b = await book(t, 'reg', D, 9);
      assert.equal(b.status, 200, b.text);
      for (const id of ids) assert.equal(t.lead(id).patient_id, null, 'заявка ушла записанному, хотя номер есть у брата: ' + t.lead(id).phone);
    } finally { t.close(); }
  });
}

test('по телефону: «8 90 …» у записанного и «909092638» в заявке — один номер, если он у одной карты', async () => {
  const t = await startCrmApp((db) => db.prepare("UPDATE patients SET phone = '8 90 909 26 38' WHERE id = 77").run());
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4 });
    const b = await book(t, 'reg', D, 9);
    assert.equal(b.status, 200, b.text);
    assert.deepEqual([t.lead(rid).patient_id, t.lead(rid).status], [77, 'scheduled']);
  } finally { t.close(); }
});

test('по телефону ищется только ОСНОВНОЙ номер записанного: его второй номер (мамин) карточку мамы не берёт', async () => {
  const t = await startCrmApp((db) => db.prepare("UPDATE patients SET phone_secondary = '+998 93 333 33 33' WHERE id = 77").run());
  try {
    const rid = addLead(t.db, { patient: null, phone: '933333333', assigned: 4, name: 'Мама (звонила о себе)' });
    const b = await book(t, 'reg', D, 9);
    assert.equal(b.status, 200, b.text);
    assert.deepEqual([t.lead(rid).patient_id, t.lead(rid).status], [null, 'in_process']);
  } finally { t.close(); }
});

test('по телефону — не больше ОДНОЙ карточки: две открытые на номер — берётся самая новая, вторая остаётся операторам', async () => {
  const t = await startCrmApp();
  try {
    const older = addLead(t.db, { patient: null, phone: '909092638', assigned: 3, name: 'звонок 1', updated: daysAgoIso(2) });
    const newer = addLead(t.db, { patient: null, phone: '+998909092638', assigned: 4, name: 'звонок 2' });
    const b = await book(t, 'reg', D, 9);
    assert.equal(b.status, 200, b.text);
    assert.deepEqual([t.lead(newer).patient_id, t.lead(newer).status], [77, 'scheduled']);
    assert.deepEqual([t.lead(older).patient_id, t.lead(older).status], [null, 'in_process'],
      'одна запись привязала две карточки — потом это две конверсии одного прихода');
  } finally { t.close(); }
});

test('по телефону: карточка другого пациента на том же номере и короткий номер не трогаются', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80,'Другой','+998 77 000 00 00')").run();
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (81,'Короткий','12345')").run();
  });
  try {
    const other = addLead(t.db, { patient: 80, phone: '909092638', assigned: 4 });
    const shortLead = addLead(t.db, { patient: null, phone: '12345' });
    assert.equal((await book(t, 'reg', D, 9)).status, 200);
    assert.equal((await t.rpc('calendar_book', 'reg', { patient_id: 81, doctor_id: 10, start: at(D, 11), duration_minutes: 30 })).status, 200);
    assert.deepEqual([t.lead(other).patient_id, t.lead(other).status], [80, 'in_process']);
    assert.equal(t.lead(shortLead).patient_id, null);
  } finally { t.close(); }
});

// ── Отмеченный приход. Визит дня уже «Пришёл»: строки этого дня всё равно берут
//    его (как прежде у ensure_visit) — и карточка закрывается правилом прихода.

test('визит дня уже «Пришёл»: ensure_visit без записи и с записью ведут строки дня в визит и закрывают карточку', async () => {
  const t = await startCrmApp();
  try {
    const first = addLead(t.db, { assigned: 3 });
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: TODAY, doctor_id: 10 });
    assert.equal(e.status, 200, e.text);
    const vid = e.json.data.visit.id;
    const when = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid).visit_date;
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, status: 'arrived', start: when });
    assert.equal(arr.status, 200, arr.text);
    assert.equal(t.lead(first).status, 'came');

    const second = addLead(t.db, { assigned: 4, name: 'Вторая' });
    addLine(t.db, second, { svc: 40, day: TODAY });
    const e2 = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: TODAY, doctor_id: 10 });
    assert.equal(e2.status, 200, e2.text);
    assert.equal(e2.json.data.visit.id, vid);
    assert.deepEqual(linesOf(t.db, second).map((l) => [l.status, l.visit_id]), [['done', vid]], 'строка дня не взяла пришедший визит');
    assert.equal(t.lead(second).status, 'came', 'пациент здесь, а карточка не закрылась');

    const third = addLead(t.db, { assigned: 4, name: 'Третья' });
    addLine(t.db, third, { svc: 30, day: TODAY, doctor: 10 });
    const e3 = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: TODAY, doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: when, duration_minutes: 30 } });
    assert.equal(e3.status, 200, e3.text);
    assert.equal(e3.json.data.reason, 'day_visit_busy');
    assert.deepEqual(linesOf(t.db, third).map((l) => [l.status, l.visit_id]), [['done', vid]]);
    assert.equal(t.lead(third).status, 'came');
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(vid).status, 'arrived');
  } finally { t.close(); }
});

// ── Дата карточки. Прошедшая дата «Перезвонить» не остаётся датой записанной
//    карточки: иначе обход доски наутро уносит её в «Не пришёл».

test('прошедшая дата карточки заменяется днём записи; будущая дата ждущей строки остаётся', async () => {
  const t = await startCrmApp();
  try {
    const recall = addLead(t.db, { status: 'recall', assigned: 3, date: localDay(-7) });
    let b = await book(t, 'reg', D, 9);
    assert.equal(b.status, 200, b.text);
    assert.deepEqual([t.lead(recall).status, t.lead(recall).scheduled_date], ['scheduled', D]);

    // Колл-центр берёт свежую карточку, ждущую другой день (шаг E), с прошедшей
    // датой звонка: её строка D2 визита не держит, и без новой даты обход доски
    // унёс бы карточку в «Не пришёл».
    t.db.prepare("UPDATE crm_requests SET status = 'came' WHERE id = ?").run(recall);
    const stale = addLead(t.db, { assigned: 3, date: localDay(-1) });
    addLine(t.db, stale, { svc: 40, day: D2 });
    b = await book(t, 'cc', localDay(2), 9);
    assert.equal(b.status, 200, b.text);
    assert.equal(t.db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ?').get(b.json.data.visit.id).request_id, stale);
    assert.deepEqual([t.lead(stale).status, t.lead(stale).scheduled_date], ['scheduled', localDay(2)], 'осталась вчерашняя дата');
    t.db.prepare("UPDATE crm_requests SET status = 'came' WHERE id = ?").run(stale);

    // Дата остаётся, только если на неё ждёт строка, которую держит живой визит.
    const ahead = addLead(t.db, { assigned: 3 });
    addLine(t.db, ahead, { svc: 40, day: localDay(1) });
    addLine(t.db, ahead, { svc: 30, day: localDay(4), doctor: 10 });
    b = await book(t, 'reg', localDay(1), 9);
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(ahead).scheduled_date, localDay(1));
    b = await book(t, 'reg', localDay(4), 9, { service_id: 30 });
    assert.equal(b.status, 200, b.text);
    assert.deepEqual([t.lead(ahead).status, t.lead(ahead).scheduled_date], ['scheduled', localDay(1)],
      'ближайший записанный день — завтра, а не день этой записи');
  } finally { t.close(); }
});

// CRM_UNIFY_V1 (ревью 2, F3) — будущая дата звонка, на которую ничто не записано,
// датой записанной карточки не остаётся: послезавтра обход унёс бы её в «Не пришёл».
test('«Перезвонить» завтра, строка на D+5, колл-центр записал на D+3 без услуги — дата карточки D+3', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', assigned: 3, date: localDay(1) });
    addLine(t.db, rid, { svc: 40, day: localDay(5) });
    const b = await book(t, 'cc', localDay(3), 9);
    assert.equal(b.status, 200, b.text);
    assert.equal(t.db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ?').get(b.json.data.visit.id).request_id, rid);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', localDay(3)]);
  } finally { t.close(); }
});

// CRM_UNIFY_V1 (ревью 2, F2) — прошедшая незаписанная строка не возвращает карточке
// прошедшую дату: сверка зеркала (touchRequest) берёт ближайшую ждущую строку
// с сегодняшнего дня, а нет такой — оставляет дату, поставленную записью.
test('строка прошлой недели не тянет дату назад: запись, повторные клики двери, добавление и снятие услуги', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: localDay(-6) });
    addLine(t.db, rid, { svc: 40, day: localDay(-6) });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    const b = await book(t, 'reg', D, 9, { service_id: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(rid).scheduled_date, D, 'сверка вернула прошедшую дату');
    const undo = () => t.db.prepare('SELECT COUNT(*) n FROM crm_booking_undo').get().n;
    const was = undo();
    for (let i = 0; i < 3; i++) {
      const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: D, doctor_id: 10 });
      assert.equal(e.status, 200, e.text);
      assert.equal(t.lead(rid).scheduled_date, D, 'дата прыгает на каждом клике двери');
    }
    assert.equal(undo(), was, 'клики двери копят след отмены');

    t.db.prepare("UPDATE crm_requests SET status = 'came' WHERE id = ?").run(rid);
    const cc = addLead(t.db, { assigned: 3, date: localDay(-6), updated: daysAgoIso(6), name: 'Колл-центр' });
    addLine(t.db, cc, { svc: 40, day: localDay(-6) });
    const b2 = await book(t, 'cc', D2, 9);
    assert.equal(b2.status, 200, b2.text);
    const vid = b2.json.data.visit.id;
    assert.equal(t.lead(cc).scheduled_date, D2);
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    assert.equal(add.status, 200, add.text);
    assert.equal(t.lead(cc).scheduled_date, D2, 'добавление услуги вернуло прошедшую дату');
    const vsId = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 30').get(vid).id;
    const del = await t.dbq('reg', { table: 'visit_services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: vsId }] });
    assert.equal(del.status, 200, del.text);
    assert.equal(t.lead(cc).scheduled_date, D2, 'снятие услуги вернуло прошедшую дату — наутро обход унесёт карточку в «Не пришёл»');
  } finally { t.close(); }
});

// ── Строки «без даты» («консультация, когда придёт») берёт только ensure_visit
//    (регистрация, мастер визита, «Записать на дату»), а не запись календаря.

test('строка без даты не встаёт в запись календаря и booking_lines_add; ensure_visit её берёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, doctor: 10 });
    const b = await book(t, 'reg', D2, 9, { service_id: 40, duration_minutes: 15 });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'reg', { visit_id: vid, patient_id: 77, lines: [{ service_id: 40 }] });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, null]], 'строка «когда придёт» встала в чужую запись');
    assert.ok(!vsOf(t.db, vid).some((x) => x.service_id === 30), 'консультация без даты попала в смету анализа');
    assert.equal(t.lead(rid).status, 'in_process');
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: D2, doctor_id: 10 });
    assert.equal(e.status, 200, e.text);
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.service_id === 30).map((l) => l.visit_id), [vid]);
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

// ── Повтор, перенос, ответ двери, сбой.

test('шаг дважды — ничего нового: одна карточка, одна привязка, ни строки следа сверх', async () => {
  const t = await startCrmApp();
  try {
    const b = await book(t, 'cc', D, 9);
    const vid = b.json.data.visit.id;
    const snap = () => JSON.stringify([
      t.db.prepare('SELECT id, status, scheduled_date FROM crm_requests').all(),
      t.db.prepare('SELECT visit_id, request_id, source, created_request FROM crm_booking_links').all(),
      t.db.prepare('SELECT COUNT(*) n FROM crm_booking_undo').get().n,
    ]);
    const before = snap();
    const CC = { id: 3, role: 'callcenter', extra_roles: [] };
    crmLinkVisit(t.db, vid, CC); crmLinkVisit(t.db, vid, CC, { undated: true });
    assert.equal(snap(), before);
  } finally { t.close(); }
});

test('перенос пустого визита дня записью календаря: строки дня берут его, без дублей', async () => {
  const t = await startCrmApp();
  try {
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: D, doctor_id: 10 });
    const vid = e.json.data.visit.id;
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    addLine(t.db, rid, { svc: 40, day: D });
    const b = await book(t, 'reg', D, 14, { service_id: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.data.visit.id, vid);
    assert.equal(b.json.data.moved, true);
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, vid], [40, vid]]);
    assert.deepEqual(vsOf(t.db, vid).map((r) => r.service_id), [30, 40]);
  } finally { t.close(); }
});

test('ответы ensure_visit и booking_lines_add не несут ничего о чужой карточке', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, name: 'Секретная Карточка' });
    addLine(t.db, rid, { svc: 40, day: D });
    const e = await t.rpc('ensure_visit', 'cc2', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(e.status, 200, e.text);
    const add = await t.rpc('booking_lines_add', 'cc2', { visit_id: e.json.data.visit.id, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    assert.equal(add.status, 200, add.text);
    for (const r of [e, add]) {
      assert.ok(!r.text.includes('Секретная'), r.text);
      assert.ok(!/request_id|crm_|"lead/i.test(r.text), 'в ответе двери сведения о заявке: ' + r.text);
    }
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.service_id === 40).map((l) => l.visit_id), [e.json.data.visit.id],
      'карточка А не узнала о записи оператора Б');
  } finally { t.close(); }
});

test('сбой внутри шага откатывает связь целиком, пишется в лог, запись проходит; следующая дверь чинит', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    t.db.exec("CREATE TRIGGER boom BEFORE UPDATE OF status ON crm_requests BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const errs = [];
    const orig = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
    let b;
    try { b = await book(t, 'reg', D, 9); } finally { console.error = orig; }
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null], 'половина связи осталась после сбоя');
    assert.deepEqual(vsOf(t.db, vid), []);
    assert.ok(errs.some((s) => s.includes('crm-link')), 'сбой не попал в лог');
    t.db.exec('DROP TRIGGER boom');
    const add = await t.rpc('booking_lines_add', 'reg', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.service_id === 40).map((l) => l.visit_id), [vid]);
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});
