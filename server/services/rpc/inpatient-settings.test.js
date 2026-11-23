// INPATIENT_REQUIRED_V1 — «Настройки → Стационар»: кто читает, кто меняет, проверка, журнал, лицензия.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  inpatientSettingsGet, inpatientSettingsSave, loadInpatientSettings, titleRequiredKeys, requiredFlags, DEFAULT_SETTINGS,
} from './inpatient-settings.js';
import { caseDocTypeSave, caseDocTypesList } from './case-doc-types.js';
import { loadCaseDocSet } from './inpatient-reviews.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { RPC } from './index.js';   // реестр RPC (index.js `export const RPC = {`)

const admin = { id: 1, role: 'admin' };
const head  = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doc   = { id: 5, role: 'doctor' };
const nurse = { id: 3, role: 'nurse' };
const cash  = { id: 7, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role] of [[1, 'adm', 'admin'], [3, 'nur', 'nurse'], [4, 'head', 'doctor'], [5, 'doc5', 'doctor'], [7, 'cash', 'cashier']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role);
  }
  return db;
}

// База клиники, которая не дошла до 298: ни строки настроек, ни журнала, ни колонок набора.
function dropTo297(db) {
  db.exec('DROP TABLE inpatient_settings_log; DROP TABLE inpatient_settings;');
  db.exec('ALTER TABLE case_doc_types DROP COLUMN required_sections; ALTER TABLE case_doc_types DROP COLUMN required;');
  return db;
}

test('чтение: умолчания = сегодня; читают все, кто ведёт пациента; касса — нет', () => {
  const db = seed();
  const g = inpatientSettingsGet(db, {}, nurse);
  assert.deepEqual(g.settings, {
    intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1, discharge_needs_epicrisis: 1, title_required: 1,
    title_required_fields: ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation'],
  });
  const primary = g.docs.find((d) => d.kind === 'primary');
  assert.deepEqual(primary, { kind: 'primary', title: '', builtin: true, required: true, required_sections: [], sections: ['complaints', 'objective', 'diagnosis', 'plan', 'body'] });
  assert.deepEqual(g.log, []);
  assert.equal(g.can_edit, false);
  assert.equal(inpatientSettingsGet(db, {}, head).can_edit, true);
  for (const u of [admin, head, doc, nurse]) assert.ok(inpatientSettingsGet(db, {}, u));
  assert.throws(() => inpatientSettingsGet(db, {}, cash), (e) => e.status === 403);
  db.close();
});

