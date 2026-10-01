// hl7.test.js — чистый разбор. Ни базы, ни сети, ни времени: всё, что здесь
// проверяется, это текст на входе и объект на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, buildAck, mshOf, ACK_INTERNAL } from './hl7.js';   // mshOf, ACK_INTERNAL: LIS_REAL_ANALYZERS_V1_ACK

const ORU = [
  'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
  'PID|1||||Иванов^Иван',
  'OBR|1||LAB-000123|00001^Automated Count^99MRC',
  'OBX|1|NM|WBC^Leukocytes^99MRC||6.1|10*9/L|4.0-9.0|N|||F',
  'OBX|2|NM|HGB^Hemoglobin^99MRC||142|g/L|130-160|N|||F',
].join('\r');

test('разбирает ORU: тип, номер сообщения, номер пробы, наблюдения', () => {
  const m = parseMessage(ORU);
  assert.equal(m.type, 'ORU^R01');
  assert.equal(m.controlId, '42');
  assert.equal(m.sampleId, 'LAB-000123');
  assert.equal(m.sendingApp, 'BC-5300', 'MSH-3: как прибор себя называет — на этом держится самоопределение');
  assert.equal(m.observations.length, 2);
  assert.deepEqual(m.observations[0], {
    valueType: 'NM', code: 'WBC', name: 'Leukocytes', system: '99MRC', codeRaw: 'WBC^Leukocytes^99MRC',
    value: '6.1', unit: '10*9/L', range: '4.0-9.0', abnormal: 'N', status: 'F',
  });
});

test('терпит CRLF вместо CR', () => {
  const m = parseMessage(ORU.split('\r').join('\r\n'));
  assert.equal(m.observations.length, 2, 'сегменты, разделённые CRLF, обязаны разобраться');
});

test('честно читает СВОИ разделители из MSH-2', () => {
  // Прибор объявил компонентным разделителем '*'. Зашитый '^' здесь прочитал бы
  // код канала как «WBC*Leukocytes*99MRC» целиком и не нашёл бы сопоставления.
  const odd = [
    'MSH|*~\\&|BC-5300|Mindray|||20260910143943||ORU*R01|42|P|2.3.1',
    'OBR|1||LAB-000123|00001*Automated Count*99MRC',
    'OBX|1|NM|WBC*Leukocytes*99MRC||6.1|10*9/L||N|||F',
  ].join('\r');
  const m = parseMessage(odd);
  assert.equal(m.type, 'ORU^R01', 'тип нормализуется в наш вид независимо от разделителя отправителя');
  assert.equal(m.observations[0].code, 'WBC', 'компонентный разделитель обязан браться из MSH-2, а не быть зашитым');
});

test('пустой OBR-3 — это отсутствие номера пробы, а не пустая строка', () => {
  const m = parseMessage(ORU.replace('LAB-000123', ''));
  assert.equal(m.sampleId, '');
});

test('не-ORU отвергается с причиной', () => {
  assert.throws(() => parseMessage(ORU.replace('ORU^R01', 'ADT^A01')), /ORU/);
});

test('QRY^Q02 узнаётся отдельно — это запрос рабочего списка, а не результат', () => {
  const qry = 'MSH|^~\\&|BC-20|Mindray|||20260910143943||QRY^Q02|7|P|2.3.1';
  assert.throws(() => parseMessage(qry), /QRY\^Q02/);
});

test('пустое сообщение и сообщение без MSH отвергаются', () => {
  assert.throws(() => parseMessage(''), /пустое/);
  assert.throws(() => parseMessage('OBX|1|NM|WBC||6.1'), /MSH/);
});

test('ACK и NAK имеют правильную форму и несут номер исходного сообщения', () => {
  assert.match(buildAck('42', 'AA'), /MSA\|AA\|42/);
  assert.match(buildAck('42', 'AE'), /MSA\|AE\|42/);
  assert.match(buildAck('42', 'AA'), /^MSH\|\^~\\&\|/);
});

