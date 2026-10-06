// wire.test.js — LIS_REAL_ANALYZERS_V1_WIRE: вид сообщения, поля теста и
// значения по проводу прибора, номер пробы из нужного поля OBR. Чистые функции:
// ни базы, ни сети, ни времени.
//
// Фикстуры — из источников спецификации
// docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел «Тесты»; у каждой
// сказано, откуда она.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnvelope, readResult, pickSampleId, wireFor, WIRES, FORWARDER_FACILITY } from './wire.js';
import { pickMessageSample } from './wire.js';   // LIS_REAL_ANALYZERS_V1 — ревью R1, п. 1
import { wireDecision } from './wire.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 12
import { parseMessage } from './hl7.js';

const seg = (...s) => s.join('\r');

// BS-200 — «BS-200 Host Interface Manual» v1.2, с. 24–25. «Manufacturer|Model»
// заменены на «Mindray|BS-200E», штрихкод «0000000002» — на нашу этикетку.
const BS200 = (obx, { obr2 = 'LAB-000123', obr3 = '2', ackType = '0' } = {}) => seg(
  `MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||${ackType}||ASCII|||`,
  'PID|1|854||12|Tommy||19830719145307|F|A||||||||||||||||||||||',
  `OBR|1|${obr2}|${obr3}|Mindray^BS-200E|Y||||||||||serum|||||||||||||||||||||||||||||||||`,
  obx || 'OBX|1|NM|2|test2|5.000000|g/ml|-||||F|||||||',
);

// BS-200, контроль качества — с. 26–27 (MSH-16 = 2; в OBR-2 — номер теста).
const BS200_QC = seg(
  'MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|1|P|2.3.1||||2||ASCII|||',
  'OBR|1|1|test1|Mindray^BS-200E||20070720120143|||||||QUAL1|1111|20080720000000||H|5.000000|2.000000|0.11029|g/ml|||||||||||||||||||||||||||',
);

// BS-200, запрос рабочего списка — с. 27; отмена группового — с. 34 (QRD-9 = CAN).
const BS200_QRY = (qrd9 = 'OTH', barcode = '34567743') => seg(
  'MSH|^~\\&|Mindray|BS-200E|||20070723170707||QRY^Q02|1|P|2.3.1||||||ASCII|||',
  `QRD|20070723170707|R|D|1|||RD|${barcode}|${qrd9}|||T|`,
  'QRF|BS-200E|20070723170749|20070723170749|||RCT|COR|ALL||',
);

// Autobio по сети — собрано по драйверу (LiveMachine AutoLumoHL7.cs, строки
// 129–163: номер пробы OBR-2, код OBX-4, значение OBX-5 компонент 2) и
// заголовку «A2000 plus HL7 protocol V0.02». Статус «F» стоит в OBX-11 (в
// черновике спецификации он съехал в OBX-12; драйвер OBX-11 не читает).
const AUTOBIO = seg(
  'MSH|^~\\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
  'OBR|1|LAB-000123|||',
  'OBX|1|NM|1^Vitamin B12|206|5981666^390.946|pg/mL|||||F',
);

// Переадресатор под профилем A1000 — договор с forwarder/hl7-oru.js
// (MSH-4 = LabPC, номер в OBR-3, код в OBX-3, подпись в OBX-4).
const FORWARDED = seg(
  'MSH|^~\\&|AutoLumo A1000|LabPC|||20261001101500||ORU^R01|5|P|2.3.1',
  'OBR|1||LAB-000123|00001^Automated Count^99MRC',
  'OBX|1|NM|206^^AUTOBIO|Vitamin B12|390.946||||||F',
);

// BC-780 — по записи BC-3600 (salimmulyana/geulis) и BC-5380 (hl7.test.js).
const BC780 = (obr2 = '', obr3 = 'LAB-000123') => seg(
  'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|1|P|2.3.1||||||UNICODE',
  `OBR|1|${obr2}|${obr3}|00001^Automated Count^99MRC|||20261001090000`,
  'OBX|2|NM|6690-2^WBC^LN||7.25|10*9/L|4.0-10.0|N|||F',
);

// ── readEnvelope: вид сообщения ─────────────────────────────────────────────

test('readEnvelope: проба пациента — MSH-16 = 0 или пусто', () => {
  for (const raw of [BS200(), BC780(), FORWARDED]) {
    const e = readEnvelope(raw);
    assert.equal(e.ok, true);
    assert.equal(e.kind, 'result', raw.slice(0, 40));
    assert.equal(e.service, false);
  }
});

test('readEnvelope: MSH-16 = 2 — контроль качества, 1 — калибровка (руководство BS-200, с. 8 и 23)', () => {
  assert.equal(readEnvelope(BS200_QC).kind, 'qc');
  assert.equal(readEnvelope(BS200_QC).service, true);
  assert.equal(readEnvelope(BS200(null, { ackType: '1' })).kind, 'calibration');
  // В стандарте HL7 у MSH-16 значения AL/NE/ER/SU, и это обычная проба.
  assert.equal(readEnvelope(BS200(null, { ackType: 'AL' })).kind, 'result');
});

