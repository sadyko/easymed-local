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
  openStageKeys, wonStageKey, lostStageKeys, noShowStageKey, scheduledStageKey,
  readCrmSettings,   // CRM_UNIFY_V1
  confirmedStageKey,   // CRM_STAGE_ROLES_V1
  apiSourceUse, ensureApiSource, renameApiSource, archiveApiSource,   // CLINIC_API_STEP7_V1
} from './config.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';   // CLINIC_API_STEP7_V1
import { firstStageKey } from './contact-window.js';   // CRM_NO_SHOW_ANY_COLUMN_V1

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
  // CRM_HEAD_MERGE_TAGS_V1 — и метки карточек (миграция 150); у свежей базы их нет.
  // CRM_UNIFY_V1 — ОБНОВЛЕНО НАМЕРЕННО: и настройки «CRM-канбан» (crm_settings, мигр. 237).
  assert.deepEqual(Object.keys(cfg).sort(), ['routing', 'settings', 'sources', 'stages', 'tags']);
  // CRM_STAGE_ROLES_V1 — ОБНОВЛЕНО НАМЕРЕННО: booked_stage — колонка с ролью «запись», не выбор crm_settings.
  assert.deepEqual(cfg.settings, { booked_stage: 'scheduled', window_hours: 72, booked_effective: 'scheduled' });
  assert.deepEqual(cfg.tags, []);
  assert.equal(cfg.stages.length, 8);
  assert.equal(cfg.sources.length, 8);
  assert.equal(cfg.routing.length, 15);
  // is_active comes back as a boolean, not SQLite's 0/1 — the screens compare
  // it directly and the shim's JSON has no integer/boolean distinction to lean on.
  assert.equal(cfg.stages[0].is_active, true);
  assert.deepEqual(cfg.stages[0], { key: 'in_process', label: 'В обработке', color: 'info', position: 1, is_active: true, kind: 'open', role: null });   // CRM_STAGE_ROLES_V1 — и роль
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

// CRM_UNIFY_V1 — ПЕРЕПИСАНО НАМЕРЕННО (ревью задачи 4, R5): saveStages больше
// НЕ меняет вид существующих колонок. Конверсию двигают только настройки
// «Колонка конверсии» (saveCrmSettings) — с переносом карточек и журналом.
// Раньше устаревшая вкладка «Колонки» молча откатывала перенос, а собранный
// руками запрос делал «Не пришёл» конверсией. Присланный kind существующей
// колонки игнорируется; новая колонка всегда открытая.
test('saveStages: присланный kind существующих колонок игнорируется — конверсия всегда ровно одна', () => {
  const db = fresh();
  const none = asInput(listStages(db));
  none.find((s) => s.key === 'came').kind = 'open';
  saveStages(db, none);
  assert.deepEqual(listStages(db).filter((s) => s.kind === 'won').map((s) => s.key), ['came']);

  const two = asInput(listStages(db));
  two.find((s) => s.key === 'approved').kind = 'won';
  saveStages(db, two);
  assert.deepEqual(listStages(db).filter((s) => s.kind === 'won').map((s) => s.key), ['came']);

  const lostToOpen = asInput(listStages(db));
  lostToOpen.find((s) => s.key === 'no_show').kind = 'open';
  saveStages(db, lostToOpen);
  assert.equal(listStages(db).find((s) => s.key === 'no_show').kind, 'lost', 'проигрышная колонка стала живой');
});

test('saveStages не переносит конверсию: собранный запрос «Подтверждён = won, Пришёл = lost» ничего не меняет', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next.find((s) => s.key === 'came').kind = 'lost';
  next.find((s) => s.key === 'approved').kind = 'won';
  const out = saveStages(db, next);
  assert.deepEqual(out.filter((s) => s.kind === 'won').map((s) => s.key), ['came']);
  assert.equal(out.find((s) => s.key === 'approved').kind, 'open');
});

test('saveStages: новая колонка всегда открытая, какой бы kind ни прислали', () => {
  const db = fresh();
  const next = asInput(listStages(db));
  next.push({ key: 'paid', label: 'Оплатил', color: '', kind: 'won' });
  next.push({ key: 'gone', label: 'Ушёл', color: '', kind: 'lost' });
  const out = saveStages(db, next);
  assert.equal(out.find((s) => s.key === 'paid').kind, 'open');
  assert.equal(out.find((s) => s.key === 'gone').kind, 'open');
  assert.deepEqual(out.filter((s) => s.kind === 'won').map((s) => s.key), ['came']);
});

