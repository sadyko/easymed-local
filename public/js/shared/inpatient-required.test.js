// INPATIENT_REQUIRED_V1 — общие правила «что обязательно»: поля листа, разделы, правила экрана.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLE_FIELDS, TITLE_GROUPS, TITLE_FIELD_KEYS, DEFAULT_TITLE_REQUIRED, SWITCH_KEYS,
  missingTitleFields, cleanTitleRequired, cleanRequiredSections, parseRequiredSections,
  missingSections, rulesFromSettings, DEFAULT_RULES, requiredSectionsOf, waitsForAttending,
  titleKeysOf, isAdmittingDoctorOf, admittingDoctorMayAct,
} from './inpatient-required.js';
import { isAdmittingDoctor } from '../../../server/services/rpc/inpatient-flow.js';   // INPATIENT_REQUIRED_V1 (ревью) — правило сервера
import { REQUIRED_KEYS, PATIENT_FIELDS } from './title-sheet-rules.js';

test('поля листа: группы, где живут, без ФИО, даты рождения, ИМТ и примечания', () => {
  assert.deepEqual(TITLE_GROUPS, ['patient', 'admission', 'measures', 'exam', 'papers']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'patient').map((f) => f.key),
    ['phone', 'address', 'national_id', 'occupation', 'emergency_contact_name', 'emergency_contact_phone', 'blood_type', 'allergies']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'admission').map((f) => f.key), ['referred_from', 'delivered_by', 'mobility', 'since_onset']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'measures').map((f) => f.key), ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'exam').map((f) => f.key), ['pediculosis', 'sanitation']);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'papers').map((f) => [f.key, f.col]),
    [['contract_signed', 'contract_signed_at'], ['consent_signed', 'consent_signed_at'], ['memo_given', 'memo_given_at']]);
  assert.deepEqual(TITLE_FIELDS.filter((f) => f.group === 'patient').map((f) => f.key), PATIENT_FIELDS.filter((k) => k !== 'gender'),
    'поля карточки — те же, что лист вправе поправить (title-sheet-rules.js PATIENT_FIELDS), кроме пола');
  assert.ok(!TITLE_FIELD_KEYS.includes('gender'), 'пол не бывает пустым (умолчание other) — обязательным его не делают');
  for (const k of ['full_name', 'date_of_birth', 'bmi', 'note']) assert.ok(!TITLE_FIELD_KEYS.includes(k), k);
  assert.deepEqual(DEFAULT_TITLE_REQUIRED, [...REQUIRED_KEYS], 'умолчание — сегодняшние восемь полей');
  assert.deepEqual(SWITCH_KEYS, ['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']);
});

test('missingTitleFields: лист, карточка пациента и отметка бумаги; «unknown» группы крови — пусто', () => {
  const keys = ['height_cm', 'phone', 'blood_type', 'consent_signed', 'mobility'];
  assert.deepEqual(missingTitleFields({ sheet: null, patient: null }, keys), ['phone', 'blood_type', 'mobility', 'height_cm', 'consent_signed']);
  const sheet = { height_cm: 172, mobility: 'walks', consent_signed_at: '2026-11-23T08:00:00Z' };
  const patient = { phone: '+998900000000', blood_type: 'unknown' };
  assert.deepEqual(missingTitleFields({ sheet, patient }, keys), ['blood_type']);
  // Форма экрана присылает галочку, а не время — это тоже «отмечено».
  assert.deepEqual(missingTitleFields({ sheet: { consent_signed: true }, patient }, ['consent_signed']), []);
  assert.deepEqual(missingTitleFields({ sheet: { consent_signed: false }, patient }, ['consent_signed']), ['consent_signed']);
  assert.deepEqual(missingTitleFields({ sheet: { consent_signed: false, consent_signed_at: '2026-11-23T08:00:00Z' }, patient }, ['consent_signed']),
    ['consent_signed'], 'снятая галочка главнее старой отметки');
  // Пробелы — пусто; ноль — значение.
  assert.deepEqual(missingTitleFields({ sheet: { referred_from: '   ', height_cm: 0 } }, ['referred_from', 'height_cm']), ['referred_from']);
  // Неизвестный ключ не требуется.
  assert.deepEqual(missingTitleFields({ sheet: {} }, ['nonsense']), []);
});

test('cleanTitleRequired: только известные ключи, без повторов, в порядке листа; не список — пусто', () => {
  assert.deepEqual(cleanTitleRequired(['pulse_bpm', 'phone', 'pulse_bpm', 'x']), ['phone', 'pulse_bpm']);
  assert.deepEqual(cleanTitleRequired(null), []);
});

test('разделы: cleanRequiredSections / parseRequiredSections / missingSections', () => {
  assert.deepEqual(cleanRequiredSections(['plan', 'diagnosis', 'plan', 'zzz'], ['complaints', 'diagnosis', 'plan']), ['diagnosis', 'plan']);
  assert.deepEqual(parseRequiredSections('["body","plan"]', 'operation'), ['body'], 'у протокола операции нет плана');
  assert.deepEqual(parseRequiredSections('испорчено', 'primary'), []);
  assert.deepEqual(parseRequiredSections(null, 'primary'), []);
  assert.deepEqual(parseRequiredSections(['body', 'plan'], 'operation'), ['body'], 'уже разобранный список');
  const fields = { complaints: '<p><br></p>', objective: '<p>ясно</p>', diagnosis: '  ', plan: '<table></table>', body: '' };
  assert.deepEqual(missingSections(fields, ['complaints', 'objective', 'diagnosis', 'plan', 'body']), ['complaints', 'diagnosis', 'plan', 'body']);
  assert.deepEqual(missingSections({ diagnosis: 'J18.9' }, ['diagnosis']), []);
  assert.deepEqual(missingSections(null, ['diagnosis']), ['diagnosis']);
});

