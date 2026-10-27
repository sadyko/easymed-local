// NAV_VISIBILITY_V1 — видимость разделов меню: чистая логика.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHidden, isHiddenView, navGroups, canHide, withHidden, NEVER_HIDDEN } from './nav-visibility-logic.js';

test('normalizeHidden: годные id, без «Настроек», без повторов, по алфавиту', () => {
    assert.deepEqual(normalizeHidden(['crm', 'settings', 'crm', 'telegram-chat', 'DROP TABLE', '', 42, null, 'my-stock']), ['crm', 'my-stock', 'telegram-chat']);
    assert.deepEqual(normalizeHidden(undefined), []);
    assert.deepEqual(normalizeHidden('crm'), [], 'строка вместо списка — пусто, не падение');
    assert.deepEqual([...NEVER_HIDDEN], ['settings']);
});

test('isHiddenView: сам пункт, его подэкран через parentOf; «Настройки» и их подэкраны — никогда', () => {
    const parentOf = (v) => ({ 'patient-card': 'patients', 'api-settings': 'settings', 'stock-log': 'inventory' }[v] || null);
    const hidden = ['patients', 'inventory', 'settings'];
    assert.equal(isHiddenView('patients', hidden, parentOf), true);
    assert.equal(isHiddenView('patient-card', hidden, parentOf), true, 'карта пациента прячется вместе с «Пациентами»');
    assert.equal(isHiddenView('stock-log', hidden, parentOf), true);
    assert.equal(isHiddenView('crm', hidden, parentOf), false);
    assert.equal(isHiddenView('settings', hidden, parentOf), false, '«Настройки» скрыть нельзя даже списком');
    assert.equal(isHiddenView('api-settings', hidden, parentOf), false);
    assert.equal(isHiddenView('', hidden, parentOf), false);
    assert.equal(isHiddenView('patients', new Set(['patients'])), true, 'Set тоже годится');
});

test('navGroups: группы из NAV в порядке объявления, пункты до заголовка — безымянная группа', () => {
    const nav = [
        { id: 'orphan', label: 'O' },
        { section: 'Clinical' }, { id: 'patients', label: 'Patients' }, { id: 'queue', label: 'Очередь', foldsInto: 'patients' },
        { section: 'Operations', fold: true }, { id: 'crm', label: 'CRM' },
        { section: 'Empty', fold: true },
    ];
    const g = navGroups(nav);
    assert.deepEqual(g.map((x) => [x.section, x.items.map((i) => i.id)]), [[null, ['orphan']], ['Clinical', ['patients', 'queue']], ['Operations', ['crm']]]);
    assert.equal(g[1].items[1].foldsInto, 'patients');
    assert.deepEqual(navGroups(null), []);
});

test('canHide / withHidden', () => {
    assert.equal(canHide('crm'), true);
    assert.equal(canHide('settings'), false);
    assert.equal(canHide('bad id'), false);
    assert.deepEqual(withHidden(['crm'], 'labs', true), ['crm', 'labs']);
    assert.deepEqual(withHidden(['crm', 'labs'], 'crm', false), ['labs']);
    assert.deepEqual(withHidden([], 'settings', true), [], '«Настройки» не добавляются');
});
