// CASE_DOC_SET_V2 — состав истории болезни правит клиника, а не код.
//
// Владелец (2026-09-08): «this list is hardcoded and the system asks for
// filling them, we need to make not hardcoded, and able to add a title
// document. its maybe before operation it can be anesthesist list etc etc. but
// we shoud give basic templates list + option».
//
// Здесь проверяется ровно то, что стоит истории болезни:
//   • встроенный набор остался прежним — клиника, ничего не настраивавшая, не
//     заметила ни миграции, ни этого кода;
//   • свой документ клиники ПОПАДАЕТ В ЧЕК-ЛИСТ, считает свой срок и
//     принимается как род записи;
//   • убранный документ уходит из чек-листа, а написанные им записи остаются;
//   • выписной эпикриз убрать нельзя — на нём стоит гейт выписки;
//   • состав правит главный врач или администратор, а не любой врач.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit, admissionDischargeRequest } from './inpatient.js';
import { admissionCaseDocs, admissionReviewSave } from './inpatient-reviews.js';
import { caseDocTypesList, caseDocTypeSave, caseDocTypeSetActive, caseDocTypeDelete, caseDocTypesReorder } from './case-doc-types.js';

const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse = { id: 3, role: 'nurse' };
const headDoctor = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doctor = { id: 5, role: 'doctor' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'admin1', 'x', 'Админ', 'admin', 0, '');
  u.run(2, 'reg1', 'x', 'Регистратор', 'registrar', 0, '');
  u.run(3, 'nurse1', 'x', 'Медсестра', 'nurse', 0, '');
  u.run(4, 'head1', 'x', 'Главный', 'doctor', 1, 'Хирургия');
  u.run(5, 'doc1', 'x', 'Врач', 'doctor', 1, 'Хирургия');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, active) VALUES (1, 'Хирургия', 1)").run();
  db.prepare("INSERT INTO beds (id, ward_id, code, status) VALUES (1, 1, 'X-1', 'free')").run();
  return db;
}

function inBed(db) {
  const { admission } = admissionOrderCreate(db, { patient_id: 1, department: 'Хирургия' }, registrar);
  const res = admissionAdmit(db, { admission_id: admission.id, bed_id: 1, admitting_doctor_id: 5 }, nurse);
  db.prepare("UPDATE admissions SET admitted_at = datetime('now','-30 hours') WHERE id = ?").run(res.admission.id);
  return res.admission.id;
}

const kindsOf = (st) => st.items.filter((i) => i.kind !== 'title').map((i) => i.kind);

test('встроенный набор виден как встроенный, порядок прежний, запертых родов нет', () => {
  const db = seed();
  try {
    const { types, due_rules } = caseDocTypesList(db, {}, headDoctor);
    assert.deepEqual(types.map((t) => t.kind),
      ['intake', 'anesthesia', 'preop', 'head_review', 'primary', 'rationale', 'operation', 'round', 'interim', 'discharge']);
    assert.ok(types.every((t) => t.builtin && t.active));
    assert.ok(types.every((t) => t.title === ''), 'имя встроенного рода переводится на экране');
    assert.ok(due_rules.includes('none'), 'правило «без срока» должно предлагаться');
    // CASE_DOC_SET_OPEN_V1 — запертых родов больше нет: замок стоял ради гейта
    // выписки, а гейт теперь сам смотрит, есть ли эпикриз в наборе.
    assert.ok(types.every((t) => t.locked === false), 'в наборе снова появился запертый род');
  } finally { db.close(); }
});

