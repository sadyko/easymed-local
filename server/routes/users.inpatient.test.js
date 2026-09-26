// INPATIENT_BONUS_V1 (мигр. 155) — вкладка «Стационар» карточки сотрудника на
// сервере: ставки за услуги в стационаре (inpatient_rates — % ЛИБО фикс за
// единицу, отдельно от «Услуг и ставок») и вознаграждение за направление в
// стационар (inpatient_referral_pct / _fixed). Деньги — по правилам «Цен и
// процентов» (ADMIN_ROWS_GRANTABLE_V1): не-администратору нужно действие
// «Сотрудники → Цены и проценты», свои деньги не правит никто, кроме
// администратора.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { parseEmployeeFields, parseInpatientRates, MONEY_FIELDS } from './users.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, service_rates, service_rate_default) VALUES (?,?,?,?,?,?,?,?)');
  ins.run(1, 'boss', hashPassword('password1'), 'Boss', 'admin', '[]', '', 0);
  ins.run(60, 'head', hashPassword('password1'), 'Head Nurse', 'nurse', '[]', '', 0);
  ins.run(61, 'plain', hashPassword('password1'), 'Plain Nurse', 'nurse', '[]', '', 0);
  // Врач с амбулаторной ставкой по умолчанию 30 % и одной своей ставкой.
  ins.run(70, 'doc', hashPassword('password1'), 'Doc', 'doctor', '[]', JSON.stringify([{ service_id: 2, pct: 40, branches: [] }]), 30);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function call(base, method, path, body, cookie) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('ставки стационара: % или фикс на услугу, хранятся отдельно, амбулаторные не трогаются', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const res = await call(base, 'PATCH', '/api/users/70', {
      inpatient_rates: [{ service_id: 1, pct: 20 }, { service_id: 3, fix: 50000 }, { service_id: 4, pct: '12.5' }, { service_id: 5, pct: 0 }],
      inpatient_referral_pct: 5, inpatient_referral_fixed: 100000,
    }, boss);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const u = res.json.user;
    assert.deepEqual(u.inpatient_rates, [
      { service_id: 1, pct: 20 }, { service_id: 3, fix: 50000 }, { service_id: 4, pct: 12.5 },
      { service_id: 5, pct: 0 },   // введённый 0 — это решение, он хранится
    ]);
    assert.equal(u.inpatient_referral_pct, 5);
    assert.equal(u.inpatient_referral_fixed, 100000);
    // Сцепки больше нет: стационарная ставка не завела амбулаторной записи.
    assert.deepEqual(u.service_rates, [{ service_id: 2, pct: 40, branches: [] }]);
    const row = db.prepare('SELECT service_rates, service_rate_default FROM users WHERE id = 70').get();
    assert.equal(row.service_rate_default, 30);
    assert.ok(!row.service_rates.includes('"service_id":1'), 'стационар завёл амбулаторную запись {pct: 0}');
  } finally { server.close(); }
});

