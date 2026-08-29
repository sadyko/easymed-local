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
import { readPairing, writePairing, makeMainKey, b64url, GROUP_KEY_BYTES } from './pairing.js';
import { relayIdFor } from './relay-crypto.js';
import { publishCatalogue } from './relay.js';
import { readSyncGroup, regenerateSyncGroup } from './sync-group.js';

import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createApp as createCpApp } from '../../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';
import { relayPathFor } from '../../../control-plane/server/routes/relay.js';

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