test('свой документ клиники встаёт в чек-лист, считает свой срок и принимается как род записи', () => {
  const db = seed();
  try {
    const { type } = caseDocTypeSave(db, {
      title: 'Лист анестезиолога', due_rule: 'clock', due_hours: 6,
    }, headDoctor);
    assert.ok(type && type.kind.startsWith('own_'), 'свой род получает своё внутреннее имя: ' + (type && type.kind));
    assert.equal(type.builtin, false);
    assert.equal(type.active, true);

    const id = inBed(db);
    const st = admissionCaseDocs(db, { admission_id: id }, headDoctor);
    const mine = st.items.find((i) => i.kind === type.kind);
    assert.ok(mine, 'свой документ не попал в чек-лист');
    assert.equal(mine.title, 'Лист анестезиолога', 'имя своего рода едет вместе с пунктом');
    assert.equal(mine.due_rule, 'clock');
    assert.ok(mine.due_at, 'срок своего документа не посчитан');
    // Тридцать часов на койке при сроке шесть часов — просрочен.
    assert.equal(mine.state, 'overdue');
    assert.equal(mine.required, true, 'свой документ должен спрашиваться так же, как встроенный');
    assert.ok(st.discharge_gate.incomplete.includes(type.kind), 'ненаписанный свой документ не попал в перечень недооформленного');

    // И запись этого рода принимается — иначе документ был бы витриной.
    const saved = admissionReviewSave(db, {
      admission_id: id, kind: type.kind, objective: '<p>Осмотрен</p>', publish: true,
    }, headDoctor);
    assert.ok(saved.review && saved.review.id);
    const after = admissionCaseDocs(db, { admission_id: id }, headDoctor);
    assert.equal(after.items.find((i) => i.kind === type.kind).state, 'published');
  } finally { db.close(); }
});

test('«без срока» — документ в наборе, но просроченным не бывает', () => {
  const db = seed();
  try {
    const { type } = caseDocTypeSave(db, { title: 'Партограмма', due_rule: 'none' }, headDoctor);
    assert.equal(type.due_hours, null, 'у правила «без срока» часов не бывает');
    const id = inBed(db);
    const item = admissionCaseDocs(db, { admission_id: id }, headDoctor).items.find((i) => i.kind === type.kind);
    assert.equal(item.due_at, null);
    assert.notEqual(item.state, 'overdue', 'документ без срока не может быть просрочен');
  } finally { db.close(); }
});

test('убранный документ уходит из чек-листа, а написанные им записи остаются', () => {
  const db = seed();
  try {
    const id = inBed(db);
    admissionReviewSave(db, { admission_id: id, kind: 'head_review', objective: '<p>Осмотрен</p>', publish: true }, headDoctor);
    assert.ok(kindsOf(admissionCaseDocs(db, { admission_id: id }, headDoctor)).includes('head_review'));

    caseDocTypeSetActive(db, { kind: 'head_review', active: false }, headDoctor);
    const st = admissionCaseDocs(db, { admission_id: id }, headDoctor);
    assert.ok(!kindsOf(st).includes('head_review'), 'убранный документ остался в чек-листе');
    assert.ok(!st.discharge_gate.incomplete.includes('head_review'), 'убранный документ всё ещё держит выписку');

    // Запись НЕ ПОТЕРЯНА: она в базе и уедет в собранную историю.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM admission_reviews WHERE kind = 'head_review'").get().n, 1);
    // Вернуть документ в набор можно — на то он и «убран», а не «стёрт».
    caseDocTypeSetActive(db, { kind: 'head_review', active: true }, headDoctor);
    assert.ok(kindsOf(admissionCaseDocs(db, { admission_id: id }, headDoctor)).includes('head_review'));
  } finally { db.close(); }
});

