# U7 «Последний визит» — настоящий (LAST_VISIT_TRUE_V1) и U8 «Повторный визит занимает время» (REPEAT_VISIT_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal.**
- **U7.** «Последний визит», «визитов: N» и «ближайшая запись» считаются по одному серверному правилу: состоявшийся визит — статус не `cancelled`/`no_show` и МЕСТНЫЙ день ≤ сегодня; последний — самый поздний такой; ближайшая запись — самый ранний такой же визит после сегодняшнего дня; «визитов» — число состоявшихся. Правило используют картотека (`patient_base_aggregates`), карта пациента (`patient_card`) и список подключённых к Telegram-боту (`telegram_links_list`). В картотеке под датой — «запись: 3 ноября 2026», без состоявшихся визитов — местный день регистрации. Пустые будущие записи не удаляются.
- **U8.** Окно «Повторный визит» кабинета: день и время обязательны; `calendar_book` принимает `visit_kind` и строку (`line: { consultation_type_id } | { service_id }`) и пишет визит и строку ОДНОЙ транзакцией (`scheduled_at` = начало, врач строки = врач записи, цена — по дню визита); если у пациента в этот день уже есть визит — отказ `revisit_day_taken` «У пациента в этот день уже есть приём в 09:00 у <врач> — выберите другой день или время.», без «Добавить в этот визит»; `dayVisitMovableFor` переносит пустую запись только если у неё нет врача или это тот же врач; врачу — «Записи вперёд · N» (свои записи на 30 дней) в «Моём дне» кабинета.

**Architecture.**
- U7: новый чистый серверный модуль `server/services/domain/visit-summary.js` → `patientVisitSummary(db, ids, { today })` — один SQL на пачку (SUM/MAX/MIN по `localDate('v.visit_date')` из `domain/day.js`, время нормализуется через `julianday`). Три двери зовут его вместо своих `COUNT(*)`/`MAX(visit_date)`/`visits[0]`. Клиент получает местные дни (`last_visit_day`, `next_visit_day`, `registration_day`) и рисует их `fmtDay`/`fmtDate`.
- U8: `calendar.js calendarBook` — «атомарный» режим при `visit_kind` или `line`: строгая проверка дня (`revisitDayTaken`, `rpcT`-шаблон, код `revisit_day_taken`) ДО любого переноса/«добавить», `visit_kind` в INSERT, строка через существующую дверь `insertBookingLine` (`crm/booking-mirror.js` — та же, что у записи колл-центра) внутри той же `db.transaction`, после транзакции `onVisitLinesAdded` (как у `cashier_line_add` и вставки строки через `/api/db`). `dayVisitMovableFor` — одна строка. Окно повторного визита (`service-workspace.js openRevisitModal`) — один `bookVisit` с `visit_kind`/`line` и `askAddToDayVisit: () => false`, отказ пишется в окне. Новый RPC только для чтения `doctor_upcoming_visits` (`server/services/rpc/doctor-upcoming.js`, «чей» — из сессии) и блок «Записи вперёд · N» под лентой «Моего дня» (`doctor-dashboard.js`).
- Миграция не нужна (номер 272 не занимаем): `visits.visit_kind` (003), `visit_services.scheduled_at`/`consultation_type_id`/`price_tier` уже есть; словарь статусов визита — `scheduled, confirmed, arrived, cancelled, no_show` (003, CHECK; позже не менялся).

**Проверено на копии.** Весь код ниже прогнан на копии `347bfd3d` (вне репозитория): новые тесты зелёные, падают на старом коде (причины указаны в шагах «run»); 111 файлов тестов дверей записи (`calendar_book`/`ensure_visit`/CRM/онлайн-запись, сервер и браузер) — с новым правилом `dayVisitMovableFor` упали ровно 3 существующих теста, их правка — в U8.1; клиентские наборы зелёные и с английской предзагрузкой.

## Карта файлов

| Файл | Задача | Что |
|---|---|---|
| `server/services/domain/visit-summary.js` | U7.1 | новый: `patientVisitSummary`, `NOT_HAPPENED_STATUSES` |
| `server/services/domain/visit-summary.test.js` | U7.1 | новый (TZ UTC+5, «сегодня» прибито) |
| `server/services/rpc/patient-aggregates.js` (+`.test.js`) | U7.2 | визиты по правилу, `next_visit*`, `registration_day` |
| `server/services/rpc/patient-card.js` (+`.test.js`) | U7.3 | шапка карты по правилу, `next_visit_date` |
| `server/services/rpc/telegram.js` (+`.test.js`) | U7.3 | `lastVisitOf` по правилу |
| `public/js/admin/data.js` | U7.4 | без `slice(0,10)`; местные дни сервера; `nextVisit` |
| `public/js/admin/views/patients.js` | U7.4 | «запись: …» под датой |
| `public/js/admin/views/patient-card.js` | U7.4 | клетка «Последний визит» — с сервера + «запись: …» |
| `public/js/admin/i18n-strings.js` | U7.4, U8.2–U8.5 | блоки `// LAST_VISIT_TRUE_V1` и `// REPEAT_VISIT_V1` перед закрывающей `};` |
| `public/js/admin/__tests__/patients-hub.test.mjs`, `patient-card-tabs.test.mjs` | U7.4 | дописать тесты |
| `server/services/crm/booking-mirror.js` | U8.1 | `dayVisitMovableFor` |
| `server/services/rpc/calendar-repeat.test.js` | U8.1, U8.2 | новый |
| `server/services/rpc/calendar.test.js`, `visits.test.js`, `server/routes/crm-calendar-v3120.test.js` | U8.1 | правка ожиданий (пустая запись другого врача больше не переносится) |
| `server/services/rpc/calendar.js` | U8.2 | `VISIT_KINDS`, `revisitDayTaken`, `visit_kind` + `line` одной транзакцией |
| `public/js/admin/views/service-workspace.js` | U8.3 | окно «Повторный визит» |
| `public/js/admin/views/service-picker-modal.js` | U8.3 | шаблон `revisit_day_taken` в `BOOK_ERROR_TEMPLATES` |
| `public/js/admin/__tests__/revisit-repeat-visit.test.mjs` | U8.3 | новый (настоящий сервер) |
| `server/services/rpc/doctor-upcoming.js` (+`.test.js`) | U8.4 | новый RPC `doctor_upcoming_visits` |
| `server/services/rpc/index.js`, `server/services/control/gate.js` | U8.4 | регистрация, `READ_ONLY_RPCS` |
| `public/js/admin/views/doctor-dashboard.js` (+`__tests__/doctor-dashboard.test.mjs`) | U8.5 | «Записи вперёд · N» |

## Правила для всех задач

- Команды — из корня `C:\Users\user\Desktop\implementation workflow\easymed.api5` (Git Bash). Тесты — только целевые: `node --experimental-vm-modules --test <файлы>`. Клиентские наборы — ещё раз с английской предзагрузкой: `FE="file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"` и `node --import "$FE" --experimental-vm-modules --test <файлы>`.
- Правки — инструментом Edit (точный текст «найти» → «заменить»), новые файлы — Write. Не heredoc в Bash (он ест обратную косую черту). Номера строк в плане приблизительные: U1, U2, U4, U5, U6, U9 идут раньше (порядок `U1 → U2 → U4 → U7 → U5 → U6 → U9 → U8`) и сдвигают строки; каждая правка привязана к тексту. Если текст «найти» изменён предыдущей задачей — найти то же место по смыслу (оно названо у каждой правки) и сохранить поведение обеих задач.
- `i18n-strings.js`: новые статьи — перед ЕДИНСТВЕННОЙ строкой файла, равной `};` (`grep -n '^};' public/js/admin/i18n-strings.js` — одна строка). Если там уже стоит блок другой задачи — вставлять после него. U8.3–U8.5 дописывают в блок `// REPEAT_VISIT_V1`, открытый в U8.2, — перед строкой `  // /REPEAT_VISIT_V1`.
- Коммит: сообщение пишется инструментом Write в `.git/U78_MSG.txt` (внутри `.git`, в индекс не попадает); перед `git add` индекс пуст (`git diff --cached --quiet`); добавляются только названные файлы; `git commit -F .git/U78_MSG.txt`; последняя строка сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Маркер каждой правки — `LAST_VISIT_TRUE_V1` (U7) или `REPEAT_VISIT_V1` (U8) в русском комментарии. Тексты интерфейса — ключи `i18n-strings.js` ru/uz/en (в uz/en без кириллицы); значки — только `Icon()`. Местный день — только через `domain/day.js` (`localDate`, `today`, `localRangeWhere`), никаких `toISOString().slice(0, 10)`.

---

### Task U7.1: Одно правило «состоявшийся визит» — `patientVisitSummary`

**Files:**
- Create: `server/services/domain/visit-summary.js`
- Test (create): `server/services/domain/visit-summary.test.js`

- [ ] **Step 1: failing test** — создать `server/services/domain/visit-summary.test.js`:

```js
// LAST_VISIT_TRUE_V1 — «последний визит» — последний СОСТОЯВШИЙСЯ (≤ сегодня,
// не отменён, не «не пришёл»), «ближайшая запись» — отдельно, «визитов» —
// только состоявшиеся. День — МЕСТНЫЙ: клиника в UTC+5.
//
// Часовой пояс задаётся явно и ДО первого запроса к базе (SQLite берёт
// 'localtime' у среды процесса), а «сегодня» прибито аргументом — тест не
// зависит ни от машины, ни от того, что сейчас полночь.
process.env.TZ = 'UZT-5';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../../db/connection.js');
const { migrate } = await import('../../db/migrate.js');
const { patientVisitSummary } = await import('./visit-summary.js');

const TODAY = '2026-11-02';

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  for (const id of [1, 2, 3, 4]) db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(id, 'П' + id);
  return db;
}
const visit = (db, pid, at, status = 'scheduled') =>
  db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)').run(pid, at, status);

test('будущие, отменённые и неявки не входят; ближайшая запись — отдельно', () => {
  const db = freshDb();
  try {
    visit(db, 1, '2026-10-20T05:00:00Z', 'arrived');     // 20.10 — состоялся
    visit(db, 1, '2026-10-25T05:00:00Z', 'cancelled');   // отменён
    visit(db, 1, '2026-10-28T05:00:00Z', 'no_show');     // не пришёл
    visit(db, 1, '2026-11-02T18:59:00Z');                // 02.11 23:59 местного — СЕГОДНЯ, состоялся
    visit(db, 1, '2026-11-02T20:00:00Z', 'cancelled');   // 03.11 01:00 — отменённая запись не «ближайшая»
    visit(db, 1, '2026-11-03T04:00:00Z');                // 03.11 09:00 — ближайшая запись
    visit(db, 1, '2026-11-10T04:00:00Z');                // 10.11 — дальше
    const s = patientVisitSummary(db, [1], { today: TODAY }).get(1);
    assert.equal(s.visit_count, 2, 'визитов — только состоявшиеся: 20.10 и сегодня');
    assert.equal(Date.parse(s.last_visit), Date.parse('2026-11-02T18:59:00Z'), 'последний визит — не будущая запись');
    assert.equal(s.last_visit_day, '2026-11-02');
    assert.equal(Date.parse(s.next_visit), Date.parse('2026-11-03T04:00:00Z'), 'ближайшая запись — не отменённая');
    assert.equal(s.next_visit_day, '2026-11-03');
  } finally { db.close(); }
});

test('визит в 19:00Z — следующий МЕСТНЫЙ день (00:00 по Ташкенту), а не сегодняшний', () => {
  const db = freshDb();
  try {
    visit(db, 2, '2026-11-02T19:00:00.000Z');            // 03.11 00:00 местного
    visit(db, 3, '2026-11-02T18:59:59Z');                // 02.11 23:59:59 местного
    const m = patientVisitSummary(db, [2, 3], { today: TODAY });
    assert.deepEqual([m.get(2).visit_count, m.get(2).last_visit, m.get(2).next_visit_day], [0, null, '2026-11-03']);
    assert.equal(Date.parse(m.get(2).next_visit), Date.parse('2026-11-02T19:00:00Z'), 'время приходит как было, в UTC');
    assert.deepEqual([m.get(3).visit_count, m.get(3).last_visit_day, m.get(3).next_visit], [1, '2026-11-02', null]);
  } finally { db.close(); }
});

test('пациент без визитов — нули; мусор в списке и пустой список — без ошибок', () => {
  const db = freshDb();
  try {
    const m = patientVisitSummary(db, [4, '4', 0, -1, 'x', null], { today: TODAY });
    assert.deepEqual([...m.keys()], [4]);
    assert.deepEqual(m.get(4), { visit_count: 0, last_visit: null, last_visit_day: null, next_visit: null, next_visit_day: null });
    assert.equal(patientVisitSummary(db, [], { today: TODAY }).size, 0);
    assert.throws(() => patientVisitSummary(db, [4], { today: '02.11.2026' }), /YYYY-MM-DD/);
  } finally { db.close(); }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test server/services/domain/visit-summary.test.js
```
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`./visit-summary.js` не существует).

- [ ] **Step 3: implement** — создать `server/services/domain/visit-summary.js`:

