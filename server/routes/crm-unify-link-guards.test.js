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
    // CRM_UNIFY_V1 (финальное ревью, A-C1) — имя заявки — номер (так звонок
    // называет незнакомца): имени, которое могло бы не совпасть, нет.
    const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4, name: '909092638' });
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

// CRM_UNIFY_V1 (финальное ревью, A-C1) — прежнее правило «самая новая из двух»
// отдавало маме заявку сына: две открытые карточки на один номер — это почти
// всегда семья. Теперь ни одной: их разбирает оператор.
test('по телефону: две открытые карточки на номер — не привязывается ни одна', async () => {
  const t = await startCrmApp();
  try {
    const older = addLead(t.db, { patient: null, phone: '909092638', assigned: 3, name: '909092638', updated: daysAgoIso(2) });
    const newer = addLead(t.db, { patient: null, phone: '+998909092638', assigned: 4, name: '998909092638' });
    const b = await book(t, 'reg', D, 9);
    assert.equal(b.status, 200, b.text);
    for (const id of [older, newer]) {
      assert.deepEqual([t.lead(id).patient_id, t.lead(id).status], [null, 'in_process'], 'две карточки на номер, а одну отдали записанному');
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (ревью 3) — ОДНО СТРОГОЕ ПРАВИЛО НОМЕРА вместо разрезания поля:
// поле — ОДИН номер, только если в нём 7–12 цифр; ключ — последние 9 цифр;
// заявка и ОСНОВНОЙ номер записанного — оба один номер с равным ключом; владельцы
// ключа — ровно {записанный}. Два номера в поле и добавочный автоматически не
// связываются никогда — это делает оператор руками.
// ═══════════════════════════════════════════════════════════════════════════

const NBSP = '\u00a0';
const NDASH = '\u2013';
for (const [label, leadPhone] of [
  ['второй номер через неразрывные пробелы (D1)', `909092638, 91${NBSP}111${NBSP}11${NBSP}11`],
  ['второй номер через короткое тире (D1)', `909092638, 91${NDASH}111${NDASH}11${NDASH}11`],
  ['два номера через пробел', '909092638 911111111'],
  ['добавочный', '+998 90 909 26 38 доб. 12'],
]) {
  test(`заявка «${label}» к записи мамы не цепляется`, async () => {
    const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Ребёнок','+998 91 111 11 11')").run());
    try {
      const rid = addLead(t.db, { patient: null, phone: leadPhone, assigned: 4 });
      addLine(t.db, rid, { svc: 40, day: D });
      const b = await book(t, 'reg', D, 9);
      assert.equal(b.status, 200, b.text);
      const r = await followUp(t, 'ensure_visit', b.json.data.visit.id, D);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([t.lead(rid).patient_id, t.lead(rid).status], [null, 'in_process'], 'поле не из одного номера связано автоматически');
      assert.ok(!vsOf(t.db, b.json.data.visit.id).some((x) => x.service_id === 40), 'услуга заявки встала в счёт мамы');
    } finally { t.close(); }
  });
}

// CRM_UNIFY_V1 (финальное ревью, B) — иностранный номер (+7 …, 8 + десять
// цифр) ключа не даёт вовсе: автоматической связи нет, даже если номер у
// одной карты. Связывает оператор.
test('+7 и 8 одного российского номера (D2): ключа нет — заявка не связывается ни с братом, ни без него', async () => {
  let t = await startCrmApp((db) => {
    db.prepare("UPDATE patients SET phone = '+7 916 123 45 67' WHERE id = 77").run();
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','8 (916) 123-45-67')").run();
  });
  try {
    const rid = addLead(t.db, { patient: null, phone: '79161234567', assigned: 4 });
    assert.equal((await book(t, 'reg', D, 9)).status, 200);
    assert.equal(t.lead(rid).patient_id, null, 'номер брата в форме «8 …» не посчитан');
  } finally { t.close(); }
  t = await startCrmApp((db) => db.prepare("UPDATE patients SET phone = '+7 916 123 45 67' WHERE id = 77").run());
  try {
    const rid = addLead(t.db, { patient: null, phone: '8 916 123 45 67', assigned: 4, name: '89161234567' });
    assert.equal((await book(t, 'reg', D, 9)).status, 200);
    assert.deepEqual([t.lead(rid).patient_id, t.lead(rid).status], [null, 'in_process'], 'иностранный номер связан автоматически');
  } finally { t.close(); }
});

test('два номера через пробел (D3): у записанного — не один номер; у брата — владелец', async () => {
  let t = await startCrmApp((db) => {
    db.prepare("UPDATE patients SET phone = '909092638 911111111' WHERE id = 77").run();
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','+998 90 909 26 38')").run();
  });
  try {
    const ids = ['909092638 911111111', '909092638'].map((phone) => addLead(t.db, { patient: null, phone, assigned: 4 }));
    assert.equal((await book(t, 'reg', D, 9)).status, 200);
    for (const id of ids) assert.equal(t.lead(id).patient_id, null, t.lead(id).phone);
  } finally { t.close(); }
  t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','909092638 911111111')").run());
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4 });
    assert.equal((await book(t, 'reg', D, 9)).status, 200);
    assert.equal(t.lead(rid).patient_id, null, 'брат с двумя номерами через пробел не посчитан владельцем');
  } finally { t.close(); }
});

test('опекунство без номера в строке (D5): ребёнок, чья мама — опекун-карта, — владелец её номера', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Ребёнок','')").run();
    db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id, name, relationship) VALUES (78, 77, 'Мама', 'мать')").run();
  });
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4, name: 'Звонок о ребёнке' });
    addLine(t.db, rid, { svc: 40, day: D });
    const b = await book(t, 'reg', D, 9);
    assert.equal(b.status, 200, b.text);
    await followUp(t, 'booking_lines_add', b.json.data.visit.id, D);
    assert.equal(t.lead(rid).patient_id, null, 'звонок о ребёнке ушёл на карту мамы');
    assert.ok(!vsOf(t.db, b.json.data.visit.id).some((x) => x.service_id === 40));
  } finally { t.close(); }
});