test('rulesFromSettings: пустой ответ — сегодняшние правила; ответ сервера — как прислан', () => {
  assert.deepEqual(DEFAULT_RULES, rulesFromSettings(null));
  assert.equal(DEFAULT_RULES.intakeBeforeAttending, true);
  assert.equal(DEFAULT_RULES.admittingAtPlacement, true);
  assert.equal(DEFAULT_RULES.primaryNeedsDiagnosis, true);
  assert.equal(DEFAULT_RULES.dischargeNeedsEpicrisis, true);
  assert.equal(DEFAULT_RULES.titleRequired, true);
  assert.deepEqual(DEFAULT_RULES.titleFields, DEFAULT_TITLE_REQUIRED);
  const r = rulesFromSettings({
    settings: { intake_before_attending: 0, admitting_at_placement: 1, primary_needs_diagnosis: 0, discharge_needs_epicrisis: 1, title_required: 0, title_required_fields: ['phone'] },
    docs: [{ kind: 'primary', required: true, required_sections: ['plan'] }, { kind: 'round', required: false, required_sections: [] }],
  });
  assert.equal(r.intakeBeforeAttending, false);
  assert.equal(r.primaryNeedsDiagnosis, false);
  assert.equal(r.titleRequired, false);
  assert.deepEqual(r.titleFields, ['phone']);
  assert.deepEqual(requiredSectionsOf(r, 'primary'), ['plan']);
  assert.deepEqual(requiredSectionsOf(r, 'intake'), []);
  assert.equal(r.docs.round.required, false);
  // Лист не обязателен — не обязательно ни одно его поле (список при этом хранится).
  assert.deepEqual(titleKeysOf(r), []);
  assert.deepEqual(titleKeysOf(DEFAULT_RULES), [...DEFAULT_TITLE_REQUIRED]);
  assert.deepEqual(titleKeysOf(null), [...DEFAULT_TITLE_REQUIRED], 'нет правил — сегодняшние');
});

test('waitsForAttending: «осмотрен» ждёт всегда; «на койке» — только без обязательного осмотра', () => {
  assert.equal(waitsForAttending({ status: 'examined' }, false), true);
  assert.equal(waitsForAttending({ status: 'admitted' }, false), false);
  assert.equal(waitsForAttending({ status: 'admitted' }, true), true);
  assert.equal(waitsForAttending({ status: 'active' }, true), false);
  assert.equal(waitsForAttending(null, true), false);
});

// INPATIENT_REQUIRED_V1 (ревью) — экран решает «я приёмный врач» так же, как сервер:
// номер совпал и роль doctor (основная или дополнительная); is_doctor не в счёт.
test('isAdmittingDoctorOf = isAdmittingDoctor сервера: номер и роль doctor; медсестра со специальностью — нет', () => {
  const adm = { admitting_doctor_id: 5 };
  const cases = [
    [{ id: 5, role: 'doctor' }, true],
    [{ id: 5, role: 'nurse', is_doctor: true, specialty: 'Терапия' }, false],
    [{ id: 5, role: 'nurse', extra_roles: ['doctor'] }, true],
    [{ id: 5, role: 'admin', extra_roles: ['head_doctor'] }, false],
    [{ id: 6, role: 'doctor' }, false],
    [{ id: null, role: 'doctor' }, false],
    [null, false],
  ];
  for (const [user, want] of cases) {
    assert.equal(isAdmittingDoctorOf(adm, user), want, JSON.stringify(user));
    assert.equal(isAdmittingDoctor(adm, user), want, 'сервер: ' + JSON.stringify(user));
  }
  assert.equal(isAdmittingDoctorOf({ admitting_doctor_id: null }, { id: 5, role: 'doctor' }), false);
  assert.equal(isAdmittingDoctorOf(null, { id: 5, role: 'doctor' }), false);
  // Экран получает номера и строкой.
  assert.equal(isAdmittingDoctorOf({ admitting_doctor_id: '5' }, { id: 5, role: 'doctor' }), true);
});

// INPATIENT_REQUIRED_V1 (ревью) — кнопка «мой пациент на осмотр» — тому, кого сервер пустит:
// по имени (роль doctor) или по роли (администратор, главный врач). Медсестре — нет.
test('admittingDoctorMayAct: врач по имени, администратор-врач по роли; медсестра со специальностью и чужой — нет', () => {
  const adm = { admitting_doctor_id: 20 };
  assert.equal(admittingDoctorMayAct(adm, { id: 20, role: 'doctor' }), true);
  assert.equal(admittingDoctorMayAct(adm, { id: 20, role: 'admin', is_doctor: 1 }), true, 'администратор-врач (BACKLOG_1011_V1)');
  assert.equal(admittingDoctorMayAct(adm, { id: 20, role: 'registrar', extra_roles: ['head_doctor'] }), true);
  assert.equal(admittingDoctorMayAct(adm, { id: 20, role: 'nurse', is_doctor: true, specialty: 'Терапия' }), false);
  assert.equal(admittingDoctorMayAct(adm, { id: 21, role: 'admin' }), false, 'не назван — не его пациент');
  assert.equal(admittingDoctorMayAct({ admitting_doctor_id: null }, { id: 20, role: 'doctor' }), false);
});
