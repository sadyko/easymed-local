// ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности I3/I5) — карта «что дают ворота
// ненастроенного ключа» (gate-fallbacks.js) совпадает с самими воротами.
//
// Карта — копия списков ролей из кода, и защита «Ролей»/«Сотрудников» судит по
// ней. Поэтому тест обходит ВЕСЬ server/ (маршруты, сервисы, реестр) и
// находит каждый вызов ворот справочника: requireGrant, grantAllows,
// grantAllowsOr, grantAllowsAdminOr, grantLevel, effectiveLevel,
// canSeeReportKey — с любыми именами аргументов. Для каждого:
//   • ключ-строка (или константа-строка того же файла) из справочника прав;
//   • requireGrant / grantAllows — список ролей разобран и есть в карте;
//   • grantAllowsOr / grantLevel — прежнее правило описано в карте функцией
//     (FALLBACK_FN) — иначе карта о нём не знает;
//   • grantAllowsAdminOr — строка справочника с правилом «только администратор».
// Вызов, который разобрать нельзя (ключ-переменная, список не найден), — КРАСНЫЙ,
// если он не записан в ALLOW ниже с объяснением. Лишняя запись в ALLOW — тоже
// красный: список исключений не должен тихо устаревать.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_FALLBACK, FALLBACK_FN_KEYS } from './gate-fallbacks.js';
import { catalogByKey } from '../../public/js/shared/permission-catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const CALLEES = ['requireGrant', 'grantAllowsAdminOr', 'grantAllowsOr', 'grantAllows', 'grantLevel', 'effectiveLevel', 'canSeeReportKey'];
const BY_KEY = catalogByKey();
const norm = (list) => JSON.stringify([...list].sort());

// Вызовы, которые разобрать нельзя, — и почему это не дыра. Ключ записи:
// «файл|функция|текст аргумента-ключа».
// n — СКОЛЬКО таких вызовов: новый вызов той же формы (ещё одни ворота
// в custdev.js, новый ключ в реестре через scope.allGrant) меняет счёт и
// краснеет, а не проходит под старым объяснением.
const ALLOW = {
  // Сами ворота: определения переносят ключ дальше.
  'services/grants.js|grantLevel|section': { n: 1, why: 'закрытый раздел закрывает свои окна — определение grantAllowsOr' },
  'services/grants.js|grantLevel|key': { n: 1, why: 'определение grantAllowsOr' },
  'services/grants.js|grantAllowsOr|key': { n: 3, why: 'определения grantAllows / grantAllowsAdminOr / effectiveLevel' },
  'services/grants.js|grantAllows|key': { n: 1, why: 'определение requireGrant' },
  // Запись по праву плитки: ключ называет реестр (write.grant), его сверяет write-grant.test.js.
  'db/write-grant.js|grantAllowsOr|key': { n: 3, why: 'ключ плитки из реестра; прежнее правило — «нет» (() => false / true)' },
  'db/write-grant.js|grantAllowsOr|money.key': { n: 1, why: '«Цены и проценты» плитки; прежнее правило — «нет»' },
  // Ограничение по владельцу: ключ и роли из реестра (crm_requests.scope) — строка карты crm.all.
  'db/row-scope.js|grantAllows|sc.allGrant': { n: 1, why: 'crm_requests.scope: allGrant crm.all, allRoles [admin] — строка карты crm.all' },
  // Группы отчётов: ключ из REPORT_GROUP; прежнее правило — reports-hub или администратор (adminDefault).
  'services/report-access.js|grantAllowsOr|key': { n: 1, why: 'группы отчётов; fallbackLevel разбирает строки parent=reports' },
  'services/rpc/reports.js|canSeeReportKey|k': { n: 1, why: 'группы отчётов по REPORT_GROUP' },
  'services/report-access.js|canSeeReportKey|key': { n: 1, why: 'requireReportKind по REPORT_GROUP' },
  // Сама защита сравнивает уровни — она не ворота.
  'services/role-guard.js|effectiveLevel|key': { n: 2, why: 'защита «Ролей»: сравнение уровней' },
  'services/role-guard.js|grantAllowsOr|key': { n: 1, why: 'защита «Ролей»: gatePasses по спискам карты' },
  // Cust Dev: ключи custdev.list / custdev.rate, прежнее правило — галочка раздела (FALLBACK_FN).
  'services/rpc/custdev.js|grantAllowsOr|key': { n: 1, why: 'custdev.list / custdev.rate — FALLBACK_FN', wrapper: 'grantedOr', must: 'fn' },
  // Telegram: settings.telegram / reports.telegram — строки adminDefault.
  'services/rpc/telegram.js|grantAllowsAdminOr|key': { n: 1, why: 'settings.telegram / reports.telegram — adminDefault', wrapper: 'requireLevel', must: 'adminDefault' },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

// Аргументы вызова, начиная с открывающей скобки: разбиение по запятым
// верхнего уровня с учётом строк и вложенных скобок.
function argsAt(text, i) {
  const args = [];
  let depth = 0; let cur = ''; let q = null;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (q) { cur += c; if (c === '\\') { cur += text[++j]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; }
      depth--;
    }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return args;
}

function literal(arg, text) {
  const m = /^'([^']*)'$/.exec(arg);
  if (m) return m[1];
  if (/^[A-Za-z_]\w*$/.test(arg)) {
    const c = new RegExp('const ' + arg + " = '([^']*)'").exec(text);
    if (c) return c[1];
  }
  return null;
}

