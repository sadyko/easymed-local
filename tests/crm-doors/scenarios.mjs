// Door × state scenarios. Each run(t) reproduces a state, then the door's exact
// browser call sequence (see helpers.mjs / MATRIX.md for file:line), and returns
// { rid, vid, bid, pid } for cell(). EXPECT lives in matrix.test.mjs.
import {
  TODAY, D, D2, PID, at, nowIso, TODAY_SLOT,
  seedS1, seedS2, seedS3, seedPhoneCard, crmCardBook, calendarPickerBook, fastRegister,
  wizardRegister, repeatVisit, invoiceAndPay, createPatient, addVisitLine, card,
} from './helpers.mjs';

const S = [];
const add = (id, door, state, who, desc, run, gap = null) => S.push({ id, door, state, who, desc, run, gap });

// ─── DOOR 1 — CRM card «Даты приёма» → «Сохранить и записать» ─────────────────
for (const who of ['cc', 'boss']) {
  add(`1-S1-${who}`, 1, 'S1', who, 'call card booked for D from the card', async (t) => {
    const rid = seedS1(t);
    const { vid } = await crmCardBook(t, rid, D, who);
    return { rid, vid };
  });
  add(`1-S2-${who}`, 1, 'S2', who, 'booked card books a second day D2 from the same card', async (t) => {
    const { rid, bid } = await seedS2(t);
    const { vid } = await crmCardBook(t, rid, D2, who, { hour: 11, cardDate: D });
    return { rid, vid, bid };
  });
  add(`1-S3-${who}`, 1, 'S3', who, 'old card (5 days) opened and booked for D', async (t) => {
    const rid = seedS3(t);
    const { vid } = await crmCardBook(t, rid, D, who);
    return { rid, vid };
  });
  add(`1-S4-${who}`, 1, 'S4', who, 'new card created on the board and booked for D', async (t) => {
    const { rid, vid } = await crmCardBook(t, null, D, who);
    return { rid, vid };
  });
}

// ─── DOOR 2 — calendar slot → service picker ─────────────────────────────────
const NOT_ON_CARD = 'visit-link.js:466-472 step C waitsForDay (:253) — the card waits for another day / is out of the 72h window; step E (contact window) runs only for a pure call-centre user (:492)';
for (const who of ['cc', 'reg', 'boss']) {
  add(`2-S1-${who}`, 2, 'S1', who, 'calendar booking for D', async (t) => {
    const rid = seedS1(t);
    const { vid } = await calendarPickerBook(t, who, D);
    return { rid, vid };
  });
  add(`2-S2-${who}`, 2, 'S2', who, 'calendar booking for ANOTHER day D2 of a patient booked on the card for D', async (t) => {
    const { rid, bid } = await seedS2(t);
    const { vid } = await calendarPickerBook(t, who, D2);
    return { rid, vid, bid };
  }, who === 'cc' ? null : { reason: NOT_ON_CARD, expect: 'lines' });
  add(`2-S3-${who}`, 2, 'S3', who, 'calendar booking for D of a patient whose open card is 5 days old', async (t) => {
    const rid = seedS3(t);
    const { vid } = await calendarPickerBook(t, who, D);
    return { rid, vid };
  }, who === 'cc' ? null : { reason: NOT_ON_CARD, expect: 'moved' });
  add(`2-S4-${who}`, 2, 'S4', who, 'calendar booking for D, no card', async (t) => {
    const { vid } = await calendarPickerBook(t, who, D);
    const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(PID);
    return { rid: c ? c.id : null, vid };
  });
}
add('2-S2same-reg', 2, 'S2', 'reg', 'registrar adds a service on the SAME booked day D via the calendar (other doctor → day_visit_busy → add_to_day_visit)', async (t) => {
  t.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11,'doc2','x','Петров','doctor',1)").run();
  const { rid, bid } = await seedS2(t);
  const { vid } = await calendarPickerBook(t, 'reg', D, { hour: 14, svc: 40, doctor: 11 });
  return { rid, vid, bid };
});
add('2-S1p-reg', 2, 'S1p', 'reg', 'calendar booking for D; the call card has only the phone (unknown caller)', async (t) => {
  const rid = seedS1(t, { patient: null });
  const { vid } = await calendarPickerBook(t, 'reg', D);
  return { rid, vid };
}, { reason: 'visit-link.js:474-484 step D (phone) writes only patient_id + stage; step F skips «phone» (:513-515) → no crm_booking_links → mirrorVisit has no requestOfVisit → no lines (deliberate money rule: shared family phone)', expect: 'lines' });

