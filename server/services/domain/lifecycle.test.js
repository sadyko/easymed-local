// LIFECYCLE_V1 — the reachability guard.
//
// Two faults hid in the old ad-hoc status assignment, and neither was visible
// from any single call site:
//   • 'requested' admissions could never be LEFT (dead end — the patient could
//     never be referred for inpatient care again);
//   • 'refunded' invoices could never be REACHED (checked in five places,
//     assigned by nobody).
//
// Both are properties of the lifecycle as a whole, so they get tested as one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, TERMINAL, INITIAL, canTransition, assertTransition, TransitionError } from './lifecycle.js';

for (const entity of Object.keys(TRANSITIONS)) {
  test(`${entity}: every state is REACHABLE from an initial state`, () => {
    const table = TRANSITIONS[entity];
    const seen = new Set(INITIAL[entity]);
    const queue = [...INITIAL[entity]];
    while (queue.length) {
      for (const next of table[queue.shift()] || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    const unreachable = Object.keys(table).filter((s) => !seen.has(s));
    assert.deepEqual(unreachable, [],
      `${entity} states that no sequence of transitions can ever produce: ${unreachable.join(', ')}`);
  });

  test(`${entity}: every state can be LEFT, unless it is declared terminal`, () => {
    const table = TRANSITIONS[entity];
    const stuck = Object.keys(table)
      .filter((s) => (table[s] || []).length === 0)
      .filter((s) => !TERMINAL[entity].includes(s));
    assert.deepEqual(stuck, [],
      `${entity} dead ends — add a transition out, or declare them terminal: ${stuck.join(', ')}`);
  });

  test(`${entity}: declared terminal states really are terminal, and initial states exist`, () => {
    for (const s of TERMINAL[entity]) {
      assert.ok(s in TRANSITIONS[entity], `${entity}: terminal '${s}' is not a real state`);
      assert.deepEqual(TRANSITIONS[entity][s], [], `${entity}: terminal '${s}' has a way out`);
    }
    for (const s of INITIAL[entity]) {
      assert.ok(s in TRANSITIONS[entity], `${entity}: initial '${s}' is not a real state`);
    }
  });
}

// INPATIENT_FLOW_V1 (миграция 091) — 'requested' переименован в 'ordered', и у
// заявки появился настоящий маршрут вместо «сразу в лечение».
test('admission: заявка не тупик — её можно выполнить или отклонить', () => {
  assert.ok(canTransition('admission', 'ordered', 'admitted'), 'медсестра кладёт на койку');
  assert.ok(canTransition('admission', 'ordered', 'cancelled'), 'регистратура отклоняет');
  // …но заявка — ещё не госпитализация: выписать её нельзя, а законченную —
  // не открыть заново.
  assert.throws(() => assertTransition('admission', 'ordered', 'discharged'), TransitionError);
  assert.throws(() => assertTransition('admission', 'discharged', 'active'), TransitionError);
  // Слова 'requested' в маршруте больше нет вовсе.
  assert.ok(!('requested' in TRANSITIONS.admission));
});

// Порядок шагов — то, ради чего маршрут и заведён (решение владельца
// 2026-09-04). Пропуск ступени отвергается САМОЙ таблицей, без ролей.
test('admission: ступени маршрута идут по одной', () => {
  for (const [from, to] of [['ordered', 'examined'], ['admitted', 'active'],
    ['admitted', 'discharging'], ['examined', 'discharging'], ['examined', 'discharged']]) {
    assert.throws(() => assertTransition('admission', from, to), TransitionError, `${from} → ${to}`);
  }
  assert.ok(canTransition('admission', 'admitted', 'examined'));
  assert.ok(canTransition('admission', 'examined', 'active'));
  assert.ok(canTransition('admission', 'active', 'discharging'));
  assert.ok(canTransition('admission', 'discharging', 'discharged'));
});

// Две стрелки-наследства v0.8.0: их проходят СТАРЫЕ RPC (admit_patient,
// discharge_patient), и до Задач 2 и 8 они обязаны оставаться законными —
// иначе клиника теряет обе кнопки в день обновления. Машина маршрута их не
// предлагает (см. LEGACY_EDGES в rpc/inpatient-flow.js).
test('admission: наследственные прямые шаги v0.8.0 остаются законными', () => {
  assert.ok(canTransition('admission', 'ordered', 'active'), 'admit_patient');
  assert.ok(canTransition('admission', 'active', 'discharged'), 'discharge_patient');
});

test('re-asserting the current state is allowed; an unknown entity throws', () => {
  assert.ok(canTransition('admission', 'active', 'active'));
  assert.throws(() => canTransition('spaceship', 'a', 'b'), TransitionError);
});
