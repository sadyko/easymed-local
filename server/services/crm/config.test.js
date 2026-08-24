// CRM_CONFIG_V1 — the guards, not the CRUD.
//
// Everything below is a way to lose the CRM board from a settings screen:
// save an empty array, delete the column three hundred leads live in, end up
// with two conversions or none, hide the one that registers patients, or
// point a telephony rule at a column that no longer exists. Each has a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  listStages, listSources, listRouting, crmConfig,
  saveStages, saveSources, saveRouting, saveConfig, CrmConfigError,
} from './config.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// The board as it is seeded, in the shape saveStages takes back.
const asInput = (stages) => stages.map((s) => ({ ...s }));
const lead = (db, { status = 'in_process', source = 'call', phone = '+998 90 000 00 01' } = {}) =>
  db.prepare('INSERT INTO crm_requests (full_name, phone, source, status) VALUES (?,?,?,?)')
    .run('Заявка', phone, source, status).lastInsertRowid;

// assert.throws does not hand the error back, and the STATUS is part of the
// contract here: 409 is what tells the screen «спрячьте, а не удаляйте».
function refused(fn) {
  try { fn(); } catch (e) { return e; }
  return assert.fail('ожидался отказ, но сохранение прошло');
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

test('crmConfig answers the board and the settings screen in one call', () => {
  const db = fresh();
  const cfg = crmConfig(db);
  assert.deepEqual(Object.keys(cfg).sort(), ['routing', 'sources', 'stages']);
  assert.equal(cfg.stages.length, 8);
  assert.equal(cfg.sources.length, 8);
  assert.equal(cfg.routing.length, 15);
  // is_active comes back as a boolean, not SQLite's 0/1 — the screens compare
  // it directly and the shim's JSON has no integer/boolean distinction to lean on.
  assert.equal(cfg.stages[0].is_active, true);
  assert.deepEqual(cfg.stages[0], { key: 'in_process', label: 'В обработке', color: 'info', position: 1, is_active: true, kind: 'open' });
});

test('hidden columns still come back, flagged — the screen must be able to unhide them', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next.find((s) => s.key === 'not_qualified').is_active = false;
  saveStages(db, next);
  const after = listStages(db).find((s) => s.key === 'not_qualified');
  assert.equal(after.is_active, false);
  assert.equal(listStages(db).length, 8);
});

// --------------------------------------------------------------------------
// saveStages — one array, one transaction
// --------------------------------------------------------------------------

test('saveStages renames, recolours, reorders and adds in one save', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next[0].label = 'Новые обращения';          // rename
  next[1].color = 'crit';                     // recolour
  next.splice(3, 0, { key: 'waiting_pay', label: 'Ждёт оплаты', color: 'warn', kind: 'open' });   // add
  const moved = next.splice(6, 1)[0];         // reorder
  next.push(moved);

  const out = saveStages(db, next);
  assert.deepEqual(out.map((s) => s.key), next.map((s) => s.key));
  assert.deepEqual(out.map((s) => s.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(out[0].label, 'Новые обращения');
  assert.equal(out[1].color, 'crit');
  assert.equal(out[3].key, 'waiting_pay');
  // The new column is immediately a real status — that is the whole point of
  // migration 077 dropping the CHECK.
  const id = lead(db, { status: 'waiting_pay' });
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(id).status, 'waiting_pay');
});

test('saveStages refuses an empty board', () => {
  const db = fresh();
  assert.throws(() => saveStages(db, []), CrmConfigError);
  // And nothing was touched on the way to refusing.
  assert.equal(listStages(db).length, 8);
});

test('saveStages: exactly one conversion column, never zero and never two', () => {
  const db = fresh();
  const none = asInput(listStages(db));
  none.find((s) => s.key === 'came').kind = 'open';
  assert.throws(() => saveStages(db, none), /конверси/i);

  const two = asInput(listStages(db));
  two.find((s) => s.key === 'approved').kind = 'won';
  assert.throws(() => saveStages(db, two), /конверси/i);

  assert.equal(listStages(db).filter((s) => s.kind === 'won').length, 1);
});

