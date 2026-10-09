// CRM_UNIFY_V1 — шаг связи визита с CRM как функция: то, что двери не покажут.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmLinkVisit, patientIdsWithPhoneKey, phoneMatchKey, leadNameFits } from './visit-link.js';
import { touchRequest } from './booking-mirror.js';
import { localDay } from '../../test-helpers/crm-unify-app.js';

const REG = { id: 1, role: 'registrar', extra_roles: [] };
function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Рег','registrar')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент','+998 90 909 26 38')").run();
  return db;
}
const addVisit = (db, { day = '2026-12-01', origin = null } = {}) =>
  Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (77, ?, 'scheduled', ?)").run(day + 'T05:00:00Z', origin).lastInsertRowid);
const addReq = (db, status = 'in_process') =>
  Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид','x',?,77)").run(status).lastInsertRowid);

test('визит, приехавший из другого здания, шаг не трогает: связь — в здании записи', () => {
  const db = freshDb();
  const rid = addReq(db);
  crmLinkVisit(db, addVisit(db, { origin: 'B' }), REG);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'in_process');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_booking_links').get().n, 0);
  db.close();
});

test('шаг не бросается: мусор, несуществующий визит, пустая воронка', () => {
  const db = freshDb();
  assert.doesNotThrow(() => crmLinkVisit(db, 'x', REG));
  assert.doesNotThrow(() => crmLinkVisit(db, 999, REG));
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM crm_stages').run();
  assert.doesNotThrow(() => crmLinkVisit(db, addVisit(db), REG));
  db.close();
});

test('номер короче 7 цифр — не личность: совпадений нет', () => {
  const db = freshDb();
  assert.deepEqual(patientIdsWithPhoneKey(db, '638'), []);
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638'), [77]);
  db.close();
});

// CRM_UNIFY_V1 (ревью задачи 1) — владельцы номера считаются С ЗАПАСОМ: карта,
// в поле которой номер лежит вторым («…, +998 90 909 26 38») или вторым номером
// карты, — тоже владелец. Лишний владелец только делает совпадение реже.
test('владельцы номера: два номера в одном поле и второй номер карты считаются', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','+998 91 111 11 11, +998 90 909 26 38')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone, phone_secondary) VALUES (79,'Мама','+998 91 000 00 00','0909092638')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80,'Чужой','+998 90 909 26 39')").run();
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638').sort(), [77, 78, 79]);
  db.close();
});

test('отменённый и неявочный визит шаг не трогает: строки дня ждут живой записи', () => {
  const db = freshDb();
  for (const status of ['cancelled', 'no_show']) {
    const rid = addReq(db);
    db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, NULL, '2026-12-01', 'pending')").run(rid);
    const vid = addVisit(db);
    db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(status, vid);
    crmLinkVisit(db, vid, REG, { undated: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services WHERE visit_id = ?').get(vid).n, 0, status);
    assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'in_process', status);
  }
  db.close();
});

// CRM_UNIFY_V1 (ревью 2, F1) — владелец номера и тот, у кого он записан
// экстренным контактом или номером опекуна (карта ребёнка без своего номера).
test('владельцы номера: экстренный контакт и опекун карты тоже считаются', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name, phone, emergency_contact_phone) VALUES (81,'Ребёнок','','+998 90 909 26 38')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (82,'Внук','')").run();
  db.prepare("INSERT INTO patient_guardians (patient_id, name, phone) VALUES (82,'Бабушка','8 90 909 26 38')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (83,'Опекун-карта','+998 99 999 99 99')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (84,'Подопечный','')").run();
  db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id, phone) VALUES (84, 83, '909092638')").run();
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638').sort((a, b) => a - b), [77, 81, 82, 83, 84]);
  db.close();
});