```js
// LAST_VISIT_TRUE_V1 (2026-11-02) — «ПОСЛЕДНИЙ ВИЗИТ», «БЛИЖАЙШАЯ ЗАПИСЬ» И
// «ВИЗИТОВ» — ОДНО ПРАВИЛО НА ВСЕ ЭКРАНЫ.
//
// Было три копии одного неверного определения: картотека
// (rpc/patient-aggregates.js), карта пациента (rpc/patient-card.js) и
// подключённые пациенты Telegram-бота (rpc/telegram.js) брали MAX(visit_date)
// и COUNT(*) по ВСЕМ визитам. Будущая запись — в том числе пустая, которую
// автоперенос поставил на завтра, — выигрывала у настоящего приёма, а
// отменённые и неявки считались «визитами».
//
// Правило (решение владельца, выпуск 3.21.0):
//   • состоявшийся визит — статус не «отменён» и не «не пришёл», и МЕСТНЫЙ
//     день визита ≤ сегодня клиники (domain/day.js — тот же 'localtime', что у
//     отчётов: приём в 00:30 по Ташкенту хранится как 19:30Z накануне);
//   • «визитов» — число состоявшихся;
//   • «последний визит» — самый поздний состоявшийся;
//   • «ближайшая запись» — самый ранний такой же визит ПОСЛЕ сегодняшнего дня.
// Визиты всех зданий считаются: картотека клиники общая (PATIENTS_CLINIC_WIDE_V1).
// Пустые будущие записи не удаляются — их видно в календаре; здесь они просто
// перестают быть «последним визитом».
//
// Время возвращается нормализованным ISO UTC ('…T…Z', через julianday): в базе
// лежат и '…:00Z', и '…:00.000Z', и строковый MAX между ними не всегда честен.
import { localDate, today as clinicToday } from './day.js';

export const NOT_HAPPENED_STATUSES = Object.freeze(['cancelled', 'no_show']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 500;

const empty = () => ({ visit_count: 0, last_visit: null, last_visit_day: null, next_visit: null, next_visit_day: null });

/**
 * Визиты пациентов по правилу выше, одним запросом на пачку.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} patientIds
 * @param {{ today?: string }} [opts] today — местный 'YYYY-MM-DD' (для тестов);
 *        по умолчанию — сегодня клиники (domain/day.js today).
 * @returns {Map<number, { visit_count: number, last_visit: string|null,
 *   last_visit_day: string|null, next_visit: string|null, next_visit_day: string|null }>}
 *   ключ — id пациента; у пациента без визитов — нули и null.
 */
export function patientVisitSummary(db, patientIds, { today = null } = {}) {
  const ids = [...new Set((Array.isArray(patientIds) ? patientIds : []).map(Number)
    .filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map(ids.map((id) => [id, empty()]));
  if (!ids.length) return out;
  const day = today == null ? clinicToday(db) : String(today);
  if (!YMD.test(day)) throw new Error('patientVisitSummary: today must be YYYY-MM-DD, got ' + day);
  const local = localDate('v.visit_date');
  const gone = NOT_HAPPENED_STATUSES.map((s) => `'${s}'`).join(', ');
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT pid, happened,
             strftime('%Y-%m-%dT%H:%M:%SZ', last_jd) AS last_visit,
             ${localDate('last_jd')}                  AS last_visit_day,
             strftime('%Y-%m-%dT%H:%M:%SZ', next_jd) AS next_visit,
             ${localDate('next_jd')}                  AS next_visit_day
        FROM (SELECT v.patient_id AS pid,
                     SUM(CASE WHEN ${local} <= ? THEN 1 ELSE 0 END)                AS happened,
                     MAX(CASE WHEN ${local} <= ? THEN julianday(v.visit_date) END) AS last_jd,
                     MIN(CASE WHEN ${local} >  ? THEN julianday(v.visit_date) END) AS next_jd
                FROM visits v
               WHERE v.patient_id IN (${part.map(() => '?').join(', ')})
                 AND v.status NOT IN (${gone})
               GROUP BY v.patient_id)`).all(day, day, day, ...part);
    for (const r of rows) {
      out.set(Number(r.pid), {
        visit_count: Number(r.happened) || 0,
        last_visit: r.last_visit || null,
        last_visit_day: r.last_visit_day || null,
        next_visit: r.next_visit || null,
        next_visit_day: r.next_visit_day || null,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: run — должен пройти**

```bash
node --experimental-vm-modules --test server/services/domain/visit-summary.test.js server/services/domain/no-drift.test.js
```
Expected: PASS (3 + 3), ни одного ✖.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt` (Write):
```
Одно правило «состоявшийся визит» для картотеки, карты и бота (LAST_VISIT_TRUE_V1)

domain/visit-summary.js — patientVisitSummary: визит считается, если он не
отменён и не «не пришёл» и его местный день не позже сегодняшнего; последний
визит — самый поздний такой, ближайшая запись — самый ранний после сегодня,
«визитов» — число состоявшихся. Один запрос на пачку пациентов, день — через
domain/day.js (визит в 19:00Z — следующий день по Ташкенту).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add server/services/domain/visit-summary.js server/services/domain/visit-summary.test.js
git commit -F .git/U78_MSG.txt
```

---

### Task U7.2: Картотека — визиты по правилу, ближайшая запись, местный день регистрации

**Files:**
- Modify: `server/services/rpc/patient-aggregates.js`
- Test (modify): `server/services/rpc/patient-aggregates.test.js` — дописать в конец

- [ ] **Step 1: failing test** — дописать в конец `server/services/rpc/patient-aggregates.test.js`:

```js

// LAST_VISIT_TRUE_V1 — «последний визит» — последний СОСТОЯВШИЙСЯ, ближайшая
// запись — отдельным полем, визиты — только состоявшиеся. Даты далеко от
// сегодняшнего дня — тест не зависит ни от часового пояса, ни от полуночи.
test('LAST_VISIT_TRUE_V1: будущая запись и отменённый визит не «последний визит»; next_visit отдельно', () => {
  const { db, p1, p2 } = seed();
  try {
    const add = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)');
    add.run(p1, '2020-01-01T09:00:00Z', 'arrived');
    add.run(p1, '2021-06-01T09:00:00Z', 'cancelled');
    add.run(p1, '2022-03-01T09:00:00Z', 'no_show');
    add.run(p1, '2099-01-01T09:00:00Z', 'scheduled');
    add.run(p1, '2099-02-01T09:00:00Z', 'scheduled');
    add.run(p2, '2099-05-05T09:00:00Z', 'scheduled');
    db.prepare("UPDATE patients SET registration_date = '2019-12-31T12:00:00Z' WHERE id = ?").run(p2);
    const rows = patientBaseAggregates(db, { p_ids: [p1, p2] }, registrar);
    const a = rows.find((r) => r.patient_id === p1);
    const b = rows.find((r) => r.patient_id === p2);
    assert.equal(a.visit_count, 1, 'отменённый, неявка и будущие — не визиты');
    assert.equal(Date.parse(a.last_visit), Date.parse('2020-01-01T09:00:00Z'), 'последним визитом стала будущая запись');
    assert.equal(a.last_visit_day, '2020-01-01');
    assert.equal(Date.parse(a.next_visit), Date.parse('2099-01-01T09:00:00Z'), 'ближайшая запись — самая ранняя будущая');
    assert.equal(a.next_visit_day, '2099-01-01');
    assert.deepEqual([b.visit_count, b.last_visit, b.next_visit_day], [0, null, '2099-05-05'], 'только будущая запись — визитов не было');
    assert.equal(b.registration_day, '2019-12-31', 'день регистрации — местный день, а не пусто');
  } finally { db.close(); }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test server/services/rpc/patient-aggregates.test.js
```
Expected: FAIL 1 — `5 !== 1` «отменённый, неявка и будущие — не визиты». Остальные 5 — PASS (существующий тест «последний визит — самый поздний» — визиты в прошлом и `arrived`, он не меняется).

- [ ] **Step 3: implement** — `server/services/rpc/patient-aggregates.js`:

**3.1** Найти (шапка файла, пояснение «что считается»):
```js
//   • визиты — все строки `visits` пациента, включая отменённые: картотека
//     отвечает на вопрос «человек у нас бывал?», а не «сколько раз дошёл»;
//   • последний визит — самая поздняя дата визита (её же показывает карта);
```
заменить на:
```js
//   • LAST_VISIT_TRUE_V1 (3.21.0) — визиты, последний визит и ближайшая
//     запись — по одному правилу domain/visit-summary.js (то же у карты
//     пациента и бота): считаются только СОСТОЯВШИЕСЯ визиты (не отменён, не
//     «не пришёл», местный день ≤ сегодня); будущая запись — отдельным полем
//     next_visit, а не «последним визитом». Прежде визитами были все строки
//     `visits`, а последним — MAX(visit_date): будущая запись выигрывала;
//   • registration_day — МЕСТНЫЙ день регистрации: его картотека пишет, когда
//     состоявшихся визитов нет (раньше браузер резал ISO до дня UTC);
```

**3.2** Найти:
```js
import { outstandingWhere } from '../domain/money.js';
```
заменить на:
```js
import { outstandingWhere } from '../domain/money.js';
import { localDate } from '../domain/day.js';   // LAST_VISIT_TRUE_V1 — местный день регистрации
import { patientVisitSummary } from '../domain/visit-summary.js';   // LAST_VISIT_TRUE_V1
```

**3.3** Найти:
```js
  const holes = use.map(() => '?').join(',');

  return db.prepare(`
    SELECT p.id AS patient_id,
           (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
           (SELECT MAX(v.visit_date) FROM visits v WHERE v.patient_id = p.id) AS last_visit,
           (SELECT
```
заменить на:
```js
  const holes = use.map(() => '?').join(',');
  const visitsOf = patientVisitSummary(db, use);   // LAST_VISIT_TRUE_V1

  return db.prepare(`
    SELECT p.id AS patient_id,
           ${localDate("COALESCE(NULLIF(p.registration_date, ''), p.created_at)")} AS registration_day,
           (SELECT
```

**3.4** Найти:
```js
     WHERE p.id IN (${holes})`).all(...use).map((r) => ({
    ...r,
    visit_count: Number(r.visit_count) || 0,
    balance:
```
заменить на:
```js
     WHERE p.id IN (${holes})`).all(...use).map((r) => ({
    ...r,
    // LAST_VISIT_TRUE_V1 — состоявшиеся визиты и ближайшая запись (domain/visit-summary.js).
    ...visitsOf.get(Number(r.patient_id)),
    registration_day: r.registration_day || null,
    balance:
```

Ответ строки теперь: `visit_count`, `last_visit` (ISO), `last_visit_day`, `next_visit` (ISO), `next_visit_day`, `registration_day` — плюс прежние `debt`, `balance`, `net_balance`, `insurer`, `payer_type`, `registrar`.

- [ ] **Step 4: run — должен пройти**

```bash
node --experimental-vm-modules --test server/services/rpc/patient-aggregates.test.js server/services/domain/no-drift.test.js
```
Expected: PASS (6 + 3).

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
Картотека: «последний визит» — последний состоявшийся, запись — отдельно (LAST_VISIT_TRUE_V1)

patient_base_aggregates считал визитами все строки visits (с отменёнными и
будущими), а последним визитом — MAX(visit_date): будущая запись выигрывала.
Теперь — правило domain/visit-summary.js; в ответе ещё next_visit /
next_visit_day (ближайшая запись) и registration_day — местный день
регистрации для пациента без состоявшихся визитов.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add server/services/rpc/patient-aggregates.js server/services/rpc/patient-aggregates.test.js
git commit -F .git/U78_MSG.txt
```

---

### Task U7.3: Карта пациента и бот — то же правило

**Files:**
- Modify: `server/services/rpc/patient-card.js`
- Modify: `server/services/rpc/telegram.js`
- Test (modify): `server/services/rpc/patient-card.test.js`, `server/services/rpc/telegram.test.js` — дописать в конец

- [ ] **Step 1: failing tests**

Дописать в конец `server/services/rpc/patient-card.test.js` (фикстура `seed()` файла: визит `2026-08-12T09:00:00Z`, статус по умолчанию `scheduled`, — в прошлом, состоялся):
```js

// LAST_VISIT_TRUE_V1 — шапка карты: «последний визит» — последний
// СОСТОЯВШИЙСЯ, ближайшая запись — отдельно; список «Визиты» — полный.
test('LAST_VISIT_TRUE_V1: будущая запись и отменённый визит не становятся «последним визитом» карты', () => {
  const { db, pid } = seed();
  db.prepare("INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date, status) VALUES (?,3,1,'2099-03-01T09:00:00Z','scheduled')").run(pid);
  db.prepare("INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date, status) VALUES (?,3,1,'2026-09-01T09:00:00Z','cancelled')").run(pid);
  const out = patientCard(db, { patient_id: pid }, REGISTRAR);
  assert.equal(out.visits.length, 3, 'вкладка «Визиты» показывает все визиты, и отменённые, и будущие');
  assert.equal(out.visit_count, 1, 'визитов — только состоявшиеся');
  assert.equal(Date.parse(out.last_visit_date), Date.parse('2026-08-12T09:00:00Z'), 'последним визитом стала будущая запись');
  assert.equal(Date.parse(out.next_visit_date), Date.parse('2099-03-01T09:00:00Z'));
  db.close();
});
```

Дописать в конец `server/services/rpc/telegram.test.js`:
```js

// LAST_VISIT_TRUE_V1 — «когда последний раз приходил» у подключённого пациента —
// последний СОСТОЯВШИЙСЯ визит: не будущая запись и не отменённый.
test('LAST_VISIT_TRUE_V1: последний визит подключённого пациента — состоявшийся, а не будущая запись', () => {
  const db = freshDb();
  const pid = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Алиев А.','+998 90 111 22 33')").run().lastInsertRowid;
  const add = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)');
  add.run(pid, '2020-01-01T09:00:00Z', 'arrived');
  add.run(pid, '2021-01-01T09:00:00Z', 'cancelled');
  add.run(pid, '2099-01-01T09:00:00Z', 'scheduled');
  db.prepare("INSERT INTO telegram_links (chat_id, phone, tg_name) VALUES ('77','998901112233','А')").run();
  const [link] = telegramLinksList(db, {}, admin);
  assert.equal(Date.parse(link.patients[0].last_visit), Date.parse('2020-01-01T09:00:00Z'));
  db.close();
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test server/services/rpc/patient-card.test.js server/services/rpc/telegram.test.js
```
Expected: FAIL 2 — карта: `3 !== 1` «визитов — только состоявшиеся»; бот: даты не равны (пришла `2099-01-01T09:00:00Z`). Остальные — PASS.

- [ ] **Step 3: implement**

**3.1** `server/services/rpc/patient-card.js` — найти:
```js
import { telegramPatientStatus } from './telegram.js';   // TELEGRAM_PATIENT_BADGE_V1
```
заменить на:
```js
import { telegramPatientStatus } from './telegram.js';   // TELEGRAM_PATIENT_BADGE_V1
import { patientVisitSummary } from '../domain/visit-summary.js';   // LAST_VISIT_TRUE_V1
```

**3.2** Там же (`patientCard`, инициализация `out`) найти:
```js
    visit_count: null, last_visit_date: null,
  };
```
заменить на:
```js
    visit_count: null, last_visit_date: null,
    next_visit_date: null,   // LAST_VISIT_TRUE_V1 — ближайшая запись, отдельно от последнего визита
  };
```

**3.3** Там же (вкладка «Визиты» выдана) найти:
```js
    out.visit_count = out.visits.length;
    out.last_visit_date = out.visits.length ? out.visits[0].visit_date : null;
  }
```
заменить на:
```js
    // LAST_VISIT_TRUE_V1 — шапка карты считает по СОСТОЯВШИМСЯ визитам (то же
    // правило, что картотека: domain/visit-summary.js). visits[0] — самая
    // поздняя строка вообще, и будущая запись (или отменённый визит) была
    // «последним визитом». Список вкладки «Визиты» остаётся полным.
    const sum = canRead('visits', roles) ? patientVisitSummary(db, [id]).get(Number(id)) : null;
    out.visit_count = sum ? sum.visit_count : 0;
    out.last_visit_date = sum ? sum.last_visit : null;
    out.next_visit_date = sum ? sum.next_visit : null;
  }
```
(`canRead` и `roles` в функции уже есть — тем же условием читаются `visitRows`; закрытая вкладка «Визиты» по-прежнему даёт `null`.)

**3.4** `server/services/rpc/telegram.js` — найти:
```js
import { findPatientsByPhone, digitsOf } from '../telegram/documents.js';
```
заменить на:
```js
import { findPatientsByPhone, digitsOf } from '../telegram/documents.js';
import { patientVisitSummary } from '../domain/visit-summary.js';   // LAST_VISIT_TRUE_V1
```

**3.5** Там же найти:
```js
function lastVisitOf(db, patientId) {
  const row = db.prepare(
    'SELECT MAX(visit_date) d FROM visits WHERE patient_id = ?').get(patientId);
  return (row && row.d) || null;
}
```
заменить на:
```js
// LAST_VISIT_TRUE_V1 — последний СОСТОЯВШИЙСЯ визит, то же правило, что у
// картотеки и карты пациента (domain/visit-summary.js). MAX(visit_date) здесь
// называл «последним посещением» будущую запись и отменённый визит.
function lastVisitOf(db, patientId) {
  const s = patientVisitSummary(db, [patientId]).get(Number(patientId));
  return (s && s.last_visit) || null;
}
```

- [ ] **Step 4: run — должен пройти**

```bash
node --experimental-vm-modules --test server/services/rpc/patient-card.test.js server/services/rpc/telegram.test.js server/services/rpc/patient-aggregates.test.js
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
Карта пациента и бот: последний визит — состоявшийся, запись — отдельно (LAST_VISIT_TRUE_V1)

Шапка карты брала visits[0] (самую позднюю строку вообще), список
подключённых к боту — MAX(visit_date). Оба теперь по правилу
domain/visit-summary.js; карта отдаёт ещё next_visit_date. Список вкладки
«Визиты» остаётся полным.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add server/services/rpc/patient-card.js server/services/rpc/patient-card.test.js server/services/rpc/telegram.js server/services/rpc/telegram.test.js
git commit -F .git/U78_MSG.txt
```

---

### Task U7.4: Экран — «запись: …» под датой, клетка карты с сервера, день регистрации местный

**Files:**
- Modify: `public/js/admin/data.js`
- Modify: `public/js/admin/views/patients.js`
- Modify: `public/js/admin/views/patient-card.js`
- Modify: `public/js/admin/i18n-strings.js`
- Test (modify): `public/js/admin/__tests__/patients-hub.test.mjs`, `public/js/admin/__tests__/patient-card-tabs.test.mjs` — дописать в конец

- [ ] **Step 1: failing tests**

Дописать в конец `public/js/admin/__tests__/patients-hub.test.mjs` (стенд файла: `AGGS` — ответ `patient_base_aggregates`, пациент `p-1`, язык ru):
```js

// LAST_VISIT_TRUE_V1 — «Последний визит» в реестре — последний СОСТОЯВШИЙСЯ
// (местный день от сервера), под датой — ближайшая запись; без состоявшихся
// визитов — местный день регистрации и «визитов не было».
test('LAST_VISIT_TRUE_V1: под датой последнего визита — «запись: …», будущая запись не «последний визит»', async () => {
  reset();
  setFullAccess('Admin');
  AGGS = [{ patient_id: 'p-1', visit_count: 2, balance: 0, debt: 0, net_balance: 0,
    last_visit: '2026-10-20T05:00:00Z', last_visit_day: '2026-10-20',
    next_visit: '2026-11-03T04:00:00Z', next_visit_day: '2026-11-03', registration_day: '2026-09-01' }];
  try {
    const { renderPatients } = await import('../views/patients.js?v=lastvisit1');
    const box = mk('div');
    await renderPatients(box, { onNavigate() {}, embedded: true });
    await tick(60);
    const t = textOf(box);
    assert.ok(t.includes('20 октября 2026'), 'нет даты последнего состоявшегося визита: ' + t.slice(0, 400));
    assert.ok(t.includes('запись: 3 ноября 2026'), 'ближайшая запись не названа под датой: ' + t.slice(0, 400));
    assert.ok(t.includes('визитов: 2'));
    // Только будущая запись: дата — день регистрации, «визитов не было», запись — под датой.
    AGGS = [{ patient_id: 'p-1', visit_count: 0, balance: 0, debt: 0, net_balance: 0,
      last_visit: null, last_visit_day: null, next_visit: '2026-11-03T04:00:00Z', next_visit_day: '2026-11-03', registration_day: '2026-09-01' }];
    const box2 = mk('div');
    await renderPatients(box2, { onNavigate() {}, embedded: true });
    await tick(60);
    const t2 = textOf(box2);
    assert.ok(t2.includes('1 сентября 2026') && t2.includes('визитов не было') && t2.includes('запись: 3 ноября 2026'), t2.slice(0, 400));
  } finally {
    AGGS = null;
  }
});
```

Дописать в конец `public/js/admin/__tests__/patient-card-tabs.test.mjs` (стенд файла: `fullPayload()`, `VISIT` — визит `2026-08-12T09:00:00Z`, `render`, `buttons`, `textOf`):
```js

// LAST_VISIT_TRUE_V1 — клетка «Последний визит» шапки берёт дату с сервера
// (последний СОСТОЯВШИЙСЯ), а не первую строку списка визитов — там первой
// стоит будущая запись. Ближайшая запись — в подписи клетки.
test('LAST_VISIT_TRUE_V1: «Последний визит» шапки — с сервера, а не первая строка визитов; запись — в подписи', async () => {
  const p = fullPayload();
  const FUTURE = { ...VISIT, id: 12, visit_date: '2099-03-01T09:00:00Z', status: 'scheduled' };
  p.visits = [FUTURE, VISIT];   // вкладка «Визиты» — от поздней к ранней
  p.visit_count = 1; p.last_visit_date = VISIT.visit_date; p.next_visit_date = FUTURE.visit_date;
  const box = await render(p);
  const cell = buttons(box).find((b) => textOf(b).includes('Последний визит'));
  assert.ok(cell, 'нет клетки «Последний визит»');
  const t = textOf(cell);
  assert.ok(t.includes('12 августа 2026'), 'в клетке не последний состоявшийся визит: ' + t);
  assert.ok(t.includes('запись: 1 марта 2099'), 'ближайшая запись не названа: ' + t);
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/patients-hub.test.mjs public/js/admin/__tests__/patient-card-tabs.test.mjs
```
Expected: FAIL 2 — «ближайшая запись не названа под датой» (реестр) и «в клетке не последний состоявшийся визит» (в клетке «1 марта 2099 г.», подпись «сегодня»). Остальные — PASS.

- [ ] **Step 3: implement**

**3.1** `public/js/admin/data.js` (`shapePatient`) — найти:
```js
        lastVisit:     row.last_visit_date || (row.registration_date || row.created_at || '').slice(0, 10),
```
заменить на:
```js
        // LAST_VISIT_TRUE_V1 — ISO целиком, без slice(0, 10): обрезка давала день
        // UTC, и карта, заведённая в 00:30 по Ташкенту, «регистрировалась»
        // вчера. Дату пишет fmtDay (местный день); сервер затем подставляет
        // свой местный день (patient_base_aggregates).
        lastVisit:     row.last_visit_date || row.registration_date || row.created_at || '',
        nextVisit:     '',                      // LAST_VISIT_TRUE_V1 — ближайшая запись (patient_base_aggregates)
```

**3.2** Там же (`loadPatientsPaged`, разбор `patient_base_aggregates`) найти:
```js
                if (a.last_visit) r.lastVisit = a.last_visit;
```
заменить на:
```js
                // LAST_VISIT_TRUE_V1 — последний СОСТОЯВШИЙСЯ визит (местный день
                // сервера); нет такого — местный день регистрации. Будущая запись —
                // отдельно: «запись: 3 ноября» под датой.
                if (a.last_visit_day) r.lastVisit = a.last_visit_day;
                else if (a.registration_day) r.lastVisit = a.registration_day;
                r.nextVisit = a.next_visit_day || '';
```

**3.3** `public/js/admin/views/patients.js` (`patientRow`) — найти:
```js
    const last = fmtDay(p.lastVisit);
```
заменить на:
```js
    const last = fmtDay(p.lastVisit);
    const next = fmtDay(p.nextVisit);   // LAST_VISIT_TRUE_V1 — ближайшая запись
```

**3.4** Там же (ячейка 4 «Последний визит») найти:
```js
            last ? h('div', { class: 'pt-when-main' }, last) : noneCell('—'),
            h('div', { class: 'pt-when-sub' }, visits > 0 ? trf('визитов: {n}', { n: visits }) : 'визитов не было'),
```
заменить на:
```js
            last ? h('div', { class: 'pt-when-main' }, last) : noneCell('—'),
            // LAST_VISIT_TRUE_V1 — будущая запись — не «последний визит»: она
            // стоит своей строкой под датой.
            next ? h('div', { class: 'pt-when-sub pt-when-next' }, trf('запись: {d}', { d: next })) : null,
            h('div', { class: 'pt-when-sub' }, visits > 0 ? trf('визитов: {n}', { n: visits }) : 'визитов не было'),
```

**3.5** `public/js/admin/views/patient-card.js` — найти:
```js
    let lastVisitDate = null;
```
заменить на:
```js
    let lastVisitDate = null;
    let nextVisitDate = null;   // LAST_VISIT_TRUE_V1 — ближайшая запись
```

**3.6** Там же (`applyCardPayload`) найти:
```js
        lastVisitDate = tabOpen('visits') ? (data.last_visit_date || null) : null;
```
заменить на:
```js
        lastVisitDate = tabOpen('visits') ? (data.last_visit_date || null) : null;
        nextVisitDate = tabOpen('visits') ? (data.next_visit_date || null) : null;   // LAST_VISIT_TRUE_V1
```

**3.7** Там же (шапка, «stat row») найти:
```js
        const lastVisit = tabOpen('visits') ? visits[0] : null;
        let daysAgo = null;
        if (lastVisit) {
            daysAgo = Math.max(0, Math.floor((Date.now() - new Date(lastVisit.visit_date).getTime()) / 86400000));
        }
```
заменить на:
```js
        // LAST_VISIT_TRUE_V1 — «Последний визит» — последний СОСТОЯВШИЙСЯ, его
        // называет сервер (last_visit_date). visits[0] была самой поздней строкой
        // вообще: будущая запись и отменённый визит выигрывали у приёма.
        const lastVisitAt = tabOpen('visits') ? lastVisitDate : null;
        const nextVisitAt = tabOpen('visits') ? nextVisitDate : null;
        let daysAgo = null;
        if (lastVisitAt) {
            daysAgo = Math.max(0, Math.floor((Date.now() - new Date(lastVisitAt).getTime()) / 86400000));
        }
```

**3.8** Там же найти:
```js
            statCell(tabOpen('visits') ? 'Clock' : 'Lock', '#2563eb', 'Последний визит',
                lastVisit ? fmtDate(lastVisit.visit_date) : '—',
                !tabOpen('visits') ? 'вкладка закрыта'
                    : (daysAgo != null
                        ? (daysAgo === 0 ? tr('сегодня') : trf('{n} дн. назад', { n: daysAgo }))
                        : 'визитов не было'),
                null, () => gotoTab('visits')),
```
заменить на:
```js
            statCell(tabOpen('visits') ? 'Clock' : 'Lock', '#2563eb', 'Последний визит',
                lastVisitAt ? fmtDate(lastVisitAt) : '—',
                !tabOpen('visits') ? 'вкладка закрыта'
                    : [
                        daysAgo != null
                            ? (daysAgo === 0 ? tr('сегодня') : trf('{n} дн. назад', { n: daysAgo }))
                            : tr('визитов не было'),
                        // LAST_VISIT_TRUE_V1 — ближайшая запись своей частью строки.
                        nextVisitAt ? trf('запись: {d}', { d: fmtDate(nextVisitAt) }) : null,
                    ].filter(Boolean).join(' · '),
                null, () => gotoTab('visits')),
```
(Строка собирается из уже переведённых частей — `tr()`/`trf()` до склейки; разделитель без кириллицы.)

**3.9** `public/js/admin/i18n-strings.js` — перед единственной строкой `};` вставить:
```js
  // LAST_VISIT_TRUE_V1
  "запись: {d}": {"en":"booked: {d}","ru":"запись: {d}","uz":"yozuv: {d}"},   // LAST_VISIT_TRUE_V1 — ближайшая запись под «последним визитом»
  // /LAST_VISIT_TRUE_V1
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/patients-hub.test.mjs public/js/admin/__tests__/patient-card-tabs.test.mjs public/js/admin/__tests__/patient-row.test.mjs public/js/admin/__tests__/patient-card-v3120.test.mjs public/js/admin/__tests__/patient-card-docs.test.mjs public/js/admin/__tests__/patient-card-history.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS, ни одного ✖ (оба прогона). `i18n-coverage.test.mjs` идёт больше минуты — это его обычная скорость.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
Реестр и карта: «запись: …» под последним визитом, день регистрации местный (LAST_VISIT_TRUE_V1)

Реестр пациентов берёт с сервера местный день последнего СОСТОЯВШЕГОСЯ
визита, а без него — местный день регистрации (браузер больше не режет ISO
до дня UTC). Ближайшая запись — отдельной строкой «запись: 3 ноября 2026»
под датой. Клетка «Последний визит» карты — дата с сервера, а не первая
строка списка визитов (там стояла будущая запись), и в подписи — запись.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/data.js public/js/admin/views/patients.js public/js/admin/views/patient-card.js public/js/admin/i18n-strings.js public/js/admin/__tests__/patients-hub.test.mjs public/js/admin/__tests__/patient-card-tabs.test.mjs
git commit -F .git/U78_MSG.txt
```

---

### Task U8.1: Пустая запись одного врача не переезжает под запись другого

**Files:**
- Modify: `server/services/crm/booking-mirror.js` (`dayVisitMovableFor`)
- Test (create): `server/services/rpc/calendar-repeat.test.js`
- Test (modify): `server/services/rpc/calendar.test.js`, `server/services/rpc/visits.test.js`, `server/routes/crm-calendar-v3120.test.js` — эти три теста закрепляли старое поведение (пустая запись врача А переезжала под запись врача Б); прогон 111 файлов дверей записи на копии с новым правилом уронил ровно их.

Кто зовёт `dayVisitMovableFor`: `calendar_book` (визит дня при новой записи), `ensure_visit` с `book` (мастер, быстрая регистрация, CRM `crm.js` ~:3023, подтверждение онлайн-записи), `api/bookings.js confirmBooking` (выбор кода отказа). Всем им правило и нужно: пустая запись другого врача теперь — «визит дня есть» (`day_visit_busy` / `booked:false`), как запись с работой.

- [ ] **Step 1: failing test** — создать `server/services/rpc/calendar-repeat.test.js`:

```js
// REPEAT_VISIT_V1 (2026-11-02) — «ПОВТОРНЫЙ ВИЗИТ» ЗАНИМАЕТ ВРЕМЯ ОДНОЙ ОПЕРАЦИЕЙ.
//
// Кабинет врача записывал повторный визит тремя запросами (calendar_book —
// всегда 'first', правка visit_kind, строка консультации без времени), а если
// у пациента в тот день уже был визит, окно предлагало «Добавить в этот
// визит» и писало «записан», не заняв ни минуты. И пустая запись одного врача
// переезжала под запись другого (dayVisitMovableFor).
//
// Здесь проверяется сам обработчик:
//   • свободный день — визит 'repeat' и строка консультации одним вызовом,
//     строка со временем приёма и ценой врача, время занято;
//   • у пациента в этот день уже есть визит — отказ revisit_day_taken словами,
//     и в базе НИЧЕГО не изменилось (ни переноса, ни «добавить в этот визит»);
//   • отказ строки откатывает и визит;
//   • цена строки — по дню ВИЗИТА (ярус «второй визит»), а не по сегодняшнему;
//   • пустая запись другого врача не переносится — ни calendar_book, ни
//     ensure_visit; запись без врача и запись того же врача — как прежде.
//
// Время набирается МЕСТНОЕ (new Date(y, m, d, h)), как в calendar.test.js:
// обработчик проверяется вместе с переводом настенного времени в UTC. День —
// ближайший будущий понедельник и дальше: «сегодня» здесь не участвует.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarBook } from './calendar.js';
import { ensureVisit } from './visits.js';
import { dayVisitMovableFor } from '../crm/booking-mirror.js';

const REG = { id: 1, role: 'registrar', extra_roles: [] };
const DOC = { id: 10, role: 'doctor', is_doctor: true, extra_roles: [] };

function nextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  return d;
}
const MON = nextMonday();
/** ISO момента: понедельник MON + `day` дней, местные hh:mm. */
const at = (day, hh, mm = 0) => new Date(MON.getFullYear(), MON.getMonth(), MON.getDate() + day, hh, mm, 0, 0).toISOString();

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(10, 'doc', 'x', 'Иванов Иван', 'doctor', 1);
  u.run(11, 'doc2', 'x', 'Петров Пётр', 'doctor', 1);
  u.run(12, 'nurse', 'x', 'Медсестра', 'nurse', 0);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (78, 'Другой Пациент')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6, 'Повторный', 'Повторный приём', 60000, 1, 1)").run();
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (10, 6, 120000, 1, 0)').run();
  // Осмотр невролога: второй визит с 5-го по 30-й день — 60 000 вместо 100 000.
  db.prepare("INSERT INTO services (id, name, price, type, price_secondary, secondary_days_from, secondary_days_to) VALUES (31, 'Осмотр невролога', 100000, 'consultation', 60000, 5, 30)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (32, 'Операция', 900000, 'other')").run();
  return db;
}

test('REPEAT_VISIT_V1: пустая запись другого врача не переносится — ни calendar_book, ни ensure_visit', async () => {
  const db = freshDb();
  try {
    const a = await calendarBook(db, { patient_id: 77, doctor_id: 11, start: at(7, 9), duration_minutes: 30 }, REG);
    assert.equal(dayVisitMovableFor(db, a.visit.id, 10), false, 'запись Петрова отдана Иванову');
    assert.equal(dayVisitMovableFor(db, a.visit.id, 11), true, 'тот же врач — перенос его же записи');
    await assert.rejects(
      () => calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => e.code === 'day_visit_busy');
    const ens = await ensureVisit(db, { patient_id: 77, date: at(7, 14), doctor_id: 10,
      book: { doctor_id: 10, start: at(7, 14), duration_minutes: 30 } }, REG);
    assert.deepEqual([ens.booked, ens.reason], [false, 'day_visit_busy']);
    const v = db.prepare('SELECT doctor_id, visit_date FROM visits WHERE id = ?').get(a.visit.id);
    assert.equal(v.doctor_id, 11, 'врач чужой записи переписан');
    assert.equal(Date.parse(v.visit_date), Date.parse(at(7, 9)), 'время чужой записи переписано');
    // Запись без врача — переносится под любого врача, как прежде.
    const b = await calendarBook(db, { patient_id: 78, start: at(7, 9), duration_minutes: 30 }, REG);
    assert.equal(dayVisitMovableFor(db, b.visit.id, 10), true);
    const moved = await calendarBook(db, { patient_id: 78, doctor_id: 10, start: at(7, 15), duration_minutes: 30 }, REG);
    assert.deepEqual([moved.moved, moved.visit.id, moved.visit.doctor_id], [true, b.visit.id, 10]);
  } finally { db.close(); }
});
```

Правка существующих тестов (они закрепляли перенос пустой записи под другого врача):

**1.1** `server/services/rpc/calendar.test.js` (тест «запись создаётся, длительность берётся ИЗ УСЛУГИ») — найти:
```js
  // Без услуги вовсе — тоже 15.
  const bare = await book(db, { patient_id: 3, doctor_id: 8, start: at(14) });
  assert.equal(bare.visit.duration_minutes, 15);
```
заменить на:
```js
  // Без услуги вовсе — тоже 15. REPEAT_VISIT_V1 — НОВАЯ запись нового
  // пациента: у пациента 3 в этот день уже есть пустая запись к врачу 7, и
  // под врача 8 она больше не переезжает (dayVisitMovableFor).
  db.prepare("INSERT INTO patients (id, full_name) VALUES (5,'Третий Пациент')").run();
  const bare = await book(db, { patient_id: 5, doctor_id: 8, start: at(14) });
  assert.equal(bare.created, true);
  assert.equal(bare.visit.duration_minutes, 15);
```

**1.2** `server/services/rpc/visits.test.js` — найти тест целиком:
```js
test('CRM_REAL_BOOKING_V1: перенос отдаёт прежнее время и врача, а в базе — новые', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (3,'d2','x','Петров','doctor',1,'')").run();
  const first = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T11:00:00Z' },
  }, REG);
  assert.equal(first.booked, true);

  const moved = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 3, start: '2026-08-09T04:15:00Z' },
  }, REG);

  assert.equal(moved.moved, true);
  assert.equal(moved.booked, true);
  assert.deepEqual(moved.from, { start: hhmm('2026-08-09T11:00:00Z'), doctor_id: 2, doctor_name: 'Doc' },
    'перенос не назвал, откуда: экрану нечего сказать оператору');
  const row = db.prepare('SELECT visit_date, doctor_id FROM visits WHERE id=?').get(first.visit.id);
  assert.equal(Date.parse(row.visit_date), Date.parse('2026-08-09T04:15:00Z'), 'в базе осталось старое время');
  assert.equal(row.doctor_id, 3, 'в базе остался старый врач');
  assert.equal(moved.visit.doctor_id, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id=1').get().n, 1, 'один пациент — один визит дня');
});
```
заменить на:
```js
test('CRM_REAL_BOOKING_V1: перенос отдаёт прежнее время и врача, а в базе — новые', async () => {
  const db = freshDb();
  const first = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T11:00:00Z' },
  }, REG);
  assert.equal(first.booked, true);

  // REPEAT_VISIT_V1 — пустая запись переносится только под СВОЕГО врача (или
  // если врача у неё нет): тот же врач, новое время.
  const moved = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T04:15:00Z' },
  }, REG);

  assert.equal(moved.moved, true);
  assert.equal(moved.booked, true);
  assert.deepEqual(moved.from, { start: hhmm('2026-08-09T11:00:00Z'), doctor_id: 2, doctor_name: 'Doc' },
    'перенос не назвал, откуда: экрану нечего сказать оператору');
  const row = db.prepare('SELECT visit_date, doctor_id FROM visits WHERE id=?').get(first.visit.id);
  assert.equal(Date.parse(row.visit_date), Date.parse('2026-08-09T04:15:00Z'), 'в базе осталось старое время');
  assert.equal(row.doctor_id, 2);
  assert.equal(moved.visit.doctor_id, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id=1').get().n, 1, 'один пациент — один визит дня');
});

// REPEAT_VISIT_V1 — пустая запись к одному врачу НЕ переезжает под запись к
// другому: повторный визит врача Б забирал пустую запись врача А, и слот А
// освобождался молча. Теперь это «визит дня есть» — booked:false с его временем.
test('REPEAT_VISIT_V1: пустая запись к Doc не переносится под запись к Петрову — booked:false', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (3,'d2','x','Петров','doctor',1,'')").run();
  const first = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T11:00:00Z' },
  }, REG);
  const other = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 3, start: '2026-08-09T04:15:00Z' },
  }, REG);
  assert.equal(other.booked, false, 'чужая пустая запись перенесена');
  assert.equal(other.reason, 'day_visit_busy');
  assert.deepEqual([other.day_visit.id, other.day_visit.doctor_id], [first.visit.id, 2]);
  const row = db.prepare('SELECT visit_date, doctor_id FROM visits WHERE id=?').get(first.visit.id);
  assert.equal(row.doctor_id, 2, 'врач записи переписан');
  assert.equal(Date.parse(row.visit_date), Date.parse('2026-08-09T11:00:00Z'), 'время записи переписано');
});
```

**1.3** `server/routes/crm-calendar-v3120.test.js` (тест «MAJOR: calendar_book без visit_id не заводит второй живой визит на день») — найти:
```js
    // Пустая запись дня (без работы) — перенос, а не второй визит.
    const first = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 9), duration_minutes: 30 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const again = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 11, service_id: 30, start: at(D, 15), duration_minutes: 30 });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.data.visit.id, first.json.data.visit.id, 'заведён второй визит вместо переноса');
    assert.equal(again.json.data.moved, true);
    assert.equal(again.json.data.visit.doctor_id, 11);
```
заменить на:
```js
    // Пустая запись дня (без работы) того же врача — перенос, а не второй визит.
    const first = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 9), duration_minutes: 30 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    // REPEAT_VISIT_V1 — под ДРУГОГО врача пустая запись не переезжает: «визит дня есть».
    const foreign = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 11, service_id: 30, start: at(D, 15), duration_minutes: 30 });
    assert.equal(foreign.status, 409, JSON.stringify(foreign.json));
    assert.equal(foreign.json.error.code, 'day_visit_busy');
    const again = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 15), duration_minutes: 30 });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.data.visit.id, first.json.data.visit.id, 'заведён второй визит вместо переноса');
    assert.equal(again.json.data.moved, true);
    assert.equal(again.json.data.visit.doctor_id, 10);
```
(Дальше в этом тесте строка визита врача 11 + счёт, отказ `day_visit_busy`, «добавить в этот визит», другой день — без изменений.)

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test server/services/rpc/calendar-repeat.test.js server/services/rpc/visits.test.js server/routes/crm-calendar-v3120.test.js server/services/rpc/calendar.test.js
```
Expected: FAIL 3 — `calendar-repeat`: «запись Петрова отдана Иванову» (`true !== false`); `visits.test.js` «REPEAT_VISIT_V1: пустая запись к Doc…»: «чужая пустая запись перенесена»; `crm-calendar-v3120` MAJOR: `200 !== 409`. Остальные — PASS (`calendar.test.js` с правкой 1.1 проходит и на старом коде).

- [ ] **Step 3: implement** — `server/services/crm/booking-mirror.js`:

**3.1** Найти (doc-комментарий `dayVisitMovableFor`):
```js
 * переписывал и строки), освобождая слот Иванова. Переносится только
 *   • по-настоящему пустая запись (ни одной живой строки), или
```
заменить на:
```js
 * переписывал и строки), освобождая слот Иванова. Переносится только
 *   • пустая запись (ни одной живой строки), у которой врача нет или это тот
 *     же врач (REPEAT_VISIT_V1: пустая запись врача А переезжала под запись
 *     врача Б — повторный визит Б забирал её, и слот А освобождался молча), или
```

**3.2** Найти:
```js
  const lines = db.prepare("SELECT doctor_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(visitId);
  if (!lines.length) return true;
  const doc = Number(doctorId) || null;
```
заменить на:
```js
  const lines = db.prepare("SELECT doctor_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(visitId);
  const doc = Number(doctorId) || null;
  // REPEAT_VISIT_V1 — пустая запись: врача нет или тот же врач.
  if (!lines.length) return v.doctor_id == null || (doc != null && Number(v.doctor_id) === doc);
```

- [ ] **Step 4: run — должен пройти** (и соседние двери записи)

```bash
node --experimental-vm-modules --test server/services/rpc/calendar-repeat.test.js server/services/rpc/visits.test.js server/routes/crm-calendar-v3120.test.js server/services/rpc/calendar.test.js server/routes/visit-lines-v3120-final.test.js server/routes/crm-calendar-mirror.test.js server/routes/crm-unify-link-guards.test.js server/services/api/bookings-confirm.test.js server/services/crm/booking-mirror-twin.test.js
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
Пустая запись одного врача не переезжает под запись другого (REPEAT_VISIT_V1)

dayVisitMovableFor считал запись без строк переносимой под ЛЮБОГО врача:
повторный визит врача Б забирал пустую запись врача А, и слот А
освобождался молча. Теперь пустая запись переносится, только если врача у
неё нет или это тот же врач; иначе — «визит дня есть» (day_visit_busy,
booked:false), как у записи с работой. Три теста, закреплявших прежний
перенос, переписаны на того же врача; добавлены проверки отказа.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add server/services/crm/booking-mirror.js server/services/rpc/calendar-repeat.test.js server/services/rpc/calendar.test.js server/services/rpc/visits.test.js server/routes/crm-calendar-v3120.test.js
git commit -F .git/U78_MSG.txt
```

---

### Task U8.2: `calendar_book` — вид визита и строка записи одной транзакцией, занятый день — отказ

**Files:**
- Modify: `server/services/rpc/calendar.js`
- Modify: `public/js/admin/i18n-strings.js`
- Test (modify): `server/services/rpc/calendar-repeat.test.js` — дописать в конец

Атомарный режим включают `visit_kind` или `line` в аргументах НОВОЙ записи. В нём визит дня пациента (любой живой визит своего здания в этот местный день, тот же запрос, что у правила DAY_VISIT_V1) — всегда отказ `revisit_day_taken`: ни переноса пустой записи (даже своей), ни `add_to_day_visit`. Остальные вызовы `calendar_book` (календарь, мастер, CRM, `ensure_visit`, отмена, перенос) этих аргументов не шлют и работают как прежде.

- [ ] **Step 1: failing test** — дописать в конец `server/services/rpc/calendar-repeat.test.js`:

```js

const snapshot = (db) => ({
  visits: db.prepare('SELECT id, patient_id, doctor_id, visit_date, visit_kind, status FROM visits ORDER BY id').all(),
  lines: db.prepare('SELECT id, visit_id FROM visit_services ORDER BY id').all(),
});
const repeatArgs = (over = {}) => ({
  patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30, status: 'scheduled',
  notes: 'Контроль после лечения', visit_kind: 'repeat', line: { consultation_type_id: 6 }, ...over,
});

test('REPEAT_VISIT_V1: свободный день — визит «повторный» и консультация одним вызовом, время занято', async () => {
  const db = freshDb();
  try {
    const out = await calendarBook(db, repeatArgs(), DOC);
    assert.equal(out.created, true);
    assert.equal(out.visit.visit_kind, 'repeat', 'визит записан «первичным»');
    const lines = db.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(out.visit.id);
    assert.equal(lines.length, 1, 'строка консультации не легла вместе с визитом');
    const l = lines[0];
    assert.deepEqual([l.consultation_type_id, l.service_id, l.doctor_id, l.status, l.unit_price, l.total],
      [6, null, 10, 'added', 120000, 120000], 'строка: вид приёма, врач записи, цена врача');
    assert.equal(Date.parse(l.scheduled_at), Date.parse(out.visit.visit_date), 'у строки нет времени приёма');
    assert.equal(out.line && out.line.id, l.id, 'ответ не называет строку');
    await assert.rejects(
      () => calendarBook(db, { patient_id: 78, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => e.code === 'slot_taken', 'время повторного визита осталось свободным');
  } finally { db.close(); }
});

test('REPEAT_VISIT_V1: у пациента в этот день уже есть визит — отказ словами, ничего не записано', async () => {
  const db = freshDb();
  try {
    // Пустая запись к Петрову в 09:00 — без строк и без счёта.
    await calendarBook(db, { patient_id: 77, doctor_id: 11, start: at(7, 9), duration_minutes: 30 }, REG);
    const before = snapshot(db);
    for (const extra of [{}, { add_to_day_visit: true }]) {
      await assert.rejects(() => calendarBook(db, repeatArgs(extra), DOC), (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.code, 'revisit_day_taken');
        assert.deepEqual([e.params.start, e.params.doctor], ['09:00', 'Петров Пётр']);
        assert.equal(e.message, 'У пациента в этот день уже есть приём в 09:00 у Петров Пётр — выберите другой день или время.');
        assert.equal(e.template, 'У пациента в этот день уже есть приём в {start} у {doctor} — выберите другой день или время.');
        return true;
      });
      assert.deepEqual(snapshot(db), before, 'отказ что-то записал или перенёс');
    }
    // Своя запись того же врача в этот день — тоже отказ, а не перенос на новое время.
    const own = await calendarBook(db, repeatArgs({ patient_id: 78, start: at(8, 14) }), DOC);
    await assert.rejects(() => calendarBook(db, repeatArgs({ patient_id: 78, start: at(8, 16) }), DOC),
      (e) => e.code === 'revisit_day_taken' && e.params.start === '14:00');
    assert.equal(Date.parse(db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(own.visit.id).visit_date), Date.parse(at(8, 14)));
  } finally { db.close(); }
});

test('REPEAT_VISIT_V1: отказ строки откатывает визит; неверный вид, услуга без врача и правка записи — отказ', async () => {
  const db = freshDb();
  try {
    await assert.rejects(() => calendarBook(db, repeatArgs({ line: { service_id: 32 } }), DOC),
      (e) => e.status === 400 && /хирургия/.test(e.message));
    await assert.rejects(() => calendarBook(db, repeatArgs({ line: { consultation_type_id: 999 } }), DOC),
      (e) => e.status === 400 && /Вид приёма не найден/.test(e.message));
    await assert.rejects(() => calendarBook(db, repeatArgs({ visit_kind: 'weird' }), DOC), /Вид визита указан неверно/);
    await assert.rejects(() => calendarBook(db, repeatArgs({ doctor_id: undefined }), REG), /выберите врача/);
    await assert.rejects(() => calendarBook(db, repeatArgs({ doctor_id: 12 }), REG), /среди врачей клиники/);
    assert.deepEqual(snapshot(db), { visits: [], lines: [] }, 'после отказа остался визит или строка');
    const ok = await calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 9), duration_minutes: 30 }, REG);
    await assert.rejects(() => calendarBook(db, { visit_id: ok.visit.id, start: at(7, 10), visit_kind: 'repeat' }, REG),
      /только новой записи/);
    assert.equal(db.prepare('SELECT visit_kind FROM visits WHERE id = ?').get(ok.visit.id).visit_kind, 'first');
  } finally { db.close(); }
});

test('REPEAT_VISIT_V1: цена строки — по дню ВИЗИТА: через 10 дней после первого — ярус «второй визит»', async () => {
  const db = freshDb();
  try {
    const first = await calendarBook(db, repeatArgs({ visit_kind: 'first', start: at(0, 10), line: { service_id: 31 } }), REG);
    assert.deepEqual([first.line.price_tier, first.line.unit_price], ['primary', 100000]);
    // Сегодня первого приёма ещё нет (он в будущем понедельнике) — котировка
    // «на сегодня» дала бы первичную цену. День визита — через 10 дней после.
    const rep = await calendarBook(db, repeatArgs({ start: at(10, 10), line: { service_id: 31 } }), DOC);
    assert.deepEqual([rep.line.price_tier, rep.line.unit_price], ['secondary', 60000], 'цена посчитана не по дню визита');
  } finally { db.close(); }
});

// REPEAT_VISIT_V1 · К6 (дизайн, касса «Платежи») — строка повторного визита —
// обычная строка визита для обоих окон кассы: «Заменить услугу» в
// неоплаченном счёте и «Вернуть услугу» после оплаты.
test('REPEAT_VISIT_V1 (К6): строку повторного визита касса заменяет и возвращает, как любую', async () => {
  const { createInvoiceForVisit, recordPayment, refundInvoiceLine, changeUnpaidService } = await import('./billing.js');
  const { openCashShift } = await import('./cashier.js');
  const db = freshDb();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9, 'cash', 'x', 'Кассир', 'cashier')").run();
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (33, 'Осмотр кардиолога', 80000, 'consultation')").run();
    const CASH = { id: 9, role: 'cashier', full_name: 'Кассир', extra_roles: [] };
    openCashShift(db, { opening_float: 0 }, CASH);
    const rep = await calendarBook(db, repeatArgs({ line: { service_id: 31 } }), DOC);
    const bill = createInvoiceForVisit(db, { visit_id: rep.visit.id, visit_service_ids: [rep.line.id] }, REG);
    assert.equal(bill.invoice.total_amount, 100000);
    changeUnpaidService(db, { visit_service_id: rep.line.id, new_service_id: 33 }, REG);
    const swapped = db.prepare('SELECT service_id, scheduled_at FROM visit_services WHERE id = ?').get(rep.line.id);
    assert.equal(swapped.service_id, 33, 'замена не дошла до строки');
    assert.equal(Date.parse(swapped.scheduled_at), Date.parse(rep.visit.visit_date), 'замена потеряла время приёма');
    assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(bill.invoice.id).total_amount, 80000);
    recordPayment(db, { invoice_id: bill.invoice.id, amount: 80000, method: 'cash' }, CASH);
    const item = db.prepare('SELECT invoice_item_id AS i FROM visit_services WHERE id = ?').get(rep.line.id).i;
    const back = refundInvoiceLine(db, { invoice_item_id: item }, CASH);
    assert.equal(back.refunded, 80000, 'возврат строки повторного визита не вернул деньги');
  } finally { db.close(); }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test server/services/rpc/calendar-repeat.test.js
```
Expected: FAIL 5 — «визит записан «первичным»» (`'first' !== 'repeat'`); второй — `'day_visit_busy' !== 'revisit_day_taken'` (после U8.1 пустая запись Петрова уже не переносится, но отказ — прежний, с «добавьте в этот визит»); третий — `Missing expected rejection` (строку старый обработчик молча игнорирует); четвёртый и К6 — `TypeError: Cannot read properties of undefined` (`rep.line`/`first.line` нет). Тест U8.1 — PASS.

(К6 дизайна — «каждая задача, которая трогает строки визита, проверяет оба окна кассы»: строка повторного визита проходит «Заменить услугу» (`change_unpaid_service`) и «Вернуть услугу» (`refund_invoice_line`). Если U6/U9 изменили эти двери — тест обязан остаться зелёным без правок: строка повторного визита для кассы ничем не отличается от строки записи колл-центра.)

- [ ] **Step 3: implement**

**3.1** `server/services/rpc/calendar.js` — найти:
```js
import { dayVisitMovableFor, requestOfVisit } from '../crm/booking-mirror.js';
import { followVisitMove } from '../crm/one-way.js';
```
заменить на:
```js
import { dayVisitMovableFor, requestOfVisit } from '../crm/booking-mirror.js';
import { insertBookingLine, bookingLineRefusal } from '../crm/booking-mirror.js';   // REPEAT_VISIT_V1 — строка записи одной транзакцией с визитом
import { followVisitMove } from '../crm/one-way.js';
import { onVisitLinesAdded } from '../crm/one-way.js';   // REPEAT_VISIT_V1 — как у кассы и /api/db после новой строки
import { rpcT } from '../server-message.js';   // REPEAT_VISIT_V1 — отказ «день занят» шаблоном
```

**3.2** Там же (сразу после функции `conflictError`) найти:
```js
  return new RpcError(message, 409, 'slot_taken', params);
}
```
заменить на:
```js
  return new RpcError(message, 409, 'slot_taken', params);
}

// REPEAT_VISIT_V1 (2026-11-02) — ВИДЫ ВИЗИТА, которые знает окно визита
// (visit-modal.js «Visit type»). По умолчанию — 'first', как в миграции 003.
export const VISIT_KINDS = Object.freeze(['first', 'repeat', 'follow_up', 'secondary']);

// REPEAT_VISIT_V1 — у пациента в этот день уже есть визит. Запись с видом
// визита или строкой (повторный визит из кабинета врача) — ТОЛЬКО новый
// визит: ни перенос пустой записи под себя, ни «добавить в этот визит» —
// окно обязано сказать «записан» лишь тогда, когда время действительно занято.
function revisitDayTaken(db, dayVisit) {
  const doc = dayVisit.doctor_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(dayVisit.doctor_id) : null;
  const params = {
    visit_id: dayVisit.id,
    start: formatHhmm(minutesOfLocal(Date.parse(dayVisit.visit_date))),
    doctor: (doc && doc.full_name) || '—',
  };
  const err = rpcT(RpcError,
    'У пациента в этот день уже есть приём в {start} у {doctor} — выберите другой день или время.', params, 409);
  err.code = 'revisit_day_taken';
  return err;
}
```

**3.3** Там же (`calendarBook`, после проверки источника направления) найти:
```js
  const referralSourceId = existing ? null : optId(a.referral_source_id, 'referral_source_id');
  if (referralSourceId && !db.prepare('SELECT 1 FROM referral_sources WHERE id = ?').get(referralSourceId)) {
    throw new RpcError('Источник направления не найден.', 400);   // FINAL_ROLES_SYNC_FIX_V1 (M5) — по-русски
  }
```
заменить на:
```js
  const referralSourceId = existing ? null : optId(a.referral_source_id, 'referral_source_id');
  if (referralSourceId && !db.prepare('SELECT 1 FROM referral_sources WHERE id = ?').get(referralSourceId)) {
    throw new RpcError('Источник направления не найден.', 400);   // FINAL_ROLES_SYNC_FIX_V1 (M5) — по-русски
  }

  // ─── REPEAT_VISIT_V1 — ВИД ВИЗИТА И СТРОКА ЗАПИСИ ОДНИМ ВЫЗОВОМ ─────────────
  //
  // «Повторный визит» кабинета врача писал визит тремя запросами браузера:
  // calendar_book (всегда 'first'), правка visit_kind и вставка строки
  // консультации без времени (и только если у врача есть виды приёма). Обрыв
  // между ними оставлял «первичный» визит без услуги. Теперь calendar_book
  // принимает visit_kind и line ({ consultation_type_id } | { service_id }) и
  // пишет визит и строку в ОДНОЙ транзакции (insertBookingLine — та же дверь,
  // что у записи колл-центра: цена — по дню ВИЗИТА, строка 'added' в смете,
  // scheduled_at = начало приёма, врач строки — врач записи).
  const kindArg = a.visit_kind == null || a.visit_kind === '' ? null : String(a.visit_kind);
  const lineArg = a.line == null || a.line === '' ? null : a.line;
  if (kindArg !== null && !VISIT_KINDS.includes(kindArg)) throw new RpcError('Вид визита указан неверно.', 400);
  if ((kindArg !== null || lineArg !== null) && existing) {
    throw new RpcError('Вид визита и услугу записи задают только новой записи.', 400);
  }
  let lineSpec = null;
  if (lineArg !== null) {
    if (typeof lineArg !== 'object' || Array.isArray(lineArg)) throw new RpcError('Услуга указана неверно.', 400);
    const hasService = lineArg.service_id != null && lineArg.service_id !== '';
    const sId = hasService ? Number(lineArg.service_id) : null;
    const cId = !hasService && lineArg.consultation_type_id != null && lineArg.consultation_type_id !== ''
      ? Number(lineArg.consultation_type_id) : null;
    if (hasService ? !isPosInt(sId) : !isPosInt(cId)) throw new RpcError('Услуга указана неверно.', 400);
    const refusal = bookingLineRefusal(db, { serviceId: sId, consultationTypeId: cId });
    if (refusal) throw new RpcError(refusal, 400);
    if (!doctorId) throw new RpcError('Для записи с услугой выберите врача.', 400);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND (is_doctor = 1 OR role = 'doctor')").get(doctorId)) {
      throw new RpcError('Врач строки не найден среди врачей клиники.', 400);
    }
    lineSpec = { serviceId: sId, consultationTypeId: cId };
  }
  const visitKind = kindArg || 'first';
  const atomic = !existing && (kindArg !== null || lineSpec !== null);
```

**3.4** Там же (блок DAY_VISIT_V1, визит дня найден) найти:
```js
    if (dayVisit) {
      if (a.add_to_day_visit === true || a.add_to_day_visit === 'true') {
```
заменить на:
```js
    if (dayVisit) {
      if (atomic) throw revisitDayTaken(db, dayVisit);   // REPEAT_VISIT_V1 — ни переноса, ни «добавить в этот визит»
      if (a.add_to_day_visit === true || a.add_to_day_visit === 'true') {
```

**3.5** Там же (транзакция записи) найти:
```js
  const run = db.transaction(() => {
    let id;
    if (existing) {
```
заменить на:
```js
  const run = db.transaction(() => {
    let id;
    let lineId = null;   // REPEAT_VISIT_V1
    if (existing) {
```

**3.6** Там же (INSERT нового визита) найти:
```js
        VALUES (?, ?, ?, ?, ?, ?, ?, 'first', 'outpatient', ?, ?, ?, ?, ?)
      `).run(patientId, doctorId, roomId, serviceId, branchId, visitDate, durationMin, status, notes,
        user && user.id, bookedAt, referralSourceId);
      id = Number(info.lastInsertRowid);
    }
```
заменить на:
```js
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outpatient', ?, ?, ?, ?, ?)
      `).run(patientId, doctorId, roomId, serviceId, branchId, visitDate, durationMin, visitKind, status, notes,
        user && user.id, bookedAt, referralSourceId);   // REPEAT_VISIT_V1 — visitKind вместо зашитого 'first'
      id = Number(info.lastInsertRowid);
      // REPEAT_VISIT_V1 — строка записи в ТОЙ ЖЕ транзакции: отказ строки
      // откатывает и визит. День цены — местный день визита (SQLite
      // 'localtime', как у котировки), не сегодняшний.
      if (lineSpec) {
        const day = db.prepare(`SELECT ${localDate('?')} AS d`).get(visitDate).d;
        lineId = insertBookingLine(db, {
          visit: { id, patient_id: patientId, day },
          serviceId: lineSpec.serviceId, consultationTypeId: lineSpec.consultationTypeId,
          doctorId, createdBy: user && user.id, scheduledAt: visitDate,
        });
      }
    }
```

**3.7** Там же найти:
```js
    return { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(id), created: !existing, seq };
  });

  const out = run();
  const seq = out.seq;
  delete out.seq;
```
заменить на:
```js
    return { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(id), created: !existing, seq, lineId };
  });

  const out = run();
  const seq = out.seq;
  delete out.seq;
  const lineId = out.lineId;   // REPEAT_VISIT_V1
  delete out.lineId;
  if (lineId) out.line = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(lineId);
```

**3.8** Там же (связь новой записи с заявкой) найти:
```js
  if (!existing) {
    crmLinkVisit(db, out.visit.id, user);   // CRM_UNIFY_V1
    crmVisitStatus(db, { visitId: out.visit.id, from: null, to: status });   // CRM_LINK_ALL_V1 (F-6) — после связи
```
заменить на:
```js
  if (!existing) {
    crmLinkVisit(db, out.visit.id, user);   // CRM_UNIFY_V1
    crmVisitStatus(db, { visitId: out.visit.id, from: null, to: status });   // CRM_LINK_ALL_V1 (F-6) — после связи
    if (lineId) onVisitLinesAdded(db, out.visit.id, [lineId]);   // REPEAT_VISIT_V1 — та же сверка карточки, что у новой строки /api/db
```

**3.9** `public/js/admin/i18n-strings.js` — перед единственной строкой `};` вставить (сторож сообщений сервера требует статьи для каждой статической фразы `RpcError` и для шаблона `rpcT`; «Услуга указана неверно.» и «Врач строки не найден среди врачей клиники.» в словаре уже есть):
```js
  // REPEAT_VISIT_V1
  "Вид визита указан неверно.": {"en":"Invalid visit type.","ru":"Вид визита указан неверно.","uz":"Tashrif turi noto'g'ri ko'rsatilgan."},   // REPEAT_VISIT_V1 — calendar_book
  "Вид визита и услугу записи задают только новой записи.": {"en":"The visit type and the booking service can be set only on a new booking.","ru":"Вид визита и услугу записи задают только новой записи.","uz":"Tashrif turi va yozuv xizmati faqat yangi yozuvda belgilanadi."},   // REPEAT_VISIT_V1
  "Для записи с услугой выберите врача.": {"en":"Choose a doctor to book with a service.","ru":"Для записи с услугой выберите врача.","uz":"Xizmat bilan yozish uchun shifokorni tanlang."},   // REPEAT_VISIT_V1
  "У пациента в этот день уже есть приём в {start} у {doctor} — выберите другой день или время.": {"en":"The patient already has an appointment at {start} with {doctor} on this day — choose another day or time.","ru":"У пациента в этот день уже есть приём в {start} у {doctor} — выберите другой день или время.","uz":"Bemorning bu kunda {start} da {doctor} qabulida yozuvi bor — boshqa kun yoki vaqtni tanlang."},   // REPEAT_VISIT_V1 — отказ revisit_day_taken
  // /REPEAT_VISIT_V1
```

- [ ] **Step 4: run — должен пройти**

```bash
node --experimental-vm-modules --test server/services/rpc/calendar-repeat.test.js server/services/rpc/calendar.test.js server/services/rpc/calendar-cross-branch.test.js server/services/rpc/calendar-holds.test.js server/services/rpc/visits.test.js server/i18n-server-messages.test.js server/routes/visit-lines-v3120-final.test.js server/routes/crm-calendar-mirror.test.js server/routes/crm-calendar-v3120.test.js server/services/api/bookings-confirm.test.js
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
calendar_book: вид визита и строка записи одной транзакцией; занятый день — отказ (REPEAT_VISIT_V1)

calendar_book всегда писал visit_kind = 'first', а «Повторный визит»
кабинета дописывал вид и строку консультации отдельными запросами
браузера: строка без времени и только при видах приёма у врача. Теперь
calendar_book принимает visit_kind и line ({consultation_type_id} |
{service_id}): визит и строка (insertBookingLine — scheduled_at = начало,
врач записи, цена по дню визита) пишутся в одной транзакции, отказ строки
откатывает визит. Если у пациента в этот день уже есть визит — отказ
revisit_day_taken «У пациента в этот день уже есть приём в 09:00 у … —
выберите другой день или время.» без переноса и «добавить в этот визит».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add server/services/rpc/calendar.js server/services/rpc/calendar-repeat.test.js public/js/admin/i18n-strings.js
git commit -F .git/U78_MSG.txt
```

---

### Task U8.3: Окно «Повторный визит» — один вызов, отказ в окне, «записан» только за занятым временем

**Files:**
- Modify: `public/js/admin/views/service-workspace.js` (`openRevisitModal`)
- Modify: `public/js/admin/views/service-picker-modal.js` (`BOOK_ERROR_TEMPLATES`)
- Modify: `public/js/admin/i18n-strings.js`
- Test (create): `public/js/admin/__tests__/revisit-repeat-visit.test.mjs`

Кнопки окна — `service-workspace.js` ~:1114 (лист) и ~:6917 (бланк), обе зовут `openRevisitModal(ctx)` — правится одна функция. `bookVisit` (`visit-booking.js`) = `calendarBookOrAsk` (`service-picker-modal.js`): отказ с кодом не `slot_taken`/`day_visit_busy` бросается текстом `bookErrorText`, поэтому шаблон нового кода добавляется в `BOOK_ERROR_TEMPLATES`; `opts.askAddToDayVisit` у `calendarBookOrAsk` уже есть.

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/revisit-repeat-visit.test.mjs`:

```js
// REPEAT_VISIT_V1 (2026-11-02) — «ПОВТОРНЫЙ ВИЗИТ» КАБИНЕТА ЗАНИМАЕТ ВРЕМЯ.
//
// Окно повторного визита писало визит тремя запросами браузера, а в день, где
// у пациента уже был приём, предлагало «Добавить в этот визит» — визит не
// менялся, время не занималось, а окно говорило «Пациент записан» и вставляло
// время в документ. Здесь окно проходит весь путь через НАСТОЯЩИЙ сервер
// (createApp, база в памяти — тот же стенд, что consultation-flags.test.mjs):
//   • свободный день — один calendar_book: визит 'repeat' и строка
//     консультации со временем приёма, окно закрыто, «записан» — правда;
//   • день, где у пациента уже есть приём, — отказ словами В ОКНЕ, окно
//     открыто, «записан» не сказано, «Добавить в этот визит» не спрошено,
//     в базе ничего нового.
// Дни — 10-е число следующего месяца (кнопка «+1 мес»): «сегодня» не участвует.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, TOASTS } from './cabinet-harness.mjs';

installFakeDom();
for (const [k, fn] of Object.entries({
    click() { this.dispatch('click'); },
    dispatchEvent(e) { this.dispatch(e.type, e); return true; },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); },
    contains() { return false; }, scrollTo() {}, select() {},
})) if (!(k in El.prototype)) El.prototype[k] = fn;
globalThis.window.CLINIC = { id: 1, name: 'Клиника' };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { hashPassword } = await import('../../../../server/services/auth.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');

const DB = openDb(':memory:');
migrate(DB);
const WEEK = JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { on: true, from: '09:00', to: '18:00' }])));
const addUser = DB.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (?,?,?,?,?,?,?)');
addUser.run(1, 'boss', hashPassword('password1'), 'Админ Клиники', 'admin', 0, '');
addUser.run(10, 'doc', hashPassword('password1'), 'Иванов Иван', 'doctor', 1, WEEK);
addUser.run(11, 'doc2', hashPassword('password1'), 'Петров Пётр', 'doctor', 1, WEEK);
DB.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6,'Повторный','Повторный приём',60000,1,1)").run();
DB.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Свободный')").run();
DB.prepare("INSERT INTO patients (id, full_name) VALUES (78,'Пациент Занятый')").run();
const PETROV = 11;

const realFetch = globalThis.fetch;
const server = await listen(createApp(DB, { dataDir: licensedDataDir() }));
const BASE = `http://127.0.0.1:${server.address().port}`;
const login = await realFetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
});
assert.equal(login.status, 200, 'вход администратора');
const COOKIE = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const bookCalls = [];
globalThis.fetch = (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    if (u === '/api/rpc/calendar_book') bookCalls.push(JSON.parse(opts.body || '{}'));
    return realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
};
test.after(() => { globalThis.fetch = realFetch; server.closeAllConnections?.(); server.close(); });

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v || Date.now() > end) return v; await settle(); }
}
const modals = () => document.body.children.filter((c) => c.classList && c.classList.contains('modal'));
const WS = await import('../views/service-workspace.js');

/** Кабинет пациента `pid` у Петрова → «Повторный визит» → 10-е след. месяца, 10:00 → «Записать». */
async function bookRevisit(pid) {
    document.body.children = [];
    const container = new El('div');
    const ctx = { container, visitServiceId: 900 + pid, visitId: 1900 + pid, patient: { id: pid, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-' + pid, __service: { id: 900 + pid, name: 'Приём', doctorId: PETROV, doctorName: 'Петров Пётр' } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const btn = container.querySelector('[data-revisit-btn]');
    btn.dispatch('click');
    await btn._pending;
    const dlg = await until(() => modals().pop());
    assert.ok(dlg, 'окно повторного визита не открылось');
    dlg.querySelectorAll('button').find((b) => b.textContent.includes('+1 мес')).dispatch('click');
    dlg.querySelectorAll('button').find((b) => b.classList.contains('rv-cell') && b.textContent === '10').dispatch('click');
    const slot = await until(() => dlg.querySelectorAll('button').find((b) => b.classList.contains('rv-slot') && !b.hasAttribute('disabled') && b.textContent === '10:00'));
    assert.ok(slot, 'нет свободного 10:00');
    slot.dispatch('click');
    const bookBtn = dlg.querySelectorAll('button').find((b) => /Записать/.test(b.textContent));
    bookBtn.dispatch('click');
    await bookBtn._pending;
    return { ctx, container, dlg };
}
const tenthNextMonth = (hh) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 10, hh, 0, 0, 0); };

test('REPEAT_VISIT_V1: свободный день — один calendar_book: визит «повторный» и консультация со временем; «записан» — правда', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    const { container, dlg } = await bookRevisit(77);
    assert.equal(bookCalls.length, 1, 'запись ушла не одним вызовом');
    assert.equal(bookCalls[0].visit_kind, 'repeat');
    assert.deepEqual(bookCalls[0].line, { consultation_type_id: 6 });
    const v = DB.prepare('SELECT * FROM visits WHERE patient_id = 77').all();
    assert.equal(v.length, 1);
    assert.equal(v[0].visit_kind, 'repeat', 'визит записан «первичным»');
    assert.equal(Date.parse(v[0].visit_date), tenthNextMonth(10).getTime());
    const lines = DB.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(v[0].id);
    assert.deepEqual(lines.map((l) => [l.consultation_type_id, l.doctor_id]), [[6, PETROV]], 'нет строки консультации');
    assert.equal(Date.parse(lines[0].scheduled_at), Date.parse(v[0].visit_date), 'у строки нет времени приёма');
    assert.ok(TOASTS.some((t) => t.includes('Пациент записан на повторный визит')));
    assert.ok(!modals().includes(dlg), 'окно не закрылось после записи');
    assert.ok(container.querySelector('[data-revisit-btn]').classList.contains('booked'));
});

test('REPEAT_VISIT_V1: у пациента в этот день уже есть приём — отказ в окне, «записан» не сказано, в базе ничего нового', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (78, 10, ?, 'scheduled')").run(tenthNextMonth(9).toISOString());
    const visitsBefore = DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 78').get().n;
    const { container, dlg } = await bookRevisit(78);
    const err = await until(() => { const e = dlg.querySelector('.rv-err'); return e && e.textContent ? e : null; });
    assert.ok(err, 'отказ не показан в окне');
    assert.equal(err.textContent, 'У пациента в этот день уже есть приём в 09:00 у Иванов Иван — выберите другой день или время.');
    assert.ok(modals().includes(dlg), 'окно закрылось после отказа');
    assert.ok(!TOASTS.some((t) => t.includes('Пациент записан')), 'окно сказало «записан» без занятого времени');
    assert.ok(!container.querySelector('[data-revisit-btn]').classList.contains('booked'), 'кнопка отмечена записанной');
    assert.ok(!bookCalls.some((b) => b.add_to_day_visit), 'окно попробовало «Добавить в этот визит»');
    assert.ok(!modals().some((m) => m.textContent.includes('Добавить в этот визит')), 'окно спросило «Добавить в этот визит»');
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 78').get().n, visitsBefore, 'появился второй визит');
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE v.patient_id = 78').get().n, 0);
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/revisit-repeat-visit.test.mjs
```
Expected: FAIL 2 — первый: `undefined !== 'repeat'` (окно не шлёт `visit_kind`); второй: `test timed out after 30000ms` (старое окно на отказ `day_visit_busy` открывает «Добавить в этот визит» и ждёт ответа человека). В выводе может стоять строка `[db] 400 patient_activity_log insert … unsupported value type` — это давний сбой журнала действий окна (см. «Риски»), не этого теста.

- [ ] **Step 3: implement**

**3.1** `public/js/admin/views/service-picker-modal.js` (`BOOK_ERROR_TEMPLATES`) — найти:
```js
    day_visit_busy: 'У пациента на этот день уже есть визит ({start}, врач {doctor}), и по нему уже идёт работа. Второй визит на день не заводится — добавьте услугу в этот визит.',
```
заменить на:
```js
    day_visit_busy: 'У пациента на этот день уже есть визит ({start}, врач {doctor}), и по нему уже идёт работа. Второй визит на день не заводится — добавьте услугу в этот визит.',
    // REPEAT_VISIT_V1 — повторный визит кабинета: день занят — только отказ, без «добавить в этот визит».
    revisit_day_taken: 'У пациента в этот день уже есть приём в {start} у {doctor} — выберите другой день или время.',
```

**3.2** `public/js/admin/views/service-workspace.js` — найти (импорт):
```js
import { consultPrice as consultPriceRule, consultOffered, consultMinutes } from '../../shared/consultation-price.js';   // DOCTOR_PROFILE_V1
```
заменить на:
```js
import { consultOffered, consultMinutes } from '../../shared/consultation-price.js';   // DOCTOR_PROFILE_V1 · REPEAT_VISIT_V1 — цену строки повторного визита считает сервер
```
(`consultPriceRule` больше нигде в файле не используется — проверить `grep -n consultPriceRule public/js/admin/views/service-workspace.js` → пусто после правки 3.3.)

**3.3** Там же (`openRevisitModal`) найти:
```js
    const consultLabel = (ct) => { const r = docConsult[ct.id]; return (r && (r.name_ru || r.name_uz)) || ct.name_ru || ct.name_uz || 'Консультация'; };
    const consultPrice = (ct) => consultPriceRule(ct, docConsult[ct.id] || null).price;   // DOCTOR_PROFILE_V1 — правило кассы
```
заменить на:
```js
    const consultLabel = (ct) => { const r = docConsult[ct.id]; return (r && (r.name_ru || r.name_uz)) || ct.name_ru || ct.name_uz || 'Консультация'; };
    // REPEAT_VISIT_V1 — у врача нет видов консультаций: строкой визита идёт
    // услуга каталога типа «Консультация» (значение 's:<id>'); цену по дню
    // визита считает сервер. Нет и таких — визит записывается без строки.
    let rvServices = [];
    if (!consultTypes.length) {
        const { data: sData } = await supabase.from('services')
            .select('id, name, duration_minutes').eq('type', 'consultation').eq('active', true)
            .order('name', { ascending: true }).limit(50);
        rvServices = sData || [];
    }
    const rvService = (v) => rvServices.find((s) => 's:' + s.id === String(v)) || null;
```

**3.4** Там же найти:
```js
    const svcSel = h('select', null,
        ...(consultTypes.length
            ? consultTypes.map(ct => h('option', { value: ct.id }, consultLabel(ct)))
            : [h('option', { value: '' }, 'Консультация')]));
```
заменить на:
```js
    const svcSel = h('select', null,
        ...(consultTypes.length
            ? consultTypes.map(ct => h('option', { value: ct.id }, consultLabel(ct)))
            : rvServices.length   // REPEAT_VISIT_V1
                ? rvServices.map(s => h('option', { value: 's:' + s.id }, s.name))
                : [h('option', { value: '' }, 'Консультация')]));
```

**3.5** Там же найти:
```js
    const rvMinutes = () => { const ct = consultTypes.find((c) => String(c.id) === String(svcSel.value)); return ct ? consultMinutes(ct) : RV_SLOT_MIN; };
```
заменить на:
```js
    const rvMinutes = () => {
        const ct = consultTypes.find((c) => String(c.id) === String(svcSel.value));
        if (ct) return consultMinutes(ct);
        const s = rvService(svcSel.value);   // REPEAT_VISIT_V1 — длительность услуги каталога
        return (s && Number(s.duration_minutes) > 0) ? Number(s.duration_minutes) : RV_SLOT_MIN;
    };
```

**3.6** Там же найти:
```js
    const footSel   = h('div', { class: 'rv-foot-sel muted' }, 'Слот не выбран');
```
заменить на:
```js
    const footSel   = h('div', { class: 'rv-foot-sel muted' }, 'Слот не выбран');
    // REPEAT_VISIT_V1 — отказ сервера («в этот день уже есть приём…») пишется в
    // самом окне: окно остаётся открытым, врач выбирает другой день или время.
    const errBox    = h('div', { class: 'rv-err', role: 'alert', style: { display: 'none', marginTop: '12px', fontSize: '13px', color: 'var(--crit-700)' } });
    const showErr = (text) => { errBox.textContent = text || ''; errBox.style.display = text ? '' : 'none'; };
```

**3.7** Там же (клетка дня в `renderCal`) найти:
```js
                onclick: () => { state.sel = { y: state.y, m: state.m, d: dd }; state.slot = null; renderCal(); renderSlots(); refreshFootBtn(); } }, String(dd));
