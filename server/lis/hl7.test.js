// hl7.test.js — чистый разбор. Ни базы, ни сети, ни времени: всё, что здесь
// проверяется, это текст на входе и объект на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, buildAck, mshOf, ACK_INTERNAL } from './hl7.js';   // mshOf, ACK_INTERNAL: LIS_REAL_ANALYZERS_V1_ACK
import { buildQueryReply } from './hl7.js';   // LIS_VENDOR_EXACT_V1 — QCK^Q02 и ORR^O02 в виде производителя

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

// Пустые поля в конце сегмента — для сравнения поле в поле. Точный вид ответа
// (хвост «…|ASCII|||», «|» после MSA-6, CR после каждого сегмента) проверяется
// байт в байт ниже, в разделе LIS_VENDOR_EXACT_V1.
const fieldsOf = (seg) => { const f = seg.split('|'); while (f.length && f[f.length - 1] === '') f.pop(); return f; };
// LIS_VENDOR_EXACT_V1 — сегменты ответа: CR после КАЖДОГО, и последнего тоже
// (HIM v5.0, с. 3 и 23: «Each HL7 message is composed of segments that end with
// <CR>»), поэтому split даёт пустой хвост — он отбрасывается.
const linesOf = (reply) => { const l = reply.split('\r'); assert.equal(l.pop(), '', 'ответ кончается CR'); return l; };

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

// LIS_REAL_ANALYZERS_V1_SERVICE — заголовок ищется так же, как у parseMessage:
// иначе проба, которую приём разобрал и применил, получила бы ответ «не
// разобрано», и прибор слал бы её снова.
test('mshOf: пустые строки перед MSH пропускаются — как у parseMessage', () => {
  const text = '\r\n' + BS200_ORU;
  assert.equal(parseMessage(text).type, 'ORU^R01');
  assert.equal(mshOf(text).ok, true);
  assert.equal(mshOf(text).controlId, '1');
  assert.equal(mshOf('  MSH|^~\\&|X').ok, false, 'MSH не с начала сегмента — не заголовок, как и у parseMessage');
});

test('mshOf: свои разделители отправителя из MSH-2', () => {
  const m = mshOf('MSH|*~\\&|BC-5300*X|Mindray|||20260910143943||ORU*R01|42|P|2.3.1');
  assert.equal(m.type, 'ORU^R01', 'тип нормализуется в наш вид');
  assert.equal(m.event, 'R01');
  assert.equal(m.app, 'BC-5300');
  assert.equal(m.controlId, '42');
});

// LIS_VENDOR_EXACT_V1 — было «совпадает поле в поле, хвост не важен»: ответ
// без хвоста роняет BS200.exe (кусок 27 = MSA-6 отсутствует) и блокирует
// CL-900i (MSH короче 19 полей). Теперь — байт в байт с примером руководства:
// HIM v5.0 (BS-120…BS-350E, P/N BA20-20-75337), с. 25 (pdf 30), §2.1
// analyzers\mindray-bs-200.manual-check.md.
test('ответ на ORU BS-200 — пример руководства (с. 25) байт в байт, кроме MSH-3/4 (EASYMED|CLINIC, с. 8) и времени', () => {
  const ack = buildAck(mshOf(BS200_ORU), 'AA');
  const [mshLine] = linesOf(ack);
  const stamp = mshLine.split('|')[6];
  assert.match(stamp, /^\d{14}$/, 'MSH-7 — время ответа');
  // с. 25: «MSH|^~\&|||Manufacturer|Model|20070719145307||ACK^R01|1|P|2.3.1||||0||ASCII|||<CR>MSA|AA|1|Message accepted|||0|<CR>»
  // MSH-5/6 — эхо MSH-3/4 («fields 5 and 6 are set to Manufacturer and Model», с. 8); MSH-10 — номер входящего.
  assert.equal(ack, `MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|${stamp}||ACK^R01|1|P|2.3.1||||0||ASCII|||\rMSA|AA|1|Message accepted|||0|\r`);
});