// D4 — дата карточки: ОДНА функция для шага G и сверки зеркала (cardDateOf).
// Незаписанная строка завтра, консультация на D: запись D, затем по кругу
// ensure_visit, перенос внутри D и booking_lines_add — дата стоит на D, след
// отмены не растёт.
test('дата карточки не прыгает: ensure_visit, перенос в календаре и booking_lines_add по кругу', async () => {
  const t = await startCrmApp();
  try {
    const T1 = localDay(1);
    const rid = addLead(t.db, { assigned: 3, date: T1 });
    addLine(t.db, rid, { svc: 40, day: T1 });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    const b = await book(t, 'reg', D, 9, { service_id: 30 });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const undo = () => t.db.prepare('SELECT COUNT(*) n FROM crm_booking_undo').get().n;
    assert.equal(t.lead(rid).scheduled_date, D);
    const was = undo();
    for (let i = 0; i < 3; i++) {
      const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: D, doctor_id: 10 });
      assert.equal(e.status, 200, e.text);
      assert.equal(t.lead(rid).scheduled_date, D, `клик ${i + 1}: ensure_visit`);
      const mv = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(D, 10 + i), duration_minutes: 30 });
      assert.equal(mv.status, 200, mv.text);
      assert.equal(t.lead(rid).scheduled_date, D, `клик ${i + 1}: перенос`);
      const add = await t.rpc('booking_lines_add', 'reg', { visit_id: vid, patient_id: 77, lines: [{ service_id: 40, doctor_id: 10 }] });
      assert.equal(add.status, 200, add.text);
      assert.equal(t.lead(rid).scheduled_date, D, `клик ${i + 1}: booking_lines_add`);
    }
    assert.equal(undo(), was, 'двери по кругу копят след отмены — дата прыгает');
  } finally { t.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (финальное ревью) — деньги и номер: семья на одном номере,
// имя заявки, строки «без даты» закрытых карточек, номера не по образцу,
// «Родственники», хозяин новой карточки.
// ═══════════════════════════════════════════════════════════════════════════
const nowIso = () => new Date().toISOString();
const hoursAgoIso = (h) => new Date(Date.now() - h * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A-C1 (P2): две заявки на семейный номер — мамина и сына. Мама заводит карту
// и регистрируется на стойке: заявка сына не уходит к маме, его анализ — не в её визит.
test('A-C1: мама и сын на одном номере — новая карта мамы и стойка не берут ни одной заявки', async () => {
  const t = await startCrmApp((db) => db.prepare("UPDATE patients SET phone = '+998 91 000 00 01' WHERE id = 77").run());
  try {
    const mom = addLead(t.db, { patient: null, phone: '+998 90 909 26 38', name: 'Мама Каримова', updated: hoursAgoIso(2) });
    addLine(t.db, mom, { svc: 30, day: TODAY, doctor: 10 });
    const kid = addLead(t.db, { patient: null, phone: '+998 90 909 26 38', name: 'Сын Каримов' });
    addLine(t.db, kid, { svc: 40, day: TODAY });
    const p = await t.dbq('reg', { table: 'patients', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Мама Каримова', phone: '+998 90 909 26 38' } });
    assert.equal(p.status, 200, p.text);
    const pid = p.json.data.id;
    assert.equal((await t.rpc('crm_link_new_patient', 'reg', { patient_id: pid })).status, 200);
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: pid, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(e.status, 200, e.text);
    assert.deepEqual([t.lead(mom).patient_id, t.lead(kid).patient_id], [null, null], 'семейный номер отдал заявку одной из карт');
    assert.ok(!vsOf(t.db, e.json.data.visit.id).some((x) => x.service_id === 40), 'анализ сына встал в визит мамы');
  } finally { t.close(); }
});

// A-C1 (P2b): одна заявка о ребёнке без карты; номер — мамин. Имя заявки — не
// мамино: не связывается, и вторая дверь того же дня анализ в её визит не ставит.
test('A-C1: заявка с чужим именем на номер мамы — не к маме; вторая дверь анализ в её визит не ставит', async () => {
  const t = await startCrmApp();
  try {
    const kid = addLead(t.db, { patient: null, phone: '909092638', name: 'Сын (без карты)' });
    addLine(t.db, kid, { svc: 40, day: TODAY });
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(e.status, 200, e.text);
    const e2 = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(e2.status, 200, e2.text);
    assert.equal(t.lead(kid).patient_id, null, 'заявку о ребёнке отдали маме');
    assert.ok(!vsOf(t.db, e.json.data.visit.id).some((x) => x.service_id === 40), 'анализ ребёнка встал в визит мамы');
  } finally { t.close(); }
});

test('A-C1: имя заявки совпадает с именем или фамилией карты (регистр, ё/е) — связь есть; другое письмо — нет', async () => {
  for (const [name, linked] of [['пациент', true], ['Тёст Иванович', true], ['Patsient Test', false], ['Мама', false], ['Ли', true]]) {
    const t = await startCrmApp((db) => db.prepare("UPDATE patients SET full_name = 'Пациент Тест' WHERE id = 77").run());
    try {
      const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 4, name });
      assert.equal((await book(t, 'reg', D, 9)).status, 200);
      assert.equal(t.lead(rid).patient_id, linked ? 77 : null, name);
    } finally { t.close(); }
  }
});

// A-C2 (Q1-a): строка «без даты» карточки, перетащенной в «Пришёл», в визит стойки
// не встаёт: «без даты» — только у живых карточек. Строка закрытой карточки НА
// ЭТОТ ДЕНЬ — встаёт (R3).
test('A-C2: строка «без даты» закрытой карточки не встаёт в визит; строка того же дня — встаёт', async () => {
  const t = await startCrmApp();
  try {
    const old = addLead(t.db, { status: 'in_process', patient: 77, assigned: 3 });
    const undatedLine = addLine(t.db, old, { svc: 30, day: null, doctor: 10 });
    const drag = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'came' }, filters: [{ col: 'id', op: 'eq', val: old }] });
    assert.equal(drag.status, 200, drag.text);
    t.db.prepare('UPDATE crm_requests SET updated_at = ?, created_at = ? WHERE id = ?').run(daysAgoIso(60), daysAgoIso(61), old);
    const won = addLead(t.db, { status: 'came', patient: 77, assigned: 3 });
    const todayLine = addLine(t.db, won, { svc: 40, day: TODAY });
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(e.status, 200, e.text);
    const vid = e.json.data.visit.id;
    assert.ok(!vsOf(t.db, vid).some((x) => x.service_id === 30), 'давняя консультация «без даты» закрытой карточки встала в счёт');
    assert.deepEqual(t.db.prepare('SELECT status, visit_id FROM crm_request_services WHERE id = ?').get(undatedLine), { status: 'pending', visit_id: null });
    assert.equal(t.db.prepare('SELECT visit_id FROM crm_request_services WHERE id = ?').get(todayLine).visit_id, vid,
      'строка закрытой карточки на этот день не дошла до визита (R3)');
  } finally { t.close(); }
});

