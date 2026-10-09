// LIS_PROXY_V1 — форма LIS Proxy → ORU и ответ рабочего списка (чистые функции).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readResult, pickMessageSample, wireDecision } from './wire.js';
import { parseMessage, mshOf } from './hl7.js';
import { guessProfile } from './discover.js';
import {
  escapeHl7, proxyValue, proxyNorms, junkReason, normaliseProxyBarcode, buildOru, hl7Stamp,
  dottedDate, sexCode, biomaterialOf, worklistEntries, PROXY_APP, PROXY_NOT_TUBE,
  parseProxyForm, decodeProxyBody, looksLikeResult, FORM_MAX_PAIRS,   // LIS_PROXY_V1 (ревью I1)
} from './lisproxy-form.js';

test('escapeHl7: | ^ ~ \\ & — escape-последовательности, перевод строки — пробел', () => {
  assert.equal(escapeHl7('a|b^c~d\\e&f'), 'a\\F\\b\\S\\c\\R\\d\\E\\e\\T\\f');
  assert.equal(escapeHl7('x\r\ny\rz'), 'x y z');
  assert.equal(escapeHl7(null), '');
});

test('proxyValue: запятая → точка, %f BS-200 без хвостовых нулей, NM только у простого числа', () => {
  assert.deepEqual(proxyValue('5.100000'), { value: '5.1', type: 'NM' });
  assert.deepEqual(proxyValue('5.000000'), { value: '5', type: 'NM' });
  assert.deepEqual(proxyValue('5,1'), { value: '5.1', type: 'NM' });
  assert.deepEqual(proxyValue('0.50'), { value: '0.50', type: 'NM' }, 'гематология — как пришло');
  assert.deepEqual(proxyValue('132'), { value: '132', type: 'NM' });
  assert.deepEqual(proxyValue('-1.5'), { value: '-1.5', type: 'NM' });
  assert.deepEqual(proxyValue('<0.5'), { value: '<0.5', type: 'ST' });
  assert.deepEqual(proxyValue('1,2,3'), { value: '1,2,3', type: 'ST' });
  assert.deepEqual(proxyValue('CBC+DIFF'), { value: 'CBC+DIFF', type: 'ST' });
  assert.equal(proxyNorms('3.900000-6.100000'), '3.9-6.1');
  assert.equal(proxyNorms('4.00-10.00'), '4.00-10.00');
});

test('мусор: пустое и «*», служебные строки Mindray, код с пробелом и не число, «нет результата»; настоящее значение — нет', () => {
  assert.match(junkReason({ code: 'IS', res: '' }), /пустое значение/);
  assert.match(junkReason({ code: 'GLU', res: '***' }), /пустое значение/);
  assert.match(junkReason({ code: 'Take Mode', res: 'O' }), /служебная строка прибора «Take Mode»/);
  assert.match(junkReason({ code: 'Test Mode', res: 'CBC+DIFF' }), /служебная строка/);
  assert.match(junkReason({ code: 'is', res: '1' }), /служебная строка/);
  assert.match(junkReason({ code: 'Ref Group', res: 'General' }), /служебная строка/);
  assert.match(junkReason({ code: 'GLU', res: '-268435455.000000' }), /нет результата «-268435455.000000» \(GLU\)/);
  assert.match(junkReason({ code: 'GLU', res: '-100000000' }), /нет результата/);
  assert.equal(junkReason({ code: 'GLU', res: '5.1' }), null);
  assert.equal(junkReason({ code: 'Some Ratio', res: '1,5' }), null, 'код с пробелом и число — значение');
  assert.equal(junkReason({ code: '214', res: '28.4' }), null);
});

test('штрихкод: LAB- как есть, обрезка AutoLumo — только у AutoLumo, прочее — не номер пробирки с причиной', () => {
  assert.deepEqual(normaliseProxyBarcode(' lab-000123 '), { ok: true, barcode: 'LAB-000123', restored: false, shown: 'lab-000123' });
  assert.equal(normaliseProxyBarcode('LAB-1234567').barcode, 'LAB-1234567');
  assert.deepEqual(normaliseProxyBarcode('B-000777', { autolumo: true }), { ok: true, barcode: 'LAB-000777', restored: true, shown: 'B-000777' });
  assert.equal(normaliseProxyBarcode('-1234567', { autolumo: true }).barcode, 'LAB-1234567');
  const cut = normaliseProxyBarcode('B-000777');
  assert.equal(cut.ok, false);
  assert.match(cut.why, /обрезанную этикетку AutoLumo/);
  for (const [raw, re] of [
    ['900001', /номер пациента или места/], ['12345678', /номер пациента или места/], ['PATNUM9', /проверьте настройку штрихкода/],
    ['Therapy^^12', /BC-20\/BC-5300 путают поле/], ['6690-2^WBC^LN', /BC-20\/BC-5300/], ['', /\(пусто\) — анализатор не передал номер пробы/],
    ['LAB-123', /проверьте настройку штрихкода/], ['ORU^R01', /путают поле/], ['ALL', /проверьте настройку/],
  ]) {
    const r = normaliseProxyBarcode(raw, { autolumo: true });
    assert.equal(r.ok, false, raw);
    assert.ok(r.why.startsWith(PROXY_NOT_TUBE + ': ' + (raw || '(пусто)')), r.why);
    assert.match(r.why, re, raw);
  }
});