test('saveStages: колонку конверсии нельзя удалить, даже пустую', () => {
  const db = fresh();
  const without = asInput(listStages(db)).filter((s) => s.key !== 'came');
  assert.throws(() => saveStages(db, without), /Колонку конверсии нельзя удалить/);
  assert.deepEqual(listStages(db).filter((s) => s.kind === 'won').map((s) => s.key), ['came']);
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
  // CRM_STAGE_ROLES_V1 — «Обработка остановлена», а не «Не пришёл»: у той роль, и её скрытие — другой отказ.
  lead(db, { status: 'stopped' });
  const without = asInput(listStages(db)).filter((s) => s.key !== 'stopped');
  const e = refused(() => saveStages(db, without));
  assert.ok(e instanceof CrmConfigError);
  assert.equal(e.status, 409);
  assert.match(e.message, /1 заявок|нельзя/);
  assert.equal(listStages(db).length, 8);

  // Hiding the same column is fine, and the lead keeps a status that still
  // resolves to a label.
  const hidden = asInput(listStages(db));
  hidden.find((s) => s.key === 'stopped').is_active = false;
  saveStages(db, hidden);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status='stopped'").get().n, 1);
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
  // CRM_STAGE_ROLES_V1 — «Перезвонить»: у «Записан» роль, её удаление — другой отказ.
  saveRouting(db, [{ disposition: 'ANSWER', action: 'create', stage_key: 'recall' }]);
  const without = asInput(listStages(db)).filter((s) => s.key !== 'recall');
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
  next.find((s) => s.key === 'recall').is_active = false;   // CRM_STAGE_ROLES_V1 — колонка без роли
  saveStages(db, next);
  assert.throws(() => saveRouting(db, [{ disposition: 'ANSWER', action: 'create', stage_key: 'recall' }]), /скрыта/);
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

// --------------------------------------------------------------------------
// CRM_LINKS_V1 — ключи ступеней для тех, кто работает с воронкой, а не рисует её
// --------------------------------------------------------------------------
//
// «Переименовать "Пришёл" в "Дошёл" можно; сделать две конверсии — нет»
// (шапка миграции 077). Значит код, которому нужен ключ конверсии или список
// живых ступеней, обязан СПРОСИТЬ его, а не носить копию сидового списка.

test('openStageKeys / wonStageKey / lostStageKeys читают настроенную воронку', () => {
  const db = fresh();
  assert.deepEqual(openStageKeys(db), ['in_process', 'recall', 'scheduled', 'approved']);
  assert.equal(wonStageKey(db), 'came');
  assert.deepEqual(lostStageKeys(db), ['no_show', 'stopped', 'not_qualified']);
  assert.equal(noShowStageKey(db), 'no_show');

  // Клиника завела свою колонку — она живая, и код обязан её увидеть.
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('waiting_pay','Ждёт оплаты','info',9,1,'open')").run();
  assert.ok(openStageKeys(db).includes('waiting_pay'), 'добавленная колонка не попала в список живых ступеней');
});

test('скрытая колонка остаётся ступенью: в ней лежат заявки', () => {
  const db = fresh();
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'recall'").run();
  assert.ok(openStageKeys(db).includes('recall'),
    'спрятанная колонка выпала из живых ступеней — лежащие в ней заявки перестали закрываться визитом');
});

// CRM_STAGE_ROLES_V1 (3.23.0) — ПЕРЕПИСАНО НАМЕРЕННО. «Не пришёл», «Колонка записи» и
// «Колонка подтверждения» больше не угадываются (сидовый ключ, первая проигрышная, «Записан»,
// последняя открытая видимая до конверсии, выбор crm_settings.booked_stage, первая после
// записи) — это роли колонок (crm_stages.role, миграция 284). Владелец: «we need to add a
// booking tick (like conversion) so the system won't break». Прежние тесты догадки — в
// 284.test.js: миграция заполнила роли ровно ею.
const rolesOf = (db) => Object.fromEntries(listStages(db).filter((s) => s.role).map((s) => [s.role, s.key]));
/** Сохранить колонки как есть, с ролями из карты { key: role|null } поверх нынешних. */
const withRoles = (db, map, edit = (s) => s) => asInput(listStages(db))
  .map((s) => (Object.prototype.hasOwnProperty.call(map, s.key) ? { ...s, role: map[s.key] } : s)).map(edit);

test('роли колонок: сидовая воронка — «Записан», «Подтверждён», «Не пришёл»; роль едет в ответе', () => {
  const db = fresh();
  assert.deepEqual(rolesOf(db), { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' });
  assert.equal(scheduledStageKey(db), 'scheduled');
  assert.equal(confirmedStageKey(db), 'approved');
  assert.equal(noShowStageKey(db), 'no_show');
  db.close();
});

test('роли читаются по отметке, не по названию, ключу или порядку', () => {
  const db = fresh();
  saveStages(db, withRoles(db, {}, (s) => ({ ...s, label: s.key === 'recall' ? 'Записан' : s.label + ' (х)' }))
    .sort((a, b) => (a.key === 'approved' ? -1 : b.key === 'approved' ? 1 : 0)).map((s) => (s.key === 'approved' ? { ...s, role: null } : s)));
  assert.equal(scheduledStageKey(db), 'scheduled', 'переименование или порядок сдвинули колонку записи');
  assert.equal(confirmedStageKey(db), null, 'подтверждение снято');
  saveStages(db, withRoles(db, { recall: 'booked', scheduled: null }));
  assert.equal(scheduledStageKey(db), 'recall');
  db.close();
});

test('«Не пришёл» — только роль: без неё автоматика выключена; ключ no_show ничего не значит', () => {
  const db = fresh();
  saveStages(db, withRoles(db, { no_show: null }));
  assert.equal(noShowStageKey(db), null, 'без роли «Не пришёл» — колонки нет (первая проигрышная больше не угадывается)');
  saveStages(db, withRoles(db, { stopped: 'no_show' }));
  assert.equal(noShowStageKey(db), 'stopped');
  // CRM_NO_SHOW_ANY_COLUMN_V1 — ПЕРЕПИСАНО НАМЕРЕННО: роль на открытой колонке действует;
  // ручная правка базы мимо экрана — роль на конверсии — нет.
  db.prepare("UPDATE crm_stages SET role = NULL WHERE role = 'no_show'").run();
  db.prepare("UPDATE crm_stages SET role = 'no_show' WHERE key = 'recall'").run();
  assert.equal(noShowStageKey(db), 'recall');
  db.prepare("UPDATE crm_stages SET role = NULL WHERE role = 'no_show'").run();
  db.prepare("UPDATE crm_stages SET role = 'no_show' WHERE key = 'came'").run();
  assert.equal(noShowStageKey(db), null, 'роль «не пришёл» на конверсии не действует');
  db.close();
});

// CRM_NO_SHOW_ANY_COLUMN_V1 (3.23.0) — владелец: «we also need to add the "unarrived" status tick».
// Роль «не пришёл» ставится на любую видимую колонку, кроме конверсии. Колонка с этой ролью для
// автоматики — колонка «Не пришёл», какого бы вида она ни была: среди живых (openStageKeys) её нет,
// среди потерянных (lostStageKeys) она есть, начало воронки (firstStageKey) — не она. Иначе
// обход наутро считал бы её карточки ждущими приёма, а возврат в начало воронки уносил бы
// карточку в «Не пришёл».
test('CRM_NO_SHOW_ANY_COLUMN_V1: «не пришёл» на открытой колонке — сохраняется; для автоматики она «Не пришёл», а не живая', () => {
  const db = fresh();
  saveStages(db, withRoles(db, { recall: 'no_show', no_show: null }));
  assert.deepEqual(rolesOf(db), { booked: 'scheduled', confirmed: 'approved', no_show: 'recall' });
  assert.equal(noShowStageKey(db), 'recall');
  assert.equal(listStages(db).find((s) => s.key === 'recall').kind, 'open', 'вид колонки не меняется');
  assert.deepEqual(openStageKeys(db), ['in_process', 'scheduled', 'approved'], 'колонка «Не пришёл» осталась среди ждущих');
  assert.deepEqual(lostStageKeys(db), ['no_show', 'stopped', 'not_qualified', 'recall'], 'колонка «Не пришёл» выпала из потерянных');
  // Первая открытая колонка с ролью «не пришёл» — не начало воронки.
  saveStages(db, withRoles(db, { in_process: 'no_show', recall: null }));
  assert.equal(noShowStageKey(db), 'in_process');
  assert.equal(firstStageKey(db), 'recall', 'возврат в начало воронки унёс бы карточку в «Не пришёл»');
  assert.deepEqual(openStageKeys(db), ['recall', 'scheduled', 'approved']);
  // Роль у проигрышной — как прежде.
  saveStages(db, withRoles(db, { in_process: null, no_show: 'no_show' }));
  assert.deepEqual(openStageKeys(db), ['in_process', 'recall', 'scheduled', 'approved']);
  assert.deepEqual(lostStageKeys(db), ['no_show', 'stopped', 'not_qualified']);
  assert.equal(firstStageKey(db), 'in_process');
  db.close();
});

test('crm_settings.booked_stage больше не читается', () => {
  const db = fresh();
  db.prepare("UPDATE crm_settings SET booked_stage = 'recall' WHERE id = 1").run();
  assert.equal(scheduledStageKey(db), 'scheduled');
  assert.equal(crmConfig(db).settings.booked_stage, 'scheduled', 'ответ называет колонку с ролью');
  db.close();
});

test('сохранение колонок: роли едут вместе с колонками; без поля role (экран старше сервера) — не трогаются', () => {
  const db = fresh();
  const old = asInput(listStages(db)).map(({ role, ...s }) => s);
  saveStages(db, old.map((s) => (s.key === 'recall' ? { ...s, label: 'Перезвон' } : s)));
  assert.deepEqual(rolesOf(db), { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' });
  saveStages(db, withRoles(db, { recall: 'booked', scheduled: 'confirmed', approved: null, stopped: 'no_show', no_show: null }));
  assert.deepEqual(rolesOf(db), { booked: 'recall', confirmed: 'scheduled', no_show: 'stopped' });
  db.close();
});

test('сохранение колонок: отказы ролей — 409 понятной фразой; ничего не записано', () => {
  const db = fresh();
  const before = JSON.stringify(listStages(db));
  const cases = [
    [withRoles(db, { stopped: 'booked', scheduled: null }), 'Колонка записи должна быть открытой видимой колонкой перед колонкой-конверсией.'],
    [withRoles(db, {}, (s) => (s.key === 'scheduled' ? { ...s, is_active: true } : s)).map((s) => (s.key === 'recall' ? { ...s, is_active: false, role: 'booked' } : (s.key === 'scheduled' ? { ...s, role: null } : s))),
      'Колонка записи должна быть открытой видимой колонкой перед колонкой-конверсией.'],
    [withRoles(db, {}).map((s) => (s.key === 'scheduled' ? { ...s, position: 99 } : s)).sort((a, b) => a.position - b.position)
      .map((s, i) => ({ ...s, position: i + 1 })), 'Колонка записи должна быть открытой видимой колонкой перед колонкой-конверсией.'],
    [withRoles(db, { recall: 'confirmed', approved: null }), 'Колонка подтверждения должна быть открытой видимой колонкой после колонки записи и перед колонкой-конверсией.'],
    [withRoles(db, { scheduled: null }), 'Колонка подтверждения должна быть открытой видимой колонкой после колонки записи и перед колонкой-конверсией.'],
    // CRM_NO_SHOW_ANY_COLUMN_V1 — открытая колонка теперь допустима; скрытая — нет (новая фраза).
    [withRoles(db, { recall: 'no_show', no_show: null }, (s) => (s.key === 'recall' ? { ...s, is_active: false } : s)),
      'Колонкой «Не пришёл» может быть любая видимая колонка, кроме колонки-конверсии.'],
    [withRoles(db, { stopped: 'no_show', no_show: null }, (s) => (s.key === 'stopped' ? { ...s, is_active: false } : s)),
      'Колонкой «Не пришёл» может быть любая видимая колонка, кроме колонки-конверсии.'],
  ];
  for (const [stages, msg] of cases) {
    const e = refused(() => saveStages(db, stages));
    assert.ok(e instanceof CrmConfigError);
    assert.equal(e.status, 409, msg);
    assert.equal(e.message, msg);
  }
  const twice = refused(() => saveStages(db, withRoles(db, { recall: 'booked' })));
  assert.equal(twice.status, 409);
  assert.equal(twice.message, 'Каждую роль можно отметить только у одной колонки.');
  const bad = refused(() => saveStages(db, withRoles(db, { recall: 'boss' })));
  assert.equal(bad.status, 400);
  assert.equal(bad.message, 'Неизвестная роль у колонки «recall».');
  assert.equal(JSON.stringify(listStages(db)), before, 'отказ что-то записал');
  db.close();
});

test('роль на колонке конверсии отбрасывается, как и присланный вид (устаревшая вкладка)', () => {
  const db = fresh();
  saveStages(db, withRoles(db, { came: 'confirmed', approved: null }));
  assert.equal(listStages(db).find((s) => s.key === 'came').role, null);
  assert.equal(confirmedStageKey(db), null);
  db.close();
});

test('колонку с ролью нельзя скрыть или удалить, пока роль не передана: «сначала передайте роль другой колонке»', () => {
  const db = fresh();
  const cases = [
    [withRoles(db, {}, (s) => (s.key === 'scheduled' ? { ...s, is_active: false } : s)), 'Колонка «Записан» — колонка записи: сначала передайте роль другой колонке.',
      'Колонка «{label}» — колонка записи: сначала передайте роль другой колонке.'],
    // Ревью: удаление с ролями в правке снимает роль (см. ниже); удаление экраном без ролей — отказ.
    [asInput(listStages(db)).map(({ role, ...s }) => s).filter((s) => s.key !== 'approved'), 'Колонка «Подтверждён» — колонка подтверждения: сначала передайте роль другой колонке.',
      'Колонка «{label}» — колонка подтверждения: сначала передайте роль другой колонке.'],
    [withRoles(db, {}, (s) => (s.key === 'no_show' ? { ...s, is_active: false } : s)), 'Колонка «Не пришёл» — колонка «Не пришёл»: сначала передайте роль другой колонке.',
      'Колонка «{label}» — колонка «Не пришёл»: сначала передайте роль другой колонке.'],
    // Экран старше сервера (без поля role) удаляет колонку записи — тот же отказ.
    [asInput(listStages(db)).map(({ role, ...s }) => s).filter((s) => s.key !== 'scheduled'), 'Колонка «Записан» — колонка записи: сначала передайте роль другой колонке.',
      'Колонка «{label}» — колонка записи: сначала передайте роль другой колонке.'],
  ];
  for (const [stages, msg, template] of cases) {
    const e = refused(() => saveStages(db, stages));
    assert.equal(e.status, 409, msg);
    assert.equal(e.message, msg);
    assert.equal(e.template, template);
  }
  // Роль передана в той же правке — удалить можно; снята — скрыть можно.
  saveStages(db, withRoles(db, { recall: 'booked', scheduled: null, approved: null }).filter((s) => s.key !== 'scheduled'));
  assert.deepEqual(rolesOf(db), { booked: 'recall', no_show: 'no_show' });
  saveStages(db, withRoles(db, { no_show: null }, (s) => (s.key === 'no_show' ? { ...s, is_active: false } : s)));
  assert.equal(noShowStageKey(db), null);
  db.close();
});

test('скрытая «Не пришёл» с ролью (так её оставила миграция 284) не мешает сохранять колонки', () => {
  const db = fresh();
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'no_show'").run();
  saveStages(db, withRoles(db, {}, (s) => (s.key === 'recall' ? { ...s, label: 'Перезвон' } : s)));
  assert.equal(noShowStageKey(db), 'no_show');
  db.close();
});

test('настройки (экран старше сервера): booked_stage передаёт роль «запись»; пусто — ничего не меняет', () => {
  const db = fresh();
  saveConfig(db, { settings: { booked_stage: 'recall' } });
  assert.equal(scheduledStageKey(db), 'recall');
  assert.equal(crmConfig(db).settings.booked_stage, 'recall');
  assert.equal(crmConfig(db).settings.booked_effective, 'recall');
  for (const key of ['came', 'nope']) {
    const e = refused(() => saveConfig(db, { settings: { booked_stage: key } }));
    assert.equal(e.status, 409, key);
    assert.match(e.message, /Колонка записи/);
  }
  // Ревью: колонка с другой ролью (подтверждение, «Не пришёл») — отказ: роль не снимается молча.
  for (const [key, msg] of [['approved', 'Колонка «Подтверждён» — колонка подтверждения: сначала передайте роль другой колонке.'],
    ['no_show', 'Колонка «Не пришёл» — колонка «Не пришёл»: сначала передайте роль другой колонке.']]) {
    const e = refused(() => saveConfig(db, { settings: { booked_stage: key } }));
    assert.equal(e.status, 409, key);
    assert.equal(e.message, msg);
  }
  assert.equal(confirmedStageKey(db), 'approved');
  saveConfig(db, { settings: { booked_stage: null } });
  assert.equal(scheduledStageKey(db), 'recall', 'пустой выбор снял роль');
  assert.equal(db.prepare('SELECT booked_stage FROM crm_settings').get().booked_stage, null, 'старая настройка снова пишется');
  db.close();
});

test('окно повторного обращения: целое 1..720, по умолчанию 72', () => {
  const db = fresh();
  assert.equal(readCrmSettings(db).window_hours, 72);
  saveConfig(db, { settings: { window_hours: 48 } });
  assert.equal(readCrmSettings(db).window_hours, 48);
  for (const bad of [0, 721, 1.5, 'abc']) assert.throws(() => saveConfig(db, { settings: { window_hours: bad } }), /Окно повторного обращения/);
  db.close();
});

test('настройки помнят, кто и когда их менял', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'adm', 'x', 'admin')").run();
  saveConfig(db, { settings: { booked_stage: 'recall' } }, { actorId: 1 });
  const row = db.prepare('SELECT changed_by, changed_at FROM crm_settings WHERE id = 1').get();
  assert.equal(row.changed_by, 1);
  assert.match(String(row.changed_at), /^\d{4}-\d{2}-\d{2}T/);
  db.close();
});

// --------------------------------------------------------------------------
// CRM_UNIFY_V1 — «КОЛОНКА КОНВЕРСИИ (ПРИШЁЛ)» (дополнение владельца 2026-10-09)
// --------------------------------------------------------------------------
// Выбор переносит вид won на выбранную колонку одной транзакцией; прежняя
// конверсия становится открытой. Новой таблицы для выбора нет: всё, что ищет
// конверсию, читает вид won (wonStageKey).
//
// CRM_UNIFY_V1 — ПЕРЕПИСАНО НАМЕРЕННО (ревью задачи 4, решение контролёра):
// «карточки не двигаются» оживляло всю историю конверсий в ставшей открытой
// колонке. Теперь новая колонка обязана быть пустой, а карточки прежней
// конверсии идут за ролью — с тем же updated_at, с записью в журнал.
const wonKeys = (db) => db.prepare("SELECT key FROM crm_stages WHERE kind = 'won'").all().map((r) => r.key);
const row = (db, id) => db.prepare('SELECT status, updated_at FROM crm_requests WHERE id = ?').get(id);

test('конверсия: перенос won одной транзакцией — ровно одна won; карточки конверсии идут за ней с прежним updated_at', () => {
  const db = fresh();
  const inCame = lead(db, { status: 'came' });
  db.prepare("UPDATE crm_requests SET updated_at = '2025-05-01T10:00:00Z' WHERE id = ?").run(inCame);
  const inRecall = lead(db, { status: 'recall' });
  const recallBefore = row(db, inRecall);
  saveStages(db, withRoles(db, { approved: null }));   // CRM_STAGE_ROLES_V1 — роль подтверждения сначала снята (решение координатора)
  const out = saveConfig(db, { settings: { won_stage: 'approved' } });
  assert.deepEqual(wonKeys(db), ['approved']);
  assert.equal(wonStageKey(db), 'approved');
  assert.equal(listStages(db).find((s) => s.key === 'came').kind, 'open', 'прежняя конверсия — открытая колонка');
  assert.equal(out.stages.find((s) => s.key === 'approved').kind, 'won', 'ответ сохранения — уже новая воронка');
  assert.deepEqual(row(db, inCame), { status: 'approved', updated_at: '2025-05-01T10:00:00Z' },
    'конвертированная карточка не пошла за конверсией или «ожила»');
  assert.deepEqual(row(db, inRecall), recallBefore, 'перенос тронул живую карточку');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status = 'came'").get().n, 0);
  assert.deepEqual(db.prepare('SELECT moved_by, from_stage, to_stage, cards_moved FROM crm_conversion_log').all(),
    [{ moved_by: null, from_stage: 'came', to_stage: 'approved', cards_moved: 1 }]);
  // CRM_STAGE_ROLES_V1 — колонка записи — своя роль, конверсия её не трогает.
  assert.equal(scheduledStageKey(db), 'scheduled');
  db.close();
});

test('конверсия: колонка с карточками — отказ 409 с числом; ничего не сдвинуто', () => {
  const db = fresh();
  const live = lead(db, { status: 'approved' });
  lead(db, { status: 'approved' });
  lead(db, { status: 'came' });
  saveStages(db, withRoles(db, { approved: null }));   // CRM_STAGE_ROLES_V1
  const e = refused(() => saveConfig(db, { settings: { won_stage: 'approved' } }));
  assert.ok(e instanceof CrmConfigError);
  assert.equal(e.status, 409);
  assert.equal(e.message, 'В колонке «Подтверждён» карточек: 2 — сначала перенесите их в другие колонки.');
  assert.equal(e.template, 'В колонке «{label}» карточек: {n} — сначала перенесите их в другие колонки.');
  assert.deepEqual(e.params, { label: 'Подтверждён', n: 2 });
  assert.deepEqual(wonKeys(db), ['came']);
  assert.equal(row(db, live).status, 'approved', 'открытая карточка стала ложной конверсией');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status = 'came'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_conversion_log').get().n, 0);
  db.close();
});

test('конверсия: правила звонков, кормившие новую колонку конверсии, выключаются — звонок не рождает конверсию', () => {
  const db = fresh();
  // CRM_STAGE_ROLES_V1 — ОБНОВЛЕНО: «Перезвонить» стоит перед колонкой записи и конверсией
  // стать не может (запись оказалась бы после конверсии) — берётся «Подтверждён».
  saveRouting(db, [{ disposition: 'NOANSWER', action: 'create', stage_key: 'approved' }]);
  saveStages(db, withRoles(db, { approved: null }));   // CRM_STAGE_ROLES_V1 — роль подтверждения сначала снята
  saveConfig(db, { settings: { won_stage: 'approved' } });
  assert.deepEqual(wonKeys(db), ['approved']);
  const r = listRouting(db).find((x) => x.disposition === 'NOANSWER');
  assert.deepEqual([r.action, r.stage_key], ['ignore', null]);
  db.close();
});

test('конверсия: ровно одна won после любой цепочки переносов, отказов и сохранений колонок', () => {
  const db = fresh();
  const one = () => assert.equal(wonKeys(db).length, 1);
  lead(db, { status: 'came' });
  saveStages(db, withRoles(db, { approved: null }));   // CRM_STAGE_ROLES_V1 — роль подтверждения сначала снята
  saveConfig(db, { settings: { won_stage: 'approved' } }); one();
  saveStages(db, asInput(listStages(db)).map((s) => ({ ...s, kind: s.key === 'came' ? 'won' : 'open' }))); one();
  assert.deepEqual(wonKeys(db), ['approved'], 'сохранение колонок сдвинуло конверсию');
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'stopped' } })); one();
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'scheduled' } }), /Колонка записи/); one();   // CRM_STAGE_ROLES_V1
  saveStages(db, withRoles(db, { recall: 'booked', scheduled: null }));
  saveConfig(db, { settings: { won_stage: 'scheduled' } }); one();
  saveConfig(db, { settings: { won_stage: 'came' } }); one();
  assert.deepEqual(wonKeys(db), ['came']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status = 'came'").get().n, 1, 'история вернулась вместе с конверсией');
  db.close();
});