test('readEnvelope: запросы рабочего списка — QRY^Q02 (BS-200), QRY^Q01 (Autobio), ORM^O01 (гематология)', () => {
  const q = readEnvelope(BS200_QRY());
  assert.equal(q.kind, 'query');
  assert.equal(q.service, true);
  assert.equal(q.type, 'QRY^Q02');
  assert.equal(q.queryBarcode, '34567743', 'QRD-8 — штрихкод пробирки (с. 19)');
  assert.equal(q.queryCancel, false);
  assert.match(q.qrd, /^QRD\|/);
  assert.match(q.qrf, /^QRF\|/);

  const cancel = readEnvelope(BS200_QRY('CAN', ''));
  assert.equal(cancel.kind, 'query');
  assert.equal(cancel.queryCancel, true, 'QRD-9 = CAN — отмена группового запроса (с. 34)');

  const q01 = readEnvelope(seg('MSH|^~\\&|A1000|Autolumo|||20261001101500||QRY^Q01|3|P|2.3.1',
    'QRD|20261001101500|R|D|7|||RD|LAB-000123|OTH|||T', 'QRF|A1000|20261001000000|20261001101500|||RCT|COR|ALL'));
  assert.equal(q01.kind, 'query');
  assert.equal(q01.queryBarcode, 'LAB-000123');

  const orm = readEnvelope('MSH|^~\\&|BC-780|Mindray|||20261001090000||ORM^O01|9|P|2.3.1');
  assert.equal(orm.kind, 'query');
});

test('readEnvelope: известный, но не поддержанный тип — unsupported; мусор и пустой тип — unparsed', () => {
  assert.equal(readEnvelope('MSH|^~\\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1').kind, 'unsupported');
  for (const junk of ['', 'это не HL7', 'OBX|1|NM|WBC||6.1', 'MSH|^~\\&|X|Y|||20260910143943|||1|P|2.3.1']) {
    const e = readEnvelope(junk);
    assert.equal(e.kind, 'unparsed', JSON.stringify(junk));
    assert.equal(e.service, false);
  }
});

// ── readResult: строки теста по проводу ─────────────────────────────────────

test('WIRES: пять проводов', () => {
  assert.deepEqual([...WIRES].sort(), ['autobio-hl7', 'default', 'forwarder', 'mindray-chem', 'mindray-hematology']);
  assert.equal(FORWARDER_FACILITY, 'LabPC');
});

test('провод default читает ровно то, что читал parseMessage, — существующие профили не меняются', () => {
  const raw = seg(
    'MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|7|P|2.3.1',
    'OBR|1||LAB-000098|00001^Automated Count^99MRC',
    'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
    'OBX|2|NM|6690-2^WBC^LN||9.81|10*9/L|4.00-10.00|H~N|||F',
    'OBX|3|NM|WBC^^99MRC||6.1|10*9/L|||||F',
    'OBX|4|ST|X^Y^Z|sub|  Positive  |u^v|r|A~B||||',
  );
  const { observations } = readResult(raw, 'default');
  assert.deepEqual(observations.map(({ label, ...o }) => o), parseMessage(raw).observations);
  assert.ok(observations.every((o) => o.label === ''), 'у провода default подписи нет');
  // Свои разделители отправителя (MSH-2) — как у parseMessage.
  const odd = seg('MSH|*~\\&|BC-5300|Mindray|||20260910143943||ORU*R01|42|P|2.3.1', 'OBR|1||LAB-000123|x', 'OBX|1|NM|WBC*Leukocytes*99MRC||6.1|10*9/L||N|||F');
  assert.deepEqual(readResult(odd, 'default').observations.map(({ label, ...o }) => o), parseMessage(odd).observations);
});

test('неизвестный провод читается как default', () => {
  assert.deepEqual(readResult(BC780(), 'nonsense'), readResult(BC780(), 'default'));
  assert.deepEqual(readResult(BC780()), readResult(BC780(), 'default'));
});

