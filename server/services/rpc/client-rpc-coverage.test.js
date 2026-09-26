// RPC_PORT_V1 — КАЖДОЕ ИМЯ RPC, КОТОРОЕ ЗОВЁТ БРАУЗЕР, ЕСТЬ В КАРТЕ СЕРВЕРА.
//
// Офлайн-сборка — переписанное облачное приложение на Supabase, и часть экранов
// всё ещё звала функции Postgres, которые сюда так и не перенесли. Сервер
// отвечает на такое 501 «RPC not implemented: <имя>» (routes/rpc.js), а экран
// чаще всего глотает ошибку — кнопка «ничего не делает».
//
// Тест смотрит на исходники public/**/*.js теми же выражениями, что и разовый
// аудит (supabase.rpc('x'), .rpc("x"), rpc(`x`), callRpc('x'), '/api/rpc/x'), и
// сверяет с живой картой RPC из index.js — не с текстом файла, а с объектом,
// поэтому имя, записанное в карте с ошибкой в импорте, тоже будет замечено
// index.test.js, а здесь — только отсутствие.
//
// ALLOWLIST — имена, оставленные в МЁРТВОМ коде сознательно. Список может
// только сокращаться: второй тест валится, если имя из него уже реализовано
// или его больше никто не зовёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RPC } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PUBLIC = path.join(REPO, 'public');

const ALLOWLIST = new Map([
  // employee-editor.js открывается только из section-crud раздела users, а
  // #settings:users маршрутизатор уводит в #employees (admin.js, RPC_PORT_V1).
  ['admin_reset_user_password', 'employee-editor.js / section-crud.js — settings:users уводит в #employees; пароль меняет /api/users'],
  ['current_user_is_admin', 'employee-editor.js — недостижим, см. admin_reset_user_password'],
  ['current_user_can_manage_staff', 'employee-editor.js — недостижим, см. admin_reset_user_password'],
  // Облачный склад с местами хранения и партиями: #procurement уводит в
  // #inventory, файл никто не импортирует, таблиц batch_stock/stock_locations
  // офлайн нет.
  ['dispose_batch_stock', 'procurement.js — облачный склад, #procurement уводит в #inventory'],
  ['get_or_create_batch', 'procurement.js — облачный склад, #procurement уводит в #inventory'],
  ['get_or_create_batch_v2', 'procurement.js — облачный склад, #procurement уводит в #inventory'],
  // Чат поддержки SaaS: <script> закомментирован в admin.html
  // (SUPPORT_FAB_REMOVED_V1), таблиц support_* офлайн нет.
  ['mark_support_read_user', 'support-widget.js — не подключён в admin.html'],
  ['send_support_message', 'support-widget.js — не подключён в admin.html'],
]);

const PATTERNS = [
  /\.rpc\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g,
  /\/api\/rpc\/([a-zA-Z0-9_]+)/g,
  /\brpc\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g,
  /callRpc\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g,
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '__tests__' && e.name !== 'vendor') walk(p, out);
      continue;
    }
    if (!/\.(m?js|html)$/.test(e.name) || /\.test\./.test(e.name)) continue;
    out.push(p);
  }
  return out;
}

function clientCalls() {
  const calls = new Map();   // name -> Set('file:line')
  for (const file of walk(PUBLIC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length;
        if (!calls.has(m[1])) calls.set(m[1], new Set());
        calls.get(m[1]).add(path.relative(REPO, file).replace(/\\/g, '/') + ':' + line);
      }
    }
  }
  return calls;
}

test('каждый RPC, который зовёт браузер, зарегистрирован на сервере', () => {
  const known = new Set(Object.keys(RPC));
  assert.ok(known.size > 100, 'карта RPC не прочиталась: ' + known.size);
  const calls = clientCalls();
  assert.ok(calls.size > 50, 'сканер не нашёл вызовов — сломались выражения: ' + calls.size);
  const missing = [...calls]
    .filter(([name]) => !known.has(name) && !ALLOWLIST.has(name))
    .map(([name, where]) => name + ' — ' + [...where].join(', '));
  assert.deepEqual(missing, [], 'этих RPC нет на сервере — экран получит 501 «RPC not implemented»');
});

test('ALLOWLIST только сокращается: в нём нет реализованных и никем не зовущихся имён', () => {
  const known = new Set(Object.keys(RPC));
  const calls = clientCalls();
  const stale = [...ALLOWLIST.keys()].filter((n) => known.has(n) || !calls.has(n));
  assert.deepEqual(stale, [], 'уберите эти имена из ALLOWLIST');
});

test('мёртвые экраны ALLOWLIST действительно закрыты маршрутизатором', () => {
  const admin = fs.readFileSync(path.join(PUBLIC, 'js', 'admin.js'), 'utf8');
  assert.match(admin, /if \(key === 'users'\) return void navigate\('employees'\)/, '#settings:users должен уводить в #employees');
  assert.match(admin, /case 'procurement':\s+return void navigate\('inventory'\)/, '#procurement должен уводить в #inventory');
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const live = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!live.includes('support-widget.js'), 'support-widget.js снова подключён — у его RPC нет сервера');
  assert.ok(!/from '\.\/procurement\.js|views\/procurement\.js/.test(
    walk(path.join(PUBLIC, 'js')).filter((f) => !f.endsWith('procurement.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
      .replace(/^\s*\/\/.*$/gm, '')),
  'procurement.js кто-то импортирует — его RPC не реализованы');
});
