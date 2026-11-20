// REP_BOT_CLAIMS_V1 — заявки бота медпредставителей на закрепление существующего
// врача: список открытых, подтверждение (переносит врача к заявителю тем же
// правилом, что вкладка «Представители»), отклонение, void, права и сообщения в бот.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { repBotClaimsList, repBotClaimDecide, RpcError } from './rep-bot.js';
import { T } from '../rep-bot/flow.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, phone, custom_role_code) VALUES (?,?,?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Админ', '', null);
  ins.run(2, 'reg', 'x', 'registrar', 'Регистратор', '', null);
  ins.run(3, 'rep', 'x', 'callcenter', 'Юсупов Акмал', '+998903106570', 'medrep');
  ins.run(4, 'rep2', 'x', 'callcenter', 'Прежний Представитель', '+998911111111', 'medrep');
  // Подтверждённые связки обоих представителей с ботом.
  db.prepare("INSERT INTO rep_bot_links (id, user_id, chat_id, phone, status) VALUES (10, 3, '700', '998903106570', 'confirmed'), (11, 4, '800', '998911111111', 'confirmed')").run();
  const src = Number(db.prepare("INSERT INTO referral_sources (name, phone, workplace, representative_id) VALUES ('Каримов Азиз', '+998901234567', 'Поликлиника № 5', 4)").run().lastInsertRowid);
  const claim = Number(db.prepare("INSERT INTO rep_bot_claims (referral_source_id, user_id, link_id, chat_id, entered_name) VALUES (?, 3, 10, '700', 'Каримов Азиз Б.')").run(src).lastInsertRowid);
  return { db, src, claim, code: db.prepare('SELECT code FROM referral_sources WHERE id = ?').get(src).code };
}
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
function sender() {
  const sent = [];
  return { sent, send: async (_db, chat, text) => { sent.push({ chat, text }); } };
}
const claimRow = (db, id) => db.prepare('SELECT * FROM rep_bot_claims WHERE id = ?').get(id);
const repOf = (db, src) => db.prepare('SELECT representative_id FROM referral_sources WHERE id = ?').get(src).representative_id;

test('RPC зарегистрированы; список — чтение, решение — запись (просроченная клиника не решает); только администратор', async () => {
  const { db, claim } = fresh();
  assert.equal(typeof getRpc('rep_bot_claims_list'), 'function');
  assert.equal(typeof getRpc('rep_bot_claim_decide'), 'function');
  assert.equal(isReadOnlyRpc('rep_bot_claims_list'), true);
  assert.equal(isReadOnlyRpc('rep_bot_claim_decide'), false);
  assert.throws(() => repBotClaimsList(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
  await assert.rejects(() => repBotClaimDecide(db, { id: claim, decision: 'approve' }, registrar), (e) => e.status === 403);
  assert.equal(claimRow(db, claim).status, 'pending');
});

test('список: только открытые; врач, заявитель, текущий представитель, дата', () => {
  const { db, src, claim, code } = fresh();
  const rows = repBotClaimsList(db, {}, admin);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, claim);
  assert.deepEqual([r.source_id, r.source_code, r.source_name, r.source_phone], [src, code, 'Каримов Азиз', '+998901234567']);
  assert.deepEqual([r.requester_id, r.requester_name], [3, 'Юсупов Акмал']);
  assert.deepEqual([r.current_rep_id, r.current_rep_name], [4, 'Прежний Представитель']);
  assert.equal(r.entered_name, 'Каримов Азиз Б.');
  assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T/);

  db.prepare('UPDATE referral_sources SET representative_id = NULL WHERE id = ?').run(src);
  assert.equal(repBotClaimsList(db, {}, admin)[0].current_rep_name, null, 'не закреплён');
  db.prepare("UPDATE rep_bot_claims SET status = 'rejected'").run();
  assert.equal(repBotClaimsList(db, {}, admin).length, 0);
});