test('BS-200 (mindray-chem): код — номер теста OBX-3, подпись OBX-4 только показ, значение без хвостовых нулей', () => {
  const [o] = readResult(BS200(), 'mindray-chem').observations;
  assert.equal(o.code, '2', 'OBX-3 — «test ID» (с. 17)');
  assert.equal(o.name, '', 'имени для сравнения нет: OBX-4 «must not be analyzed» (с. 24)');
  assert.equal(o.label, 'test2', 'подпись — только показ');
  assert.equal(o.value, '5', '«5.000000» → «5»');
  assert.equal(o.valueType, 'NM');
  assert.equal(o.unit, 'g/ml');
  assert.equal(o.range, '-');
  assert.equal(o.status, 'F');
  const val = (v, type = 'NM') => readResult(BS200(`OBX|1|${type}|3|test3|${v}|g/ml|-||||F|||||||`), 'mindray-chem').observations[0].value;
  assert.equal(val('10.000000'), '10');
  assert.equal(val('10.500000'), '10.5');
  assert.equal(val('0.123400'), '0.1234');
  assert.equal(val('0.000000'), '0');
  assert.equal(val('-0.000000'), '0', 'без «минус нуля» в бланке');
  assert.equal(val('-1.250000'), '-1.25');
  assert.equal(val('123.456'), '123.456', 'число не округляется');
  assert.equal(val('15'), '15');
  assert.equal(val('+-', 'ST'), '+-', 'текст не трогается');
  assert.equal(val('<0.010000'), '<0.010000', 'не число — как пришло');
});

test('Autobio по сети (autobio-hl7): код — OBX-4, значение — компонент 2 OBX-5, OBX-3 не сравнивается', () => {
  const [o] = readResult(AUTOBIO, 'autobio-hl7').observations;
  assert.equal(o.code, '206', 'код позиции — OBX-4.1');
  assert.equal(o.name, '', 'OBX-3 у Autobio может быть номером заявки на тест — не сравнивается');
  assert.equal(o.label, 'Vitamin B12', 'подпись — OBX-3.2');
  assert.equal(o.value, '390.946', '«5981666^390.946»: компонент 1 — RLU, сигнал прибора, никогда');
  assert.equal(o.unit, 'pg/mL');
  assert.equal(o.status, 'F');
  // Подписи в OBX-3.2 нет — берётся OBX-3.1; первое повторение OBX-5.
  const [p] = readResult(seg('MSH|^~\\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1', 'OBR|1|LAB-000123',
    'OBX|1|NM|TSH|207|1234^2.5~999^9.9|uIU/mL|||||F'), 'autobio-hl7').observations;
  assert.equal(p.label, 'TSH');
  assert.equal(p.value, '2.5');
});

test('сообщение переадресателя под профилем A1000 читается проводом forwarder: OBR-3 и OBX-3, подпись OBX-4', () => {
  const [o] = readResult(FORWARDED, 'forwarder').observations;
  assert.equal(o.code, '206');
  assert.equal(o.name, '');
  assert.equal(o.system, 'AUTOBIO');
  assert.equal(o.codeRaw, '206^^AUTOBIO');
  assert.equal(o.label, 'Vitamin B12');
  assert.equal(o.value, '390.946');
  assert.equal(pickSampleId(readResult(FORWARDED, 'forwarder').obr, 'forwarder').value, 'LAB-000123');
  // Старый пакет OBX-4 не пишет — подписи нет, остальное как у default.
  const old = readResult(seg('MSH|^~\\&|BC-2800|LabPC|||20260910143943||ORU^R01|1|P|2.3.1', 'OBR|1||LAB-000123', 'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F'), 'forwarder');
  assert.equal(old.observations[0].label, '');
  assert.equal(old.observations[0].code, 'WBC');
});

test('BC-780 (mindray-hematology): код OBX-3.1, затем OBX-3.2 — как default', () => {
  const [o] = readResult(BC780(), 'mindray-hematology').observations;
  assert.equal(o.code, '6690-2');
  assert.equal(o.name, 'WBC');
  assert.equal(o.value, '7.25');
  assert.equal(o.label, '');
});

test('readResult: первый OBR — компонент 1 полей 2 и 3 без пробелов; без OBR — null; мусор не бросает', () => {
  const r = readResult(seg('MSH|^~\\&|X|Y|||1||ORU^R01|1|P|2.3.1', 'OBR|1| LAB-000007^x | 15^y ', 'OBR|2|LAB-9|LAB-9'), 'default');
  assert.deepEqual(r.obr, { placer: 'LAB-000007', filler: '15' });
  assert.equal(readResult('MSH|^~\\&|X|Y|||1||ORU^R01|1|P|2.3.1', 'default').obr, null);
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 1) — и obrs: все OBR сообщения, поля целиком.
  assert.deepEqual(readResult('это не HL7', 'default'), { obr: null, obrs: [], observations: [] });
  assert.deepEqual(readResult(null, 'default'), { obr: null, obrs: [], observations: [] });
});

// ── pickSampleId: номер пробы из нужного поля ───────────────────────────────

const obr = (placer, filler) => ({ placer, filler });

test('default: основное поле — OBR-3; голые цифры OBR-2 не читаются (это может быть номер прогона)', () => {
  assert.deepEqual(pickSampleId(obr('', 'LAB-000123'), 'default'),
    { sampleId: 'LAB-000123', value: 'LAB-000123', field: 'OBR-3', lab: true, conflict: false });
  assert.deepEqual(pickSampleId(obr('77', '15'), 'default'),
    { sampleId: '15', value: '15', field: 'OBR-3', lab: false, conflict: false });
  assert.deepEqual(pickSampleId(obr('77', ''), 'default'),
    { sampleId: '', value: '', field: '', lab: false, conflict: false }, 'запасного поля у default нет');
  assert.equal(pickSampleId(obr('LAB-000123', '15'), 'default').value, 'LAB-000123', 'LAB- бьёт всё — в любом поле');
  assert.equal(pickSampleId(obr('LAB-000123', ''), 'default').field, 'OBR-2');
});

