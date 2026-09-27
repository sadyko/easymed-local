// PAY_PERIOD_CLOSE_V1 (владелец, 27.09) — «Закрыть месяц» в «Отчётах».
//
// Договор двух сторон: полоса над «Зарплатами врачей» и «По врачам» зовёт
// pay_period_status / pay_period_close / pay_period_reopen, и сервер обязан
// знать эти имена и отвечать тем, что полоса читает (months, current,
// can_close, can_reopen). Закрытие настоящим RPC — и полоса видит месяц
// закрытым.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { RPC } = await import('../../../../server/services/rpc/index.js');
const { today } = await import('../../../../server/services/domain/day.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');

test('полоса «Закрыть месяц» стоит у «Зарплат врачей» и «По врачам» и зовёт известные серверу RPC', () => {
  const bar = hub.slice(hub.indexOf('function payPeriodBar()'), hub.indexOf('function paintPreview()'));
  assert.ok(bar.length > 100, 'нет payPeriodBar');
  for (const name of ['pay_period_status', 'pay_period_close', 'pay_period_reopen']) {
    assert.ok(bar.includes("'" + name + "'"), 'полоса не зовёт ' + name);
    assert.equal(typeof RPC[name], 'function', 'сервер не знает ' + name);
  }
  assert.match(hub, /rep\.kind === 'doctor_salaries' \|\| rep\.kind === 'by_doctors'\) previewEl\.appendChild\(payPeriodBar\(\)\)/);
  // Подтверждение — вторым нажатием, без confirm() (его в программе нет).
  assert.doesNotMatch(bar, /confirm\(/);
});

test('ответ статуса — те поля, что читает полоса; закрытый месяц в нём виден', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9, 'adm', 'x', 'admin', 'Админ')").run();
    const admin = { id: 9, role: 'admin' };
    const cur = today(db).slice(0, 7);
    let y = Number(cur.slice(0, 4)); let m = Number(cur.slice(5, 7)) - 1;
    if (m < 1) { m = 12; y -= 1; }
    const prev = y + '-' + String(m).padStart(2, '0');
    const before = RPC.pay_period_status(db, {}, admin);
    assert.equal(before.current, cur);
    assert.equal(before.can_close, true);
    assert.equal(before.can_reopen, true);
    assert.deepEqual(before.months, []);
    RPC.pay_period_close(db, { month: prev }, admin);
    const after = RPC.pay_period_status(db, {}, admin);
    assert.equal(after.months[0].month, prev);
    assert.ok(after.months[0].closed_at);
    assert.equal(after.months[0].closed_by_name, 'Админ');
  } finally { db.close(); }
});