// LIS_MINDRAY_CODES_V1 — Mindray пишет OBX-3 как «LOINC^ИМЯ^LN». Раньше выживал
// только первый компонент, и бланк, привязанный к «WBC», оставался пустым.
test('«6690-2^WBC^LN» разбирается на код, имя и систему, поле целиком сохраняется', () => {
  const m = parseMessage([
    'MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|7|P|2.3.1',
    'OBR|1||LAB-000098|00001^Automated Count^99MRC',
    'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
    'OBX|2|NM|6690-2^WBC^LN||9.81|10*9/L|4.00-10.00|H~N|||F',
    'OBX|3|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r'));
  const [mode, loinc, plain] = m.observations;
  assert.equal(mode.valueType, 'IS');
  assert.equal(mode.name, 'Take Mode');
  assert.equal(loinc.code, '6690-2');
  assert.equal(loinc.name, 'WBC');
  assert.equal(loinc.system, 'LN');
  assert.equal(loinc.codeRaw, '6690-2^WBC^LN', 'человек в журнале видит обе части');
  assert.equal(loinc.abnormal, 'H', 'OBX-8 «H~N»: смысл несёт первое повторение');
  assert.equal(plain.code, 'WBC');
  assert.equal(plain.name, '', 'у «WBC^^99MRC» имени нет — и это не ошибка');
  assert.equal(plain.codeRaw, 'WBC^^99MRC');
});

// ── LIS_REAL_ANALYZERS_V1_ACK — ответ прибору по руководству ────────────────
// «BS-200 Host Interface Manual» v1.2 (обезличенная копия — «Chemistry Analyzer
// Host Interface Manual»), с. 8–9 и 23–28. Примеры ниже — оттуда дословно;
// «Manufacturer|Model» заменены на то, как называет себя BS-200.
const BS200_ORU = [
  'MSH|^~\\&|Mindray|BS-200E|||20070719145353||ORU^R01|1|P|2.3.1||||0||ASCII|||',
  'PID|1|854||12|Tommy||19830719145307|F|A||||||||||||||||||||||',
  'OBR|1|0000000002|2|Mindray^BS-200E|Y||||||||||serum|||||||||||||||||||||||||||||||||',
  'OBX|1|NM|2|test2|5.000000|g/ml|-||||F|||||||',
].join('\r');

// Пустые поля в конце сегмента в HL7 смысла не несут: руководство пишет
// «…|ASCII|||», Easy-Med — «…|ASCII». Сравнивается всё остальное, поле в поле.
const fieldsOf = (seg) => { const f = seg.split('|'); while (f.length && f[f.length - 1] === '') f.pop(); return f; };

test('mshOf: терпимый разбор MSH — поля заголовка и ничего не бросает', () => {
  const m = mshOf(BS200_ORU);
  assert.equal(m.ok, true);
  assert.equal(m.app, 'Mindray', 'MSH-3 у BS-200 — производитель');
  assert.equal(m.facility, 'BS-200E', 'MSH-4 у BS-200 — модель');
  assert.equal(m.type, 'ORU^R01');
  assert.equal(m.event, 'R01');
  assert.equal(m.controlId, '1');
  assert.equal(m.version, '2.3.1');
  assert.equal(m.ackType, '0', 'MSH-16: 0 — проба, 1 — калибровка, 2 — контроль (с. 8)');
  assert.equal(m.charset, 'ASCII', 'MSH-18');
  for (const junk of ['', null, undefined, 'это не HL7', 'OBX|1|NM|WBC||6.1', 'MSH']) {
    const j = mshOf(junk);
    assert.equal(j.ok, false, String(junk));
    assert.equal(j.controlId, '');
    assert.equal(j.type, '');
  }
});

test('mshOf: свои разделители отправителя из MSH-2', () => {
  const m = mshOf('MSH|*~\\&|BC-5300*X|Mindray|||20260910143943||ORU*R01|42|P|2.3.1');
  assert.equal(m.type, 'ORU^R01', 'тип нормализуется в наш вид');
  assert.equal(m.event, 'R01');
  assert.equal(m.app, 'BC-5300');
  assert.equal(m.controlId, '42');
});