test('конверсия: отказ для проигрышной, «Не пришёл», скрытой — и для колонки записи на месте конверсии или после', () => {
  const db = fresh();
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'stopped' } }), /Проигрышная колонка/);
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'no_show' } }), /Проигрышная колонка|«Не пришёл»/);
  db.prepare("UPDATE crm_stages SET kind = 'open' WHERE key = 'no_show'").run();
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'no_show' } }), /«Не пришёл» не может быть колонкой конверсии/);
  db.prepare("UPDATE crm_stages SET kind = 'lost' WHERE key = 'no_show'").run();   // CRM_STAGE_ROLES_V1 — назад: открытая «Не пришёл» ломала бы любые роли
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'approved'").run();
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'approved' } }), /Скрытая колонка/);
  db.prepare("UPDATE crm_stages SET is_active = 1 WHERE key = 'approved'").run();
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'nope' } }), /нет в воронке/);
  saveStages(db, withRoles(db, { approved: null }));   // CRM_STAGE_ROLES_V1 — «Подтверждён» без роли подтверждения: может стать колонкой записи
  // Колонка записи «Подтверждён» и конверсия «Записан» — запись после конверсии.
  assert.throws(() => saveConfig(db, { settings: { booked_stage: 'approved', won_stage: 'scheduled' } }), /Колонка записи/);
  // Сохранённый выбор тоже проверяется: «Подтверждён» стоит после новой «Записан».
  saveConfig(db, { settings: { booked_stage: 'approved' } });
  assert.throws(() => saveConfig(db, { settings: { won_stage: 'scheduled' } }), /Колонка записи/);
  // Запись = конверсия.
  assert.throws(() => saveConfig(db, { settings: { booked_stage: 'approved', won_stage: 'approved' } }), /Колонка записи/);
  // CRM_STAGE_ROLES_V1 — ОБНОВЛЕНО: колонка записи — роль («Подтверждён»), и конверсия перед
  // ней — тот же отказ «Колонка записи…» (прежде — «Перед колонкой конверсии…» правила по умолчанию).
  assert.throws(() => saveConfig(db, { settings: { booked_stage: null, won_stage: 'in_process' } }), /Колонка записи/);
  assert.deepEqual(wonKeys(db), ['came'], 'ни один отказ не сдвинул конверсию');
  assert.equal(scheduledStageKey(db), 'approved', 'ни один отказ не изменил колонку записи');
  db.close();
});