export const SCENARIOS = S;

// ─── DOOR 3 — fast registration («Быстрая регистрация» → registerWalkIn) ──────
export const DESK_NO_LINES = 'visit-link.js:528-544 step G sends the card to «Пришёл» (won, closed) BEFORE the desk lines exist; the lines are inserted later via /api/db → mirrorVisit step 3 (booking-mirror.js:429-432, :451) drops reqId of a closed card and writes no line; deskArrive mirror (:388-389) runs while the visit is still empty';
const DESK_OLD = 'visit-link.js:320-333 deskCloses: open card older than 72h that does not wait for today is left as is (step C :468); step E is never used at the desk (:492 !desk)';
for (const who of ['reg', 'boss']) {
  add(`3b-S1-${who}`, 3, 'S1', who, 'existing patient from the search strip; call card ≤72h', async (t) => {
    const rid = seedS1(t);
    const { vid } = await fastRegister(t, who);
    return { rid, vid };
  }, { reason: DESK_NO_LINES, expect: 'lines' });
}
add('3b-S1p-reg', 3, 'S1p', 'reg', 'existing patient; the call card has only the phone', async (t) => {
  const rid = seedS1(t, { patient: null });
  const { vid } = await fastRegister(t, 'reg');
  return { rid, vid };
}, { reason: DESK_NO_LINES + '; phone match (step D :474-484) gives patient_id only', expect: 'lines' });
add('3b-S2-reg', 3, 'S2', 'reg', 'existing patient booked by the call centre for D comes TODAY (fast registration)', async (t) => {
  const { rid, bid } = await seedS2(t);
  const { vid } = await fastRegister(t, 'reg');
  return { rid, vid, bid };
}, { reason: DESK_NO_LINES, expect: 'lines' });
add('3b-S3-reg', 3, 'S3', 'reg', 'existing patient; open card 5 days old', async (t) => {
  const rid = seedS3(t);
  const { vid } = await fastRegister(t, 'reg');
  return { rid, vid };
}, { reason: DESK_OLD, expect: 'moved' });
add('3b-S4-reg', 3, 'S4', 'reg', 'existing patient, no card (walk-in)', async (t) => {
  const { vid } = await fastRegister(t, 'reg');
  const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(PID);
  return { rid: c ? c.id : null, vid };
});
add('3a-S1p-reg', 3, 'S1p', 'reg', 'NEW patient (INSERT patients + crm_link_new_patient) whose number called ≤72h ago', async (t) => {
  const rid = seedPhoneCard(t);
  const pid = await createPatient(t, 'reg');
  const { vid } = await fastRegister(t, 'reg', { pid });
  return { rid, vid, pid };
}, { reason: DESK_NO_LINES, expect: 'lines' });
add('3a-S3p-reg', 3, 'S3p', 'reg', 'NEW patient whose number called 5 days ago (phone card out of window)', async (t) => {
  const rid = seedPhoneCard(t, { old: true });
  const pid = await createPatient(t, 'reg');
  const { vid } = await fastRegister(t, 'reg', { pid });
  return { rid, vid, pid };
}, { reason: 'crm_link_new_patient links the old card and bumps updated_at (new-patient-link.js:92), so deskCloses lets it close; ' + DESK_NO_LINES, expect: 'lines' });
add('3a-S4-reg', 3, 'S4', 'reg', 'NEW patient, no card (walk-in)', async (t) => {
  const pid = await createPatient(t, 'reg');
  const { vid } = await fastRegister(t, 'reg', { pid });
  const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(pid);
  return { rid: c ? c.id : null, vid, pid };
});
add('3c-S2-reg', 3, 'S2', 'reg', '«use existing» in the duplicate dialog (server-identical to 3b: no INSERT patients, no crm_link_new_patient) — call-centre-booked patient comes today', async (t) => {
  const { rid, bid } = await seedS2(t);
  // the duplicate check is reads only (data.js:611-682); the dialog loads the patient (data.js:843)
  const { vid } = await fastRegister(t, 'reg');
  return { rid, vid, bid };
}, { reason: DESK_NO_LINES, expect: 'lines' });

