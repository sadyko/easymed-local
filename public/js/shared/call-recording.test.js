// CALL_RECORDING_REASONS_V1 (2026-10-02) — слова «Прослушать» и повтор, пока
// станция готовит запись (shared/call-recording.js).
//
// Владелец: оператор нажал «Прослушать» через пару минут после разговора и
// прочёл «Записи этого разговора у станции нет.», хотя запись была. Здесь:
// у каждой причины своя фраза (и она есть в словаре на трёх языках), а «запись
// готовится» спрашивается снова каждые 10 секунд, не больше 6 раз, и
// перестаёт, как только экран закрыли.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORDING_MESSAGES, RECORDING_WAITING, RECORDING_GAVE_UP, RECORDING_RETRY_EVERY_MS, RECORDING_RETRY_TRIES,
  RECORDING_NOT_READY_WINDOW_MS, recordingMessage, fillRecordingText, askRecordingUntilReady,
} from './call-recording.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('у каждой причины — своя фраза, как решил владелец', () => {
  assert.equal(recordingMessage('not_ready'), 'Запись ещё готовится на станции — пробуем снова…');
  assert.equal(recordingMessage('not_found'), 'Записи этого разговора у станции нет.');
  assert.equal(recordingMessage('not_supported'), 'Эта телефония записи не отдаёт.');
  assert.equal(recordingMessage('no_line'), 'Линия этого звонка удалена из настроек телефонии — запись недоступна.');
  assert.equal(recordingMessage('offline'), 'Нет связи с onlinePBX — проверьте интернет и попробуйте ещё раз.');
  assert.equal(recordingMessage('rate_limited'), 'onlinePBX просит не чаще — попробуйте через минуту.');
  assert.equal(recordingMessage('bad_credentials'), 'Ключ onlinePBX не подходит — проверьте настройки телефонии.');
  assert.equal(recordingMessage('server_error'), 'onlinePBX ответил ошибкой — попробуйте ещё раз.');
  assert.equal(recordingMessage('bad_response'), 'onlinePBX ответил ошибкой — попробуйте ещё раз.');
  assert.equal(recordingMessage('no_talk'), 'Разговора не было — записывать нечего.');
});

test('ответ без причины или с незнакомой — прежнее «записи нет», а не пустота', () => {
  for (const r of [undefined, null, '', 'something_new', 'toString', '__proto__']) {
    assert.equal(recordingMessage(r), RECORDING_MESSAGES.not_found, String(r));
  }
});

test('сроки: «готовится» — 10 минут после разговора; повтор — каждые 10 секунд, 6 раз', () => {
  assert.equal(RECORDING_NOT_READY_WINDOW_MS, 600_000);
  assert.equal(RECORDING_RETRY_EVERY_MS, 10_000);
  assert.equal(RECORDING_RETRY_TRIES, 6);
  assert.equal(fillRecordingText(RECORDING_WAITING, { n: 2, max: 6 }), 'Запись готовится… (2/6)');
});

// Модуль лежит в public/js/shared, и общая проверка словаря (i18n-coverage)
// его не обходит — поэтому здесь: каждая фраза, которую увидит экран, — ключ
// словаря, полный на трёх языках, узбекский латиницей, {дырки} на месте.
test('каждая фраза — в словаре на ru/uz/en, узбекская латиницей, {n}/{max} не потеряны', () => {
  const phrases = new Set([...Object.values(RECORDING_MESSAGES), RECORDING_WAITING, RECORDING_GAVE_UP]);
  for (const p of phrases) {
    const e = STRINGS[p];
    assert.ok(e, 'нет в словаре: ' + p);
    for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang] && String(e[lang]).trim(), lang + ' пусто: ' + p);
    assert.equal(e.ru, p);
    assert.doesNotMatch(e.uz, /[Ѐ-ӿ]/, 'кириллица в узбекском: ' + p);
    assert.doesNotMatch(e.en, /[Ѐ-ӿ]/, 'кириллица в английском: ' + p);
    for (const hole of p.match(/\{\w+\}/g) || []) {
      assert.ok(e.uz.includes(hole) && e.en.includes(hole), hole + ' потерян в переводе: ' + p);
    }
  }
});