```
заменить на:
```js
                onclick: () => { state.sel = { y: state.y, m: state.m, d: dd }; state.slot = null; showErr(''); renderCal(); renderSlots(); refreshFootBtn(); } }, String(dd));
```

**3.8** Там же (`renderSlots`) найти:
```js
        const day = await loadSlotDay(doctorId, dayIso, rvMinutes(), { stepMinutes: RV_SLOT_MIN, patientId });   // DOCTOR_PROFILE_V1 — длительность вида, шаг 20
```
заменить на:
```js
        // REPEAT_VISIT_V1 — без patientId: свой приём пациента в этот день не
        // прячется из занятого — повторный визит в такой день сервер не запишет.
        const day = await loadSlotDay(doctorId, dayIso, rvMinutes(), { stepMinutes: RV_SLOT_MIN });   // DOCTOR_PROFILE_V1 — длительность вида, шаг 20
```

**3.9** Там же (кнопка слота) найти:
```js
                onclick: () => { state.slot = sl.label; renderSlots(); refreshFootBtn(); } }, sl.label));
```
заменить на:
```js
                onclick: () => { state.slot = sl.label; showErr(''); renderSlots(); refreshFootBtn(); } }, sl.label));
```

**3.10** Там же (`doBook`, начало до `best-effort activity log`) найти:
```js
    async function doBook() {
        bookBtn.setAttribute('disabled', '');
        try {
            const isoDate = rvIso(state.sel.y, state.sel.m, state.sel.d);
            const visitDate = new Date(`${isoDate}T${state.slot}:00`).toISOString();
            const reason  = reasonSel.value;
            const comment = commentInput.value.trim();
            const notes = [reason, comment].filter(Boolean).join(' — ') || 'Повторный визит';
            const ctId = svcSel.value || null;
            const ct = consultTypes.find(c => String(c.id) === String(ctId)) || null;
            const price = ct ? consultPrice(ct) : 0;

            // VISITS_ONE_DOOR_V1 — запись идёт тем же входом, что у календаря и
            // мастеров: занятое время сервер называет словами, а поверх него
            // можно записать только экстренно и только с причиной. null =
            // врач передумал — не создано ни визита, ни строки услуги.
            const booked = await bookVisit({
                patient_id:       patientId,
                doctor_id:        doctorId,
                service_id:       null,            // consultation-primary → null (CONSULT_BOOKING_V1)
                start:            visitDate,
                duration_minutes: ct ? consultMinutes(ct) : RV_SLOT_MIN,   // DOCTOR_PROFILE_V1 — длительность вида (ревью №1)
                status:           'scheduled',
                notes,
            });
            if (!booked) { bookBtn.removeAttribute('disabled'); return; }
            const visit = booked.visit;
            // Повторность — не расписание, и записью она не ставится: у
            // calendar_book новый визит всегда 'first'. Пометка отдельная.
            const { error: kindErr } = await supabase.from('visits')
                .update({ visit_kind: 'repeat' }).eq('id', visit.id);
            if (kindErr) console.warn('[revisit] visit_kind not saved:', kindErr.message);

            // visit_services consultation line — MIRRORS createVisit __consult branch.
            if (ctId) { const { error: vsErr } = await insertRow('visit_services', {
                visit_id:             visit.id,
                consultation_type_id: ctId,
                service_id:           null,
                doctor_id:            doctorId,
                quantity:             1,
                unit_price:           price,
                total:                price,
            });
            if (vsErr) console.warn('[revisit] visit_services not attached:', vsErr.message); }
```
заменить на:
```js
    async function doBook() {
        if (!state.sel || !state.slot) return;   // REPEAT_VISIT_V1 — день и время обязательны
        bookBtn.setAttribute('disabled', '');
        showErr('');
        try {
            const isoDate = rvIso(state.sel.y, state.sel.m, state.sel.d);
            const visitDate = new Date(`${isoDate}T${state.slot}:00`).toISOString();
            const reason  = reasonSel.value;
            const comment = commentInput.value.trim();
            const notes = [reason, comment].filter(Boolean).join(' — ') || 'Повторный визит';
            const ctId = svcSel.value || null;
            const ct = consultTypes.find(c => String(c.id) === String(ctId)) || null;
            const svc = ct ? null : rvService(ctId);

            // REPEAT_VISIT_V1 — ОДИН ВЫЗОВ. Визит «повторный», его время и строка
            // консультации (или услуги каталога) пишутся сервером в одной
            // транзакции calendar_book: врач строки — врач записи, scheduled_at —
            // начало приёма, цена — по дню визита. Прежде здесь было три запроса
            // (запись 'first', правка visit_kind, строка без времени и без цены
            // сервера), и обрыв между ними оставлял «первичный» визит без услуги.
            //
            // VISITS_ONE_DOOR_V1 — вход тот же, что у календаря и мастеров:
            // занятое время сервер называет словами, поверх него — только
            // экстренно с причиной; null = врач передумал, не создано ничего.
            // «Добавить в этот визит» здесь нет: день, в который у пациента уже
            // есть приём, сервер отказывает (revisit_day_taken), и окно остаётся
            // открытым с этим отказом.
            const line = ct ? { consultation_type_id: ct.id } : (svc ? { service_id: svc.id } : null);
            const booked = await bookVisit({
                patient_id:       patientId,
                doctor_id:        doctorId,
                service_id:       null,            // consultation-primary → null (CONSULT_BOOKING_V1)
                start:            visitDate,
                duration_minutes: rvMinutes(),     // DOCTOR_PROFILE_V1 — длительность вида (ревью №1)
                status:           'scheduled',
                notes,
                visit_kind:       'repeat',        // REPEAT_VISIT_V1
                ...(line ? { line } : {}),         // REPEAT_VISIT_V1
            }, { askAddToDayVisit: async () => false });
            if (!booked) { bookBtn.removeAttribute('disabled'); return; }
            // REPEAT_VISIT_V1 — «записан» только за занятым временем: новый визит,
            // а не чужой визит дня.
            if (!booked.created || !booked.visit || booked.added_to_day_visit) {
                throw new Error(tr('Время не занято — повторный визит не записан. Выберите другой день или время.'));
            }
            const visit = booked.visit;
```
(Дальше — журнал действий, `close()`, `markRevisitBooked`, запись в «Рекомендации», toast «Пациент записан на повторный визит» — без изменений: туда доходит только записанный новый визит.)

**3.11** Там же (`catch` в `doBook`) найти:
```js
        } catch (e) {
            toast(trf('Не удалось записать: {msg}', { msg: e?.message || e }), 'fail');
            bookBtn.removeAttribute('disabled');
        }
    }

    // step 2: confirmation
```
заменить на:
```js
        } catch (e) {
            showErr(e?.message || String(e));   // REPEAT_VISIT_V1 — отказ остаётся в окне
            toast(trf('Не удалось записать: {msg}', { msg: e?.message || e }), 'fail');
            bookBtn.removeAttribute('disabled');
        }
    }

    // step 2: confirmation
