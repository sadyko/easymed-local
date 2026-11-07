// V3120_FIX (M6/M7/M8) — хранилище файлов: что отдаётся «внутри страницы»,
// кто видит корзины, перезапись, имена Windows, и заголовки безопасности
// приложения (CSP, X-Frame-Options).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function start(t) {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  for (const r of ['admin', 'registrar', 'inventory', 'callcenter']) {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(r, pw, r, r);
  }
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const dataDir = licensedDataDir();
  const server = await listen(createApp(db, { dataDir }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = {};
  for (const r of ['admin', 'registrar', 'inventory', 'callcenter']) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: r, password: 'password1' }) });
    cookie[r] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  return { db, base, cookie, pid, storage: path.join(dataDir, 'storage') };
}

const put = (s, who, obj, body = 'data', type = 'application/octet-stream') => fetch(s.base + '/api/storage/' + obj,
  { method: 'POST', headers: { 'Content-Type': type, Cookie: s.cookie[who] }, body: Buffer.from(body) });
const get = (s, who, obj) => fetch(s.base + '/api/storage/' + obj, { headers: { Cookie: s.cookie[who] } });

function plant(s, rel, content) {
  const abs = path.join(s.storage, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test('M6: SVG и HTML не отдаются «внутри страницы»; картинки и PDF — да', async (t) => {
  const s = await start(t);
  plant(s, 'clinic-docs/misc/evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  plant(s, 'clinic-docs/misc/page.html', '<script>alert(1)</script>');
  plant(s, 'clinic-docs/misc/pic.png', 'png');
  plant(s, 'clinic-docs/misc/doc.pdf', '%PDF-1.4');
  const svg = await get(s, 'admin', 'clinic-docs/misc/evil.svg');
  assert.equal(svg.status, 200);
  assert.doesNotMatch(svg.headers.get('content-type') || '', /svg/);
  assert.match(svg.headers.get('content-disposition') || '', /^attachment/);
  const html = await get(s, 'admin', 'clinic-docs/misc/page.html');
  assert.match(html.headers.get('content-disposition') || '', /^attachment/);
  assert.doesNotMatch(html.headers.get('content-type') || '', /html/);
  const png = await get(s, 'admin', 'clinic-docs/misc/pic.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('content-disposition'), null);
  const pdf = await get(s, 'admin', 'clinic-docs/misc/doc.pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});

test('M7: любой путь под clinic-docs/patients/ — по праву вкладки «Документы» (не только 4 сегмента)', async (t) => {
  const s = await start(t);
  plant(s, `clinic-docs/patients/${s.pid}/docs/deep/scan.pdf`, '%PDF');
  plant(s, `clinic-docs/patients/${s.pid}/scan.pdf`, '%PDF');
  for (const p of [`clinic-docs/patients/${s.pid}/docs/deep/scan.pdf`, `clinic-docs/patients/${s.pid}/scan.pdf`]) {
    assert.equal((await get(s, 'inventory', p)).status, 403, p);
    assert.equal((await get(s, 'registrar', p)).status, 200, p);
  }
  const up = await put(s, 'inventory', `clinic-docs/patients/${s.pid}/x/scan.pdf`, '%PDF');
  assert.equal(up.status, 403);
});

test('M7: telegram-media — только тем, у кого Telegram (чат / бот)', async (t) => {
  const s = await start(t);
  plant(s, 'telegram-media/chat/1/a.jpg', 'jpg');
  assert.equal((await get(s, 'inventory', 'telegram-media/chat/1/a.jpg')).status, 403);
  assert.equal((await get(s, 'callcenter', 'telegram-media/chat/1/a.jpg')).status, 200, 'колл-центр ведёт чат');
  assert.equal((await put(s, 'inventory', 'telegram-media/chat/1/b.jpg', 'jpg')).status, 403);
});

test('M8: документ и фото пациента не перезаписываются (409)', async (t) => {
  const s = await start(t);
  const doc = `clinic-docs/patients/${s.pid}/docs/1-a-scan.pdf`;
  assert.equal((await put(s, 'registrar', doc, '%PDF-first')).status, 200);
  const again = await put(s, 'registrar', doc, '%PDF-second');
  assert.equal(again.status, 409);
  assert.match((await again.json()).error.message, /[А-Яа-я]/);
  assert.equal(fs.readFileSync(path.join(s.storage, 'clinic-docs', 'patients', String(s.pid), 'docs', '1-a-scan.pdf'), 'utf8'), '%PDF-first');
  assert.equal((await put(s, 'registrar', 'patient-photos/patients/1-a.jpg', 'jpg1')).status, 200);
  assert.equal((await put(s, 'registrar', 'patient-photos/patients/1-a.jpg', 'jpg2')).status, 409);
});

test('M8: расширения по корзине; имена Windows; длинное имя — 400 по-русски', async (t) => {
  const s = await start(t);
  const bad = [
    'clinic-docs/misc/page.html', 'clinic-docs/misc/x.svg', 'telegram-media/chat/1/x.svg',
    'clinic-docs/misc/CON.pdf', 'clinic-docs/misc/aux', 'clinic-docs/misc/com1.txt',
    'clinic-docs/misc/a%3Ab.pdf', 'clinic-docs/misc/trail.pdf.', 'clinic-docs/misc/trail.pdf%20',
    'clinic-docs/misc/' + 'x'.repeat(300) + '.pdf',
  ];
  for (const obj of bad) {
    const r = await put(s, 'admin', obj, 'x');
    assert.equal(r.status >= 400 && r.status < 500, true, obj + ' → ' + r.status);
    const j = await r.json().catch(() => ({}));
    assert.match(String(j.error && j.error.message), /[А-Яа-я]/, obj + ': ' + JSON.stringify(j));
  }
  assert.equal((await put(s, 'admin', 'clinic-docs/misc/ok.pdf', '%PDF')).status, 200);
});

test('CSP и X-Frame-Options у приложения', async (t) => {
  const s = await start(t);
  const res = await fetch(s.base + '/admin.html');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /connect-src 'self'/);
  // SOFTPHONE_V1 — телефон Easy-Med: только wss к onlinePBX, ни http, ни чужие домены.
  const connect = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
  assert.equal(connect, "connect-src 'self' wss://*.onpbx.ru:*");
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  const api = await fetch(s.base + '/api/health');
  assert.equal(api.headers.get('x-frame-options'), 'SAMEORIGIN');
});

// Ревью 3.22.0 m2 — свои права «Push-уведомления» и «Ссылки для рекламы» открывают
// в корзине telegram-media только СВОЮ папку: картинку рассылки (broadcast/,
// views/commerce-push.js) и файл ссылки (deeplinks/, telegram/deeplinks.js
// FILE_DIR). Вложения переписки (chat/…) — результаты и направления пациентов —
// остаются за чатом и ботом, как до 3.22.0: маркетолог со «Ссылками: Просмотр»
// их не читает, с «Push» — не стирает.
test('m2: Push и ссылки для рекламы открывают в telegram-media только свои папки', async (t) => {
  const s = await start(t);
  const setGrants = (grants) => {
    const row = s.db.prepare("SELECT permissions FROM role_permissions WHERE role = 'inventory'").get();
    const p = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
    p.grants = { ...(p.grants || {}), ...grants };
    s.db.prepare("INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES ('inventory', ?)").run(JSON.stringify(p));
  };
  const del = (st, who, obj) => fetch(st.base + '/api/storage/' + obj, { method: 'DELETE', headers: { Cookie: st.cookie[who] } });
  plant(s, 'telegram-media/chat/1/a.jpg', 'jpg');
  plant(s, 'telegram-media/broadcast/1-a.jpg', 'jpg');
  plant(s, 'telegram-media/deeplinks/1/f.pdf', '%PDF');

  setGrants({ commerce_push: 'edit' });
  assert.equal((await put(s, 'inventory', 'telegram-media/broadcast/2-b.jpg', 'jpg')).status, 200, 'картинку рассылки кладёт тот, кто рассылает');
  assert.equal((await get(s, 'inventory', 'telegram-media/broadcast/1-a.jpg')).status, 200);
  assert.equal((await get(s, 'inventory', 'telegram-media/chat/1/a.jpg')).status, 403, 'Push не читает вложения переписки');
  assert.equal((await put(s, 'inventory', 'telegram-media/chat/1/b.jpg', 'jpg')).status, 403);
  assert.equal((await del(s, 'inventory', 'telegram-media/chat/1/a.jpg')).status, 403, 'Push не стирает вложения переписки');
  assert.equal((await get(s, 'inventory', 'telegram-media/deeplinks/1/f.pdf')).status, 403, 'Push — не ссылки');

  setGrants({ commerce_push: 'none', commerce_links: 'view' });
  assert.equal((await get(s, 'inventory', 'telegram-media/deeplinks/1/f.pdf')).status, 200, 'файл ссылки видит тот, кто видит ссылки');
  assert.equal((await put(s, 'inventory', 'telegram-media/deeplinks/1/g.pdf', '%PDF')).status, 403, '«Просмотр» не кладёт');
  assert.equal((await get(s, 'inventory', 'telegram-media/chat/1/a.jpg')).status, 403, 'ссылки не читают вложения переписки');
  assert.equal((await get(s, 'inventory', 'telegram-media/broadcast/1-a.jpg')).status, 403);

  setGrants({ commerce_links: 'edit' });
  assert.equal((await put(s, 'inventory', 'telegram-media/deeplinks/1/h.pdf', '%PDF')).status, 200);
  assert.equal((await del(s, 'inventory', 'telegram-media/deeplinks/1/h.pdf')).status, 200);
  assert.equal((await del(s, 'inventory', 'telegram-media/chat/1/a.jpg')).status, 403);

  // Как вчера: «Telegram-бот: Изменение» — вся корзина, и переписка тоже.
  setGrants({ commerce_links: 'none', settings: 'edit', 'settings.telegram': 'edit' });
  assert.equal((await get(s, 'inventory', 'telegram-media/chat/1/a.jpg')).status, 200);
  assert.equal((await put(s, 'inventory', 'telegram-media/chat/1/c.jpg', 'jpg')).status, 200);
});
