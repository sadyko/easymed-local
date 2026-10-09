// CRM_UNIFY_V1 — «Колонка записи» и «Колонка конверсии»: одно правило для
// сервера (services/crm/config.js) и браузера (crm-settings-logic.js,
// views/crm-settings.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedStageKey, bookedStageCandidates, withConversion, conversionRefusal, conversionCandidates,
} from './crm-booked-stage.js';

const st = (key, kind, position, is_active = 1) => ({ key, kind, position, is_active });
const SEED = [st('in_process', 'open', 1), st('recall', 'open', 2), st('scheduled', 'open', 3), st('approved', 'open', 4),
  st('came', 'won', 5), st('no_show', 'lost', 6), st('stopped', 'lost', 7)];
// Воронка клиники: «Записан» удалена, «Успешно» — своя открытая колонка после «Не пришёл».
const CLINIC = [st('in_process', 'open', 1), st('recall', 'open', 2), st('approved', 'open', 4),
  st('no_show', 'lost', 6), st('uspeshno', 'open', 7), st('came', 'won', 8), st('stopped', 'lost', 9)];
const hide = (list, key) => list.map((s) => (s.key === key ? { ...s, is_active: 0 } : s));

// ── «Колонка записи» ────────────────────────────────────────────────────────
test('по умолчанию — «Записан», если она есть и видна', () => {
  assert.equal(bookedStageKey(SEED), 'scheduled');
});
test('«Записан» скрыта или удалена — последняя открытая видимая ДО «Пришёл»', () => {
  assert.equal(bookedStageKey(hide(SEED, 'scheduled')), 'approved');
  assert.equal(bookedStageKey(CLINIC), 'uspeshno');
});
test('выбор администратора действует, только если колонка открытая, видимая и до «Пришёл»', () => {
  assert.equal(bookedStageKey(CLINIC, 'approved'), 'approved');
  assert.equal(bookedStageKey(SEED, 'came'), 'scheduled', 'конверсия не может быть колонкой записи');
  assert.equal(bookedStageKey(SEED, 'no_show'), 'scheduled');
  assert.equal(bookedStageKey(hide(SEED, 'approved'), 'approved'), 'scheduled');
  assert.equal(bookedStageKey([...SEED, st('after_won', 'open', 9)], 'after_won'), 'scheduled', 'колонка после «Пришёл» не годится');
});
test('кандидаты — открытые видимые до «Пришёл», по порядку; пустая воронка — null', () => {
  assert.deepEqual(bookedStageCandidates(CLINIC), ['in_process', 'recall', 'approved', 'uspeshno']);
  assert.equal(bookedStageKey([]), null);
  assert.equal(bookedStageKey(null), null);
});
test('is_active приходит и булевым (сервер), и 1/0 (экран)', () => {
  assert.equal(bookedStageKey(SEED.map((s) => ({ ...s, is_active: !!s.is_active }))), 'scheduled');
  assert.equal(bookedStageKey(hide(SEED, 'scheduled').map((s) => ({ ...s, is_active: !!s.is_active }))), 'approved');
});
test('порядок — по position, а не по порядку в массиве', () => {
  assert.equal(bookedStageKey([...SEED].reverse()), 'scheduled');
  assert.deepEqual(bookedStageCandidates([...CLINIC].reverse()), ['in_process', 'recall', 'approved', 'uspeshno']);
});

// ── «Колонка конверсии» — дополнение владельца 2026-10-09 ─────────────────
test('withConversion переносит вид won на выбранную колонку; прежняя конверсия — открытая; исходник не тронут', () => {
  const next = withConversion(CLINIC, 'uspeshno');
  assert.deepEqual(next.filter((s) => s.kind === 'won').map((s) => s.key), ['uspeshno'], 'конверсия ровно одна');
  assert.equal(next.find((s) => s.key === 'came').kind, 'open');
  assert.equal(CLINIC.find((s) => s.key === 'came').kind, 'won', 'чистая функция не правит вход');
  assert.equal(bookedStageKey(next), 'approved', 'колонка записи по умолчанию считается от новой конверсии');
});
test('конверсией нельзя: проигрышную, сидовую «Не пришёл», скрытую, несуществующую', () => {
  assert.equal(conversionRefusal(SEED, 'stopped'), 'lost');
  assert.equal(conversionRefusal(SEED, 'no_show'), 'lost');
  const noShowOpen = SEED.map((s) => (s.key === 'no_show' ? { ...s, kind: 'open' } : s));
  assert.equal(conversionRefusal(noShowOpen, 'no_show'), 'no_show', 'сидовая «Не пришёл» не конверсия, даже открытая');
  assert.equal(conversionRefusal(hide(SEED, 'approved'), 'approved'), 'hidden');
  assert.equal(conversionRefusal(SEED, 'nope'), 'missing');
  assert.equal(conversionRefusal(SEED, 'approved'), null);
  assert.equal(conversionRefusal(SEED, 'came'), null, 'нынешняя конверсия — допустима');
});
test('колонка записи обязана стоять ДО конверсии: выбор на месте конверсии или после неё — отказ', () => {
  assert.equal(conversionRefusal(SEED, 'scheduled', 'approved'), 'booked_order', 'запись после конверсии');
  assert.equal(conversionRefusal(SEED, 'approved', 'approved'), 'booked_order', 'запись = конверсия');
  assert.equal(conversionRefusal(SEED, 'approved', 'recall'), null);
  assert.equal(conversionRefusal(SEED, 'in_process'), 'booked_none', 'перед конверсией не осталось колонки для записанных');
});
test('кандидаты конверсии — по порядку доски, с нынешней; без проигрышных и скрытых', () => {
  assert.deepEqual(conversionCandidates(hide(SEED, 'recall')), ['scheduled', 'approved', 'came']);
  assert.deepEqual(conversionCandidates(CLINIC), ['recall', 'approved', 'uspeshno', 'came']);
  assert.deepEqual(conversionCandidates(SEED, 'approved'), ['came'], 'с выбранной записью «Подтверждён» конверсия — только после неё');
  assert.deepEqual(conversionCandidates(null), []);
});
