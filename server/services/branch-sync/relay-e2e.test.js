// BRANCH_SYNC_RELAY_V1 — МАРШРУТ Б целиком: две настоящие установки Easy-Med и
// настоящая контрольная панель поставщика, все три в одном процессе, на трёх
// своих портах.
//
// Ничего не подменено: своя база у каждого филиала, свои миграции, свой HTTP,
// реальный fetch, реальное AES-256-GCM, реальный реестр клиник у поставщика.
// Проверяется результат — строки в базе принимающего филиала и БАЙТЫ на диске
// поставщика, — а не то, с какими аргументами кого позвали. Причина та же, что
// у sync-e2e.test.js: в прошлой жизни проекта четыре релиза подряд не
// устанавливали ничего, потому что тесты сверяли аргументы вызова.
//
// Ловушка окружения — та же и обходится так же: services/control/config.js
// хранит каталог данных ОДНИМ значением на процесс, и его выставляет
// createApp(). Поэтому сначала поднимается главный филиал и через его RPC
// делается всё, что делается «на главном», и только потом — вторичный. Там, где
// после этого нужно что-то сделать от имени главного, вызывается СЕРВИС с явным
// каталогом (publishCatalogue(db, mainDir)), а не RPC — сервисы принимают
// dataDir параметром именно за этим.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createApp } from '../../app.js';
import { hashPassword } from '../auth.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { readPairing, writePairing, makeMainKey, encodeKey, b64url, GROUP_KEY_BYTES } from './pairing.js';
import { relayIdFor } from './relay-crypto.js';
import { publishCatalogue, mintRelayToken, MAX_SCOPE } from './relay.js';
import { readSyncGroup, regenerateSyncGroup } from './sync-group.js';

import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createApp as createCpApp } from '../../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';
import { relayPathFor } from '../../../control-plane/server/routes/relay.js';
import { RELAY_TOKEN_MOUNT, MAX_SCOPE as MAX_SCOPE_CP } from '../../../control-plane/server/routes/relay-token.js';   // BRANCH_IDENTITY_V1

const MARKER = 'ZZPATIENTMARKER';

// --- один филиал -----------------------------------------------------------
function install(dataDir, name) {
  const db = openDb(path.join(dataDir, name + '.db'));
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  return db;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Закрывать надо вместе с живыми keep-alive соединениями: fetch держит их
// открытыми, и голый close() ждал бы их вечно — тест повис бы ровно на том
// «главный филиал выключен», который он же и проверяет.
function shutdown(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(res.status, 200, 'администратор должен войти');
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function rpc(base, cookie, name, args = {}) {
  const res = await fetch(base + '/api/rpc/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data ?? null, error: json.error ?? null };
}

/** Справочник + клинические данные, которых на сервере поставщика быть не должно. */
function seedMain(db) {
  db.prepare("UPDATE doc_settings SET clinic_name='Клиника Луч', accent_color='#0d5f57', license='LIC-77' WHERE id=1").run();
  db.prepare("INSERT INTO service_categories (name, code) VALUES ('Кардиология','CARD')").run();
  db.prepare(`INSERT INTO services (name, code, price, type, category_id, active)
              VALUES ('Приём кардиолога','S-CARD',250000,'consultation',1,1)`).run();

  db.prepare('INSERT INTO patients (full_name, phone, notes) VALUES (?,?,?)')
    .run(MARKER + ' Петров', '+998900000001', 'жалобы ' + MARKER);
  db.prepare("INSERT INTO visits (patient_id, visit_date, notes) VALUES (1,'2026-08-29',?)").run(MARKER);
  db.prepare('INSERT INTO invoices (invoice_number, patient_id, total_amount) VALUES (?,1,250000)').run(MARKER + '-7');
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, unit_price) VALUES (1,1,?,250000)').run(MARKER);
}

const backups = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'backups')); } catch { return []; }
};
const clinicalCounts = (db) => ({
  patients: db.prepare('SELECT COUNT(*) n FROM patients').get().n,
  visits: db.prepare('SELECT COUNT(*) n FROM visits').get().n,
  invoices: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
  invoice_items: db.prepare('SELECT COUNT(*) n FROM invoice_items').get().n,
});
const priceOf = (db, code) => db.prepare('SELECT price FROM services WHERE code = ?').get(code)?.price ?? null;

// Каталог данных активированной клиники: лицензионная фикстура + install_token,
// которым установка представляется поставщику. Фикстура его не пишет (её задача
// — лицензия), а резервный канал без него не работает по построению: сервер
// поставщика пускает только активированные установки.
function withInstallToken(dir, token) {
  const file = path.join(dir, 'control.json');
  const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...identity, install_token: token }));
}