test('конверсия и запись одной правкой: пара проверяется по новой воронке', () => {
  const db = fresh();
  saveStages(db, withRoles(db, { approved: null }));   // CRM_STAGE_ROLES_V1 — роль подтверждения сначала снята
  saveConfig(db, { settings: { booked_stage: 'scheduled', won_stage: 'approved' } });
  assert.deepEqual(wonKeys(db), ['approved']);
  assert.equal(scheduledStageKey(db), 'scheduled');
  // Назад — тоже одной правкой.
  saveConfig(db, { settings: { booked_stage: null, won_stage: 'came' } });
  assert.deepEqual(wonKeys(db), ['came']);
  assert.equal(listStages(db).find((s) => s.key === 'approved').kind, 'open');
  db.close();
});

// CRM_STAGE_ROLES_V1 (ревью; решение координатора 2026-11-10) — ОБНОВЛЕНО: роль «подтверждение»
// не снимается переносом конверсии — отказ 409 с названием колонки; колонку записи перенос
// тоже не трогает — отказ (400, как прежние отказы конверсии).
test('конверсия и роли: на колонку подтверждения или перед ней — отказ 409; на колонку записи — отказ 400', () => {
  const db = fresh();
  const e1 = refused(() => saveConfig(db, { settings: { won_stage: 'approved' } }));
  assert.equal(e1.status, 409);
  assert.equal(e1.message, 'Колонка «Подтверждён» — колонка подтверждения: сначала передайте роль другой колонке.');
  assert.equal(e1.template, 'Колонка «{label}» — колонка подтверждения: сначала передайте роль другой колонке.');
  saveStages(db, [...withRoles(db, {})].flatMap((s) => (s.key === 'approved' ? [{ key: 'mid', label: 'Между', color: '', kind: 'open', is_active: true, role: null }, s] : [s])));
  const e2 = refused(() => saveConfig(db, { settings: { won_stage: 'mid' } }));
  assert.equal(e2.status, 409, 'подтверждение оказалось бы после конверсии');
  assert.deepEqual([wonKeys(db), confirmedStageKey(db)], [['came'], 'approved'], 'отказ сдвинул конверсию или снял роль');
  const e = refused(() => saveConfig(db, { settings: { won_stage: 'scheduled' } }));
  assert.equal(e.status, 400);
  assert.equal(e.message, 'Колонка записи должна быть открытой видимой колонкой перед колонкой-конверсией.');
  db.close();
});