test('forwarder: OBR-3', () => {
  assert.equal(pickSampleId(obr('', 'LAB-000123'), 'forwarder').value, 'LAB-000123');
  assert.equal(pickSampleId(obr('9', '123'), 'forwarder').value, '123');
});

test('mindray-chem (BS-200): OBR-2; OBR-3 — номер места в штативе — не читается НИКОГДА', () => {
  assert.equal(pickSampleId(obr('LAB-000123', '2'), 'mindray-chem').value, 'LAB-000123');
  assert.equal(pickSampleId(obr('000123', '2'), 'mindray-chem').value, '000123', 'голые цифры штрихкода — из OBR-2');
  assert.deepEqual(pickSampleId(obr('', '2'), 'mindray-chem'),
    { sampleId: '', value: '', field: '', lab: false, conflict: false }, '«Sample ID is for internal use and must not be analyzed» (с. 24)');
  assert.equal(pickSampleId(obr('', 'LAB-000123'), 'mindray-chem').value, '', 'даже LAB- в поле «никогда» не читается');
});

test('autobio-hl7: OBR-2', () => {
  assert.equal(pickSampleId(obr('LAB-000123', ''), 'autobio-hl7').value, 'LAB-000123');
  assert.equal(pickSampleId(obr('123', '9'), 'autobio-hl7').value, '123');
  assert.equal(pickSampleId(obr('', '9'), 'autobio-hl7').value, '', 'запасного поля нет');
  assert.equal(pickSampleId(obr('', 'LAB-000123'), 'autobio-hl7').value, 'LAB-000123', 'LAB- — в любом поле');
});

test('mindray-hematology (BC-780): OBR-3, запасное — OBR-2, только если OBR-3 пуст', () => {
  const pick = (raw) => pickSampleId(readResult(raw, 'mindray-hematology').obr, 'mindray-hematology');
  assert.equal(pick(BC780('', 'LAB-000123')).value, 'LAB-000123');
  assert.deepEqual(pick(BC780('LAB-000123', '')), { sampleId: 'LAB-000123', value: 'LAB-000123', field: 'OBR-2', lab: true, conflict: false });
  assert.equal(pick(BC780('LAB-000123', '15')).value, 'LAB-000123', 'LAB- в OBR-2 бьёт голое «15» в OBR-3');
  assert.deepEqual(pick(BC780('', '15')), { sampleId: '15', value: '15', field: 'OBR-3', lab: false, conflict: false });
  assert.deepEqual(pick(BC780('16', '')), { sampleId: '16', value: '16', field: 'OBR-2', lab: false, conflict: false }, 'запасное — голые цифры тоже');
  assert.equal(pick(BC780('16', '15')).value, '15', 'запасное — только когда основное пусто');
});

test('два разных LAB- в OBR-2 и OBR-3 — номера нет, в sample_id оба через « / »', () => {
  for (const wire of ['default', 'mindray-hematology', 'autobio-hl7', 'forwarder']) {
    assert.deepEqual(pickSampleId(obr('LAB-000124', 'LAB-000123'), wire),
      { sampleId: 'LAB-000124 / LAB-000123', value: '', field: '', lab: true, conflict: true }, wire);
  }
  // Один и тот же заказ, записанный по-разному, — не спор. (Ревью R1, п. 8:
  // этикетка — только «LAB-» и не меньше 6 цифр, регистр не важен.)
  assert.equal(pickSampleId(obr('LAB-000123', 'lab-0000123'), 'default').conflict, false);
  assert.equal(pickSampleId(obr('LAB-000123', 'lab-0000123'), 'default').value, 'lab-0000123', 'основное поле, раз номера равны');
  // У BS-200 OBR-3 не читается — и спора нет.
  assert.equal(pickSampleId(obr('LAB-000124', 'LAB-000123'), 'mindray-chem').value, 'LAB-000124');
});