test('маршрут Б: копия через сервер поставщика, которую он не может прочитать', async (t) => {
  // --- поставщик ---------------------------------------------------------
  const cpDb = openCpDb(':memory:');
  migrateCp(cpDb);
  const cp = await listen(createCpApp(cpDb));
  const tokenMain = redeemEnrollmentCode(cpDb, { code: createEnrollmentCode(cpDb, { clinicId: 'cp-main', name: 'Главный' }) }).install_token;
  const tokenSec = redeemEnrollmentCode(cpDb, { code: createEnrollmentCode(cpDb, { clinicId: 'cp-sec', name: 'Филиал' }) }).install_token;

  // Обе установки ходят к ЭТОМУ поставщику. Читается при каждом вызове
  // (relayUrl), как и у checkin.js.
  const prevControlUrl = process.env.EASYMED_CONTROL_URL;
  process.env.EASYMED_CONTROL_URL = cp.base;

  // --- два филиала -------------------------------------------------------
  // Оба каталога лицензированы ОДНИМ ключом: licensedDataDir() выдаёт новый на
  // каждый вызов, поэтому второй каталог получается копированием файлов первого.
  const secDir = licensedDataDir();
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay-main-'));
  for (const f of ['control.json', 'licence.dat']) fs.copyFileSync(path.join(secDir, f), path.join(mainDir, f));
  withInstallToken(mainDir, tokenMain);
  withInstallToken(secDir, tokenSec);

  const dbMain = install(mainDir, 'main');
  seedMain(dbMain);
  const main = await listen(createApp(dbMain, { dataDir: mainDir }));

  const dbSec = install(secDir, 'sec');
  dbSec.prepare("UPDATE sqlite_sequence SET seq = 700 WHERE name = 'services'").run();

  let sec = null;
  let secCookie = null;

  t.after(async () => {
    if (sec) await shutdown(sec.server);
    try { await shutdown(main.server); } catch { /* уже закрыт этим же тестом */ }
    await shutdown(cp.server);
    dbSec.close(); dbMain.close(); cpDb.close();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(secDir, { recursive: true, force: true });
    if (prevControlUrl === undefined) delete process.env.EASYMED_CONTROL_URL;
    else process.env.EASYMED_CONTROL_URL = prevControlUrl;
  });

  const mainCookie = await login(main.base);
  let key = null;
  let groupKey = null;

  await t.test('ключ синхронизации существует и НЕ уходит поставщику', async () => {
    // Установка активирована (control.json с install_token). Ключ заводится
    // ленивым путём — ровно как у клиники, активированной до Маршрута Б.
    const r = await rpc(main.base, mainCookie, 'branch_sync_make_key', { url: main.base });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.relay_ready, true, 'ключ подключения обязан нести ключ шифрования группы');
    key = r.data.key;

    const group = readSyncGroup(mainDir);
    assert.ok(group && group.key, 'ключ лежит в каталоге данных клиники');
    groupKey = readPairing(mainDir).group_key;
    assert.equal(groupKey, group.key, 'пара работает тем же ключом, что выписан при активации');

    // Главное отрицательное утверждение: у поставщика ключа нет нигде.
    const cpDump = JSON.stringify(cpDb.prepare('SELECT * FROM clinics').all())
      + JSON.stringify(cpDb.prepare('SELECT * FROM checkins').all());
    assert.equal(cpDump.includes(groupKey), false, 'ключ не должен попасть к поставщику ни одним полем');
  });

  await t.test('владелец включает резервный канал и отправляет копию', async () => {
    const off = await rpc(main.base, mainCookie, 'branch_sync_relay_publish');
    assert.equal(off.data.ok, false, 'без согласия владельца ничего не выгружается');
    assert.equal(off.data.reason, 'relay_disabled');
    assert.equal(cpDb.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 0);

    const on = await rpc(main.base, mainCookie, 'branch_sync_relay_set', { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.error));

    // Цена, которая НЕ должна победить: она уедет в копию, а сразу после будет
    // возвращена. Прямой путь обязан привезти 250000, и это единственный
    // честный способ доказать, что предпочли именно его.
    dbMain.prepare("UPDATE services SET price = 999999 WHERE code='S-CARD'").run();
    const pub = await rpc(main.base, mainCookie, 'branch_sync_relay_publish');
    assert.equal(pub.data.ok, true, JSON.stringify(pub.data));
    assert.ok(pub.data.bytes > 0);
    dbMain.prepare("UPDATE services SET price = 250000 WHERE code='S-CARD'").run();
  });

  await t.test('на диске поставщика лежит шифротекст: ни клиники, ни цен, ни маркера', () => {
    const row = cpDb.prepare('SELECT relay_id, clinic_id, bytes, size FROM relay_blobs').get();
    assert.ok(row, 'копия должна была лечь');
    assert.equal(row.relay_id, relayIdFor(groupKey), 'адрес блоба выводится из ключа группы');
    assert.equal(row.clinic_id, 'cp-main', 'поставщик знает, КТО выгрузил, — и это всё, что он знает');

    const text = row.bytes.toString('latin1');
    assert.equal(text.includes(MARKER), false, 'клинические данные не должны уходить из клиники');
    assert.equal(text.includes('Клиника Луч'), false, 'даже название клиники не читается');
    assert.equal(text.includes('S-CARD'), false);
    assert.equal(text.includes('999999'), false, 'цены не читаются');
    assert.equal(text.includes('catalogue'), false, 'не читаются даже имена полей');
    assert.equal(row.bytes.subarray(0, 4).toString('ascii'), 'EMR1', 'снаружи виден только формат');
  });

  await t.test('вторичный филиал принимает ключ — вместе с ключом шифрования', async () => {
    sec = await listen(createApp(dbSec, { dataDir: secDir }));
    secCookie = await login(sec.base);
    const r = await rpc(sec.base, secCookie, 'branch_sync_pair', { key });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.relay_ready, true);
    assert.equal(readPairing(secDir).group_key, groupKey,
      'ключ доехал ключом подключения — единственным путём, минующим поставщика');
  });

  await t.test('пока главный филиал доступен, идём НАПРЯМУЮ', async () => {
    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.equal(r.data.route, 'direct', 'прямой путь обязан пробоваться первым');
    assert.equal(priceOf(dbSec, 'S-CARD'), 250000,
      'приехала цена главного филиала, а не 999999 из копии на сервере — значит взяли именно прямой путь');
    assert.deepEqual(clinicalCounts(dbSec), { patients: 0, visits: 0, invoices: 0, invoice_items: 0 },
      'клинические строки не едут ни одним из маршрутов');
  });

  await t.test('главный филиал недоступен — справочник приходит через сервер', async () => {
    // Новая цена и свежая копия — от имени главного филиала, но уже сервисом:
    // getDataDir() в этом процессе теперь указывает на вторичный (см. заголовок).
    dbMain.prepare("UPDATE services SET price = 320000 WHERE code='S-CARD'").run();
    const pub = await publishCatalogue(dbMain, mainDir);
    assert.equal(pub.ok, true, JSON.stringify(pub));

    await shutdown(main.server);

    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200, 'недоступный главный филиал — не 500');
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.equal(r.data.route, 'relay', 'резервный путь включается только когда прямой не удался');
    assert.ok(r.data.relayed_at, 'возраст копии обязан быть виден: это не сегодняшние данные, а копия');
    assert.equal(priceOf(dbSec, 'S-CARD'), 320000, 'новая цена доехала через сервер поставщика');
    assert.deepEqual(clinicalCounts(dbSec), { patients: 0, visits: 0, invoices: 0, invoice_items: 0 });
  });

  await t.test('экран знает, каким путём пришёл справочник, и не выдаёт ключ', async () => {
    const r = await rpc(sec.base, secCookie, 'branch_sync_status');
    assert.equal(r.status, 200);
    assert.equal(r.data.last_ok.route, 'relay', 'владелец должен видеть, что VPN сейчас не работает');
    assert.equal(r.data.relay_ready, true);
    assert.equal(r.data.sync_key_present, true);

    const dump = JSON.stringify(r.data);
    assert.equal(dump.includes(groupKey), false, 'ключ шифрования не уходит на экран');
    assert.equal(dump.includes(readPairing(secDir).secret), false, 'и секрет подписи тоже');
  });

  await t.test('чужой ключ: копия не расшифровывается, и НИЧЕГО не меняется', async () => {
    const snapshot = dbSec.prepare('SELECT id, code, price FROM services ORDER BY id').all();
    const beforeBackups = backups(secDir).length;
    const good = readPairing(secDir);

    // Байты, которые запечатаны ЧУЖИМ ключом, но лежат по НАШЕМУ адресу. В
    // жизни это либо сервер поставщика, подсунувший не то, либо остаток от
    // старой группы. Собирается честно: берём настоящий блоб и кладём его по
    // адресу другого ключа тем же PUT-ом, что делает клиника.
    const blob = cpDb.prepare('SELECT bytes FROM relay_blobs').get().bytes;
    const otherKey = b64url(randomBytes(GROUP_KEY_BYTES));
    const put = await fetch(cp.base + relayPathFor(relayIdFor(otherKey)), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMain}`, 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    assert.equal(put.status, 200);

    writePairing(secDir, { ...good, group_key: otherKey });
    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, false);
    assert.equal(r.data.reason, 'offline', 'первопричина — недоступный главный филиал');
    assert.equal(r.data.relay_reason, 'relay_bad_key');
    assert.match(r.data.message, /Ключи филиалов не совпадают/,
      'владельцу должно быть понятно, что чинить: ключ, а не сеть');

    assert.deepEqual(dbSec.prepare('SELECT id, code, price FROM services ORDER BY id').all(), snapshot,
      'нерасшифрованная копия не применяется даже частично');
    assert.equal(backups(secDir).length, beforeBackups, 'копия базы ради ничего не снимается');
    writePairing(secDir, good);
  });

  await t.test('ключ есть, а копии по его адресу нет — отдельная честная причина', async () => {
    const good = readPairing(secDir);
    writePairing(secDir, { ...good, group_key: b64url(randomBytes(GROUP_KEY_BYTES)) });
    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.data.ok, false);
    assert.equal(r.data.relay_reason, 'relay_empty');
    assert.match(r.data.message, /Включите отправку копии в главном филиале/,
      'чинится это на ДРУГОЙ машине, и так и написано');
    writePairing(secDir, good);
  });

  await t.test('выключенный резервный канал не ходит на сервер вообще', async () => {
    const good = readPairing(secDir);
    writePairing(secDir, { ...good, relay: false });
    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.data.ok, false);
    assert.equal(r.data.relay_reason, 'relay_disabled');
    writePairing(secDir, good);
  });

  await t.test('сервер поставщика не отдаёт копию тому, кто не активирован', async () => {
    const id = relayIdFor(groupKey);
    // Токен только из ASCII: заголовок с кириллицей fetch не пропускает вовсе,
    // и «отказ» получился бы не от сервера, а от клиента.
    for (const headers of [{}, { Authorization: 'Bearer guessed-token-0123456789' }]) {
      const res = await fetch(cp.base + relayPathFor(id), { headers });
      assert.equal(res.status, 401, 'копия клиники не отдаётся без её же учётных данных');
    }
    // А активированной — отдаёт, и это те же байты. Прочитать их без ключа
    // всё равно невозможно, что и проверено выше.
    const ok = await fetch(cp.base + relayPathFor(id), { headers: { Authorization: `Bearer ${tokenSec}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), cpDb.prepare('SELECT bytes FROM relay_blobs WHERE relay_id = ?').get(id).bytes);
  });

  await t.test('перевыпуск ключа: группа уезжает на другой адрес, старая копия замирает', async () => {
    // Перевыпуск делается на ГЛАВНОМ филиале, поэтому вызывается сервисом с
    // явным каталогом: RPC в этом процессе адресует уже вторичный.
    const before = readPairing(mainDir);
    const fresh = regenerateSyncGroup(mainDir);
    const r = makeMainKey(mainDir, { url: before.main_url, groupId: fresh.group_id, groupKey: fresh.key, rotate: true });
    assert.equal(r.ok, true);
    assert.notEqual(r.record.secret, before.secret,
      'секрет подписи меняется тоже — иначе «перевыпуск отключит все филиалы» было бы правдой наполовину');
    assert.notEqual(r.record.group_key, before.group_key);
    assert.notEqual(relayIdFor(r.record.group_key), relayIdFor(before.group_key));

    // По новому адресу копии ещё нет — старый блоб к новой группе отношения не
    // имеет и будет вычищен удержанием на сервере.
    const probe = await fetch(cp.base + relayPathFor(relayIdFor(r.record.group_key)), {
      headers: { Authorization: `Bearer ${tokenMain}` },
    });
    assert.equal(probe.status, 404, 'новая группа начинает с пустого места');

    // ЧЕСТНОЕ ОГРАНИЧЕНИЕ, зафиксированное тестом, а не спрятанное. Филиал со
    // старым ключом не «сразу отваливается»: пока главный филиал недоступен, он
    // продолжает читать СТАРУЮ копию — она просто больше никогда не обновится.
    // Именно поэтому экран показывает возраст копии («копия главного филиала от
    // …»): по нему и видно, что связь давно замерла. Прямой путь при этом
    // закрыт наглухо — секрет подписи сменился.
    const after = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(after.data.ok, true);
    assert.equal(after.data.route, 'relay');
    assert.equal(after.data.changed, 0, 'ничего нового приехать уже не может: копия заморожена');
    assert.equal(after.data.relayed_at, before.rotated_at ?? after.data.relayed_at);
    assert.ok(Date.now() - Date.parse(after.data.relayed_at) >= 0, 'возраст копии виден владельцу');
  });
});