// CRM_STAGE_ROLES_V1 (ревью) — недопустимая роль, оставшаяся в базе мимо экрана (ручная правка,
// откат версии), читается как неотмеченная и не блокирует другие правки колонок.
test('роль на скрытой колонке или после конверсии не действует и не мешает сохранять колонки', () => {
  const db = fresh();
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'scheduled'").run();
  assert.equal(scheduledStageKey(db), null, 'запись в скрытую колонку');
  assert.equal(confirmedStageKey(db), null, 'подтверждение без действующей колонки записи');
  saveStages(db, withRoles(db, {}, (s) => (s.key === 'recall' ? { ...s, label: 'Перезвон' } : s)));
  assert.equal(listStages(db).find((s) => s.key === 'recall').label, 'Перезвон');
  saveStages(db, withRoles(db, { scheduled: null, in_process: 'booked', approved: 'confirmed' }));
  assert.equal(scheduledStageKey(db), 'in_process');
  assert.equal(confirmedStageKey(db), 'approved');
  const e = refused(() => saveStages(db, withRoles(db, { in_process: null, recall: 'booked' }, (s) => (s.key === 'recall' ? { ...s, is_active: false } : s))));
  assert.equal(e.status, 409, 'роль перенесли на скрытую колонку');
  db.close();
});

