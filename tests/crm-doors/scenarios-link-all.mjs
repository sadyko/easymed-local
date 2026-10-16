// CRM_LINK_ALL_V1 — scenarios added by the plan docs/plans/2026-10-16-crm-link-all.md
// (appended to SCENARIOS from scenarios-789.mjs). They have no frozen «today's
// behaviour» cell: their expectation lives only in DECIDED (matrix.test.mjs).
import {
  TODAY, PID, nowIso,
  seedS1, seedS2, seedS3, seedPhoneCard, wizardRegister, createPatient,
} from './helpers.mjs';
import { SCENARIOS } from './scenarios-789.mjs';

const add = (id, door, state, who, desc, run, gap = null) => SCENARIOS.push({ id, door, state, who, desc, run, gap });
const pickCard = (t, pid = PID) => { const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(pid); return c ? c.id : null; };

// ─── Task 5 — R3 (D2): the wizard's «now» registration is a desk arrival ─────
// «now» = live-queue / no-slot mode: ensure_visit WITHOUT book, desk: true (visit-wizard.js createVisit).
const st = {
  S1: (t) => ({ rid: seedS1(t) }),
  S2: async (t) => seedS2(t),
  S3: (t) => ({ rid: seedS3(t) }),
  S4: () => ({ rid: null }),
  S1p: (t) => ({ rid: seedS1(t, { patient: null }) }),
};
for (const [state, seed] of Object.entries(st)) {
  add(`4-now-${state}`, 4, state, 'reg', 'wizard TODAY «now» (no slot / live queue) — desk arrival (R3)', async (t) => {
    const s = await seed(t);
    const { vid } = await wizardRegister(t, 'reg', nowIso(), { book: false, desk: true });
    return { ...s, rid: s.rid || pickCard(t), vid };
  });
}
add('5-S1p-crm-wizard-now', 5, 'S1p', 'reg', 'QPM from the CRM card → convert → wizard TODAY «now» (R3)', async (t) => {
  const rid = seedPhoneCard(t);
  const pid = await createPatient(t, 'reg');
  const up = await t.dbq('reg', { table: 'crm_requests', op: 'update', values: { patient_id: pid }, filters: [{ col: 'id', op: 'eq', val: rid }] });
  if (up.status !== 200) throw new Error(up.text);
  const { vid } = await wizardRegister(t, 'reg', nowIso(), { pid, book: false, desk: true });
  return { rid, vid, pid };
});
add('7-wiz-S2T-now', 7, 'S2T', 'reg', 'call centre booked TODAY 23:00 from the card; the patient comes early — wizard «now» (R3)', async (t) => {
  const s = await seedS2(t, TODAY, { hour: 23 });
  const { vid } = await wizardRegister(t, 'reg', nowIso(), { book: false, desk: true });
  return { ...s, vid };
});

export { SCENARIOS };