// A-C2 (Q1-a2): консультация «без даты» записана колл-центром из календаря,
// пациент пришёл, оплатил; через неделю — новая запись: консультации в ней нет.
test('A-C2: консультация «без даты» оплачена в первом визите — следующая запись её второй раз не берёт', async () => {
  const t = await startCrmApp();
  try {
    const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status: 'in_process', source: 'call' } });
    assert.equal(r.status, 200, r.text);
    const rid = r.json.data.id;
    await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: [{ request_id: rid, service_id: 30, scheduled_date: null, doctor_id: 10, status: 'pending' }] });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(TODAY, 8), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    const v1 = b.json.data.visit.id;
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: v1, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    const ids = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ?').all(v1).map((x) => x.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v1, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: Number(inv.json.data.invoice.total_amount), method: 'cash' });
    assert.equal(pay.status, 200, pay.text);
    assert.equal(t.lead(rid).status, 'came');
    const s2 = at(localDay(7), 11);
    const e2 = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: s2, doctor_id: 10, book: { doctor_id: 10, start: s2, duration_minutes: 30 } });
    assert.equal(e2.status, 200, e2.text);
    assert.ok(!vsOf(t.db, e2.json.data.visit.id).some((x) => x.service_id === 30), 'консультация выставлена второй раз');
  } finally { t.close(); }
});