// CRM_UNIFY_V1 (ревью 3) — ОДНО СТРОГОЕ ПРАВИЛО НОМЕРА заменило разрезание поля
// на номера (phoneKeysOf, ревью 2): разрезание ошибалось на неразрывных пробелах,
// тире и номерах через пробел. Поле — ОДИН номер, только если в нём 7–12 цифр;
// ключ — последние 9 цифр; короче 9 — ключа нет.
// CRM_UNIFY_V1 (финальное ревью, B) — правило строже: ключ даёт только ЦЕЛЫЙ
// узбекский номер (9 цифр; 0 + 9; 8 + 9; 998 + 9), без единой буквы. Текст
// («тел: … (мама)»), добавочный и иностранный номер (+7 …) ключа не дают:
// последние 9 цифр такого поля — часто чужой номер.
test('phoneMatchKey: целый узбекский номер в любом виде — ключ из 9 цифр; буквы, иностранный, неполный — нет', () => {
  for (const f of ['+998 90 909 26 38', '+998 (90) 909-26-38', '998909092638', '0909092638', '8 90 909 26 38',
    '90.909.26.38', '+998(90)9092638', ' +998 90 909 26 38 ', '+998\t90\t909\t26\t38', '+ 998 90 909 26 38',
    '+998\u00a090\u00a0909\u00a026\u00a038', '+998 90\u2013909\u201326\u201338', '909092638', '8-90-909-26-38']) {
    assert.equal(phoneMatchKey(f), '909092638', JSON.stringify(f));
  }
  for (const f of ['+998 90 909 26 38, +998 91 111 11 11', '909092638 911111111', '+998 90 909 26 38 доб. 12',
    '+998 90 909 26 38 12', '909092638, 91\u00a0111\u00a011\u00a011', '234 56 78', '12345', '', null, undefined,
    'тел: 90 909 26 38 (мама)', '+7 916 123 45 67', '8 (916) 123-45-67', '+998 90 123 45', '90 912 34 56 доб. 78',
    '71 207 12 34 доб 56', '+7 (990) 123-45-67', '9989 0909 26 38 1']) {
    assert.equal(phoneMatchKey(f), '', JSON.stringify(f));
  }
});

// CRM_UNIFY_V1 (финальное ревью, A-C1) — имя заявки: пусто или только цифры (так
// звонок называет незнакомца) — не мешает; иначе хоть одно слово из 3+ букв
// равно имени или фамилии карты (регистр, ё/е не важны). Другое письмо — нет.
test('leadNameFits: имя заявки и имя карты', () => {
  const p = { full_name: 'Пациент Тест', first_name: '', last_name: '' };
  for (const [name, fits] of [['', true], [null, true], ['909092638', true], ['+998 90 909 26 38', true], ['Ли', true],
    ['пациент', true], ['ТЕСТ', true], ['Тёст Иванович', true], ['Patsient Test', false], ['Мама', false],
    ['Сын (без карты)', false], ['Пациентка', false]]) {
    assert.equal(leadNameFits(name, p), fits, JSON.stringify(name));
  }
  const q = { full_name: 'Каримова Азиза Рустамовна', first_name: 'Азиза', last_name: 'Королёва' };
  assert.equal(leadNameFits('королева', q), true);
  assert.equal(leadNameFits('Азиза', q), true);
  assert.equal(leadNameFits('Рустамовна', q), false, 'отчество — не имя и не фамилия');
  assert.equal(leadNameFits('Каримова', { full_name: 'Каримова Азиза Рустамовна' }), true);
  assert.equal(leadNameFits('Рустамовна', { full_name: 'Каримова Азиза Рустамовна' }), false);
  assert.equal(leadNameFits('Азиза', { full_name: '' }), false, 'у карты нет имени — заявка с именем не её');
});