// CRM_STAGE_ROLES_V1 (ревью) — снять галочку и удалить колонку одной правкой можно (как снять и скрыть).
test('снять роль и удалить колонку одной правкой — можно; удалить, не снимая, экраном старше сервера — нельзя', () => {
  const db = fresh();
  const s = asInput(listStages(db));
  s.splice(4, 0, { key: 'agreed', label: 'Согласовано', color: '', kind: 'open', is_active: true, role: 'confirmed' });
  s.find((x) => x.key === 'approved').role = null;
  saveStages(db, s);
  const old = asInput(listStages(db)).map(({ role, ...x }) => x).filter((x) => x.key !== 'agreed');
  assert.equal(refused(() => saveStages(db, old)).status, 409);
  saveStages(db, asInput(listStages(db)).filter((x) => x.key !== 'agreed'));
  assert.equal(confirmedStageKey(db), null);
  assert.ok(!listStages(db).some((x) => x.key === 'agreed'));
  db.close();
});

// Переход заявки не вправе отказать в визите (settleCrmOnBooking в
// rpc/visits.js зовёт это внутри записи), поэтому пустой и сломанный
// справочник обязаны отвечать, а не бросаться.
test('scheduledStageKey не бросается ни на пустой воронке, ни на сломанной базе', () => {
  const db = fresh();
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM crm_stages').run();
  assert.equal(scheduledStageKey(db), 'scheduled', 'пустой справочник обязан отвечать сидовой воронкой');
  db.prepare('DROP TABLE crm_stages').run();
  assert.equal(scheduledStageKey(db), 'scheduled', 'без таблицы справочника ответ обязан остаться сидовым');
});