// LIS_REAL_ANALYZERS_V1 (ревью R1, п. 8) — наша этикетка — ровно «LAB-» и не
// меньше 6 цифр (lab-doc.js labAccession: 'LAB-' + padStart(6)). «LAB2», «lab 2»,
// «lab_2», «LAB000123» и «LAB-123» раньше считались нашими и обходили правило
// голых цифр (открытый заказ последних 7 дней).
test('LAB- узнаётся только как печатает Easy-Med: «LAB-» и 6+ цифр, регистр не важен; прочее — не LAB-', () => {
  assert.equal(pickSampleId(obr('lab-000123', '15'), 'default').value, 'lab-000123');
  assert.equal(pickSampleId(obr('LAB-1234567', '15'), 'default').value, 'LAB-1234567', 'заказ больше 999 999 — семь цифр');
  for (const loose of ['lab 000123', 'LAB000123', 'lab_000123', 'LAB2', 'lab 2', 'lab_2', 'LAB-123', 'LAB-00012']) {
    assert.equal(pickSampleId(obr(loose, '15'), 'default').value, '15', '«' + loose + '» — не наша этикетка');
  }
  assert.equal(pickSampleId(obr('LAB-12a', '15'), 'default').value, '15', '«LAB-12a» — не наша этикетка');
  assert.equal(pickSampleId(obr('QC-LAB-1', '15'), 'default').value, '15');
});

test('pickSampleId терпит пустой OBR и неизвестный провод', () => {
  assert.deepEqual(pickSampleId(null, 'default'), { sampleId: '', value: '', field: '', lab: false, conflict: false });
  assert.equal(pickSampleId(obr('77', '15'), 'nonsense').value, '15', 'неизвестный провод — default');
});

// ── wireFor: какой провод у сообщения ───────────────────────────────────────

