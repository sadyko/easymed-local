// SOFTPHONE_V1 — вход телефона Easy-Med в АТС: только СВОЙ внутренний номер, только с правом набора,
// не от чужого имени; пароль не выходит никуда, кроме ответа владельцу номера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyWebrtcMe, telephonyCaller, telephonyMyExtension, telephonyPhoneMe, webrtcCacheSize, WEBRTC_CACHE_MS } from './phone.js';
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
// assigned — номер, назначенный оператору в карточке сотрудника (по умолчанию — его же).
function seed({ ext = '108', assigned = ext, line = true, enabled = 1 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  setGrants(db, 'registrar', { 'crm.dial': 'edit', 'crm.calls': 'view' });
  setGrants(db, 'doctor', { 'crm.dial': 'none', 'crm.calls': 'none' });
  setGrants(db, 'lab', { 'crm.dial': 'none', 'crm.calls': 'view' });
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension, pbx_extension_assigned) VALUES (1,'op','x','Оператор','registrar',?,?)")
    .run(ext, assigned);
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

// РЕШЕНИЕ ВЛАДЕЛЬЦА («Only admin assigns»). Браузер получает пароль SIP номера —
// а он работает в любой SIP-программе и после увольнения. Поэтому телефон Easy-Med
// включается только на номере, который назначен в карточке сотрудника; «Моя
// трубка» по-прежнему выбирает трубку для «Позвонить», но не для входа в АТС.
test('номер, выбранный себе в «Моя трубка», а не назначенный, — 403, станцию не спрашивают (кража чужого номера)', async () => {
  const db = seed();   // назначен 108
  const pbx = fakePbx({ ok: true, data: [{ num: '107', enabled: true, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '107', password: 'q'.repeat(32) } }] });
  telephonyMyExtension(db, { extension: '107' }, OP);   // «Моя трубка» — чужой номер 107
  await assert.rejects(telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: pbx.impl }),
    refused(403, /администратор назначил вам в карточке сотрудника/));
  assert.equal(pbx.calls.length, 0, 'станцию спросили о пароле номера, которого администратор не назначал');
  assert.equal(db.prepare('SELECT pbx_extension_assigned FROM users WHERE id = 1').get().pbx_extension_assigned, '108',
    '«Моя трубка» переписала назначенный номер');
  // Вернулся на свой 108 — телефон работает.
  telephonyMyExtension(db, { extension: '108' }, OP);
  const ok = fakePbx(OK_108);
  assert.equal((await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: ok.impl })).password, PASSWORD);
  assert.equal(ok.calls[0].params.num, '108');
});

test('номер не назначен вовсе — 403, станцию не спрашивают', async () => {
  const pbx = fakePbx(OK_108);
  await assert.rejects(telephonyWebrtcMe(seed({ assigned: null }), {}, OP, { pbxCallImpl: pbx.impl }), refused(403, /администратор назначил/));
  await assert.rejects(telephonyWebrtcMe(seed({ assigned: '  ' }), {}, OP, { pbxCallImpl: pbx.impl }), refused(403, /администратор назначил/));
  assert.equal(pbx.calls.length, 0);
  // Назначенный с пробелами по краям — тот же номер.
  const ok = fakePbx(OK_108);
  assert.equal((await telephonyWebrtcMe(seed({ assigned: ' 108 ' }), {}, OP, { pbxCallImpl: ok.impl })).extension, '108');
});

test('«кто я» говорит, на каком номере включается телефон Easy-Med', () => {
  assert.equal(telephonyPhoneMe(seed(), {}, OP).softphone_extension, '108');
  assert.equal(telephonyPhoneMe(seed({ assigned: null }), {}, OP).softphone_extension, '');
  const db = seed({ ext: '107', assigned: '108' });
  const me = telephonyPhoneMe(db, {}, OP);
  assert.equal(me.extension, '107');
  assert.equal(me.softphone_extension, '108', 'панель не узнает, почему телефон выключен');
  // Журнал без набора видит «кто я» — номер для телефона ему ни к чему, но и не секрет.
  assert.equal(typeof telephonyPhoneMe(db, {}, LAB).softphone_extension, 'string');
});