// --- повтор ----------------------------------------------------------------

function fakeRpc(...answers) {
  let i = 0;
  const ask = async () => {
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (a instanceof Error) throw a;
    return a;
  };
  return { ask, count: () => i };
}

test('запись готова сразу — один запрос, без ожидания', async () => {
  const rpc = fakeRpc({ url: 'https://rec/1.mp3' });
  const waits = [];
  const sleeps = [];
  const r = await askRecordingUntilReady(rpc.ask, { onWait: (n, max) => waits.push([n, max]), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(r, { url: 'https://rec/1.mp3' });
  assert.equal(rpc.count(), 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(sleeps, []);
});

test('«готовится» дважды, потом ссылка — два ожидания по 10 с, счёт (1/6), (2/6)', async () => {
  const rpc = fakeRpc({ url: '', reason: 'not_ready' }, { url: '', reason: 'not_ready' }, { url: 'https://rec/2.mp3' });
  const waits = [];
  const sleeps = [];
  const r = await askRecordingUntilReady(rpc.ask, { onWait: (n, max) => waits.push([n, max]), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(r, { url: 'https://rec/2.mp3' });
  assert.equal(rpc.count(), 3);
  assert.deepEqual(waits, [[1, 6], [2, 6]]);
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test('станция готовит больше минуты — шесть повторов и честное «ещё не готова»', async () => {
  const rpc = fakeRpc({ url: '', reason: 'not_ready' });
  const waits = [];
  const r = await askRecordingUntilReady(rpc.ask, { onWait: (n) => waits.push(n), sleep: async () => {} });
  assert.deepEqual(r, { url: '', reason: 'not_ready', gave_up: true });
  assert.equal(rpc.count(), 1 + RECORDING_RETRY_TRIES, 'первый запрос и шесть повторов');
  assert.deepEqual(waits, [1, 2, 3, 4, 5, 6]);
});

test('карточку закрыли во время ожидания — станцию больше не спрашиваем', async () => {
  const rpc = fakeRpc({ url: '', reason: 'not_ready' });
  let open = true;
  const r = await askRecordingUntilReady(rpc.ask, { sleep: async () => { open = false; }, alive: () => open });
  assert.deepEqual(r, { url: '', reason: 'gone' });
  assert.equal(rpc.count(), 1, 'после закрытия карточки станцию спросили снова');
});

test('во время повторов пришла другая причина — она и показывается, повторы кончаются', async () => {
  const rpc = fakeRpc({ url: '', reason: 'not_ready' }, { url: '', reason: 'offline' });
  const r = await askRecordingUntilReady(rpc.ask, { sleep: async () => {} });
  assert.deepEqual(r, { url: '', reason: 'offline' });
  assert.equal(rpc.count(), 2);
});

test('отказ запроса во время повторов уходит наверх как есть', async () => {
  const rpc = fakeRpc({ url: '', reason: 'not_ready' }, new Error('Слушать записи — недоступно вашей роли.'));
  await assert.rejects(() => askRecordingUntilReady(rpc.ask, { sleep: async () => {} }), /недоступно вашей роли/);
});

test('настоящий таймер: следующий запрос — ровно через 10 секунд, не раньше', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rpc = fakeRpc({ url: '', reason: 'not_ready' }, { url: 'https://rec/3.mp3' });
  const flush = () => new Promise((r) => setImmediate(r));
  const done = askRecordingUntilReady(rpc.ask);
  await flush();
  assert.equal(rpc.count(), 1);
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(rpc.count(), 1, 'спросили раньше десяти секунд');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(rpc.count(), 2);
  assert.deepEqual(await done, { url: 'https://rec/3.mp3' });
});