test('ответ на ORU BS-200 совпадает с примером руководства (с. 25), кроме времени и MSH-3/4', () => {
  const ack = buildAck(mshOf(BS200_ORU), 'AA').split('\r');
  assert.equal(ack.length, 2);
  // с. 25: «MSH|^~\&|||Manufacturer|Model|20070719145307||ACK^R01|1|P|2.3.1||||0||ASCII|||»
  const want = fieldsOf('MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|<время>||ACK^R01|1|P|2.3.1||||0||ASCII|||');
  const got = fieldsOf(ack[0]);
  assert.match(got[6], /^\d{14}$/, 'MSH-7 — время ответа');
  got[6] = '<время>';
  assert.deepEqual(got, want, 'MSH-5/6 — эхо MSH-3/4 («fields 5 and 6 are set to Manufacturer and Model», с. 8); MSH-10 — номер входящего');
  // с. 25: «MSA|AA|1|Message accepted|||0|»
  assert.deepEqual(fieldsOf(ack[1]), fieldsOf('MSA|AA|1|Message accepted|||0|'));
});

test('ответ на контроль качества несёт MSH-16 = 2 эхом (с. 27)', () => {
  const qc = 'MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|1|P|2.3.1||||2||ASCII|||';
  const [mshLine, msa] = buildAck(mshOf(qc), 'AA').split('\r');
  // с. 27: «MSH|^~\&|||Manufacturer|Model|20070720120225||ACK^R01|1|P|2.3.1||||2||ASCII|||»
  const got = fieldsOf(mshLine);
  got[6] = '<время>';
  assert.deepEqual(got, fieldsOf('MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|<время>||ACK^R01|1|P|2.3.1||||2||ASCII|||'));
  assert.equal(msa, 'MSA|AA|1|Message accepted|||0');
});

test('гематология Mindray: MSH-18 UNICODE эхом, MSH-5/6 — её MSH-3/4', () => {
  const oru = 'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|7|P|2.3.1||||||UNICODE';
  const f = fieldsOf(buildAck(mshOf(oru), 'AA').split('\r')[0]);
  assert.equal(f[4], 'BC-780');
  assert.equal(f[5], 'Mindray');
  assert.equal(f[8], 'ACK^R01');
  assert.equal(f[9], '7');
  assert.equal(f[15], '', 'MSH-16 пуст — пуст и в ответе');
  assert.equal(f[17], 'UNICODE');
});

test('прибор без MSH-16 и MSH-18 получает заголовок без хвоста — как прежде', () => {
  // Существующие приборы (BC-5300, переадресатор) MSH-16/18 не шлют: их ответ
  // оканчивается на MSH-12, как и до этой правки.
  const mshLine = buildAck(mshOf('MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1'), 'AA').split('\r')[0];
  assert.match(mshLine, /^MSH\|\^~\\&\|EASYMED\|CLINIC\|BC-5300\|Mindray\|\d{14}\|\|ACK\^R01\|42\|P\|2\.3\.1$/);
});

test('неразобранное: голый ACK и MSA|AE||Segment sequence error|||100', () => {
  const [mshLine, msa] = buildAck(mshOf('это не HL7'), 'AE').split('\r');
  const f = fieldsOf(mshLine);
  assert.equal(f[8], 'ACK', 'событие не разобралось — голый ACK, как сегодня');
  assert.equal(f[9], '1', 'MSH-10 ответа не бывает пустым');
  assert.equal(msa, 'MSA|AE||Segment sequence error|||100');
});

test('известный, но не поддержанный тип (ADT^A01) — AR 200, отказ без повтора', () => {
  const adt = 'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1';
  const [mshLine, msa] = buildAck(mshOf(adt), 'AR').split('\r');
  assert.equal(fieldsOf(mshLine)[8], 'ACK^A01');
  assert.equal(msa, 'MSA|AR|43|Unsupported message type|||200');
});

test('сорвалась запись или переросшее — AE 207 «Application internal error»', () => {
  const msa = buildAck(mshOf(BS200_ORU), 'AE', ACK_INTERNAL).split('\r')[1];
  assert.equal(msa, 'MSA|AE|1|Application internal error|||207');
});

test('прежняя форма buildAck(номер, код) по-прежнему отвечает с номером', () => {
  const [mshLine, msa] = buildAck('42', 'AE').split('\r');
  assert.equal(fieldsOf(mshLine)[9], '42');
  assert.equal(msa, 'MSA|AE|42|Segment sequence error|||100');
});