// CLINIC_API_STEP7_V1 — источники подключений API (правило спецификации «API-источники
// защищены как «Звонок»» и Р11–Р12 плана шага 7).
test('свой источник подключения: список его не удаляет, не переименовывает и не скрывает; он встаёт после присланных', () => {
  const db = fresh();
  const src = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  assert.deepEqual(src, { key: 'api_med24_uz', owns: 1 });
  insertConnectionRow(db, { crm_source_key: src.key });
  // Экран CRM шлёт только свой список — без источника подключения.
  const mine = asInput(listSources(db)).filter((s) => s.key !== src.key);
  const api = saveSources(db, mine).find((s) => s.key === src.key);
  assert.ok(api, 'источник подключения удалён сохранением списка');
  assert.equal(api.position, mine.length + 1);
  // CLINIC_API_STEP7_V1 (ревью №7) — собранный руками список с другим названием или
  // видимостью своего источника подключения — отказ 409 с шаблоном, а не молчаливая
  // подмена с ответом «сохранено»; источник не тронут.
  for (const over of [{ label: 'Другое имя' }, { is_active: false }]) {
    const forged = asInput(listSources(db)).map((s) => (s.key === src.key ? { ...s, ...over } : s));
    const e = refused(() => saveSources(db, forged));
    assert.equal(e.status, 409, JSON.stringify(over));
    assert.ok(e.template, 'фраза собрана шаблоном — экран переведёт');
    assert.match(e.message, /«api_med24_uz».*«med24\.uz»/);
  }
  // Тот же источник как есть — проходит.
  const after = saveSources(db, asInput(listSources(db))).find((s) => s.key === src.key);
  assert.deepEqual([after.label, after.is_active], ['med24.uz', true]);
  assert.deepEqual(after.api, { connection_id: 1, connection_name: 'med24.uz', owned: true, archived: false });
  assert.equal(listSources(db).find((s) => s.key === 'call').api, null);
});

