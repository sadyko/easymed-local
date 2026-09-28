# Коды Mindray «LOINC^ИМЯ^LN» и тихий лоток — план реализации (LIS_MINDRAY_CODES_V1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бланк заполняется из настоящего Mindray (`6690-2^WBC^LN`). Нормальная проба не ложится в «Необработанные». В «Панелях» лаборатория выбирает коды, которые прибор действительно присылал, или вписывает свой код. Симулятор умеет говорить как настоящий Mindray.

**Architecture:**
- `hl7.js` отдаёт `OBX-3` целиком и по частям.
- Новый чистый модуль `server/lis/match.js` решает, какая строка прибора ложится в какую строку бланка и какой у сообщения статус. `ingest.js` только пишет то, что тот решил.
- Новый RPC `lis_device_codes` читает `raw` из `lab_device_messages`.
- Новый чистый модуль `public/js/admin/views/lab-device-codes.js` строит список для ячейки «Поле анализатора».
- Симулятор (отдельный репозиторий) получает режим «провод Mindray» в общей сборке `buildOru`.

**Tech Stack:** Node 24 ESM, better-sqlite3, `node:test`, ванильный JS без сборки, fake-DOM тесты видов.

**Спецификация:** `docs/specs/2026-09-28-lis-mindray-codes-design.md` (коммит `0422e1d`).

---

## Правила общего рабочего дерева (читать до первого шага)

- В этом же дереве и на этой же ветке (`feat/stock-own-shelf-suppliers-vat`) сейчас работают ещё два агента: склад/НДС и касса.
  - Ветку не переключать, worktree не создавать (он уже стирал `node_modules` на этой машине).
  - Не пушить, не ставить тег.
- **Полный `npm test` не запускать.** Только свои файлы, явными путями.
- Перед КАЖДЫМ коммитом:
  1. `git log --oneline -3` и `git status --short`;
  2. `git diff --cached --name-only` должен быть пуст — иначе чужое уже в индексе: остановиться и доложить;
  3. для каждого своего файла `git diff -U0 -- <файл>`. Если в файле есть чужие ханки, файл общий: индексировать только свои ханки (ниже). Если чужих нет — `git add -- <файл>`.
- Общие файлы этой задачи — те, что прямо сейчас правят другие агенты:
  - `public/js/admin/i18n-strings.js`
  - `server/services/rpc/index.js`
  - `server/services/control/gate.js`
  - `public/js/admin.js`

  В этих файлах **каждая** своя вставка обязана содержать метку `LIS_MINDRAY_CODES_V1` в добавленной строке: комментарий блока или хвост строки. По этой метке скрипт ниже отличает свои ханки от чужих.
- Скрипт, который оставляет из диффа одного файла только ханки с меткой. Создать один раз в scratchpad:

`C:\Users\user\AppData\Local\Temp\claude\c--Users-user-Desktop-ailos-agentic-system\cdaa5eb3-8422-4424-8c3a-38580164abe3\scratchpad\keep-hunks.mjs`:

```js
// Оставляет заголовок диффа ОДНОГО файла и только те ханки, в добавленных
// строках которых есть метка. Вход — `git diff -U0 -- <файл>` на stdin.
import fs from 'node:fs';
const marker = process.argv[2];
if (!marker) { console.error('usage: node keep-hunks.mjs <MARKER> < diff'); process.exit(2); }
const lines = fs.readFileSync(0, 'utf8').split('\n');
const header = [];
const out = [];
let hunk = null;
let kept = 0;
const flush = () => {
  if (hunk && hunk.some((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(marker))) { out.push(...hunk); kept++; }
  hunk = null;
};
for (const l of lines) {
  if (l.startsWith('@@')) { flush(); hunk = [l]; continue; }
  if (hunk) { hunk.push(l); continue; }
  if (l !== '') header.push(l);
}
flush();
if (!kept) { console.error('ни одного ханка с меткой ' + marker); process.exit(1); }
process.stdout.write(header.concat(out).join('\n') + '\n');
```

- Индексация своих ханков общего файла (bash):

```bash
SP="C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad"
F=public/js/admin/i18n-strings.js      # пример
git diff -U0 -- "$F" > "$SP/own-all.patch"
node "$SP/keep-hunks.mjs" LIS_MINDRAY_CODES_V1 < "$SP/own-all.patch" > "$SP/own.patch"
git apply --cached --unidiff-zero "$SP/own.patch"
git diff --cached -- "$F"              # глазами: только свои строки
```

- Коммит — обычный `git commit -m "…"`: индекс к этому моменту содержит только своё. Сообщения — по-русски, в стиле репозитория, с меткой и строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Тесты на Windows — явными путями или глобом bash, никогда не каталогом.

---

## Карта файлов

**easymed.local**

| Файл | Что | Задача |
|---|---|---|
| `server/lis/hl7.js` | наблюдение несёт `name`, `system`, `codeRaw`; `OBX-8` — первое повторение | 1 |
| `server/lis/hl7.test.js` | ожидание формы наблюдения + новый тест | 1 |
| `server/lis/match.js` (новый) | `planObservations()`, `outcome()` — чистое правило | 2 |
| `server/lis/match.test.js` (новый) | тесты правила | 2 |
| `server/lis/ingest.js` | использует `match.js` | 3 |
| `server/lis/ingest.test.js` | новые тесты Mindray; тест «та же модель» шлёт полную пробу | 3 |
| `server/services/rpc/lis.js` | `lisDeviceCodes()` | 4 |
| `server/services/rpc/lis.test.js` | тесты RPC | 4 |
| `server/services/rpc/index.js` (общий) | регистрация `lis_device_codes` | 4 |
| `server/services/control/gate.js` (общий) | `lis_device_codes` в `READ_ONLY_RPCS` | 4 |
| `public/js/admin/i18n-strings.js` (общий) | 2 серверные фразы (задача 4), 5 фраз экрана (задача 6) | 4, 6 |
| `public/js/admin/views/lab-device-codes.js` (новый) | `codeChoices()`, `TYPE_OWN` — чистое правило списка | 5 |
| `public/js/admin/views/lab-device-codes.test.mjs` (новый) | тесты правила списка | 5 |
| `public/js/admin/views/lab-panels.js` | загрузка присланных кодов, новая ячейка, `LAB_BUILD` | 6 |
| `public/js/admin/__tests__/lab-panels-device-codes.test.mjs` (новый) | тест вида: группы, ввод своего кода, сохранение | 6 |
| `public/js/admin/views/laboratory.js` | штамп `lab-panels.js?v=panelsv4` | 6 |
| `public/js/admin.js` (общий) | штамп `laboratory.js?v=labwords2` | 6 |

**analyzers** (`C:\Users\user\Desktop\analyzers`, ветка `master`, отдельный репозиторий)

| Файл | Что | Задача |
|---|---|---|
| `forwarder/mindray-wire.js` (новый) | коды LOINC, служебные строки, строка гистограммы | 7 |
| `forwarder/hl7-oru.js` | `buildOru({ …, wire })` | 7 |
| `forwarder/hl7-oru.test.js` (новый) | прежний режим не изменился; режим Mindray | 7 |
| `server.js` | передаёт `wire` | 7 |
| `public/index.html` | выбор «Провод» | 7 |

---

### Задача 1: разбор `OBX-3` по частям и `OBX-8` с повторениями

**Files:**
- Modify: `server/lis/hl7.js` (ветка `seg.startsWith('OBX')` в `parseMessage`)
- Test: `server/lis/hl7.test.js`

- [ ] **Шаг 1: обновить ожидание и написать падающий тест**

В `server/lis/hl7.test.js`, в тесте «разбирает ORU: тип, номер сообщения, номер пробы, наблюдения», заменить `assert.deepEqual(m.observations[0], {…})` на:

```js
  assert.deepEqual(m.observations[0], {
    valueType: 'NM', code: 'WBC', name: 'Leukocytes', system: '99MRC', codeRaw: 'WBC^Leukocytes^99MRC',
    value: '6.1', unit: '10*9/L', range: '4.0-9.0', abnormal: 'N', status: 'F',
  });
```

В конец файла добавить:

```js
// LIS_MINDRAY_CODES_V1 — Mindray пишет OBX-3 как «LOINC^ИМЯ^LN». Раньше выживал
// только первый компонент, и бланк, привязанный к «WBC», оставался пустым.
test('«6690-2^WBC^LN» разбирается на код, имя и систему, поле целиком сохраняется', () => {
  const m = parseMessage([
    'MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|7|P|2.3.1',
    'OBR|1||LAB-000098|00001^Automated Count^99MRC',
    'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
    'OBX|2|NM|6690-2^WBC^LN||9.81|10*9/L|4.00-10.00|H~N|||F',
    'OBX|3|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r'));
  const [mode, loinc, plain] = m.observations;
  assert.equal(mode.valueType, 'IS');
  assert.equal(mode.name, 'Take Mode');
  assert.equal(loinc.code, '6690-2');
  assert.equal(loinc.name, 'WBC');
  assert.equal(loinc.system, 'LN');
  assert.equal(loinc.codeRaw, '6690-2^WBC^LN', 'человек в журнале видит обе части');
  assert.equal(loinc.abnormal, 'H', 'OBX-8 «H~N»: смысл несёт первое повторение');
  assert.equal(plain.code, 'WBC');
  assert.equal(plain.name, '', 'у «WBC^^99MRC» имени нет — и это не ошибка');
  assert.equal(plain.codeRaw, 'WBC^^99MRC');
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/lis/hl7.test.js`
Expected: FAIL в двух тестах: `deepEqual` без `name`/`system`/`codeRaw` и `loinc.name` = `undefined`.

- [ ] **Шаг 3: реализация**

