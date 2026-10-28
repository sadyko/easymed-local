// SOFTPHONE_V1 — вход телефона Easy-Med в АТС: только СВОЙ внутренний номер, только с правом набора,
// не от чужого имени; пароль не выходит никуда, кроме ответа владельцу номера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyWebrtcMe, telephonyCaller } from './phone.js';
import { RpcError } from './telephony.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc, isReadRpc, isAlwaysAllowedRpc } from '../control/gate.js';
import { DIAL_MESSAGES } from '../telephony/dial.js';

function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

const PASSWORD = 'p'.repeat(32);

// Оператор (набор + журнал), врач (ничего), лаборант (только журнал). Права —
// явно: миграция 141 уже записала ролям свои значения, проверяем ровно то, что выдали.
function seed({ ext = '108', line = true, enabled = 1 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  setGrants(db, 'registrar', { 'crm.dial': 'edit', 'crm.calls': 'view' });
  setGrants(db, 'doctor', { 'crm.dial': 'none', 'crm.calls': 'none' });
  setGrants(db, 'lab', { 'crm.dial': 'none', 'crm.calls': 'view' });
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (1,'op','x','Оператор','registrar',?)").run(ext);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Врач','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (3,'lab','x','Лаборант','lab','109')").run();
  if (line) {
    db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
                VALUES ('onlinepbx', 'onlinepbx', 'АТС', ?, ?, ?, 30)`)
      .run(enabled, JSON.stringify({ domain: 'pbx38631.onpbx.ru' }), JSON.stringify({ auth_key: 'k', key_id: 'kid', key: 'kv' }));
  }
  return db;
}
const OP = { id: 1, role: 'registrar', full_name: 'Оператор', acting_admin: null };
const DOC = { id: 2, role: 'doctor', full_name: 'Врач', acting_admin: null };
const LAB = { id: 3, role: 'lab', full_name: 'Лаборант', acting_admin: null };
function fakePbx(reply) {
  const calls = [];
  const impl = async (domain, path, params) => { calls.push({ domain, path, params }); return reply; };
  return { impl, calls };
}
const OK_108 = { ok: true, data: [{ num: '108', name: 'x', enabled: true, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '108', password: PASSWORD } }] };
const refused = (status, re) => (e) => e instanceof RpcError && e.status === status && (!re || re.test(e.message));

test('свой номер: host, user, password, ws_url и sip_domain; поля — СТРОКОЙ через запятую', async () => {
  const db = seed();
  const pbx = fakePbx(OK_108);
  const r = await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: pbx.impl });
  assert.deepEqual(r, { extension: '108', user: '108', password: PASSWORD, ws_url: 'wss://pbx38631.onpbx.ru:8082', sip_domain: 'pbx38631.onpbx.ru' });
  assert.equal(pbx.calls.length, 1);
  assert.equal(pbx.calls[0].domain, 'pbx38631.onpbx.ru');
  assert.equal(pbx.calls[0].path, 'user/get.json');
  // Массивом onlinePBX поля молча не замечает — и webrtc не отдаёт.
  assert.deepEqual(pbx.calls[0].params, { num: '108', fields: 'num,name,enabled,webrtc' });
});

test('без внутреннего номера — 400 со словами; без права набора — 403; от чужого имени — 403', async () => {
  const pbx = fakePbx(OK_108);
  await assert.rejects(telephonyWebrtcMe(seed({ ext: null }), {}, OP, { pbxCallImpl: pbx.impl }), refused(400, /внутренний номер/));
  await assert.rejects(telephonyWebrtcMe(seed({ ext: '  ' }), {}, OP, { pbxCallImpl: pbx.impl }), refused(400, /внутренний номер/));
  await assert.rejects(telephonyWebrtcMe(seed(), {}, DOC, { pbxCallImpl: pbx.impl }), refused(403));
  // Журнал без набора — не повод входить в АТС.
  await assert.rejects(telephonyWebrtcMe(seed(), {}, LAB, { pbxCallImpl: pbx.impl }), refused(403));
  await assert.rejects(telephonyWebrtcMe(seed(), {}, { ...OP, acting_admin: { id: 9, full_name: 'Адм' } }, { pbxCallImpl: pbx.impl }),
    refused(403, /чужого имени/));
  assert.equal(pbx.calls.length, 0, 'станцию спросили, хотя вход запрещён');
});

test('нет линии onlinePBX (нет вовсе или выключена) — 400 со словами', async () => {
  const pbx = fakePbx(OK_108);
  await assert.rejects(telephonyWebrtcMe(seed({ line: false }), {}, OP, { pbxCallImpl: pbx.impl }), refused(400, /Линия onlinePBX не подключена/));
  await assert.rejects(telephonyWebrtcMe(seed({ enabled: 0 }), {}, OP, { pbxCallImpl: pbx.impl }), refused(400, /Линия onlinePBX не подключена/));
  assert.equal(pbx.calls.length, 0);
});

// Чужой номер — чужие звонки: номер берётся из карточки сотрудника, не из запроса.
test('только свой номер: запрос не перенаправит вход на чужую трубку', async () => {
  const db = seed();
  const pbx = fakePbx(OK_108);
  const r = await telephonyWebrtcMe(db, { num: '999', extension: '999', user_id: 2, id: 2 }, OP, { pbxCallImpl: pbx.impl });
  assert.equal(r.extension, '108');
  assert.equal(pbx.calls[0].params.num, '108', 'станцию спросили про номер из запроса');
});

test('станция не дала webrtc номеру — 409 со словами, пароль не придуман', async () => {
  const pbx = fakePbx({ ok: true, data: [{ num: '108', enabled: true }] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }), refused(409, /браузер/));
  const half = fakePbx({ ok: true, data: [{ num: '108', enabled: true, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '108', password: '' } }] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: half.impl }), refused(409, /браузер/));
  const off = fakePbx({ ok: true, data: [{ num: '108', enabled: false, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '108', password: PASSWORD } }] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: off.impl }), refused(409, /браузер/));
  const empty = fakePbx({ ok: true, data: [] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: empty.impl }), refused(409, /браузер/));
});

test('webrtc другого номера в ответе не отдаётся: пароль трубки 107 владельцу 108 не уходит', async () => {
  const pbx = fakePbx({ ok: true, data: [
    { num: '107', enabled: true, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '107', password: 'q'.repeat(32) } },
    { num: '108', enabled: true },
  ] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }),
    (e) => refused(409, /браузер/)(e) && !e.message.includes('q'.repeat(32)));
});

// Отказ станции — не поломка сервера. Маршрут RPC (routes/rpc.js) прячет всё, что
// 500 и выше, за «Ошибка сервера», поэтому — 400 словами клиники, как у
// «Позвонить» (telephonyDial): ключей и адресов в этих словах нет.
test('станция ответила ошибкой — отказ с её причиной словами, не 500; чужой текст станции не эхом', async () => {
  const bad = fakePbx({ ok: false, reason: 'bad_credentials', comment: 'Wrong auth key k-SECRET-123' });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: bad.impl }), (e) => e instanceof RpcError
    && e.status === 400 && e.message === DIAL_MESSAGES.bad_credentials && !e.message.includes('SECRET'));
  const off = fakePbx({ ok: false, reason: 'offline' });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: off.impl }),
    (e) => e.status < 500 && e.message === DIAL_MESSAGES.offline);
  const odd = fakePbx({ ok: false, reason: 'something_new' });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: odd.impl }),
    (e) => e.status < 500 && e.message === DIAL_MESSAGES.server_error);
});

test('пароль не пишется ни в базу, ни в журнал сервера', async () => {
  const db = seed();
  const pbx = fakePbx(OK_108);
  const said = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { said.push(a.map(String).join(' ')); };
  try {
    assert.equal((await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: pbx.impl })).password, PASSWORD);
  } finally { Object.assign(console, orig); }
  assert.ok(!said.some((s) => s.includes(PASSWORD)), 'пароль трубки попал в журнал сервера');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  assert.ok(tables.length > 20, 'таблиц нет — проверка ничего бы не нашла');
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).all()) {
      for (const [col, v] of Object.entries(row)) {
        if (v == null) continue;
        const s = Buffer.isBuffer(v) ? v.toString('latin1') : String(v);
        assert.ok(!s.includes(PASSWORD), `пароль трубки записан в ${t}.${col}`);
      }
    }
  }
});

test('кто звонит: пациент и заявка по номеру; дверь — право набора или журнала', () => {
  const db = seed();
  const pid = db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES ('Каримова Азиза', '+998 90 111 22 33', 'A-12')").run().lastInsertRowid;
  const lid = db.prepare("INSERT INTO crm_requests (full_name, phone, status, source) VALUES ('Заявка Тестовая', '+998 90 111 22 33', 'in_process', 'call')").run().lastInsertRowid;
  const r = telephonyCaller(db, { number: '998901112233' }, OP);
  assert.equal(r.patient.id, pid);
  assert.equal(r.patient.mrn, 'A-12');
  assert.equal(r.patient.full_name, 'Каримова Азиза');
  assert.equal(r.lead.id, lid);
  // Номер как его прислала станция — с плюсом и пробелами — тот же человек.
  assert.equal(telephonyCaller(db, { number: '+998 (90) 111-22-33' }, OP).patient.id, pid);
  // Только журнал — тоже можно: входящий видит и тот, кто смотрит журнал.
  assert.equal(telephonyCaller(db, { number: '998901112233' }, LAB).patient.id, pid);
  assert.throws(() => telephonyCaller(db, { number: '998901112233' }, DOC), refused(403));
  assert.deepEqual(telephonyCaller(db, { number: '' }, OP), { patient: null, lead: null });
  assert.deepEqual(telephonyCaller(db, {}, OP), { patient: null, lead: null });
  assert.deepEqual(telephonyCaller(db, { number: '998935550199' }, OP), { patient: null, lead: null });
});

test('регистрация RPC и ворота лицензии', () => {
  assert.equal(typeof getRpc('telephony_webrtc_me'), 'function');
  assert.equal(typeof getRpc('telephony_caller'), 'function');
  assert.equal(isReadOnlyRpc('telephony_caller'), true, '«кто звонит» — чтение, при блокировке отвечает');
  assert.equal(isReadOnlyRpc('telephony_webrtc_me'), false, 'при блокировке телефон закрыт, как экран «Телефония»');
  assert.equal(isAlwaysAllowedRpc('telephony_webrtc_me'), false);
  // Журнал входа от имени: «кто звонит» — чтение; вход в АТС — действие (выдаёт пароль трубки).
  assert.equal(isReadRpc('telephony_caller'), true);
  assert.equal(isReadRpc('telephony_webrtc_me'), false, 'вход в АТС — действие, журнал входа от имени его считает');
});

// Политика страницы пускает только wss://*.onpbx.ru:* — другой адрес браузер молча
// не откроет, а пароль трубки уже ушёл бы. Чужой адрес — тот же отказ, без пароля.
test('адрес АТС не из *.onpbx.ru — 409 со словами, пароль не отдаётся', async () => {
  const leak = 'z'.repeat(32);
  for (const host of ['evil.example.com:8082', 'onpbx.ru:8082', 'pbx38631.onpbx.ru.evil.com', 'pbx38631.onpbx.ru:8082/x',
    'user@pbx38631.onpbx.ru', 'pbx38631.onpbx.ru:', 'pbx38631.onpbx.ru:123456', 'pbx 1.onpbx.ru', 'pbx38631.onpbx.ru:8082?x=1',
    'pbx38631.onpbx.ru:8082\n']) {
    const pbx = fakePbx({ ok: true, data: [{ num: '108', enabled: true, webrtc: { host, user: '108', password: leak } }] });
    await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }),
      (e) => refused(409, /браузер/)(e) && !e.message.includes(leak), JSON.stringify(host));
  }
  // Без порта и с несколькими уровнями — свой адрес.
  for (const [host, domain] of [['pbx38631.onpbx.ru', 'pbx38631.onpbx.ru'], ['a-1.b.onpbx.ru:443', 'a-1.b.onpbx.ru']]) {
    const pbx = fakePbx({ ok: true, data: [{ num: '108', enabled: true, webrtc: { host, user: '108', password: PASSWORD } }] });
    const r = await telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl });
    assert.equal(r.ws_url, 'wss://' + host);
    assert.equal(r.sip_domain, domain);
  }
});

// Станция может прислать data объектом — по номеру или с вложенным data: ищем так же,
// и так же только СВОЙ номер.
test('ответ станции объектом (по номеру или {data:[…]}) — тот же поиск своего номера', async () => {
  const w108 = { host: 'pbx38631.onpbx.ru:8082', user: '108', password: PASSWORD };
  const w107 = { host: 'pbx38631.onpbx.ru:8082', user: '107', password: 'q'.repeat(32) };
  for (const data of [
    { 107: { num: '107', enabled: true, webrtc: w107 }, 108: { num: '108', enabled: true, webrtc: w108 } },
    { data: [{ num: '107', enabled: true, webrtc: w107 }, { num: 108, enabled: true, webrtc: w108 }] },
    { num: '108', enabled: true, webrtc: w108 },
  ]) {
    const pbx = fakePbx({ ok: true, data });
    const r = await telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl });
    assert.equal(r.user, '108');
    assert.equal(r.password, PASSWORD);
  }
  // Объектом, но своего номера нет — чужой пароль не отдаётся.
  for (const data of [{ 107: { num: '107', enabled: true, webrtc: w107 } }, { data: [{ num: '107', enabled: true, webrtc: w107 }] },
    { num: '107', enabled: true, webrtc: w107 }, 'текст', null]) {
    const pbx = fakePbx({ ok: true, data });
    await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }),
      (e) => refused(409, /браузер/)(e) && !e.message.includes('q'.repeat(32)));
  }
});