test('«Сайт» у подключения сайта: переименовать можно; скрыть и удалить — 409 с шаблоном', () => {
  const db = fresh();
  ensureApiSource(db, { kind: 'site' });
  insertConnectionRow(db, { kind: 'site', name: 'Сайт клиники', crm_source_key: 'website', owns_source: 0, active: 0 });
  const renamed = saveSources(db, asInput(listSources(db)).map((s) => (s.key === 'website' ? { ...s, label: 'Наш сайт' } : s)));
  assert.equal(renamed.find((s) => s.key === 'website').label, 'Наш сайт');
  const hide = refused(() => saveSources(db, asInput(listSources(db)).map((s) => (s.key === 'website' ? { ...s, is_active: false } : s))));
  assert.equal(hide.status, 409);
  assert.match(hide.message, /нужен подключению «Сайт клиники»/);
  assert.ok(hide.template, 'фраза собрана шаблоном — экран переведёт');
  const del = refused(() => saveSources(db, asInput(listSources(db)).filter((s) => s.key !== 'website')));
  assert.equal(del.status, 409);
});

test('источник для сайта: «Сайт» заводится заново, если его удалили, и становится видимым, если его скрыли', () => {
  const db = fresh();
  db.prepare("UPDATE crm_sources SET is_active = 0 WHERE key = 'website'").run();
  assert.deepEqual(ensureApiSource(db, { kind: 'site' }), { key: 'website', owns: 0 });
  assert.equal(db.prepare("SELECT is_active FROM crm_sources WHERE key = 'website'").get().is_active, 1);
  db.prepare("DELETE FROM crm_sources WHERE key = 'website'").run();
  ensureApiSource(db, { kind: 'site' });
  assert.equal(db.prepare("SELECT label FROM crm_sources WHERE key = 'website'").get().label, 'Сайт');
});

test('архив подключения: свой источник скрыт, но цел и под замком — заявки партнёра остаются в отчётах', () => {
  const db = fresh();
  const { key } = ensureApiSource(db, { kind: 'partner', name: 'clinics.uz' });
  const id = insertConnectionRow(db, { crm_source_key: key, name: 'clinics.uz' });
  lead(db, { source: key });
  db.prepare(`UPDATE api_connections SET deleted_at = '2026-10-10T10:00:00Z', active = 0,
    key_hash = '', key_sealed = '', secret_sealed = '' WHERE id = ?`).run(id);
  archiveApiSource(db, key);
  const row = saveSources(db, asInput(listSources(db)).filter((s) => s.key !== key)).find((s) => s.key === key);
  assert.ok(row, 'источник удалённого подключения удалён');
  assert.equal(row.is_active, false);
  assert.equal(row.api.archived, true);
  assert.equal(apiSourceUse(db).get(key).owned, true);
});

test('переименование подключения переименовывает его источник; ключи двух одноимённых не сталкиваются', () => {
  const db = fresh();
  const a = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  const b = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  assert.notEqual(a.key, b.key);
  renameApiSource(db, a.key, 'med24 (новый)');
  assert.equal(db.prepare('SELECT label FROM crm_sources WHERE key = ?').get(a.key).label, 'med24 (новый)');
});

// CLINIC_API_STEP7_V1 (ревью №7) — новый источник, чей код совпал с кодом подключения
// (в том числе удалённого): раньше сервер молча подменял присланное своим и отвечал
// «Источники сохранены», а нового источника не было нигде.
test('новый источник с кодом подключения (и удалённого) — 409 с шаблоном, источник подключения не тронут', () => {
  const db = fresh();
  const { key } = ensureApiSource(db, { kind: 'symptex', name: 'Symptex' });
  assert.equal(key, 'api_symptex');
  const id = insertConnectionRow(db, { kind: 'symptex', name: 'Symptex', crm_source_key: key });
  for (const archived of [false, true]) {
    if (archived) {
      db.prepare(`UPDATE api_connections SET deleted_at = '2026-10-10T10:00:00Z', active = 0,
        key_hash = '', key_sealed = '', secret_sealed = '' WHERE id = ?`).run(id);
      archiveApiSource(db, key);
    }
    const before = { ...db.prepare('SELECT label, is_active FROM crm_sources WHERE key = ?').get(key) };
    const mine = asInput(listSources(db)).filter((s) => !(s.api && s.api.owned));
    const e = refused(() => saveSources(db, [...mine, { key, label: 'API Symptex', is_active: true }]));
    assert.equal(e.status, 409, archived ? 'удалённое' : 'живое');
    assert.ok(e.template);
    assert.match(e.message, /«api_symptex».*«Symptex»/);
    assert.deepEqual({ ...db.prepare('SELECT label, is_active FROM crm_sources WHERE key = ?').get(key) }, before);
  }
});