// SOFTPHONE_V1 (M1) — телефон Easy-Med работает только через onlinePBX: у клиники на
// Binotel или «Моих Звонках» переключателя не должно быть вовсе.
test('«кто я»: softphone_available — есть ли включённая линия onlinePBX', () => {
  assert.equal(telephonyPhoneMe(seed(), {}, OP).softphone_available, true);
  assert.equal(telephonyPhoneMe(seed({ line: false }), {}, OP).softphone_available, false);
  assert.equal(telephonyPhoneMe(seed({ enabled: 0 }), {}, OP).softphone_available, false);
  // «Мои Звонки» живут в той же таблице (kind onlinepbx, vendor moizvonki) — это не onlinePBX.
  const mz = seed({ line: false });
  mz.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
              VALUES ('onlinepbx', 'moizvonki', 'Мои Звонки', 1, '{"domain":"clinic.moizvonki.ru"}', '{}', 30)`).run();
  assert.equal(telephonyPhoneMe(mz, {}, OP).softphone_available, false, '«Мои Звонки» приняты за onlinePBX');
  assert.equal(typeof telephonyPhoneMe(seed(), {}, LAB).softphone_available, 'boolean');
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

// SOFTPHONE_V1 (M10) — станция пишет «выключен» по-разному: числом, строкой, словом.
test('номер выключен на станции (0, «0», false, «false») — 409, пароль не отдаётся', async () => {
  for (const enabled of [0, '0', false, 'false']) {
    const pbx = fakePbx({ ok: true, data: [{ num: '108', enabled, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '108', password: PASSWORD } }] });
    await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }),
      (e) => refused(409, /браузер/)(e) && !e.message.includes(PASSWORD), 'enabled = ' + JSON.stringify(enabled));
  }
  for (const enabled of [1, '1', true, 'true', undefined]) {
    const pbx = fakePbx({ ok: true, data: [{ num: '108', enabled, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: '108', password: PASSWORD } }] });
    assert.equal((await telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl })).password, PASSWORD, 'enabled = ' + JSON.stringify(enabled));
  }
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

// SOFTPHONE_V1 (I1) — временная беда станции (нет связи, «реже», ошибка, неразборчиво)
// несёт код station_unavailable: браузер повторит вход сам, с паузой. Постоянный отказ
// (ключ не подошёл, номер не назначен, нет линии, нет webrtc…) — без него: повтор не поможет.
test('временный отказ станции — код station_unavailable; постоянные отказы — без него', async () => {
  for (const reason of ['offline', 'rate_limited', 'bad_response', 'server_error', 'something_new', undefined]) {
    const pbx = fakePbx({ ok: false, reason });
    await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: pbx.impl }),
      (e) => e instanceof RpcError && e.status === 400 && e.code === 'station_unavailable', 'reason = ' + reason);
  }
  const notTransient = (e) => e instanceof RpcError && e.code !== 'station_unavailable';
  const bad = fakePbx({ ok: false, reason: 'bad_credentials' });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: bad.impl }), notTransient);
  const ok = fakePbx(OK_108);
  await assert.rejects(telephonyWebrtcMe(seed({ assigned: null }), {}, OP, { pbxCallImpl: ok.impl }), notTransient);
  await assert.rejects(telephonyWebrtcMe(seed({ ext: null }), {}, OP, { pbxCallImpl: ok.impl }), notTransient);
  await assert.rejects(telephonyWebrtcMe(seed(), {}, { ...OP, acting_admin: { id: 9 } }, { pbxCallImpl: ok.impl }), notTransient);
  await assert.rejects(telephonyWebrtcMe(seed({ line: false }), {}, OP, { pbxCallImpl: ok.impl }), notTransient);
  await assert.rejects(telephonyWebrtcMe(seed(), {}, DOC, { pbxCallImpl: ok.impl }), notTransient);
  const none = fakePbx({ ok: true, data: [{ num: '108', enabled: true }] });
  await assert.rejects(telephonyWebrtcMe(seed(), {}, OP, { pbxCallImpl: none.impl }), notTransient);
});

// SOFTPHONE_V1 (M5) — перезагрузки страниц у всех операторов разом не должны каждая
// спрашивать станцию: при протухшем ключе одновременные запросы выпускали бы новый
// ключ наперегонки и выбивали друг друга (ONLINEPBX_KEY_SHARE_V1). Успешный ответ
// живёт в памяти процесса минуту; одновременные вопросы ждут один ответ станции.
function deferredPbx(reply) {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const impl = async (domain, path, params) => { calls.push(params); await gate; return typeof reply === 'function' ? reply(params) : reply; };
  return { impl, calls, release };
}
const webrtcFor = (num) => ({ ok: true, data: [{ num, enabled: true, webrtc: { host: 'pbx38631.onpbx.ru:8082', user: num, password: PASSWORD } }] });

test('кэш входа: одновременные вопросы — один запрос к станции; повтор за минуту — без станции', async () => {
  const db = seed();
  let t = 1_000_000;
  const now = () => t;
  const pbx = deferredPbx(OK_108);
  const a = telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: pbx.impl, now });
  const b = telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: pbx.impl, now });
  await new Promise((r) => setImmediate(r));
  pbx.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(pbx.calls.length, 1, 'два одновременных входа — два запроса к станции');
  assert.equal(ra.password, PASSWORD);
  assert.deepEqual(ra, rb);
  ra.password = 'испорчено';   // ответ — копия: правка вызывающим не портит кэш
  t += 59_000;
  const again = fakePbx(OK_108);
  assert.equal((await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: again.impl, now })).password, PASSWORD);
  assert.equal(again.calls.length, 0, 'повтор в пределах минуты снова спросил станцию');
  t += 2_000;   // минута прошла
  const later = fakePbx(OK_108);
  await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: later.impl, now });
  assert.equal(later.calls.length, 1, 'после минуты станцию не спросили заново');
});

test('кэш входа: другой назначенный номер — не старый ответ; отказ очищает кэш; неудача не кэшируется', async () => {
  const db = seed();
  let t = 5_000_000;
  const now = () => t;
  await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: fakePbx(OK_108).impl, now });
  // Администратор назначил 109, оператор выбрал его — старый ответ (108) не годится.
  db.prepare("UPDATE users SET pbx_extension = '109', pbx_extension_assigned = '109' WHERE id = 1").run();
  const p109 = fakePbx(webrtcFor('109'));
  const r = await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: p109.impl, now });
  assert.equal(p109.calls.length, 1, 'новый номер получил чужой (прежний) ответ из кэша');
  assert.equal(r.extension, '109');
  assert.equal(r.user, '109');
  // Отказ (здесь — вход от чужого имени) очищает кэш: следующий вход снова спросит станцию.
  await assert.rejects(telephonyWebrtcMe(db, {}, { ...OP, acting_admin: { id: 9 } }, { pbxCallImpl: p109.impl, now }), refused(403));
  const after = fakePbx(webrtcFor('109'));
  await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: after.impl, now });
  assert.equal(after.calls.length, 1, 'после отказа вход взят из кэша');
  // Неудача станции не кэшируется — ни для одновременных, ни для следующего вопроса.
  const db2 = seed();
  const down = deferredPbx({ ok: false, reason: 'offline' });
  const x = telephonyWebrtcMe(db2, {}, OP, { pbxCallImpl: down.impl, now });
  const y = telephonyWebrtcMe(db2, {}, OP, { pbxCallImpl: down.impl, now });
  await new Promise((res) => setImmediate(res));
  down.release();
  await assert.rejects(x, (e) => e.code === 'station_unavailable');
  await assert.rejects(y, (e) => e.code === 'station_unavailable');
  assert.equal(down.calls.length, 1, 'одновременные неудачные входы — два запроса к станции');
  const up = fakePbx(OK_108);
  assert.equal((await telephonyWebrtcMe(db2, {}, OP, { pbxCallImpl: up.impl, now })).password, PASSWORD);
  assert.equal(up.calls.length, 1, 'неудача станции осталась в кэше');
});

// SOFTPHONE_V1 (M5, ревью) — пароль трубки не лежит в памяти сервера дольше минуты:
// запись удаляет таймер (unref — процесс он не держит), а каждый вопрос выметает
// просроченные. Удалённая или заменённая запись свой таймер снимает.
function fakeTimers() {
  const pending = new Map();
  let n = 0;
  const set = (fn, ms) => {
    const h = { id: ++n, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    pending.set(h.id, { fn, h });
    return h;
  };
  const clear = (h) => { if (h) pending.delete(h.id); };
  const fire = () => { for (const [id, p] of [...pending]) { pending.delete(id); p.fn(); } };
  return { timers: { set, clear }, pending, fire };
}
const OP2 = { id: 4, role: 'registrar', full_name: 'Оператор 2', acting_admin: null };
function seedTwo() {
  const db = seed();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension, pbx_extension_assigned) VALUES (4,'op2','x','Оператор 2','registrar','107','107')").run();
  return db;
}

test('кэш входа: запись живёт минуту — таймер (unref) удаляет её, и таймеров не остаётся', async () => {
  const db = seed();
  const t = 1_000_000;
  const ft = fakeTimers();
  await telephonyWebrtcMe(db, {}, OP, { pbxCallImpl: fakePbx(OK_108).impl, now: () => t, timers: ft.timers });
  assert.equal(webrtcCacheSize(db), 1);
  assert.equal(ft.pending.size, 1, 'у записи нет таймера удаления');
  const [{ h }] = [...ft.pending.values()];
  assert.equal(h.ms, WEBRTC_CACHE_MS);
  assert.equal(h.unrefed, true, 'таймер держит процесс сервера');
  ft.fire();
  assert.equal(webrtcCacheSize(db), 0, 'по таймеру пароль трубки не ушёл из памяти');
  assert.equal(ft.pending.size, 0);
});

test('кэш входа: просроченные записи выметаются при каждом вопросе; удалённая и заменённая снимают таймер', async () => {
  const db = seedTwo();
  let t = 2_000_000;
  const now = () => t;
  const ft = fakeTimers();
  const opts = (reply) => ({ pbxCallImpl: fakePbx(reply).impl, now, timers: ft.timers });
  await telephonyWebrtcMe(db, {}, OP, opts(OK_108));
  t += WEBRTC_CACHE_MS + 1;   // таймер не сработал (сон, занятый процесс) — запись просрочена
  await telephonyWebrtcMe(db, {}, OP2, opts(webrtcFor('107')));
  assert.equal(webrtcCacheSize(db), 1, 'просроченная запись первого оператора осталась в памяти');
  assert.equal(ft.pending.size, 1, 'таймер выметенной записи остался висеть');
  // Замена: тот же оператор после минуты — новый ответ, старый таймер снят.
  t += WEBRTC_CACHE_MS + 1;
  await telephonyWebrtcMe(db, {}, OP2, opts(webrtcFor('107')));
  assert.equal(webrtcCacheSize(db), 1);
  assert.equal(ft.pending.size, 1, 'заменённая запись оставила свой таймер');
  // Отказ: запись удалена — и её таймер тоже.
  await assert.rejects(telephonyWebrtcMe(db, {}, { ...OP2, acting_admin: { id: 9 } }, opts(webrtcFor('107'))), refused(403));
  assert.equal(webrtcCacheSize(db), 0);
  assert.equal(ft.pending.size, 0, 'после удаления записи остался таймер');
  // Свежая запись выметанием не трогается.
  await telephonyWebrtcMe(db, {}, OP, opts(OK_108));
  t += 30_000;
  await telephonyWebrtcMe(db, {}, OP2, opts(webrtcFor('107')));
  assert.equal(webrtcCacheSize(db), 2, 'выметание удалило свежую запись');
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

test('кто звонит: пациент и заявка по номеру; дверь — только право набора', () => {
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
  // SOFTPHONE_V1 (M4) — только журнал — НЕТ: «кто звонит» спрашивает лишь телефон
  // Easy-Med (право набора), а по любому номеру он отдаёт имя пациента и номер карты.
  assert.throws(() => telephonyCaller(db, { number: '998901112233' }, LAB), refused(403, /«Позвонить пациенту»/),
    'право «Журнал звонков» открыло поиск пациента по любому номеру');
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
