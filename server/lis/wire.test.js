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
  assert.deepEqual(readResult('это не HL7', 'default'), { obr: null, observations: [] });
  assert.deepEqual(readResult(null, 'default'), { obr: null, observations: [] });
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
  // Один и тот же заказ, записанный по-разному, — не спор.
  assert.equal(pickSampleId(obr('LAB-123', 'lab_000123'), 'default').conflict, false);
  assert.equal(pickSampleId(obr('LAB-123', 'lab_000123'), 'default').value, 'lab_000123', 'основное поле, раз номера равны');
  // У BS-200 OBR-3 не читается — и спора нет.
  assert.equal(pickSampleId(obr('LAB-000124', 'LAB-000123'), 'mindray-chem').value, 'LAB-000124');
});

test('LAB- узнаётся так же, как parseSampleId: регистр, «_» и пробел; прочее — не LAB-', () => {
  assert.equal(pickSampleId(obr('lab 000123', '15'), 'default').value, 'lab 000123');
  assert.equal(pickSampleId(obr('LAB000123', '15'), 'default').value, 'LAB000123');
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
