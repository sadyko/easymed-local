// ═══════════════════════════════════════════════════════════════════════════
// EVIDENCE MATRIX — CRM card × calendar × registration, door by door (HEAD e8b4aab4)
// ═══════════════════════════════════════════════════════════════════════════
// Tests only, no product fixes. Every DOOR test reproduces a patient STATE and then
// the exact browser call sequence of that door (/api/rpc + /api/db, file:line in
// helpers.mjs and MATRIX.md) on a fresh in-memory DB with all migrations
// (server/test-helpers/crm-unify-app.js), and asserts TODAY'S behaviour:
//   stage/date of the card · the card's lines (svc@day:status/visit; V = the door's
//   visit, B = the S2 booking; day T/D/D2) · crm_booking_links of V · counts of the
//   patient's cards and live visits · services in V.
// «GAP: …» tests are test.todo: they assert the owner's expectation («every booking
// or registration of a patient with a live card shows on that card and moves it»,
// and the owner decisions) and carry the code reason. A todo that fails is reported
// as TODO, not as a failure.
//
// Run (repo root):  LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs
// Older tree:       REPO_URL=file:///…/old/ LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs
// CRM_LINK_ALL_V1 — acceptance test of docs/specs/2026-10-16-crm-link-all-doors-design.md.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cell } from './helpers.mjs';
import { SCENARIOS } from './scenarios-link-all.mjs';   // CRM_LINK_ALL_V1 — the frozen doors + the plan's scenarios