```

**3.12** Там же (тело окна) найти:
```js
        h('div', { class: 'rv-cols' },
            h('div', { class: 'rv-col-cal' }, calWrap),
            h('div', { class: 'rv-col-slots' }, slotsWrap),
        ),
    );
```
заменить на:
```js
        h('div', { class: 'rv-cols' },
            h('div', { class: 'rv-col-cal' }, calWrap),
            h('div', { class: 'rv-col-slots' }, slotsWrap),
        ),
        errBox,   // REPEAT_VISIT_V1
    );
```

**3.13** Там же (последняя строка `openRevisitModal`) найти:
```js
    svcSel.addEventListener('change', () => { state.slot = null; renderSlots(); refreshFootBtn(); });
```
заменить на:
```js
    svcSel.addEventListener('change', () => { state.slot = null; showErr(''); renderSlots(); refreshFootBtn(); });
```

**3.14** `public/js/admin/i18n-strings.js` — перед строкой `  // /REPEAT_VISIT_V1` (блок из U8.2) вставить:
```js
  "Время не занято — повторный визит не записан. Выберите другой день или время.": {"en":"No time was reserved — the follow-up visit was not booked. Choose another day or time.","ru":"Время не занято — повторный визит не записан. Выберите другой день или время.","uz":"Vaqt band qilinmadi — takroriy tashrif yozilmadi. Boshqa kun yoki vaqtni tanlang."},   // REPEAT_VISIT_V1 — окно повторного визита
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/revisit-repeat-visit.test.mjs public/js/admin/__tests__/consultation-flags.test.mjs public/js/admin/__tests__/booking-doors.test.mjs public/js/admin/__tests__/service-workspace-add.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/server-messages-i18n.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS, ни одного ✖ (оба прогона). Тест «DOCTOR_PROFILE_V1: «Повторный визит» — слоты и запись на длительность…» в `consultation-flags` сам отвечает на `calendar_book` отказом 400 — теперь окно пишет его в `.rv-err`; тест проверяет только длительность и проходит.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
«Повторный визит» кабинета: один вызов, отказ в окне, «записан» — только за временем (REPEAT_VISIT_V1)

Окно писало визит тремя запросами (запись 'first', правка вида, строка
консультации без времени), а в день, где у пациента уже был приём,
предлагало «Добавить в этот визит» — время не занималось, а окно говорило
«записан» и вставляло время в документ. Теперь один calendar_book с
visit_kind 'repeat' и строкой (вид консультации врача, а если видов нет —
услуга каталога «Консультация»); отказ «в этот день уже есть приём …»
пишется в окне, окно остаётся открытым; «записан» — только за новым
записанным визитом.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/service-workspace.js public/js/admin/views/service-picker-modal.js public/js/admin/i18n-strings.js public/js/admin/__tests__/revisit-repeat-visit.test.mjs
git commit -F .git/U78_MSG.txt
```

