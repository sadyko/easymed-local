// CALL_RING_V1 (2026-10-17) — решения блока «Звонит» без DOM: какой звонок показать,
// как назвать, когда пискнуть, и что звук молчит там, где WebAudio нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRinging, ringLabel, ringWord, beepDue, audioContextOf, ringTone, BEEP_EVERY_MS, BEEP_MAX_MS } from './crm-ring-logic.js';

const T = 1_000_000;
const call = (over) => ({ uuid: 'u', direction: 'in', state: 'ringing', was_answered: false, caller: '998901112233', callee: '101', number: '998901112233', updated: T, patient: null, lead: null, ...over });

test('показывается самый свежий входящий: звонит, идёт или только что пропущен; отвеченный и законченный — нет; исходящий — нет', () => {
    assert.equal(pickRinging([]), null);
    assert.equal(pickRinging([call({ direction: 'out' })]), null);
    assert.equal(pickRinging([call({ state: 'ended', was_answered: true })]), null, 'состоявшийся разговор — уже строка журнала');
    const r = pickRinging([call({ uuid: 'a', updated: T }), call({ uuid: 'b', updated: T + 5 }), call({ uuid: 'c', state: 'ended', updated: T + 1 })]);
    assert.equal(r.call.uuid, 'b');
    assert.equal(r.others, 2);
    assert.equal(r.foreign, false);
});

test('«Скрыть» убирает звонок из показа; чужая трубка — foreign', () => {
    const hidden = new Set(['b']);
    const r = pickRinging([call({ uuid: 'a', updated: T }), call({ uuid: 'b', updated: T + 5 })], { hidden });
    assert.equal(r.call.uuid, 'a');
    assert.equal(r.others, 0);
    assert.equal(pickRinging([call({ callee: '102' })], { ext: '101' }).foreign, true);
    assert.equal(pickRinging([call({ callee: '101' })], { ext: '101' }).foreign, false);
    assert.equal(pickRinging([call({ callee: '' })], { ext: '101' }).foreign, false, 'без добавочного в событии чужим не считаем');
});

test('имя: пациент, иначе заявка, иначе номер; слово — по состоянию', () => {
    assert.equal(ringLabel(call({ patient: { full_name: 'Каримова Азиза' }, lead: { full_name: 'Заявка' } })), 'Каримова Азиза');
    assert.equal(ringLabel(call({ lead: { full_name: 'Заявка Тестовая' } })), 'Заявка Тестовая');
    assert.equal(ringLabel(call()), '+998 90 111 22 33');
    assert.equal(ringWord(call()), 'Входящий звонок');
    assert.equal(ringWord(call({ state: 'answered' })), 'Разговор идёт');
    assert.equal(ringWord(call({ state: 'ended' })), 'Пропущен');
});

test('сигнал: раз в две секунды, не дольше 40 секунд, не при выключенном звуке, не на чужой трубке, не после ответа', () => {
    const c = call();
    assert.equal(beepDue(c, T, { firstSeenAt: T }), true);
    assert.equal(beepDue(c, T + 500, { lastBeepAt: T, firstSeenAt: T }), false);
    assert.equal(beepDue(c, T + BEEP_EVERY_MS, { lastBeepAt: T, firstSeenAt: T }), true);
    assert.equal(beepDue(c, T + BEEP_MAX_MS + 1, { lastBeepAt: 0, firstSeenAt: T }), false);
    assert.equal(beepDue(c, T, { muted: true }), false);
    assert.equal(beepDue(c, T, { foreign: true }), false);
    assert.equal(beepDue(call({ state: 'answered' }), T), false);
});

test('звук: без WebAudio — null и тишина без ошибок; с поддельным контекстом — два осциллятора', () => {
    assert.equal(audioContextOf({}), null);
    assert.equal(audioContextOf(undefined), null);
    assert.equal(ringTone(null), false);
    const made = [];
    const node = () => ({ connect(n) { return n; }, start() {}, stop() {}, frequency: {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
    const ctx = { currentTime: 0, state: 'running', destination: {}, createOscillator() { const n = node(); made.push(n); return n; }, createGain() { return node(); } };
    assert.equal(ringTone(ctx), true);
    assert.equal(made.length, 2);
    assert.equal(made[0].frequency.value, 880);
});
