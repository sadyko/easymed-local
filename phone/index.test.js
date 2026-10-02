// CALLCENTER_OPERATOR_V1 (2026-09-21) — ПЕРВЫЙ ТЕСТ ОТДЕЛЬНОЙ ПРОГРАММЫ ТЕЛЕФОНИИ.
//
// EasyPhone (phone/index.js) — второй сервер той же установки, со своим портом
// и своими маршрутами, и до этого дня у него не было НИ ОДНОГО теста. Проверки
// прав, переведённые на матрицу в EasyMed, здесь жили одной строкой: все
// маршруты, включая `GET /api/calls` — весь журнал звонков клиники со ссылками
// на записи разговоров, — открывались правом ПОЗВОНИТЬ (`crm.dial`). Право
// смотреть журнал (`crm.calls`) и право слушать запись (`crm.recording`) в этой
// программе не значили ничего: выдай человеку набор номера — и он получал
// голоса пациентов за всю историю клиники.
//
// Здесь пять человек и один звонок с записью. Каждый маршрут обязан спрашивать
// СВОЁ право, а ссылка на запись — приходить только тому, кому прослушивание
// выдано.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';
// FETCH_BAD_PORT_V1 — порт берётся через общий помощник: динамический
// диапазон этой машины пересекается со списком «плохих портов» undici, и
// app.listen(0) изредка отдаёт порт, к которому fetch() не пойдёт вовсе.
import { listen } from '../control-plane/server/test-helpers/listen.js';
import { createPhoneApp } from './index.js';

const SESSION = '2099-01-01T00:00:00Z';   // сессии тестовых людей не истекают

function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