// B: номера, которые раньше давали ключ чужого номера (последние 9 цифр сдвигались).
for (const [label, leadPhone, strangerPhone] of [
  ['добавочный «90 912 34 56 доб. 78»', '90 912 34 56 доб. 78', '+998 91 234 56 78'],
  ['городской с добавочным «71 207 12 34 доб 56»', '71 207 12 34 доб 56', '+998 20 712 34 56'],
  ['+998 без двух цифр «+998 90 123 45»', '+998 90 123 45', '+998 98 901 23 45'],
  ['российский «+7 (990) 123-45-67»', '+7 (990) 123-45-67', '+998 90 123 45 67'],
]) {
  test(`номер не по образцу (${label}) не связывает заявку с посторонним`, async () => {
    const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80,'Посторонний',?)").run(strangerPhone));
    try {
      const rid = addLead(t.db, { patient: null, phone: leadPhone, assigned: 4, name: leadPhone.replace(/\D/g, '') });
      addLine(t.db, rid, { svc: 40, day: D });
      assert.equal((await t.rpc('calendar_book', 'reg', { patient_id: 80, doctor_id: 10, start: at(D, 9), duration_minutes: 30 })).status, 200);
      const e = await t.rpc('ensure_visit', 'reg', { patient_id: 80, date: D });
      assert.equal(e.status, 200, e.text);
      assert.equal(t.lead(rid).patient_id, null, 'заявка связана с посторонним');
      assert.ok(!vsOf(t.db, e.json.data.visit.id).some((x) => x.service_id === 40), 'услуга заявки встала в счёт постороннего');
    } finally { t.close(); }
  });
}

// B: «Родственники» карточки пациента (patient_relationships) — связь владельцев
// номера, как опекунство: мама и ребёнок связаны — заявка о ребёнке маме не идёт.
test('B: мама и ребёнок связаны в «Родственниках» или опекунством — заявка на мамин номер ни к кому', async () => {
  for (const table of ['patient_relationships', 'patient_relationships_reverse', 'patient_guardians']) {
    const t = await startCrmApp((db) => {
      db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (82,'Мама','+998 93 111 22 33')").run();
      db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (83,'Ребёнок','')").run();
      if (table === 'patient_relationships') db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (82, 83, 'parent')").run();
      else if (table === 'patient_relationships_reverse') db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (83, 82, 'child')").run();
      else db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id, name, phone) VALUES (83, 82, 'Мама', NULL)").run();
    });
    try {
      const rid = addLead(t.db, { patient: null, phone: '931112233', assigned: 4, name: '931112233' });
      addLine(t.db, rid, { svc: 40, day: D });
      assert.equal((await t.rpc('calendar_book', 'reg', { patient_id: 82, doctor_id: 10, start: at(D, 9), duration_minutes: 30 })).status, 200);
      assert.equal(t.lead(rid).patient_id, null, table);
    } finally { t.close(); }
  }
});

// B: шаг E не делает хозяином новой карточки того, кто не может её вести
// (наблюдатель CRM): карточка заводится, но ничья.
test('B: наблюдатель CRM записывает пациента без карточки — карточка ничья, не его', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('cc_view', 'КЦ просмотр', 'callcenter')").run();
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('cc_view', JSON.stringify({ sections: ['crm'], levels: { crm: 'viewer' } }));
    db.prepare("UPDATE users SET custom_role_code = 'cc_view' WHERE id = 4").run();
  });
  try {
    const b = await t.rpc('calendar_book', 'cc2', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    const card = t.db.prepare('SELECT id, assigned_to, created_by FROM crm_requests WHERE patient_id = 77').get();
    assert.ok(card, 'карточка не заведена');
    assert.deepEqual([card.assigned_to, card.created_by], [null, 4], 'наблюдатель стал хозяином карточки');
  } finally { t.close(); }
});