test('saveStages lets the conversion move to another column', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next.find((s) => s.key === 'came').kind = 'lost';
  next.find((s) => s.key === 'approved').kind = 'won';
  // The partial unique index is checked per row, so this only works because
  // saveStages clears the flag from every column before re-applying it.
  const out = saveStages(db, next);
  assert.deepEqual(out.filter((s) => s.kind === 'won').map((s) => s.key), ['approved']);
});

test('saveStages will not hide the conversion column', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next.find((s) => s.key === 'came').is_active = false;
  // Hiding it removes the only path that registers a patient card.
  assert.throws(() => saveStages(db, next), /конверси/i);
});

test('saveStages will not leave the board with nothing visible', () => {
  const db = fresh();
  const next = asInput(listStages(db)).map((s) => ({ ...s, is_active: false, kind: s.kind === 'won' ? 'open' : s.kind }));
  next[0].kind = 'won';
  assert.throws(() => saveStages(db, next), CrmConfigError);
});

test('a column with leads may be hidden but NOT deleted', () => {
  const db = fresh();
  lead(db, { status: 'no_show' });
  const without = asInput(listStages(db)).filter((s) => s.key !== 'no_show');
  const e = refused(() => saveStages(db, without));
  assert.ok(e instanceof CrmConfigError);
  assert.equal(e.status, 409);
  assert.match(e.message, /1 заявок|нельзя/);
  assert.equal(listStages(db).length, 8);

  // Hiding the same column is fine, and the lead keeps a status that still
  // resolves to a label.
  const hidden = asInput(listStages(db));
  hidden.find((s) => s.key === 'no_show').is_active = false;
  saveStages(db, hidden);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status='no_show'").get().n, 1);
});

test('an empty column can be deleted', () => {
  const db = fresh();
  const without = asInput(listStages(db)).filter((s) => s.key !== 'not_qualified');
  const out = saveStages(db, without);
  assert.equal(out.length, 7);
  assert.equal(out.some((s) => s.key === 'not_qualified'), false);
});

test('the column the schema DEFAULTs to cannot be deleted, even when empty', () => {
  const db = fresh();
  const without = asInput(listStages(db)).filter((s) => s.key !== 'in_process');
  // crm_requests.status DEFAULT 'in_process' is written by /api/db whenever a
  // screen omits the field; a DEFAULT pointing nowhere breaks every such INSERT.
  const e = refused(() => saveStages(db, without));
  assert.ok(e instanceof CrmConfigError);
  assert.equal(e.status, 409);
  // Proof of what the guard is protecting: the DEFAULT still resolves.
  db.prepare("INSERT INTO crm_requests (full_name) VALUES ('Без статуса')").run();
});

test('saveStages validates keys, labels, colours and kinds', () => {
  const db = fresh();
  const base = () => asInput(listStages(db));
  const withFirst = (patch) => { const n = base(); Object.assign(n[0], patch); return n; };

  assert.throws(() => saveStages(db, withFirst({ key: 'В обработке' })), /Недопустимый код/);
  assert.throws(() => saveStages(db, withFirst({ key: 'a'.repeat(33) })), /Недопустимый код/);
  assert.throws(() => saveStages(db, withFirst({ key: '' })), /Недопустимый код/);
  assert.throws(() => saveStages(db, withFirst({ label: '   ' })), /название/);
  assert.throws(() => saveStages(db, withFirst({ color: '#ff0000' })), /цвет/i);
  assert.throws(() => saveStages(db, withFirst({ kind: 'maybe' })), /тип колонки/);

  const dup = base(); dup[1].key = dup[0].key;
  assert.throws(() => saveStages(db, dup), /повторяется/);
});

test('a typed key is folded to lower case, and folding cannot merge two columns', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  // «Waiting_Pay» and «waiting_pay» are one column in the owner's head, so a
  // capital letter is folded rather than refused.
  next.push({ key: '  Waiting_Pay ', label: 'Ждёт оплаты', color: 'warn', kind: 'open' });
  assert.equal(saveStages(db, next).some((s) => s.key === 'waiting_pay'), true);

  // Folding must never quietly MERGE two columns: the duplicate check runs
  // after it, so two entries differing only in case are refused.
  const collide = asInput(listStages(db));
  collide.push({ key: 'WAITING_PAY', label: 'Дубль', color: '', kind: 'open' });
  assert.throws(() => saveStages(db, collide), /повторяется/);

  // Anything that is not merely wrong-cased is still refused outright.
  const bad = asInput(listStages(db));
  bad.push({ key: 'ждёт оплаты', label: 'Кириллица', color: '', kind: 'open' });
  assert.throws(() => saveStages(db, bad), /Недопустимый код/);
});