test('buildOru: провод forwarder, номер из OBR-3, код одним компонентом, модели по MSH-3 нет; экранирование не ломает поля', () => {
  const now = new Date(2026, 9, 9, 20, 21, 10);
  const raw = buildOru({ code: 'GLU', res: '5.100000', unit: 'mmol/L', norms: '3.900000-6.100000', flag: 'N', barcode: 'LAB-000123', controlId: '41', now });
  assert.equal(raw, [
    'MSH|^~\\&|LISPROXY|LabPC|||20261009202110||ORU^R01|41|P|2.3.1||||0||UNICODE',
    'PID|1',
    'OBR|1||LAB-000123',
    'OBX|1|NM|GLU||5.1|mmol/L|3.9-6.1|N|||F',
  ].join('\r'));
  assert.doesNotThrow(() => parseMessage(raw));
  const head = mshOf(raw);
  assert.deepEqual(wireDecision({ profile: null, facility: head.facility, app: head.app }), { wire: 'lisproxy', conflict: false }, 'ревью I2/I3 — провод входа LIS Proxy');
  assert.equal(guessProfile({ app: PROXY_APP, facility: head.facility }), null);
  const { obrs, observations } = readResult(raw, 'forwarder');
  assert.equal(pickMessageSample(obrs, 'forwarder').value, 'LAB-000123');
  assert.deepEqual([observations[0].code, observations[0].value, observations[0].valueType, observations[0].unit, observations[0].range, observations[0].abnormal, observations[0].status],
    ['GLU', '5.1', 'NM', 'mmol/L', '3.9-6.1', 'N', 'F']);
  const odd = buildOru({ code: 'A|B', res: 'x^y', unit: '10^9/L', barcode: '', now });
  const o = readResult(odd, 'forwarder').observations[0];
  assert.deepEqual([o.code, o.value, o.unit, o.status], ['A\\F\\B', 'x\\S\\y', '10\\S\\9/L', 'F'], 'поля на месте, OBX-11 — F');
  assert.equal(pickMessageSample(readResult(odd, 'forwarder').obrs, 'forwarder').sampleId, '', 'не номер пробирки — OBR-3 пуст');
  assert.equal(hl7Stamp(now), '20261009202110');
});

test('рабочий список: dd.MM.yyyy, пол 1/0/пусто, биоматериал, все ключи в каждой записи', () => {
  assert.equal(dottedDate('1990-02-03'), '03.02.1990');
  assert.equal(dottedDate('1990-02-03T00:00:00Z'), '03.02.1990');
  assert.equal(dottedDate('03.02.1990'), '03.02.1990');
  assert.equal(dottedDate(null), '');
  assert.equal(dottedDate('вчера'), '');
  assert.deepEqual([sexCode('male'), sexCode('female'), sexCode('other'), sexCode(undefined)], ['1', '0', '', '']);
  assert.deepEqual([biomaterialOf('Моча'), biomaterialOf('Плазма'), biomaterialOf('Сыворотка'), biomaterialOf('Кровь'), biomaterialOf(null)],
    ['urine', 'plasma', 'serum', 'serum', 'serum']);
  assert.deepEqual(worklistEntries({ barcode: 'LAB-000123', codes: ['GLU', 'UREA'], patient: { date_of_birth: '1990-02-03', gender: 'male' }, specimen: 'Сыворотка' }), {
    0: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' },
    1: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'UREA' },
  });
  assert.deepEqual(worklistEntries({ barcode: 'LAB-000001', codes: [] }), {});
});

// ── LIS_PROXY_V1 (ревью I1, A4/A5/A8) — тело формы: свой разбор ────────────
test('parseProxyForm: ключи в скобках как в PHP, «+» — пробел, %XX — UTF-8; повтор ключа — массив; «[]» — массив', () => {
  const { body, notes } = parseProxyForm('method=apiResultSave&lisResult[name]=bs200&lisResult[host]=LAB+PC%2D1&lisResult[R][res]=5.1&lisResult[R][unit]=10%5E9%2FL'
    + '&lisResult[host2]=%D0%9B%D0%B0%D0%B1&lisResult[R][res]=6.2&method2[]=a&method2[]=b');
  assert.deepEqual(notes, []);
  assert.equal(body.method, 'apiResultSave');
  assert.deepEqual(body.lisResult, { name: 'bs200', host: 'LAB PC-1', R: { res: ['5.1', '6.2'], unit: '10^9/L' }, host2: 'Лаб' });
  assert.deepEqual(body.method2, ['a', 'b']);
});

