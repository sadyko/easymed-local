// CRM_UNIFY_V1 — «Колонка записи» и «Колонка конверсии»: одно правило для
// сервера (services/crm/config.js) и браузера (crm-settings-logic.js,
// views/crm-settings.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedStageKey, bookedStageCandidates, withConversion, conversionRefusal, conversionCandidates,
  STAGE_ROLES, roleKey, hasStageRoles, withRole, roleRefusal, roleLeaving, conversionMove,   // CRM_STAGE_ROLES_V1
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

// ── CRM_STAGE_ROLES_V1 — роли колонок (миграция 284) ──────────────────────
// ОБНОВЛЕНО НАМЕРЕННО (3.23.0): колонка записи, подтверждения и «Не пришёл» — роли колонок,
// а не догадка. Прежние проверки конверсии с выбранной колонкой записи (третий аргумент,
// 'booked_none') переписаны на роли: без роли «запись» конверсии ничто не мешает.
const withRoles = (list, roles) => list.map((s) => ({ ...s, role: roles[s.key] || null }));
const ROLED = withRoles(SEED, { scheduled: 'booked', approved: 'confirmed', no_show: 'no_show' });

test('роли: ключ по роли; без поля role — сервер старше экрана', () => {
  assert.equal(roleKey(ROLED, 'booked'), 'scheduled');
  assert.equal(roleKey(ROLED, 'confirmed'), 'approved');
  assert.equal(roleKey(ROLED, 'no_show'), 'no_show');
  assert.equal(roleKey(SEED, 'booked'), null);
  assert.equal(hasStageRoles(ROLED), true);
  assert.equal(hasStageRoles(SEED), false);
  assert.deepEqual([...STAGE_ROLES], ['booked', 'confirmed', 'no_show']);
});
test('withRole: роль одна на воронку и у колонки одна роль; снять можно; вход не меняется', () => {
  const moved = withRole(ROLED, 'recall', 'booked');
  assert.equal(roleKey(moved, 'booked'), 'recall');
  assert.equal(moved.find((s) => s.key === 'scheduled').role, null, 'прежняя колонка записи держит роль');
  const swapped = withRole(ROLED, 'approved', 'booked');
  assert.equal(roleKey(swapped, 'booked'), 'approved');
  assert.equal(roleKey(swapped, 'confirmed'), null, 'у колонки две роли');
  const off = withRole(ROLED, 'no_show', 'no_show', false);
  assert.equal(roleKey(off, 'no_show'), null);
  assert.equal(roleKey(ROLED, 'booked'), 'scheduled', 'чистая функция правит вход');
});
test('roleRefusal: запись — открытая видимая до конверсии; подтверждение — после записи и до конверсии; «Не пришёл» — проигрышная', () => {
  assert.equal(roleRefusal(ROLED), null);
  assert.equal(roleRefusal(withRole(ROLED, 'came', 'booked')), 'booked_order', 'конверсия — колонка записи');
  assert.equal(roleRefusal(withRole(ROLED, 'stopped', 'booked')), 'booked_order', 'проигрышная — колонка записи');
  assert.equal(roleRefusal(hide(ROLED, 'scheduled')), 'booked_order', 'скрытая — колонка записи');
  const later = [...ROLED, { ...st('later', 'open', 9), role: null }];
  assert.equal(roleRefusal(withRole(later, 'later', 'booked')), 'booked_order', 'запись после конверсии');
  assert.equal(roleRefusal(withRole(ROLED, 'recall', 'confirmed')), 'confirmed_order', 'подтверждение до записи');
  assert.equal(roleRefusal(withRole(ROLED, 'scheduled', 'booked', false)), 'confirmed_order', 'подтверждение без записи');
  assert.equal(roleRefusal(hide(ROLED, 'approved')), 'confirmed_order', 'скрытая — колонка подтверждения');
  assert.equal(roleRefusal(withRole(ROLED, 'approved', 'confirmed', false)), null, 'без подтверждения можно');
  assert.equal(roleRefusal(withRole(ROLED, 'recall', 'no_show')), 'no_show_kind', '«Не пришёл» — открытая');
  assert.equal(roleRefusal(withRole(ROLED, 'stopped', 'no_show')), null, 'другая проигрышная — можно');
  assert.equal(roleRefusal(withRole(hide(ROLED, 'stopped'), 'stopped', 'no_show'), ROLED), 'no_show_kind', 'новая роль скрытой колонке');
  assert.equal(roleRefusal(hide(ROLED, 'no_show'), hide(ROLED, 'no_show')), null, 'скрытая «Не пришёл» с прежней ролью (миграция 284) — можно');
  assert.equal(roleRefusal(ROLED.map((s) => (s.key === 'recall' ? { ...s, role: 'booked' } : s))), 'role_twice');
  assert.equal(roleRefusal(SEED), null, 'без ролей — можно');
});
test('roleLeaving: колонку с ролью удаляют или скрывают — отказ; роль передали в той же правке — можно', () => {
  const without = (list, key) => list.filter((s) => s.key !== key);
  assert.deepEqual(roleLeaving(ROLED, without(ROLED, 'scheduled')), { role: 'booked', key: 'scheduled', label: 'scheduled', why: 'deleted' });
  assert.equal(roleLeaving(ROLED, without(withRole(ROLED, 'recall', 'booked'), 'scheduled')), null, 'роль у другой колонки');
  assert.deepEqual(roleLeaving(ROLED, hide(ROLED, 'approved')), { role: 'confirmed', key: 'approved', label: 'approved', why: 'hidden' });
  assert.equal(roleLeaving(ROLED, hide(withRole(ROLED, 'approved', 'confirmed', false), 'approved')), null, 'роль снята — скрыть можно');
  assert.equal(roleLeaving(hide(ROLED, 'no_show'), hide(ROLED, 'no_show')), null, 'уже скрытая — не уход');
  assert.equal(roleLeaving(ROLED, ROLED), null);
});
test('конверсией нельзя: проигрышную, колонку «Не пришёл», скрытую, несуществующую', () => {
  assert.equal(conversionRefusal(ROLED, 'stopped'), 'lost');
  assert.equal(conversionRefusal(ROLED, 'no_show'), 'lost');
  const noShowOpen = ROLED.map((s) => (s.key === 'no_show' ? { ...s, kind: 'open' } : s));
  assert.equal(conversionRefusal(noShowOpen, 'no_show'), 'no_show', 'колонка с ролью «Не пришёл» не конверсия, даже открытая');
  assert.equal(conversionRefusal(hide(ROLED, 'recall'), 'recall'), 'hidden');
  assert.equal(conversionRefusal(ROLED, 'nope'), 'missing');
  assert.equal(conversionRefusal(ROLED, 'came'), null, 'нынешняя конверсия — допустима');
});
test('роли не переезжают с конверсией: колонка записи на месте конверсии или после неё — отказ; подтверждение — снимается', () => {
  assert.equal(conversionRefusal(ROLED, 'scheduled'), 'booked_order', 'конверсия на колонке записи');
  assert.equal(conversionRefusal(ROLED, 'approved'), null, 'конверсия на колонке подтверждения — роль подтверждения снимается');
  const moved = conversionMove(ROLED, 'approved');
  assert.equal(roleKey(moved.stages, 'confirmed'), null);
  assert.equal(roleKey(moved.stages, 'booked'), 'scheduled');
  assert.equal(conversionMove(ROLED, 'scheduled').why, 'booked_order');
  assert.equal(conversionRefusal(ROLED, 'recall'), 'booked_order', 'запись после конверсии');
  assert.equal(conversionRefusal(withRole(ROLED, 'approved', 'confirmed', false), 'approved'), null);
  assert.equal(conversionRefusal(SEED, 'in_process'), null, 'без ролей конверсии ничто не мешает');
});
test('кандидаты конверсии — по порядку доски, с нынешней; без проигрышных, скрытых и мест, ломающих роли', () => {
  assert.deepEqual(conversionCandidates(ROLED), ['approved', 'came']);
  assert.deepEqual(conversionCandidates(withRole(ROLED, 'approved', 'confirmed', false)), ['approved', 'came']);
  assert.deepEqual(conversionCandidates(withRoles(CLINIC, { approved: 'booked' })), ['uspeshno', 'came']);
  assert.deepEqual(conversionCandidates(hide(SEED, 'recall')), ['in_process', 'scheduled', 'approved', 'came']);
  assert.deepEqual(conversionCandidates(null), []);
});