В `server/lis/hl7.js` заменить блок

```js
    } else if (seg.startsWith('OBX')) {
      observations.push({
        valueType: (f[2] || '').trim(),
        code: comp(f[3])[0].trim(),
        value: (f[5] || '').trim(),
        unit: comp(f[6])[0].trim(),
        range: (f[7] || '').trim(),
        abnormal: (f[8] || '').trim(),
        status: (f[11] || '').trim(),
      });
    }
```

на

```js
    } else if (seg.startsWith('OBX')) {
      // LIS_MINDRAY_CODES_V1 — OBX-3 целиком и по частям. Mindray пишет
      // «6690-2^WBC^LN»: код LOINC, имя, система. Раньше выживал только первый
      // компонент, и бланк, привязанный к «WBC», оставался пустым при ACK AA.
      // Сравнивать с кодом бланка — дело match.js; здесь только разбор.
      const id = comp(f[3]);
      observations.push({
        valueType: (f[2] || '').trim(),
        code: (id[0] || '').trim(),
        name: (id[1] || '').trim(),
        system: (id[2] || '').trim(),
        codeRaw: (f[3] || '').trim(),
        value: (f[5] || '').trim(),
        unit: comp(f[6])[0].trim(),
        range: (f[7] || '').trim(),
        // OBX-8 повторяется («H~N»): смысл несёт первое повторение. Целиком
        // строка уходила в «прочее» и становилась «abnormal» вместо «high».
        abnormal: String(f[8] == null ? '' : f[8]).split(repSep)[0].trim(),
        status: (f[11] || '').trim(),
      });
    }
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test server/lis/hl7.test.js`
Expected: PASS, 9 тестов.

- [ ] **Шаг 5: коммит** (файлы не общие)

```bash
git add -- server/lis/hl7.js server/lis/hl7.test.js
git commit -m "Приём анализаторов: OBX-3 разбирается на код, имя и систему, OBX-8 — по первому повторению (LIS_MINDRAY_CODES_V1)"
```

---

### Задача 2: чистое правило сопоставления и лотка — `server/lis/match.js`

**Files:**
- Create: `server/lis/match.js`
- Test: `server/lis/match.test.js`

- [ ] **Шаг 1: падающие тесты** — создать `server/lis/match.test.js`:

```js
// match.test.js — какая строка прибора кладётся в какую строку бланка, и когда
// проба лежит в лотке (LIS_MINDRAY_CODES_V1). Чистые функции: ни базы, ни времени.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planObservations, outcome } from './match.js';

const obs = (codeRaw, value = '1', status = 'F') => {
  const [code = '', name = '', system = ''] = codeRaw.split('^');
  return { code, name, system, codeRaw, value, status, valueType: 'NM', unit: '', range: '', abnormal: '' };
};
const line = (id, name, device_code, confirmed = 1) => ({ id, name, device_code, device_code_confirmed: confirmed });

test('подтверждённый код ловит строку прибора и по коду, и по имени, без учёта регистра', () => {
  const byName = planObservations([obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', 'WBC')]);
  assert.equal(byName.fills.length, 1);
  assert.equal(byName.fills[0].analyte.id, 1);
  assert.equal(planObservations([obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', '6690-2')]).fills.length, 1);
  assert.equal(planObservations([obs('6690-2^wbc^LN')], [line(1, 'Лейкоциты', 'WBC')]).fills.length, 1, 'регистр не важен');
});

test('две строки прибора на одну строку бланка — побеждает совпавшая по коду', () => {
  const p = planObservations([obs('12345^WBC^99MRC', '1.0'), obs('WBC^^99MRC', '2.0')], [line(1, 'Лейкоциты', 'WBC')]);
  assert.equal(p.fills.length, 1);
  assert.equal(p.fills[0].obs.value, '2.0');
  assert.deepEqual(p.unused.map((o) => o.codeRaw), ['12345^WBC^99MRC']);
});

test('неподтверждённая строка не заполняется, а пришедшее для неё названо отдельно (D4)', () => {
  const p = planObservations([obs('6690-2^WBC^LN')], [line(1, 'Лейкоциты', 'WBC', 0)]);
  assert.equal(p.fills.length, 0);
  assert.deepEqual(p.unconfirmed.map((o) => o.codeRaw), ['6690-2^WBC^LN']);
  assert.equal(p.missing.length, 0, 'неподтверждённую строку ещё никто не ждёт — «не пришла» она не бывает');
});

test('предварительное и пустое значение не ложатся, строка бланка названа с причиной', () => {
  const p = planObservations([obs('WBC^^99MRC', '6.1', 'P'), obs('HGB^^99MRC', '')],
    [line(1, 'Лейкоциты', 'WBC'), line(2, 'Гемоглобин', 'HGB')]);
  assert.equal(p.fills.length, 0);
  assert.deepEqual(p.missing.map((m) => m.analyte.name + ':' + m.reason), ['Лейкоциты:статус P', 'Гемоглобин:пустое значение']);
});

test('лоток: бланк заполнен — applied, лишние строки только в справке', () => {
  const o = outcome(planObservations([obs('08001^Take Mode^99MRC', 'O'), obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', 'WBC')]));
  assert.equal(o.status, 'applied');
  assert.equal(o.detail, 'не использованы: 08001^Take Mode^99MRC');
});

test('лоток: подтверждённая строка не пришла — unmapped с её именем и кодом', () => {
  const o = outcome(planObservations([obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', 'WBC'), line(2, 'Гемоглобин', 'HGB')]));
  assert.equal(o.status, 'unmapped');
  assert.equal(o.detail, 'не пришли: Гемоглобин (HGB)');
});

test('лоток: ничего не легло — unmapped, и журнал говорит почему', () => {
  assert.equal(outcome(planObservations([], [])).status, 'unmapped');
  assert.equal(outcome(planObservations([], [])).detail, 'в сообщении нет результатов');
  assert.equal(outcome(planObservations([obs('ALT^^99MRC')], [])).detail, 'не использованы: ALT^^99MRC');
});

test('длинный список лишних строк обрезается с остатком', () => {
  const many = Array.from({ length: 20 }, (_, i) => obs(`${i}^X${i}^99MRC`));
  const o = outcome(planObservations([obs('6690-2^WBC^LN', '9.81'), ...many], [line(1, 'Лейкоциты', 'WBC')]));
  assert.match(o.detail, / и ещё 5$/);
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/lis/match.test.js`
Expected: FAIL — `Cannot find module './match.js'`.

- [ ] **Шаг 3: реализация** — создать `server/lis/match.js`:

```js
// LIS_MINDRAY_CODES_V1 — какая строка прибора ложится в какую строку бланка и
// когда проба лежит в лотке. Чистое правило: ни базы, ни записи. ingest.js
// спрашивает его и пишет то, что оно решило, — проверять надо правило, а не SQL.
//
// Mindray пишет OBX-3 как «6690-2^WBC^LN», переадресатор с лабораторного ПК —
// как «WBC^^99MRC». Подтверждённый device_code совпадает с компонентом 1 ИЛИ 2,
// без учёта регистра. Два прохода: сначала по коду, потом по имени, и только в
// строки бланка, которые ещё свободны. Поэтому при споре двух строк прибора за
// одну строку бланка побеждает совпавшая по коду, и исход не зависит от
// порядка строк в сообщении.
//
// D4 не меняется: неподтверждённое сопоставление не применяется никогда. Но
// значение, пришедшее для неподтверждённой строки, названо отдельно: человек
// положил этот код в бланк, и посмотреть на него должен человек.
//
// Лоток (решение владельца 2026-09-28): проба принята, когда заполнена каждая
// ПОДТВЕРЖДЁННАЯ строка бланка. Лишние строки прибора (режимы пробы,
// референсная группа, гистограммы) — справка в журнале, а не повод для клика.

const key = (s) => String(s == null ? '' : s).trim().toUpperCase();

/**
 * @param {Array<{code:string,name:string,codeRaw:string,value:string,status:string}>} observations  строки прибора
 * @param {Array<{id:number,name:string,device_code:string,device_code_confirmed:number}>} analytes  строки бланка в порядке бланка
 * @returns {{
 *   fills: Array<{obs:object, analyte:object}>,
 *   missing: Array<{analyte:object, reason:string}>,
 *   unconfirmed: object[],
 *   unused: object[],
 * }}
 *   fills        — что писать в бланк;
 *   missing      — подтверждённые строки бланка без значения; reason: '' | 'статус P' | 'пустое значение';
 *   unconfirmed  — строки прибора, пришедшие для неподтверждённой строки бланка;
 *   unused       — строки прибора, которые ни к чему не относятся.
 */
export function planObservations(observations = [], analytes = []) {
  const confirmed = new Map();      // код → строка бланка (первая по порядку бланка)
  const unconfirmed = new Set();
  for (const a of analytes) {
    const k = key(a.device_code);
    if (!k) continue;
    if (a.device_code_confirmed) { if (!confirmed.has(k)) confirmed.set(k, a); }
    else unconfirmed.add(k);
  }

  const filled = new Set();         // строки бланка, получившие значение
  const used = new Set();           // индексы строк прибора, уже отнесённых к строке бланка
  const why = new Map();            // строка бланка → почему значение не легло
  const fills = [];

  for (const part of ['code', 'name']) {
    observations.forEach((obs, i) => {
      if (used.has(i)) return;
      const a = confirmed.get(key(obs[part]));
      if (!a || filled.has(a)) return;
      used.add(i);
      const status = key(obs.status) || 'F';
      // Предварительный (P) и неполученный (X) в бланк не идут: лаборант
      // подтвердил бы число, которое прибор ещё сам не считает окончательным.
      if (status !== 'F') { if (!why.has(a)) why.set(a, 'статус ' + status); return; }
      // Пустое значение — не значение: оно не стирает набранное руками.
      if (!String(obs.value == null ? '' : obs.value).trim()) { if (!why.has(a)) why.set(a, 'пустое значение'); return; }
      filled.add(a);
      fills.push({ obs, analyte: a });
    });
  }

  const unconfirmedHits = [];
  const unused = [];
  observations.forEach((obs, i) => {
    if (used.has(i)) return;
    if (unconfirmed.has(key(obs.code)) || unconfirmed.has(key(obs.name))) unconfirmedHits.push(obs);
    else unused.push(obs);
  });

  const missing = [...confirmed.values()]
    .filter((a) => !filled.has(a))
    .map((a) => ({ analyte: a, reason: why.get(a) || '' }));

  return { fills, missing, unconfirmed: unconfirmedHits, unused };
}

// Журнал читает человек в лотке: полсотни кодов гистограмм и режимов в одной
// ячейке не читаются. Сырое сообщение хранится целиком (инвариант 2).
const LIST_CAP = 15;
const list = (items) => items.length > LIST_CAP
  ? items.slice(0, LIST_CAP).join(', ') + ' и ещё ' + (items.length - LIST_CAP)
  : items.join(', ');

/**
 * Статус сообщения и строка журнала.
 * @returns {{status:'applied'|'unmapped', detail:string}}
 */
export function outcome(plan) {
  const done = plan.fills.length > 0 && !plan.missing.length && !plan.unconfirmed.length;
  const parts = [];
  if (plan.missing.length) {
    parts.push('не пришли: ' + list(plan.missing.map(({ analyte: a, reason }) =>
      a.name + ' (' + a.device_code + (reason ? ', ' + reason : '') + ')')));
  }
  if (plan.unconfirmed.length) parts.push('не подтверждено: ' + list(plan.unconfirmed.map((o) => o.codeRaw || o.code)));
  if (plan.unused.length) parts.push('не использованы: ' + list(plan.unused.map((o) => o.codeRaw || o.code)));
  if (!plan.fills.length && !parts.length) parts.push('в сообщении нет результатов');
  return { status: done ? 'applied' : 'unmapped', detail: parts.join('; ') };
}
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test server/lis/match.test.js`
Expected: PASS, 8 тестов.

