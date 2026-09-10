// hl7.test.js — чистый разбор. Ни базы, ни сети, ни времени: всё, что здесь
// проверяется, это текст на входе и объект на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, buildAck } from './hl7.js';

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
    valueType: 'NM', code: 'WBC', value: '6.1',
    unit: '10*9/L', range: '4.0-9.0', abnormal: 'N', status: 'F',
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