test('ответ на контроль качества несёт MSH-16 = 2 эхом (с. 26, байт в байт)', () => {
  const qc = 'MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|1|P|2.3.1||||2||ASCII|||';
  const ack = buildAck(mshOf(qc), 'AA');
  const stamp = ack.split('|')[6];
  // с. 26: «…||ACK^R01|1|P|2.3.1||||2||ASCII|||<CR>MSA|AA|1|Message accepted|||0|<CR>»
  assert.equal(ack, `MSH|^~\\&|EASYMED|CLINIC|Mindray|BS-200E|${stamp}||ACK^R01|1|P|2.3.1||||2||ASCII|||\rMSA|AA|1|Message accepted|||0|\r`);
});

test('гематология Mindray (короткий вид): MSH-18 UNICODE эхом, MSH-5/6 — её MSH-3/4', () => {
  const oru = 'MSH|^~\\&|BC-780|Mindray|||20261001090000||ORU^R01|7|P|2.3.1||||||UNICODE';
  const f = fieldsOf(linesOf(buildAck(mshOf(oru), 'AA', { layout: 'short' }))[0]);
  assert.equal(f[4], 'BC-780');
  assert.equal(f[5], 'Mindray');
  assert.equal(f[8], 'ACK^R01');
  assert.equal(f[9], '7');
  assert.equal(f[15], '', 'MSH-16 пуст — пуст и в ответе');
  assert.equal(f[17], 'UNICODE');
});

// LIS_VENDOR_EXACT_V1 — короткий заголовок остаётся только у гематологии; у
// переадресателя и незнакомого прибора — вид руководства (MSH-18 = ASCII, если
// прибор его не прислал: mindray-bs-240.md M15).
test('без MSH-16 и MSH-18: короткий вид (гематология) кончается на MSH-12, длинный — хвостом «||||||ASCII|||»', () => {
  const m = mshOf('MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1');
  assert.match(linesOf(buildAck(m, 'AA', { layout: 'short' }))[0], /^MSH\|\^~\\&\|EASYMED\|CLINIC\|BC-5300\|Mindray\|\d{14}\|\|ACK\^R01\|42\|P\|2\.3\.1$/);
  assert.match(linesOf(buildAck(m, 'AA'))[0], /^MSH\|\^~\\&\|EASYMED\|CLINIC\|BC-5300\|Mindray\|\d{14}\|\|ACK\^R01\|42\|P\|2\.3\.1\|\|\|\|\|\|ASCII\|\|\|$/);
});

test('неразобранное: голый ACK и MSA|AE||Segment sequence error|||100|', () => {
  const [mshLine, msa] = linesOf(buildAck(mshOf('это не HL7'), 'AE'));
  const f = fieldsOf(mshLine);
  assert.equal(f[8], 'ACK', 'событие не разобралось — голый ACK, как сегодня');
  assert.equal(f[9], '1', 'MSH-10 ответа не бывает пустым');
  assert.equal(msa, 'MSA|AE||Segment sequence error|||100|');
});

test('известный, но не поддержанный тип (ADT^A01) — AR 200, отказ без повтора', () => {
  const adt = 'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1';
  const [mshLine, msa] = linesOf(buildAck(mshOf(adt), 'AR'));
  assert.equal(fieldsOf(mshLine)[8], 'ACK^A01');
  assert.equal(msa, 'MSA|AR|43|Unsupported message type|||200|');
});

test('сорвалась запись или переросшее — 207 «Application internal error»', () => {
  const msa = linesOf(buildAck(mshOf(BS200_ORU), 'AE', ACK_INTERNAL))[1];
  assert.equal(msa, 'MSA|AE|1|Application internal error|||207|');
});