- [ ] **Шаг 5: коммит** (файлы новые, не общие)

```bash
git add -- server/lis/match.js server/lis/match.test.js
git commit -m "Приём анализаторов: правило «строка прибора → строка бланка» и лоток — чистым модулем (LIS_MINDRAY_CODES_V1)"
```

---

### Задача 3: `ingest.js` использует правило; тесты Mindray

**Files:**
- Modify: `server/lis/ingest.js` (импорт; блок от `const analytes =` до конца определения `run`)
- Test: `server/lis/ingest.test.js`

- [ ] **Шаг 1: падающие тесты** — в конец `server/lis/ingest.test.js` добавить:

```js
// ── LIS_MINDRAY_CODES_V1 — провод Mindray: OBX-3 = «LOINC^ИМЯ^LN» ────────────
// Воспроизведено 2026-09-28 на копии базы: «6690-2^WBC^LN» → ACK AA и ни одного
// значения в бланке. Симулятор слал «КОД^^99MRC» и ошибку поймать не мог.
const OBXR = (n, id, value, opts = {}) =>
  `OBX|${n}|${opts.type || 'NM'}|${id}||${value}|${opts.unit || '10*9/L'}|${opts.range || ''}|${opts.flag || ''}|||${opts.status || 'F'}`;

test('Mindray «6690-2^WBC^LN» ложится в строку, подтверждённую как WBC', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142', { unit: 'g/L' })]), '127.0.0.1');
  assert.equal(code, 'AA');
  const wbc = results(db).find((r) => r.parameter === 'Лейкоциты');
  assert.ok(wbc, 'до исправления здесь было 0 значений при ACK AA');
  assert.equal(wbc.value, '9.81');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('Mindray «6690-2^WBC^LN» ложится и в строку, подтверждённую кодом LOINC 6690-2', () => {
  const db = fresh();
  db.prepare("UPDATE lab_panel_analytes SET device_code = '6690-2' WHERE code = 'WBC'").run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '9.81');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('Mindray: неподтверждённый код не применяется, проба в лотке с полным кодом', () => {
  const db = fresh({ confirmed: 0 });
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81'), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  assert.equal(results(db).filter((r) => r.parameter === 'Лейкоциты').length, 0, 'D4: совпадение само по себе не разрешение');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не подтверждено: 6690-2\^WBC\^LN/);
  db.close();
});

test('бланк заполнен, лишние строки Mindray (режимы, референсная группа, гистограмма) — не в лоток', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [
    OBXR(1, '08001^Take Mode^99MRC', 'O', { type: 'IS' }),
    OBXR(2, '01002^Ref Group^99MRC', 'General', { type: 'IS' }),
    OBXR(3, '6690-2^WBC^LN', '9.81'),
    OBXR(4, '718-7^HGB^LN', '142'),
    OBXR(5, '15551-4^WBC Histogram. BMP^99MRC', '^Image^BMP^Base64^Qk0=', { type: 'ED' }),
  ]), '127.0.0.1');
  assert.equal(results(db).length, 2);
  const m = message(db);
  assert.equal(m.status, 'applied', 'нормальная проба Mindray не требует клика в «Необработанных»');
  assert.match(m.detail, /не использованы: 08001\^Take Mode\^99MRC, 01002\^Ref Group\^99MRC, 15551-4\^WBC Histogram\. BMP\^99MRC/);
  db.close();
});

test('подтверждённая строка бланка не пришла — проба в лотке, строка названа, пришедшее записано', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '9.81')]), '127.0.0.1');
  assert.equal(results(db).length, 1, 'то, что пришло, всё равно ложится');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /не пришли: Гемоглобин \(HGB\)/);
  db.close();
});

test('пустое значение не стирает набранное руками и считается «не пришло»', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, entered_by) VALUES (123,'Лейкоциты','9.9','manual',7)").run();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', ''), OBXR(2, '718-7^HGB^LN', '142')]), '127.0.0.1');
  const wbc = results(db).find((r) => r.parameter === 'Лейкоциты');
  assert.equal(wbc.value, '9.9');
  assert.equal(wbc.source, 'manual');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /Лейкоциты \(WBC, пустое значение\)/);
  db.close();
});

test('две строки прибора на одну строку бланка — ложится совпавшая по коду', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '12345^WBC^99MRC', '1.0'), OBXR(2, 'WBC^^99MRC', '2.0'), OBXR(3, 'HGB^^99MRC', '142')]), '127.0.0.1');
  assert.equal(results(db).find((r) => r.parameter === 'Лейкоциты').value, '2.0');
  assert.match(message(db).detail, /не использованы: 12345\^WBC\^99MRC/);
  db.close();
});

test('флаг «H~N» без диапазона клиники — высокий, а не «отклонение»', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBXR(1, '6690-2^WBC^LN', '12.36', { flag: 'H~N' })]), '127.0.0.1');
  assert.equal(results(db)[0].flag, 'high');
  db.close();
});
```

И в тесте «второй анализатор ТОЙ ЖЕ модели принимается…» заменить строку отправки и первую проверку:

```js
  // Проба полная: с LIS_MINDRAY_CODES_V1 (решение владельца 2026-09-28) бланк,
  // в котором не пришла подтверждённая строка, лежит в лотке. Этот тест — про
  // приём с прибора той же модели, поэтому проба заполняет весь бланк.
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]), '10.0.0.12', 2);

  assert.equal(results(db).length, 2, 'результат с одинаковой модели обязан лечь');
```

Остальные строки теста (`results(db)[0].value === '6.1'`, `status === 'applied'`) не менять.

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/lis/ingest.test.js`
Expected: FAIL. `Mindray «6690-2^WBC^LN» ложится…` падает на `assert.ok(wbc)`. Тесты про лишние строки, пустое значение и «H~N» тоже падают. Тест «та же модель» с полной пробой проходит.

- [ ] **Шаг 3: реализация**

В `server/lis/ingest.js`:

1. В шапку, после строки `//   D7           выданный результат молча не переписывается`, добавить:

```js
//   LIS_MINDRAY_CODES_V1  код бланка сравнивается с компонентом 1 или 2 поля
//                         OBX-3; в лоток — только когда бланк не заполнен
//                         (решение владельца 2026-09-28; server/lis/match.js)
```

2. После `import { recordMessage, touchDevice } from './inbox.js';` добавить:

```js
import { planObservations, outcome } from './match.js';   // LIS_MINDRAY_CODES_V1 — правило сопоставления и лотка
```

3. Заменить весь блок от строки `const analytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1').all(panel.id);` до конца определения `run` (строка `  });` перед `  try {\n    run();`) на:

