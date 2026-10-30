// TEST_DATA_WIPE_V1 — чистые решения карточки «Удалить тестовые данные»:
// итог прошлого удаления строками, заметки под ним, кто попросил, подпись
// копии — и сверка фраз экрана с фразами сервера (отказ связанной клинике,
// «нет места», ключи итога).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIPE_DELETES, WIPE_KEEPS, WIPE_CALENDAR_WARNING, PAIRED_TEXT, WIPE_NO_SPACE_TEMPLATE,
  wipeSummaryRows, wipeLastNotes, wipeRequestInfo,
} from './test-wipe-logic.js';
import { backupKindLabel } from './system-logic.js';
import { STRINGS } from './i18n-strings.js';
import { PAIRED_REFUSAL } from '../../../server/services/rpc/backup.js';
import { WIPE_NO_SPACE_TEMPLATE as SERVER_NO_SPACE, SUMMARY_KEYS } from '../../../server/services/test-data-wipe.js';

const LAST = {
  ok: true, at: '2026-10-30T05:00:00.000Z', backup: 'wipe-20261030-100000.db',
  deleted: { visits: 12, visit_services: 30, lab_results: 41, visit_documents: 5, admissions: 2, invoices: 7, payments: 9,
    patient_deposits: 4, cash_shifts: 3, stock_movements: 20, api_requests: 1 },
  cleared: { products: 6, crm_request_services: 2 },
  files: { removed: 5, failed: 0 },
  vacuum: { done: true, before_bytes: 2000, after_bytes: 500 },
};

test('итог удаления — строки «что — сколько» в порядке экрана', () => {
  const rows = wipeSummaryRows(LAST);
  assert.deepEqual(rows.slice(0, 3), [{ label: 'Визиты', n: 12 }, { label: 'Услуги визитов', n: 30 }, { label: 'Результаты анализов', n: 41 }]);
  assert.deepEqual(rows.find((r) => r.label === 'Файлы документов'), { label: 'Файлы документов', n: 5 });
  assert.deepEqual(rows.find((r) => r.label === 'Товары с обнулённым остатком'), { label: 'Товары с обнулённым остатком', n: 6 });
  assert.deepEqual(rows.find((r) => r.label === 'Услуги в карточках CRM, отвязанные от визитов'), { label: 'Услуги в карточках CRM, отвязанные от визитов', n: 2 });
  assert.equal(rows.length, 14);
  // Каждый ключ строки итога сервера (SUMMARY_KEYS) — строкой экрана.
  assert.deepEqual(rows.filter((r) => r.label !== 'Файлы документов' && !/обнулённым|отвязанные/.test(r.label)).map((r) => r.n),
    SUMMARY_KEYS.map((k) => LAST.deleted[k]));
});

test('итога нет, он не удался или в нём мусор — пустые строки, а не NaN', () => {
  assert.deepEqual(wipeSummaryRows(null), []);
  assert.deepEqual(wipeSummaryRows({ ok: false, reason: 'paired' }), []);
  const rows = wipeSummaryRows({ ok: true, deleted: { visits: 'abc', invoices: -3 } });
  assert.equal(rows.find((r) => r.label === 'Визиты').n, 0);
  assert.equal(rows.find((r) => r.label === 'Счета').n, 0);
});

test('заметки к отказу: связана со зданиями; нет места — фраза сервера с числами на языке экрана; сбой — база не тронута', () => {
  assert.deepEqual(wipeLastNotes(LAST), []);
  assert.deepEqual(wipeLastNotes(null), []);
  assert.match(wipeLastNotes({ ok: false, reason: 'paired' })[0].template, /связана с другими зданиями/);
  assert.match(wipeLastNotes({ ok: false, reason: 'failed' })[0].template, /база не тронута/);
  const noSpace = { ok: false, reason: 'no_space', template: SERVER_NO_SPACE, params: { need: 2.1, free: 0.4 } };
  assert.deepEqual(wipeLastNotes(noSpace, 'ru'), [{ template: WIPE_NO_SPACE_TEMPLATE, params: { need: '2,1', free: '0,4' } }]);
  assert.deepEqual(wipeLastNotes(noSpace, 'en')[0].params, { need: '2.1', free: '0.4' });
  assert.deepEqual(wipeLastNotes(noSpace, 'uz')[0].params, { need: '2,1', free: '0,4' });
  // Чисел нет или они не числа — общая фраза, а не «нужно undefined ГБ».
  assert.match(wipeLastNotes({ ok: false, reason: 'no_space', params: { need: 'x' } })[0].template, /^Тестовые данные не удалены: не хватило места на диске\.$/);
});