---

### Task U8.4: Сервер — «Записи вперёд» (`doctor_upcoming_visits`)

**Files:**
- Create: `server/services/rpc/doctor-upcoming.js`
- Modify: `server/services/rpc/index.js`, `server/services/control/gate.js`, `public/js/admin/i18n-strings.js`
- Test (create): `server/services/rpc/doctor-upcoming.test.js`

- [ ] **Step 1: failing test** — создать `server/services/rpc/doctor-upcoming.test.js`:

```js
// REPEAT_VISIT_V1 — «Записи вперёд»: свои записи врача на 30 дней вперёд, с
// завтрашнего МЕСТНОГО дня. Часовой пояс задан явно (UTC+5, до первого
// запроса к базе), «сегодня» прибито аргументом — тест не зависит ни от
// машины, ни от полуночи.
process.env.TZ = 'UZT-5';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../../db/connection.js');
const { migrate } = await import('../../db/migrate.js');
const { doctorUpcomingVisits } = await import('./doctor-upcoming.js');
const { RPC } = await import('./index.js');
const { isReadOnlyRpc } = await import('../control/gate.js');

const TODAY = '2026-11-02';
const DOC = { id: 10, role: 'doctor', extra_roles: [] };
const DOC2 = { id: 11, role: 'doctor', extra_roles: [] };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(10, 'doc', 'x', 'Иванов Иван', 'doctor', 1);
  u.run(11, 'doc2', 'x', 'Петров Пётр', 'doctor', 1);
  u.run(12, 'adm', 'x', 'Алиева Алия', 'admin', 1);   // ADMIN_DOCTOR_V1 — администратор, который ведёт приём
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (77, 'Пациент Один', 'P-77'), (78, 'Пациент Два', 'P-78')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6, 'Повторный', 'Повторный приём', 60000, 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (31, 'УЗИ почек', 90000, 'imaging')").run();
  return db;
}
const visit = (db, { pid = 77, doc = 10, at, status = 'scheduled', kind = 'first', origin = null }) =>
  Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, visit_kind, sync_origin) VALUES (?,?,?,?,?,?)')
    .run(pid, doc, at, status, kind, origin).lastInsertRowid);
const line = (db, vid, { doc = 10, ct = null, svc = null, status = 'added' } = {}) =>
  db.prepare('INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,?,1,0,0,?)')
    .run(vid, svc, ct, doc, status);

test('свои записи с завтрашнего местного дня на 30 дней; сегодняшние, отменённые, чужие и чужого здания — нет', () => {
  const db = freshDb();
  try {
    visit(db, { at: '2026-11-02T13:00:00Z' });                                     // сегодня 18:00 — это «Мой день»
    const midnight = visit(db, { at: '2026-11-02T19:00:00Z', kind: 'repeat' });    // 03.11 00:00 местного — уже завтра
    line(db, midnight, { ct: 6 });
    const tomorrow = visit(db, { pid: 78, at: '2026-11-03T04:00:00Z' });            // 03.11 09:00
    visit(db, { at: '2026-11-03T05:00:00Z', status: 'cancelled' });                 // отменён
    const foreign = visit(db, { pid: 78, doc: 11, at: '2026-11-04T06:00:00Z' });    // запись Петрова…
    line(db, foreign, { doc: 10, svc: 31 });                                        // …с УЗИ у Иванова — его запись тоже
    const foreignOnly = visit(db, { doc: 11, at: '2026-11-05T06:00:00Z' });         // только Петров
    line(db, foreignOnly, { doc: 10, svc: 31, status: 'cancelled' });               // снятая строка Иванова не в счёт
    visit(db, { at: '2026-11-06T06:00:00Z', origin: 'B' });                          // чужое здание
    const last = visit(db, { at: '2026-12-02T04:00:00Z' });                          // 02.12 — тридцатый день
    visit(db, { at: '2026-12-03T04:00:00Z' });                                       // 03.12 — за окном

    const out = doctorUpcomingVisits(db, { days: 30 }, DOC, { todayYmd: TODAY });
    assert.deepEqual([out.from, out.to], ['2026-11-03', '2026-12-02']);
    assert.deepEqual(out.rows.map((r) => r.visit_id), [midnight, tomorrow, foreign, last]);
    const first = out.rows[0];
    assert.deepEqual([first.day, first.time, first.visit_kind, first.patient_name, first.mrn], ['2026-11-03', '00:00', 'repeat', 'Пациент Один', 'P-77']);
    assert.deepEqual(first.what, ['Повторный приём']);
    assert.deepEqual(out.rows[2].what, ['УЗИ почек'], 'в чужой записи — только своя строка');
    assert.deepEqual(doctorUpcomingVisits(db, {}, DOC2, { todayYmd: TODAY }).rows.map((r) => r.visit_id), [foreign, foreignOnly],
      'у Петрова — только его записи');
  } finally { db.close(); }
});

test('только врачу: регистратор — отказ; администратор-врач — свои; чтение при просроченной лицензии', () => {
  const db = freshDb();
  try {
    assert.throws(() => doctorUpcomingVisits(db, {}, { id: 1, role: 'registrar' }, { todayYmd: TODAY }), (e) => e.status === 403);
    assert.deepEqual(doctorUpcomingVisits(db, {}, { id: 12, role: 'admin' }, { todayYmd: TODAY }).rows, []);
    assert.equal(typeof RPC.doctor_upcoming_visits, 'function', 'RPC не зарегистрирован');
    assert.ok(isReadOnlyRpc('doctor_upcoming_visits'), 'это чтение — кабинет показывает записи и при просроченной лицензии');
  } finally { db.close(); }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test server/services/rpc/doctor-upcoming.test.js
```
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`./doctor-upcoming.js`).