```js
  // LIS_MINDRAY_CODES_V1 — какая строка прибора ложится в какую строку бланка,
  // решает planObservations (match.js): компонент 1 ИЛИ 2 поля OBX-3 (Mindray
  // пишет «6690-2^WBC^LN»), только подтверждённые сопоставления (D4), пустое
  // значение — не значение. Порядок бланка — чтобы спор решался одинаково.
  const analytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1 ORDER BY sort_order, id').all(panel.id);
  const plan = planObservations(msg.observations, analytes);

  let applied = 0;

  const run = db.transaction(() => {
    for (const { obs, analyte: a } of plan.fills) {
      const num = obs.valueType === 'NM' && /^-?\d+(\.\d+)?$/.test(obs.value) ? parseFloat(obs.value) : null;
      const flag = flagFromClinic(num, a.ref_low, a.ref_high) || flagFromDevice(obs.abnormal);
      // Инвариант 3 и 4: диапазон, имя и единица — из панели. Диапазон прибора
      // берётся только там, где клиника свой не задала.
      const range = a.ref_text
        || (a.ref_low != null || a.ref_high != null ? `${a.ref_low == null ? '' : a.ref_low}-${a.ref_high == null ? '' : a.ref_high}` : (obs.range || ''));

      const existing = db.prepare('SELECT id FROM lab_results WHERE visit_service_id = ? AND parameter = ?').get(order.id, a.name);
      if (existing) {
        // D6 — машина побеждает в ЧЕРНОВИКЕ (выданное отсеяно выше).
        db.prepare(`UPDATE lab_results SET value = ?, numeric_value = ?, unit = ?, reference_range = ?,
                      ref_low = ?, ref_high = ?, flag = ?, source = 'analyzer',
                      entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE id = ?`)
          .run(obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag, existing.id);
      } else {
        db.prepare(`INSERT INTO lab_results
                      (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, entered_by, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'analyzer')`)
          .run(order.id, a.name, obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag);
      }
      applied++;
    }

    if (applied > 0 && order.status !== 'completed') {
      // Инвариант 1: до «resulted», и ни шагом дальше. verified_* не трогаем.
      // sample_collected_at не подставляем: времени забора мы не наблюдали, и
      // выдумать его значило бы записать в карту факт, которого не было.
      db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = ?").run(order.id);
      // CRM_REAL_BOOKING_V1 — прибор отдал результат по пробе, которую взяли у
      // человека здесь: для заявки колл-центра это доказательство прихода.
      crmServiceEvidence(db, [order.id]);
    }

    // Лоток (решение владельца 2026-09-28): проба принята, когда заполнена
    // каждая подтверждённая строка бланка; лишние строки прибора — справка.
    const { status, detail } = outcome(plan);
    recordMessage(db, { ...base, visitServiceId: order.id, status, detail });
  });
```

(Прежние `byCode`, `unapplied` и проверка статуса строки внутри цикла уходят: статус `P`/`X` и пустое значение теперь решает `match.js`.)

- [ ] **Шаг 4: убедиться, что проходит всё про приём**

Run: `node --test server/lis/hl7.test.js server/lis/match.test.js server/lis/ingest.test.js server/lis/discover.test.js server/lis/mllp.test.js server/services/rpc/lis.test.js`
Expected: PASS все. Закреплённые тесты D4, «никогда не выдаёт», D7 (`superseded`) и «сырое сохранено целиком» проходят без правок.

- [ ] **Шаг 5: коммит** (файлы не общие)

```bash
git add -- server/lis/ingest.js server/lis/ingest.test.js
git commit -m "Приём анализаторов: коды Mindray LOINC^ИМЯ^LN ложатся в бланк; в «Необработанные» — только когда бланк не заполнен (LIS_MINDRAY_CODES_V1)

Код бланка сравнивается с компонентом 1 или 2 поля OBX-3. Пустое значение не
стирает набранное. Тест «та же модель» шлёт полную пробу: с новым правилом
неполный бланк лежит в лотке, а тест — про приём с прибора той же модели."
```

---

### Задача 4: RPC `lis_device_codes`

**Files:**
- Modify: `server/services/rpc/lis.js`
- Modify (общий): `server/services/rpc/index.js` — импорт (строка ~70) и карта (после `lis_recent:`)
- Modify (общий): `server/services/control/gate.js` — `READ_ONLY_RPCS`, после строки `'report_freshness',`
- Modify (общий): `public/js/admin/i18n-strings.js` — после строки с ключом `"Подтвердить это сопоставление"`
- Test: `server/services/rpc/lis.test.js`

- [ ] **Шаг 1: падающие тесты**

В `server/services/rpc/lis.test.js` расширить импорт:

```js
import { lisProfiles, lisMessageAttach, lisMessageDismiss, lisDeviceCodes } from './lis.js';
```

В конец файла добавить:

```js
// ── LIS_MINDRAY_CODES_V1 — коды, которые прибор действительно присылал ───────
const RAW = (...obx) => ['MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|7|P|2.3.1',
  'OBR|1||LAB-000098|00001^Automated Count^99MRC', ...obx].join('\r');

test('коды прибора: различные, без картинок, с приборами той же модели и без чужой', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300'), (2,'Гем 2','mindray-bc-5300'), (3,'Биохимия','mindray-bs-240')").run();
  const ins = db.prepare('INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (?,?,?,?,?)');
  ins.run(1, '10.0.0.5', RAW('OBX|1|IS|08001^Take Mode^99MRC||O||||||F', 'OBX|2|NM|6690-2^WBC^LN||9.81|10*9/L|||||F',
    'OBX|3|ED|15551-4^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^Qk0=||||||F'), 'unmapped', '2026-09-28T10:00:00Z');
  ins.run(2, '10.0.0.6', RAW('OBX|1|NM|6690-2^WBC^LN||7.1|10*9/L|||||F', 'OBX|2|NM|718-7^HGB^LN||142|g/L|||||F'), 'unmapped', '2026-09-28T11:00:00Z');
  ins.run(3, '10.0.0.7', RAW('OBX|1|NM|ALT^^99MRC||31|U/L|||||F'), 'unmapped', '2026-09-28T12:00:00Z');
  ins.run(1, '10.0.0.5', 'мусор, а не HL7', 'rejected', '2026-09-28T12:30:00Z');

  const codes = lisDeviceCodes(db, { device_id: 1 }, LAB);
  assert.deepEqual(codes.map((c) => c.code + '^' + c.name).sort(), ['08001^Take Mode', '6690-2^WBC', '718-7^HGB'],
    'та же модель — те же коды; чужая модель и картинки (ED) — нет; мусор пропущен');
  const wbc = codes.find((c) => c.code === '6690-2');
  assert.equal(wbc.system, 'LN');
  assert.equal(wbc.value_type, 'NM');
  assert.equal(wbc.unit, '10*9/L');
  assert.equal(wbc.last_at, '2026-09-28T11:00:00Z', 'последний раз — по самому свежему сообщению');
  db.close();
});

test('коды прибора — только лаборатории; номер обязателен; прибор обязан существовать', () => {
  const db = fresh();
  assert.throws(() => lisDeviceCodes(db, { device_id: 1 }, { role: 'reception' }), /прав/);
  assert.throws(() => lisDeviceCodes(db, {}, LAB), /номер/);
  assert.throws(() => lisDeviceCodes(db, { device_id: 'abc' }, LAB), /номер/);
  assert.throws(() => lisDeviceCodes(db, { device_id: 999 }, LAB), /не найден/);
  db.close();
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/services/rpc/lis.test.js`
Expected: FAIL — `lisDeviceCodes is not a function` (или `does not provide an export named`).

- [ ] **Шаг 3: реализация**

В `server/services/rpc/lis.js` после строки `import { resolveMessage } from '../../lis/inbox.js';` добавить:

```js
import { parseMessage } from '../../lis/hl7.js';   // LIS_MINDRAY_CODES_V1 — тот же разбор, что у приёма
```

В конец файла добавить:

```js
// LIS_MINDRAY_CODES_V1 — сколько последних сообщений читать ради списка кодов.
// Сотня покрывает любой режим прибора и не тянет месяцы гистограмм.
const CODES_SCAN_LIMIT = 100;

/**
 * Коды, которые прибор ДЕЙСТВИТЕЛЬНО присылал, — для «Поле анализатора» в
 * редакторе панелей (решение владельца 2026-09-28: сначала присланное, потом
 * типовой список модели, потом свой код).
 *
 * Типового списка мало: он собран со скриншотов и догадок, а Mindray пишет
 * «6690-2^WBC^LN», и кода «6690-2» в нём нет. Здесь — факт из провода.
 *
 * Приборы той же модели читаются вместе: приём принимает пробу с любого из
 * одинаковых приборов (ingest.js), значит, и коды у них одни. Картинки (ED)
 * не предлагаются — в бланк они не кладутся. Неразбираемое пропускается:
 * мусор на порту кодов не имеет.
 */
export function lisDeviceCodes(db, args, user) {
  guard(user);
  const id = Number(args && args.device_id);
  if (!id) throw new LisError('Нужен номер прибора');
  const dev = db.prepare('SELECT id, profile FROM lab_devices WHERE id = ?').get(id);
  if (!dev) throw new LisError('Прибор не найден', 404);

  const ids = dev.profile
    ? db.prepare('SELECT id FROM lab_devices WHERE profile = ?').all(dev.profile).map((r) => r.id)
    : [dev.id];
  const rows = db.prepare(`SELECT raw, received_at FROM lab_device_messages
                            WHERE device_id IN (${ids.map(() => '?').join(',')})
                            ORDER BY id DESC LIMIT ?`).all(...ids, CODES_SCAN_LIMIT);

  const seen = new Map();
  for (const r of rows) {
    let msg;
    try { msg = parseMessage(r.raw); } catch { continue; }
    for (const o of msg.observations) {
      if (o.valueType.toUpperCase() === 'ED') continue;
      if (!o.code && !o.name) continue;
      const k = (o.code + '^' + o.name).toUpperCase();
      // Строки идут от свежих к старым: первое появление — последний раз.
      if (!seen.has(k)) {
        seen.set(k, { code: o.code, name: o.name, system: o.system, value_type: o.valueType, unit: o.unit, last_at: r.received_at });
      }
    }
  }
  return [...seen.values()];
}
```

В `server/services/rpc/index.js` (общий файл) заменить строку импорта