test('запись: только главный врач и администратор; пишется лишь изменённое, строка журнала на значение', () => {
  const db = seed();
  for (const u of [doc, nurse, cash]) assert.throws(() => inpatientSettingsSave(db, { intake_before_attending: 0 }, u), (e) => e.status === 403);
  const out = inpatientSettingsSave(db, {
    intake_before_attending: 0, admitting_at_placement: 1,                         // второе не изменилось
    title_required_fields: ['phone', 'height_cm', 'phone'],
    docs: [{ kind: 'round', required: false }, { kind: 'primary', required_sections: ['plan', 'diagnosis'] }],
  }, head);
  assert.equal(out.changed, 4);
  assert.equal(out.settings.intake_before_attending, 0);
  assert.deepEqual(out.settings.title_required_fields, ['phone', 'height_cm']);
  const log = out.log.map((l) => [l.field, l.old_value, l.new_value, l.user_name]);
  assert.deepEqual(log.sort(), [
    ['doc:primary:sections', '[]', '["diagnosis","plan"]', 'Сотрудник head'],
    ['doc:round:required', '1', '0', 'Сотрудник head'],
    ['intake_before_attending', '1', '0', 'Сотрудник head'],
    ['title_required_fields', JSON.stringify(DEFAULT_SETTINGS.title_required_fields), '["phone","height_cm"]', 'Сотрудник head'],
  ].sort());
  const row = db.prepare('SELECT updated_by, updated_at FROM inpatient_settings WHERE id = 1').get();
  assert.equal(row.updated_by, 4);
  assert.ok(row.updated_at);
  // Повтор того же — ничего не пишет.
  assert.equal(inpatientSettingsSave(db, { intake_before_attending: 0 }, admin).changed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inpatient_settings_log').get().n, 4);
  // Документ «по желанию» виден и в ответе чтения, и в наборе чек-листа.
  const g = inpatientSettingsGet(db, {}, nurse);
  assert.equal(g.docs.find((d) => d.kind === 'round').required, false);
  assert.deepEqual(g.docs.find((d) => d.kind === 'primary').required_sections, ['diagnosis', 'plan']);
  assert.equal(loadCaseDocSet(db).find((d) => d.kind === 'round').required, false);
  db.close();
});

test('проверка: неизвестный ключ, поле, документ, раздел, не «да/нет» — отказ и НИЧЕГО не записано', () => {
  const db = seed();
  const bad = [
    [{ nonsense: 1 }, /Неизвестная настройка стационара: nonsense/],
    [{ title_required_fields: ['height_cm', 'full_name'] }, /Неизвестное поле титульного листа: full_name/],
    [{ title_required_fields: 'height_cm' }, /список/],
    [{ intake_before_attending: 'может быть' }, /да.*нет/],
    [{ intake_before_attending: 0, docs: [{ kind: 'nope', required: false }] }, /Такого документа в наборе нет: nope/],
    [{ intake_before_attending: 0, docs: [{ kind: 'operation', required_sections: ['plan'] }] }, /нет раздела: plan/],
    [{ intake_before_attending: 0, docs: [{ kind: 'round', required: 'может быть' }] }, /да.*нет/],
    [{ docs: [{ kind: 'round', required_sections: 'plan' }] }, /разделы документа — список/],
    [{ docs: 'x' }, /Список документов/],
  ];
  for (const [args, re] of bad) assert.throws(() => inpatientSettingsSave(db, args, admin), (e) => e.status >= 400 && re.test(e.message), JSON.stringify(args));
  assert.equal(loadInpatientSettings(db).intake_before_attending, 1, 'транзакция откатила частичную запись');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inpatient_settings_log').get().n, 0);
  db.close();
});

test('собранные отказы идут шаблоном словаря (rpcT) — экран переводит их на свой язык', () => {
  const db = seed();
  try {
    inpatientSettingsSave(db, { nonsense: 1 }, admin);
    assert.fail('должен отказать');
  } catch (e) {
    assert.equal(e.template, 'Неизвестная настройка стационара: {key}.');
    assert.deepEqual(e.params, { key: 'nonsense' });
  }
  try {
    inpatientSettingsSave(db, { docs: [{ kind: 'nope', required: 0 }] }, admin);
    assert.fail('должен отказать');
  } catch (e) {
    assert.equal(e.status, 404);
    assert.equal(e.template, 'Такого документа в наборе нет: {kind}.');
  }
  db.close();
});

test('case_doc_type_save несёт required и required_sections; список их показывает; набор их отдаёт', () => {
  const db = seed();
  caseDocTypeSave(db, { kind: 'head_review', required: 0, required_sections: ['diagnosis'] }, head);
  const t = caseDocTypesList(db, {}, head).types.find((x) => x.kind === 'head_review');
  assert.equal(t.required, false);
  assert.deepEqual(t.required_sections, ['diagnosis']);
  assert.deepEqual(t.sections, ['objective', 'diagnosis', 'plan']);
  const def = loadCaseDocSet(db).find((d) => d.kind === 'head_review');
  assert.equal(def.required, false);
  assert.deepEqual([...def.requiredSections], ['diagnosis']);
  assert.equal(loadCaseDocSet(db).find((d) => d.kind === 'primary').required, true);
  assert.deepEqual(db.prepare('SELECT field FROM inpatient_settings_log ORDER BY id').all().map((r) => r.field),
    ['doc:head_review:required', 'doc:head_review:sections']);
  // Новый свой документ — обязательный по умолчанию, разделы проверяются по полному набору.
  const own = caseDocTypeSave(db, { title: 'Тестовый лист', due_rule: 'none', required_sections: ['body'] }, head).type;
  assert.equal(own.required, true);
  assert.deepEqual(own.required_sections, ['body']);
  // Что не прислали, то не меняется (CASE_DOC_RENAME_V1): переименование не трогает обязательность.
  caseDocTypeSave(db, { kind: own.kind, title: 'Тестовый лист 2' }, head);
  const again = caseDocTypesList(db, {}, head).types.find((x) => x.kind === own.kind);
  assert.equal(again.required, true);
  assert.deepEqual(again.required_sections, ['body']);
  db.close();
});

test('case_doc_type_save: неверный раздел — отказ, и сам документ тоже не записан (одна транзакция)', () => {
  const db = seed();
  assert.throws(() => caseDocTypeSave(db, { kind: 'operation', due_rule: 'none', required_sections: ['plan'] }, head),
    (e) => e.status === 400 && /нет раздела: plan/.test(e.message));
  assert.equal(db.prepare("SELECT due_rule FROM case_doc_types WHERE kind = 'operation'").get().due_rule, 'surgical');
  const before = db.prepare('SELECT COUNT(*) n FROM case_doc_types').get().n;
  assert.throws(() => caseDocTypeSave(db, { title: 'Тестовый лист', due_rule: 'none', required: 'может быть' }, head), /да.*нет/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM case_doc_types').get().n, before, 'новый документ не остался без обязательности');
  db.close();
});

test('база старше 298: умолчания, набор — обязательный, без разделов', () => {
  const db = dropTo297(seed());
  const s = loadInpatientSettings(db);
  assert.equal(s.intake_before_attending, 1);
  assert.deepEqual(titleRequiredKeys(s), [...DEFAULT_SETTINGS.title_required_fields]);
  assert.deepEqual(requiredFlags(s), { intake_before_attending: true, admitting_at_placement: true, primary_needs_diagnosis: true, discharge_needs_epicrisis: true, title_required: true });
  const set = loadCaseDocSet(db);
  assert.ok(set.length >= 10, 'набор клиники читается и без колонок 298');
  assert.ok(set.every((d) => d.required === true && d.requiredSections.length === 0));
  assert.equal(loadInpatientSettings(null).title_required, 1, 'без базы — умолчания');
  db.close();
});

test('база старше 298: чтение настроек, список и сохранение состава работают как сегодня', () => {
  const db = dropTo297(seed());
  const g = inpatientSettingsGet(db, {}, nurse);
  assert.equal(g.settings.intake_before_attending, 1);
  assert.deepEqual(g.settings.title_required_fields, [...DEFAULT_SETTINGS.title_required_fields]);
  assert.deepEqual(g.log, []);
  assert.ok(g.docs.length >= 10, 'документы набора видны и без колонок 298');
  assert.ok(g.docs.every((d) => d.required === true && d.required_sections.length === 0));
  const list = caseDocTypesList(db, {}, head).types;
  assert.ok(list.every((t) => t.required === true && t.required_sections.length === 0));
  // Переименование и новый документ — без полей обязательности — как до 298.
  const own = caseDocTypeSave(db, { title: 'Тестовый лист', due_rule: 'none' }, head).type;
  assert.equal(own.title, 'Тестовый лист');
  assert.equal(caseDocTypeSave(db, { kind: own.kind, title: 'Тестовый лист 2' }, head).type.title, 'Тестовый лист 2');
  db.close();
});

test('лицензия: чтение проходит блокировку, запись — нет; оба имени в реестре RPC', () => {
  assert.equal(isReadOnlyRpc('inpatient_settings_get'), true);
  assert.equal(isReadOnlyRpc('inpatient_settings_save'), false);
  assert.equal(typeof RPC.inpatient_settings_get, 'function');
  assert.equal(typeof RPC.inpatient_settings_save, 'function');
});

test('title_required = 0 — не обязательно ни одно поле листа', () => {
  assert.deepEqual(titleRequiredKeys({ title_required: 0, title_required_fields: ['phone'] }), []);
  assert.deepEqual(titleRequiredKeys({ title_required: 1, title_required_fields: ['phone'] }), ['phone']);
});
