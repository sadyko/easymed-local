// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — поток изменений для рабочих экранов:
// GET /api/live (Server-Sent Events) и GET /api/live/version (запасной опрос), а также
// то, что маршруты записи (/api/db, RPC) сообщают о записи — после успеха и только тогда.
// Настоящее приложение, база в памяти со всеми миграциями, вход по паролю.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { liveBusFor, LIVE_TABLES } from '../services/live/bus.js';
import { LIVE_RELEVANCE } from '../../public/js/admin/live-relevance.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stand(t, { dataDir = licensedDataDir(), heartbeatMs } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin');
  u.run(9, 'kassa', hashPassword('password1'), 'Кассир', 'cashier');
  const live = heartbeatMs ? { heartbeatMs } : {};
  const server = await listen(createApp(db, { dataDir, live }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  t.after(() => {
    for (const s of streams) s.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    db.close();
  });
  const cookies = {};
  for (const login of ['boss', 'kassa']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: login, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + login);
    cookies[login] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const post = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    let json = {};
    try { json = await res.json(); } catch { /* не JSON */ }
    return { status: res.status, json };
  };
  /** Открыть поток и читать его кадрами. */
  const open = async (who, { path = '/api/live', headers = {} } = {}) => {
    const ac = new AbortController();
    const res = await fetch(base + path, {
      headers: { Accept: 'text/event-stream', 'Accept-Encoding': 'gzip', ...(who ? { Cookie: cookies[who] } : {}), ...headers },
      signal: ac.signal,
    });
    const frames = [];
    let ended = false;
    if (res.status === 200) {
      (async () => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const f = { raw };
              for (const line of raw.split('\n')) {
                if (line.startsWith(':')) f.comment = line.slice(1).trim();
                else {
                  const k = line.indexOf(':');
                  const key = k < 0 ? line : line.slice(0, k);
                  const val = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '');
                  f[key] = val;
                }
              }
              if (f.data) { try { f.json = JSON.parse(f.data); } catch { /* не JSON */ } }
              frames.push(f);
            }
          }
        } catch { /* поток закрыт */ }
        ended = true;
      })();
    }
    const s = {
      res, frames,
      get ended() { return ended; },
      async next(pred, ms = 2000, label = 'кадр') {
        const until = Date.now() + ms;
        for (;;) {
          const f = frames.find(pred);
          if (f) return f;
          if (Date.now() > until) throw new Error('не дождались: ' + label + '; пришло: ' + JSON.stringify(frames.map((x) => x.raw)));
          await sleep(10);
        }
      },
      close() { try { ac.abort(); } catch { /* уже закрыт */ } },
    };
    streams.push(s);
    return s;
  };
  return { db, base, cookies, post, open, bus: liveBusFor(db) };
}

const changes = (s) => s.frames.filter((f) => f.event === 'change').map((f) => f.json);

test('без сессии — 401, как у всех /api: и поток, и версия', async (t) => {
  const { base } = await stand(t);
  for (const p of ['/api/live', '/api/live/version']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 401, p);
    assert.equal((await res.json()).error.code, 'unauthorized');
  }
});

test('поток: text/event-stream, не сжат и не закэширован, первым — hello с версией', async (t) => {
  const { open, bus } = await stand(t);
  const s = await open('kassa');
  assert.equal(s.res.status, 200);
  assert.match(String(s.res.headers.get('content-type')), /^text\/event-stream/);
  assert.equal(s.res.headers.get('content-encoding'), null, 'gzip держал бы поток в памяти до конца ответа');
  assert.match(String(s.res.headers.get('cache-control')), /no-cache/);
  const hello = await s.next((f) => f.event === 'hello', 2000, 'hello');
  assert.deepEqual(hello.json, { v: bus.version });
  assert.equal(bus.listenerCount, 1);
});