test('the plan\'s «none» colour is accepted as the empty token the board draws', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next[0].color = 'none';
  assert.equal(saveStages(db, next)[0].color, '');
});

test('deleting a column switches the telephony rules that fed it off', () => {
  const db = fresh();
  saveRouting(db, [{ disposition: 'ANSWER', action: 'create', stage_key: 'scheduled' }]);
  const without = asInput(listStages(db)).filter((s) => s.key !== 'scheduled');
  saveStages(db, without);
  const rule = listRouting(db).find((r) => r.disposition === 'ANSWER');
  // Not a foreign-key error and not a rule aiming at nothing: the rule
  // survives, visibly disabled, on the routing card.
  assert.deepEqual(rule, { provider: 'binotel', disposition: 'ANSWER', action: 'ignore', stage_key: null });
});

test('hiding a column switches its telephony rules off too', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next.find((s) => s.key === 'recall').is_active = false;
  saveStages(db, next);
  for (const d of ['NOANSWER', 'BUSY', 'CANCEL']) {
    const rule = listRouting(db).find((r) => r.disposition === d);
    // A lead created into a column nobody can see reads exactly like a lost lead.
    assert.deepEqual(rule, { provider: 'binotel', disposition: d, action: 'ignore', stage_key: null });
  }
});

// --------------------------------------------------------------------------
// saveSources
// --------------------------------------------------------------------------