test('подтверждение переносит врача к заявителю, записывает прежнего и решившего; сообщения заявителю и прежнему представителю', async () => {
  const { db, src, claim, code } = fresh();
  const { sent, send } = sender();
  const out = await repBotClaimDecide(db, { id: claim, decision: 'approve' }, admin, { send });
  assert.deepEqual(out, { id: claim, status: 'approved', source_id: src, representative_id: 3, prev_representative_id: 4 });
  assert.equal(repOf(db, src), 3);
  const c = claimRow(db, claim);
  assert.equal(c.status, 'approved');
  assert.equal(c.prev_representative_id, 4);
  assert.equal(c.decided_by, 1);
  assert.match(c.decided_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(sent, [
    { chat: '700', text: T.claimApproved('Каримов Азиз', code) },
    { chat: '800', text: T.claimMoved('Каримов Азиз', code) },
  ]);
  assert.match(sent[0].text, /закреплён за вами/);
  assert.match(sent[1].text, /передан другому представителю/);
  const sw = db.prepare('SELECT workplace, name, phone FROM referral_sources WHERE id = ?').get(src);
  assert.deepEqual({ ...sw }, { workplace: 'Поликлиника № 5', name: 'Каримов Азиз', phone: '+998901234567' }, 'карточка врача не меняется');

  await assert.rejects(() => repBotClaimDecide(db, { id: claim, decision: 'approve' }, admin, { send }), (e) => e.status === 409, 'второй раз — нет');
});

test('врач не был закреплён или прежний без подключённого бота — сообщение только заявителю', async () => {
  const { db, src, claim } = fresh();
  db.prepare('UPDATE referral_sources SET representative_id = NULL WHERE id = ?').run(src);
  const { sent, send } = sender();
  const out = await repBotClaimDecide(db, { id: claim, decision: 'approve' }, admin, { send });
  assert.equal(out.prev_representative_id, null);
  assert.deepEqual(sent.map((s) => s.chat), ['700']);

  const env = fresh();
  env.db.prepare('UPDATE rep_bot_links SET revoked_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE user_id = 4').run();
  const s2 = sender();
  await repBotClaimDecide(env.db, { id: env.claim, decision: 'approve' }, admin, { send: s2.send });
  assert.deepEqual(s2.sent.map((s) => s.chat), ['700']);
});

test('отклонение: врач остаётся у прежнего, заявитель получает «отклонена»', async () => {
  const { db, src, claim, code } = fresh();
  const { sent, send } = sender();
  assert.deepEqual(await repBotClaimDecide(db, { id: claim, decision: 'reject' }, admin, { send }), { id: claim, status: 'rejected' });
  assert.equal(repOf(db, src), 4);
  assert.equal(claimRow(db, claim).status, 'rejected');
  assert.equal(claimRow(db, claim).decided_by, 1);
  assert.deepEqual(sent, [{ chat: '700', text: T.claimRejected('Каримов Азиз', code) }]);
});

test('заявитель уволен или без роли — заявка void, врач не переходит, понятный отказ', async () => {
  for (const change of ['UPDATE users SET is_active = 0 WHERE id = 3', 'UPDATE users SET custom_role_code = NULL WHERE id = 3']) {
    const { db, src, claim } = fresh();
    db.prepare(change).run();
    const { sent, send } = sender();
    await assert.rejects(() => repBotClaimDecide(db, { id: claim, decision: 'approve' }, admin, { send }),
      (e) => e.status === 409 && /Заявитель больше не действующий медпредставитель/.test(e.message));
    assert.equal(claimRow(db, claim).status, 'void', 'void сохраняется, хотя RPC ответил отказом');
    assert.equal(repOf(db, src), 4);
    assert.equal(sent.length, 0);
    assert.equal(repBotClaimsList(db, {}, admin).length, 0, 'из списка открытых ушла');
  }
});

test('врач стал врачом клиники — заявка void', async () => {
  const { db, src, claim } = fresh();
  // Строка справочника стала строкой сотрудника клиники (doctor_id задан).
  db.prepare('UPDATE referral_sources SET doctor_id = 2 WHERE id = ?').run(src);
  await assert.rejects(() => repBotClaimDecide(db, { id: claim, decision: 'approve' }, admin, { send: async () => {} }), (e) => e.status === 409);
  assert.equal(claimRow(db, claim).status, 'void');
});

test('сбой отправки в Telegram решение не отменяет', async () => {
  const { db, src, claim } = fresh();
  const out = await repBotClaimDecide(db, { id: claim, decision: 'approve' }, admin, { send: async () => { throw new Error('Telegram недоступен'); } });
  assert.equal(out.status, 'approved');
  assert.equal(repOf(db, src), 3);
  assert.equal(claimRow(db, claim).status, 'approved');
});

test('неверные аргументы: нет id, неизвестное решение', async () => {
  const { db, claim } = fresh();
  await assert.rejects(() => repBotClaimDecide(db, { decision: 'approve' }, admin), (e) => e.status === 400);
  await assert.rejects(() => repBotClaimDecide(db, { id: claim, decision: 'maybe' }, admin), (e) => e.status === 400);
  await assert.rejects(() => repBotClaimDecide(db, { id: 99999, decision: 'reject' }, admin), (e) => e.status === 409);
});
