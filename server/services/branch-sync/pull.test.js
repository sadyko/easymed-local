// BRANCH_SYNC_V1 — как филиал реагирует на КАЖДЫЙ способ, которым поход за
// справочником может не удаться.
//
// Отдельно от sync-e2e.test.js, потому что настоящий сервер не умеет по
// команде отвечать обрезанным телом, гигабайтом мусора или чужой группой, а
// именно на таких ответах и проверяется главное обещание файла pull.js:
// НИКОГДА не бросать наружу и НИКОГДА не отдавать вызывающему что-то, что он
// мог бы принять за справочник. Словарь причин закрытый — rpc/branch-sync.js
// переводит его в русские фразы, и «неизвестная причина» на экране означала бы
// «неизвестно, что чинить».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullCatalogue } from './pull.js';
import { writePairing } from './pairing.js';

const GOOD = { role: 'secondary', group_id: 'BR-AAAABBBBCCCC', secret: 'общий-секрет', main_url: 'http://10.0.0.5:8000' };

function dir(record = GOOD) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'em-branch-pull-'));
  if (record) writePairing(d, record);
  return d;
}
const answer = (body, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('не спарен / спарен как главный — в сеть даже не выходим', async () => {
  const never = async () => { throw new Error('сети быть не должно'); };
  assert.equal((await pullCatalogue(dir(null), { fetchImpl: never })).reason, 'not_paired');
  assert.equal((await pullCatalogue(dir({ ...GOOD, role: 'main' }), { fetchImpl: never })).reason, 'not_secondary');
});

test('сеть недоступна — это «offline», а не исключение', async () => {
  const r = await pullCatalogue(dir(), { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(r, { ok: false, reason: 'offline' });
});

test('каждый отказ сервера получает свою причину', async () => {
  const cases = [
    [401, { error: { code: 'unauthorized' } }, 'unauthorized'],
    [401, { error: { code: 'clock_skew' } }, 'clock_skew'],
    [404, { error: { code: 'not_found' } }, 'not_main'],
    [500, { error: { code: 'internal' } }, 'server_error'],
    [503, 'сервер лежит', 'server_error'],
  ];
  for (const [status, body, reason] of cases) {
    const r = await pullCatalogue(dir(), { fetchImpl: answer(body, status) });
    assert.equal(r.reason, reason, `${status} -> ${reason}`);
  }
});

test('ответ не той формы никогда не выдаётся за справочник', async () => {
  const bad = [
    'не json',
    '[]',
    JSON.stringify({ ok: false }),
    JSON.stringify({ ok: true }),                                   // нет catalogue
    JSON.stringify({ ok: true, catalogue: 'строка' }),
    JSON.stringify({ ok: true, catalogue: [] }),
    // Правильная форма, но чужая группа: адрес указывает не туда, куда думает
    // владелец. Приём такого справочника перепутал бы прайсы двух клиник.
    JSON.stringify({ ok: true, group_id: 'BR-DDDDEEEEFFFF', catalogue: { services: [] } }),
  ];
  for (const body of bad) {
    const r = await pullCatalogue(dir(), { fetchImpl: answer(body) });
    assert.equal(r.ok, false, body);
    assert.equal(r.reason, 'bad_response', body);
  }
});

test('слишком большое тело обрывается, а не набирается в память', async () => {
  const huge = JSON.stringify({ ok: true, catalogue: { services: [{ id: 1, name: 'x'.repeat(50_000) }] } });
  const r = await pullCatalogue(dir(), { fetchImpl: answer(huge), maxResponseBytes: 1024 });
  assert.deepEqual(r, { ok: false, reason: 'too_large' });
});

test('нормальный ответ доезжает целиком', async () => {
  let seen = null;
  const r = await pullCatalogue(dir(), {
    fetchImpl: async (url, opts) => {
      seen = { url, headers: opts.headers };
      return new Response(JSON.stringify({ ok: true, group_id: GOOD.group_id, catalogue: { services: [{ id: 3, name: 'Приём' }] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.catalogue.services[0].name, 'Приём');
  assert.equal(seen.url, 'http://10.0.0.5:8000/api/branch-sync/catalogue');
  assert.equal(seen.headers['x-em-branch-group'], GOOD.group_id);
  assert.ok(seen.headers['x-em-branch-sig'], 'запрос подписан');
  // Секрет в сеть не уходит ни в одном заголовке — только подпись от него.
  assert.equal(JSON.stringify(seen.headers).includes(GOOD.secret), false);
});