- [ ] **Step 3: implement**

**3.1** Создать `server/services/rpc/doctor-upcoming.js`:
```js
// REPEAT_VISIT_V1 (2026-11-02) — «ЗАПИСИ ВПЕРЁД» В КАБИНЕТЕ ВРАЧА.
//
// Врач не видел своих будущих записей нигде: «Мой день» кончается сегодня
// (doctor-dashboard.js, окно до конца дня), «Мои записи» показывают строки
// после оплаты (consultation.js). Пациент, которого врач сам записал на
// повторный визит через неделю, пропадал из виду до дня приёма.
//
// doctor_upcoming_visits({ days = 30 }) → { from, to, rows: [...] } — СВОИ записи
// с завтрашнего местного дня на `days` дней вперёд:
//   • визит, где врач — врач записи (visits.doctor_id), или где у него есть
//     живая строка услуги (запись к другому врачу с его УЗИ);
//   • только ждущие записи (scheduled / confirmed) своего здания (sync_origin
//     IS NULL — как «Мой день»: приехавшая запись живёт в кабинете своего
//     здания);
//   • в строке — день и время (местные), пациент, вид визита и что записано
//     к этому врачу.
// Чей кабинет — решает СЕССИЯ (user.id), аргумента «чей» нет: параметр и
// означал бы «покажи чужие записи» (то же правило, что у загрузчиков дашборда).
import { hasAnyRole } from '../roles.js';
import { today, localDate, localRangeWhere } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const UPCOMING_DEFAULT_DAYS = 30;
export const UPCOMING_MAX_DAYS = 60;
const MAX_ROWS = 300;

/**
 * @param {object} db
 * @param {{ days?: number }} args
 * @param {object} user — сессия
 * @param {{ todayYmd?: string }} [opts] — только для тестов: «сегодня» клиники
 */
export function doctorUpcomingVisits(db, args, user, { todayYmd = null } = {}) {
  const me = Number(user && user.id);
  const row = Number.isInteger(me) && me > 0 ? db.prepare('SELECT id, role, is_doctor FROM users WHERE id = ?').get(me) : null;
  const isDoctor = !!row && (Number(row.is_doctor) === 1 || row.role === 'doctor' || hasAnyRole(user, ['doctor', 'head_doctor']));
  if (!isDoctor) throw new RpcError('«Записи вперёд» открываются только врачу.', 403);
  const asked = Math.round(Number(args && args.days));
  const days = Number.isFinite(asked) && asked > 0 ? Math.min(asked, UPCOMING_MAX_DAYS) : UPCOMING_DEFAULT_DAYS;
  const t = todayYmd || today(db);
  const span = db.prepare("SELECT date(?, '+1 day') AS f, date(?, ?) AS t").get(t, t, `+${days} days`);
  const w = localRangeWhere('v.visit_date', span.f, span.t);
  const rows = db.prepare(`
    SELECT v.id AS visit_id, v.visit_date, v.duration_minutes, v.status, v.visit_kind,
           ${localDate('v.visit_date')} AS day,
           strftime('%H:%M', v.visit_date, 'localtime') AS time,
           v.patient_id, p.full_name AS patient_name, p.mrn
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
     WHERE ${w.sql}
       AND v.status IN ('scheduled', 'confirmed')
       AND v.sync_origin IS NULL
       AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM visit_services vs
                                        WHERE vs.visit_id = v.id AND vs.doctor_id = ? AND vs.status <> 'cancelled'))
     ORDER BY v.visit_date, v.id
     LIMIT ${MAX_ROWS}`).all(...w.params, me, me);
  const what = new Map();
  if (rows.length) {
    const ids = rows.map((r) => r.visit_id);
    const lines = db.prepare(`
      SELECT vs.visit_id, COALESCE(NULLIF(s.name, ''), NULLIF(ct.name_ru, ''), ct.name) AS name
        FROM visit_services vs
        LEFT JOIN services s ON s.id = vs.service_id
        LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
       WHERE vs.visit_id IN (${ids.map(() => '?').join(', ')}) AND vs.doctor_id = ? AND vs.status <> 'cancelled'
       ORDER BY vs.id`).all(...ids, me);
    for (const l of lines) {
      if (!l.name) continue;
      const list = what.get(l.visit_id) || [];
      list.push(l.name);
      what.set(l.visit_id, list);
    }
  }
  return {
    from: span.f,
    to: span.t,
    rows: rows.map((r) => ({ ...r, patient_name: r.patient_name || '', mrn: r.mrn || '', what: what.get(r.visit_id) || [] })),
  };
}
```

