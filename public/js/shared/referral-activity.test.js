// REFERRALS_CRM_V1 — активность врача-источника: правило одно на сервер и экран.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityStatus, activityCounters, dynamics, normalizeWindow, daysBetween, ACTIVITY_WINDOWS } from './referral-activity.js';

test('activityStatus: четыре состояния по фиксированным окнам 30 / 90', () => {
    assert.equal(activityStatus({ total: 0 }), 'never');
    assert.equal(activityStatus({ total: 3, last30: 1, last90: 1 }), 'active');
    assert.equal(activityStatus({ total: 3, last30: 0, last90: 2 }), 'fading');
    assert.equal(activityStatus({ total: 3, last30: 0, last90: 0 }), 'passive');
    assert.equal(activityStatus(), 'never', 'без аргументов — «ни разу», а не падение');
});

test('normalizeWindow: только 7 / 30 / 90, всё остальное — 30', () => {
    assert.deepEqual([...ACTIVITY_WINDOWS], [7, 30, 90]);
    assert.equal(normalizeWindow(7), 7);
    assert.equal(normalizeWindow('90'), 90);
    assert.equal(normalizeWindow(14), 30);
    assert.equal(normalizeWindow(undefined), 30);
});

test('dynamics: знак разницы', () => {
    assert.deepEqual(dynamics(5, 2), { delta: 3, kind: 'up' });
    assert.deepEqual(dynamics(1, 4), { delta: -3, kind: 'down' });
    assert.deepEqual(dynamics(0, 0), { delta: 0, kind: 'flat' });
    assert.deepEqual(dynamics(null, undefined), { delta: 0, kind: 'flat' });
});

test('daysBetween: календарные дни без часовых поясов', () => {
    assert.equal(daysBetween('2026-10-01', '2026-10-26'), 25);
    assert.equal(daysBetween('2026-10-26', '2026-10-01'), -25);
    assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
    assert.ok(Number.isNaN(daysBetween('', '2026-10-01')));
});

test('activityCounters: окно N, прошлое окно, 30 / 90, последний день; будущие визиты не считаются', () => {
    const today = '2026-10-26';
    const days = ['2026-10-26', '2026-10-20', '2026-10-19', '2026-09-30', '2026-08-01', '2026-11-05'];
    const c = activityCounters(days, today, 7);
    assert.equal(c.total, 5, 'запись на 5 ноября — ещё не направление');
    assert.equal(c.last, '2026-10-26');
    assert.equal(c.cur, 2, 'за 7 дней (0..6 дней назад): 26 и 20 октября; 19-е — ровно 7 дней назад — уже прошлое окно');
    assert.equal(c.prev, 1, 'прошлые 7 дней (7..13 дней назад): 19 октября');
    assert.equal(c.last30, 4, '26, 20, 19 октября и 30 сентября (26 дней назад)');
    assert.equal(c.last90, 5);
    assert.equal(c.status, 'active');
});

test('activityCounters: затихает / пассивен / ни разу', () => {
    const today = '2026-10-26';
    assert.equal(activityCounters(['2026-09-01'], today, 30).status, 'fading', '55 дней назад');
    assert.equal(activityCounters(['2026-06-01'], today, 30).status, 'passive', '147 дней назад');
    const never = activityCounters([], today, 30);
    assert.equal(never.status, 'never');
    assert.equal(never.last, null);
    assert.equal(never.total, 0);
});