function listOf(arg, text) {
  let src = arg;
  if (/^[A-Za-z_]\w*$/.test(arg)) {
    const c = new RegExp('const ' + arg + ' = (?:Object\\.freeze\\()?(\\[[^\\]]*\\])').exec(text);
    if (!c) return null;
    src = c[1];
  }
  const m = /^\[([^\]]*)\]$/.exec(src);
  if (!m) return null;
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

function scanGates(root) {
  const sites = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const re = new RegExp('(^|[^\\w.])(' + CALLEES.join('|') + ')\\(', 'g');
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index + m[1].length);
      if (/function\s*$/.test(before)) continue;   // определение, а не вызов
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*)/.test(text.slice(lineStart, m.index + 1))) continue;   // комментарий
      const callee = m[2];
      const open = m.index + m[0].length - 1;
      sites.push({ rel, callee, args: argsAt(text, open), text });
    }
  }
  return sites;
}

function gateProblems(root, { checkAllow = true } = {}) {
  const bad = [];
  const usedAllow = new Map();
  const sites = scanGates(root);
  for (const s of sites) {
    const keyArg = s.args[2] || '';
    const id = `${s.rel}|${s.callee}|${keyArg}`;
    if (ALLOW[id]) { usedAllow.set(id, (usedAllow.get(id) || 0) + 1); continue; }
    const key = literal(keyArg, s.text);
    if (key === null || !BY_KEY.has(key)) { bad.push(`${id}: ключ не разобран`); continue; }
    const row = BY_KEY.get(key);
    if (s.callee === 'requireGrant' || s.callee === 'grantAllows') {
      const need = literal(s.args[3] || '', s.text);
      const list = listOf(s.args[4] || '', s.text);
      if (!need || !list) { bad.push(`${id}: уровень или список ролей не разобран`); continue; }
      const lists = (GATE_FALLBACK[key] || {})[need] || [];
      if (!lists.some((l) => norm(l) === norm(list))) bad.push(`${id}: ${key}/${need} ${JSON.stringify(list)} — нет в gate-fallbacks.js`);
    } else if (s.callee === 'grantAllowsOr' || s.callee === 'grantLevel') {
      if (!FALLBACK_FN_KEYS.includes(key)) bad.push(`${id}: прежнее правило ${key} не описано в FALLBACK_FN`);
    } else if (s.callee === 'grantAllowsAdminOr') {
      if (!row.adminDefault) bad.push(`${id}: ${key} — ворота «только администратор» у строки без adminDefault`);
    } else {
      bad.push(`${id}: ${s.callee} с ключом справочника вне списка исключений`);
    }
  }
  // Ключи, которые идут в ворота через обёртку файла, проверяются у вызовов самой обёртки.
  for (const [id, a] of Object.entries(ALLOW)) {
    if (!a.wrapper) continue;
    const file = path.join(root, id.split('|')[0]);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const re = new RegExp('(^|[^\\w.])' + a.wrapper + '\\(', 'g');
    let m; let seen = 0;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index + m[1].length);
      if (/function\s*$/.test(before)) continue;
      const k = literal(argsAt(text, m.index + m[0].length - 1)[2] || '', text);
      seen++;
      const row = k ? BY_KEY.get(k) : null;
      const ok = row && (a.must === 'fn' ? FALLBACK_FN_KEYS.includes(k) : !!row.adminDefault);
      if (!ok) bad.push(`${id}: обёртка ${a.wrapper} зовётся с ключом ${k} — ${a.must === 'fn' ? 'нет в FALLBACK_FN' : 'не «только администратор»'}`);
    }
    if (!seen) bad.push(`${id}: обёртка ${a.wrapper} не найдена`);
  }
  if (checkAllow) {
    for (const [id, a] of Object.entries(ALLOW)) {
      const got = usedAllow.get(id) || 0;
      if (got === 0) bad.push(`${id}: исключение больше ни к чему не относится — уберите`);
      else if (got !== a.n) bad.push(`${id}: вызовов ${got}, а в исключении записано ${a.n} — проверьте новый вызов и поправьте счёт`);
    }
  }
  return { bad, sites };
}