// --- политика «сначала А, потом Б» -----------------------------------------
//
// Отдельным тестом и на подставных транспортах, потому что проверяется РЕШЕНИЕ,
// а не сеть: какие неудачи прямого пути оправдывают попытку через сервер
// поставщика, а какие — нет. Исключения тут важнее включений: неверный ключ и
// разъехавшиеся часы — это настоящая поломка, и подсунуть вместо неё вчерашнюю
// копию значило бы спрятать ровно ту неисправность, ради которой владелец на
// экран и смотрит.
test('резервный канал включается только там, где он уместен', async () => {
  const { branchSyncNow } = await import('../rpc/branch-sync.js');
  const db = openDb(':memory:');
  migrate(db);
  const admin = { id: 1, role: 'admin' };
  const run = async (pullResult) => {
    let relayCalls = 0;
    const res = await branchSyncNow(db, {}, admin, {
      pullImpl: async () => pullResult,
      relayImpl: async () => { relayCalls++; return { ok: false, reason: 'relay_empty' }; },
      backupImpl: async () => {},
    });
    return { relayCalls, res };
  };

  for (const reason of ['offline', 'server_error', 'not_main', 'bad_response', 'too_large']) {
    const { relayCalls } = await run({ ok: false, reason });
    assert.equal(relayCalls, 1, `до главного филиала не достучались (${reason}) — ровно случай Маршрута Б`);
  }
  for (const reason of ['unauthorized', 'clock_skew', 'not_paired', 'not_secondary']) {
    const { relayCalls, res } = await run({ ok: false, reason });
    assert.equal(relayCalls, 0, `${reason} — это поломка, которую надо чинить, а не обходить копией`);
    assert.equal(res.relay_reason, undefined);
  }

  // Удачный прямой путь не идёт к поставщику вовсе — данные не покидают клинику.
  let relayCalls = 0;
  const ok = await branchSyncNow(db, {}, admin, {
    pullImpl: async () => ({ ok: true, catalogue: {} }),
    relayImpl: async () => { relayCalls++; return { ok: true }; },
    backupImpl: async () => {},
  });
  assert.equal(relayCalls, 0, 'пока прямая связь работает, поставщик в этой цепочке не участвует');
  assert.equal(ok.ok, true);
  assert.equal(ok.route, 'direct');
  db.close();
});