```js
import { lisProfiles, lisRestart, lisRecent, lisMessageAttach, lisMessageDismiss } from './lis.js';   // LIS_INGEST_V1
```

на

```js
import { lisProfiles, lisRestart, lisRecent, lisMessageAttach, lisMessageDismiss, lisDeviceCodes } from './lis.js';   // LIS_INGEST_V1, LIS_MINDRAY_CODES_V1
```

и сразу после строки `  lis_recent:               (db, args, user) => lisRecent(db, args, user),` вставить:

```js
  // LIS_MINDRAY_CODES_V1 — коды, которые прибор действительно присылал: из них
  // «Поле анализатора» в редакторе панелей. Чистое чтение (gate.js).
  lis_device_codes:         (db, args, user) => lisDeviceCodes(db, args, user),
```

В `server/services/control/gate.js` (общий файл) сразу после строки `  'report_freshness',` вставить:

```js
  // LIS_MINDRAY_CODES_V1 — коды, которые присылал анализатор, для редактора
  // панелей. Чистое чтение сохранённых сообщений.
  'lis_device_codes',
```

В `public/js/admin/i18n-strings.js` (общий файл) сразу после строки с ключом `"Подтвердить это сопоставление"` вставить:

```js
  // LIS_MINDRAY_CODES_V1 (2026-09-28) — коды, которые присылал анализатор
  "Нужен номер прибора": {"en":"The device number is required","ru":"Нужен номер прибора","uz":"Qurilma raqami kerak"},
  "Прибор не найден": {"en":"Device not found","ru":"Прибор не найден","uz":"Qurilma topilmadi"},
```

Перед вставкой проверить `grep -n '"Нужен номер прибора"\|"Прибор не найден"' public/js/admin/i18n-strings.js`: если ключ уже есть, второй раз его не добавлять.

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test server/services/rpc/lis.test.js server/i18n-server-messages.test.js public/js/admin/__tests__/server-messages-i18n.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`
Expected: PASS все.

- [ ] **Шаг 5: коммит** (`lis.js` и `lis.test.js` — `git add`; три общих файла — через `keep-hunks.mjs`, см. «Правила»)

```bash
git add -- server/services/rpc/lis.js server/services/rpc/lis.test.js
# для каждого из: server/services/rpc/index.js server/services/control/gate.js public/js/admin/i18n-strings.js
#   git diff -U0 -- "$F" > "$SP/own-all.patch" && node "$SP/keep-hunks.mjs" LIS_MINDRAY_CODES_V1 < "$SP/own-all.patch" > "$SP/own.patch" && git apply --cached --unidiff-zero "$SP/own.patch"
git diff --cached --stat
git commit -m "Анализаторы: RPC lis_device_codes — коды, которые прибор действительно присылал (LIS_MINDRAY_CODES_V1)"
```

---

### Задача 5: чистое правило списка «Поле анализатора»

**Files:**
- Create: `public/js/admin/views/lab-device-codes.js`
- Test: `public/js/admin/views/lab-device-codes.test.mjs`

- [ ] **Шаг 1: падающие тесты** — создать `public/js/admin/views/lab-device-codes.test.mjs`:

```js
// lab-device-codes.test.mjs — из чего выбирать «Поле анализатора»
// (LIS_MINDRAY_CODES_V1). Чистое правило: списки на входе, решение на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeChoices, TYPE_OWN } from './lab-device-codes.js';

const SENT = [
  { code: '08001', name: 'Take Mode', value_type: 'IS' },
  { code: '6690-2', name: 'WBC', value_type: 'NM' },
  { code: '718-7', name: 'HGB', value_type: 'NM' },
];
const CHANNELS = [{ code: 'WBC', name: 'Лейкоциты' }, { code: 'PLT', name: 'Тромбоциты' }];

test('присланные коды: числа впереди служебных строк, подпись «код · имя», сохраняется имя', () => {
  const c = codeChoices({ sent: SENT, channels: CHANNELS });
  assert.deepEqual(c.sent.map((o) => o.label), ['6690-2 · WBC', '718-7 · HGB', '08001 · Take Mode']);
  assert.deepEqual(c.sent.map((o) => o.value), ['WBC', 'HGB', 'Take Mode'], 'имя ловят оба вида провода');
});

test('типовой список не повторяет то, что прибор уже присылал', () => {
  assert.deepEqual(codeChoices({ sent: SENT, channels: CHANNELS }).typical.map((o) => o.value), ['PLT']);
});

test('сохранённый код узнаётся и по коду, и по имени, без учёта регистра', () => {
  assert.equal(codeChoices({ sent: SENT, channels: CHANNELS, current: '6690-2' }).selected, 'WBC');
  assert.equal(codeChoices({ sent: SENT, channels: CHANNELS, current: 'wbc' }).selected, 'WBC');
  assert.equal(codeChoices({ sent: SENT, channels: CHANNELS, current: 'PLT' }).selected, 'PLT');
});

test('код вне обоих списков не превращается в «не выбрано» — он показан отдельно', () => {
  const c = codeChoices({ sent: SENT, channels: CHANNELS, current: 'NRBC#' });
  assert.deepEqual(c.orphan, { value: 'NRBC#', label: 'NRBC#' });
  assert.equal(c.selected, 'NRBC#');
});

test('без присланных кодов остаётся типовой список; пустое сохранённое — ничего не выбрано', () => {
  const c = codeChoices({ channels: CHANNELS });
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.typical.map((o) => o.label), ['WBC · Лейкоциты', 'PLT · Тромбоциты']);
  assert.equal(c.selected, '');
  assert.equal(c.orphan, null);
});