// ─── DOOR 4 — registration wizard (visit-wizard.js createVisit) ───────────────
export const WIZ_NO_DESK = 'visit-wizard.js:2678-2695 never sends desk → deskArrival false (visit-link.js:342-344) → step G puts the card in «Записан» (:546-549); «Пришёл» only after payment/work (visit-status.js arriveBy :435-451)';
const st4 = {
  S1: (t) => ({ rid: seedS1(t) }),
  S2: async (t) => seedS2(t),
  S3: (t) => ({ rid: seedS3(t) }),
  S4: () => ({ rid: null }),
};
for (const [state, seed] of Object.entries(st4)) {
  for (const pay of [false, true]) {
    const gapToday = state === 'S4' ? null
      : state === 'S1' ? (pay ? null : { reason: WIZ_NO_DESK, expect: 'came' })
      : state === 'S2' ? { reason: NOT_ON_CARD + '; ' + WIZ_NO_DESK, expect: 'came+lines' }
      : { reason: NOT_ON_CARD, expect: 'moved' };
    add(`4-today-${state}${pay ? '-pay' : ''}`, 4, state, 'reg', `wizard TODAY (timed slot)${pay ? ' + invoice + cash at the cashier' : ', no payment yet'}`, async (t) => {
      const s = await seed(t);
      const { vid } = await wizardRegister(t, 'reg', TODAY_SLOT(), { pay });
      const c = s.rid ? null : t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(PID);
      return { ...s, rid: s.rid || (c && c.id) || null, vid };
    }, gapToday);
  }
  add(`4-future-${state}`, 4, state, 'reg', 'wizard for a FUTURE day D2 (timed slot)', async (t) => {
    const s = await seed(t);
    const { vid } = await wizardRegister(t, 'reg', at(D2, 9));
    const c = s.rid ? null : t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(PID);
    return { ...s, rid: s.rid || (c && c.id) || null, vid };
  }, state === 'S2' ? { reason: NOT_ON_CARD, expect: 'lines' } : state === 'S3' ? { reason: NOT_ON_CARD, expect: 'moved' } : null);
}
add('4-today-S1p', 4, 'S1p', 'reg', 'wizard TODAY, the call card has only the phone', async (t) => {
  const rid = seedS1(t, { patient: null });
  const { vid } = await wizardRegister(t, 'reg', TODAY_SLOT());
  return { rid, vid };
}, { reason: 'step D (visit-link.js:474-484) patient_id only, no link/lines; ' + WIZ_NO_DESK, expect: 'came+lines' });

// ─── DOOR 5 — quick-patient window (quick-patient-modal.js) ──────────────────
add('5-S1p-alone', 5, 'S1p', 'reg', 'QPM creates the patient (INSERT patients + crm_link_new_patient); no visit', async (t) => {
  const rid = seedPhoneCard(t);
  const pid = await createPatient(t, 'reg');
  return { rid, pid };
});
add('5-S1p-crm-wizard', 5, 'S1p', 'reg', 'QPM opened from the CRM card (crm.js:1521 UPDATE crm_requests {patient_id}) → convert → wizard TODAY (crm.js:1340-1349)', async (t) => {
  const rid = seedPhoneCard(t);
  const pid = await createPatient(t, 'reg');
  const up = await t.dbq('reg', { table: 'crm_requests', op: 'update', values: { patient_id: pid }, filters: [{ col: 'id', op: 'eq', val: rid }] });
  if (up.status !== 200) throw new Error(up.text);
  const { vid } = await wizardRegister(t, 'reg', TODAY_SLOT(), { pid });
  return { rid, vid, pid };
}, { reason: WIZ_NO_DESK, expect: 'came' });
add('5-S4-alone', 5, 'S4', 'reg', 'QPM from the service picker / cashier — patient only', async (t) => {
  const pid = await createPatient(t, 'reg');
  const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ?').get(pid);
  return { rid: c ? c.id : null, pid };
});

// ─── DOOR 6 — «Повторный визит» (doctor) ─────────────────────────────────────
const st6 = { S1: (t) => ({ rid: seedS1(t) }), S2: async (t) => seedS2(t), S3: (t) => ({ rid: seedS3(t) }), S4: () => ({ rid: null }) };
for (const [state, seed] of Object.entries(st6)) {
  add(`6-${state}-doc`, 6, state, 'doc', 'doctor books a repeat visit for D2 (calendar_book + visit_kind + consultation line)', async (t) => {
    const s = await seed(t);
    const { vid } = await repeatVisit(t, 'doc', D2);
    const c = s.rid ? null : t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(PID);
    return { ...s, rid: s.rid || (c && c.id) || null, vid };
  }, state === 'S2' ? { reason: NOT_ON_CARD, expect: 'lines' } : state === 'S3' ? { reason: NOT_ON_CARD, expect: 'moved' } : null);
}
