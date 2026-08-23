// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) —
// tests for every pure decision behind Settings → «Система». Pure node, no
// fake DOM, no locale pin needed: unlike the __tests__/*.mjs view fixtures,
// nothing here touches i18n.js — every label is asserted as the literal
// Russian source string these functions return (translation happens later,
// in h()'s text-child path, and is not this file's concern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASH, formatRuDateTime, formatBytes, backupKind, backupKindLabel,
  backupDateLabel, normalizeBackupList, freeSpaceNote, confirmWordOk,
  validUntilLabel, validityLabel, lastCheckinLabel, dashWhenEmpty,
  subscriptionBadge, moduleRows, enrollFormVisible, requestDateLabel,
} from './system-logic.js';

// --- formatRuDateTime / backupDateLabel -------------------------------------

test('formatRuDateTime: DD.MM.YYYY HH:mm from ms, ISO and Date, zero-padded', () => {
  const at = new Date(2026, 7, 23, 3, 5, 0);
  assert.equal(formatRuDateTime(at.getTime()), '23.08.2026 03:05');
  assert.equal(formatRuDateTime(at.toISOString()), '23.08.2026 03:05');
  assert.equal(formatRuDateTime(at), '23.08.2026 03:05');
});

test('formatRuDateTime: garbage/missing → null, never "Invalid Date"', () => {
  for (const bad of [null, undefined, '', 'вчера', {}]) {
    assert.equal(formatRuDateTime(bad), null, `input=${JSON.stringify(bad)}`);
  }
});

test('backupDateLabel: em-dash when the server sent no mtime', () => {
  assert.equal(backupDateLabel(undefined), DASH);
  assert.equal(backupDateLabel(new Date(2026, 0, 2, 14, 30).getTime()), '02.01.2026 14:30');
});

// --- formatBytes -------------------------------------------------------------

test('formatBytes: bytes stay in Б, units climb with a Russian comma decimal', () => {
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(1023), '1023 Б');
  assert.equal(formatBytes(1024), '1 КБ');
  assert.equal(formatBytes(1229), '1,2 КБ');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 МБ');
  assert.equal(formatBytes(1.8 * 1024 * 1024 * 1024), '1,8 ГБ');
});

test('formatBytes: one decimal only under 10 of a unit, whole numbers above', () => {
  assert.equal(formatBytes(9.4 * 1024), '9,4 КБ');
  assert.equal(formatBytes(347 * 1024), '347 КБ');
});

test('formatBytes: missing/garbage/negative size → em-dash, never "NaN Б" (the parallel-built server may omit size)', () => {
  for (const bad of [null, undefined, '', 'много', -1, NaN, {}]) {
    assert.equal(formatBytes(bad), DASH, `size=${JSON.stringify(bad)}`);
  }
});

test('formatBytes: numeric string is accepted (the shape JSON round-trips can hand back)', () => {
  assert.equal(formatBytes('2048'), '2 КБ');
});

// --- backupKind / backupKindLabel --------------------------------------------

test('backupKind: prefers the server kind field, falls back to the filename prefix', () => {
  assert.equal(backupKind({ kind: 'daily', name: 'manual-x.db' }), 'daily');
  assert.equal(backupKind({ name: 'pre-20260823-030000.db' }), 'pre');
  assert.equal(backupKind({ name: 'safety-20260823-030000.db' }), 'safety');
  assert.equal(backupKind({ name: 'nodash.db' }), null);
  assert.equal(backupKind(null), null);
});

test('backupKindLabel: the five plan kinds plus replaced- get human words', () => {
  assert.equal(backupKindLabel('pre'), 'перед обновлением');
  assert.equal(backupKindLabel('daily'), 'ежедневная');
  assert.equal(backupKindLabel('manual'), 'ручная');
  assert.equal(backupKindLabel('safety'), 'страховочная (перед восстановлением)');
  assert.equal(backupKindLabel('final'), 'перед удалением данных');
  assert.equal(backupKindLabel('replaced'), 'заменённая при восстановлении');
});

test('backupKindLabel: an unknown kind shows its raw word (identifiable), only a missing kind shows the dash', () => {
  assert.equal(backupKindLabel('weekly'), 'weekly');
  assert.equal(backupKindLabel(null), DASH);
  assert.equal(backupKindLabel(''), DASH);
});

// --- normalizeBackupList -------------------------------------------------------

test('normalizeBackupList: bare array and {backups: []} both accepted, sorted newest first', () => {
  const rows = [
    { name: 'daily-old.db', mtimeMs: 100 },
    { name: 'manual-new.db', mtimeMs: 300 },
    { name: 'pre-mid.db', mtimeMs: 200 },
  ];
  const fromArray = normalizeBackupList(rows);
  assert.deepEqual(fromArray.map((r) => r.name), ['manual-new.db', 'pre-mid.db', 'daily-old.db']);
  const fromWrapped = normalizeBackupList({ backups: rows, free_bytes: 1 });
  assert.deepEqual(fromWrapped.map((r) => r.name), ['manual-new.db', 'pre-mid.db', 'daily-old.db']);
});