test('пункт «Вписать код…» — служебное значение, не похожее на код прибора', () => {
  assert.match(TYPE_OWN, /^__/);
  assert.ok(!codeChoices({ sent: SENT, channels: CHANNELS }).sent.some((o) => o.value === TYPE_OWN));
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test public/js/admin/views/lab-device-codes.test.mjs`
Expected: FAIL — модуль не найден.

- [ ] **Шаг 3: реализация** — создать `public/js/admin/views/lab-device-codes.js`:

```js
// LIS_MINDRAY_CODES_V1 — ИЗ ЧЕГО ВЫБИРАТЬ «Поле анализатора». Чистая функция:
// ни DOM, ни словаря, ни сети — только списки на входе и решение на выходе.
// Тот же приём, что у lab-devices-live.js: проверять надо правило, а не разметку.
//
// Порядок — решение владельца (2026-09-28):
//   1. коды, которые ЭТОТ анализатор действительно присылал («6690-2 · WBC»);
//   2. типовой список модели (профиль) — догадка, а не факт;
//   3. свой код руками — для того, чего нет ни там, ни там.
// Выбор или ввод и есть подтверждение (D4), как было.
//
// Что сохраняется при выборе присланного кода: ИМЯ (компонент 2), если оно
// есть, иначе код. Строка бланка, подтверждённая как «WBC», ловит и
// «6690-2^WBC^LN» (сеть), и «WBC^^99MRC» (переадресатор с лабораторного ПК):
// приём сравнивает с компонентом 1 или 2 (server/lis/match.js).

/** Значение пункта «Вписать код…»: не код прибора, а команда экрана. */
export const TYPE_OWN = '__lis_type_own__';

const K = (s) => String(s == null ? '' : s).trim().toUpperCase();

/**
 * @param {object} o
 * @param {Array<{code:string,name:string,value_type?:string}>} [o.sent]  что прибор присылал (lis_device_codes)
 * @param {Array<{code:string,name:string}>} [o.channels]                каналы профиля модели
 * @param {string} [o.current]                                           сохранённый device_code строки
 * @returns {{sent:Array<{value:string,label:string}>, typical:Array<{value:string,label:string}>,
 *            orphan:{value:string,label:string}|null, selected:string}}
 *   orphan   — сохранённый код, которого нет ни в одном списке: показать отдельно, а не «не выбрано»;
 *   selected — value пункта, который изображает сохранённый код ('' — ничего не сохранено).
 */
export function codeChoices({ sent = [], channels = [], current = '' } = {}) {
    const cur = K(current);
    let selected = '';

    // Числа — вперёд: режимы пробы и референсная группа (IS) тоже присылаются,
    // но в бланк их не кладут. Внутри групп — порядок прибора.
    const ordered = sent.map((c, i) => ({ c, i }))
        .sort((a, b) => ((K(b.c.value_type) === 'NM') - (K(a.c.value_type) === 'NM')) || (a.i - b.i))
        .map((x) => x.c);

    const seen = new Set();
    const sentOpts = [];
    for (const c of ordered) {
        const value = String(c.name || c.code || '').trim();
        if (!value || seen.has(K(value))) continue;
        seen.add(K(value));
        const both = c.code && c.name && K(c.code) !== K(c.name);
        sentOpts.push({ value, label: both ? c.code + ' · ' + c.name : value });
        if (cur && !selected && (cur === K(c.code) || cur === K(c.name))) selected = value;
    }

    const typical = [];
    for (const ch of channels) {
        const value = String(ch.code || '').trim();
        // Уже есть среди присланных — второй раз не показываем.
        if (!value || seen.has(K(value))) continue;
        seen.add(K(value));
        typical.push({ value, label: ch.name ? value + ' · ' + ch.name : value });
        if (cur && !selected && cur === K(value)) selected = value;
    }

    let orphan = null;
    if (cur && !selected) {
        const value = String(current).trim();
        orphan = { value, label: value };
        selected = value;
    }
    return { sent: sentOpts, typical, orphan, selected };
}
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test public/js/admin/views/lab-device-codes.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
Expected: PASS все (в новом модуле нет кириллических литералов).

- [ ] **Шаг 5: коммит** (файлы новые)

```bash
git add -- public/js/admin/views/lab-device-codes.js public/js/admin/views/lab-device-codes.test.mjs
git commit -m "Панели: правило списка «Поле анализатора» — присланные коды, типовые, свой код (LIS_MINDRAY_CODES_V1)"
```

---

### Задача 6: редактор панелей — новая ячейка «Поле анализатора»

**Files:**
- Modify: `public/js/admin/views/lab-panels.js`
- Modify: `public/js/admin/views/laboratory.js:38` (штамп)
- Modify (общий): `public/js/admin.js:68` (штамп)
- Modify (общий): `public/js/admin/i18n-strings.js` (5 фраз)
- Test: `public/js/admin/__tests__/lab-panels-device-codes.test.mjs` (новый)

- [ ] **Шаг 1: падающий тест вида** — создать `public/js/admin/__tests__/lab-panels-device-codes.test.mjs`.

Файл начинается с шапки и импортов:

```js
// LIS_MINDRAY_CODES_V1 (2026-09-28) — «Поле анализатора» в Лаборатория → «Панели».
//
// Владелец: лаборатория обязана выбрать код, который прибор ДЕЙСТВИТЕЛЬНО
// присылает («6690-2 · WBC»), а не только догадку из типового списка, и
// вписать свой, если его нет нигде. Раньше ввод руками появлялся, только когда
// у профиля нет каналов, — у каждого Mindray список есть, и настоящий код
// ввести было нельзя.
import { test } from 'node:test';
import assert from 'node:assert';
```

Дальше **дословно** скопировать строки 38–138 из `public/js/admin/__tests__/lab-panels-mode.test.mjs`: от строки `// Fake-DOM harness — copied from …` до строки `const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));` включительно. Это fake-DOM, `window`, `localStorage` (с `admin.lang = 'ru'`), `history`, помощники `walk`/`textOf`/`findButtonByText`/`findByAriaLabel`, узел тоста и `tick`.

Затем добавить фикстуры, fake-сервер и тест:

```js
// --- fake сервер: одна панель, привязанная к прибору 1 ---------------------
const PANELS = [{ id: 'p-1', company_id: 'c-1', name: 'Общий анализ крови', modality: 'lab', has_narrative: false, service_id: 's-1', active: true, device_id: 1 }];
const ANALYTES = [{ id: 'a-1', panel_id: 'p-1', code: 'WBC', name: 'Лейкоциты', unit: '10^9/л', value_type: 'numeric', decimals: 1,
  ref_low: null, ref_high: null, group_label: '', sort_order: 0, ref_ranges: null, device_code: '', device_code_confirmed: 0 }];
const SERVICES = [{ id: 's-1', name: 'ОАК', type: 'lab', is_lab: true, department_id: 'd-1', type_id: null }];
const DEVICES = [{ id: 1, name: 'Гематология', profile: 'mindray-bc-5300', enabled: 1 }];
const PROFILES = [{ key: 'mindray-bc-5300', vendor: 'Mindray', model: 'BC-5300', channelsSource: 'screenshot',
  channels: [{ code: 'WBC', name: 'Лейкоциты' }, { code: 'PLT', name: 'Тромбоциты' }] }];
const SENT_CODES = [
  { code: '08001', name: 'Take Mode', system: '99MRC', value_type: 'IS', unit: '' },
  { code: '6690-2', name: 'WBC', system: 'LN', value_type: 'NM', unit: '10*9/L' },
];

let rpcCalls = [];
let writes = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') writes.push(body);
    const rows = {
      lab_panels: PANELS, lab_panel_analytes: ANALYTES, services: SERVICES, lab_devices: DEVICES,
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }], service_types: [],
      visit_services: [], visits: [], lab_results: [],
    }[body && body.table] || [];
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') return { ok: true, json: async () => ({ data: PROFILES }) };
    if (name === 'lis_device_codes') return { ok: true, json: async () => ({ data: SENT_CODES }) };
    return { ok: true, json: async () => ({ data: null }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { setEffectiveFromRole } = await import('../permissions.js');
const LAB_SEEDED = { name: 'lab', permissions: { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } } };

test('«Поле анализатора»: присланные коды первыми, свой код вписывается и сохраняется подтверждённым', async () => {
  setEffectiveFromRole(LAB_SEEDED);
  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick(80);

  assert.ok(rpcCalls.some((c) => c.name === 'lis_device_codes' && c.args && c.args.device_id === 1),
    'редактор спросил коды прибора панели: ' + JSON.stringify(rpcCalls));

  const sel = walk(root).find((n) => n.tagName === 'SELECT' && walk(n).some((o) => o.tagName === 'OPTGROUP'));
  assert.ok(sel, 'у строки показателя — список с группами');
  assert.deepStrictEqual(walk(sel).filter((n) => n.tagName === 'OPTGROUP').map((g) => g.attrs.label),
    ['Присылал этот анализатор', 'Типовые для модели']);
  const labels = walk(sel).filter((n) => n.tagName === 'OPTION').map((o) => textOf(o));
  assert.ok(labels.includes('6690-2 · WBC'), 'присланный код с обеими частями: ' + labels.join(' | '));
  assert.ok(labels.indexOf('6690-2 · WBC') < labels.indexOf('PLT · Тромбоциты'), 'присланное — раньше типового');
  assert.ok(!labels.includes('WBC · Лейкоциты'), 'WBC уже есть среди присланных — второй раз не показан');
  assert.strictEqual(labels[labels.length - 1], 'Вписать код…', 'свой код — последним пунктом');

  // «Вписать код…» → поле ввода → вписанный код сохраняется подтверждённым.
  sel.value = '__lis_type_own__';
  sel.dispatchEvent({ type: 'change', target: sel });
  await tick();
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === 'код канала');
  assert.ok(inp, 'появилось поле для своего кода');
  inp.value = 'NRBC#';
  inp.dispatchEvent({ type: 'input', target: inp });

  findButtonByText(root, /Сохранить панель/).click();
  await tick(80);
  const ins = writes.find((w) => w.table === 'lab_panel_analytes' && w.op === 'insert');
  assert.ok(ins, 'показатели записаны: ' + JSON.stringify(writes.map((w) => w.table + ':' + w.op)));
  const row = [].concat(ins.values).find((r) => r.name === 'Лейкоциты');
  assert.strictEqual(row.device_code, 'NRBC#');
  assert.strictEqual(row.device_code_confirmed, 1, 'вписал сам — это и есть подтверждение');
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test public/js/admin/__tests__/lab-panels-device-codes.test.mjs`
Expected: FAIL на `lis_device_codes` (редактор ещё не спрашивает) или на поиске `OPTGROUP`.

- [ ] **Шаг 3: реализация в `public/js/admin/views/lab-panels.js`**

3.1. После строки `import { isLabService, deptKindMap, typeNameMap } from './lab-service.js';   // …` добавить:

```js
import { codeChoices, TYPE_OWN } from './lab-device-codes.js';   // LIS_MINDRAY_CODES_V1 — присланные коды, типовые, свой код
```

3.2. Строку `export const LAB_BUILD = 'lab-v12';   // LAB_RANGES_VISIBLE_V1 — named ranges as a visible link + presets` заменить на:

```js
export const LAB_BUILD = 'lab-v13';   // LIS_MINDRAY_CODES_V1 — «Поле анализатора»: присланные коды, типовые, свой код
```

3.3. В объекте `state` строку `        devices: [], profiles: [] };` заменить на:

```js
        devices: [], profiles: [],
        // LIS_MINDRAY_CODES_V1 — коды, которые прибор действительно присылал, по id прибора.
        deviceCodes: {} };
```

3.4. В `reload()` сразу после строки `        state.profiles = (profilesRes && profilesRes.data) || [];` добавить:

```js
        state.deviceCodes = {};   // LIS_MINDRAY_CODES_V1 — после сохранения перечитать: прибор мог прислать новое
```

3.5. Сразу перед строкой `    let panelToken = 0;` добавить функцию:

```js
    // LIS_MINDRAY_CODES_V1 — коды, которые прибор действительно присылал.
    // Отказ не фатален: остаются типовой список и свой код.
    async function loadDeviceCodes(deviceId) {
        const id = Number(deviceId);
        if (!id || state.deviceCodes[id]) return;
        state.deviceCodes[id] = [];   // не спрашивать дважды, пока ждём ответ
        const { data, error } = await supabase.rpc('lis_device_codes', { device_id: id });
        if (error) { console.warn('[lab-panels] lis_device_codes:', error.message || error); return; }
        state.deviceCodes[id] = Array.isArray(data) ? data : [];
        if (state.selected && Number(state.selected.device_id) === id) paintEditor();
    }
```

3.6. В `selectPanel` заменить две строки

```js
        state.rowsPanelId = p.id || null;       // чьи показатели сейчас в редакторе
        paintEditor();
```

на

```js
        state.rowsPanelId = p.id || null;       // чьи показатели сейчас в редакторе
        paintEditor();
        loadDeviceCodes(p.device_id);           // LIS_MINDRAY_CODES_V1 — перерисует, когда придёт ответ
```

3.7. Строку

```js
        devSel.onchange = () => { p.device_id = Number(devSel.value) || null; suggestMapping(p.device_id); paintEditor(); };
```

заменить на

```js
        devSel.onchange = () => { p.device_id = Number(devSel.value) || null; suggestMapping(p.device_id); paintEditor(); loadDeviceCodes(p.device_id); };
```

3.8. Функцию `deviceCell(r)` целиком (от `    /** Ячейка «Поле анализатора» одной строки. */` до закрывающей `    }` перед `    function analyteRow(r, idx) {`) заменить на:

```js
    /** Ячейка «Поле анализатора» одной строки. */
    function deviceCell(r) {
        if (!state.selected || !state.selected.device_id) {
            return h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('укажите «Анализатор» над таблицей'));
        }
        // LIS_MINDRAY_CODES_V1 — порядок решил владелец (2026-09-28): что прибор
        // действительно присылал, потом типовой список модели, потом свой код.
        // Раньше ввод руками появлялся, только когда у профиля нет каналов, — и
        // настоящий код Mindray («6690-2») ввести было нельзя.
        const sent = state.deviceCodes[Number(state.selected.device_id)] || [];
        const choice = codeChoices({ sent, channels: deviceChannels(), current: r.device_code });
        const noLists = !choice.sent.length && !choice.typical.length;

        if (r._typing || noLists) {
            const inp = h('input', {
                value: r.device_code || '', placeholder: 'код канала', class: 'lw-inp', style: { width: '130px' },
                title: 'Впишите код так, как его присылает прибор',
                // Вписал сам — это и есть подтверждение.
                oninput: (e) => { r.device_code = e.target.value; r.device_code_confirmed = e.target.value.trim() ? 1 : 0; },
            });
            if (noLists) return inp;
            return h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, inp,
                h('button', {
                    class: 'lp-ic', type: 'button', title: 'Вернуться к списку', 'aria-label': 'Вернуться к списку',
                    onclick: () => { r._typing = false; paintEditor(); },
                }, '↩'));
        }

        const suggested = !!(r.device_code || '').trim() && !r.device_code_confirmed;
        const opt = (o) => h('option', { value: o.value, selected: o.value === choice.selected ? true : null }, o.label);
        const sel = h('select', {
            class: 'lw-inp',
            style: { width: '170px', ...(suggested ? { opacity: '0.65', fontStyle: 'italic' } : {}) },
            onchange: (e) => {
                if (e.target.value === TYPE_OWN) { r._typing = true; paintEditor(); return; }
                // Человек выбрал сам — это и есть подтверждение.
                r.device_code = e.target.value; r.device_code_confirmed = e.target.value ? 1 : 0; paintEditor();
            },
        },
            h('option', { value: '', selected: !choice.selected ? true : null }, '— не выбрано —'),
            choice.orphan ? opt(choice.orphan) : null,
            choice.sent.length ? h('optgroup', { label: tr('Присылал этот анализатор') }, ...choice.sent.map(opt)) : null,
            choice.typical.length ? h('optgroup', { label: tr('Типовые для модели') }, ...choice.typical.map(opt)) : null,
            h('option', { value: TYPE_OWN }, 'Вписать код…'));

        if (!suggested) return sel;
        return h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, sel,
            h('button', {
                class: 'lp-ic', type: 'button', title: 'Подтвердить это сопоставление',
                'aria-label': 'Подтвердить сопоставление',
                onclick: () => { r.device_code_confirmed = 1; paintEditor(); },
            }, Icon('Check', { size: 12 })));
    }
```

(`h()` сам переводит `title`, `placeholder`, `aria-label` и текст детей через `tr()`. `label` у `optgroup` он не переводит — поэтому там явный `tr()`. Флаг `r._typing` в базу не едет: `savePanel` пишет поля по списку.)

3.9. В `public/js/admin/views/laboratory.js` в строке импорта `lab-panels.js?v=panelsv3` заменить на `lab-panels.js?v=panelsv4`.

3.10. В `public/js/admin.js` (общий файл), в строке `import { renderLaboratory }   from './admin/views/laboratory.js?v=labwords1';   // …`:
- заменить `labwords1` на `labwords2`;
- в конец этой строки дописать ` · LIS_MINDRAY_CODES_V1 — штамп`.

3.11. В `public/js/admin/i18n-strings.js` (общий файл) сразу после строки `"Прибор не найден": …` (из задачи 4) вставить:

```js
  // LIS_MINDRAY_CODES_V1 (2026-09-28) — «Поле анализатора» в редакторе панелей
  "Присылал этот анализатор": {"en":"Sent by this analyzer","ru":"Присылал этот анализатор","uz":"Shu analizator yuborgan"},
  "Типовые для модели": {"en":"Typical for this model","ru":"Типовые для модели","uz":"Model uchun odatiy"},
  "Вписать код…": {"en":"Type a code…","ru":"Вписать код…","uz":"Kodni yozish…"},
  "Впишите код так, как его присылает прибор": {"en":"Type the code exactly as the analyzer sends it","ru":"Впишите код так, как его присылает прибор","uz":"Kodni analizator yuborganidek yozing"},
  "Вернуться к списку": {"en":"Back to the list","ru":"Вернуться к списку","uz":"Ro‘yxatga qaytish"},
```

Перед вставкой проверить `grep -n` каждого ключа: уже существующий второй раз не добавлять.

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test public/js/admin/__tests__/lab-panels-device-codes.test.mjs public/js/admin/__tests__/lab-panels-mode.test.mjs public/js/admin/views/lab-device-codes.test.mjs public/js/admin/views/lab-devices.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs`
Expected: PASS все.

- [ ] **Шаг 5: коммит** (`lab-panels.js`, `laboratory.js`, новый тест — `git add`; `admin.js` и `i18n-strings.js` — через `keep-hunks.mjs`)

```bash
git add -- public/js/admin/views/lab-panels.js public/js/admin/views/laboratory.js public/js/admin/__tests__/lab-panels-device-codes.test.mjs
# public/js/admin.js и public/js/admin/i18n-strings.js — свои ханки через keep-hunks.mjs (метка LIS_MINDRAY_CODES_V1)
git diff --cached --stat
git commit -m "Панели: «Поле анализатора» — коды, которые прибор присылал, типовой список и свой код (LIS_MINDRAY_CODES_V1)"
```

---

### Задача 7: симулятор — режим «провод Mindray» (репозиторий `analyzers`)

Рабочий каталог: `C:\Users\user\Desktop\analyzers` (ветка `master`). Неотслеживаемый `data/` не трогать и не добавлять.

**Files:**
- Create: `forwarder/mindray-wire.js`
- Modify: `forwarder/hl7-oru.js`
- Test: `forwarder/hl7-oru.test.js` (новый)
- Modify: `server.js`, `public/index.html`

- [ ] **Шаг 1: падающие тесты** — создать `forwarder/hl7-oru.test.js`:

```js
// hl7-oru.test.js — сборка ORU для симулятора и переадресатора.
// LIS_MINDRAY_CODES_V1: режим «провод Mindray» пишет OBX-3 так, как настоящий
// прибор («6690-2^WBC^LN»), — чтобы тесты Easy-Med перестали быть кругом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOru } from './hl7-oru.js';

const values = [{ code: 'WBC', value: '9.81', unit: '10*9/L' }, { code: 'ALY%', value: '0.4', unit: '%' }];

test('обычный режим не изменился: КОД^^99MRC, MSH-4 = LabPC, без служебных строк', () => {
  const seg = buildOru({ model: 'BC-5300', sampleId: 'LAB-000098', values, controlId: '7' }).split('\r');
  assert.match(seg[0], /^MSH\|\^~\\&\|BC-5300\|LabPC\|/);
  assert.equal(seg[2], 'OBX|1|NM|WBC^^99MRC||9.81|10*9/L|||||F');
  assert.equal(seg[3], 'OBX|2|NM|ALY%^^99MRC||0.4|%|||||F');
  assert.equal(seg.length, 4);
});

test('режим Mindray: LOINC^ИМЯ^LN, частный код для остальных, служебные строки и гистограмма', () => {
  const seg = buildOru({ model: 'BC-5300', sampleId: 'LAB-000098', values, controlId: '7', wire: 'mindray' }).split('\r');
  assert.match(seg[0], /^MSH\|\^~\\&\|BC-5300\|Mindray\|/);
  const obx = seg.filter((s) => s.startsWith('OBX|'));
  const ids = obx.map((s) => s.split('|')[3]);
  assert.deepEqual(ids.slice(0, 4), ['08001^Take Mode^99MRC', '08002^Blood Mode^99MRC', '08003^Test Mode^99MRC', '01002^Ref Group^99MRC']);
  assert.equal(ids[4], '6690-2^WBC^LN');
  assert.match(ids[5], /^\d{5}\^ALY%\^99MRC$/);
  assert.equal(ids[6], '15551-4^WBC Histogram. BMP^99MRC');
  assert.equal(obx[4], 'OBX|5|NM|6690-2^WBC^LN||9.81|10*9/L|||||F');
  assert.equal(obx[6].split('|')[2], 'ED');
  assert.equal(obx.map((s) => s.split('|')[1]).join(','), '1,2,3,4,5,6,7', 'номера OBX идут подряд');
});

test('частный код стабилен: один параметр — один код, где бы он ни стоял', () => {
  const idOf = (m) => m.split('\r').find((s) => s.includes('^ALY%^')).split('|')[3];
  const a = buildOru({ model: 'X', sampleId: '1', values: [{ code: 'ALY%', value: '1' }], wire: 'mindray' });
  const b = buildOru({ model: 'X', sampleId: '1', values: [{ code: 'PCT', value: '1' }, { code: 'ALY%', value: '1' }], wire: 'mindray' });
  assert.equal(idOf(a), idOf(b));
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run (в `C:\Users\user\Desktop\analyzers`): `node --test forwarder/hl7-oru.test.js`
Expected: FAIL — в режиме Mindray `MSH-4` = `LabPC`, а OBX-3 = `WBC^^99MRC`.

- [ ] **Шаг 3: реализация**

Создать `forwarder/mindray-wire.js`:

```js
// LIS_MINDRAY_CODES_V1 — как НАСТОЯЩИЙ Mindray пишет результат.
//
// Mindray кладёт в OBX-3 три компонента: «LOINC^ИМЯ^LN», например
// «6690-2^WBC^LN». Так в публичных протоколах BC-5380 и BC-20S/30S и в полевой
// записи BC-3600 (2026-09-03). Параметры без кода LOINC идут частным кодом
// Mindray: «ЧИСЛО^ИМЯ^99MRC». Кроме результатов, в каждом сообщении есть
// служебные строки (режимы пробы, референсная группа) и картинки гистограмм.
//
// Режим «провод Mindray» симулятора шлёт именно это, чтобы тесты Easy-Med
// перестали быть кругом: раньше симулятор слал «КОД^^99MRC» с кодами из наших
// же профилей, и ошибиться в коде было нечем.
//
// Коды LOINC — типовые из публичных протоколов; сверить с первой настоящей
// записью прибора в клинике.

export const LOINC = {
  'WBC': '6690-2',
  'BAS#': '704-7',   'BAS%': '706-2',
  'NEU#': '751-8',   'NEU%': '770-8',
  'EOS#': '711-2',   'EOS%': '713-8',
  'LYM#': '731-0',   'LYM%': '736-9',
  'MON#': '742-7',   'MON%': '5905-5',
  'RBC': '789-8',    'HGB': '718-7',    'HCT': '4544-3',
  'MCV': '787-2',    'MCH': '785-6',    'MCHC': '786-4',
  'RDW-CV': '788-0', 'RDW-SD': '21000-5',
  'PLT': '777-3',    'MPV': '32623-1',  'PDW': '32207-3',
};

/** Служебные строки, которые Mindray шлёт с каждой пробой; в бланк они не идут. */
export const SERVICE_LINES = [
  { id: '08001^Take Mode^99MRC',  type: 'IS', value: 'O' },
  { id: '08002^Blood Mode^99MRC', type: 'IS', value: 'W' },
  { id: '08003^Test Mode^99MRC',  type: 'IS', value: 'CBC+DIFF' },
  { id: '01002^Ref Group^99MRC',  type: 'IS', value: 'General' },
];

/** Картинка гистограммы — строка ED, как у настоящего прибора, только крошечная. */
export const HISTOGRAM_LINE = { id: '15551-4^WBC Histogram. BMP^99MRC', type: 'ED', value: '^Image^BMP^Base64^Qk0=' };

// Частный код Mindray стабилен для имени: один параметр — один код, где бы он
// ни стоял в сообщении.
const privateCode = (code) => String(10000 + [...String(code)].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) % 9000, 0));

/** OBX-3 результата так, как его пишет Mindray. */
export function mindrayId(code) {
  const loinc = LOINC[String(code).toUpperCase()];
  return loinc ? `${loinc}^${code}^LN` : `${privateCode(code)}^${code}^99MRC`;
}
```

В `forwarder/hl7-oru.js`:

1. После шапки добавить импорт:

```js
import { SERVICE_LINES, HISTOGRAM_LINE, mindrayId } from './mindray-wire.js';   // LIS_MINDRAY_CODES_V1
```

2. Функцию `buildOru` (с её JSDoc) заменить на:

```js
/**
 * @param {object} o
 * @param {string} o.model      кто шлёт (MSH-3) — по нему Easy-Med заводит прибор
 * @param {string} o.sampleId   номер пробы (OBR-3)
 * @param {Array<{code:string,value:string,unit?:string,range?:string,flag?:string,status?:string}>} o.values
 * @param {string} [o.controlId]
 * @param {string} [o.observedAt]  время анализа по прибору, YYYYMMDDHHMMSS
 * @param {'plain'|'mindray'} [o.wire]  'plain' — «КОД^^99MRC», как переадресатор;
 *        'mindray' — как настоящий прибор: «LOINC^ИМЯ^LN», служебные строки,
 *        гистограмма (LIS_MINDRAY_CODES_V1). Переадресатор всегда 'plain'.
 */
export function buildOru({ model, sampleId, values = [], controlId, observedAt, wire = 'plain' }) {
  const now = stamp();
  const id = controlId || String(Date.now() % 1000000);
  const mindray = wire === 'mindray';
  const segs = [
    // Настоящий Mindray пишет в MSH-4 «Mindray»; переадресатор — «LabPC».
    `MSH|^~\\&|${model}|${mindray ? 'Mindray' : 'LabPC'}|||${now}||ORU^R01|${id}|P|2.3.1`,
    `OBR|1||${sampleId}|00001^Automated Count^99MRC|||${observedAt || now}`,
  ];
  const lines = mindray ? SERVICE_LINES.map((s) => ({ ...s })) : [];
  for (const v of values) {
    const val = String(v.value == null ? '' : v.value);
    const numeric = /^-?\d+(\.\d+)?$/.test(val);
    lines.push({
      id: mindray ? mindrayId(v.code) : `${v.code}^^99MRC`,
      type: numeric ? 'NM' : 'ST', value: val,
      unit: v.unit, range: v.range, flag: v.flag, status: v.status,
    });
  }
  if (mindray) lines.push({ ...HISTOGRAM_LINE });
  lines.forEach((l, i) => {
    segs.push([
      'OBX', String(i + 1), l.type, l.id, '', l.value,
      l.unit || '', l.range || '', l.flag || '', '', '', l.status || 'F',
    ].join('|'));
  });
  return segs.join('\r');
}
```

В `server.js` строку

```js
      const message = buildOru({ model: profile.model, sampleId, values });
```

заменить на

```js
      // LIS_MINDRAY_CODES_V1 — «провод Mindray» по умолчанию: так говорит настоящий прибор.
      const message = buildOru({ model: profile.model, sampleId, values, wire: body.wire === 'plain' ? 'plain' : 'mindray' });
```

В `public/index.html` сразу после блока поля «Порт» (`<input id="port" value="2575" size="6">` и его закрывающий `</div>`) вставить:

```html
      <div class="field">
        <label for="wire">Провод</label>
        <select id="wire">
          <option value="mindray" selected>Как настоящий Mindray (LOINC^ИМЯ^LN + служебные строки)</option>
          <option value="plain">Упрощённый (КОД^^99MRC, как переадресатор)</option>
        </select>
      </div>
```

и в теле запроса `/api/publish` после строки `        port: $('port').value,` добавить:

```js
        wire: $('wire').value,
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test forwarder/hl7-oru.test.js forwarder/protocols/astm.test.js forwarder/protocols/hl7-mllp.test.js forwarder/protocols/mindray-legacy.test.js forwarder/deliver.test.js forwarder/queue.test.js`
Expected: PASS все (прежние тесты переадресатора — без правок).

- [ ] **Шаг 5: коммит** (в репозитории `analyzers`; не пушить)

```bash
cd "C:/Users/user/Desktop/analyzers"
git add -- forwarder/mindray-wire.js forwarder/hl7-oru.js forwarder/hl7-oru.test.js server.js public/index.html
git commit -m "Симулятор: режим «провод Mindray» — LOINC^ИМЯ^LN, служебные строки и гистограмма (LIS_MINDRAY_CODES_V1)"
```

---

### Задача 8: проверка целиком и ручная проверка на dev (координатор)

- [ ] **Шаг 1: все тесты приёма, экрана и перевода**

Run (в `easymed.local`):

```bash
node --test server/lis/*.test.js server/lis/profiles/*.test.js server/services/rpc/lis.test.js \
  public/js/admin/views/lab-device-codes.test.mjs public/js/admin/views/lab-devices.test.mjs \
  public/js/admin/__tests__/lab-panels-mode.test.mjs public/js/admin/__tests__/lab-panels-device-codes.test.mjs \
  public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs \
  public/js/admin/__tests__/server-messages-i18n.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs \
  server/i18n-server-messages.test.js server/db/migrations/123.test.js
```

Expected: PASS все.

- [ ] **Шаг 2: перезапуск dev-сервера на :8000** — рецепт из памяти:
  1. остановить `node server\index.js` (не easymed.clinic, не `--test`);
  2. копия `data\easymed.db*` в `data\backup-before-restart-<yyyyMMdd-HHmm>`;
  3. `Start-Process node server\index.js -WindowStyle Hidden`;
  4. ждать `/api/health`.

- [ ] **Шаг 3: ручная проверка**
  1. Симулятор (`SIMULATOR.bat` или `node server.js` в `analyzers`), провод «Как настоящий Mindray», BC-5300, номер пробы — открытый лабораторный заказ из dev-базы, отправка на `127.0.0.1:2575`.
  2. «Панели» → панель этой услуги → «Поле анализатора»: в группе «Присылал этот анализатор» видны `6690-2 · WBC` и соседи. Выбрать для строк бланка, сохранить.
  3. Отправить пробу ещё раз.
  4. Бланк заказа: значения стоят. «Необработанные»: этой пробы там нет. «Последние результаты»: «Применено».

- [ ] **Шаг 4: полный `npm test` — только когда в дереве не пишет ни один агент.**

---

## Самопроверка плана по спецификации

| Раздел спецификации | Задача |
|---|---|
| §1 разбор (`name`/`system`/`codeRaw`, `H~N`) | 1 |
| §2 сопоставление по компоненту 1 или 2, два прохода, D4, пустое значение, полный OBX-3 в журнале | 2, 3 |
| §3 правило лотка и тексты журнала | 2, 3 |
| §4 RPC `lis_device_codes` (роли, `READ_ONLY_RPCS`, та же модель, без ED, 100 сообщений) | 4 |
| §4 ячейка: группы, свой код, код вне списков, сохраняется имя, выбор = подтверждение | 5, 6 |
| §5 симулятор | 7 |
| «Что НЕ меняется» — закреплённые тесты проходят без правок | 3 (шаг 4) |
| Тесты и ручная проверка | 1–8 |