test('parseProxyForm: __proto__ и constructor не трогают объект; мусорные ключи и глубина не бросают; предел пар', () => {
  const { body } = parseProxyForm('lisResult[__proto__][code]=GLU&constructor[prototype][x]=1&lisResult[name]=bs200&' + 'a['.repeat(40) + 'x' + ']'.repeat(40) + '=1&=v&&k');
  assert.equal(({}).code, undefined);
  assert.equal(Object.prototype.x, undefined);
  assert.equal(body.lisResult.name, 'bs200');
  assert.equal(Object.getPrototypeOf(body.lisResult), Object.prototype);
  const many = parseProxyForm('method=apiResultSave' + '&x=1'.repeat(FORM_MAX_PAIRS + 5));
  assert.equal(many.body.method, 'apiResultSave');
  assert.match(many.notes[0], /пар в теле больше 10000/);
});

test('parseProxyForm: %XX не в UTF-8 — windows-1251 (с отметкой); битая последовательность не бросает', () => {
  const r = parseProxyForm('lisResult[unit]=%EC%EC%EE%EB%FC%2F%EB&lisResult[R][res]=5.1%E0%A4%A');
  assert.equal(r.body.lisResult.unit, 'ммоль/л');
  assert.match(r.notes.join('; '), /windows-1251/);
  assert.equal(typeof r.body.lisResult.R.res, 'string');
});

test('decodeProxyBody: UTF-8; не UTF-8 — windows-1251 с отметкой; объявленная кодировка — запасная', () => {
  assert.deepEqual(decodeProxyBody(Buffer.from('a=Лаб', 'utf8')), { text: 'a=Лаб', charset: 'utf-8' });
  assert.deepEqual(decodeProxyBody(Buffer.from([0x61, 0x3d, 0xcb, 0xe0, 0xe1])), { text: 'a=Лаб', charset: 'windows-1251' });
  assert.deepEqual(decodeProxyBody(Buffer.from([0x61, 0x3d, 0xe9]), 'latin1'), { text: 'a=é', charset: 'windows-1252' });
});

test('looksLikeResult: method=apiResultSave в любом регистре и как method[] — по сырому тексту', () => {
  for (const t of ['method=apiResultSave&x=1', 'x=1&METHOD=APIRESULTSAVE', 'method[]=apiResultSave', 'method%5B%5D=apiresultsave&x']) assert.equal(looksLikeResult(t), true, t);
  for (const t of ['method=apiOrderGet', 'xmethod=apiResultSave2', '']) assert.equal(looksLikeResult(t), false, t);
});

// ── LIS_PROXY_V1 (ревью I4, I6) ────────────────────────────────────────────
test('ревью I4: обрезка AutoLumo «-ddddddd» — только 7-значный номер без нуля впереди (этикетки от 1 000 000); «B-dddddd» — как прежде', () => {
  assert.equal(normaliseProxyBarcode('-1234567', { autolumo: true }).barcode, 'LAB-1234567');
  assert.equal(normaliseProxyBarcode('B-000777', { autolumo: true }).barcode, 'LAB-000777');
  for (const raw of ['-0000777', '-0123456']) {
    const r = normaliseProxyBarcode(raw, { autolumo: true });
    assert.equal(r.ok, false, raw);
    assert.ok(r.why.startsWith(PROXY_NOT_TUBE + ': ' + raw), r.why);
  }
});

test('ревью I6: мусор — только служебные строки Mindray по списку, пусто, «*», «нет результата»; код с пробелом и текстом — значение', () => {
  assert.equal(junkReason({ code: 'HIV Ag', res: 'Positive' }), null);
  assert.equal(junkReason({ code: 'HIV Ag', res: '<0.10' }), null);
  assert.equal(junkReason({ code: 'Anti HCV', res: 'Negative' }), null);
  for (const code of ['Take Mode', 'Blood Mode', 'Test Mode', 'Ref Group', 'Remark', 'Age', 'IS', 'Qc Level',
    'WBC Histogram. BMP', 'RBC Histogram. Left Line', 'PLT Histogram. Right Line']) {
    assert.match(junkReason({ code, res: 'Qk1x' }), /служебная строка прибора/, code);
  }
});