// CASE_DOC_SET_OPEN_V1 — владелец: «why is epicrisis is locked, open it, and we
// can form the full history».
//
// Замок стоял не ради эпикриза, а ради гейта выписки, который спрашивал его ПО
// ИМЕНИ. Отпереть замок можно было только вместе с этой зависимостью: иначе
// клиника убрала бы документ из набора и получила бы отказ в выписке, не видя
// в чек-листе, чего от неё ждут.
test('выписной эпикриз убирается из набора, и выписка перестаёт его требовать', () => {
  const db = seed();
  try {
    // Пациента доводим до лечения ПРЯМО: у заявки на выписку есть и другие
    // условия (свой лечащий врач, начатое лечение), и тест не про них — он
    // про то, спрашивают ли эпикриз.
    const id = inBed(db);
    db.prepare('UPDATE admissions SET status = ?, attending_doctor_id = ? WHERE id = ?').run('active', headDoctor.id, id);
    // Пока эпикриз в наборе — без него заявку не принимают. Это не изменилось.
    assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, headDoctor),
      /эпикриз/i, 'клиника держит эпикриз — значит он и спрашивается');

    caseDocTypeSetActive(db, { kind: 'discharge', active: false }, headDoctor);
    assert.ok(!kindsOf(admissionCaseDocs(db, { admission_id: id }, headDoctor)).includes('discharge'),
      'убранный эпикриз остался в чек-листе');

    // Убрали из набора — заявка проходит: спрашивать документ, которого в
    // чек-листе нет, значит отказывать молча.
    const res = admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, headDoctor);
    assert.ok(res && res.admission, 'выписка всё ещё требует убранный из набора эпикриз');

    // Вернули в набор — документ снова в чек-листе, а значит снова
    // спрашивается: первое утверждение этого теста уже это показало.
    caseDocTypeSetActive(db, { kind: 'discharge', active: true }, headDoctor);
    assert.ok(kindsOf(admissionCaseDocs(db, { admission_id: id }, headDoctor)).includes('discharge'),
      'вернуть эпикриз в набор оказалось нечем');
  } finally { db.close(); }
});

// CASE_DOC_RENAME_V1 (2026-09-09) — владелец: «why i cant delete or edit added
// documents? add an option».
//
// Заведённый по ошибке документ иначе оставался бы в клинике навсегда: убрать
// из набора можно, удалить — нечем. И переименовать нечем тоже, а имя своего
// документа — единственное, что о нём известно.
test('свой документ переименовывается, и срок при этом НЕ сбрасывается', () => {
  const db = seed();
  try {
    const { type } = caseDocTypeSave(db, { title: 'Лист анестезиолога', due_rule: 'clock', due_hours: 6 }, headDoctor);

    // Экран правки имени шлёт ИМЯ. Всё остальное он не спрашивал и не знает.
    const { type: renamed } = caseDocTypeSave(db, { kind: type.kind, title: 'Лист анестезиолога №1' }, headDoctor);
    assert.equal(renamed.title, 'Лист анестезиолога №1');
    assert.equal(renamed.due_rule, 'clock', 'правило срока сбросилось на умолчание');
    assert.equal(renamed.due_hours, 6, 'часы срока потерялись при переименовании');
    assert.equal(renamed.active, true, 'документ ушёл из набора при переименовании');

    // И в чек-листе он под новым именем — переименовать значит переименовать
    // везде, а не только в справочнике.
    const id = inBed(db);
    const st = admissionCaseDocs(db, { admission_id: id }, headDoctor);
    assert.equal(st.items.find((i) => i.kind === type.kind).title, 'Лист анестезиолога №1');
  } finally { db.close(); }
});

test('свой ненаписанный документ удаляется насовсем; написанный и встроенный — нет', () => {
  const db = seed();
  try {
    const { type } = caseDocTypeSave(db, { title: 'Заведён по ошибке', due_rule: 'none' }, headDoctor);
    caseDocTypeDelete(db, { kind: type.kind }, headDoctor);
    assert.ok(!caseDocTypesList(db, {}, headDoctor).types.some((t) => t.kind === type.kind),
      'удалённый документ остался в справочнике');

    // Встроенный не удаляется НИКОГДА: на него ссылаются написанные записи во
    // всех историях болезни.
    assert.throws(() => caseDocTypeDelete(db, { kind: 'intake' }, headDoctor), /встроенн/i);
    assert.ok(caseDocTypesList(db, {}, headDoctor).types.some((t) => t.kind === 'intake'));

    // Свой, которым уже написали, — тоже: иначе написанное осталось бы без
    // имени. Для него есть «убрать из набора».
    const { type: used } = caseDocTypeSave(db, { title: 'Лист наблюдения', due_rule: 'none' }, headDoctor);
    const id = inBed(db);
    admissionReviewSave(db, { admission_id: id, kind: used.kind, body: 'написано', publish: true }, headDoctor);
    assert.throws(() => caseDocTypeDelete(db, { kind: used.kind }, headDoctor), /записи/i);
    caseDocTypeSetActive(db, { kind: used.kind, active: false }, headDoctor);
    assert.ok(caseDocTypesList(db, {}, headDoctor).types.some((t) => t.kind === used.kind && !t.active),
      'убрать из набора должно остаться возможным');
  } finally { db.close(); }
});