test('normalizeBackupList: does not mutate the input array (the view may repaint from the same status object)', () => {
  const rows = [{ name: 'a.db', mtimeMs: 1 }, { name: 'b.db', mtimeMs: 2 }];
  normalizeBackupList(rows);
  assert.deepEqual(rows.map((r) => r.name), ['a.db', 'b.db']);
});

test('normalizeBackupList: rows without a usable name are dropped — name is the restore key', () => {
  const out = normalizeBackupList([{ name: 'ok.db', mtimeMs: 1 }, { mtimeMs: 2 }, { name: '', mtimeMs: 3 }, null, 'x']);
  assert.deepEqual(out.map((r) => r.name), ['ok.db']);
});

test('normalizeBackupList: {} (the answer before the RPC exists), null, garbage → empty list, never a throw', () => {
  for (const bad of [{}, null, undefined, 'x', 42]) {
    assert.deepEqual(normalizeBackupList(bad), [], `input=${JSON.stringify(bad)}`);
  }
});

test('normalizeBackupList: a row with no mtimeMs sinks to the bottom, not the top', () => {
  const out = normalizeBackupList([{ name: 'undated.db' }, { name: 'dated.db', mtimeMs: 5 }]);
  assert.deepEqual(out.map((r) => r.name), ['dated.db', 'undated.db']);
});

// --- freeSpaceNote ---------------------------------------------------------------

test('freeSpaceNote: the courtesy line when backup_list shipped free_bytes', () => {
  assert.equal(freeSpaceNote({ backups: [], free_bytes: 12 * 1024 * 1024 * 1024 }), 'Свободно на диске: 12 ГБ');
});

test('freeSpaceNote: absent/garbage free_bytes → null (no line beats a dash)', () => {
  for (const bad of [{}, { free_bytes: null }, { free_bytes: 'много' }, { free_bytes: -1 }, null, undefined, []]) {
    assert.equal(freeSpaceNote(bad), null, `input=${JSON.stringify(bad)}`);
  }
});

// --- confirmWordOk ---------------------------------------------------------------

test('confirmWordOk: exactly «УДАЛИТЬ», surrounding whitespace forgiven', () => {
  assert.equal(confirmWordOk('УДАЛИТЬ'), true);
  assert.equal(confirmWordOk('  УДАЛИТЬ  '), true, 'an invisible trailing space must not gaslight the admin');
});

test('confirmWordOk: case, lookalikes and everything else refused — the server re-checks the same exact word', () => {
  for (const bad of ['удалить', 'Удалить', 'DELETE', 'УДАЛИТ', 'УДАЛИТЬ!', '', null, undefined, 42]) {
    assert.equal(confirmWordOk(bad), false, `input=${JSON.stringify(bad)}`);
  }
});

// --- validUntilLabel / validityLabel ---------------------------------------------

test('validUntilLabel: ISO or ms → DD.MM.YYYY; absent (server not shipping it yet) → em-dash', () => {
  assert.equal(validUntilLabel(new Date(2026, 8, 12).toISOString()), '12.09.2026');
  assert.equal(validUntilLabel(new Date(2026, 8, 12).getTime()), '12.09.2026');
  assert.equal(validUntilLabel(null), DASH);
  assert.equal(validUntilLabel('когда-нибудь'), DASH);
});

test('validityLabel: date and days fold into one line when both are known', () => {
  const lic = { valid_until: new Date(2026, 8, 12).toISOString(), days_left: 22 };
  assert.equal(validityLabel(lic), '12.09.2026 — осталось 22 дн.');
});

test('validityLabel: days alone (no valid_until from the server yet) still says something honest', () => {
  assert.equal(validityLabel({ days_left: 22 }), 'осталось 22 дн.');
});

test('validityLabel: locked (days 0) with a date shows the date without a "0 дн." countdown', () => {
  assert.equal(validityLabel({ valid_until: new Date(2026, 8, 12).toISOString(), days_left: 0 }), '12.09.2026');
});

test('validityLabel: nothing known → em-dash; malformed licence → em-dash', () => {
  assert.equal(validityLabel({}), DASH);
  assert.equal(validityLabel(null), DASH);
});

// --- lastCheckinLabel / dashWhenEmpty --------------------------------------------

test('lastCheckinLabel: timestamp or em-dash (before the first check-in ever)', () => {
  assert.equal(lastCheckinLabel(new Date(2026, 7, 23, 9, 0).toISOString()), '23.08.2026 09:00');
  assert.equal(lastCheckinLabel(null), DASH);
});