**3.2** `server/services/rpc/index.js` — найти:
```js
import { calendarSlots, calendarWindows, calendarBook } from './calendar.js';   // CALENDAR_BOOKING_V1
```
заменить на:
```js
import { calendarSlots, calendarWindows, calendarBook } from './calendar.js';   // CALENDAR_BOOKING_V1
import { doctorUpcomingVisits } from './doctor-upcoming.js';   // REPEAT_VISIT_V1 — «Записи вперёд» кабинета врача
```

**3.3** Там же найти:
```js
  calendar_book:             (db, args, user) => calendarBook(db, args, user),
```
заменить на:
```js
  calendar_book:             (db, args, user) => calendarBook(db, args, user),
  // REPEAT_VISIT_V1 — «Записи вперёд»: свои записи врача на 30 дней. Только
  // чтение (READ_ONLY_RPCS): чьи — решает сессия, аргумента «чей» нет.
  doctor_upcoming_visits:    (db, args, user) => doctorUpcomingVisits(db, args, user),
```

**3.4** `server/services/control/gate.js` (`READ_ONLY_RPCS`) — найти:
```js
  'calendar_slots', 'calendar_windows',
```
заменить на:
```js
  'calendar_slots', 'calendar_windows',
  // REPEAT_VISIT_V1 — «Записи вперёд» кабинета врача: свои будущие записи. Чтение.
  'doctor_upcoming_visits',
```

**3.5** `public/js/admin/i18n-strings.js` — перед строкой `  // /REPEAT_VISIT_V1` вставить:
```js
  "«Записи вперёд» открываются только врачу.": {"en":"Upcoming bookings are available to doctors only.","ru":"«Записи вперёд» открываются только врачу.","uz":"«Oldindagi yozuvlar» faqat shifokorga ochiladi."},   // REPEAT_VISIT_V1 — doctor_upcoming_visits
```

- [ ] **Step 4: run — должен пройти**

```bash
node --experimental-vm-modules --test server/services/rpc/doctor-upcoming.test.js server/services/domain/no-drift.test.js server/i18n-server-messages.test.js server/services/rpc/client-rpc-coverage.test.js
node --experimental-vm-modules --test server/services/rpc/index.test.js
```
Expected: PASS, ни одного ✖. `index.test.js` зовёт КАЖДЫЙ обработчик карты и идёт несколько минут — это его обычная скорость.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
Сервер: «Записи вперёд» врача — doctor_upcoming_visits (REPEAT_VISIT_V1)

