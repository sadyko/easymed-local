// CALL_RECORDING_REASONS_V1 (2026-10-02) — «Прослушать» в карточке заявки
// говорит, ПОЧЕМУ записи нет, и сам спрашивает снова, пока станция её готовит.
//
// Владелец: оператор нажал «Прослушать» на входящем звонке 09:33 (1 мин
// 37 сек) и прочёл «Записи этого разговора у станции нет.». Запись была —
// onlinePBX отдал её по тому же звонку позже: оператор нажал раньше, чем
// станция её склеила, а карточка любой отказ показывала этим одним словом.
//
// Здесь: каждая причина сервера — своя фраза; «готовится» — повтор каждые
// 10 секунд, не больше 6 раз, счёт на кнопке, и тишина, если карточку
// закрыли.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, walk, textOf, byClass, tick, mk, TOASTS } from './crm-harness.mjs';
import { RECORDING_MESSAGES, RECORDING_GAVE_UP } from '../../shared/call-recording.js';

const { renderCrm } = await import('../views/crm.js');

// Поддельный ответ telephony_call_recording поверх общего стенда: по списку,
// последний повторяется; {error} — отказ запроса.
let answers = [];
let asked = 0;
const harnessFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url) === '/api/rpc/telephony_call_recording') {
    const a = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    if (a && a.error) return { ok: false, status: 403, json: async () => ({ error: { message: a.error } }) };
    return { ok: true, json: async () => ({ data: a }) };
  }
  return harnessFetch(url, opts);
};

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const LEAD = { id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'call',
  created_at: '2026-09-03T10:12:00Z', assigned_to: 12, users: { full_name: 'Оператор Лола' } };
const TALK = { id: 195701, started_at: '2026-10-02T04:33:00Z', call_type: 0, billsec: 97, waitsec: 8, disposition: 'ANSWER',
  internal_number: '101', operator_name: 'Лола', recording_url: null, has_recording: false, can_listen: true };

async function openCard(reply) {
  answers = reply;
  asked = 0;
  TOASTS.length = 0;
  window.easymed.state.user = ADMIN;
  S.leads = [LEAD];
  S.leadCalls = [TALK];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const c = byClass(root, 'crm-card')[0];
  c.dispatchEvent({ type: 'click', target: c, currentTarget: c, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно заявки не открылось');
  const play = walk(modal).find((n) => n.tagName === 'BUTTON' && /Прослушать/.test(textOf(n)));
  assert.ok(play, 'кнопки «Прослушать» нет');
  return { modal, play };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const audioIn = (modal) => walk(modal).find((n) => n.tagName === 'AUDIO');

test('каждая причина — своя фраза; кнопка снова «Прослушать», станцию спросили один раз', async () => {
  for (const reason of ['offline', 'rate_limited', 'bad_credentials', 'server_error', 'bad_response', 'no_line', 'not_found', 'not_supported']) {
    const { play } = await openCard([{ url: '', reason }]);
    play.click();
    await tick(30);
    assert.ok(TOASTS.includes(RECORDING_MESSAGES[reason]), reason + ': показано ' + JSON.stringify(TOASTS));
    assert.equal(asked, 1, reason + ': повтор без «готовится»');
    assert.equal(play.disabled, false, reason + ': кнопка осталась выключенной');
    assert.match(textOf(play), /Прослушать/, reason);
  }
  // Прежде все эти отказы читались одним «записи нет».
  assert.notEqual(RECORDING_MESSAGES.offline, RECORDING_MESSAGES.not_found);
});

test('ответ без причины (старый сервер) — прежнее «записи нет»', async () => {
  const { play } = await openCard([{ url: '' }]);
  play.click();
  await tick(30);
  assert.ok(TOASTS.includes('Записи этого разговора у станции нет.'), JSON.stringify(TOASTS));
});

test('отказ запроса — его текст, как прежде', async () => {
  const { play } = await openCard([{ error: 'Слушать записи разговоров — недоступно вашей роли.' }]);
  play.click();
  await tick(30);
  assert.ok(TOASTS.includes('Слушать записи разговоров — недоступно вашей роли.'), JSON.stringify(TOASTS));
});

test('«готовится»: сказано, счёт на кнопке (1/6), через 10 секунд — снова, и плеер, когда запись готова', async (t) => {
  const { modal, play } = await openCard([{ url: '', reason: 'not_ready' }, { url: '', reason: 'not_ready' }, { url: 'https://rec/195701.mp3' }]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  play.click();
  await flush();
  assert.equal(asked, 1);
  assert.ok(TOASTS.includes(RECORDING_MESSAGES.not_ready), JSON.stringify(TOASTS));
  assert.ok(textOf(play).includes('Запись готовится… (1/6)'), textOf(play));
  assert.equal(play.disabled, true, 'кнопку можно нажать второй раз, пока идёт повтор');

  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(asked, 1, 'спросили раньше десяти секунд');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(asked, 2);
  assert.ok(textOf(play).includes('Запись готовится… (2/6)'), textOf(play));

  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(asked, 3);
  const audio = audioIn(modal);
  assert.ok(audio, 'плеер не появился, когда запись стала готова');
  assert.equal(audio.attrs.src || audio.src, 'https://rec/195701.mp3');
});

test('минута прошла, а запись всё готовится — шесть повторов и «ещё не готова», кнопка снова в строю', async (t) => {
  const { modal, play } = await openCard([{ url: '', reason: 'not_ready' }]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  play.click();
  await flush();
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(10_000); await flush(); }
  assert.equal(asked, 7, 'первый запрос и шесть повторов');
  assert.ok(TOASTS.includes(RECORDING_GAVE_UP), JSON.stringify(TOASTS));
  assert.equal(play.disabled, false);
  assert.match(textOf(play), /Прослушать/);
  assert.ok(!audioIn(modal));
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(asked, 7, 'после «ещё не готова» станцию спрашивают дальше');
});

test('карточку закрыли во время ожидания — повторов больше нет и ничего не всплывает', async (t) => {
  const { play } = await openCard([{ url: '', reason: 'not_ready' }]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  play.click();
  await flush();
  assert.equal(asked, 1);
  Object.defineProperty(play, 'isConnected', { get: () => false, configurable: true });   // окно закрыто: кнопки нет в документе
  TOASTS.length = 0;
  t.mock.timers.tick(10_000);
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(asked, 1, 'станцию спрашивают из закрытой карточки');
  assert.deepEqual(TOASTS, []);
});