test('запись через /api/db приходит событием с именем таблицы; чтение и отказ — нет', async (t) => {
  const { open, post, db } = await stand(t);
  const s = await open('kassa');
  await s.next((f) => f.event === 'hello');
  // Чтение — ничего.
  const read = await post('/api/db', 'boss', { table: 'patients', op: 'select', columns: 'id' });
  assert.equal(read.status, 200);
  // Отказ — ничего: CHECK на статусе визита.
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid);
  await sleep(250);   // прямую вставку выше шина видит (patients не наблюдается) — дать ей уйти
  const before = s.frames.length;
  const bad = await post('/api/db', 'boss', { table: 'visits', op: 'insert', values: { patient_id: pid, visit_date: '2026-11-08T09:00:00Z', status: 'нет-такого' } });
  assert.ok(bad.status >= 400, 'запись отвергнута: ' + bad.status);
  await sleep(300);
  assert.equal(changes({ frames: s.frames.slice(before) }).length, 0, 'отказ события не дал');
  // Успех — событие с таблицей (таблица и не наблюдаемая — имя называет сам маршрут).
  const ok = await post('/api/db', 'boss', { table: 'patients', op: 'insert', values: { full_name: 'Новый Пациент' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const ev = await s.next((f) => f.event === 'change' && f.json.tables.includes('patients'), 2000, 'событие patients');
  assert.ok(Number(ev.id) === ev.json.v, 'id кадра — версия (по нему браузер догоняет после обрыва)');
  assert.deepEqual(Object.keys(ev.json).sort(), ['rpc', 'tables', 'v']);
});

test('RPC: запись — событие с именем RPC и записанными таблицами; чтение, отказ и чтение вне списка — нет', async (t) => {
  const { open, post } = await stand(t);
  const s = await open('boss');
  await s.next((f) => f.event === 'hello');
  // Только чтение (READ_ONLY_RPCS) — ничего.
  assert.equal((await post('/api/rpc/dashboard_summary', 'boss', {})).status, 200);
  // Чтение, которого нет в READ_ONLY_RPCS, но которое ничего не записало, — тоже ничего.
  const today = await post('/api/rpc/outpatients_today', 'boss', {});
  assert.equal(today.status, 200, JSON.stringify(today.json));
  await sleep(300);
  assert.equal(changes(s).length, 0, 'чтение не будит экраны: ' + JSON.stringify(changes(s)));
  // Запись — событие.
  const opened = await post('/api/rpc/open_cash_shift', 'kassa', { opening_float: 0 });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  const ev = await s.next((f) => f.event === 'change' && f.json.rpc.includes('open_cash_shift'), 2000, 'событие open_cash_shift');
  assert.deepEqual(ev.json.tables, ['cash_shifts'], 'база назвала, что записал RPC');
  // Отказ (смена уже открыта) — ничего.
  const n = changes(s).length;
  const again = await post('/api/rpc/open_cash_shift', 'kassa', { opening_float: 0 });
  assert.equal(again.status, 400);
  await sleep(300);
  assert.equal(changes(s).length, n, 'неудачный RPC события не дал');
});

test('пульс — комментарий раз в heartbeatMs; конец сессии закрывает поток', async (t) => {
  const { open, post } = await stand(t, { heartbeatMs: 60 });
  const s = await open('kassa');
  await s.next((f) => f.comment === 'hb', 2000, 'пульс');
  // Пульс и для самой вкладки: событие ping с версией (по его тишине она узнаёт зависший поток).
  const ping = await s.next((f) => f.event === 'ping', 2000, 'ping');
  assert.deepEqual(Object.keys(ping.json), ['v']);
  const out = await post('/api/auth/logout', 'kassa', {});
  assert.ok(out.status < 400);
  const until = Date.now() + 2000;
  while (!s.ended && Date.now() < until) await sleep(20);
  assert.equal(s.ended, true, 'поток вышедшего сотрудника закрыт пульсом');
});

test('закрытый поток снимается с шины', async (t) => {
  const { open, bus } = await stand(t);
  const a = await open('kassa');
  const b = await open('boss');
  await a.next((f) => f.event === 'hello');
  await b.next((f) => f.event === 'hello');
  assert.equal(bus.listenerCount, 2);
  a.close();
  b.close();
  const until = Date.now() + 2000;
  while (bus.listenerCount > 0 && Date.now() < until) await sleep(20);
  assert.equal(bus.listenerCount, 0, 'слушатели не остались висеть');
});

test('догоняющий: ?since= и Last-Event-ID — пропущенное одним событием; /version — то же для опроса', async (t) => {
  const { open, db, base, cookies, bus } = await stand(t);
  const v0 = bus.version;
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid);
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-11-08T09:00:00Z', 'arrived')").run(pid);
  bus.flush();
  const r = await fetch(`${base}/api/live/version?since=${v0}`, { headers: { Cookie: cookies.kassa } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get('cache-control')), /no-store/);
  assert.deepEqual(await r.json(), { v: bus.version, tables: ['visits'], rpc: [] });
  const s = await open('kassa', { path: '/api/live?since=' + v0 });
  const ev = await s.next((f) => f.event === 'change', 2000, 'догоняющее событие');
  assert.deepEqual(ev.json, { v: bus.version, tables: ['visits'], rpc: [] });
  const s2 = await open('kassa', { headers: { 'Last-Event-ID': String(v0 - 5) } });
  const ev2 = await s2.next((f) => f.event === 'change', 2000, 'сброс');
  assert.equal(ev2.json.reset, true, 'номер до запуска сервера — «могло измениться всё»');
});

test('просроченная лицензия: читать можно — поток и версия работают', async (t) => {
  // Пустая папка данных — клиника не активирована: только чтение (402 на запись).
  const { open, post, base, cookies } = await stand(t, { dataDir: tmpDir('em-live-locked-') });
  const w = await post('/api/rpc/open_cash_shift', 'kassa', { opening_float: 0 });
  assert.equal(w.status, 402, 'клиника действительно заперта');
  const r = await fetch(base + '/api/live/version', { headers: { Cookie: cookies.kassa } });
  assert.equal(r.status, 200);
  const s = await open('kassa');
  await s.next((f) => f.event === 'hello');
});

test('поток не пишется в журнал медленных запросов', async (t) => {
  const { open, db } = await stand(t);
  const s = await open('kassa');
  await s.next((f) => f.event === 'hello');
  await sleep(350);   // дольше порога slow-log (200 мс по умолчанию)
  s.close();
  await sleep(100);
  const n = db.prepare("SELECT COUNT(*) AS n FROM ops_events WHERE kind = 'slow_request'").get().n;
  assert.equal(n, 0, 'живой поток — не «медленный запрос»');
});

test('страж: всё, что смотрят экраны, база ловит (LIVE_TABLES ⊇ таблиц экранов)', () => {
  for (const [screen, rule] of Object.entries(LIVE_RELEVANCE)) {
    for (const tbl of rule.tables) assert.ok(LIVE_TABLES.includes(tbl), `${screen}: ${tbl} не наблюдается сервером`);
  }
});