test('dashWhenEmpty: value or em-dash, and 0 is a value, not an absence', () => {
  assert.equal(dashWhenEmpty('c-000051'), 'c-000051');
  assert.equal(dashWhenEmpty(''), DASH);
  assert.equal(dashWhenEmpty(null), DASH);
  assert.equal(dashWhenEmpty(undefined), DASH);
  assert.equal(dashWhenEmpty(0), '0');
});

// --- subscriptionBadge ------------------------------------------------------------

test('subscriptionBadge: not_enrolled is its own state, not a flavour of lapse', () => {
  assert.deepEqual(subscriptionBadge({ state: 'locked', locked: true, reason: 'not_enrolled' }),
    { kind: 'warn', label: 'Не активирована' });
});

test('subscriptionBadge: locked wording follows the reason — a paid clinic offline is never told it owes money', () => {
  assert.deepEqual(subscriptionBadge({ state: 'locked', locked: true, reason: 'unpaid' }),
    { kind: 'crit', label: 'Подписка не активна' });
  assert.deepEqual(subscriptionBadge({ state: 'locked', locked: true, reason: 'offline' }),
    { kind: 'crit', label: 'Нет связи с Easy-Med — система заблокирована' });
  assert.deepEqual(subscriptionBadge({ state: 'locked', locked: true, reason: 'unlicensed' }),
    { kind: 'crit', label: 'Лицензия недействительна' });
});

test('subscriptionBadge: warn/notice rungs carry the day count with reason-specific wording', () => {
  assert.deepEqual(subscriptionBadge({ state: 'warn', locked: false, reason: 'unpaid', days_left: 3 }),
    { kind: 'warn', label: 'Подписка заканчивается через 3 дн.' });
  assert.deepEqual(subscriptionBadge({ state: 'notice', locked: false, reason: 'offline', days_left: 9 }),
    { kind: 'info', label: 'Нет связи с Easy-Med 9 дн.' });
});

test('subscriptionBadge: a malformed days_left on a warn rung floors at 1, never «0 дн.»', () => {
  const b = subscriptionBadge({ state: 'warn', locked: false, reason: 'unpaid', days_left: null });
  assert.match(b.label, /через 1 дн\./);
});

test('subscriptionBadge: ok → calm green; locked must be boolean true, string garbage falls through', () => {
  assert.deepEqual(subscriptionBadge({ state: 'ok', locked: false, reason: 'unpaid', days_left: 200 }),
    { kind: 'ok', label: 'Подписка активна' });
  assert.equal(subscriptionBadge({ state: 'ok', locked: 'true', reason: 'offline' }).kind, 'ok',
    'same === true strictness as licence.js isLicensed()');
});

test('subscriptionBadge: null/malformed licence → dash badge, never a throw', () => {
  assert.deepEqual(subscriptionBadge(null), { kind: '', label: DASH });
});

// --- moduleRows --------------------------------------------------------------------

test('moduleRows: the two-key client vocabulary, marked against the granted list', () => {
  assert.deepEqual(moduleRows(['crm']), [
    { key: 'crm', label: 'CRM и call-центр', enabled: true },
    { key: 'telegram', label: 'Telegram-бот для пациентов', enabled: false },
  ]);
});

test('moduleRows: a granted key the vocabulary does not know still shows (paid-for must never be invisible)', () => {
  const rows = moduleRows(['crm', 'marketing']);
  const extra = rows.find((r) => r.key === 'marketing');
  assert.deepEqual(extra, { key: 'marketing', label: 'marketing', enabled: true });
});

test('moduleRows: malformed modules (string, null, mixed junk) reads as nothing enabled, never a throw', () => {
  for (const bad of [null, undefined, 'crm', 42]) {
    assert.equal(moduleRows(bad).every((r) => r.enabled === false), true, `modules=${JSON.stringify(bad)}`);
  }
  const mixed = moduleRows(['crm', 7, null]);
  assert.equal(mixed.find((r) => r.key === 'crm').enabled, true);
  assert.equal(mixed.length, 2, 'non-string junk in the array must not become a phantom row');
});

// --- enrollFormVisible --------------------------------------------------------------

test('enrollFormVisible: ONLY when licence_status says not enrolled', () => {
  assert.equal(enrollFormVisible({ reason: 'not_enrolled' }), true);
  assert.equal(enrollFormVisible({ reason: 'unpaid' }), false);
  assert.equal(enrollFormVisible({ reason: 'offline' }), false);
  assert.equal(enrollFormVisible(null), false);
});

// --- requestDateLabel ----------------------------------------------------------------

test('requestDateLabel: ru-RU date or empty string — same shape as locked-module.js formatRequestDate', () => {
  assert.equal(requestDateLabel('2026-08-23T09:00:00.000Z'), new Date('2026-08-23T09:00:00.000Z').toLocaleDateString('ru-RU'));
  assert.equal(requestDateLabel(null), '');
  assert.equal(requestDateLabel('не дата'), '');
});