// --- BRANCH_IDENTITY_V1 ------------------------------------------------------
//
// НАСТОЯЩИЙ ВТОРОЙ ФИЛИАЛ, а не вторая активированная клиника. Тест выше сводил
// два филиала, каждый из которых активирован у поставщика ОТДЕЛЬНО — это удобно
// для проверки транспорта и непохоже на жизнь: филиал подключается к клинике, а
// не к поставщику, у него нет ни кода активации, ни install_token-а, и по
// резервному каналу ему ходить было нечем.
//
// Задачи 4 и 5 построили для этого весь механизм — поставщик выписывает главному
// филиалу узкий токен на один адрес, ключ подключения его переносит, pairing.js
// кладёт на диск, — и на этом всё обрывалось: токен на диске никто не читал.
// Проверяется здесь сквозной путь целиком, вплоть до номера пациента с буквой
// филиала и до отзыва токена.
test('филиал, не активированный у поставщика: буква и токен приезжают в ключе и работают', async (t) => {
  const cpDb = openCpDb(':memory:');
  migrateCp(cpDb);
  const cp = await listen(createCpApp(cpDb));
  // ОДНА активация на всю группу — у главного филиала. Второго кода активации
  // никто не выдаёт, и это ровно то, что здесь проверяется.
  const tokenMain = redeemEnrollmentCode(cpDb, {
    code: createEnrollmentCode(cpDb, { clinicId: 'cp-clinic', name: 'Клиника' }),
  }).install_token;

  const prevControlUrl = process.env.EASYMED_CONTROL_URL;
  process.env.EASYMED_CONTROL_URL = cp.base;

  // Лицензия у обоих одна (licensedDataDir выдаёт новый ключ подписи на каждый
  // вызов, поэтому второй каталог получается копированием файлов первого).
  // install_token дописывается ТОЛЬКО главному — у филиала его нет и не будет.
  const secDir = licensedDataDir();
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay-branch-'));
  for (const f of ['control.json', 'licence.dat']) fs.copyFileSync(path.join(secDir, f), path.join(mainDir, f));
  withInstallToken(mainDir, tokenMain);

  const dbMain = install(mainDir, 'main');
  seedMain(dbMain);
  const main = await listen(createApp(dbMain, { dataDir: mainDir }));
  const dbSec = install(secDir, 'sec');

  let sec = null;
  let secCookie = null;
  t.after(async () => {
    if (sec) await shutdown(sec.server);
    try { await shutdown(main.server); } catch { /* уже закрыт этим же тестом */ }
    await shutdown(cp.server);
    dbSec.close(); dbMain.close(); cpDb.close();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(secDir, { recursive: true, force: true });
    if (prevControlUrl === undefined) delete process.env.EASYMED_CONTROL_URL;
    else process.env.EASYMED_CONTROL_URL = prevControlUrl;
  });

  const mainCookie = await login(main.base);
  let branchKey = null;
  let minted = null;
  let relayId = null;

  await t.test('главный филиал выписывает филиалу узкий токен и вкладывает его в ключ', async () => {
    assert.equal((await rpc(main.base, mainCookie, 'branch_sync_make_key', { url: main.base })).status, 200);
    assert.equal((await rpc(main.base, mainCookie, 'branch_sync_relay_set', { enabled: true })).status, 200);
    const pub = await rpc(main.base, mainCookie, 'branch_sync_relay_publish');
    assert.equal(pub.data.ok, true, JSON.stringify(pub.data));

    const pairing = readPairing(mainDir);
    relayId = relayIdFor(pairing.group_key);

    // Выписывает ГЛАВНЫЙ и своим install_token-ом: он единственный в группе, у
    // кого есть личность у поставщика.
    const res = await fetch(cp.base + RELAY_TOKEN_MOUNT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMain}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay_id: relayId }),
    });
    assert.equal(res.status, 201, 'активированная клиника вправе выписать токен на свой адрес');
    minted = (await res.json()).token;

    // Ключ, который владелец несёт во второе здание: адрес, секрет, ключ
    // шифрования, БУКВА филиала и токен. Через сервер поставщика он не проходит.
    branchKey = encodeKey({ ...pairing, letter: 'B', relay_token: minted });
  });

  await t.test('филиал принимает ключ: буква ложится в базу, токен — на диск', async () => {
    sec = await listen(createApp(dbSec, { dataDir: secDir }));
    secCookie = await login(sec.base);

    const r = await rpc(sec.base, secCookie, 'branch_sync_pair', { key: branchKey });
    assert.equal(r.status, 200, JSON.stringify(r.error));

    assert.deepEqual(dbSec.prepare('SELECT letter, role FROM branch_identity WHERE id = 1').get(),
      { letter: 'B', role: 'secondary' }, 'установка узнала, каким филиалом она является');
    assert.equal(readPairing(secDir).relay_token, minted, 'токен доехал ключом и лёг в запись');
    assert.equal('install_token' in JSON.parse(fs.readFileSync(path.join(secDir, 'control.json'), 'utf8')),
      false, 'у филиала нет и не должно быть учётной записи у поставщика');

    // То, ради чего буква вообще заведена: номера этого здания не пересекаются
    // с номерами главного филиала.
    dbSec.prepare("INSERT INTO patients (full_name) VALUES ('Пациент филиала')").run();
    assert.match(dbSec.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get().mrn, /^B-/);
  });

  await t.test('главный выключен — справочник приходит через сервер по токену из ключа', async () => {
    dbMain.prepare("UPDATE services SET price = 320000 WHERE code='S-CARD'").run();
    assert.equal((await publishCatalogue(dbMain, mainDir)).ok, true);
    await shutdown(main.server);

    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.equal(r.data.route, 'relay');
    assert.equal(priceOf(dbSec, 'S-CARD'), 320000, 'цена главного филиала доехала через сервер поставщика');
    assert.deepEqual(clinicalCounts(dbSec), { patients: 1, visits: 0, invoices: 0, invoice_items: 0 },
      'приехал справочник и только он: свой пациент на месте, чужих нет');

    // Именно ЭТИМ токеном: поставщик отмечает последнее использование.
    const row = cpDb.prepare('SELECT relay_id, last_used FROM relay_tokens WHERE token = ?').get(minted);
    assert.equal(row.relay_id, relayId);
    assert.ok(row.last_used, 'ходили токеном из ключа, а не чем-то ещё');
  });

  await t.test('отзыв токена отключает ИМЕННО этот филиал, и сразу', async () => {
    // Ради этого свойства токен из ключа и предпочитается install_token-у:
    // отозвать учётку одного филиала можно, не трогая клинику.
    cpDb.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE token = ?')
      .run(new Date().toISOString(), minted);

    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.data.ok, false);
    assert.equal(r.data.reason, 'offline', 'первопричина по-прежнему — выключенный главный филиал');
    // ИЗМЕНЁННЫЙ КОД, тот же отказ: 401 у ПОДКЛЮЧЁННОГО филиала теперь
    // называется relay_branch_revoked. Прежнее relay_unauthorized уводило
    // владельца в «проверьте активацию клиники», тогда как случившееся чинится
    // на другой машине и одним действием — новым ключом подключения из главного
    // филиала (rpc/branch-sync.js REASONS).
    assert.equal(r.data.relay_reason, 'relay_branch_revoked');

    // А блоб на месте, и главный филиал ничего не потерял: отозвана учётка
    // филиала, а не клиники.
    const ok = await fetch(cp.base + relayPathFor(relayId), { headers: { Authorization: 'Bearer ' + tokenMain } });
    assert.equal(ok.status, 200);
  });
});