test('удалять и переименовывать состав может только тот, кто им заведует', () => {
  const db = seed();
  try {
    const { type } = caseDocTypeSave(db, { title: 'Свой документ', due_rule: 'none' }, headDoctor);
    const nurse = { id: 9, role: 'nurse' };
    assert.throws(() => caseDocTypeDelete(db, { kind: type.kind }, nurse), /роли|главный врач|администратор/i);
    assert.throws(() => caseDocTypeSave(db, { kind: type.kind, title: 'Переименовано' }, nurse), /роли|главный врач|администратор/i);
  } finally { db.close(); }
});

test('порядок меняется целиком и становится порядком чек-листа', () => {
  const db = seed();
  try {
    const start = caseDocTypesList(db, {}, headDoctor).types.map((t) => t.kind);
    const moved = ['primary', ...start.filter((k) => k !== 'primary')];
    caseDocTypesReorder(db, { kinds: moved }, headDoctor);
    const id = inBed(db);
    assert.equal(kindsOf(admissionCaseDocs(db, { admission_id: id }, headDoctor))[0], 'primary',
      'новый порядок не доехал до чек-листа');
    assert.throws(() => caseDocTypesReorder(db, { kinds: ['нет-такого'] }, headDoctor), /нет/i);
  } finally { db.close(); }
});

test('состав правят главный врач и администратор; рядовой врач читает, но не правит', () => {
  const db = seed();
  try {
    assert.ok(caseDocTypesList(db, {}, doctor).types.length, 'читать состав должен всякий, кто ведёт пациента');
    assert.throws(() => caseDocTypeSave(db, { title: 'Своё', due_rule: 'none' }, doctor), /главный врач|администратор/i);
    assert.throws(() => caseDocTypeSetActive(db, { kind: 'intake', active: false }, doctor), /главный врач|администратор/i);
    assert.throws(() => caseDocTypesList(db, {}, { id: 7, role: 'cashier' }), /роли/i);
    // Администратор — может.
    assert.ok(caseDocTypeSave(db, { title: 'Своё', due_rule: 'none' }, admin).type);
  } finally { db.close(); }
});

test('плохие данные не заводят документ: без имени, с выдуманным правилом, без часов там, где они нужны', () => {
  const db = seed();
  try {
    assert.throws(() => caseDocTypeSave(db, { title: '  ', due_rule: 'none' }, headDoctor), /Назовите/);
    assert.throws(() => caseDocTypeSave(db, { title: 'Х', due_rule: 'когда-нибудь' }, headDoctor), /правило/i);
    assert.throws(() => caseDocTypeSave(db, { title: 'Х', due_rule: 'clock' }, headDoctor), /часов/i);
    assert.throws(() => caseDocTypeSave(db, { title: 'Х', due_rule: 'clock', due_hours: 0 }, headDoctor), /часов/i);
    assert.throws(() => caseDocTypeSave(db, { title: 'Х', due_rule: 'clock', due_hours: 1.5 }, headDoctor), /часов/i);
    assert.throws(() => caseDocTypeSave(db, { kind: 'нет-такого', title: 'Х', due_rule: 'none' }, headDoctor), /нет/i);
    assert.equal(caseDocTypesList(db, {}, headDoctor).types.length, 10, 'ни одна плохая попытка не завела документ');
  } finally { db.close(); }
});

test('у встроенного рода меняются срок и имя, а род — никогда', () => {
  const db = seed();
  try {
    caseDocTypeSave(db, { kind: 'head_review', title: 'Обход заведующего', due_rule: 'clock', due_hours: 48 }, headDoctor);
    const t = caseDocTypesList(db, {}, headDoctor).types.find((x) => x.kind === 'head_review');
    assert.equal(t.title, 'Обход заведующего');
    assert.equal(t.due_hours, 48);
    assert.equal(t.builtin, true, 'встроенный род остался встроенным');
    assert.equal(t.kind, 'head_review', 'род переименовывать нельзя — на него ссылаются записи');
  } finally { db.close(); }
});