test('saveSources renames, reorders, adds and hides', () => {
  const db = fresh();
  const next = asInput(listSources(db));
  next[0].label = 'Входящий звонок';
  next.push({ key: 'billboard', label: 'Билборд' });
  next.find((s) => s.key === 'other').is_active = false;
  const out = saveSources(db, next);
  assert.equal(out[0].label, 'Входящий звонок');
  assert.equal(out.find((s) => s.key === 'billboard').is_active, true);
  assert.equal(out.find((s) => s.key === 'other').is_active, false);
  assert.deepEqual(out.map((s) => s.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a source with leads may be hidden but NOT deleted', () => {
  const db = fresh();
  lead(db, { source: 'instagram' });
  const without = asInput(listSources(db)).filter((s) => s.key !== 'instagram');
  const e = refused(() => saveSources(db, without));
  assert.ok(e instanceof CrmConfigError);
  assert.equal(e.status, 409);
  assert.equal(listSources(db).length, 8);
});

test('«call» and «telephony» cannot be deleted — code names them', () => {
  const db = fresh();
  for (const key of ['call', 'telephony']) {
    const without = asInput(listSources(db)).filter((s) => s.key !== key);
    const e = refused(() => saveSources(db, without));
    assert.ok(e instanceof CrmConfigError);
    assert.equal(e.status, 409);
  }
  // What the guard protects: the column DEFAULT still resolves, and the
  // telephony writer still has a source to file under.
  db.prepare("INSERT INTO crm_requests (full_name) VALUES ('Без источника')").run();
  db.prepare("INSERT INTO crm_requests (full_name, source) VALUES ('Из звонка','telephony')").run();
});

test('saveSources refuses an empty list and an all-hidden list', () => {
  const db = fresh();
  assert.throws(() => saveSources(db, []), CrmConfigError);
  const allHidden = asInput(listSources(db)).map((s) => ({ ...s, is_active: false }));
  assert.throws(() => saveSources(db, allHidden), CrmConfigError);
});

// --------------------------------------------------------------------------
// saveRouting
// --------------------------------------------------------------------------

test('saveRouting upserts and leaves untouched dispositions alone', () => {
  const db = fresh();
  const before = listRouting(db).length;
  saveRouting(db, [{ disposition: 'NOANSWER', action: 'create', stage_key: 'scheduled' }]);
  const after = listRouting(db);
  // Upsert only, deliberately: an older screen posting a shorter list must not
  // wipe a rule someone configured for a disposition it does not know about.
  assert.equal(after.length, before);
  assert.equal(after.find((r) => r.disposition === 'NOANSWER').stage_key, 'scheduled');
  assert.equal(after.find((r) => r.disposition === 'BUSY').stage_key, 'recall');
});

test('saveRouting adds a disposition the vendor invented later', () => {
  const db = fresh();
  saveRouting(db, [{ disposition: 'callback-queued', action: 'create', stage_key: 'recall' }]);
  const row = listRouting(db).find((r) => r.disposition === 'CALLBACK-QUEUED');
  // Upper-cased on the way in: calls.disposition stores Binotel's own
  // spelling, and a rule keyed differently would silently never fire.
  assert.deepEqual(row, { provider: 'binotel', disposition: 'CALLBACK-QUEUED', action: 'create', stage_key: 'recall' });
});

test('an «ignore» rule forgets its column', () => {
  const db = fresh();
  saveRouting(db, [{ disposition: 'ANSWER', action: 'ignore', stage_key: 'in_process' }]);
  assert.equal(listRouting(db).find((r) => r.disposition === 'ANSWER').stage_key, null);
});

test('saveRouting refuses a rule that names no column, a missing column, or a hidden one', () => {
  const db = fresh();
  assert.throws(() => saveRouting(db, [{ disposition: 'ANSWER', action: 'create' }]), /Недопустимый код|не существует/);
  assert.throws(() => saveRouting(db, [{ disposition: 'ANSWER', action: 'create', stage_key: 'no_such' }]), /не существует/);
  assert.throws(() => saveRouting(db, [{ disposition: '', action: 'ignore' }]), /статус звонка/i);
  assert.throws(() => saveRouting(db, [{ disposition: 'ANSWER', action: 'maybe' }]), /действие/i);
  assert.throws(() => saveRouting(db, [
    { disposition: 'ANSWER', action: 'ignore' }, { disposition: 'answer', action: 'create', stage_key: 'recall' },
  ]), /дважды/);

  const next = asInput(listStages(db));
  next.find((s) => s.key === 'scheduled').is_active = false;
  saveStages(db, next);
  assert.throws(() => saveRouting(db, [{ disposition: 'ANSWER', action: 'create', stage_key: 'scheduled' }]), /скрыта/);
});

// --------------------------------------------------------------------------
// saveConfig — the whole screen at once
// --------------------------------------------------------------------------

test('saveConfig applies all three lists and answers with the full config', () => {
  const db = fresh();
  const stages = asInput(listStages(db));
  stages.push({ key: 'waiting_pay', label: 'Ждёт оплаты', color: 'warn', kind: 'open' });
  const out = saveConfig(db, {
    stages,
    sources: [...asInput(listSources(db)), { key: 'billboard', label: 'Билборд' }],
    // Stages are saved first on purpose, so a rule may point at a column
    // created in the very same request.
    routing: [{ disposition: 'ANSWER', action: 'create', stage_key: 'waiting_pay' }],
  });
  assert.equal(out.stages.length, 9);
  assert.equal(out.sources.length, 9);
  assert.equal(out.routing.find((r) => r.disposition === 'ANSWER').stage_key, 'waiting_pay');
});

test('saveConfig is one transaction: a bad source list rolls the columns back too', () => {
  const db = fresh();
  const stages = asInput(listStages(db));
  stages[0].label = 'Переименовано';
  assert.throws(() => saveConfig(db, { stages, sources: [] }), CrmConfigError);
  assert.equal(listStages(db)[0].label, 'В обработке');
});

test('saveConfig with nothing to save changes nothing', () => {
  const db = fresh();
  const before = crmConfig(db);
  assert.deepEqual(saveConfig(db, {}), before);
});

test('saveConfig reports routing turned off by a column that was hidden in the same save', () => {
  const db = fresh();
  const stages = asInput(listStages(db));
  stages.find((s) => s.key === 'recall').is_active = false;
  const out = saveConfig(db, { stages });
  // The answer is the FULL config, not just the list that was posted —
  // otherwise the routing card on screen would still show «Перезвонить».
  assert.equal(out.routing.find((r) => r.disposition === 'NOANSWER').action, 'ignore');
});