test('ставки стационара: проверка — отказ словами, и отказ ничего не пишет', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    assert.equal((await call(base, 'PATCH', '/api/users/70', { inpatient_rates: [{ service_id: 1, pct: 20 }] }, boss)).status, 200);
    const bad = [
      [{ inpatient_rates: [{ service_id: 1, pct: 150 }] }, 'Стационарная ставка врача — процент от 0 до 100.'],
      [{ inpatient_rates: [{ service_id: 1, pct: -1 }] }, 'Стационарная ставка врача — процент от 0 до 100.'],
      [{ inpatient_rates: [{ service_id: 1, pct: 'abc' }] }, 'Стационарная ставка врача — процент от 0 до 100.'],
      [{ inpatient_rates: [{ service_id: 1, pct: true }] }, 'Стационарная ставка врача — процент от 0 до 100.'],
      [{ inpatient_rates: [{ service_id: 1, fix: -5 }] }, 'Стационарная ставка врача — сумма от 0 до 1 000 000 000 000.'],
      [{ inpatient_rates: [{ service_id: 1, pct: 10, fix: 5 }] }, 'Стационарная ставка — либо процент, либо сумма, не обе сразу.'],
      [{ inpatient_rates: [{ service_id: 1 }] }, 'У услуги во вкладке «Стационар» не задана ставка.'],
      [{ inpatient_rates: [{ service_id: 'x', pct: 1 }] }, 'Invalid rate entry.'],
      [{ inpatient_rates: 'nope' }, 'inpatient_rates must be an array.'],
      [{ inpatient_referral_pct: 101 }, 'За направление в стационар — процент от 0 до 100.'],
      [{ inpatient_referral_fixed: -1 }, 'За направление в стационар — сумма от 0 до 1 000 000 000 000.'],
    ];
    for (const [body, msg] of bad) {
      const r = await call(base, 'PATCH', '/api/users/70', body, boss);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.message, msg);
    }
    assert.equal(db.prepare('SELECT inpatient_rates FROM users WHERE id = 70').get().inpatient_rates, '[{"service_id":1,"pct":20}]');
    // Пустой список — ставок нет; пустое поле бонуса — 0.
    const r = await call(base, 'PATCH', '/api/users/70', { inpatient_rates: [], inpatient_referral_pct: '' }, boss);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.user.inpatient_rates, []);
    assert.equal(r.json.user.inpatient_referral_pct, 0);
  } finally { server.close(); }
});

test('ставки стационара — деньги: без «Цен и процентов» 403 и скрыты, с ними пишутся, свои — никогда', async () => {
  const { db, server, base } = await startServer();
  try {
    for (const k of ['inpatient_rates', 'inpatient_referral_pct', 'inpatient_referral_fixed']) {
      assert.ok(MONEY_FIELDS.includes(k), k + ' не в деньгах карточки');
    }
    addGrants(db, 'nurse', { settings: 'view', 'settings.employees': 'edit' });
    const head = await login(base, 'head');
    for (const body of [{ inpatient_rates: [{ service_id: 1, pct: 5 }] }, { inpatient_referral_pct: 5 }, { inpatient_referral_fixed: 1 }]) {
      assert.equal((await call(base, 'PATCH', '/api/users/61', body, head)).status, 403, JSON.stringify(body));
    }
    const list = await call(base, 'GET', '/api/users', undefined, head);
    const doc = list.json.users.find((u) => u.id === 61);
    assert.ok(!('inpatient_rates' in doc) && !('inpatient_referral_pct' in doc) && !('inpatient_referral_fixed' in doc),
      'без «Цен и процентов» стационарные ставки видны');
    addGrants(db, 'nurse', { 'settings.employees.money': 'edit' });
    // Сотрудник той же силы роли (карточку врача медсестра не правит вовсе — ревью b).
    assert.equal((await call(base, 'PATCH', '/api/users/61', { inpatient_rates: [{ service_id: 1, pct: 5 }], inpatient_referral_fixed: 7 }, head)).status, 200);
    assert.equal(db.prepare('SELECT inpatient_referral_fixed FROM users WHERE id = 61').get().inpatient_referral_fixed, 7);
    // Свои деньги — только администратор.
    assert.equal((await call(base, 'PATCH', '/api/users/60', { inpatient_referral_pct: 50 }, head)).status, 403);
    assert.equal((await call(base, 'PATCH', '/api/users/60', { inpatient_rates: [{ service_id: 1, pct: 99 }] }, head)).status, 403);
  } finally { server.close(); }
});

test('parseInpatientRates: повтор услуги — последняя запись; parseEmployeeFields кладёт JSON', () => {
  const r = parseInpatientRates([{ service_id: 1, pct: 5 }, { service_id: 1, fix: 700 }]);
  assert.ok(r.ok);
  assert.equal(r.value, '[{"service_id":1,"fix":700}]');
  const db = openDb(':memory:');
  migrate(db);
  const p = parseEmployeeFields({ inpatient_rates: [{ service_id: 2, pct: 10 }], inpatient_referral_pct: '7.5' }, db);
  assert.ok(p.ok, p.message);
  assert.equal(p.fields.inpatient_rates, '[{"service_id":2,"pct":10}]');
  assert.equal(p.fields.inpatient_referral_pct, 7.5);
  db.close();
});