Врач нигде не видел своих будущих записей: «Мой день» кончается сегодня,
«Мои записи» — строки после оплаты. Новый RPC только для чтения отдаёт
свои записи (врач записи или своя живая строка) с завтрашнего местного дня
на 30 дней: день и время, пациент, вид визита, что записано к этому врачу.
Только своё здание, только ждущие записи; «чей» — из сессии.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add server/services/rpc/doctor-upcoming.js server/services/rpc/doctor-upcoming.test.js server/services/rpc/index.js server/services/control/gate.js public/js/admin/i18n-strings.js
git commit -F .git/U78_MSG.txt
```

---

### Task U8.5: Кабинет — «Записи вперёд · N» под «Моим днём»

**Files:**
- Modify: `public/js/admin/views/doctor-dashboard.js`
- Modify: `public/js/admin/i18n-strings.js`
- Test (modify): `public/js/admin/__tests__/doctor-dashboard.test.mjs`

Блок — третьим ребёнком карточки «Мой день» (`aside.dd-day`), ПОД лентой `.dd-day-list`: лента по-прежнему кончается группой «Завершённые» (это проверяет существующий тест CABINET_ACTIVE_FIRST_V1), будущие записи не смешиваются с сегодняшними. U2.6 правит этот же файл (подписка на `queue-fresh.js` после `let openInpatientsRef`) — места не пересекаются.

- [ ] **Step 1: failing test** — `public/js/admin/__tests__/doctor-dashboard.test.mjs`:

**1.1** Найти:
```js
let PAY_BY_DOCTOR = { 'u-doc-a': PAY_A(), 'u-doc-b': [payLineOf('svb', 0, 37600, null)] };
```
заменить на:
```js
let PAY_BY_DOCTOR = { 'u-doc-a': PAY_A(), 'u-doc-b': [payLineOf('svb', 0, 37600, null)] };
// REPEAT_VISIT_V1 — ответ doctor_upcoming_visits («Записи вперёд»); null — пусто.
let UPCOMING = null;
let upcomingCalls = [];
```

**1.2** В фальшивом `fetch` найти:
```js
  if (u.startsWith('/api/rpc/doctor_pay_summary')) {
```
заменить на:
```js
  if (u.startsWith('/api/rpc/doctor_upcoming_visits')) {
    upcomingCalls.push(body);
    return { ok: true, json: async () => ({ data: UPCOMING || { from: '', to: '', rows: [] } }) };
  }
  if (u.startsWith('/api/rpc/doctor_pay_summary')) {
```

**1.3** Дописать в конец файла:
```js

// REPEAT_VISIT_V1 (2026-11-02) — «Записи вперёд · N»: свои записи на 30 дней
// (сервер, doctor_upcoming_visits) под лентой «Моего дня», свёрнуто при
// открытии, внутри — по дням. Лента дня по-прежнему кончается «Завершёнными».
test('REPEAT_VISIT_V1: «Записи вперёд · N» — свои записи по дням, свёрнуто при открытии кабинета', async () => {
  reset();
  upcomingCalls = [];
  UPCOMING = { from: '2026-11-03', to: '2026-12-02', rows: [
    { visit_id: 'f-1', day: '2026-11-03', time: '09:00', visit_kind: 'repeat', status: 'scheduled',
      patient_id: 'p-1', patient_name: 'Иванов Пётр', mrn: 'MRN-001', what: ['Повторный приём'] },
    { visit_id: 'f-2', day: '2026-11-10', time: '14:20', visit_kind: 'first', status: 'confirmed',
      patient_id: 'p-3', patient_name: 'Тошев Жасур', mrn: 'MRN-003', what: [] },
  ] };
  try {
    loginAs(DOCTOR_A);
    const host = mk('div');
    await dash.renderDoctorDashboard(host, {});
    assert.deepStrictEqual(upcomingCalls, [{ days: 30 }], 'записи вперёд спрошены не на 30 дней');
    const block = byClass(host, 'dd-upcoming')[0];
    assert.ok(block, 'нет блока «Записи вперёд»');
    const head = byClass(block, 'dd-done-h')[0];
    assert.ok(textOf(head).includes('Записи вперёд · 2'), 'подпись группы: ' + textOf(head));
    assert.strictEqual(head.attrs['aria-expanded'], 'false', 'при открытии кабинета группа свёрнута');
    assert.ok(!textOf(block).includes('Тошев Жасур'), 'свёрнутая группа показывает записи');
    head.click();
    const t = textOf(block);
    for (const s of ['3 ноября 2026', '10 ноября 2026', '09:00', 'Иванов Пётр', 'Повторный приём', 'Повторный', '14:20', 'Тошев Жасур']) {
      assert.ok(t.includes(s), 'в «Записях вперёд» нет «' + s + '»: ' + t);
    }
    const list = byClass(host, 'dd-day-list')[0];
    assert.ok(hasClass(list.children.at(-1), 'dd-done'), 'лента дня больше не кончается «Завершёнными»');
    assert.ok(!byClass(list, 'dd-up-row').length, 'будущие записи попали в ленту сегодняшнего дня');
  } finally {
    UPCOMING = null;
  }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/doctor-dashboard.test.mjs
```
Expected: FAIL 1 — «записи вперёд спрошены не на 30 дней» (`[]` вместо `[{ days: 30 }]`). Остальные — PASS.

- [ ] **Step 3: implement** — `public/js/admin/views/doctor-dashboard.js`:

**3.1** Найти:
```js
/** Только для тестов и соседей: что полоса сейчас показывает. */
export function wardHeadState() { return { ...ward }; }
```
заменить на:
```js
/** Только для тестов и соседей: что полоса сейчас показывает. */
export function wardHeadState() { return { ...ward }; }

// REPEAT_VISIT_V1 — свои записи на 30 дней вперёд (doctor_upcoming_visits).
// Аргумента «чей» нет и у сервера: записи — того, кто вошёл.
export const UPCOMING_DAYS = 30;
async function loadUpcoming() {
    state.upcoming = [];
    try {
        const { data, error } = await supabase.rpc('doctor_upcoming_visits', { days: UPCOMING_DAYS });
        if (error) { console.warn('[doctor-dash] upcoming:', error.message); return; }
        state.upcoming = Array.isArray(data && data.rows) ? data.rows : [];
    } catch (e) { console.warn('[doctor-dash] upcoming threw:', e && e.message); }
}
```

**3.2** Найти (объект `state`):
```js
    doneOpen: false,
```
заменить на:
```js
    doneOpen: false,
    // REPEAT_VISIT_V1 — «Записи вперёд · N»: свои записи на 30 дней (сервер) и
    // раскрыта ли группа. Новое открытие кабинета её сворачивает.
    upcoming: [],
    upcomingOpen: false,
```

**3.3** Найти (`loadDoctorDashboard`):
```js
    await loadWardHead();
```
заменить на:
```js
    await loadWardHead();

    // REPEAT_VISIT_V1 — «Записи вперёд» — тоже отдельным шагом и молча: сбой не
    // делает день «неполным» (state.failed не трогается), группа просто пуста.
    await loadUpcoming();
```

**3.4** Найти (`resetDoctorDashboard`):
```js
    state.doneOpen = false;   // CABINET_ACTIVE_FIRST_V1 — новое открытие кабинета: завершённые свёрнуты
```
заменить на:
```js
    state.doneOpen = false;   // CABINET_ACTIVE_FIRST_V1 — новое открытие кабинета: завершённые свёрнуты
    state.upcoming = []; state.upcomingOpen = false;   // REPEAT_VISIT_V1
```

**3.5** Найти (`dayCard`, конец):
```js
        ),
        list,
    );
}
function nowLine(now) {
```
заменить на:
```js
        ),
        list,
        // REPEAT_VISIT_V1 — «Записи вперёд» под лентой дня, своим блоком: лента
        // по-прежнему кончается группой «Завершённые», а будущие записи не
        // смешиваются с сегодняшними.
        upcomingGroup(state.upcoming || []),
    );
}
function nowLine(now) {
```

**3.6** Найти:
```js
function apptCard(r) {
```
заменить на:
```js
// REPEAT_VISIT_V1 (2026-11-02) — «ЗАПИСИ ВПЕРЁД · N». «Мой день» кончается
// сегодня, а «Мои записи» — строки после оплаты: пациент, которого врач сам
// записал на повторный визит через неделю, нигде не был виден. Группа свёрнута
// при открытии кабинета (как «Завершённые»), внутри — по дням, по времени.
// Строки не кнопки: работы по будущей записи сегодня нет.
function upcomingGroup(rows) {
    const box = h('div', { class: 'dd-done-list' });
    const head = h('button', {
        type: 'button', class: 'dd-done-h', 'aria-expanded': 'false',
        onclick: () => { state.upcomingOpen = !state.upcomingOpen; draw(); },
    },
        h('span', { class: 'dd-done-ic' }, Icon('ChevronRight', { size: 14 })),
        trf('Записи вперёд · {n}', { n: rows.length }));
    function draw() {
        head.setAttribute('aria-expanded', state.upcomingOpen ? 'true' : 'false');
        head.className = 'dd-done-h' + (state.upcomingOpen ? ' on' : '');
        clear(box);
        if (!state.upcomingOpen) return;
        if (!rows.length) {
            box.appendChild(h('div', { class: 'dd-up-day' }, tr('Записей на ближайшие 30 дней нет')));
            return;
        }
        let day = null;
        for (const r of rows) {
            if (r.day !== day) { day = r.day; box.appendChild(h('div', { class: 'dd-up-day' }, fmtDate(r.day))); }
            box.appendChild(upcomingRow(r));
        }
    }
    draw();
    return h('div', { class: 'dd-done dd-upcoming' }, head, box);
}
function upcomingRow(r) {
    const meta = [r.mrn || null, (r.what || []).join(', ') || null].filter(Boolean).join(' · ');
    return h('div', { class: 'dd-appt dd-up-row' },
        h('span', { class: 'dd-appt-t' }, r.time || '—'),
        h('span', { class: 'dd-appt-av ' + pastelFor(r.patient_id) }, initials(r.patient_name || '?')),
        h('span', { class: 'dd-appt-b' },
            h('span', { class: 'dd-appt-n' }, r.patient_name || tr('Без имени')),
            h('span', { class: 'dd-appt-m' }, meta || '—'),
        ),
        r.visit_kind === 'repeat' ? h('span', { class: 'dd-chip now' }, tr('Повторный')) : null,
    );
}
function apptCard(r) {
```
(`h`, `Icon`, `clear`, `initials`, `fmtDate`, `tr`, `trf`, `pastelFor`, `supabase` в файле уже импортированы. `fmtDate('YYYY-MM-DD')` разбирает день как местную полночь — день не сдвигается.)

**3.7** Найти (в строке `DASH_CSS`; внутри строки — только латиница):
```js
/* HEAD_DOCTOR_WARD_VIEW_V1 — head-doctor ward strip. No new colours. */
```
заменить на:
```js
/* REPEAT_VISIT_V1 — upcoming bookings under the day list: folded head, own
   scroll, rows are not buttons. No new colours. */
.dd-upcoming { flex: 0 1 auto; max-height: 45%; overflow-y: auto; margin: 0 10px 10px; }
.dd-up-day { font-size: 12.5px; font-weight: 700; color: var(--ink-600); padding: 4px 4px 0; }
.dd-up-row { cursor: default; }
.dd-up-row:hover { border-color: var(--ink-100); }

/* HEAD_DOCTOR_WARD_VIEW_V1 — head-doctor ward strip. No new colours. */
```

**3.8** `public/js/admin/i18n-strings.js` — перед строкой `  // /REPEAT_VISIT_V1` вставить:
```js
  "Записи вперёд · {n}": {"en":"Upcoming bookings · {n}","ru":"Записи вперёд · {n}","uz":"Oldindagi yozuvlar · {n}"},   // REPEAT_VISIT_V1 — кабинет врача
  "Записей на ближайшие 30 дней нет": {"en":"No bookings in the next 30 days","ru":"Записей на ближайшие 30 дней нет","uz":"Keyingi 30 kunda yozuvlar yo'q"},   // REPEAT_VISIT_V1
  "Повторный": {"en":"Follow-up","ru":"Повторный","uz":"Takroriy"},   // REPEAT_VISIT_V1 — метка визита в «Записях вперёд»
```

- [ ] **Step 4: run — должен пройти** (итоговый прогон U7 + U8)

```bash
C="public/js/admin/__tests__/doctor-dashboard.test.mjs public/js/admin/__tests__/revisit-repeat-visit.test.mjs public/js/admin/__tests__/consultation-flags.test.mjs public/js/admin/__tests__/booking-doors.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/patients-hub.test.mjs public/js/admin/__tests__/patient-row.test.mjs public/js/admin/__tests__/patient-card-tabs.test.mjs public/js/admin/__tests__/app-shell.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/server-messages-i18n.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
S="server/services/domain/visit-summary.test.js server/services/rpc/patient-aggregates.test.js server/services/rpc/patient-card.test.js server/services/rpc/telegram.test.js server/services/rpc/calendar-repeat.test.js server/services/rpc/calendar.test.js server/services/rpc/visits.test.js server/services/rpc/doctor-upcoming.test.js server/routes/crm-calendar-v3120.test.js server/routes/crm-calendar-mirror.test.js server/routes/visit-lines-v3120-final.test.js server/routes/crm-unify-link-guards.test.js server/services/api/bookings-confirm.test.js server/i18n-server-messages.test.js server/services/domain/no-drift.test.js"
node --experimental-vm-modules --test $S
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U78_MSG.txt`:
```
Кабинет: «Записи вперёд · N» под «Моим днём» (REPEAT_VISIT_V1)

Свои записи врача на 30 дней (doctor_upcoming_visits) — свёрнутой группой
под лентой дня, как «Завершённые»: по дням, время, пациент, что записано,
метка «Повторный». Лента сегодняшнего дня не меняется; сбой загрузки — пустая
группа, день не помечается неполным.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/doctor-dashboard.js public/js/admin/i18n-strings.js public/js/admin/__tests__/doctor-dashboard.test.mjs
git commit -F .git/U78_MSG.txt
```

---

## Поправки к дизайну (проверено по коду)

1. **«Цена по дню визита — `quoteTier`»:** `quoteTier` — закрытая функция `billing.js` и знает только `service_id`. Строка записи идёт через уже существующую дверь `insertBookingLine` (`crm/booking-mirror.js` → `priceFor`): та же котировка `servicePriceQuote` с `date` = местный день визита и `lineUnitPrice` кассы — по сути то же правило, что `quoteTier`, и та же дверь, что у записи колл-центра (`booking_lines_add`). У консультации (`consultation_type_id`) ярусов нет: цена — по ценам врача, `price_tier = NULL` (так же у мастера и колл-центра).
2. **«Строка консультации/услуги» у врача без видов консультаций:** прежнее окно в этом случае писало визит без строки. Теперь окно предлагает услуги каталога типа `consultation` (`services.type = 'consultation'`, активные) и шлёт `line: { service_id }`; если нет и их — визит записывается без строки (время всё равно занято). Сервер не проверяет, что врач «ведёт» эту услугу (`assertPerformer` кассы — внутренняя функция `billing.js`; у `booking_lines_add` такой проверки тоже нет).
3. **Строгий отказ — для любого визита дня, включая пустую запись ТОГО ЖЕ врача.** Дизайн: «если у пациента в этот день уже есть визит — отказ». Поэтому повторный визит не переносит даже свою пустую запись (иначе окно молча сдвигало бы чужое для врача время приёма). Визиты соседнего здания (`sync_origin`) правило не видит — тот же запрос, что у DAY_VISIT_V1 и `ensure_visit`.
4. **«Записи вперёд» — с завтрашнего дня:** сегодняшние приёмы уже в «Моём дне». Своими считаются визит врача и визит другого врача со СВОЕЙ живой строкой (УЗИ у этого врача). Блок — в «Моём дне» кабинета (первый экран кабинета), а не во вкладке «Мои записи».
5. **«Без визитов — местный день регистрации»** делает сервер (`registration_day`, `domain/day.js`), а не браузер; до ответа агрегатов строка реестра показывает ISO регистрации через `fmtDay` (тоже местный день браузера). Карта пациента без состоявшихся визитов по-прежнему пишет «—» и «визитов не было» (день регистрации там не подставлялся и раньше).

## Risks / implementer must check

- **Порядок задач.** U8 идёт после U9 (DUP_STOP_V1). Если U9 повесил проверку повтора на `insertBookingLine` — новый визит повторного приёма пуст, конфликтов нет; но если U9 изменил сигнатуру `insertBookingLine`/`bookingLineRefusal` — подстроить вызов в 3.6 U8.2. U10a (REFERRAL_LINE_V1, после U8) должен включить новую дверь строки — `calendar_book` с `line` — в свой список дверей (строку повторного визита врач добавляет себе сам → бонуса нет; но если врач А записывает повторный визит пациента к врачу Б, это направление).
- **Слова отказа «визит дня есть» для пустой записи.** После U8.1 регистратор, записывающий пациента к врачу Б в день, где у того пустая запись к врачу А, получает прежний текст `day_visit_busy` «…и по нему уже идёт работа…», хотя работы нет; онлайн-запись партнёра — `day_visit_busy` («визит с работой») вместо `day_visit_exists`. Отказ верный, формулировка неточная (так же было с G3 — строки другого врача). Если владелец захочет точнее — отдельный код, в этот план не входит.
- **Журнал действий окна повторного визита падает давно:** `logPatientActivity` шлёт `detail` объектом, `/api/db` отвечает `400 … unsupported value type` (видно в выводе нового теста). Обёрнуто в `try`, на запись не влияет; не чинится здесь.
- **`index.test.js`** зовёт каждый обработчик и идёт минуты; новый обработчик без `user.id` отвечает 403 — это «намеренный» отказ, тест его принимает.
- **Тест окна** берёт 10-е число следующего месяца от `new Date()` в двух местах (окно и тест); расхождение возможно только если прогон пересекает полночь последнего дня месяца.
- **Анкоры после предыдущих задач:** `doctor-dashboard.js` правит U2.6 (место не пересекается), `service-picker-modal.js` — U5/U9 (`BOOK_ERROR_TEMPLATES` они не трогают), `service-workspace.js` — U1/U9/U3 (U3 идёт позже). Если строка «найти» не совпала — искать по маркеру/функции, названной у правки.
- Проверить руками на dev, что `room-calendar.js` (свой вызов `calendar_book`) и окно визита (`visit-modal.js`, перенос дня) не шлют `visit_kind`/`line` — иначе их перенос получит 400 «Вид визита и услугу записи задают только новой записи.» (на 347bfd3d не шлют: `grep -rn "visit_kind" public/js` — только окно визита через `/api/db` и бывший повторный визит).

## Manual check for the owner

1. Пациенты: у пациента с завтрашней записью в колонке «Последний визит» — дата прошлого приёма (или день регистрации), под ней «запись: 3 ноября 2026»; отменённые и будущие визиты не считаются в «визитов: N».
2. Кабинет врача → «Повторный визит» → день, где у пациента уже есть приём: окно пишет «У пациента в этот день уже есть приём в 09:00 у … — выберите другой день или время.» и не закрывается; на свободный день — визит «Повторный» с консультацией появляется в календаре на выбранное время.
3. Тот же врач, «Мой день» → внизу «Записи вперёд · N» → раскрыть: записанный пациент виден в нужный день и время.