test('владельцы номера: опекунство в обе стороны, даже без номера в строке (D5); +7 и 8 одного номера', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (85,'Ребёнок','')").run();
  db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id) VALUES (85, 77)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (86,'Подопечный мамы','')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (87,'Опекун ребёнка','+998 33 333 33 33')").run();
  db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id) VALUES (77, 87)").run();
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638').sort((a, b) => a - b), [77, 85, 87]);
  // CRM_UNIFY_V1 (финальное ревью, B) — иностранный номер ключа не даёт, но
  // владельцы по-прежнему считаются по вхождению цифр — с запасом.
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (90,'Рус','+7 916 123 45 67')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (91,'Брат','8 (916) 123-45-67')").run();
  assert.equal(phoneMatchKey('+7 916 123 45 67'), '');
  assert.deepEqual(patientIdsWithPhoneKey(db, '161234567').sort((a, b) => a - b), [90, 91]);
  // «Родственники» (patient_relationships) — связь владельцев в обе стороны.
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (92,'Сестра','')").run();
  db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (92, 77, 'sibling')").run();
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638').sort((a, b) => a - b), [77, 85, 87, 92]);
  db.close();
});

// CRM_UNIFY_V1 (ревью 3, D4) — дата карточки: одна функция (cardDateOf) для шага
// G и сверки зеркала. Ближайшая с сегодняшнего дня строка, которую держит живой
// визит (или живой визит привязки); иначе ближайшая ждущая с сегодняшнего дня;
// иначе дата, которую ставит шаг связи. Назад в прошлое не едет.
const T1 = localDay(1);
const DD = localDay(3);
const visitOn = (db, day, status = 'scheduled') =>
  Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, ?)').run(day + 'T05:00:00Z', status).lastInsertRowid);
const lineOn = (db, rid, day, visit = null) =>
  db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?, NULL, ?, 'pending', ?)").run(rid, day, visit);
for (const [name, was, heldBy, withLine, expect] of [
  ['T1, строку держит живой визит — остаётся T1', T1, 'scheduled', true, T1],
  ['T1, строку держал отменённый визит', T1, 'cancelled', true, DD],
  ['T1, строку держал неявочный визит', T1, 'no_show', true, DD],
  ['T1, строка не записана', T1, null, true, DD],
  ['T1 — дата звонка, строк нет', T1, null, false, DD],
  ['позавчера, строку держит живой визит', localDay(-2), 'scheduled', true, DD],
  ['D+5, строку держит живой визит — позже этой записи', localDay(5), 'scheduled', true, DD],
]) {
  test(`дата карточки при записи на D: ${name}`, () => {
    const db = freshDb();
    const rid = addReq(db);
    db.prepare('UPDATE crm_requests SET scheduled_date = ? WHERE id = ?').run(was, rid);
    if (withLine) lineOn(db, rid, was, heldBy ? visitOn(db, was, heldBy) : null);
    lineOn(db, rid, DD);
    crmLinkVisit(db, visitOn(db, DD), REG);
    assert.equal(db.prepare('SELECT scheduled_date FROM crm_requests WHERE id = ?').get(rid).scheduled_date, expect);
    db.close();
  });
}

test('сверка зеркала (touchRequest): прошедшие строки дату не трогают; ближайшая будущая — да; назад не едет', () => {
  const db = freshDb();
  const date = (id) => db.prepare('SELECT scheduled_date FROM crm_requests WHERE id = ?').get(id).scheduled_date;
  const rid = addReq(db, 'scheduled');
  db.prepare('UPDATE crm_requests SET scheduled_date = ? WHERE id = ?').run(DD, rid);
  lineOn(db, rid, localDay(-6));
  touchRequest(db, rid);
  assert.equal(date(rid), DD);
  lineOn(db, rid, localDay(0));
  touchRequest(db, rid);
  assert.equal(date(rid), localDay(0));
  const r2 = addReq(db, 'scheduled');
  db.prepare('UPDATE crm_requests SET scheduled_date = ? WHERE id = ?').run(localDay(-2), r2);
  lineOn(db, r2, localDay(-6));
  touchRequest(db, r2);
  assert.equal(date(r2), localDay(-2));
  const r3 = addReq(db, 'scheduled');
  db.prepare('UPDATE crm_requests SET scheduled_date = ? WHERE id = ?').run(DD, r3);
  lineOn(db, r3, null);
  touchRequest(db, r3);
  assert.equal(date(r3), DD);
  db.close();
});