// Observed at HEAD e8b4aab4 (2026-10-16) — today's behaviour, one entry per cell.
const EXPECT = {
  "1-S1-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "1-S2-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "1-S3-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "1-S4-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "1-S1-boss": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "1-S2-boss": {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "1-S3-boss": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "1-S4-boss": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "2-S1-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "2-S2-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]},
  "2-S3-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "2-S4-cc": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "2-S1-reg": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "2-S2-reg": {"stage":"scheduled","date":"D","lines":["30@D:pending/B"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "2-S3-reg": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "2-S4-reg": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "2-S1-boss": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "2-S2-boss": {"stage":"scheduled","date":"D","lines":["30@D:pending/B"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "2-S3-boss": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "2-S4-boss": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "2-S2same-reg": {"stage":"scheduled","date":"D","lines":["30@D:pending/V","40@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30,40]},
  "2-S1p-reg": {"stage":"scheduled","date":"D","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "3b-S1-reg": {"stage":"came","date":"-","lines":[],"link":"card","cards":1,"visits":1,"vs":[30]},
  "3b-S1-boss": {"stage":"came","date":"-","lines":[],"link":"card","cards":1,"visits":1,"vs":[30]},
  "3b-S1p-reg": {"stage":"came","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "3b-S2-reg": {"stage":"came","date":"D","lines":["30@D:pending/B"],"link":"card","cards":1,"visits":2,"vs":[30]},
  "3b-S3-reg": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "3b-S4-reg": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "3a-S1p-reg": {"stage":"came","date":"-","lines":[],"link":"card","cards":1,"visits":1,"vs":[30]},
  "3a-S3p-reg": {"stage":"came","date":"-","lines":[],"link":"card","cards":1,"visits":1,"vs":[30]},
  "3a-S4-reg": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "3c-S2-reg": {"stage":"came","date":"D","lines":["30@D:pending/B"],"link":"card","cards":1,"visits":2,"vs":[30]},
  "4-today-S1": {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "4-today-S1-pay": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "4-future-S1": {"stage":"scheduled","date":"D2","lines":["30@D2:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "4-today-S2": {"stage":"scheduled","date":"D","lines":["30@D:pending/B"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "4-today-S2-pay": {"stage":"scheduled","date":"D","lines":["30@D:pending/B"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "4-future-S2": {"stage":"scheduled","date":"D","lines":["30@D:pending/B"],"link":"none","cards":1,"visits":2,"vs":[30]},
  "4-today-S3": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "4-today-S3-pay": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "4-future-S3": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "4-today-S4": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "4-today-S4-pay": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "4-future-S4": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]},
  "4-today-S1p": {"stage":"scheduled","date":"T","lines":[],"link":"none","cards":1,"visits":1,"vs":[30]},
  "5-S1p-alone": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":0,"vs":[]},
  "5-S1p-crm-wizard": {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "5-S4-alone": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":0,"vs":[]},
  "6-S1-doc": {"stage":"scheduled","date":"D2","lines":["c5@D2:pending/V"],"link":"card","cards":1,"visits":1,"vs":["c5"]},
  "6-S2-doc": {"stage":"scheduled","date":"D","lines":["30@D:pending/B"],"link":"none","cards":1,"visits":2,"vs":["c5"]},
  "6-S3-doc": {"stage":"in_process","date":"-","lines":[],"link":"none","cards":1,"visits":1,"vs":["c5"]},
  "6-S4-doc": {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":["c5"]},
  "7-fast-S2T-same": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "7-fast-S2T-other": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30,40]},
  "7-fast-S2Tcal-same": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30,30]},
  "7-wiz-S2T-same": {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "7-wiz-S2T-same-pay": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "7-wiz-S2T-earlier": {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "7-wiz-S2Tcal-same": {"stage":"scheduled","date":"T","lines":["30@T:pending/V","30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30,30]},
  "8-S2-confirmed": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "8-S2T-arrived": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "8-S2-noshow": {"stage":"no_show","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":0,"vs":[30]},
  "8-S2-move": {"stage":"scheduled","date":"D2","lines":["30@D2:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "8-S2-cancel": {"stage":"in_process","date":"-","lines":["30@D:pending"],"link":"none","cards":1,"visits":0,"vs":[30]},
  "8-S1cal-arrived": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
  "8-S1cal-cancel": {"stage":"in_process","date":"-","lines":["30@D:pending"],"link":"card","cards":1,"visits":0,"vs":[30]},
  "9-S2T-pay": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "9-S2-prepay": {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]},
  "9-S2T-addline": {"stage":"came","date":"T","lines":["30@T:done/V","40@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30,40]},
  "9-S1cal-pay": {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]},
};

// ═══ CRM_LINK_ALL_V1 — DECIDED CELLS ═══════════════════════════════════════
// A cell whose rule an owner decision (D1–D4) or a defect fix (G4, G7) changed.
// `cell` replaces EXPECT[id] (today's behaviour above stays as the frozen record);
// `owner` names the OWNER predicate the cell must meet (null — an intermediate cell of a
// later task: the cell is pinned, its GAP stays todo); `rule` cites the decision.
// A GAP todo of a decided cell runs as a REAL test. Each task adds its own cells.
const DECIDED = {
  // Task 1 — R1 + R2 (D1)
  '2-S2-reg': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '2-S2-boss': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '2-S3-reg': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '2-S3-boss': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-today-S2': { rule: 'R1 (D1) + D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@D:pending/B","30@T:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-today-S2-pay': { rule: 'R1 (D1)', owner: 'came+lines', cell: {"stage":"came","date":"T","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-future-S2': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-today-S3': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-today-S3-pay': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-future-S3': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D2","lines":["30@D2:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '6-S2-doc': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","c5@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":["c5"]} },
  '6-S3-doc': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D2","lines":["c5@D2:pending/V"],"link":"card","cards":1,"visits":1,"vs":["c5"]} },
  // Task 2 — R5 (D4)
  '2-S1p-reg': { rule: 'R5 (D4)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-today-S1p': { rule: 'R5 (D4) + D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  // Task 3 — R6 (G4)
  '3b-S1-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S1-boss': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S2-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"D","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '3a-S1p-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3a-S3p-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3c-S2-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"D","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '7-fast-S2T-other': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"T","lines":["30@T:done/V","40@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30,40]} },
  '3b-S3-reg': { rule: 'R2 (D1) + R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S1p-reg': { rule: 'R5 (D4) + R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  // intermediate until Task 6 (R7b): the G7 twin is in the visit twice, so R6 shows it twice on the card too — its GAP stays todo
  '7-fast-S2Tcal-same': { rule: 'R6 (G4), before R7b', owner: null, cell: {"stage":"came","date":"T","lines":["30@T:done/V","30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30,30]} },
  // Task 4 — R4 (D3)
  '8-S2-confirmed': { rule: 'R4 (D3)', owner: 'approved', cell: {"stage":"approved","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
  // Task 5 — R3 (D2)
  '4-today-S1': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '5-S1p-crm-wizard': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2T-same': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2T-earlier': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
  '4-now-S1': { rule: 'R3 (D2) + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-now-S2': { rule: 'R3 (D2) + R6', owner: 'came+lines', cell: {"stage":"came","date":"D","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-now-S3': { rule: 'R3 (D2) + R2 + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-now-S4': { rule: 'R3 (D2): no card — still no card (owner decision 2)', owner: 'nodup', cell: {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]} },
  '4-now-S1p': { rule: 'R3 (D2) + R5 + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '5-S1p-crm-wizard-now': { rule: 'R3 (D2) + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2T-now': { rule: 'R3 (D2)', owner: 'came+lines', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
};

const rows = [];
after(() => {
  const w = (s, n) => String(s).padEnd(n);
  console.log('\n' + w('cell', 20) + w('stage', 12) + w('date', 6) + w('link', 6) + w('cards', 6) + w('visits', 7) + w('vs', 10) + 'card lines');
  for (const r of rows) console.log(w(r.id, 20) + w(r.o.stage, 12) + w(r.o.date, 6) + w(r.o.link, 6) + w(r.o.cards, 6) + w(r.o.visits, 7) + w(r.o.vs.join(','), 10) + r.o.lines.join(' '));
});

async function observe(sc) {
  const t = await start();
  try {
    const ctx = await sc.run(t);
    return cell(t, ctx.rid, ctx);
  } finally { t.close(); }
}

const OWNER = {
  lines: (o) => o.lines.some((l) => l.endsWith('/V')) && o.vs.every((s) => o.lines.some((l) => l.startsWith(s + '@') && l.endsWith('/V'))),
  moved: (o) => o.link === 'card' || o.lines.some((l) => l.endsWith('/V')),
  came: (o) => o.stage === 'came',
  'came+lines': (o) => o.stage === 'came' && o.lines.some((l) => l.endsWith('/V')),
  nodup: (o) => new Set(o.vs).size === o.vs.length,
  approved: (o) => o.stage === 'approved',
  // CRM_LINK_ALL_V1 (D2) — a later slot today is a booking: the card shows the visit and waits in the booked column.
  booked: (o) => o.stage === 'scheduled' && o.lines.some((l) => l.endsWith('/V')),
};
const OWNER_TEXT = {
  lines: 'the card shows the visit\'s services as its lines',
  moved: 'the live card takes the visit (link or lines) and moves',
  came: 'a desk registration of a called / booked patient sends the card to «Пришёл»',
  'came+lines': 'the card goes to «Пришёл» AND shows the visit',
  nodup: 'no service twice in the visit',
  approved: '«Подтверждён» in the calendar moves the card to «Подтверждён»',
  booked: 'a later slot today stays a booking: «Записан» with the visit on the card (D2)',
};

for (const sc of SCENARIOS) {
  const name = `DOOR ${sc.door} / ${sc.state} (${sc.who}) [${sc.id}]: ${sc.desc}`;
  const dec = DECIDED[sc.id] || null;
  test(name, async () => {
    const o = await observe(sc);
    rows.push({ id: sc.id, o });
    assert.deepEqual(o, dec ? dec.cell : EXPECT[sc.id], dec ? `CRM_LINK_ALL_V1 ${dec.rule}: decided cell` : 'today\'s behaviour changed');
    if (dec && dec.owner) assert.ok(OWNER[dec.owner](o), `CRM_LINK_ALL_V1 ${dec.rule}: ${OWNER_TEXT[dec.owner]}`);
  });
  if (sc.gap && dec && dec.owner) {
    test(`GAP→${dec.rule}: DOOR ${sc.door} / ${sc.state} (${sc.who}) [${sc.id}]: ${OWNER_TEXT[dec.owner]}`, async () => {
      const o = await observe(sc);
      assert.ok(OWNER[dec.owner](o), 'CRM_LINK_ALL_V1 decided expectation not met: ' + JSON.stringify(o));
    });
  } else if (sc.gap) {
    test.todo(`GAP: DOOR ${sc.door} / ${sc.state} (${sc.who}) [${sc.id}]: ${OWNER_TEXT[sc.gap.expect]} — ${sc.gap.reason}`, async () => {
      const o = await observe(sc);
      assert.ok(OWNER[sc.gap.expect](o), 'owner expectation not met: ' + JSON.stringify(o));
    });
  }
}