// Пять рабочих мест, каждое со СВОИМ набором прав, — ради того, чтобы «пустил»
// нельзя было спутать с «не пустил» по соседнему праву.
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  const ses = db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)');
  const people = [
    [1, 'adm', 'Администратор', 'admin'],
    [2, 'dialer', 'Только набор', 'nurse'],
    [3, 'watcher', 'Только журнал', 'lab'],
    [4, 'listener', 'Журнал и записи', 'cashier'],
    [5, 'nobody', 'Без телефонии', 'doctor'],
  ];
  for (const [id, name, full, role] of people) { mk.run(id, name, 'x', full, role); ses.run('sid-' + name, id, SESSION); }

  // Миграция 141 уже записала этим ролям явные «Нет» — выдаём поверх ровно то,
  // что проверяем.
  setGrants(db, 'nurse',   { 'crm.dial': 'edit', 'crm.calls': 'none', 'crm.recording': 'none' });
  setGrants(db, 'lab',     { 'crm.dial': 'none', 'crm.calls': 'view', 'crm.recording': 'none' });
  setGrants(db, 'cashier', { 'crm.dial': 'none', 'crm.calls': 'view', 'crm.recording': 'edit' });

  db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number, billsec, recording_url)
              VALUES ('c-1', '2026-09-20T08:00:00Z', 0, '998901112233', '101', 42, 'https://rec/1.mp3')`).run();
  return db;
}

async function withApp(fn) {
  const db = seed();
  const server = await listen(createPhoneApp(db));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, who) => fetch(base + path, { headers: { Cookie: 'emsid=sid-' + who } });
  const post = (path, who, body) => fetch(base + path, {
    method: 'POST', headers: { Cookie: 'emsid=sid-' + who, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  try { await fn({ db, base, get, post }); }
  finally { await new Promise((r) => server.close(r)); db.close(); }
}

test('без входа программа не отдаёт ничего — ни журнала, ни набора', async () => {
  await withApp(async ({ base }) => {
    assert.equal((await fetch(base + '/api/calls')).status, 401);
    assert.equal((await fetch(base + '/api/dial', { method: 'POST' })).status, 401);
  });
});

// ГЛАВНОЕ. Журнал звонков — это вся история обращений клиники: номера, время,
// кто звонил и ссылка на запись разговора. Право ПОЗВОНИТЬ его не открывает.
test('журнал звонков открывает право «Звонки», а не право «Позвонить»', async () => {
  await withApp(async ({ get }) => {
    assert.equal((await get('/api/calls', 'dialer')).status, 403,
      'человеку с одним лишь набором номера отдали весь журнал звонков клиники');
    assert.equal((await get('/api/calls', 'nobody')).status, 403);
    assert.equal((await get('/api/calls', 'watcher')).status, 200);
    assert.equal((await get('/api/calls', 'adm')).status, 200);
  });
});

test('набор номера открывает право «Позвонить», а не право «Звонки»', async () => {
  await withApp(async ({ post }) => {
    assert.equal((await post('/api/dial', 'watcher', { phone: '+998901112233' })).status, 403,
      'право смотреть журнал стало правом звонить');
    assert.equal((await post('/api/dial', 'nobody', { phone: '+998901112233' })).status, 403);
    // У того, кому набор выдан, ворота прав молчат, и отказывает САМА
    // телефония: линии в тесте нет, и это 400, а не 403.
    assert.equal((await post('/api/dial', 'dialer', { phone: '+998901112233' })).status, 400);
  });
});

// ССЫЛКА НА ЗАПИСЬ — ОТДЕЛЬНОЕ ПРАВО, И В ЖУРНАЛЕ ЕЁ БЫТЬ НЕ ДОЛЖНО.
// Адрес записи у Binotel и «Моих Звонков» прямой: уехав в журнал, он даёт
// голос пациента любому, кто журнал открыл. Флаг has_recording остаётся —
// кнопка «Прослушать» рисуется по нему и получает честный отказ.
test('запись разговора приходит только тому, кому выдано прослушивание', async () => {
  await withApp(async ({ get }) => {
    const seen = await (await get('/api/calls', 'watcher')).json();
    assert.equal(seen.calls.length, 1);
    assert.equal(seen.calls[0].recording_url, null, 'ссылка на запись уехала в журнал мимо права «Прослушать»');
    assert.equal(seen.calls[0].has_recording, true, 'журнал скрыл сам факт записи — кнопке не из чего взяться');

    const heard = await (await get('/api/calls', 'listener')).json();
    assert.equal(heard.calls[0].recording_url, 'https://rec/1.mp3', 'выданное право прослушивания не отдало запись');

    const boss = await (await get('/api/calls', 'adm')).json();
    assert.equal(boss.calls[0].recording_url, 'https://rec/1.mp3');
  });
});

// ROLES_SAVE_TRUTH_V1 — экран рисует «Прослушать» только тому, кому слушать можно:
// журнал говорит это одним флагом, теми же воротами, что у /api/recording. И
// отказ журнала называет строку «Ролей» её нынешним именем — «Журнал звонков».
test('журнал говорит экрану, можно ли слушать записи (may_hear); отказ журнала называет строку «Журнал звонков»', async () => {
  await withApp(async ({ get }) => {
    assert.equal((await (await get('/api/calls', 'watcher')).json()).may_hear, false);
    assert.equal((await (await get('/api/calls', 'listener')).json()).may_hear, true);
    assert.equal((await (await get('/api/calls', 'adm')).json()).may_hear, true);
    const denied = await (await get('/api/calls', 'dialer')).json();
    assert.match(denied.error.message, /«Журнал звонков»/);
  });
});

// CALL_RECORDING_REASONS_V1 (2026-10-02) — EasyPhone получает ту же причину,
// что карточка заявки: станция ответила без ссылки через пару минут после
// разговора — «готовится» (экран спросит снова), через час — «записи нет».
// И модуль с фразами и повтором отдаётся по тому пути, куда смотрит app.js.
test('/api/recording называет причину: свежий разговор — not_ready, давний — not_found', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api2.onlinepbx.ru/')) {
      asked.push(String(url));
      return new Response(JSON.stringify({ status: '1', data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  try {
    await withApp(async ({ db, get }) => {
      const p = db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
          VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1, ?, ?, 30)`)
        .run(JSON.stringify({ domain: 'clinic.onpbx.ru' }), JSON.stringify({ auth_key: 'a', key_id: 'k', key: 'v' }));
      const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const add = db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number,
          waitsec, billsec, disposition, provider, provider_id) VALUES (?, ?, 0, '998901112233', '101', 8, 97, 'ANSWER', 'onlinepbx', ?)`);
      const freshId = add.run('onlinepbx:fresh', iso(Date.now() - 3 * 60_000), p.lastInsertRowid).lastInsertRowid;
      const oldId = add.run('onlinepbx:old', iso(Date.now() - 60 * 60_000), p.lastInsertRowid).lastInsertRowid;

      assert.deepEqual(await (await get('/api/recording?call_id=' + freshId, 'listener')).json(), { url: '', reason: 'not_ready' });
      assert.deepEqual(await (await get('/api/recording?call_id=' + oldId, 'listener')).json(), { url: '', reason: 'not_found' });
      assert.equal(asked.length, 2, 'станцию спросили не по разу на звонок');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('модуль фраз и повтора отдаётся по пути, куда смотрит app.js — и только он', async () => {
  await withApp(async ({ base }) => {
    const r = await fetch(base + '/public/js/shared/call-recording.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /javascript/);
    assert.match(await r.text(), /export async function askRecordingUntilReady/);
    const other = await fetch(base + '/public/js/shared/permission-catalog.js');
    assert.notEqual(other.status, 200, 'вся папка shared раздаётся наружу');
  });
});