test('каждые ворота ключа справочника во всём server/ — в карте gate-fallbacks.js или в списке исключений', () => {
  const { bad, sites } = gateProblems(SERVER);
  assert.ok(sites.length >= 50, 'сканер не видит ворот: ' + sites.length);
  assert.ok(sites.some((s) => s.rel.startsWith('routes/')) && sites.some((s) => s.rel.startsWith('db/')), 'сканер не заходит в routes/ и db/');
  assert.deepEqual(bad, []);
  // И в карте нет выдуманных ворот (кроме двух, что живут не в вызовах: row-scope и реестр).
  for (const [key, byNeed] of Object.entries(GATE_FALLBACK)) {
    if (key === 'crm.all' || key === 'crm.convert') continue;
    for (const [need, lists] of Object.entries(byNeed)) {
      for (const l of lists) {
        assert.ok(sites.some((s) => (s.callee === 'requireGrant' || s.callee === 'grantAllows')
          && literal(s.args[2] || '', s.text) === key && literal(s.args[3] || '', s.text) === need
          && norm(listOf(s.args[4] || '', s.text) || []) === norm(l)), `${key}/${need} ${JSON.stringify(l)} — таких ворот нет`);
      }
    }
  }
});

test('расхождение в файле вне services/rpc — красный тест', () => {
  const tmp = fs.mkdtempSync(path.join(SERVER, '.gf-'));
  try {
    fs.mkdirSync(path.join(tmp, 'routes'));
    fs.writeFileSync(path.join(tmp, 'routes', 'drift.js'),
      "const ROLES = ['cashier'];\nexport function f(db, req) { requireGrant(db, req.user, 'inpatient.vitals', 'edit', ROLES, 'x'); }\n" +
      "export function g(db, u, k) { return grantAllows(db, u, k, 'view', []); }\n" +
      "export function h(db, u) { return grantAllowsOr(db, u, 'inpatient.vitals', 'view', () => true); }\n");
    const { bad } = gateProblems(tmp, { checkAllow: false });
    assert.ok(bad.some((b) => b.includes('routes/drift.js|requireGrant') && b.includes('нет в gate-fallbacks.js')), 'разошедшийся список не пойман: ' + bad.join('; '));
    assert.ok(bad.some((b) => b.includes('routes/drift.js|grantAllows|k') && b.includes('не разобран')), 'ключ-переменная не поймана');
    assert.ok(bad.some((b) => b.includes('routes/drift.js|grantAllowsOr') && b.includes('FALLBACK_FN')), 'своё прежнее правило не поймано');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ограничение по владельцу из реестра (scope.allGrant): каждый ключ — строкой карты с теми же ролями', async () => {
  const { REGISTRY } = await import('../db/schema-registry.js');
  let n = 0;
  for (const [t, e] of Object.entries(REGISTRY)) {
    const sc = e && e.scope;
    if (!sc || !sc.allGrant) continue;
    n++;
    const lists = (GATE_FALLBACK[sc.allGrant] || {}).edit || [];
    assert.ok(lists.some((l) => norm(l) === norm(sc.allRoles || [])), `${t}: scope.allGrant ${sc.allGrant} ${JSON.stringify(sc.allRoles)} — нет в gate-fallbacks.js`);
  }
  assert.equal(n, ALLOW['db/row-scope.js|grantAllows|sc.allGrant'].n, 'таблиц со scope.allGrant больше, чем проверено');
});

// FALLBACK_FN — прежнее правило, описанное функцией. Сверяется ПОВЕДЕНИЕМ: для
// каждой штатной роли карта отвечает то же, что настоящие ворота (ключ не
// настроен ни у кого — работает именно прежнее правило).
test('FALLBACK_FN отвечает то же, что настоящие ворота, для каждой штатной роли', async () => {
  const { openDb } = await import('../db/connection.js');
  const { migrate } = await import('../db/migrate.js');
  const { VALID_ROLES } = await import('./roles.js');
  const { fallbackLevel } = await import('./gate-fallbacks.js');
  const { custdevList, custdevRate } = await import('./rpc/custdev.js');
  const { canSeeAll, departmentForm } = await import('./rpc/departments.js');
  const { canSeeAllMovements } = await import('./rpc/stock-log.js');
  const { stockMinimumsList } = await import('./rpc/stock-requests.js');
  const db = openDb(':memory:');
  migrate(db);
  const allowed = (fn) => { try { fn(); return true; } catch (e) { if (e && e.status === 403) return false; return true; } };
  const RANK = { none: 0, view: 1, edit: 2, delete: 3 };
  const atLeast = (lvl, need) => (RANK[lvl] || 0) >= RANK[need];
  let id = 100;
  try {
    for (const role of VALID_ROLES) {
      const u = { id: ++id, role, extra_roles: [] };
      db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(u.id, 'u' + u.id, 'x', role);
      const real = {
        'custdev.list/view': allowed(() => custdevList(db, {}, u)),
        'custdev.rate/edit': allowed(() => custdevRate(db, {}, u)),
        'settings.departments/view': canSeeAll(db, u),
        'settings.departments/edit': allowed(() => departmentForm(db, {}, u)),
        'procurement/view': canSeeAllMovements(db, u),
        'procurement/edit': !!stockMinimumsList(db, { scope: 'mine' }, u).can_manage_all,
      };
      for (const [k, want] of Object.entries(real)) {
        const [key, need] = k.split('/');
        assert.equal(atLeast(fallbackLevel(db, u, key, 'all'), need), want, `${role}: ${k} — карта ${fallbackLevel(db, u, key, 'all')}, ворота ${want ? 'пускают' : 'не пускают'}`);
      }
    }
  } finally { db.close(); }
  assert.deepEqual([...FALLBACK_FN_KEYS].sort(), ['custdev.list', 'custdev.rate', 'procurement', 'settings.departments'], 'в FALLBACK_FN новый ключ — добавьте его в сверку поведением');
});