test('wireFor: MSH-4 = LabPC — переадресатор, что бы ни говорил профиль; иначе провод профиля; иначе default', () => {
  assert.equal(wireFor({ profile: { wire: 'autobio-hl7' }, facility: 'LabPC' }), 'forwarder');
  assert.equal(wireFor({ profile: { wire: 'autobio-hl7' }, facility: ' labpc ' }), 'forwarder');
  assert.equal(wireFor({ profile: { wire: 'autobio-hl7' }, facility: 'Autolumo' }), 'autobio-hl7');
  assert.equal(wireFor({ profile: { wire: 'mindray-chem' }, facility: 'BS-200E' }), 'mindray-chem');
  assert.equal(wireFor({ profile: { key: 'mindray-bc-5300' }, facility: 'Mindray' }), 'default', 'у прежних профилей провода нет');
  assert.equal(wireFor({ profile: null, facility: '' }), 'default');
  assert.equal(wireFor({ profile: { wire: 'nonsense' } }), 'default');
  assert.equal(wireFor(), 'default');
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R1 (E1–E5 на 1728cbc) ─────────────────────

// П. 1 — номер пробы у КАЖДОГО OBR. Раньше номер брался у первого OBR, а строки
// OBX — у всех: «OBR|1||LAB-000123 + OBX, OBR|2||LAB-000124 + OBX» клал значение
// пробы 124 в бланк 123.
const MULTI = (o1, o2) => seg(
  'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|1|P|2.3.1',
  `OBR|1||${o1}|00001^Automated Count^99MRC`,
  'OBX|1|NM|WBC^^99MRC||9.9|10*9/L|||||F',
  `OBR|2||${o2}|00001^Automated Count^99MRC`,
  'OBX|1|NM|HGB^^99MRC||142|g/L|||||F',
);

test('R1 п. 1: readResult отдаёт все OBR — поля целиком, с разделителем компонентов', () => {
  const r = readResult(seg('MSH|^~\\&|X|Y|||1||ORU^R01|1|P|2.3.1', 'OBR|1| 2^LAB-000123 |', 'OBR|2||15'), 'default');
  assert.deepEqual(r.obrs, [{ placer: '2^LAB-000123', filler: '', compSep: '^' }, { placer: '', filler: '15', compSep: '^' }]);
  assert.deepEqual(r.obr, { placer: '2', filler: '' }, 'obr — как прежде: первый OBR, компонент 1');
});

test('R1 п. 1: разные номера в разных OBR — номера нет (спор), в sample_id оба', () => {
  const p = pickMessageSample(readResult(MULTI('LAB-000123', 'LAB-000124'), 'default').obrs, 'default');
  assert.deepEqual({ value: p.value, conflict: p.conflict, why: p.why, sampleId: p.sampleId },
    { value: '', conflict: true, why: 'obrs', sampleId: 'LAB-000123 / LAB-000124' });
  const bare = pickMessageSample(readResult(MULTI('LAB-000123', '15'), 'default').obrs, 'default');
  assert.equal(bare.conflict, true, 'LAB-000123 и голое «15» — тоже разные номера');
});

test('R1 п. 1 и 5: номер — первый НЕПУСТОЙ по OBR; тот же номер в разных записях — не спор', () => {
  assert.equal(pickMessageSample(readResult(MULTI('', 'LAB-000123'), 'default').obrs, 'default').value, 'LAB-000123',
    'до E5 parseMessage брал первый непустой OBR-3 — пустой первый не делает пробу ничьей');
  const same = pickMessageSample(readResult(MULTI('000123', 'LAB-000123'), 'default').obrs, 'default');
  assert.deepEqual([same.conflict, same.value, same.lab], [false, 'LAB-000123', true], 'тот же номер; этикетка бьёт голые цифры');
  assert.deepEqual(pickMessageSample([], 'default'), { sampleId: '', value: '', field: '', lab: false, conflict: false });
});

// П. 2 — компоненты поля. Раньше читался только компонент 1: OBR-3 =
// «2^LAB-000123» читалось как голое «2» и ложилось в открытый свежий заказ № 2.
test('R1 п. 2: LAB- узнаётся в ЛЮБОМ компоненте поля; голые цифры — только поле целиком из цифр', () => {
  const o = (filler) => ({ placer: '', filler, compSep: '^' });
  assert.deepEqual(pickSampleId(o('2^LAB-000123'), 'default'), { sampleId: 'LAB-000123', value: 'LAB-000123', field: 'OBR-3', lab: true, conflict: false });
  assert.equal(pickSampleId(o('^LAB-000123^'), 'default').value, 'LAB-000123');
  assert.equal(pickSampleId(o('000123'), 'default').value, '000123', 'поле целиком из цифр — голые цифры, как parseMessage');
  for (const notBare of ['2^15', '15^', '15^x', 'QC1', 'lab_000123']) {
    const p = pickSampleId(o(notBare), 'default');
    assert.deepEqual([p.value, p.foreign, p.sampleId], ['', true, notBare], '«' + notBare + '» — не этикетка и не голые цифры: номера нет');
  }
  const two = pickSampleId(o('LAB-000123^LAB-000124'), 'default');
  assert.deepEqual([two.value, two.conflict, two.why], ['', true, 'components'], 'разные номера в компонентах одного поля');
  assert.equal(pickSampleId(o('LAB-000123^lab-000123'), 'default').conflict, false, 'один номер дважды — не спор');
  // Поле «никогда» не читается и по компонентам.
  assert.equal(pickSampleId({ placer: '', filler: '2^LAB-000123', compSep: '^' }, 'mindray-chem').value, '');
  // Свой разделитель компонентов отправителя.
  assert.equal(pickSampleId({ placer: '', filler: '2*LAB-000123', compSep: '*' }, 'default').value, 'LAB-000123');
});

test('R1 п. 8: восьмизначный голый номер прежнего переадресателя — по-прежнему голые цифры', () => {
  const p = pickSampleId({ placer: '', filler: '29260001', compSep: '^' }, 'forwarder');
  assert.deepEqual([p.value, p.lab, !!p.foreign], ['29260001', false, false]);
});

// П. 7 — MSH-16 = 1/2 значит калибровку и контроль только у приборов, чей
// провод объявляет это соглашение: химия Mindray (BS-200, руководство с. 8) и
// Autobio по сети (тот же заголовок «…|2.3.1||||0||ASCII», A2000 plus HL7
// protocol V0.02). У прочих MSH-16 в виде сообщения не участвует.
// Ревью R2, п. 11 — у Autobio по сети соглашение не проверено (провод по
// драйверу, не по документу): MSH-16 = 1/2 у него — обычная проба; без
// этикетки LAB- она ляжет в лоток, где её видно. Проверить на приборе.
test('R1 п. 7, R2 п. 11: MSH-16 = 1/2 — служебное только у mindray-chem; прочие провода, и autobio-hl7, — проба', () => {
  const qc = (app, facility) => seg(`MSH|^~\\&|${app}|${facility}|||20261001090000||ORU^R01|1|P|2.3.1||||2||ASCII|||`, 'OBR|1||LAB-000123');
  assert.equal(readEnvelope(qc('X', 'Y'), 'mindray-chem').kind, 'qc');
  for (const wire of ['default', 'forwarder', 'mindray-hematology', 'autobio-hl7']) {
    assert.equal(readEnvelope(qc('X', 'Y'), wire).kind, 'result', wire);
    assert.equal(readEnvelope(qc('X', 'Y'), wire).service, false, wire);
  }
  // Провод не назван — по тому, как сообщение называет себя.
  assert.equal(readEnvelope(qc('Mindray', 'BS-200E')).kind, 'qc', 'BS-200 по MSH-4');
  assert.equal(readEnvelope(qc('A1000', 'Autolumo')).kind, 'result', 'Autobio — соглашение не проверено (R2, п. 11)');
  assert.equal(readEnvelope(qc('BC-5300', 'Mindray')).kind, 'result', 'гематология — соглашения нет');
  assert.equal(readEnvelope(qc('X', 'Y')).kind, 'result', 'незнакомый прибор — соглашения нет');
  // Запросы — по типу сообщения, у всех.
  assert.equal(readEnvelope('MSH|^~\\&|X|Y|||1||QRY^Q02|1|P|2.3.1', 'default').kind, 'query');
});

// П. 11 — провод и из того, как сообщение называет себя (MSH-3/MSH-4,
// псевдонимы профилей). Своё имя сообщения бьёт пустой профиль строки; при
// споре — БЕЗОПАСНЫЙ провод: OBR-3 никогда не читается, если сообщение
// называет себя BS-200.
test('R1 п. 11: провод по имени сообщения, если у профиля строки провода нет; при споре — безопасный', () => {
  const bs = { app: 'Mindray', facility: 'BS-200E' };
  assert.equal(wireFor({ profile: null, ...bs }), 'mindray-chem', 'строка без профиля');
  assert.equal(wireFor({ profile: { key: 'mindray-bs-240' }, ...bs }), 'mindray-chem', 'строка с чужим профилем без провода');
  assert.equal(wireFor({ profile: { wire: 'mindray-hematology' }, ...bs }), 'mindray-chem', 'спор: BS-200 — OBR-3 не читать');
  assert.equal(wireFor({ profile: { wire: 'autobio-hl7' }, ...bs }), 'mindray-chem');
  assert.equal(wireFor({ profile: { wire: 'mindray-chem' }, app: 'BC-780', facility: 'Mindray' }), 'mindray-chem', 'спор: строка BS-200 — безопаснее');
  assert.equal(wireFor({ profile: { wire: 'mindray-hematology' }, app: 'A1000', facility: 'Autolumo' }), 'autobio-hl7', 'спор: голые цифры только OBR-2');
  assert.equal(wireFor({ profile: null, app: 'A1000', facility: 'Autolumo' }), 'autobio-hl7');
  assert.equal(wireFor({ profile: { wire: 'mindray-chem' }, app: 'Mindray', facility: '' }), 'mindray-chem', 'сообщение себя не назвало — провод строки');
  assert.equal(wireFor({ profile: { wire: 'mindray-chem' }, app: 'AutoLumo A1000', facility: 'LabPC' }), 'forwarder', 'переадресатор — по MSH-4, как прежде');
  assert.equal(wireFor({ profile: null, app: 'BC-5300', facility: 'Mindray' }), 'default', 'прежние профили провода не называют');
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R2, п. 12 ────────────────────────────────
// Профиль строки и само сообщение называют РАЗНЫЕ провода (не default) — это
// спор: приём кладёт сообщение в лоток с причиной, а не выбирает наугад.
// wireFor по-прежнему отдаёт безопасный провод — им читается вид сообщения,
// номер для человека, «Поле анализатора».
test('R2 п. 12: wireDecision — спор, когда профиль и сообщение называют разные провода', () => {
  const bs = { app: 'Mindray', facility: 'BS-200E' };
  const c = wireDecision({ profile: { wire: 'mindray-hematology', model: 'BC-780' }, ...bs });
  assert.deepEqual({ wire: c.wire, conflict: c.conflict, rowModel: c.rowModel, messageModel: c.messageModel },
    { wire: 'mindray-chem', conflict: true, rowModel: 'BC-780', messageModel: 'BS-200' });
  assert.equal(wireDecision({ profile: null, ...bs }).conflict, false, 'строка без профиля — провод сообщения');
  assert.equal(wireDecision({ profile: { key: 'mindray-bs-240', model: 'BS-240' }, ...bs }).conflict, false, 'прежний профиль без провода');
  assert.equal(wireDecision({ profile: { wire: 'mindray-chem', model: 'BS-200' }, ...bs }).conflict, false, 'согласны');
  assert.equal(wireDecision({ profile: { wire: 'mindray-chem', model: 'BS-200' }, app: 'X', facility: 'Y' }).conflict, false, 'сообщение себя не назвало');
  assert.equal(wireDecision({ profile: { wire: 'mindray-chem', model: 'BS-200' }, app: 'AutoLumo A1000', facility: 'LabPC' }).wire, 'forwarder');
  assert.equal(wireFor({ profile: { wire: 'mindray-hematology' }, ...bs }), 'mindray-chem', 'wireFor — безопасный, как в R1');
});

// ── LIS_VENDOR_EXACT_V1 — D7: контроль гематологии — не проба пациента ──────
// BC-5300: контроль — ORU^R01 с MSH-11 = Q и OBR-4 = 00003–00008 (L-J, X, XB,
// X-R, средние X и X-R; руководство оператора BC-5300, приложение C, табл. 9).
// В OBR-3 — номер файла контроля, маленькое голое число («6»). Кадр — пример
// X-R-контроля из того же приложения (pdf 486–489), сокращён: имя оператора
// заменено, из 109 строк OBX оставлены четыре.
const BC5300_QC = seg(
  'MSH|^~\&|BC-5300|Mindray|||20081120171602||ORU^R01|1|Q|2.3.1||||||UNICODE',
  'PID|1||6666666||||20080807235959',
  'OBR|1||6|00006^XR QCR^99MRC|||20080807142518|||||||||||||||||HM||||||||Operator',
  'OBX|1|IS|05001^Qc Level^99MRC||M||||||F',
  'OBX|4|NM|6690-2^WBC^LN||0.00|10*9/L|||||F',
  'OBX|23|NM|777-3^PLT^LN||4|10*9/L|||||F',
  'PID|3||6666666',
  'OBR|3||6|00008^XR QCR Mean^99MRC||||||||||||||||||||HM',
  'OBX|83|NM|6690-2^WBC^LN||0.00|10*9/L|||||F',
);
// BC-20 — по руководству BC-3600 (то же семейство, приложение D, с. D-30–D-32):
// контроль L-J — MSH-11 = Q (в табл. D-2 — T или D), OBR-4 = 00003^LJ QCR^99MRC,
// в OBR-3 — номер файла контроля 1…12, в PID-3 — номер лота.
const BC20_QC = (msh11 = 'Q', obr4 = '00003^LJ QCR^99MRC') => seg(
  `MSH|^~\&|||||20101206164344||ORU^R01|1|${msh11}|2.3.1||||||UNICODE`,
  'PID|1||LOT123^^^^MR',
  `OBR|1||3|${obr4}||20000102030405|20010203040506`,
  'OBX|7|NM|6690-2^WBC^LN||7.10|10*9/L|||||F',
);

test('D7: гематология — контроль по MSH-11 (Q, T, D) или OBR-4 00003–00008 — служебное, не проба', async () => {
  const { getProfile } = await import('./profiles/index.js');
  const wireOf = (key, raw) => {
    const m = readEnvelope(raw);
    return wireFor({ profile: getProfile(key), facility: m.facility, app: m.app });
  };
  // BC-5300 называет себя «BC-5300|Mindray»; BC-20 — не называет (профиль строки).
  const e = readEnvelope(BC5300_QC, wireOf('mindray-bc-5300', BC5300_QC));
  assert.deepEqual([e.kind, e.service], ['qc', true]);
  assert.equal(readEnvelope(BC5300_QC).kind, 'qc', 'провод по имени сообщения — тот же');
  for (const msh11 of ['Q', 'T', 'D', 'q']) {
    assert.equal(readEnvelope(BC20_QC(msh11), wireOf('mindray-bc-20', BC20_QC(msh11))).kind, 'qc', 'MSH-11 = ' + msh11);
  }
  // OBR-4 сам по себе: тип результата — контроль, даже если MSH-11 = P.
  for (const code of ['00003', '00004', '00005', '00006', '00007', '00008']) {
    assert.equal(readEnvelope(BC20_QC('P', code + '^QCR^99MRC'), 'default').kind, 'qc', 'OBR-4 ' + code);
  }
  // Проба пациента: MSH-11 = P, OBR-4 = 00001 (счёт) или 00002 (микроскопия).
  assert.equal(readEnvelope(BC20_QC('P', '00001^Automated Count^99MRC'), 'default').kind, 'result');
  assert.equal(readEnvelope(BC20_QC('P', '00002^Manual Count^99MRC'), 'default').kind, 'result');
  assert.equal(readEnvelope(BC780('', 'LAB-000123'), 'mindray-hematology').kind, 'result');
  // BC-780 (mindray-hematology) — то же семейство, тот же признак.
  assert.equal(readEnvelope(BC20_QC(), 'mindray-hematology').kind, 'qc');
  // У прочих проводов MSH-11 и OBR-4 вида не меняют.
  for (const wire of ['forwarder', 'autobio-hl7', 'mindray-chem']) {
    assert.equal(readEnvelope(BC20_QC(), wire).kind, 'result', wire);
  }
});

// CL-900i и BS-240 — с D2 на mindray-chem: контроль — MSH-16 = 2, сообщение из
// MSH и OBR, в OBR-2 — НОМЕР КАНАЛА теста («7»), не номер пробирки. Кадр —
// пример руководства CL (Host Interface Manual, с. 1-28, pdf 36).
const CL_QC = seg(
  'MSH|^~\&|||||20120508103014||ORU^R01|1|P|2.3.1||||2||ASCII|||',
  'OBR|1|7|AST|^|0|20130729160839|20120405141255|20130729161552|||1|2|QUAL2|2222|20300101|0|M|55.000000|5.000000|0.137470|nkat/L|||||||||1||||||||||||||||||',
);

test('D7: CL-900i и BS-240 — контроль (MSH-16 = 2) и калибровка (1) по проводу профиля — служебные', async () => {
  const { getProfile } = await import('./profiles/index.js');
  for (const key of ['mindray-cl-900i', 'mindray-bs-240']) {
    const w = wireFor({ profile: getProfile(key), facility: '', app: '' });
    assert.equal(readEnvelope(CL_QC, w).kind, 'qc', key);
    assert.equal(readEnvelope(CL_QC.replace('||||2||ASCII', '||||1||ASCII'), w).kind, 'calibration', key);
    assert.equal(readEnvelope(CL_QC.replace('||||2||ASCII', '||||0||ASCII'), w).kind, 'result', key);
  }
  // На прежнем проводе default (до D2) тот же контроль читался как проба.
  assert.equal(readEnvelope(CL_QC, 'default').kind, 'result');
});