test('прежняя форма buildAck(номер, код) по-прежнему отвечает с номером', () => {
  const [mshLine, msa] = linesOf(buildAck('42', 'AE'));
  assert.equal(fieldsOf(mshLine)[9], '42');
  assert.equal(msa, 'MSA|AE|42|Segment sequence error|||100|');
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R1, п. 9: эхо в ответе ────────────────────
// MSH-16 эхом — только числа 0/1/2 из руководства BS-200 (с. 8: «0- Sample
// result; 1- Calibration result; 2- QC result»). Стандартные AL/NE/ER/SU —
// просьба отправителя о виде подтверждения, а не вид результата: в ответ они
// не возвращаются.
test('R1 п. 9: MSH-16 эхом — только 0/1/2; AL, NE, ER, SU и прочее — пусто', () => {
  for (const v of ['0', '1', '2']) {
    const f = buildAck(mshOf(`MSH|^~\\&|Mindray|BS-200E|||20070719145353||ORU^R01|1|P|2.3.1||||${v}||ASCII`), 'AA').split('\r')[0].split('|');
    assert.equal(f[15], v, v);
  }
  for (const v of ['AL', 'NE', 'ER', 'SU', '3', '22', 'x']) {
    const f = buildAck(mshOf(`MSH|^~\\&|X|Y|||20070719145353||ORU^R01|1|P|2.3.1||||${v}||ASCII`), 'AA').split('\r')[0].split('|');
    assert.equal(f[15] || '', '', v + ' не эхом');
    assert.equal(f[17], 'ASCII', 'MSH-18 — эхом, как прежде');
  }
});

test('R1 п. 9: номер сообщения, MSH-12 и MSH-18 чистятся так же, как MSH-3/4 — чужой разделитель не ломает ответ', () => {
  // Отправитель с разделителем полей «#»: «|» в его полях — просто знак, но в
  // нашем ответе разделитель — «|», и без чистки поля бы съехали.
  const m = mshOf('MSH#^~\\&#X|1#Y#####ORU^R01#4|2#P#2.3|1####2##AS|CII');
  const [mshLine, msa] = linesOf(buildAck(m, 'AA'));
  const f = mshLine.split('|');
  assert.equal(f[9], '4 2', 'MSH-10');
  assert.equal(f[11], '2.3 1', 'MSH-12');
  assert.equal(f[17], 'AS CII', 'MSH-18');
  assert.equal(f[4], 'X 1', 'MSH-5 — эхо MSH-3, как прежде');
  assert.equal(msa, 'MSA|AA|4 2|Message accepted|||0|', 'MSA-2 — тот же чищеный номер');
});

// ── LIS_VENDOR_EXACT_V1 — D1 и D13: ответ прибору в виде производителя ──────
// Сообщения и ожидаемые ответы — раскладка производителя с синтетическими
// значениями, слово в слово из analyzer-research\notes\capture-kit\tests\
// run-tests.ps1 (BS200_ORU, CL_ORU, CL_QC, BS200_QRY, CL_QRY, BC5300_ORU,
// BC5300_QC, ORM, A1000_TEST, A1000_SAMPLE; ответы X_BS200_ACK, X_CL_ACK,
// X_CL_ACK_QC, X_BS200_QCK, X_CL_QCK, X_HEME_ACK, X_HEME_ACK_QC, X_HEME_ORR), а
// те сверены байт в байт с примерами: HIM v5.0 BS-200 с. 25–27
// (mindray-bs-200.manual-check.md §2), CL-900i HIM pdf 35–36, BC-5300 OM13
// pdf 485–490, декодер A1000 (autobio-autolumo-a1000.settle.md, табл. c).
// Отличия от строк набора, и только они: MSH-3/4 ответа = EASYMED|CLINIC
// (руководство оставляет их LIS: «Fields 3 and 4 are determined by LIS
// manufacturer», HIM v5.0 с. 8) и MSH-7 — время ответа.
const CRX = '\r';
/** Как пишет прибор: CR после каждого сегмента (Seg в run-tests.ps1). */
const segs = (...s) => s.join(CRX) + CRX;
/**
 * Ожидаемый ответ из строки набора: {TS} — MSH-7 самого ответа (Test-Frame в
 * run-tests.ps1), MSH-3/4 — наши EASYMED|CLINIC; MSH-5/6 — как в строке
 * набора, если не названы (у гематологии производитель оставляет их пустыми,
 * Easy-Med возвращает в них MSH-3/4 прибора, как всегда).
 */
const expectFrom = (kit, reply, { msh5, msh6 } = {}) => {
  const [mshLine, ...rest] = kit.replace('{TS}', reply.split('|')[6]).split(CRX);
  const f = mshLine.split('|');
  f[2] = 'EASYMED';
  f[3] = 'CLINIC';
  if (msh5 !== undefined) f[4] = msh5;
  if (msh6 !== undefined) f[5] = msh6;
  return [f.join('|'), ...rest].join(CRX);
};
/**
 * Разрез BS200.exe (0x7886e7; notes\bs200-probes\manual-check-pieces.mjs):
 * весь ответ режется по «|», кусок — с 1, текст после последнего «|» — не кусок.
 */
const piece = (reply, n) => {
  const out = [];
  let rest = reply;
  for (let i = rest.indexOf('|'); i !== -1; i = rest.indexOf('|')) { out.push(rest.slice(0, i)); rest = rest.slice(i + 1); }
  return out[n - 1];
};
/** Правило CL-900i (SM Fig 12-30, pdf 603): «|» после «^~\&» в MSH ответа — не меньше 19. */
const clCount = (reply) => { const msh = reply.split(CRX)[0]; return (msh.slice(msh.indexOf('^~\\&') + 4).match(/\|/g) || []).length; };
const bars = (line) => (line.match(/\|/g) || []).length;

const KIT_BS200_ORU = (id) => segs(`MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|${id}|P|2.3.1||||0||ASCII|||`, 'PID|1',
  'OBR|1|LAB-000123|12|Mindray^BS-200|N||20261005101200||||||||serum', 'OBX|1|NM|GLU|Glucose|5.230000|mmol/L|3.900000-6.100000|N|||F|||20261005101200');
const KIT_CL_ORU = segs('MSH|^~\\&|||||20120508094822||ORU^R01|1|P|2.3.1||||0||ASCII|||', 'PID|1|TEST-0001|||||||||||||||||||||||||||',
  'OBR|1|LAB-000125|10|^|Y|20120405193926|20120405193914|20120405193914||||||20120405193914|serum|||||||||3|||||||||||||||||||||||',
  'OBX|1|NM|2|TBil|100| umol/L |-|N|||F||100|20120405194245||tester|0|');
const KIT_CL_QC = segs('MSH|^~\\&|||||20120508103014||ORU^R01|1|P|2.3.1||||2||ASCII|||',
  'OBR|1|7|AST|^|0|20130729160839|20120405141255|20130729161552|||1|2|QUAL2|2222|20300101|0|M|55.000000|5.000000|0.137470|nkat/L|||||||||1||||||||||||||||||');
const KIT_BS200_QRY = segs('MSH|^~\\&|Mindray|BS-200|||20261005101500||QRY^Q02|8|P|2.3.1||||||ASCII|||', 'QRD|20261005101500|R|D|1|||RD|LAB-000123|OTH|||T|', 'QRF|BS-200|||||RCT|COR|ALL||');
const KIT_CL_QRY = segs('MSH|^~\\&|||||20190222102859||QRY^Q02|10|P|2.3.1||||||ASCII|||', 'QRD|20190222102859|R|D|9|||RD|LAB-000126|OTH|||T|', 'QRF||||||RCT|COR|ALL||');
const KIT_BC5300_ORU = (id) => segs(`MSH|^~\\&|BC-5300|Mindray|||20080419104618||ORU^R01|${id}|P|2.3.1||||||UNICODE`, 'PID|1||TEST-0002^^^^MR', 'PV1|1',
  'OBR|1||LAB-000127|00001^Automated Count^99MRC||20071207080000|20071207160000|||Mindray||||20071207083000||||||||||HM||||||||Mindray',
  'OBX|6|NM|6690-2^WBC^LN||4.63|10*9/L|11.00-12.00|L|||F||E');
const KIT_BC5300_QC = segs('MSH|^~\\&|BC-5300|Mindray|||20081120171602||ORU^R01|1|Q|2.3.1||||||UNICODE', 'PID|1||LOT1234^^^^MR||||20301231',
  'OBR|1||6|00003^LJ QCR^99MRC||||||||||||||||||||HM', 'OBX|1|NM|6690-2^WBC^LN||7.10|10*9/L|||||F');
const KIT_ORM = (id) => segs(`MSH|^~\\&|BC-5300|Mindray|||20081120174836||ORM^O01|${id}|P|2.3.1||||||UNICODE`, 'ORC|RF||SampleID1||IP');
const KIT_A1000_TEST = (obx1, obr2, val) => segs('MSH|^~\\&|||||20261005120000||ORU^R01|5|P|2.3.1|261005120000123', `OBR|1|${obr2}|7764|AutoLumo A1000`,
  'NTE|||180323~~AFP~107~20271231~DQ70~1', `OBX|${obx1}|CE|107|107|41765^${val}~||||||F|||2026/10/05 12:00:00`);
const KIT_A1000_SAMPLE = segs('MSH|^~\\&|||||20261005120000||ORU^R01|7|P|2.3.1|261005120000124', 'OBR|1|LAB-000123|7764|AutoLumo A1000',
  'OBX||CE|107||41765^4.17||||||F', 'OBX||CE|112||22000^1.23||||||F');

const X_BS200_ACK = (id) => `MSH|^~\\&|||Mindray|BS-200|{TS}||ACK^R01|${id}|P|2.3.1||||0||ASCII|||\rMSA|AA|${id}|Message accepted|||0|\r`;
const X_CL_ACK = 'MSH|^~\\&|||||{TS}||ACK^R01|1|P|2.3.1||||0||ASCII|||\rMSA|AA|1|Message accepted|||0|\r';
const X_CL_ACK_QC = 'MSH|^~\\&|||||{TS}||ACK^R01|1|P|2.3.1||||2||ASCII|||\rMSA|AA|1|Message accepted|||0|\r';
const X_BS200_QCK = 'MSH|^~\\&|||Mindray|BS-200|{TS}||QCK^Q02|8|P|2.3.1||||||ASCII|||\rMSA|AA|8|Message accepted|||0|\rERR|0|\rQAK|SR|NF|\r';
const X_CL_QCK = 'MSH|^~\\&|||||{TS}||QCK^Q02|10|P|2.3.1||||||ASCII|||\rMSA|AA|10|Message accepted|||0|\rERR|0|\rQAK|SR|NF|\r';
const X_HEME_ACK = (id) => `MSH|^~\\&|LIS||||{TS}||ACK^R01|${id}|P|2.3.1||||||UNICODE\rMSA|AA|${id}\r`;
const X_HEME_ACK_QC = 'MSH|^~\\&|LIS||||{TS}||ACK^R01|1|Q|2.3.1||||||UNICODE\rMSA|AA|1\r';
const X_HEME_ORR = 'MSH|^~\\&|LIS||||{TS}||ORR^O02|1|P|2.3.1||||||UNICODE\rMSA|AR|9\r';

test('D1: BS-200 (BS200.exe) — ACK^R01 = X_BS200_ACK байт в байт; MSH 20 «|», MSA 7; кусок 10 = MSH-10, кусок 27 = MSA-6; CL ≥ 19', () => {
  const reply = buildAck(mshOf(KIT_BS200_ORU(17)), 'AA', { layout: 'long' });
  assert.equal(reply, expectFrom(X_BS200_ACK(17), reply));
  const [mshLine, msa] = linesOf(reply);
  assert.equal(bars(mshLine), 20, 'MSH до MSH-20 с хвостом «|ASCII|||» (HIM v5.0 с. 25)');
  assert.equal(bars(msa), 7, 'MSA с «|» после MSA-6');
  assert.equal(piece(reply, 10), '17', 'BS200.exe: кусок 10 — MSH-10 (push 0xa)');
  assert.equal(piece(reply, 27), '0', 'BS200.exe: кусок 27 — MSA-6 (push 0x1b); раньше его не было — NULL');
  assert.ok(clCount(reply) >= 19, 'CL-900i: «MSH segment field count < 19 error» — ' + clCount(reply));
  assert.ok(reply.endsWith('|\r'), 'кадр кончается «|<CR><FS><CR>»');
});

test('D1: незнакомый прибор (вид не назван) — тот же вид руководства; BS-240/CL-900i с пустыми MSH-3/4 — X_CL_ACK', () => {
  const reply = buildAck(mshOf(KIT_CL_ORU), 'AA');
  assert.equal(reply, expectFrom(X_CL_ACK, reply));
  assert.ok(clCount(reply) >= 19);
  assert.equal(piece(reply, 27), '0');
});

test('D1: контроль CL-900i (HIM pdf 36, MSH-16 = 2) — X_CL_ACK_QC байт в байт', () => {
  const reply = buildAck(mshOf(KIT_CL_QC), 'AA', { layout: 'long' });
  assert.equal(reply, expectFrom(X_CL_ACK_QC, reply));
});

test('D1: сорвалась запись у химии — AR 206 «Application record locked» (HIM v5.0 с. 9 и пример с. 25: MSA|AR|1|Application record locked|||206|)', async () => {
  const { ACK_LOCKED } = await import('./hl7.js');
  const reply = buildAck(mshOf(KIT_BS200_ORU(1)), 'AR', { ...ACK_LOCKED, layout: 'long' });
  assert.equal(linesOf(reply)[1], 'MSA|AR|1|Application record locked|||206|');
  assert.equal(piece(reply, 27), '206', 'BS200.exe читает MSA-6 — тревога с кодом 206');
});

test('D1: QCK^Q02 «заказов нет» — X_BS200_QCK / X_CL_QCK байт в байт (HIM v5.0 с. 27); куски 10, 27, 32; MSH-16 пуст', () => {
  for (const [qry, kit, id] of [[KIT_BS200_QRY, X_BS200_QCK, '8'], [KIT_CL_QRY, X_CL_QCK, '10']]) {
    const reply = buildQueryReply(mshOf(qry));
    assert.equal(reply, expectFrom(kit, reply));
    assert.equal(piece(reply, 10), id);
    assert.equal(piece(reply, 27), '0');
    assert.equal(piece(reply, 32), 'NF', 'BS200.exe: кусок 32 — QAK-2 (push 0x20)');
    assert.ok(clCount(reply) >= 19, 'SM Fig 12-30: отвергнутый QCK кончался «ASCII||»');
    assert.equal(linesOf(reply)[0].split('|')[15], '', 'MSH-16 «is void in non-ORU messages» (HIM v5.0 с. 8)');
  }
});

test('D1/D13: гематология (короткий вид) — MSH байт в байт как X_HEME_ACK (OM13 pdf 485), кроме MSH-3…6 и MSH-7; CR после MSA', () => {
  const reply = buildAck(mshOf(KIT_BC5300_ORU(42)), 'AA', { layout: 'short' });
  const [mshLine, msa] = linesOf(reply);
  const [kitMsh, kitMsa] = expectFrom(X_HEME_ACK(42), reply, { msh5: 'BC-5300', msh6: 'Mindray' }).split(CRX);
  assert.equal(mshLine, kitMsh, 'короткий заголовок — 17 «|», как в примере производителя');
  // MSA-1 и MSA-2 — как в примере; MSA-3 и MSA-6 из таблиц 2–3 OM13 остаются,
  // как сегодня (REPORT D1: «keep today's short form»; settle, табл. c, S2:
  // декодер A1000 без MSA-6 ответ выбрасывает).
  assert.equal(msa, kitMsa + '|Message accepted|||0');
  assert.ok(reply.endsWith('|0\r'), 'CR после последнего сегмента («Every segment ends with <CR>», OM13 C.2.1)');
});

test('D13: гематология — MSH-11 эхом: контроль BC-5300 (MSH-11 = Q) получает Q (OM13 pdf 489, X_HEME_ACK_QC)', () => {
  const reply = buildAck(mshOf(KIT_BC5300_QC), 'AA', { layout: 'short' });
  const kitMsh = expectFrom(X_HEME_ACK_QC, reply, { msh5: 'BC-5300', msh6: 'Mindray' }).split(CRX)[0];
  assert.equal(linesOf(reply)[0], kitMsh);
});

test('D13: MSH-11 эхом в любом ответе — P, Q, T, D; иное и пусто — P', () => {
  for (const [v, want] of [['P', 'P'], ['Q', 'Q'], ['T', 'T'], ['D', 'D'], ['Q^A', 'Q'], ['X', 'P'], ['', 'P']]) {
    const m = mshOf(`MSH|^~\\&|X|Y|||20261005101500||ORU^R01|3|${v}|2.3.1||||0||ASCII|||`);
    for (const layout of ['long', 'short']) {
      assert.equal(linesOf(buildAck(m, 'AA', { layout }))[0].split('|')[10], want, `${layout}: MSH-11 «${v}»`);
    }
  }
});

test('D13: ORM^O01 гематологии — ORR^O02 с MSA|AR|<id> (OM13 pdf 490, X_HEME_ORR), а не ACK^O01', () => {
  const reply = buildQueryReply(mshOf(KIT_ORM(9)), { layout: 'short' });
  const [mshLine, msa] = linesOf(reply);
  // MSH-10: производитель печатает свой номер «1»; Easy-Med, как во всех
  // ответах, возвращает номер запроса (прибор сверяет MSA-2 — правило OM13).
  const kit = expectFrom(X_HEME_ORR, reply, { msh5: 'BC-5300', msh6: 'Mindray' }).replace('|ORR^O02|1|', '|ORR^O02|9|');
  assert.equal(reply, kit);
  assert.equal(fieldsOf(mshLine)[8], 'ORR^O02');
  assert.equal(msa, 'MSA|AR|9', '«заказов нет» — дословно OM13 pdf 490');
});

test('D9: A1000 по тесту (MSH-10 = 5) — MSA-4 = OBX-1; по пробе (MSH-10 = 7) — MSA-4 = OBR-3; MSA-6 — целое (settle, табл. c, R1 и R5)', async () => {
  const { firstField } = await import('./hl7.js');
  const byTest = KIT_A1000_TEST(10455, 'LAB-000123', '4.17');
  assert.equal(firstField(byTest, 'OBX', 1), '10455', 'OBX-1 — TestRequest_ID, не 1, 2, 3');
  const r1 = buildAck(mshOf(byTest), 'AA', { ref: firstField(byTest, 'OBX', 1) });
  assert.equal(linesOf(r1)[1], 'MSA|AA|5|Message accepted|10455||0|', 'R1: «Mindray long form» с MSA-4 — «Accepted»');
  assert.equal(r1.split('|')[9], '5', 'MSH-10 эхом: декодер принимает только 5 или 7');
  assert.equal(firstField(KIT_A1000_SAMPLE, 'OBR', 3), '7764', 'OBR-3 — внутренний номер пробы A1000');
  const r5 = buildAck(mshOf(KIT_A1000_SAMPLE), 'AA', { ref: firstField(KIT_A1000_SAMPLE, 'OBR', 3) });
  assert.equal(linesOf(r5)[1], 'MSA|AA|7|Message accepted|7764||0|', 'R5: по пробе');
  // M18: при AE MSA-4 пуст — A1000 оставляет результат «Finished» к повтору.
  assert.equal(linesOf(buildAck(mshOf(byTest), 'AE', { ...ACK_INTERNAL, ref: '10455' }))[1], 'MSA|AE|5|Application internal error|||207|');
  assert.equal(firstField('это не HL7', 'OBX', 1), '');
  assert.equal(firstField(KIT_BS200_QRY, 'OBX', 1), '', 'сегмента нет — пусто');
});

test('mshOf: MSH-11 (processingId) — для эха в ответе', () => {
  assert.equal(mshOf(KIT_BC5300_QC).processingId, 'Q');
  assert.equal(mshOf(KIT_BS200_ORU(1)).processingId, 'P');
  assert.equal(mshOf('это не HL7').processingId, '');
});