// BRANCH_RECORDS_V1 (Задача 7a) — ДВА ВТОРИЧНЫХ ФИЛИАЛА, и выгружает вторичный.
//
// Почему именно так, и почему ни один прежний тест этого не показывал: главная
// клиника ходит к поставщику по install_token, который к адресу не привязан
// ВОВСЕ, — её выгрузка проходит при любой ошибке в области токена. Вторичный
// филиал не имеет ничего, кроме токена из ключа подключения, и до этой задачи
// токен разрешал ровно один адрес — справочник. Значит, в Фазе 2 выгрузка
// журнала со ВТОРИЧНОГО филиала (свой адрес relayIdFor(ключ, буква)) была бы
// 401 → relay_branch_revoked → «возьмите новый ключ у главной» — неверный совет
// на ошибку кода, и на одной машине его не увидеть.
//
// Настоящая контрольная панель, настоящий HTTP, настоящая проверка доступа.
// Клиентские установки здесь не поднимаются: проверяется выписка (клиентская
// функция mintRelayToken) и то, что выписанным токеном МОЖНО сделать, — а для
// этого филиалу нужен каталог данных с парой и install_token главной, не больше.
test('Задача 7a: вторичный филиал пишет по СВОЕМУ адресу, второй вторичный читает', async (t) => {
  const cpDb = openCpDb(':memory:');
  migrateCp(cpDb);
  const cp = await listen(createCpApp(cpDb));
  const installToken = redeemEnrollmentCode(cpDb, {
    code: createEnrollmentCode(cpDb, { clinicId: 'cp-group', name: 'Сеть' }),
  }).install_token;

  // Каталог данных ГЛАВНОЙ клиники: пара с ключом группы и учётка у поставщика.
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay-7a-'));
  const groupKey = b64url(randomBytes(GROUP_KEY_BYTES));
  fs.writeFileSync(path.join(mainDir, 'control.json'),
    JSON.stringify({ clinic_id: 'cp-group', install_token: installToken }));
  writePairing(mainDir, {
    role: 'main', group_id: 'BR-7A0000000001', secret: 'sss',
    main_url: 'http://10.0.0.5:8000', group_key: groupKey, relay: true,
  });

  t.after(async () => {
    await shutdown(cp.server);
    cpDb.close();
    fs.rmSync(mainDir, { recursive: true, force: true });
  });

  const env = { EASYMED_CONTROL_URL: cp.base };
  // Сеть из трёх зданий: A — главное, B и C — филиалы. Буквы приходят из
  // таблицы branches главной клиники, ровно так их и передаёт
  // rpc/branch-sync.js ensureBranchToken.
  const letters = ['A', 'B', 'C'];
  const mintedB = await mintRelayToken(mainDir, { env, letters });
  const mintedC = await mintRelayToken(mainDir, { env, letters });
  assert.equal(mintedB.ok, true, JSON.stringify(mintedB));
  assert.equal(mintedC.ok, true, JSON.stringify(mintedC));

  // ОДНА строка токена на филиал, а не по строке на адрес: иначе сеть из девяти
  // зданий упирается в потолок клиники (MAX_LIVE_TOKENS_PER_CLINIC = 64) на
  // ровном месте.
  assert.equal(cpDb.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 2);
  assert.equal(cpDb.prepare('SELECT COUNT(*) n FROM relay_token_scopes').get().n, 54,
    'справочник и 26 узлов алфавита × 2 филиала');

  const addr = (letter) => cp.base + relayPathFor(relayIdFor(groupKey, letter));
  const blob = Buffer.from('журнал филиала B, зашифрованный');

  // ВОТ ОНО: вторичный филиал выгружает СВОЙ журнал по СВОЕМУ адресу, своим
  // токеном из ключа подключения. До Задачи 7a — 401.
  const up = await fetch(addr('B'), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${mintedB.token}`, 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  assert.equal(up.status, 200, 'вторичный филиал обязан уметь писать по адресу своего узла');

  // И второй вторичный его читает — обмен между филиалами, а не только вниз от
  // главной.
  const down = await fetch(addr('B'), { headers: { Authorization: `Bearer ${mintedC.token}` } });
  assert.equal(down.status, 200, 'сосед обязан уметь прочитать чужой узел');
  assert.equal(Buffer.from(await down.arrayBuffer()).toString(), blob.toString());

  // Справочник по-прежнему доступен обоим: адрес группы входит в область.
  for (const [name, m] of [['B', mintedB], ['C', mintedC]]) {
    const res = await fetch(cp.base + relayPathFor(relayIdFor(groupKey)), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${m.token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    assert.equal(res.status, 200, 'филиал ' + name + ' обязан видеть справочник');
  }

  // Область осталась ОБЛАСТЬЮ. Алфавит A..Z выдаётся авансом (иначе филиал,
  // заведённый позже, никто не прочтёт — см. тест ниже), но шире него токен не пускает:
  // ни к многобуквенному узлу чужой большой сети, ни к адресу другой группы.
  for (const [what, id] of [
    ['многобуквенный узел', relayIdFor(groupKey, 'AA')],
    ['чужая группа', relayIdFor(b64url(randomBytes(GROUP_KEY_BYTES)))],
  ]) {
    const outside = await fetch(cp.base + relayPathFor(id), {
      headers: { Authorization: `Bearer ${mintedB.token}` },
    });
    assert.equal(outside.status, 401, 'шире выписанного токен не пускает: ' + what);
  }

  // И отзыв по-прежнему выключает ИМЕННО этот филиал — сразу и на всех адресах.
  cpDb.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE token = ?')
    .run(new Date().toISOString(), mintedC.token);
  assert.equal((await fetch(addr('B'), { headers: { Authorization: `Bearer ${mintedC.token}` } })).status, 401);
  assert.equal((await fetch(addr('B'), { headers: { Authorization: `Bearer ${mintedB.token}` } })).status, 200,
    'сосед филиала C ничего не потерял');
});

// Потолок области — ОДНО число на две стороны, и разъехаться им нельзя.
//
// Тот же приём, что держит вместе RELAY_ID_RE выписки и релея
// (relay-token.route.test.js): клиника режет список по своему числу, сервер
// отказывает по своему. Стань клиентское больше — сеть получала бы 400 и
// оставалась БЕЗ ТОКЕНА; стань меньше — клиника молча роняла бы соседей,
// которых сервер принял бы. Здесь оба значения сравниваются напрямую, потому
// что этот файл — единственное место, которое видит обе половины сразу.
test('потолок области у клиники и у поставщика — одно и то же число', () => {
  assert.equal(MAX_SCOPE, MAX_SCOPE_CP);
});

// BRANCH_RECORDS_V1 (Задача 7a) — филиал, заведённый ПОСЛЕ выдачи ключа соседу.
//
// Настоящий порядок событий в клинике, а не крайний случай: филиалы заводят по
// одному, месяцами. Область токена считается ОДИН РАЗ — ensureBranchToken
// выписывает только если токена ещё нет, а ключ подключения потом собирается из
// СОХРАНЁННОГО токена (branchKeyFor). Значит, у филиала B, получившего ключ,
// когда в сети были только A и B, права на адрес филиала C не появятся никогда:
// ни повторный показ ключа, ни новый ключ подключения не перевыписывают токен.
// Чтение журнала C давало бы 401 → «доступ отозван» → «возьмите новый ключ»,
// и новый ключ не чинил бы ничего.
test('Задача 7a: токен, выписанный ДО появления филиала C, пускает его к адресу C', async (t) => {
  const cpDb = openCpDb(':memory:');
  migrateCp(cpDb);
  const cp = await listen(createCpApp(cpDb));
  const installToken = redeemEnrollmentCode(cpDb, {
    code: createEnrollmentCode(cpDb, { clinicId: 'cp-later', name: 'Сеть' }),
  }).install_token;

  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay-7a-later-'));
  const groupKey = b64url(randomBytes(GROUP_KEY_BYTES));
  fs.writeFileSync(path.join(mainDir, 'control.json'),
    JSON.stringify({ clinic_id: 'cp-later', install_token: installToken }));
  writePairing(mainDir, {
    role: 'main', group_id: 'BR-7A0000000002', secret: 'sss',
    main_url: 'http://10.0.0.5:8000', group_key: groupKey, relay: true,
  });

  t.after(async () => {
    await shutdown(cp.server);
    cpDb.close();
    fs.rmSync(mainDir, { recursive: true, force: true });
  });

  const env = { EASYMED_CONTROL_URL: cp.base };
  // МОМЕНТ t₁: в сети два здания. Филиал C ещё даже не задуман.
  const mintedB = await mintRelayToken(mainDir, { env, letters: ['A', 'B'] });
  assert.equal(mintedB.ok, true, JSON.stringify(mintedB));
  assert.equal(cpDb.prepare('SELECT COUNT(*) n FROM relay_token_scopes WHERE token = ?')
    .get(mintedB.token).n, 27, 'справочник и весь алфавит узлов');

  // МОМЕНТ t₂, месяцем позже: заводят филиал C, он получает свой токен и
  // выкладывает журнал по своему адресу.
  const mintedC = await mintRelayToken(mainDir, { env, letters: ['A', 'B', 'C'] });
  assert.equal(mintedC.ok, true, JSON.stringify(mintedC));
  const addrC = cp.base + relayPathFor(relayIdFor(groupKey, 'C'));
  assert.equal((await fetch(addrC, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${mintedC.token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('журнал филиала C'),
  })).status, 200);

  // И ВОТ ОНО: старый токен B читает нового соседа. Без предварительной выдачи
  // алфавита здесь был бы 401, а на экране — «главный филиал отозвал доступ».
  const read = await fetch(addrC, { headers: { Authorization: `Bearer ${mintedB.token}` } });
  assert.equal(read.status, 200, 'токен, выписанный до появления C, обязан читать журнал C');
  assert.equal(Buffer.from(await read.arrayBuffer()).toString(), 'журнал филиала C');

  // Область осталась ОБЛАСТЬЮ: адрес вне алфавита закрыт обоим.
  const outside = cp.base + relayPathFor(relayIdFor(groupKey, 'AA'));
  assert.equal((await fetch(outside, { headers: { Authorization: `Bearer ${mintedB.token}` } })).status, 401,
    'алфавит — это A..Z, а не «любой адрес группы»');
});