test('заметки к удаче: карточки CRM без учебной записи, оставленные файлы документов (не сбой), база не уменьшилась', () => {
  const notes = wipeLastNotes({ ...LAST, crm_cards_unbooked: 4, files: { removed: 3, failed: 2 }, vacuum: { done: false, reason: 'no_space' } });
  assert.deepEqual(notes[0], { template: 'Карточек CRM без учебной записи: {n} — их стадии не менялись.', params: { n: 4 } });
  assert.equal(notes[1].params.n, 2);
  assert.match(notes[1].template, /^Файлов документов оставлено на диске: \{n\} — их нет в копии «Перед удалением тестовых данных»/);
  assert.match(notes[2].template, /не хватило места/);
  assert.match(wipeLastNotes({ ...LAST, vacuum: { done: false, reason: 'failed' } })[0].template, /^Файл базы не уменьшен\. /);
  assert.deepEqual(wipeLastNotes({ ...LAST, crm_cards_unbooked: 0 }), [], 'ноль карточек — не о чем говорить');
});

test('кто попросил: номер — целое больше нуля, время — разбираемая строка; иначе null', () => {
  assert.deepEqual(wipeRequestInfo({ requested_by: 7, requested_at: '2026-10-30T04:58:00.000Z' }), { by: 7, at: '2026-10-30T04:58:00.000Z' });
  assert.deepEqual(wipeRequestInfo({ requested_by: '7', requested_at: 'вчера' }), { by: null, at: null });
  assert.deepEqual(wipeRequestInfo({ requested_by: 0, requested_at: 5 }), { by: null, at: null });
  assert.deepEqual(wipeRequestInfo(null), { by: null, at: null });
});

test('списки «удалятся» и «останутся» говорят о картах пациентов, CRM и календаре прямо', () => {
  assert.ok(WIPE_DELETES.some((s) => /визиты/.test(s)) && WIPE_DELETES.some((s) => /деньги/.test(s)) && WIPE_DELETES.some((s) => /склад/.test(s)));
  assert.ok(WIPE_DELETES.some((s) => /сканы в карте пациента/.test(s)), 'поправка 6: и сканы в карте пациента');
  assert.ok(WIPE_KEEPS.some((s) => /карты пациентов/.test(s)) && WIPE_KEEPS.some((s) => /^CRM.*стадии карточек не меняются/.test(s)), 'поправка 8');
  assert.match(WIPE_CALENDAR_WARNING, /ВСЕ записи в календаре.*будущие/);
});

test('фразы экрана — те же, что у сервера, и каждая в словаре на трёх языках', () => {
  assert.equal(PAIRED_TEXT, PAIRED_REFUSAL);
  assert.equal(WIPE_NO_SPACE_TEMPLATE, SERVER_NO_SPACE);
  for (const k of [PAIRED_TEXT, WIPE_NO_SPACE_TEMPLATE, WIPE_CALENDAR_WARNING, ...WIPE_DELETES, ...WIPE_KEEPS]) {
    assert.ok(STRINGS[k] && STRINGS[k].ru && STRINGS[k].uz && STRINGS[k].en, 'нет в словаре: ' + k);
  }
});

test('копия перед удалением тестовых данных подписана в списке копий', () => {
  assert.equal(backupKindLabel('wipe'), 'перед удалением тестовых данных');
});
