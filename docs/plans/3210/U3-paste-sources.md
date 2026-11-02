# U3. «Вставить результаты» — из всех документов пациента (PASTE_SOURCES_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal:** кнопка «Вставить результаты» в кабинете врача показывает ВСЕ документы пациента пятью вкладками — «Консультации», «Диагностика», «Анализы», «Стационар», «Файлы»; раскладка по `services.type`; анализ в `resulted` виден с пометкой «не проверено»; у документа — разделы с галочками, и в выбранное поле вставляется ПОЛНЫЙ текст отмеченных разделов (через прежние `_pastePickField` → `a4InsertHtml`). Текущая строка не показывается, чужое здание не видно, права — как у карты пациента. Мёртвый `openStudyHistoryModal` удалён.

**Architecture:** сервер — новый `server/services/rpc/patient-doc-sources.js` (`patientDocSources`, RPC `patient_doc_sources`, только чтение): права через новую `patientCardAccess()` карты пациента (`rpc/patient-card.js`), подписанная запись строки — общим правилом `lastSignedEntry()` (выносится из карты пациента в `public/js/shared/cabinet-doc.js`), снимок → разделы через `notesDocData`/`richForSheet` (`shared/cabinet-doc.js`) и общий санитайзер (`shared/rich-text.js`). Клиент — новый экран-модуль `public/js/admin/views/paste-sources.js` (окно + чистые сборщики разметки вставки); `service-workspace.js` `openEmrModal` вызывает его, вся прежняя «Карта приёмов» (`loadPatientEmr`, `paintEmr`, `emrRow`, `emrTabBtn`, `openEmrResultModal`, `fillServiceConclusion`, `fillLabResults`, `openStudyHistoryModal`, `renderStudyPreview`, `wsState.emr`) удаляется. Миграции нет.

**Tech Stack:** Node 24 ESM, better-sqlite3, vanilla-JS SPA (`h()`, `Icon()`, `tr()`/`trf()`), node:test, DOM-стенд `public/js/admin/__tests__/cabinet-harness.mjs`.

**Спецификация:** `docs/specs/2026-11-02-3210-batch-design.md`, раздел U3. Порядок выпуска: U3 идёт после U10b — к этому моменту U1/U2/U8 уже правили `service-workspace.js`, другие задачи — `i18n-strings.js`, `rpc/index.js`, `control/gate.js`. **Номера строк ниже — до любых правок выпуска; все правки привязаны к тексту.** Не нашёлся точный текст «было» — найти то же место по смыслу, сохранить чужие правки.

## Карта файлов

| Файл | Что |
|---|---|
| `public/js/shared/cabinet-doc.js` | + `lastSignedEntry(raw)` — последняя подписанная запись кабинета из `visit_services.notes` |
| `public/js/shared/cabinet-doc.test.js` | новый: правило `lastSignedEntry`; карта пациента пользуется им же |
| `public/js/admin/views/patient-card.js` | «Документы» (WS_DERIVED_DOCS_V1) разбирает notes через `lastSignedEntry` |
| `server/services/rpc/patient-card.js` | + `export function patientCardAccess(db, user)`; `fileOnThisMachine` — `export` (U3.4) |
| `server/services/rpc/patient-doc-sources.js` | новый: `patientDocSources` и разбор документов |
| `server/services/rpc/patient-doc-sources.test.js` | новый: всё серверное U3 |
| `server/services/rpc/index.js` | импорт + `patient_doc_sources` в карте RPC |
| `server/services/control/gate.js` | `'patient_doc_sources'` в `READ_ONLY_RPCS` |
| `public/js/admin/views/paste-sources.js` | новый: окно «Вставить результаты», `docInsertHtml`, `labInsertHtml`, `docDay`, `docTitle` |
| `public/js/admin/i18n-strings.js` | блок `// PASTE_SOURCES_V1` — 11 фраз ru/uz/en |
| `public/js/admin/__tests__/paste-sources.test.mjs` | новый: окно и сборщики вставки |
| `public/js/admin/views/service-workspace.js` | `openEmrModal` → `openPasteSourcesModal`; удалена прежняя «Карта приёмов», мёртвые `openStudyHistoryModal`/`renderStudyPreview` и неприкреплённая кнопка `emrBtn` |
| `public/css/admin-views.css` | удалены стили `.st-*` мёртвого окна истории исследований |
| `public/js/admin/__tests__/paste-sources-cabinet.test.mjs` | новый: кнопка листа → окно → «Куда вставить?» → поле; страж удалённого кода |
| `public/js/admin/__tests__/cabinet-review-r2.test.mjs`, `cabinet-review-r3.test.mjs`, `cabinet-review-r4.test.mjs`, `doc-rich-format.test.mjs` | правка ожиданий: `loadPatientEmr`/`fillServiceConclusion` больше нет (их смысл переехал в серверный тест) |

## Сверено с кодом (поправки к исследованию и дизайну)

- `openEmrModal` — `service-workspace.js:335`; живая кнопка — на листе (`:6921`, `_ic.results`). Кнопка `emrBtn` (`:955`) создаётся, но ни в одну панель не добавляется (`:1019` перечисляет `tplBtn, draftBtn, printBtn, saveBtn, finishBtn`) — мёртвая, удаляется вместе со старым окном.
- `loadPatientEmr` (`:1722`): только `status='completed'`, `limit(200)`, раскладка `departments.kind` → регулярка имени вида (`:1758-1771`), `services.type` не читается. `fillServiceConclusion` (`:2113`) при отсутствии подписанной записи берёт ЧЕРНОВИК; новое окно берёт только подписанное (черновик — не документ).
- `openStudyHistoryModal` (`:1988`) и `renderStudyPreview` (`:2044`) — вызовов нет; стили `.st-*` (`admin-views.css:2255-2277`, `:2332-2333`) нужны только им.
- Разбор подписанной записи в карте пациента — встроенный (`patient-card.js:1748-1753`), отдельной функции нет: выносится в `shared/cabinet-doc.js` (`lastSignedEntry`) и используется и картой, и сервером.
- Снимки архива: `protocol` — ключи `complaint, hpi, exam, labs, instrumental, dx, therapy, recsText, conclusionText, prescriptions` (`buildBlankData`, `:6480`), с `rich: 1` — разметка `richForSheet`, без него — текст; `diag` — `description, conclusion, conclusionAuto/Body, prescriptions, images` (**base64**, `diagDocData` `:6545`) — изображения в ответ не идут никогда.
- `visit_services.notes` и `visit_documents` между зданиями не ездят (`branch-sync/journal.js` `SHIPPED`: у `visit_services` только `quantity`, `status`); `lab_results` ездят. **Дизайн противоречит сам себе:** «права и здание — как у документов карты пациента», но карта (`rpc/patient-card.js`) зданием НЕ фильтрует и показывает приехавшие анализы с меткой «Филиал X» (BRANCH_ORIGIN_V1); тест дизайна — «чужое здание не видно». План выполняет тест дизайна: визиты и строки с `sync_origin` не берутся (кабинет — работа своего здания, решение 2026-09-02). Если владелец хочет «как карта» — убрать два `ownWhere` (риск 1).
- У встроенных родов истории болезни `case_doc_types.title` пуст (миграция 115: «их имена переводятся на экране»); имена — `CASE_DOC_TITLE` в `views/case-docs.js`. Сервер отдаёт `doc_kind` и своё имя клиники (или `''`), окно называет документ этим словарём.
- `visits.conclusion` пишет и кабинет (текст своего «Заключения», WS_CONCLUSION_V1 `:5510`) — поэтому заключение визита показывается, только если ни у одной строки визита (включая текущую) нет документа.
- «Куда вставить?» (`_pastePickField`, `:691`) предлагает только `DOC_SECTIONS` приёма; прежние поля по умолчанию `labs_text`/`instrumental_text` в нём не подсвечиваются — поведение сохранено как было.
- Проверки RPC: `server/services/rpc/index.test.js` зовёт каждый обработчик с `{}` (отказ должен быть `RpcError`); `client-rpc-coverage.test.js` и `rpc-exists.test.mjs` требуют регистрации имени, которое зовёт браузер; `READ_ONLY_RPCS` — `control/gate.js`.

## Общие правила

- Корень: `cd "/c/Users/user/Desktop/implementation workflow/easymed.api5"`; ветка `rc/3.21.0`. Никогда не открывать `data/` и `*.db`.
- Тесты — только названные файлы: `node --experimental-vm-modules --test <файлы>` (явные пути; на Windows с Node 24 без путей не запускать).
- Правки — инструментами Edit/Write или скриптом Node, записанным инструментом Write (heredoc в Bash ест обратную косую черту). Концы строк LF.
- Комментарии — по-русски с меткой `PASTE_SOURCES_V1`; значки — только `Icon()`; новые слова экрана — в `i18n-strings.js` (uz/en без кириллицы).
- Коммит: перед `git add` — `git diff --cached --name-only` пуст; добавлять только названные файлы; сообщение — инструментом Write в `.git/U3_MSG.txt`, `git commit -F .git/U3_MSG.txt`; последняя строка сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `server/services/rpc/case-doc-sources.js` в U3 не меняется. В нём настоящий байт NUL внутри строки (`'…\0…'` ключа на байте 4595) — Edit/Write этот файл не возьмут; если когда-нибудь понадобится — правка скриптом Node, сохраняющим байт.

---

### Task U3.1: `lastSignedEntry` — одно правило «подписанная запись строки» для карты и вставки

**Files:**
- Modify: `public/js/shared/cabinet-doc.js` (в конец файла)
- Modify: `public/js/admin/views/patient-card.js` (импорт `:33`; цикл WS_DERIVED_DOCS_V1 `:1748-1753`)
- Create: `public/js/shared/cabinet-doc.test.js`

- [ ] **Step 1: failing test** — создать `public/js/shared/cabinet-doc.test.js`:

```js
// PASTE_SOURCES_V1 — последняя ПОДПИСАННАЯ запись кабинета (visit_services.notes):
// одно правило для карты пациента («Документы», WS_DERIVED_DOCS_V1) и для
// «Вставить результаты» кабинета (rpc patient_doc_sources).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastSignedEntry } from './cabinet-doc.js';

test('lastSignedEntry: последняя подписанная версия; черновики и направления не в счёт', () => {
  const raw = JSON.stringify({ __service_workspace_v1: 1, diagnoses: [{ code: 'J20.9', type: 'main' }], history: [
    { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', fields: { chief_complaint: 'первая' } },
    { kind: 'signed', savedAt: '2026-10-02T08:00:00.000Z', fields: { chief_complaint: 'вторая' } },
    { kind: 'draft', savedAt: '2026-10-03T08:00:00.000Z', fields: { chief_complaint: 'черновик' } },
    { kind: 'referral', savedAt: '2026-10-03T09:00:00.000Z' },
  ] });
  const got = lastSignedEntry(raw);
  assert.equal(got.entry.fields.chief_complaint, 'вторая');
  assert.equal(got.payload.diagnoses[0].code, 'J20.9', 'диагнозы строки едут вместе с записью');
});

test('lastSignedEntry: не JSON, текст медсестры, массив, history не массив, без подписи — null', () => {
  for (const raw of [null, '', '{не json', 'Свободный текст лаборатории', '[]',
    JSON.stringify({ history: {} }), JSON.stringify({ history: [{ kind: 'draft', fields: {} }] }), JSON.stringify({ history: [null, 1, 'x'] })]) {
    assert.equal(lastSignedEntry(raw), null, String(raw));
  }
});

test('карта пациента берёт подписанную запись тем же правилом (patient-card.js)', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'admin', 'views', 'patient-card.js'), 'utf8');
  assert.match(src, /lastSignedEntry\(r\.notes\)/, 'карта пациента разбирает notes сама, мимо общего правила');
  assert.ok(!/filter\(e2 => e2\.kind === 'signed'\)/.test(src), 'в карте остался свой разбор подписанных версий');
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/shared/cabinet-doc.test.js`
  Ожидается FAIL: `SyntaxError: The requested module './cabinet-doc.js' does not provide an export named 'lastSignedEntry'`.

- [ ] **Step 3: implement**

  (а) В конец `public/js/shared/cabinet-doc.js` (после закрывающей `}` функции `notesDocData`) дописать:

```js

/**
 * PASTE_SOURCES_V1 — ПОСЛЕДНЯЯ ПОДПИСАННАЯ ЗАПИСЬ КАБИНЕТА из visit_services.notes.
 *
 * Одно правило на двоих: карта пациента («Документы», WS_DERIVED_DOCS_V1) и
 * «Вставить результаты» кабинета (rpc patient_doc_sources). notes — JSON
 * кабинета: history[…] с kind 'signed'; документ строки — последняя подписанная
 * версия (черновик — не документ). Не JSON, не объект, history не массив,
 * подписанных нет — null: заметка медсестры текстом документом не считается.
 *
 * @param {string} raw visit_services.notes как лежит в базе
 * @returns {{entry: object, payload: object}|null}
 */
export function lastSignedEntry(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let p = null;
    try { p = JSON.parse(raw); } catch { return null; }
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Array.isArray(p.history)) return null;
    const signed = p.history.filter((e) => e && typeof e === 'object' && e.kind === 'signed');
    const entry = signed[signed.length - 1];
    return entry ? { entry, payload: p } : null;
}
```

  (б) `public/js/admin/views/patient-card.js`, импорт. Было:
```js
import { notesDocData } from '../../shared/cabinet-doc.js';   // DOC_RICH_FORMAT_V1 (ревью T1) — лист приёма из подписанной записи
```
  Стало:
```js
import { notesDocData, lastSignedEntry } from '../../shared/cabinet-doc.js';   // DOC_RICH_FORMAT_V1 (ревью T1) — лист приёма из подписанной записи · PASTE_SOURCES_V1 — подписанная запись строки одним правилом
```

  (в) Там же, цикл в `paintList()`. Было:
```js
                        if (archived.has(r.id)) continue;
                        let p = null; try { p = JSON.parse(r.notes); } catch (e2) { continue; }
                        const signed = ((p && p.history) || []).filter(e2 => e2.kind === 'signed');
                        const last = signed[signed.length - 1];
                        if (!last) continue;
```
  Стало:
```js
                        if (archived.has(r.id)) continue;
                        // PASTE_SOURCES_V1 — то же правило, что у «Вставить результаты» (shared/cabinet-doc.js)
                        const got = lastSignedEntry(r.notes);
                        if (!got) continue;
                        const { entry: last, payload: p } = got;
```
  (Дальше в цикле `p` и `last` используются как прежде — не трогать.)

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/shared/cabinet-doc.test.js public/js/admin/__tests__/patient-card-docs.test.mjs`
  Ожидается PASS (оба файла).

- [ ] **Step 5: commit** — `.git/U3_MSG.txt`:
```
Карта пациента и «Вставить результаты»: одно правило подписанной записи строки (PASTE_SOURCES_V1)

lastSignedEntry в shared/cabinet-doc.js — тот разбор visit_services.notes, которым карта
пациента («Документы») находила подписанный протокол строки. Карта перешла на общую
функцию (поведение то же; history не массивом больше не роняет весь список), её же
возьмёт сервер для окна «Вставить результаты».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --name-only
git add public/js/shared/cabinet-doc.js public/js/shared/cabinet-doc.test.js public/js/admin/views/patient-card.js
git commit -F .git/U3_MSG.txt
```

---

### Task U3.2: сервер — `patient_doc_sources`: протоколы и диагностика (записи строк, архив, заключение визита), права, здание, текущая строка, предел

**Files:**
- Create: `server/services/rpc/patient-doc-sources.js`, `server/services/rpc/patient-doc-sources.test.js`
- Modify: `server/services/rpc/patient-card.js` (после `requireCard`, `:74-80`), `server/services/rpc/index.js` (импорт после `:131`, карта после `:148`), `server/services/control/gate.js` (`READ_ONLY_RPCS`, после `'patient_card',` `:128`)

- [ ] **Step 1: failing test** — создать `server/services/rpc/patient-doc-sources.test.js`:

```js
// PASTE_SOURCES_V1 (2026-11-02) — «Вставить результаты» кабинета врача: все
// документы пациента одной выборкой (rpc patient_doc_sources).
//
// Проверяется то, что владелец увидел на тестовой клинике и на dev:
//   • раскладка — по services.type, а не по имени вида услуги (справочник
//     «Типы услуг» у клиник пуст, отделов у услуг нет);
//   • в документ идёт ПОЛНЫЙ текст разделов — Жалобы, Анамнез, Терапия,
//     Заключение, «Описание» диагностики, — а не сводка из трёх;
//   • архив документов (visit_documents) и заключение визита читаются;
//   • текущая строка не возвращается, чужое здание не видно, права — как у
//     карты пациента; размер ответа ограничен.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientDocSources, SECTION_MAX, lineKind } from './patient-doc-sources.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const DOCTOR = { id: 3, role: 'doctor' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`
    INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES
      (3, 'doc', 'x', 'Врач Тестов', 'doctor', 1),
      (4, 'doc2', 'x', 'Врач Второй', 'doctor', 1),
      (11, 'store', 'x', 'Склад', 'inventory', 0);
    INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Пациент Тестовый', 'T-1');
    INSERT INTO services (id, name, price, type, is_lab) VALUES
      (901, 'Приём терапевта', 70000, 'consultation', 0),
      (902, 'УЗИ брюшной полости', 90000, 'imaging', 0),
      (903, 'Общий анализ крови', 50000, 'lab', 1),
      (904, 'ЭхоКГ', 120000, 'imaging', 0),
      (905, 'Массаж', 40000, 'procedure', 0);
    INSERT INTO visits (id, patient_id, doctor_id, visit_date) VALUES
      (50, 1, 3, '2026-10-01T05:00:00Z'),
      (51, 1, 4, '2026-10-20T05:00:00Z');
  `);
  return db;
}

function line(db, id, visit, service, { status = 'completed', notes = null, doctor = 3, verified = null } = {}) {
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes, verified_at)
              VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`).run(id, visit, service, doctor, status, notes, verified);
}

function signedNotes(fields, extra = {}) {
  return JSON.stringify({ __service_workspace_v1: 1, current: fields, history: [
    { kind: 'draft', savedAt: '2026-10-01T06:00:00.000Z', fields: { chief_complaint: 'ЧЕРНОВИК' } },
    { kind: 'signed', savedAt: '2026-10-01T07:00:00.000Z', byName: 'Врач Тестов', fields },
  ], ...extra });
}

const setTabs = (db, role, tabs) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const p = JSON.parse(row.permissions);
  p.patient_tabs = tabs;
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
};

test('протокол приёма — все разделы целиком; диагноз — код ПОДПИСАННОЙ записи (F8); УЗИ — «Диагностика»; массаж — «Консультации»; черновик не документ', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({
    chief_complaint: 'Кашель 3 дня', hpi: 'Болеет неделю',
    physical_exam: '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>',
    primary_diagnosis: 'Текст врача', icd10: 'N28.9', therapy_text: '<b>Амоксициллин</b>',
    recommendations_text: 'Диета', conclusion_text: 'Здоров',
  }, { diagnoses: [{ code: 'E71.0', name: 'Болезнь', type: 'main' }], prescriptions: [{ name: 'Парацетамол', dose: '500 мг', freq: '2 раза' }] }) });
  line(db, 62, 50, 902, { notes: signedNotes({ instrumental_text: 'Печень не увеличена', primary_diagnosis: 'Без патологии' }, { docType: 'diag' }) });
  line(db, 63, 50, 905, { notes: signedNotes({ chief_complaint: 'Боль в спине' }) });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(out.groups.consult.map((d) => d.title).sort(), ['Массаж', 'Приём терапевта']);
  const p = out.groups.consult.find((d) => d.title === 'Приём терапевта');
  assert.deepEqual(p.sections.map((s) => s.label), ['Жалобы', 'Анамнез', 'Осмотр', 'Диагноз', 'Терапия', 'Рекомендации', 'Заключение', 'Рецепт']);
  const sec = Object.fromEntries(p.sections.map((s) => [s.key, s.html]));
  assert.equal(sec.complaint, 'Кашель 3 дня');
  assert.equal(sec.exam, '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>', 'оформление врача — разметкой, «<» экранирован один раз');
  assert.equal(sec.dx, 'N28.9<br>Текст врача', 'диагноз — код подписанной записи, а не нынешний основной');
  assert.equal(sec.therapy, '<b>Амоксициллин</b>');
  assert.match(sec.rx, /<ol><li><b>Парацетамол<\/b> — 500 мг, 2 раза<\/li><\/ol>/);
  assert.equal(p.doctor, 'Врач Тестов');
  assert.equal(p.at, '2026-10-01T07:00:00.000Z', 'дата документа — подпись');
  assert.deepEqual(out.groups.diag.map((d) => d.title), ['УЗИ брюшной полости']);
  assert.deepEqual(out.groups.diag[0].sections.map((s) => [s.label, s.html]), [['Описание', 'Печень не увеличена'], ['Заключение', 'Без патологии']]);
  assert.ok(!JSON.stringify(out).includes('ЧЕРНОВИК'), 'черновик ушёл в документы');
});

test('раскладка по services.type; отдел — запасной путь после типа', () => {
  const db = seed();
  assert.equal(lineKind({ type: 'imaging' }), 'diag');
  assert.equal(lineKind({ type: 'radiology' }), 'diag');
  assert.equal(lineKind({ type: 'lab' }), 'labs');
  assert.equal(lineKind({ type: 'consultation', is_lab: 1 }), 'labs');
  assert.equal(lineKind({ type: 'procedure' }), 'consult');
  assert.equal(lineKind({ type: 'other' }), 'consult');
  assert.equal(lineKind({ type: 'consultation', dept_kind: 'diagnostics' }), 'diag');
  assert.equal(lineKind({ type: 'imaging', dept_kind: 'laboratory' }), 'diag', 'тип сильнее отдела');
  const dep = db.prepare("INSERT INTO departments (name, kind) VALUES ('Функциональная диагностика', 'diagnostics')").run().lastInsertRowid;
  db.prepare("INSERT INTO services (id, name, price, type, department_id) VALUES (906, 'ЭКГ', 40000, 'consultation', ?)").run(dep);
  line(db, 71, 50, 906, { notes: signedNotes({ chief_complaint: 'Перебои' }) });
  line(db, 72, 50, 905, { notes: signedNotes({ chief_complaint: 'Боль в спине' }) });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.deepEqual(out.groups.diag.map((d) => d.title), ['ЭКГ']);
  assert.deepEqual(out.groups.diag[0].sections.map((s) => s.label), ['Жалобы'], 'запись приёма у исследования — разделами приёма');
  assert.deepEqual(out.groups.consult.map((d) => d.title), ['Массаж']);
});

test('архив документов: копия подписи в списке и выигрывает у записи строки; отозванная — нет; снимок до DOC_RICH_FORMAT_V1 — текст; изображения не отдаются', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'из записи строки' }) });
  line(db, 62, 50, 902);
  const arch = (vs, type, body, voided = null) => db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, title, body, created_by, created_at, voided_at)
      VALUES (?, 50, 1, ?, 'Копия', ?, 3, '2026-10-01T08:00:00Z', ?)`).run(vs, type, JSON.stringify(body), voided);
  arch(61, 'protocol', { rich: 1, service: 'Приём терапевта', doctorName: 'Врач Тестов', complaint: 'из архива', hpi: '<p>Анамнез <i>длинный</i></p>', therapy: 'Покой', conclusionText: 'Здоров', dx: 'J20.9 — Острый бронхит' });
  arch(61, 'protocol', { rich: 1, complaint: 'ОТОЗВАННЫЙ' }, '2026-10-01T09:00:00Z');
  arch(62, 'diag', { description: 'Hb <b>ниже</b> нормы', conclusion: 'Без патологии', images: ['data:image/png;base64,' + 'A'.repeat(5000)] });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.consult.length, 1, 'документ строки задвоился: архив и запись строки');
  const p = out.groups.consult[0];
  assert.equal(p.source, 'archive');
  assert.equal(p.title, 'Приём терапевта');
  assert.deepEqual(p.sections.map((s) => s.label), ['Жалобы', 'Анамнез', 'Диагноз', 'Терапия', 'Заключение']);
  assert.equal(p.sections[1].html, '<p>Анамнез <i>длинный</i></p>');
  const s = JSON.stringify(out);
  assert.ok(!s.includes('ОТОЗВАННЫЙ') && !s.includes('из записи строки'), 'отозванный документ или запись строки рядом с её копией');
  assert.equal(out.groups.diag[0].sections[0].html, 'Hb &lt;b&gt;ниже&lt;/b&gt; нормы', 'набранное «<b>» старого снимка стало тегом');
  assert.ok(!s.includes('base64'), 'изображения снимка ушли в ответ');
});

test('текущая строка не возвращается: ни её запись, ни её копия в архиве', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'ТЕКУЩАЯ' }) });
  line(db, 64, 51, 901, { doctor: 4, notes: signedNotes({ chief_complaint: 'Прежний приём' }) });
  db.prepare("INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, title, body, created_by) VALUES (61, 50, 1, 'protocol', 'Копия', ?, 3)")
    .run(JSON.stringify({ rich: 1, complaint: 'ТЕКУЩАЯ' }));
  const out = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 61 }, DOCTOR);
  assert.ok(!JSON.stringify(out).includes('ТЕКУЩАЯ'), 'текущая строка в списке');
  assert.deepEqual(out.groups.consult.map((d) => d.visit_service_id), [64]);
});

test('заключение визита — только если у визита нет документа строки (или это текущая строка)', () => {
  const db = seed();
  db.prepare("UPDATE visits SET conclusion = 'Заключение из кабинета', conclusion_type = 'consultation' WHERE id = 50").run();
  db.prepare("UPDATE visits SET conclusion = 'Ранее: <здоров>', conclusion_type = 'diagnostic' WHERE id = 51").run();
  line(db, 61, 50, 901, { notes: signedNotes({ conclusion_text: 'Заключение из кабинета' }) });
  line(db, 64, 51, 902);
  const out = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 61 }, DOCTOR);
  assert.ok(!JSON.stringify(out.groups.consult).includes('Заключение из кабинета'), 'заключение текущей строки вернулось заключением визита');
  const v = out.groups.diag.find((d) => d.source === 'visit');
  assert.ok(v, 'заключение визита без документов строк не показано');
  assert.equal(v.title, 'Заключение визита');
  assert.equal(v.sections[0].html, 'Ранее: &lt;здоров&gt;');
});

test('чужое здание не видно: визиты и строки соседнего здания (sync_origin) не возвращаются', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'СВОЁ' }) });
  line(db, 64, 51, 901, { notes: signedNotes({ chief_complaint: 'ФИЛИАЛ-СТРОКА' }) });
  db.prepare("UPDATE visit_services SET sync_origin = 'B' WHERE id = 64").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, conclusion, sync_origin) VALUES (52, 1, '2026-10-21T05:00:00Z', 'ФИЛИАЛ-ВИЗИТ', 'B')").run();
  const s = JSON.stringify(patientDocSources(db, { patient_id: 1 }, DOCTOR));
  assert.ok(s.includes('СВОЁ'));
  assert.ok(!s.includes('ФИЛИАЛ-СТРОКА') && !s.includes('ФИЛИАЛ-ВИЗИТ'), 'работа соседнего здания в списке');
});

test('права — как у карты пациента: без раздела «Пациенты» — 403; закрытая вкладка — группа null и названа в closed; закрыто всё — 403 с названием вкладки', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: 'Кашель' }) });
  assert.throws(() => patientDocSources(db, { patient_id: 1 }, { id: 11, role: 'inventory' }), (e) => e.status === 403);
  setTabs(db, 'doctor', { docs: 'none' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.consult, null);
  assert.equal(out.groups.diag, null);
  assert.equal(out.groups.files, null);
  assert.deepEqual([...out.closed].sort(), ['consult', 'diag', 'files']);
  assert.ok(Array.isArray(out.groups.labs), 'анализы — своя вкладка «Лаборатория», она открыта');
  setTabs(db, 'doctor', { docs: 'none', labs: 'none', history: 'none' });
  assert.throws(() => patientDocSources(db, { patient_id: 1 }, DOCTOR), (e) => e.status === 403 && e.params && e.params.tab === 'Документы');
  setTabs(db, 'doctor', {});
  assert.throws(() => patientDocSources(db, {}, DOCTOR), (e) => e.status === 400);
  assert.throws(() => patientDocSources(db, { patient_id: 999 }, DOCTOR), (e) => e.status === 404);
});

test('разметка очищена: script, обработчики, картинки и ссылки не проходят, текст остаётся', () => {
  const db = seed();
  line(db, 61, 50, 901, { notes: signedNotes({ chief_complaint: '<img src=x onerror="alert(1)">Боль<script>alert(2)</script>', hpi: '<a href="javascript:alert(3)">ссылка</a>' }) });
  const s = JSON.stringify(patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.consult);
  assert.ok(!/<script|onerror|javascript:|<img|<a /i.test(s), s);
  assert.ok(s.includes('Боль') && s.includes('ссылка'), s);
});

test('размер ограничен: limit документов на группу (не больше 100) с пометкой truncated; длинный раздел обрезан', () => {
  const db = seed();
  for (let i = 0; i < 5; i++) line(db, 70 + i, 50, 901, { notes: signedNotes({ chief_complaint: 'Приём ' + i }) });
  const out = patientDocSources(db, { patient_id: 1, limit: 2 }, DOCTOR);
  assert.equal(out.groups.consult.length, 2);
  assert.equal(out.truncated.consult, true);
  assert.equal(out.truncated.diag, false);
  assert.equal(patientDocSources(db, { patient_id: 1, limit: 5000 }, DOCTOR).groups.consult.length, 5, 'предел выше 100 — не ошибка, а 100');
  line(db, 80, 51, 901, { notes: signedNotes({ hpi: 'x'.repeat(SECTION_MAX + 50) }) });
  const big = patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.consult.find((d) => d.visit_service_id === 80);
  assert.ok(big.sections[0].html.length <= SECTION_MAX + 1, 'раздел не обрезан: ' + big.sections[0].html.length);
});

test('RPC зарегистрирован, при просроченной лицензии читается (READ_ONLY_RPCS)', () => {
  assert.equal(typeof getRpc('patient_doc_sources'), 'function');
  assert.equal(isReadOnlyRpc('patient_doc_sources'), true);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js`
  Ожидается FAIL: `ERR_MODULE_NOT_FOUND` (`Cannot find module '…/server/services/rpc/patient-doc-sources.js'`).

- [ ] **Step 3: implement**

  (а) `server/services/rpc/patient-card.js`. Было:
```js
    throw new RpcError('Раздел «Пациенты» вашей роли не выдан.', 403);
  }
  return roles;
}
```
  Стало:
```js
    throw new RpcError('Раздел «Пациенты» вашей роли не выдан.', 403);
  }
  return roles;
}

/**
 * PASTE_SOURCES_V1 — та же дверь для «Вставить результаты» кабинета врача
 * (rpc/patient-doc-sources.js): раздел «Пациенты» и уровни вкладок карты.
 * Окно вставки показывает ровно то, что этой роли показала бы карта.
 */
export function patientCardAccess(db, user) {
  const roles = requireCard(db, user);
  const tabs = {};
  for (const t of PATIENT_CARD_TABS) tabs[t] = patientTabLevel(db, user, t);
  return { roles, tabs };
}
```

  (б) Создать `server/services/rpc/patient-doc-sources.js`:

```js
// PASTE_SOURCES_V1 (2026-11-02) — «ВСТАВИТЬ РЕЗУЛЬТАТЫ» КАБИНЕТА ВРАЧА: ВСЕ
// ДОКУМЕНТЫ ПАЦИЕНТА ОДНОЙ ВЫБОРКОЙ (rpc patient_doc_sources).
//
// Владелец (выпуск 3.21.0): вставить в документ приёма можно было только
// сводку «Осмотр / Диагноз / Рекомендации» ЗАВЕРШЁННЫХ строк, а строки
// раскладывались по регулярке имени вида услуги. На тестовой клинике вся
// диагностика и лаборатория попадали в «Услуги», где вставка выключена;
// анализы в 'resulted' (введены, не проверены) пропадали; архив документов
// (visit_documents), заключение визита (visits.conclusion) и документы
// стационара не читались вовсе.
//
// ЧТО ОТДАЁТ. Пять групп — вкладки окна (views/paste-sources.js):
//   consult   — протоколы приёма: подписанная запись строки (visit_services.notes,
//               то же правило, что у карты пациента, — lastSignedEntry) или её
//               копия в архиве (visit_documents 'protocol'; копия выигрывает, как
//               в карте); заключение визита — если у визита нет документа строки;
//   diag      — заключения диагностики (вид 'diag', строки imaging/radiology) с
//               «Измерениями» — показателями, внесёнными к исследованию;
//   labs      — анализы по визитам; 'resulted' — с пометкой unverified;
//   inpatient — опубликованные и не исправленные записи истории болезни;
//   files     — загруженные файлы: название и путь, содержимого нет.
// Раздел документа — { key, label, html }: ПОЛНЫЙ текст. Оформление врача —
// разметкой, очищенной общим санитайзером (shared/rich-text.js), простой текст —
// экранированным: «SpO2 <95%» не тег и не «&amp;lt;».
//
// РАСКЛАДКА — ПО services.type (CHECK миграций 022/023, пустым не бывает), не по
// имени вида услуги: справочник «Типы услуг» у клиник пуст или назван по-своему.
// Отдел услуги (departments.kind) — запасной путь, после типа.
//
// ПРАВА — КАК У КАРТЫ ПАЦИЕНТА (rpc/patient-card.js): раздел «Пациенты», вкладки
// «Документы» (протоколы, диагностика, файлы), «Лаборатория» (анализы), «История»
// (стационар) и реестр таблиц. Закрытая группа приходит null и названа в
// `closed`; закрыто всё — отказ, который называет вкладку.
//
// ЗДАНИЕ — СВОЁ. Визиты и строки соседнего здания (sync_origin) не берутся:
// кабинет врача — работа своего здания (BRANCH_ORIGIN_V1, решение владельца
// 2026-09-02). Всю историю с метками филиалов показывает карта пациента.
//
// ТЕКУЩАЯ СТРОКА (exclude_visit_service_id) не возвращается: вставлять документ
// в самого себя незачем.
//
// РАЗМЕР ОГРАНИЧЕН: строк пациента — LINE_LIMIT, документов в группе — limit
// (40, не больше 100), раздел — SECTION_MAX знаков, весь ответ — BUDGET знаков
// разметки; обрезанная группа помечена в `truncated`. Изображения снимков
// диагностики (base64 в теле архива) не отдаются никогда.
//
// ТОЛЬКО ЧТЕНИЕ: ничего не пишет (READ_ONLY_RPCS в control/gate.js).
import { RpcError } from './crm-config.js';
import { patientCardAccess, DENIED_TEMPLATE, TAB_LABELS } from './patient-card.js';
import { canRead } from '../../db/schema-registry.js';
import { hasColumn } from '../domain/buildings.js';
import { richForSheet, notesDocData, lastSignedEntry } from '../../../public/js/shared/cabinet-doc.js';
import { hasMarkup, htmlToText, textIsBlank } from '../../../public/js/shared/rich-text.js';

/** Группы ответа — те же вкладки, что у окна (views/paste-sources.js PASTE_TABS). */
export const PASTE_GROUPS = Object.freeze(['consult', 'diag', 'labs', 'inpatient', 'files']);

/** Сколько последних строк пациента (копий архива, визитов с заключением) просматривается. */
const LINE_LIMIT = 300;
const DOC_LIMIT_DEFAULT = 40;
const DOC_LIMIT_MAX = 100;
/** Самый длинный раздел, знаков разметки: длиннее — текстом, с «…». */
export const SECTION_MAX = 20000;
/** Весь ответ, знаков разметки: дальше документы не добавляются (truncated). */
const BUDGET = 1500000;

const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
// Своё здание: строка заведена здесь. Колонки нет (база до 083) — все строки свои.
const ownWhere = (db, table, alias) => (hasColumn(db, table, 'sync_origin') ? ` AND ${alias}.sync_origin IS NULL` : '');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Простой текст → разметка: экранирование, строки — <br>. Длиннее предела — обрезка с «…». */
export function textHtml(v) {
  const t = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
  if (textIsBlank(t)) return '';
  const cut = t.length > SECTION_MAX ? t.slice(0, SECTION_MAX) + '…' : t;
  return escHtml(cut).replace(/\n/g, '<br>');
}

/**
 * Раздел записи → разметка вставки.
 * rich — значение может быть разметкой врача (запись кабинета, снимок с меткой
 * rich, документ стационара): через richForSheet оформление остаётся очищенной
 * разметкой, набранное без оформления — текстом. Не rich (снимок до
 * DOC_RICH_FORMAT_V1) — значение всегда текст: набранное «<b>» тегом не станет.
 */
export function sectionHtml(v, rich = true) {
  if (v == null || v === '') return '';
  if (!rich) return textHtml(v);
  const r = richForSheet(String(v));
  if (!r) return '';
  if (hasMarkup(r)) return r.length <= SECTION_MAX ? r : textHtml(htmlToText(r));
  return textHtml(r);
}

/** Рецепт — нумерованный список «название — доза, частота, длительность». */
function rxHtml(list) {
  const rows = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && String(r.name || '').trim());
  if (!rows.length) return '';
  return '<ol>' + rows.map((r) => {
    const tail = [r.dose, r.freq, r.dur, r.notes].map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(', ');
    return '<li><b>' + escHtml(String(r.name).trim()) + '</b>' + (tail ? ' — ' + escHtml(tail) : '') + '</li>';
  }).join('') + '</ol>';
}

function pushSection(out, key, label, html) { if (html) out.push({ key, label, html }); }

/** Разделы протокола приёма — снимок формы buildBlankData / notesDocData, порядок листа. */
export function protocolSections(b, rich) {
  const d = b || {};
  const out = [];
  pushSection(out, 'complaint', 'Жалобы', sectionHtml(d.complaint, rich));
  pushSection(out, 'hpi', 'Анамнез', sectionHtml(d.hpi, rich));
  pushSection(out, 'exam', 'Осмотр', sectionHtml(d.exam, rich));
  pushSection(out, 'labs', 'Лабораторные исследования', sectionHtml(d.labs, rich));
  pushSection(out, 'instrumental', 'Инструментальные исследования', sectionHtml(d.instrumental, rich));
  pushSection(out, 'dx', 'Диагноз', textHtml(d.dx || [d.dxAuto, d.dxText].filter(Boolean).join('\n')));
  pushSection(out, 'therapy', 'Терапия', sectionHtml(d.therapy, rich));
  pushSection(out, 'recs', 'Рекомендации', sectionHtml(d.recsText, rich));
  pushSection(out, 'conclusion', 'Заключение', sectionHtml(d.conclusionText, rich));
  pushSection(out, 'rx', 'Рецепт', rxHtml(d.prescriptions));
  return out;
}

/** Разделы заключения диагностики — снимок формы diagDocData (изображения не берутся). */
export function diagSections(b, rich) {
  const d = b || {};
  const out = [];
  pushSection(out, 'description', 'Описание', sectionHtml(d.description, rich));
  pushSection(out, 'conclusion', 'Заключение', textHtml(d.conclusion || [d.conclusionAuto, d.conclusionBody].filter(Boolean).join('\n')));
  pushSection(out, 'rx', 'Рецепт', rxHtml(d.prescriptions));
  return out;
}

/**
 * Вкладка строки. Сначала services.type (и is_lab — ему верит лаборатория),
 * потом отдел услуги: консультация, заведённая в отделе диагностики (ЭКГ),
 * — «Диагностика», как было у DEPT_KIND_ROUTING_V1.
 */
export function lineKind({ type = '', is_lab = 0, dept_kind = '' } = {}) {
  const t = String(type || '').toLowerCase();
  if (t === 'lab' || Number(is_lab) === 1) return 'labs';
  if (t === 'imaging' || t === 'radiology') return 'diag';
  if (dept_kind === 'diagnostics') return 'diag';
  if (dept_kind === 'laboratory') return 'labs';
  return 'consult';
}

// Поля, которые бывают только у приёма (savedDocType кабинета, CONSULT_ONLY_FIELDS).
const CONSULT_ONLY = Object.freeze(['chief_complaint', 'hpi', 'physical_exam', 'therapy_text', 'recommendations_text', 'conclusion_text']);
/** Подписанная запись — бланк «Диагностика»? Сохранённый тип, иначе — по строке и полям. */
function signedIsDiag(payload, fields, kind) {
  if (payload.docType === 'diag') return true;
  if (payload.docType === 'conclusion') return false;
  if (kind !== 'diag') return false;
  return !CONSULT_ONLY.some((k) => !textIsBlank(htmlToText(String(fields[k] == null ? '' : fields[k]))));
}

function parseBody(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** Новые первыми; при равной дате — больший id первым (порядок стабилен). */
function byAtDesc(a, b) {
  const x = String(a.at || ''), y = String(b.at || '');
  if (x !== y) return x < y ? 1 : -1;
  const i = String(a.id), j = String(b.id);
  return i === j ? 0 : (i < j ? 1 : -1);
}

/** Сколько документ весит в ответе (знаки разметки и показателей). */
function docSize(doc) {
  let n = 200;
  for (const s of doc.sections || []) n += String(s.html || '').length + String(s.label || '').length;
  for (const p of doc.panels || []) {
    for (const r of p.rows || []) n += 60 + String(r.parameter || '').length + String(r.value || '').length + String(r.reference_range || '').length;
  }
  return n;
}

/**
 * Документы пациента для «Вставить результаты».
 * args: { patient_id, exclude_visit_service_id?, limit? }
 * → { patient_id, groups: { consult, diag, labs, inpatient, files } (закрытая — null), closed, truncated }
 */
export function patientDocSources(db, args, user) {
  const { roles, tabs } = patientCardAccess(db, user);
  const pid = posInt(args && args.patient_id);
  if (!pid) throw new RpcError('Не указан пациент.', 400);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(pid)) throw new RpcError('Пациент не найден.', 404);
  const exclude = posInt(args && args.exclude_visit_service_id);
  const limit = Math.min(posInt(args && args.limit) || DOC_LIMIT_DEFAULT, DOC_LIMIT_MAX);

  const lineRead = canRead('visits', roles) && canRead('visit_services', roles);
  const docsOpen = tabs.docs !== 'none';
  const open = {
    consult: docsOpen && lineRead,
    diag: docsOpen && lineRead,
    labs: tabs.labs !== 'none' && lineRead && canRead('lab_results', roles),
    inpatient: tabs.history !== 'none' && canRead('admission_reviews', roles),
    files: docsOpen && canRead('visit_documents', roles),
  };
  const closed = PASTE_GROUPS.filter((g) => !open[g]);
  if (closed.length === PASTE_GROUPS.length) {
    // Тот же отказ, что у вкладки карты: шаблон + название вкладки в params.
    const e = new RpcError(DENIED_TEMPLATE, 403);
    e.params = { tab: TAB_LABELS.docs };
    throw e;
  }

  const found = { consult: [], diag: [], labs: [], inpatient: [], files: [] };
  const lines = open.consult || open.labs ? loadLines(db, pid) : [];
  if (open.consult) collectTextDocs(db, pid, lines, exclude, canRead('visit_documents', roles), found);

  const groups = {};
  const truncated = {};
  let budget = BUDGET;
  for (const g of PASTE_GROUPS) {
    if (!open[g]) { groups[g] = null; truncated[g] = false; continue; }
    const all = found[g].sort(byAtDesc);
    const kept = [];
    for (const doc of all) {
      if (kept.length >= limit) break;
      const size = docSize(doc);
      if (size > budget) break;
      budget -= size;
      kept.push(doc);
    }
    groups[g] = kept;
    truncated[g] = kept.length < all.length;
  }
  return { patient_id: pid, groups, closed, truncated };
}

/** Строки визитов пациента (услуги, не товары) своего здания, новые первыми. */
function loadLines(db, pid) {
  return db.prepare(`
    SELECT vs.id, vs.visit_id, vs.status, vs.notes, vs.verified_at, vs.created_at,
           v.visit_date,
           COALESCE(s.name, '') AS name, COALESCE(s.type, '') AS type, COALESCE(s.is_lab, 0) AS is_lab,
           COALESCE(dp.kind, '') AS dept_kind,
           du.full_name AS doctor_name
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments dp ON dp.id = s.department_id
      LEFT JOIN users du ON du.id = vs.doctor_id
     WHERE v.patient_id = ? AND vs.clinic_item_id IS NULL${ownWhere(db, 'visits', 'v')}${ownWhere(db, 'visit_services', 'vs')}
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT ?`).all(pid, LINE_LIMIT);
}

/** Протоколы и заключения: копии архива, подписанные записи строк, заключения визитов. */
function collectTextDocs(db, pid, lines, exclude, archiveRead, found) {
  const docVisits = new Set();       // визиты, у строк которых есть документ (и у текущей)
  const archivedLines = new Set();   // строки с копией в архиве — их запись не задваивается

  // 1. Архив: копия подписанного документа — то, что карта пациента печатает.
  if (archiveRead) {
    const rows = db.prepare(`
      SELECT d.id, d.visit_service_id, COALESCE(d.visit_id, vs.visit_id) AS visit_id, d.doc_type, d.title, d.body, d.created_at,
             u.full_name AS created_by_name,
             COALESCE(s.name, '') AS name, COALESCE(s.type, '') AS type, COALESCE(s.is_lab, 0) AS is_lab,
             COALESCE(dp.kind, '') AS dept_kind
        FROM visit_documents d
        LEFT JOIN users u ON u.id = d.created_by
        LEFT JOIN visit_services vs ON vs.id = d.visit_service_id
        LEFT JOIN services s ON s.id = vs.service_id
        LEFT JOIN departments dp ON dp.id = s.department_id
       WHERE d.patient_id = ? AND d.voided_at IS NULL AND d.doc_type IN ('protocol', 'diag')
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ?`).all(pid, LINE_LIMIT);
    const seen = new Set();
    for (const r of rows) {
      if (r.visit_service_id != null) archivedLines.add(r.visit_service_id);
      if (r.visit_id != null) docVisits.add(r.visit_id);
      if (exclude && r.visit_service_id === exclude) continue;
      // До V3120_FIX у строки могло остаться несколько копий одного вида — берётся новейшая.
      const key = (r.visit_service_id == null ? 'd' + r.id : 'l' + r.visit_service_id) + ':' + r.doc_type;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = parseBody(r.body);
      if (!body) continue;
      const isDiag = r.doc_type === 'diag';
      const sections = isDiag ? diagSections(body, !!body.rich) : protocolSections(body, !!body.rich);
      if (!sections.length) continue;
      const tab = isDiag || lineKind(r) === 'diag' ? 'diag' : 'consult';
      found[tab].push({
        id: 'doc:' + r.id, kind: tab, source: 'archive',
        visit_service_id: r.visit_service_id == null ? null : r.visit_service_id,
        title: r.name || String(body.service || '') || String(r.title || ''),
        doctor: String(body.doctorName || '') || r.created_by_name || '',
        at: r.created_at, sections,
      });
    }
  }

  // 2. Подписанная запись строки без копии в архиве (WS_DERIVED_DOCS_V1 карты).
  for (const l of lines) {
    const got = lastSignedEntry(l.notes);
    if (!got) continue;
    docVisits.add(l.visit_id);
    if (archivedLines.has(l.id) || (exclude && l.id === exclude)) continue;
    const { entry, payload } = got;
    const fields = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
    const data = notesDocData(fields, {
      diagnoses: Array.isArray(payload.diagnoses) ? payload.diagnoses : [],
      prescriptions: Array.isArray(payload.prescriptions) ? payload.prescriptions : [],
    });
    const kind = lineKind(l);
    const isDiag = signedIsDiag(payload, fields, kind);
    const sections = isDiag
      ? diagSections({ description: data.instrumental, conclusion: data.dx, prescriptions: data.prescriptions }, true)
      : protocolSections(data, true);
    if (!sections.length) continue;
    const tab = isDiag || kind === 'diag' ? 'diag' : 'consult';
    found[tab].push({
      id: 'line:' + l.id, kind: tab, source: 'notes', visit_service_id: l.id,
      title: l.name, doctor: l.doctor_name || String(entry.byName || ''),
      at: entry.savedAt || l.created_at, sections,
    });
  }

  // 3. Заключение визита — только у визита без документов строк: кабинет пишет
  //    туда текст своего же «Заключения» (WS_CONCLUSION_V1), второй раз его не показываем.
  const visits = db.prepare(`
    SELECT v.id, v.visit_date, v.conclusion, v.conclusion_type, du.full_name AS doctor_name
      FROM visits v
      LEFT JOIN users du ON du.id = v.doctor_id
     WHERE v.patient_id = ? AND TRIM(COALESCE(v.conclusion, '')) <> ''${ownWhere(db, 'visits', 'v')}
     ORDER BY v.visit_date DESC, v.id DESC
     LIMIT ?`).all(pid, LINE_LIMIT);
  for (const v of visits) {
    if (docVisits.has(v.id)) continue;
    const html = textHtml(v.conclusion);
    if (!html) continue;
    const tab = v.conclusion_type === 'diagnostic' ? 'diag' : 'consult';
    found[tab].push({
      id: 'visit:' + v.id, kind: tab, source: 'visit', visit_service_id: null,
      title: 'Заключение визита', doctor: v.doctor_name || '',
      at: v.visit_date, sections: [{ key: 'conclusion', label: 'Заключение', html }],
    });
  }
}
```

  (в) `server/services/rpc/index.js`, импорт. Было:
```js
import { visitDocumentArchive } from './patient-card.js';   // V3120_FIX (F2) — подпись протокола отзывает прежний, а не стирает
```
  Стало:
```js
import { visitDocumentArchive } from './patient-card.js';   // V3120_FIX (F2) — подпись протокола отзывает прежний, а не стирает
import { patientDocSources } from './patient-doc-sources.js';   // PASTE_SOURCES_V1 — «Вставить результаты» кабинета: все документы пациента
```
  Там же, карта RPC. Было:
```js
  visit_document_archive:   (db, args, user) => visitDocumentArchive(db, args, user),   // V3120_FIX (F2)
```
  Стало:
```js
  visit_document_archive:   (db, args, user) => visitDocumentArchive(db, args, user),   // V3120_FIX (F2)
  patient_doc_sources:      (db, args, user) => patientDocSources(db, args, user),   // PASTE_SOURCES_V1 — «Вставить результаты»: документы пациента по вкладкам
```

  (г) `server/services/control/gate.js`, `READ_ONLY_RPCS`. Было (строка встречается один раз):
```js
  'patient_card',
```
  Стало:
```js
  'patient_card',
  // PASTE_SOURCES_V1 — «Вставить результаты» кабинета врача: документы пациента
  // для вставки. Чистое чтение, как карта пациента строкой выше: заблокированная
  // клиника читает свои записи, а сама вставка — правка документа, и подпись её
  // всё равно не пропустит.
  'patient_doc_sources',
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js server/services/rpc/patient-card.test.js`
  Ожидается PASS (все тесты обоих файлов).

- [ ] **Step 5: commit** — `.git/U3_MSG.txt`:
```
«Вставить результаты»: сервер отдаёт все документы пациента — протоколы и диагностику (PASTE_SOURCES_V1)

Новый RPC patient_doc_sources (только чтение): подписанные записи строк и их копии в
архиве (копия выигрывает, как в карте пациента), заключения диагностики, заключение
визита без документов строк. Раздел — полный текст: оформление врача очищенной
разметкой, простой текст экранирован; диагноз — код подписанной записи. Раскладка по
services.type (отдел — запасной путь). Текущая строка не возвращается, работа соседнего
здания не видна, права — как у карты пациента (patientCardAccess), размер ограничен.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --name-only
git add server/services/rpc/patient-doc-sources.js server/services/rpc/patient-doc-sources.test.js server/services/rpc/patient-card.js server/services/rpc/index.js server/services/control/gate.js
git commit -F .git/U3_MSG.txt
```

---

### Task U3.3: сервер — анализы по визитам («не проверено») и «Измерения» исследований

**Files:**
- Modify: `server/services/rpc/patient-doc-sources.js`
- Test: `server/services/rpc/patient-doc-sources.test.js` (дописать)

- [ ] **Step 1: failing test** — в `server/services/rpc/patient-doc-sources.test.js` после последнего теста (его конец:
```js
test('RPC зарегистрирован, при просроченной лицензии читается (READ_ONLY_RPCS)', () => {
  assert.equal(typeof getRpc('patient_doc_sources'), 'function');
  assert.equal(isReadOnlyRpc('patient_doc_sources'), true);
});
```
) дописать:

```js

const result = (db, vs, parameter, value, { unit = '', ref = '', flag = 'normal' } = {}) =>
  db.prepare('INSERT INTO lab_results (visit_service_id, parameter, value, unit, reference_range, flag, entered_by) VALUES (?,?,?,?,?,?,3)')
    .run(vs, parameter, value, unit, ref, flag);

test('анализы — по визитам: «resulted» в списке с пометкой, проверенный — без; без показателей и отменённый — нет; повторный ввод показателя заменяет прежний', () => {
  const db = seed();
  line(db, 63, 50, 903, { status: 'resulted' });
  line(db, 65, 51, 903, { status: 'completed', verified: '2026-10-20T09:00:00Z' });
  line(db, 66, 51, 903, { status: 'queued' });
  line(db, 67, 51, 903, { status: 'cancelled' });
  result(db, 63, 'HGB', '96', { unit: 'г/л', ref: '120–160', flag: 'low' });
  result(db, 63, 'WBC', '14.2', { flag: 'high' });
  result(db, 63, 'HGB', '101', { unit: 'г/л', ref: '120–160', flag: 'low' });
  result(db, 65, 'PLT', '250');
  result(db, 67, 'ОТМЕНЁН', '1');
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const byVisit = Object.fromEntries(out.groups.labs.map((d) => [d.visit_id, d]));
  assert.deepEqual(Object.keys(byVisit).sort(), ['50', '51']);
  assert.equal(byVisit[50].unverified, true, '«resulted» без пометки «не проверено»');
  assert.deepEqual(byVisit[50].panels.map((p) => [p.visit_service_id, p.title, p.unverified]), [[63, 'Общий анализ крови', true]]);
  assert.deepEqual(byVisit[50].panels[0].rows.map((r) => [r.parameter, r.value, r.flag]), [['WBC', '14.2', 'high'], ['HGB', '101', 'low']]);
  assert.equal(byVisit[51].unverified, false);
  assert.deepEqual(byVisit[51].panels.map((p) => p.visit_service_id), [65], 'анализ без показателей или отменённый — в списке');
  assert.ok(!JSON.stringify(out).includes('ОТМЕНЁН'));
  assert.equal(out.groups.consult.length + out.groups.diag.length, 0, 'анализ ушёл не в свою вкладку');
  const ex = patientDocSources(db, { patient_id: 1, exclude_visit_service_id: 63 }, DOCTOR);
  assert.deepEqual(ex.groups.labs.map((d) => d.visit_id), [51], 'текущая строка-анализ вернулась');
});

test('измерения исследования (показатели у УЗИ/ЭхоКГ) — раздел «Измерения» его заключения в «Диагностике», не в «Анализах»', () => {
  const db = seed();
  line(db, 68, 50, 904, { notes: signedNotes({ instrumental_text: 'Камеры не расширены', primary_diagnosis: 'Норма' }, { docType: 'diag' }) });
  result(db, 68, 'ФВ', '62', { unit: '%', ref: '55–70' });
  line(db, 69, 51, 904);
  result(db, 69, 'КДР', '6.1', { unit: 'см', ref: '3.7–5.6', flag: 'high' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  assert.equal(out.groups.labs.length, 0);
  const d68 = out.groups.diag.find((d) => d.visit_service_id === 68);
  assert.deepEqual(d68.sections.map((s) => s.label), ['Описание', 'Заключение', 'Измерения']);
  assert.match(d68.sections[2].html, /^<table class="a4-restbl">.*<td>ФВ<\/td><td>62 %<\/td><td>55–70<\/td>/);
  const d69 = out.groups.diag.find((d) => d.visit_service_id === 69);
  assert.deepEqual(d69.sections.map((s) => s.key), ['measurements']);
  assert.match(d69.sections[0].html, /<b>6\.1 см<\/b>/, 'отклонение от нормы не выделено');
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js`
  Ожидается FAIL в двух новых тестах: `Expected values to be strictly deep-equal: [] … ['50', '51']` и `Cannot read properties of undefined (reading 'sections')` (у ЭхоКГ без записи документа нет).

- [ ] **Step 3: implement** — `server/services/rpc/patient-doc-sources.js`.

  (а) Было:
```js
  if (open.consult) collectTextDocs(db, pid, lines, exclude, canRead('visit_documents', roles), found);
```
  Стало:
```js
  if (open.consult) collectTextDocs(db, pid, lines, exclude, canRead('visit_documents', roles), found);
  if (open.labs) collectLabs(db, lines, exclude, found);   // PASTE_SOURCES_V1 — анализы по визитам, «Измерения» исследований
```

  (б) Конец `collectTextDocs`. Было:
```js
      at: v.visit_date, sections: [{ key: 'conclusion', label: 'Заключение', html }],
    });
  }
}
```
  Стало:
```js
      at: v.visit_date, sections: [{ key: 'conclusion', label: 'Заключение', html }],
    });
  }
}

/** Показателей у одного анализа — не больше (панель — не архив). */
const LAB_ROWS_MAX = 200;
const FLAGGED = new Set(['high', 'low', 'critical', 'abnormal']);

/**
 * Показатели строк. Повторный ввод того же показателя ЗАМЕНЯЕТ прежний, разные
 * показатели панели живут все — правило архива и панели истории болезни
 * (case-doc-sources.js).
 */
function latestResults(db, ids) {
  const by = new Map();
  if (!ids.length) return by;
  const rows = db.prepare(`
    SELECT id, visit_service_id, parameter, value, unit, reference_range, flag
      FROM lab_results
     WHERE visit_service_id IN (${ids.map(() => '?').join(',')})
     ORDER BY id`).all(...ids);
  const latest = new Map();
  for (const r of rows) latest.set(JSON.stringify([r.visit_service_id, String(r.parameter || '')]), r);
  for (const r of [...latest.values()].sort((x, y) => x.id - y.id)) {
    if (!by.has(r.visit_service_id)) by.set(r.visit_service_id, []);
    const list = by.get(r.visit_service_id);
    if (list.length < LAB_ROWS_MAX) list.push({
      parameter: String(r.parameter || ''), value: r.value == null ? '' : String(r.value),
      unit: String(r.unit || ''), reference_range: String(r.reference_range || ''), flag: String(r.flag || ''),
    });
  }
  return by;
}

/** Таблица показателей для документа (подписи — бланк, по-русски); отклонение — жирным. */
export function resultsTableHtml(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map((r) => {
    const v = escHtml(r.value) + (r.unit ? ' ' + escHtml(r.unit) : '');
    return '<tr><td>' + escHtml(r.parameter) + '</td><td>' + (FLAGGED.has(String(r.flag).toLowerCase()) ? '<b>' + v + '</b>' : v)
      + '</td><td>' + escHtml(r.reference_range) + '</td></tr>';
  }).join('');
  return '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead><tbody>' + body + '</tbody></table>';
}

/**
 * Анализы — ДОКУМЕНТОМ НА ВИЗИТ (как «Результаты анализов» карты,
 * LAB_DOC_ONE_PER_VISIT_V1), панель — анализ. Введено, но не проверено
 * ('resulted' без verified_at) — в списке, с пометкой unverified: врач видит
 * результат и знает, что лаборатория его ещё не подтвердила. Показатели,
 * внесённые к исследованию (ЭхоКГ, УЗИ с размерами), — раздел «Измерения» его
 * заключения во вкладке «Диагностика».
 */
function collectLabs(db, lines, exclude, found) {
  const pick = lines.filter((l) => l.status !== 'cancelled' && !(exclude && l.id === exclude) && lineKind(l) !== 'consult');
  const results = latestResults(db, pick.map((l) => l.id));
  const byVisit = new Map();
  for (const l of pick) {
    const rows = results.get(l.id);
    if (!rows || !rows.length) continue;
    if (lineKind(l) === 'labs') {
      let doc = byVisit.get(l.visit_id);
      if (!doc) {
        doc = {
          id: 'labs:' + l.visit_id, kind: 'labs', source: 'lab', visit_id: l.visit_id, visit_service_id: null,
          title: 'Результаты анализов', doctor: '', at: l.visit_date, unverified: false, panels: [],
        };
        byVisit.set(l.visit_id, doc);
        found.labs.push(doc);
      }
      const unverified = l.status !== 'completed' && !l.verified_at;
      doc.panels.push({ visit_service_id: l.id, title: l.name, unverified, rows });
      if (unverified) doc.unverified = true;
      continue;
    }
    const section = { key: 'measurements', label: 'Измерения', html: resultsTableHtml(rows) };
    const doc = found.diag.find((d) => d.visit_service_id === l.id);
    if (doc) doc.sections.push(section);
    else found.diag.push({
      id: 'line:' + l.id, kind: 'diag', source: 'lab', visit_service_id: l.id,
      title: l.name, doctor: l.doctor_name || '', at: l.verified_at || l.visit_date, sections: [section],
    });
  }
  for (const doc of byVisit.values()) doc.panels.sort((a, b) => a.visit_service_id - b.visit_service_id);
}
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — `.git/U3_MSG.txt`:
```
«Вставить результаты»: анализы по визитам с пометкой «не проверено», «Измерения» исследований (PASTE_SOURCES_V1)

Анализы приходят документом на визит (панель — анализ, повторный ввод показателя
заменяет прежний). Введённый, но не проверенный анализ ('resulted') больше не пропадает —
он в списке с пометкой. Показатели у УЗИ/ЭхоКГ — раздел «Измерения» заключения во
вкладке «Диагностика». Отменённые и анализы без показателей не показываются.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --name-only
git add server/services/rpc/patient-doc-sources.js server/services/rpc/patient-doc-sources.test.js
git commit -F .git/U3_MSG.txt
```

---

### Task U3.4: сервер — документы стационара и загруженные файлы

**Files:**
- Modify: `server/services/rpc/patient-doc-sources.js`, `server/services/rpc/patient-card.js` (`function fileOnThisMachine`, `:133`)
- Test: `server/services/rpc/patient-doc-sources.test.js` (импорты и два теста)

- [ ] **Step 1: failing test**

  (а) Импорты теста. Было:
```js
import { isReadOnlyRpc } from '../control/gate.js';
```
  Стало:
```js
import { isReadOnlyRpc } from '../control/gate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir } from '../control/config.js';
```

  (б) После теста «измерения исследования …» (его конец:
```js
  assert.match(d69.sections[0].html, /<b>6\.1 см<\/b>/, 'отклонение от нормы не выделено');
});
```
) дописать:

```js

test('стационар: опубликованные и не исправленные записи — разделами (свои подписи, свои разделы); черновик и исправленная — нет; «История» закрыта — null', () => {
  const db = seed();
  db.prepare("INSERT INTO admissions (id, patient_id, status, admission_no, admitted_at) VALUES (10, 1, 'active', 'A-26-0001', '2026-10-05T06:00:00Z')").run();
  db.prepare("INSERT INTO case_doc_types (kind, title, due_rule, sort_order) VALUES ('own_cardio', 'Осмотр кардиолога', 'none', 200)").run();
  const rev = (kind, c = {}) => db.prepare(`INSERT INTO admission_reviews
      (admission_id, kind, type_kind, complaints, objective, diagnosis, plan, body, author_id, published_at, superseded_by, sections_json)
      VALUES (10, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?)`).run(kind, c.typeKind || null, c.complaints || '', c.objective || '', c.diagnosis || '',
    c.plan || '', c.body || '', c.published === undefined ? '2026-10-06T08:00:00Z' : c.published, c.superseded || null, c.sections || null).lastInsertRowid;
  const primary = rev('primary', {
    complaints: '<p>Боль в животе</p>', objective: 'Живот напряжён', diagnosis: 'K35.8 Острый аппендицит', plan: '<ul><li>Операция</li></ul>',
    sections: JSON.stringify({ titles: { objective: 'Статус' }, extra: [{ title: 'Осмотр хирурга', html: '<p>Симптом Щёткина +</p>' }] }),
  });
  rev('primary', { complaints: 'ИСПРАВЛЕННАЯ', superseded: primary });
  rev('round', { complaints: 'ЧЕРНОВИК-СТАЦИОНАРА', published: null });
  rev('other', { typeKind: 'own_cardio', objective: 'Ритм синусовый' });
  const out = patientDocSources(db, { patient_id: 1 }, DOCTOR);
  const byKind = Object.fromEntries(out.groups.inpatient.map((d) => [d.doc_kind, d]));
  assert.deepEqual(Object.keys(byKind).sort(), ['own_cardio', 'primary']);
  const p = byKind.primary;
  assert.equal(p.title, '', 'у встроенного рода имя — на экране (CASE_DOC_TITLE), не с сервера');
  assert.equal(p.admission_no, 'A-26-0001');
  assert.equal(p.doctor, 'Врач Тестов');
  assert.deepEqual(p.sections.map((s) => s.label), ['Жалобы', 'Статус', 'Диагноз', 'План обследования и лечения', 'Осмотр хирурга']);
  assert.equal(p.sections[3].html, '<ul><li>Операция</li></ul>');
  assert.equal(byKind.own_cardio.title, 'Осмотр кардиолога', 'свой род клиники — своим именем');
  const s = JSON.stringify(out);
  assert.ok(!s.includes('ИСПРАВЛЕННАЯ') && !s.includes('ЧЕРНОВИК-СТАЦИОНАРА'), 'исправленная запись или черновик в списке');
  setTabs(db, 'doctor', { history: 'none' });
  assert.equal(patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.inpatient, null);
});

test('файлы: название и путь без содержимого; отозванный — нет; «лежит ли на этом компьютере» — как в карте пациента', () => {
  const db = seed();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-paste-'));
  setDataDir(dir);
  try {
    const docs = path.join(dir, 'storage', 'clinic-docs', 'patients', '1', 'docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'k1-scan.pdf'), 'x');
    const file = (title, name, voided = null) => db.prepare(`INSERT INTO visit_documents (patient_id, title, file_name, file_path, doc_type, created_by, voided_at)
        VALUES (1, ?, ?, ?, 'upload', 3, ?)`).run(title, name, 'patients/1/docs/' + name, voided);
    file('Направление', 'k1-scan.pdf');
    file('Снимок', 'k2-missing.jpg');
    file('ОТОЗВАН', 'k3.pdf', '2026-10-02T00:00:00Z');
    const files = patientDocSources(db, { patient_id: 1 }, DOCTOR).groups.files;
    assert.deepEqual(files.map((f) => [f.title, f.file_available]).sort(), [['Направление', true], ['Снимок', false]]);
    assert.ok(files.every((f) => !f.sections && f.file_path.startsWith('patients/1/docs/')), 'у файла есть содержимое или чужой путь');
  } finally {
    setDataDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js`
  Ожидается FAIL в двух новых тестах: `Expected values to be strictly deep-equal: [] … ['own_cardio', 'primary']` и `[] … [['Направление', true], ['Снимок', false]]`.

- [ ] **Step 3: implement**

  (а) `server/services/rpc/patient-card.js`. Было:
```js
function fileOnThisMachine(filePath) {
```
  Стало:
```js
export function fileOnThisMachine(filePath) {   // PASTE_SOURCES_V1 — и для вкладки «Файлы» окна вставки
```

  (б) `server/services/rpc/patient-doc-sources.js`, импорты. Было:
```js
import { patientCardAccess, DENIED_TEMPLATE, TAB_LABELS } from './patient-card.js';
```
  Стало:
```js
import { patientCardAccess, fileOnThisMachine, DENIED_TEMPLATE, TAB_LABELS } from './patient-card.js';
```
  Было:
```js
import { hasMarkup, htmlToText, textIsBlank } from '../../../public/js/shared/rich-text.js';
```
  Стало:
```js
import { hasMarkup, htmlToText, textIsBlank } from '../../../public/js/shared/rich-text.js';
import { loadCaseDocTitles, reviewSections } from './inpatient-reviews.js';   // PASTE_SOURCES_V1 — имена своих родов и свои разделы записи
```

  (в) Было:
```js
  if (open.labs) collectLabs(db, lines, exclude, found);   // PASTE_SOURCES_V1 — анализы по визитам, «Измерения» исследований
```
  Стало:
```js
  if (open.labs) collectLabs(db, lines, exclude, found);   // PASTE_SOURCES_V1 — анализы по визитам, «Измерения» исследований
  if (open.inpatient) collectInpatient(db, pid, found);
  if (open.files) collectFiles(db, pid, found);
```

  (г) Конец `collectLabs`. Было:
```js
  for (const doc of byVisit.values()) doc.panels.sort((a, b) => a.visit_service_id - b.visit_service_id);
}
```
  Стало:
```js
  for (const doc of byVisit.values()) doc.panels.sort((a, b) => a.visit_service_id - b.visit_service_id);
}

const REVIEW_KEYS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);
// Подписи разделов — те же, что у листа истории болезни (views/case-doc-a4.js LABEL / BODY_LABEL).
const REVIEW_LABEL = Object.freeze({
  complaints: 'Жалобы', objective: 'Объективно', diagnosis: 'Диагноз', plan: 'План обследования и лечения', body: 'Дополнительно',
});
const REVIEW_BODY_LABEL = Object.freeze({ operation: 'Протокол операции', consent: 'Текст документа', other: 'Текст документа', rationale: 'Обоснование' });

/**
 * Документы истории болезни пациента: ОПУБЛИКОВАННЫЕ и не исправленные
 * (superseded_by IS NULL — исправление закрывает прежнюю запись). Черновик —
 * не документ. Имя рода: у своего рода клиники — её название
 * (case_doc_types.title), у встроенного — пусто, его называет окно словарём
 * истории болезни (views/case-docs.js CASE_DOC_TITLE) на языке экрана.
 * Диагноз записи хранится простым текстом, остальные разделы — разметкой.
 */
function collectInpatient(db, pid, found) {
  const titles = loadCaseDocTitles(db);
  const rows = db.prepare(`
    SELECT r.id, r.kind, r.type_kind, r.complaints, r.objective, r.diagnosis, r.plan, r.body, r.sections_json,
           r.published_at, r.entry_date, u.full_name AS author_name, a.admission_no
      FROM admission_reviews r
      JOIN admissions a ON a.id = r.admission_id
      LEFT JOIN users u ON u.id = r.author_id
     WHERE a.patient_id = ? AND r.published_at IS NOT NULL AND r.superseded_by IS NULL
     ORDER BY COALESCE(r.entry_date, r.published_at) DESC, r.id DESC
     LIMIT ?`).all(pid, LINE_LIMIT);
  for (const r of rows) {
    const kind = r.type_kind || r.kind;
    const secs = reviewSections(r);
    const own = secs.titles && typeof secs.titles === 'object' ? secs.titles : {};
    const out = [];
    for (const key of REVIEW_KEYS) {
      const label = String(own[key] || (key === 'body' && REVIEW_BODY_LABEL[kind]) || REVIEW_LABEL[key]);
      pushSection(out, key, label, key === 'diagnosis' ? textHtml(r.diagnosis) : sectionHtml(r[key], true));
    }
    (Array.isArray(secs.extra) ? secs.extra : []).forEach((x, i) => {
      if (!x || typeof x !== 'object') return;
      pushSection(out, 'extra' + i, String(x.title || '').trim() || 'Раздел', sectionHtml(x.html, true));
    });
    if (!out.length) continue;
    found.inpatient.push({
      id: 'review:' + r.id, kind: 'inpatient', source: 'review', visit_service_id: null,
      doc_kind: kind, title: String(titles.get(kind) || ''), doctor: r.author_name || '',
      admission_no: r.admission_no || null, at: r.entry_date || r.published_at, sections: out,
    });
  }
}

/** Файлов в ответе — не больше (их содержимое не читается никогда). */
const FILE_LIMIT = 100;

/**
 * Загруженные файлы пациента: только название, путь и «лежит ли на этом
 * компьютере» (тем же правилом, что карта пациента, — fileOnThisMachine).
 * Отозванный документ не показывается. Вставлять нечего — окно его открывает.
 */
function collectFiles(db, pid, found) {
  const rows = db.prepare(`
    SELECT d.id, d.title, d.file_name, d.file_path, d.created_at, u.full_name AS created_by_name
      FROM visit_documents d
      LEFT JOIN users u ON u.id = d.created_by
     WHERE d.patient_id = ? AND d.voided_at IS NULL AND COALESCE(d.file_path, '') <> ''
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ?`).all(pid, FILE_LIMIT);
  for (const r of rows) {
    found.files.push({
      id: 'file:' + r.id, kind: 'files', source: 'file', document_id: r.id, visit_service_id: null,
      title: r.title || r.file_name || '', file_name: r.file_name || '', file_path: r.file_path,
      file_available: fileOnThisMachine(r.file_path), doctor: r.created_by_name || '', at: r.created_at,
    });
  }
}
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js server/services/rpc/patient-card.test.js server/services/rpc/case-doc-sources.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — `.git/U3_MSG.txt`:
```
«Вставить результаты»: документы стационара и загруженные файлы (PASTE_SOURCES_V1)

Стационар — опубликованные и не исправленные записи истории болезни разделами (свои
подписи и свои разделы документа; имя своего рода — с сервера, встроенного — словарём
экрана). Файлы — название, путь и «лежит ли на этом компьютере», без содержимого;
отозванные не показываются. fileOnThisMachine карты пациента экспортирован.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --name-only
git add server/services/rpc/patient-doc-sources.js server/services/rpc/patient-doc-sources.test.js server/services/rpc/patient-card.js
git commit -F .git/U3_MSG.txt
```

---

### Task U3.5: окно «Вставить результаты» — `views/paste-sources.js` и тексты ru/uz/en

**Files:**
- Create: `public/js/admin/views/paste-sources.js`, `public/js/admin/__tests__/paste-sources.test.mjs`
- Modify: `public/js/admin/i18n-strings.js` (сразу после `export const STRINGS = {`)

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/paste-sources.test.mjs`:

```js
// PASTE_SOURCES_V1 (2026-11-02) — окно «Вставить результаты» кабинета врача
// (views/paste-sources.js): пять вкладок, разделы с галочками, ПОЛНЫЙ текст
// отмеченного, «не проверено» у анализа, закрытая вкладка объяснена словами,
// файлы только открываются. Сервер подменён: проверяется окно, не выборка.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import { installFakeDom, TOASTS } from './cabinet-harness.mjs';

installFakeDom();

const RPC_LOG = [];
let REPLY = null;   // { ok, status, payload } — ответ patient_doc_sources
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        RPC_LOG.push({ name, body });
        if (name === 'patient_doc_sources' && REPLY) return resp(REPLY.ok, REPLY.status, REPLY.payload);
        return resp(true, 200, { data: null });
    }
    return resp(true, 200, { data: null });
};

const PS = await import('../views/paste-sources.js');
const answer = (data) => { REPLY = { ok: true, status: 200, payload: { data } }; };
const tabBtn = (m, key) => m.overlay.querySelector('[data-paste-tab="' + key + '"]');

const FIXTURE = () => ({
    patient_id: 7,
    closed: ['files'],
    truncated: { consult: false, diag: false, labs: true, inpatient: false, files: false },
    groups: {
        consult: [{
            id: 'line:61', kind: 'consult', source: 'notes', visit_service_id: 61,
            title: 'Приём терапевта', doctor: 'Врач Тестов', at: '2026-10-05T07:00:00.000Z',
            sections: [
                { key: 'complaint', label: 'Жалобы', html: 'Кашель <b>3 дня</b>' },
                { key: 'hpi', label: 'Анамнез', html: 'Болеет неделю' },
                { key: 'therapy', label: 'Терапия', html: '<ul><li>Покой</li></ul><script>alert(1)</script>' },
            ],
        }],
        diag: [],
        labs: [{
            id: 'labs:50', kind: 'labs', source: 'lab', visit_id: 50, visit_service_id: null,
            title: 'Результаты анализов', doctor: '', at: '2026-10-05T05:00:00Z', unverified: true,
            panels: [
                { visit_service_id: 63, title: 'Общий анализ крови', unverified: true, rows: [
                    { parameter: 'HGB', value: '96', unit: 'г/л', reference_range: '120–160', flag: 'low' },
                    { parameter: 'WBC', value: '7.1', unit: '10⁹/л', reference_range: '4–9', flag: 'normal' },
                ] },
                { visit_service_id: 64, title: 'Глюкоза', unverified: false, rows: [
                    { parameter: 'GLU', value: '5.1', unit: 'ммоль/л', reference_range: '3.9–6.1', flag: 'normal' },
                ] },
            ],
        }],
        inpatient: [{
            id: 'review:5', kind: 'inpatient', source: 'review', visit_service_id: null,
            doc_kind: 'primary', title: '', doctor: 'Врач Тестов', admission_no: 'A-1', at: '2026-10-06T08:00:00Z',
            sections: [{ key: 'complaints', label: 'Жалобы', html: '<p>Боль в животе</p>' }],
        }],
        files: null,
    },
});

test('docInsertHtml: заголовок и ПОЛНЫЙ текст отмеченных разделов, разметка очищена; ничего не отмечено — пусто', () => {
    const doc = FIXTURE().groups.consult[0];
    const html = PS.docInsertHtml(doc, ['complaint', 'therapy']);
    assert.ok(html.startsWith('<div><b>Приём терапевта</b> — ' + PS.docDay(doc.at) + ', Врач Тестов</div>'), html);
    assert.ok(html.includes('<div><b>Жалобы:</b></div>Кашель <b>3 дня</b>'), html);
    assert.ok(html.includes('<div><b>Терапия:</b></div><ul><li>Покой</li></ul>'), html);
    assert.ok(!html.includes('Болеет неделю'), 'неотмеченный раздел вставлен');
    assert.ok(!/<script|alert/i.test(html), 'разметка не очищена: ' + html);
    assert.equal(PS.docInsertHtml(doc, []), '');
});

test('labInsertHtml: по таблице на анализ, только отмеченные показатели, отклонение — жирным, непроверенный подписан в документе', () => {
    const doc = FIXTURE().groups.labs[0];
    const html = PS.labInsertHtml(doc, ['0:0', '1:0']);
    assert.ok(html.startsWith('<div><b>Результаты анализов</b> — ' + PS.docDay(doc.at) + '</div>'), html);
    assert.ok(html.includes('<div><b>Общий анализ крови (не проверено)</b></div><table class="a4-restbl">'), html);
    assert.ok(html.includes('<td>HGB</td><td><b>96 г/л</b></td><td>120–160</td>'), html);
    assert.ok(!html.includes('WBC'), 'неотмеченный показатель вставлен');
    assert.ok(html.includes('<div><b>Глюкоза</b></div>'), html);
    assert.equal(PS.labInsertHtml(doc, ['0:1']).includes('Глюкоза'), false, 'анализ без отмеченных показателей вставлен');
    assert.equal(PS.labInsertHtml(doc, []), '');
});

test('docDay — местный день «дд.мм.гггг», дата без времени — тот же день; docTitle — имя рода стационара', () => {
    assert.equal(PS.docDay('2026-10-06'), '06.10.2026');
    const d = new Date('2026-10-05T07:00:00.000Z');
    const p2 = (n) => String(n).padStart(2, '0');
    assert.equal(PS.docDay('2026-10-05T07:00:00.000Z'), p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear());
    assert.equal(PS.docDay(''), '');
    assert.equal(PS.docTitle({ kind: 'inpatient', doc_kind: 'primary', title: '' }), 'Первичный осмотр и план лечения');
    assert.equal(PS.docTitle({ kind: 'inpatient', doc_kind: 'own_cardio', title: 'Осмотр кардиолога' }), 'Осмотр кардиолога');
    assert.equal(PS.docTitle({ kind: 'consult', title: 'Приём терапевта' }), 'Приём терапевта');
});

test('окно: спрашивает сервер про пациента без текущей строки; пять вкладок; снятый раздел не вставляется; поле по умолчанию — от вкладки; ничего не отмечено — отказ словами', async () => {
    answer(FIXTURE()); RPC_LOG.length = 0;
    const calls = [];
    const m = PS.openPasteSourcesModal({ patientId: 7, excludeVisitServiceId: 61, onInsert: (html, field) => calls.push({ html, field }) });
    await m.ready;
    assert.deepEqual(RPC_LOG.filter((c) => c.name === 'patient_doc_sources').map((c) => c.body), [{ patient_id: 7, exclude_visit_service_id: 61 }]);
    assert.deepEqual(m.overlay.querySelectorAll('[data-paste-tab]').map((t) => t.getAttribute('data-paste-tab')), ['consult', 'diag', 'labs', 'inpatient', 'files']);
    const card = m.overlay.querySelector('[data-paste-doc="line:61"]');
    assert.ok(card, 'документа консультации нет');
    card.querySelector('[data-paste-sec="hpi"]').dispatch('change');
    card.querySelector('[data-paste-insert="line:61"]').dispatch('click');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].field, 'physical_exam');
    assert.ok(calls[0].html.includes('<b>Жалобы:</b>') && calls[0].html.includes('<b>Терапия:</b>') && !calls[0].html.includes('Анамнез'), calls[0].html);
    for (const k of ['complaint', 'therapy']) card.querySelector('[data-paste-sec="' + k + '"]').dispatch('change');
    TOASTS.length = 0;
    card.querySelector('[data-paste-insert="line:61"]').dispatch('click');
    assert.equal(calls.length, 1, 'пустая вставка ушла в документ');
    assert.ok(TOASTS.includes('Выберите хотя бы один раздел'), TOASTS.join(' | '));
    m.close();
});

test('окно: анализы — «не проверено», обрезанная группа названа, вставка в «Лабораторные»; стационар — имя рода и № госпитализации; пустая и закрытая вкладки — словами', async () => {
    answer(FIXTURE());
    const calls = [];
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: (html, field) => calls.push({ html, field }) });
    await m.ready;
    tabBtn(m, 'labs').dispatch('click');
    const lab = m.overlay.querySelector('[data-paste-doc="labs:50"]');
    assert.ok(lab && lab.textContent.includes('не проверено'), 'нет пометки «не проверено»');
    assert.ok(m.overlay.textContent.includes('Показаны последние 1. Остальные — в карте пациента.'), 'обрезанная группа не названа');
    lab.querySelector('[data-paste-row="0:1"]').dispatch('change');
    lab.querySelector('[data-paste-insert="labs:50"]').dispatch('click');
    assert.equal(calls.at(-1).field, 'labs_text');
    assert.ok(calls.at(-1).html.includes('HGB') && !calls.at(-1).html.includes('WBC'), calls.at(-1).html);
    tabBtn(m, 'inpatient').dispatch('click');
    const rev = m.overlay.querySelector('[data-paste-doc="review:5"]');
    assert.ok(rev.textContent.includes('Первичный осмотр и план лечения') && rev.textContent.includes('Госпитализация № A-1'), rev.textContent);
    rev.querySelector('[data-paste-insert="review:5"]').dispatch('click');
    assert.equal(calls.at(-1).field, 'hpi');
    assert.ok(calls.at(-1).html.startsWith('<div><b>Первичный осмотр и план лечения</b>'), calls.at(-1).html);
    tabBtn(m, 'diag').dispatch('click');
    assert.ok(m.overlay.textContent.includes('Документов этого вида у пациента пока нет.'));
    tabBtn(m, 'files').dispatch('click');
    assert.ok(m.overlay.textContent.includes('Этот раздел закрыт для вашей роли.'));
    m.close();
});

test('окно: сервер отказал — причина словами (шаблон, потом значения), а не пустой список', async () => {
    REPLY = { ok: false, status: 403, payload: { error: { code: 'forbidden',
        message: 'Вкладка «{tab}» закрыта для вашей роли. Доступ открывает администратор клиники: «Настройки» → «Роли» → «Карта пациента — вкладки».',
        params: { tab: 'Документы' } } } };
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: () => {} });
    await m.ready;
    assert.ok(m.overlay.textContent.includes('Не удалось загрузить документы пациента: Вкладка «Документы» закрыта для вашей роли.'), m.overlay.textContent);
    m.close();
});

test('файлы: только «Открыть», без вставки; файла нет на этом компьютере — так и сказано', async () => {
    const data = FIXTURE();
    data.closed = [];
    data.groups.files = [{ id: 'file:9', kind: 'files', source: 'file', document_id: 9, visit_service_id: null, title: 'Направление', file_name: 'k1.pdf',
        file_path: 'patients/7/docs/k1.pdf', file_available: false, doctor: 'Регистратор', at: '2026-10-05T07:00:00Z' }];
    answer(data);
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: () => { throw new Error('файл не вставляется'); } });
    await m.ready;
    tabBtn(m, 'files').dispatch('click');
    const row = m.overlay.querySelector('[data-paste-doc="file:9"]');
    assert.ok(row && row.textContent.includes('Направление'));
    assert.equal(row.querySelector('[data-paste-insert="file:9"]'), null, 'у файла есть «Вставить»');
    TOASTS.length = 0;
    row.querySelector('[data-paste-open="file:9"]').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(TOASTS.some((t) => t.startsWith('Файл лежит на том компьютере, где его загрузили')), TOASTS.join(' | '));
    m.close();
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/paste-sources.test.mjs`
  Ожидается FAIL: `ERR_MODULE_NOT_FOUND` (`Cannot find module '…/public/js/admin/views/paste-sources.js'`).

- [ ] **Step 3: implement**

  (а) Создать `public/js/admin/views/paste-sources.js`:

```js
// PASTE_SOURCES_V1 (2026-11-02) — «ВСТАВИТЬ РЕЗУЛЬТАТЫ» КАБИНЕТА ВРАЧА: ОКНО.
//
// Владелец (выпуск 3.21.0): вставить в документ приёма можно было только
// сводку «Осмотр / Диагноз / Рекомендации» завершённых строк, разложенных по
// имени вида услуги. На тестовой клинике диагностика и анализы лежали в
// «Услугах», где вставка выключена; анализ в 'resulted' пропадал; архив
// документов, заключение визита и документы стационара не читались.
//
// Теперь окно спрашивает сервер (rpc patient_doc_sources) и показывает ВСЕ
// документы пациента пятью вкладками: «Консультации», «Диагностика»,
// «Анализы», «Стационар», «Файлы». У документа — разделы с галочками; в
// документ приёма уходит ПОЛНЫЙ текст отмеченных разделов, в поле, которое
// врач выберет («Куда вставить?» кабинета — onInsert). Файлы только
// открываются: их содержимого в ответе нет.
//
// У окна нет состояния между открытиями: каждый раз — свежий ответ сервера,
// и поздний ответ одной строки не попадёт в другую (прежняя «история» жила в
// состоянии кабинета — CABINET_FIX_V1_R2, п. 4).
//
// Разметка разделов приходит очищенной с сервера и ещё раз проходит общий
// санитайзер здесь (shared/rich-text.js): второй проход её не меняет, а
// разметка, пришедшая мимо сервера, в документ не попадёт.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { sanitizeStoredHtml, htmlToText } from '../../shared/rich-text.js';
import { BRANCH_BUCKET, signedUrl } from '../storage.js?v=aurora20b';   // тот же адрес, что у кабинета и карты (один экземпляр)
import { CASE_DOC_TITLE } from './case-docs.js?v=cw1';   // имена родов истории болезни — тот же словарь, что у стационара

/** Вкладки окна — группы ответа сервера; field — поле «рекомендуется» в «Куда вставить?». */
export const PASTE_TABS = Object.freeze([
    { key: 'consult',   label: 'Консультации', icon: 'Stethoscope', field: 'physical_exam' },
    { key: 'diag',      label: 'Диагностика',  icon: 'Activity',    field: 'instrumental_text' },
    { key: 'labs',      label: 'Анализы',      icon: 'Flask',       field: 'labs_text' },
    { key: 'inpatient', label: 'Стационар',    icon: 'Bed',         field: 'hpi' },
    { key: 'files',     label: 'Файлы',        icon: 'Folder',      field: null },
]);

const FLAGGED = new Set(['high', 'low', 'critical', 'abnormal']);
const PREVIEW_MAX = 400;
const pad2 = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Данные пациента (текст разделов, имена, даты) — узлом текста, мимо словаря.
const txt = (s) => document.createTextNode(String(s == null ? '' : s));

/** День документа для текста вставки — местный, «дд.мм.гггг» (документ — по-русски). */
export function docDay(iso) {
    if (!iso) return '';
    const s = String(iso);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s);
    return isNaN(d.getTime()) ? '' : pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
}

/** Название документа. У записи стационара встроенного рода сервер имени не шлёт — оно в словаре истории болезни. */
export function docTitle(doc) {
    if (!doc) return '';
    if (doc.kind === 'inpatient') return String(doc.title || '').trim() || CASE_DOC_TITLE[doc.doc_kind] || CASE_DOC_TITLE.other;
    return String(doc.title || '');
}

function headHtml(doc) {
    const meta = [docDay(doc.at), doc.doctor].filter(Boolean).join(', ');
    return '<div><b>' + esc(docTitle(doc)) + '</b>' + (meta ? ' — ' + esc(meta) : '') + '</div>';
}

/**
 * Вставка текстового документа: заголовок («Название — дд.мм.гггг, врач») и
 * отмеченные разделы ЦЕЛИКОМ. Ничего не отмечено — ''.
 */
export function docInsertHtml(doc, keys) {
    const want = new Set(keys || []);
    const parts = ((doc && doc.sections) || []).filter((s) => want.has(s.key))
        .map((s) => '<div><b>' + esc(s.label) + ':</b></div>' + sanitizeStoredHtml(s.html));
    return parts.length ? headHtml(doc) + parts.join('') : '';
}

/**
 * Вставка анализов визита: заголовок и по таблице на каждый анализ с
 * отмеченными показателями (ключ «анализ:показатель», '0:1'). Отклонение от
 * нормы — жирным; непроверенный анализ так и подписан в документе.
 */
/* i18n-exempt-start: таблица и пометка «(не проверено)» вставляются В ДОКУМЕНТ приёма — содержимое бланка, не текст экрана */
export function labInsertHtml(doc, keys) {
    const want = new Set(keys || []);
    const blocks = ((doc && doc.panels) || []).map((p, pi) => {
        const rows = (p.rows || []).filter((_, ri) => want.has(pi + ':' + ri));
        if (!rows.length) return '';
        const body = rows.map((r) => {
            const v = esc(r.value) + (r.unit ? ' ' + esc(r.unit) : '');
            return '<tr><td>' + esc(r.parameter) + '</td><td>' + (FLAGGED.has(String(r.flag || '').toLowerCase()) ? '<b>' + v + '</b>' : v)
                + '</td><td>' + esc(r.reference_range || '') + '</td></tr>';
        }).join('');
        return '<div><b>' + esc(p.title || '') + (p.unverified ? ' (не проверено)' : '') + '</b></div>'
            + '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead><tbody>' + body + '</tbody></table>';
    }).filter(Boolean);
    return blocks.length ? headHtml(doc) + blocks.join('') : '';
}
/* i18n-exempt-end */

/** Документы пациента для окна. → { data, error } — ответ rpc patient_doc_sources. */
export function loadPasteSources(patientId, excludeVisitServiceId = null) {
    return supabase.rpc('patient_doc_sources', { patient_id: patientId, exclude_visit_service_id: excludeVisitServiceId || null });
}

// I18N_COVERAGE_V1 — отказ сервера: сначала шаблон, потом значения (как rpcMsg карты пациента).
function errorText(error) {
    if (!error) return tr('нет ответа');
    const params = {};
    for (const [k, v] of Object.entries(error.params || {})) params[k] = typeof v === 'string' ? tr(v) : v;
    return trf(error.message || 'нет ответа', params);
}

function preview(html) {
    const t = htmlToText(sanitizeStoredHtml(html));
    return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + '…' : t;
}

function note(text, color = null) {
    return h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px', ...(color ? { color } : {}) } }, text);
}

function metaLine(doc) {
    const bits = [doc.at ? fmtDate(doc.at) : '', doc.doctor || ''];
    if (doc.admission_no) bits.push(trf('Госпитализация № {no}', { no: doc.admission_no }));
    return bits.filter(Boolean).join(' · ');
}

// Галочка: в браузере — её состояние, в стенде без DOM — переключение.
function toggleOn(e, chosen, key) {
    const t = e && e.currentTarget;
    return t && typeof t.checked === 'boolean' ? t.checked : !chosen.has(key);
}

function docHead(doc) {
    return [
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('b', { style: { fontSize: '13.5px' } }, docTitle(doc) || '—'),
            doc.unverified ? Tag('не проверено', { kind: 'warn', dot: true }) : null),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '2px 0 6px' } }, txt(metaLine(doc))),
    ];
}

function insertButton(doc, onClick) {
    return h('div', { style: { marginTop: '8px' } },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-paste-insert': doc.id, onclick: onClick },
            Icon('Plus', { size: 13 }), ' ', 'Вставить выбранное'));
}

function docCard(doc, tab, onInsert) {
    const chosen = new Set((doc.sections || []).map((s) => s.key));
    const secs = (doc.sections || []).map((s) => {
        const cb = h('input', { type: 'checkbox', checked: true, 'data-paste-sec': s.key });
        cb.addEventListener('change', (e) => { if (toggleOn(e, chosen, s.key)) chosen.add(s.key); else chosen.delete(s.key); });
        return h('label', { style: { display: 'block', padding: '6px 0', cursor: 'pointer' } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600, fontSize: '12.5px' } }, cb, s.label),
            h('div', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'pre-wrap', margin: '2px 0 0 24px', lineHeight: '1.45' } }, txt(preview(s.html))));
    });
    return h('div', { 'data-paste-doc': doc.id, style: { padding: '12px 16px', borderTop: '1px solid var(--ink-100)' } },
        ...docHead(doc), ...secs,
        insertButton(doc, () => {
            const html = docInsertHtml(doc, [...chosen]);
            if (!html) { toast('Выберите хотя бы один раздел', 'warn'); return; }
            if (onInsert) onInsert(html, tab.field);
        }));
}

function labCard(doc, tab, onInsert) {
    const chosen = new Set();
    const blocks = (doc.panels || []).map((p, pi) => {
        const tbody = h('tbody');
        (p.rows || []).forEach((r, ri) => {
            const key = pi + ':' + ri;
            chosen.add(key);
            const cb = h('input', { type: 'checkbox', checked: true, 'data-paste-row': key });
            cb.addEventListener('change', (e) => { if (toggleOn(e, chosen, key)) chosen.add(key); else chosen.delete(key); });
            const flagged = FLAGGED.has(String(r.flag || '').toLowerCase());
            tbody.appendChild(h('tr', null,
                h('td', { style: { width: '28px' } }, cb),
                h('td', null, txt(r.parameter)),
                h('td', { style: flagged ? { fontWeight: '700', color: 'var(--crit-700)' } : {} },
                    txt(String(r.value == null ? '' : r.value) + (r.unit ? ' ' + r.unit : ''))),
                h('td', { class: 'muted' }, txt(r.reference_range || '—'))));
        });
        return h('div', { 'data-paste-panel': String(p.visit_service_id), style: { marginTop: '8px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600, fontSize: '12.5px' } },
                txt(p.title || ''), p.unverified ? Tag('не проверено', { kind: 'warn', dot: true }) : null),
            h('table', { class: 'tbl', style: { fontSize: '12.5px', marginTop: '4px' } },
                h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Показатель'), h('th', null, 'Результат'), h('th', null, 'Норма'))),
                tbody));
    });
    return h('div', { 'data-paste-doc': doc.id, style: { padding: '12px 16px', borderTop: '1px solid var(--ink-100)' } },
        ...docHead(doc), ...blocks,
        insertButton(doc, () => {
            const html = labInsertHtml(doc, [...chosen]);
            if (!html) { toast('Выберите хотя бы один показатель', 'warn'); return; }
            if (onInsert) onInsert(html, tab.field);
        }));
}

function fileRow(doc) {
    const open = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-paste-open': doc.id, onclick: async () => {
        // Файлы не ездят между зданиями — та же правда, что у карты пациента.
        if (doc.file_available === false) {
            toast('Файл лежит на том компьютере, где его загрузили, — на этом его нет. Откройте карту в том здании или восстановите из резервной копии.', 'fail');
            return;
        }
        const url = await signedUrl(BRANCH_BUCKET, doc.file_path);
        if (url) window.open(url, '_blank'); else toast('Файл недоступен.', 'fail');
    } }, Icon('Link', { size: 13 }), ' ', 'Открыть');
    return h('div', { 'data-paste-doc': doc.id, style: { padding: '10px 16px', borderTop: '1px solid var(--ink-100)', display: 'flex', alignItems: 'center', gap: '10px' } },
        Icon('Doc', { size: 14 }),
        h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { fontWeight: 600, fontSize: '13.5px', wordBreak: 'break-word' } }, txt(doc.title || doc.file_name || '—')),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, txt(metaLine(doc)))),
        open);
}

/**
 * Окно «Вставить результаты».
 * @param {{patientId:number, excludeVisitServiceId?:number|null,
 *          onInsert:(html:string, field:string|null) => void}} opts
 * @returns {{overlay: Node, close: () => void, ready: Promise<void>}} ready — для проверки
 */
export function openPasteSourcesModal({ patientId, excludeVisitServiceId = null, onInsert = null } = {}) {
    const state = { tab: PASTE_TABS[0].key, data: null, error: null };
    const overlay = h('div', { class: 'modal', 'data-paste-sources': '', style: { zIndex: '140' } });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    const tabsEl = h('div', { class: 'segmented', role: 'tablist', style: { margin: '12px 14px 0', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' } });
    const body = h('div', { class: 'modal-body', 'data-paste-body': '', style: { padding: '0', maxHeight: '62vh', overflowY: 'auto' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card', role: 'dialog', 'aria-label': 'Вставить результаты', style: { width: '720px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Doc', { size: 16 }), ' ', 'Вставить результаты',
                h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: '400', marginLeft: '8px' } }, 'отметьте разделы и нажмите «Вставить выбранное»')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        tabsEl, body));
    document.body.appendChild(overlay);

    // null — вкладка закрыта для роли; нет ключа или не массив — пусто.
    const groupOf = (key) => {
        const g = state.data && state.data.groups ? state.data.groups[key] : undefined;
        if (g === null) return null;
        return Array.isArray(g) ? g : [];
    };
    function paintTabs() {
        clear(tabsEl);
        for (const t of PASTE_TABS) {
            const list = state.data ? groupOf(t.key) : [];
            const n = Array.isArray(list) ? list.length : 0;
            const on = t.key === state.tab;
            tabsEl.appendChild(h('button', {
                type: 'button', role: 'tab', 'data-paste-tab': t.key, class: on ? 'on' : '', 'aria-selected': on ? 'true' : 'false',
                onclick: () => { state.tab = t.key; paintTabs(); paintBody(); },
            }, Icon(t.icon, { size: 13 }), ' ', t.label, n ? h('span', { class: 'num', style: { marginLeft: '6px', fontWeight: 700 } }, String(n)) : null));
        }
    }
    function paintBody() {
        clear(body);
        if (state.error) { body.appendChild(note(trf('Не удалось загрузить документы пациента: {msg}', { msg: state.error }), 'var(--crit-700)')); return; }
        if (!state.data) { body.appendChild(note('Загрузка…')); return; }
        const tab = PASTE_TABS.find((t) => t.key === state.tab) || PASTE_TABS[0];
        const list = groupOf(tab.key);
        if (list === null) { body.appendChild(note('Этот раздел закрыт для вашей роли.')); return; }
        if (!list.length) { body.appendChild(note('Документов этого вида у пациента пока нет.')); return; }
        for (const doc of list) {
            body.appendChild(tab.key === 'files' ? fileRow(doc) : tab.key === 'labs' ? labCard(doc, tab, onInsert) : docCard(doc, tab, onInsert));
        }
        if (state.data.truncated && state.data.truncated[tab.key]) {
            body.appendChild(note(trf('Показаны последние {n}. Остальные — в карте пациента.', { n: list.length })));
        }
    }
    paintTabs();
    paintBody();
    const ready = Promise.resolve()
        .then(() => loadPasteSources(patientId, excludeVisitServiceId))
        .then((res) => {
            const { data, error } = res || {};
            if (error || !data) state.error = errorText(error);
            else state.data = data;
        })
        .catch((e) => { state.error = (e && e.message) || String(e); })
        .then(() => { paintTabs(); paintBody(); });
    return { overlay, close, ready };
}
```

  (б) `public/js/admin/i18n-strings.js`. Было (строка одна в файле):
```js
export const STRINGS = {
```
  Стало:
```js
export const STRINGS = {
  // PASTE_SOURCES_V1 — «Вставить результаты» кабинета врача: окно документов пациента (views/paste-sources.js, rpc patient_doc_sources)
  "Файлы": {"en":"Files","ru":"Файлы","uz":"Fayllar"},   // PASTE_SOURCES_V1
  "отметьте разделы и нажмите «Вставить выбранное»": {"en":"tick the sections and press “Insert selected”","ru":"отметьте разделы и нажмите «Вставить выбранное»","uz":"bo‘limlarni belgilang va «Tanlanganini qo‘yish» tugmasini bosing"},   // PASTE_SOURCES_V1
  "Вставить выбранное": {"en":"Insert selected","ru":"Вставить выбранное","uz":"Tanlanganini qo‘yish"},   // PASTE_SOURCES_V1
  "Выберите хотя бы один раздел": {"en":"Select at least one section","ru":"Выберите хотя бы один раздел","uz":"Kamida bitta bo‘limni tanlang"},   // PASTE_SOURCES_V1
  "не проверено": {"en":"not verified","ru":"не проверено","uz":"tekshirilmagan"},   // PASTE_SOURCES_V1
  "Не удалось загрузить документы пациента: {msg}": {"en":"Could not load the patient’s documents: {msg}","ru":"Не удалось загрузить документы пациента: {msg}","uz":"Bemor hujjatlarini yuklab bo‘lmadi: {msg}"},   // PASTE_SOURCES_V1
  "Этот раздел закрыт для вашей роли.": {"en":"This section is closed for your role.","ru":"Этот раздел закрыт для вашей роли.","uz":"Bu bo‘lim sizning rolingiz uchun yopiq."},   // PASTE_SOURCES_V1
  "Документов этого вида у пациента пока нет.": {"en":"The patient has no documents of this kind yet.","ru":"Документов этого вида у пациента пока нет.","uz":"Bemorda bu turdagi hujjatlar hozircha yo‘q."},   // PASTE_SOURCES_V1
  "Показаны последние {n}. Остальные — в карте пациента.": {"en":"Showing the latest {n}. The rest are in the patient card.","ru":"Показаны последние {n}. Остальные — в карте пациента.","uz":"Oxirgi {n} tasi ko‘rsatilgan. Qolganlari — bemor kartasida."},   // PASTE_SOURCES_V1
  "Госпитализация № {no}": {"en":"Admission No. {no}","ru":"Госпитализация № {no}","uz":"Yotqizish № {no}"},   // PASTE_SOURCES_V1
  "Заключение визита": {"en":"Visit conclusion","ru":"Заключение визита","uz":"Tashrif xulosasi"},   // PASTE_SOURCES_V1 — название документа от сервера (rpc patient_doc_sources)
```
  (Остальные слова окна уже в словаре: «Вставить результаты», «Консультации», «Диагностика», «Анализы», «Стационар», «Загрузка…», «Открыть», «Файл недоступен.», «Файл лежит на том компьютере…», «Выберите хотя бы один показатель», «нет ответа», «Показатель», «Результат», «Норма», подписи разделов «Жалобы»…«Рецепт», «Измерения», «Раздел», «Результаты анализов», имена родов истории болезни. Если перед этим другая задача уже добавила ключ с тем же текстом — свою строку не дублировать.)

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/paste-sources.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/icons.test.mjs public/js/admin/__tests__/rpc-exists.test.mjs server/services/rpc/client-rpc-coverage.test.js`
  Ожидается PASS.

- [ ] **Step 5: commit** — `.git/U3_MSG.txt`:
```
Окно «Вставить результаты»: пять вкладок, разделы с галочками, полный текст (PASTE_SOURCES_V1)

views/paste-sources.js — «Консультации», «Диагностика», «Анализы», «Стационар», «Файлы»
из rpc patient_doc_sources. У документа — разделы с галочками; вставляется полный текст
отмеченных разделов (разметка ещё раз через общий санитайзер); у анализа — показатели с
галочками, отклонения жирным, непроверенный подписан «(не проверено)». Закрытая для роли
вкладка, пустая вкладка и отказ сервера объяснены словами; файлы только открываются.
Тексты ru/uz/en.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --name-only
git add public/js/admin/views/paste-sources.js public/js/admin/__tests__/paste-sources.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/U3_MSG.txt
```

---

### Task U3.6: кабинет — «Вставить результаты» открывает новое окно; прежняя «Карта приёмов» и мёртвый `openStudyHistoryModal` удалены

**Files:**
- Modify: `public/js/admin/views/service-workspace.js` (импорт `:40`; запуск строки `:224-228`; окно `:327-358`; `emrTabBtn` `:637-650`; `emrBtn` `:953-956`; блок `:1717-2230`; `wsState` `:2248`; `freshLineState` `:2687`; `WS_PER_LINE` `:2740`; мастер направления `:5958`)
- Modify: `public/css/admin-views.css` (`:2255-2277`, `:2332-2333`)
- Modify: `public/js/admin/__tests__/cabinet-review-r2.test.mjs`, `public/js/admin/__tests__/cabinet-review-r3.test.mjs`, `public/js/admin/__tests__/cabinet-review-r4.test.mjs`, `public/js/admin/__tests__/doc-rich-format.test.mjs`
- Create: `public/js/admin/__tests__/paste-sources-cabinet.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/paste-sources-cabinet.test.mjs`:

```js
// PASTE_SOURCES_V1 (2026-11-02) — «Вставить результаты» в кабинете врача целиком:
// кнопка листа → окно документов пациента (без текущей строки) → «Куда
// вставить?» → полный текст отмеченных разделов в выбранном поле. И страж:
// прежняя «Карта приёмов» (loadPatientEmr / paintEmr / fillServiceConclusion …)
// и мёртвый openStudyHistoryModal не вернулись.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El } from './cabinet-harness.mjs';

installFakeDom();

const NOTES = new Map();
const RPC_LOG = [];
let SOURCES = null;
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        RPC_LOG.push({ name, body });
        if (name === 'patient_doc_sources') return ok(SOURCES);
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });

function cabinet(id, notes = notesOf(null)) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
        __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Терапевт' } } };
    NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.children = [];
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');   // бланк виден, как после setBlankMode в renderServiceWorkspace
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    return ctx;
}
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
const buttonByText = (root, t) => root.querySelectorAll('button').find((b) => String(b.textContent).includes(t));
const iframeBar = (ctx) => { const fr = ctx.container.querySelector('iframe'); const bar = fr && fr.contentDocument.body.querySelector('[data-ws-actions]'); return bar ? bar.querySelectorAll('button') : []; };

const FIXTURE = () => ({
    patient_id: 7, closed: [], truncated: { consult: false, diag: false, labs: false, inpatient: false, files: false },
    groups: {
        consult: [{ id: 'line:61', kind: 'consult', source: 'notes', visit_service_id: 61, title: 'Приём терапевта', doctor: 'Врач Тестов', at: '2026-10-05T07:00:00.000Z',
            sections: [{ key: 'complaint', label: 'Жалобы', html: 'Кашель <b>3 дня</b>' }, { key: 'hpi', label: 'Анамнез', html: 'Болеет неделю' }] }],
        diag: [], labs: [], inpatient: [], files: [],
    },
});

test('лист кабинета: «Вставить результаты» → окно этого пациента без текущей строки → «Куда вставить?» → полный текст отмеченных разделов в поле', async () => {
    SOURCES = FIXTURE(); RPC_LOG.length = 0;
    const ctx = cabinet(7);
    await WS.hydrateLine(ctx);
    const btn = iframeBar(ctx).find((b) => String(b.textContent).includes('Вставить результаты'));
    assert.ok(btn, 'на листе нет «Вставить результаты»');
    btn.dispatch('click');
    await tick(10);
    const call = RPC_LOG.find((c) => c.name === 'patient_doc_sources');
    assert.deepEqual(call && call.body, { patient_id: 7, exclude_visit_service_id: 7 }, 'окно спросило не того пациента или вернёт текущую строку');
    const modal = document.body.children.find((c) => c.hasAttribute && c.hasAttribute('data-paste-sources'));
    assert.ok(modal, 'окно не открылось');
    modal.querySelector('[data-paste-sec="hpi"]').dispatch('change');   // снять «Анамнез»
    modal.querySelector('[data-paste-insert="line:61"]').dispatch('click');
    const pick = document.body.children[document.body.children.length - 1];
    assert.ok(String(pick.textContent).includes('Куда вставить?'), 'нет выбора раздела');
    buttonByText(pick, 'Осмотр').dispatch('click');
    const exam = field(ctx, 'physical_exam').innerHTML;
    assert.ok(exam.includes('<div><b>Жалобы:</b></div>Кашель <b>3 дня</b>'), exam);
    assert.ok(!exam.includes('Болеет неделю'), 'снятый раздел вставлен');
    modal.remove();
});

test('страж: прежней «Карты приёмов» и мёртвого openStudyHistoryModal нет, стилей окна истории исследований тоже', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
    for (const name of ['openStudyHistoryModal', 'renderStudyPreview', 'loadPatientEmr', 'paintEmr', 'emrRow', 'emrTabBtn', 'openEmrResultModal', 'fillServiceConclusion', 'fillLabResults']) {
        assert.ok(!new RegExp('function ' + name + '\\b').test(src), name + ' остался');
    }
    assert.ok(!/data-emr-body|wsState\.emr\b|'emrFilter'|\bemr: null|const emrBtn/.test(src), 'состояние или кнопка прежней истории остались');
    assert.match(src, /openPasteSourcesModal\(\{/);
    const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
    assert.ok(!/\.st-(body|list|item|prev|tbl)\b/.test(css), 'стили удалённого окна истории остались');
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/paste-sources-cabinet.test.mjs`
  Ожидается FAIL: первый тест — `окно спросило не того пациента…` (вызова `patient_doc_sources` нет: кнопка открывает прежнюю «Карту приёмов»); второй — `openStudyHistoryModal остался`.

- [ ] **Step 3: implement**

  (а) `service-workspace.js`, импорт. Было:
```js
import { openVitalsDialog } from './patient-card.js?v=labshared1';   // CARD_SPEC_V1 — same URL as admin.js (one instance)
```
  Стало:
```js
import { openVitalsDialog } from './patient-card.js?v=labshared1';   // CARD_SPEC_V1 — same URL as admin.js (one instance)
import { openPasteSourcesModal } from './paste-sources.js';   // PASTE_SOURCES_V1 — «Вставить результаты»: все документы пациента
```

  (б) Большие блоки — скриптом. Инструментом Write создать в scratchpad-папке своей сессии `u3-cut-workspace.mjs`:

```js
// PASTE_SOURCES_V1 (план U3.6) — убрать прежнюю «Карту приёмов» из кабинета врача.
// Запуск из корня репозитория: node <путь к этому файлу>
import fs from 'node:fs';

const FILE = 'public/js/admin/views/service-workspace.js';
const src = fs.readFileSync(FILE, 'utf8');
if (src.includes('\r\n')) throw new Error('ожидались концы строк LF');
const lines = src.split('\n');

function only(pred, what) {
    const hits = [];
    lines.forEach((l, i) => { if (pred(l)) hits.push(i); });
    if (hits.length !== 1) throw new Error(what + ': найдено ' + hits.length + ' (нужно 1)');
    return hits[0];
}

// 1. История пациента и окно исследований (loadPatientEmr … fillLabResults):
//    от рамки «// ====» над «Patient EMR — …» до рамки над «Persistence — …» (рамку Persistence оставить).
const emrHead = only((l) => l.startsWith('// Patient EMR — every service the patient ever booked'), 'Patient EMR');
const persistHead = only((l) => l.startsWith('// Persistence — JSON blob inside visit_services.notes'), 'Persistence');
if (persistHead < emrHead || !lines[emrHead - 1].startsWith('// =====') || !lines[persistHead - 1].startsWith('// =====')) {
    throw new Error('рамки блоков не на месте');
}
lines.splice(emrHead - 1, (persistHead - 1) - (emrHead - 1),
    '// PASTE_SOURCES_V1 — история пациента для «Вставить результаты» — views/paste-sources.js и',
    '// rpc patient_doc_sources. Прежние loadPatientEmr / paintEmr / emrRow / openEmrResultModal /',
    '// fillServiceConclusion / fillLabResults и мёртвые openStudyHistoryModal / renderStudyPreview удалены.',
    '');

// 2. Вкладки прежнего окна (emrTabBtn) — функция и пустая строка после неё.
const tabHead = only((l) => l === 'function emrTabBtn(id, label) {', 'emrTabBtn');
let tabEnd = tabHead + 1;
while (tabEnd < lines.length && lines[tabEnd] !== '}') tabEnd++;
if (tabEnd - tabHead > 20) throw new Error('emrTabBtn длиннее ожидаемого');
lines.splice(tabHead, tabEnd - tabHead + 1 + (lines[tabEnd + 1] === '' ? 1 : 0));

// 3. Окно «Карта приёмов» → окно документов пациента (до function leftColumn).
const modalHead = only((l) => l.startsWith('// existing Patient EMR + Conditions cards'), 'комментарий окна');
const leftCol = only((l) => l === 'function leftColumn(ctx) {', 'leftColumn');
if (leftCol < modalHead) throw new Error('leftColumn выше окна');
const NEW_MODAL = `// Conditions card (PASTE_SOURCES_V1: the patient history moved to «Вставить результаты»).
// PASTE_SOURCES_V1 — «Вставить результаты»: окно со ВСЕМИ документами пациента
// (views/paste-sources.js, rpc patient_doc_sources) вместо прежней «Карты приёмов»:
// та брала только завершённые строки, раскладывала их по имени вида услуги и
// вставляла усечённую сводку. Текущая строка в окно не попадает; выбранное
// вставляется прежним путём — «Куда вставить?» (_pastePickField) → a4InsertHtml.
function openEmrModal(ctx) {
    const pid = ctx && ctx.patient && (ctx.patient.id || ctx.patient.patientId);
    if (!pid) { toast('Нет контекста пациента.', 'fail'); return; }
    openPasteSourcesModal({
        patientId: pid,
        excludeVisitServiceId: (ctx && ctx.visitServiceId) || null,
        onInsert: (html, field) => _pastePickField(ctx, html, field, 'Результат вставлен в документ'),
    });
}
`.split('\n');
lines.splice(modalHead, leftCol - modalHead, ...NEW_MODAL);

fs.writeFileSync(FILE, lines.join('\n'));
console.log('PASTE_SOURCES_V1: прежняя «Карта приёмов» удалена, окно заменено');
```
  Запуск: `node "<scratchpad>/u3-cut-workspace.mjs"` (из корня репозитория). Ожидается строка `PASTE_SOURCES_V1: прежняя «Карта приёмов» удалена, окно заменено`; любая ошибка `найдено N` — остановиться и найти блок по смыслу.

  (в) Запуск строки. Было:
```js
    // Async-load the full EMR for the patient (services + labs + diagnostics
    // across all visits) and paint it into the left-column EMR card.
    wsState.emr = null;
    wsState.emrFilter = 'all';
    loadPatientEmr(p, ctx).then(() => { if (wsState.ctx === ctx) paintEmr(); });   // CABINET_FIX_V1_R2 — только своей строке
```
  Стало:
```js
    // PASTE_SOURCES_V1 — история пациента здесь больше не грузится: окно «Вставить результаты»
    // спрашивает сервер (rpc patient_doc_sources) при каждом открытии.
```

  (г) Неприкреплённая кнопка. Было:
```js

    // AURORA_EMR_BTN_V1 — «Карта приёмов»: previous-results popup.
    const emrBtn = h('button', { class: 'btn btn-outline', type: 'button', 'data-ws-needs-load': '', onclick: () => openEmrModal(ctx) },   // CABINET_FIX_V1_R4 — заперта, пока лист грузится
        Icon('Doc', { size: 13 }), ' Вставить результаты');
```
  Стало:
```js

    // PASTE_SOURCES_V1 — здесь создавалась кнопка «Вставить результаты» (emrBtn), но ни в одну
    // панель не попадала; живая кнопка — на листе (_ic.results, openEmrModal).
```

  (д) Состояние кабинета. Было:
```js
const wsState = { payload: null, recommendations: [], emr: null, emrFilter: 'all', saved: false, rtab: 'hints', lastA4: null, dispensed: [], docType: 'conclusion', blank: false, diagImages: [] };  // RX_SEPARATE_V1 · DIAG_IMAGES_V1
```
  Стало:
```js
const wsState = { payload: null, recommendations: [], saved: false, rtab: 'hints', lastA4: null, dispensed: [], docType: 'conclusion', blank: false, diagImages: [] };  // RX_SEPARATE_V1 · DIAG_IMAGES_V1 · PASTE_SOURCES_V1 — без emr/emrFilter
```
  Было (`freshLineState`):
```js
        recommendations: [], emr: null, emrFilter: 'all', dispensed: [],   // CABINET_FIX_V1_R2
```
  Стало:
```js
        recommendations: [], dispensed: [],   // CABINET_FIX_V1_R2 · PASTE_SOURCES_V1 — истории пациента в состоянии строки нет
```
  Было:
```js
const WS_PER_LINE = ['payload', 'payloadVs', 'saved', 'docType', 'docSections', 'docPhone', 'emr', 'emrFilter',
```
  Стало:
```js
const WS_PER_LINE = ['payload', 'payloadVs', 'saved', 'docType', 'docSections', 'docPhone',   // PASTE_SOURCES_V1 — без emr/emrFilter
```

  (е) Мастер направления (`openReferralWizard`). Было:
```js
            try { await loadPatientEmr(ctx.patient); paintEmr(); } catch (e) {}
```
  Стало:
```js
            // PASTE_SOURCES_V1 — истории пациента в кабинете больше нет: окно «Вставить результаты» читает сервер при открытии.
```

  (ж) `public/css/admin-views.css`. Было:
```css
/* --- study-history modal --- */
.st-body{ display:grid; grid-template-columns:268px 1fr; gap:16px; min-height:340px; max-height:74vh; }
.st-list{ display:flex; flex-direction:column; gap:4px; overflow-y:auto;
  border-right:1px solid var(--ink-100); padding-right:12px; }
.st-item{ display:flex; flex-direction:column; align-items:flex-start; gap:2px; padding:8px 10px;
  border:1px solid transparent; border-radius:var(--r-sm); background:transparent; color:var(--ink-800);
  font:inherit; text-align:left; cursor:pointer; transition:background .12s, border-color .12s; }
.st-item:hover{ background:var(--ink-50); }
.st-item.on{ background:var(--primary-50); border-color:var(--primary-200); color:var(--primary-700); }
.st-item .st-item-n{ font-size:13.5px; font-weight:600; }
.st-item .sub{ font-size:12.5px; color:var(--ink-500); }
.st-prev{ padding:12px 14px; background:var(--ink-25); border:1px solid var(--ink-100);
  border-radius:var(--r-md); overflow-y:auto; }
.st-prev .st-prev-t{ font-size:13.5px; font-weight:600; color:var(--ink-900); }
.st-prev .sub{ font-size:12.5px; color:var(--ink-500); }
.st-tbl{ width:100%; border-collapse:separate; border-spacing:0; font-size:13.5px; }
.st-tbl th{ text-align:left; font-size:12.5px; text-transform:uppercase; letter-spacing:.04em;
  color:var(--ink-500); padding:6px 8px; border-bottom:1px solid var(--ink-200); }
.st-tbl td{ padding:7px 8px; border-bottom:1px solid var(--ink-100); }
.st-tbl tbody tr{ cursor:pointer; }
.st-tbl tbody tr.on{ background:var(--primary-50); }
.st-tbl input[type="checkbox"]{ accent-color:var(--primary-600); pointer-events:none; }
.st-tbl .sub{ color:var(--ink-500); }

```
  Стало:
```css
/* PASTE_SOURCES_V1 — стили окна истории исследований (.st-*) удалены вместе с мёртвым openStudyHistoryModal */

```
  Было:
```css
@media (max-width:760px){
  .st-body{ grid-template-columns:1fr; }
  .st-list{ border-right:none; border-bottom:1px solid var(--ink-100); padding-right:0; padding-bottom:12px; }
  .rv-cols{ grid-template-columns:1fr; }
```
  Стало:
```css
@media (max-width:760px){
  .rv-cols{ grid-template-columns:1fr; }
```

  (з) `public/js/admin/__tests__/cabinet-review-r2.test.mjs` — три правки.
  1. Было:
```js
const EMR = new Map();            // patient_id -> строки истории
```
  Стало: строку удалить.
  2. Было:
```js
        if (body.table === 'visit_services' && body.op === 'select' && /visits!inner/.test(String(body.columns))) {
            if (HOLD.has('emr:' + pid)) await HOLD.get('emr:' + pid);
            return ok(EMR.get(pid) || []);
        }
```
  Стало: эти четыре строки удалить.
  3. Было (тест «п. 2»):
```js
    const c = code(WS_SRC);
    const fill = c.slice(c.indexOf('async function fillServiceConclusion('), c.indexOf('async function fillLabResults('));
    // CABINET_FIX_V1_R3 (F8) — через entryDx: код подписанной записи (её icd10), не нынешний
    assert.match(fill, /entryDx\(f, payload && payload\.diagnoses\)/, '«Вставить результаты» теряет код МКБ');
    assert.ok(!/f\.primary_diagnosis \|\| '—'/.test(fill) && !/esc\(f\.primary_diagnosis\)/.test(fill));
```
  Стало:
```js
    // PASTE_SOURCES_V1 — «Вставить результаты» берёт код подписанной записи на сервере
    // (entryDxText в notesDocData): server/services/rpc/patient-doc-sources.test.js.
```
  4. Тест «п. 4» целиком (от `test('п. 4: поздние «рекомендации» и «история пациента» …` до его `});`) заменить на:
```js
test('п. 4: поздние «рекомендации» строки A уходят в её состояние — открытая строка B их не получает, A получает при возврате', async () => {
    // PASTE_SOURCES_V1 — «история пациента» больше не держится в кабинете: окно «Вставить
    // результаты» спрашивает сервер при каждом открытии (paste-sources-cabinet.test.mjs).
    REC.set(31, [{ id: 1, services: { name: 'A-REC' }, users: { full_name: 'Врач A' } }]);
    REC.set(32, [{ id: 2, services: { name: 'B-REC' }, users: { full_name: 'Врач B' } }]);
    const relRec = hold('rec:31');
    const a = cabinet(31);
    const recA = WS.loadRecommendations(a);
    await tick(5);
    const b = cabinet(32);
    await WS.loadRecommendations(b);
    relRec();
    await recA;
    assert.deepEqual(WS.docSnapshot(b, 'conclusion').referrals.map((r) => r.name), ['B-REC'], 'рекомендации строки A попали в открытую строку B');
    a.container.dispatch('pointerdown');   // врач вернулся к A
    assert.deepEqual(WS.docSnapshot(a, 'conclusion').referrals.map((r) => r.name), ['A-REC']);
});
```

  (и) `public/js/admin/__tests__/cabinet-review-r3.test.mjs`. Было:
```js
    // поведение «Вставить результаты» — cabinet-review-r4.test.mjs, п. 6 (fillServiceConclusion)
```
  Стало:
```js
    // поведение «Вставить результаты» — server/services/rpc/patient-doc-sources.test.js (PASTE_SOURCES_V1)
```

  (к) `public/js/admin/__tests__/cabinet-review-r4.test.mjs`. Было:
```js
test('6 (F8): код записи, которого нет среди диагнозов строки, печатается строкой кода; «Вставить результаты» — код подписанной записи', async () => {
```
  Стало:
```js
test('6 (F8): код записи, которого нет среди диагнозов строки, печатается строкой кода (вставка — rpc patient_doc_sources, PASTE_SOURCES_V1)', async () => {
```
  Было:
```js
    NOTES.set(9, notesOf(null, { diagnoses: [MSUD], history: [SIGNED({ primary_diagnosis: 'Текст врача', icd10: 'N28.9' })] }));
    const out = await WS.fillServiceConclusion(new El('div'), { id: 9 });
    assert.match(out.html, /Диагноз: N28\.9; Текст врача/, '«Вставить результаты» без кода подписанной записи: ' + out.html);
    assert.ok(!/E71\.0/.test(out.html), 'под «Подписано» — нынешний основной диагноз');
```
  Стало:
```js
    // PASTE_SOURCES_V1 — «Вставить результаты» с кодом подписанной записи: server/services/rpc/patient-doc-sources.test.js.
```

  (л) `public/js/admin/__tests__/doc-rich-format.test.mjs`. Было:
```js
test('F2: «Вставить результаты» и снимок истории — текст без тегов, без двойного экранирования', async () => {
    const f = { chief_complaint: '<i>Кашель</i> 3 дня', physical_exam: '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>', recommendations_text: '<b>Диета</b>', primary_diagnosis: 'Бронхит' };
    NOTES.set(10, notesOf(null, { history: [SIGNED(f)] }));
    const body = new El('div');
    const out = await WS.fillServiceConclusion(body, { id: 10 });
    assert.equal(out.html, '<div>Осмотр: Живот мягкий; SpO2 &lt;95%. Диагноз: Бронхит. Рекомендации: Диета</div>');
    const t = body.textContent;
    assert.ok(t.includes('Кашель 3 дня') && t.includes('Живот мягкий'), t);
    assert.ok(!/<\/?(i|b|ul|li)>|&lt;|&amp;/.test(t), 'сводка показывает разметку: ' + t);
    // окно записи истории («Снимок»)
```
  Стало:
```js
test('F2: снимок истории — текст без тегов, без двойного экранирования (вставка результатов — PASTE_SOURCES_V1, rpc patient_doc_sources: разметка врача сохраняется)', async () => {
    const f = { chief_complaint: '<i>Кашель</i> 3 дня', physical_exam: '<ul><li>Живот мягкий</li><li>SpO2 &lt;95%</li></ul>', recommendations_text: '<b>Диета</b>', primary_diagnosis: 'Бронхит' };
    // окно записи истории («Снимок»)
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/paste-sources-cabinet.test.mjs public/js/admin/__tests__/paste-sources.test.mjs public/js/admin/__tests__/cabinet-review-r2.test.mjs public/js/admin/__tests__/cabinet-review-r3.test.mjs public/js/admin/__tests__/cabinet-review-r4.test.mjs public/js/admin/__tests__/doc-rich-format.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/current-target-after-await.test.mjs public/js/admin/__tests__/append-null.test.mjs`
  Ожидается PASS. Проверить, что в `service-workspace.js` не осталось упоминаний: `grep -n "loadPatientEmr\|paintEmr\|fillServiceConclusion\|openStudyHistoryModal\|wsState.emr\|emrBtn" public/js/admin/views/service-workspace.js` — только комментарии PASTE_SOURCES_V1.

- [ ] **Step 5: commit** — `.git/U3_MSG.txt`:
```
Кабинет: «Вставить результаты» — окно всех документов пациента; прежняя «Карта приёмов» удалена (PASTE_SOURCES_V1)

openEmrModal открывает views/paste-sources.js (текущая строка исключена), выбранное
вставляется прежним путём «Куда вставить?» → a4InsertHtml. Удалены loadPatientEmr /
paintEmr / emrRow / emrTabBtn / openEmrResultModal / fillServiceConclusion / fillLabResults,
мёртвые openStudyHistoryModal / renderStudyPreview с их стилями .st-*, неприкреплённая
кнопка emrBtn и wsState.emr. Тесты прежней сводки (r2, r4, doc-rich-format) переведены на
серверный тест; новый тест — кнопка листа → окно → поле документа.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --name-only
git add public/js/admin/views/service-workspace.js public/css/admin-views.css public/js/admin/__tests__/paste-sources-cabinet.test.mjs public/js/admin/__tests__/cabinet-review-r2.test.mjs public/js/admin/__tests__/cabinet-review-r3.test.mjs public/js/admin/__tests__/cabinet-review-r4.test.mjs public/js/admin/__tests__/doc-rich-format.test.mjs
git commit -F .git/U3_MSG.txt
```

---

### Task U3.7: прогон затронутого

- [ ] **Step 1: сервер** — `LIS_ENABLED=0 node --experimental-vm-modules --test server/services/rpc/patient-doc-sources.test.js server/services/rpc/patient-card.test.js server/services/rpc/case-doc-sources.test.js server/services/rpc/client-rpc-coverage.test.js server/routes/licence-gate.test.js` — PASS.
- [ ] **Step 2: обход карты RPC** — `node --experimental-vm-modules --test server/services/rpc/index.test.js` (идёт 10–15 минут — это его обычная скорость) — PASS (`patient_doc_sources` с `{}` отвечает `RpcError` 400, не `ReferenceError`).
- [ ] **Step 3: браузер** — `node --experimental-vm-modules --test public/js/shared/cabinet-doc.test.js public/js/shared/rich-text.test.js public/js/admin/__tests__/paste-sources.test.mjs public/js/admin/__tests__/paste-sources-cabinet.test.mjs public/js/admin/__tests__/patient-card-docs.test.mjs public/js/admin/__tests__/cabinet-review-r1.test.mjs public/js/admin/__tests__/cabinet-review-r2.test.mjs public/js/admin/__tests__/cabinet-review-r3.test.mjs public/js/admin/__tests__/cabinet-review-r4.test.mjs public/js/admin/__tests__/cabinet-review-r5.test.mjs public/js/admin/__tests__/cabinet-review-r6.test.mjs public/js/admin/__tests__/cabinet-review-r7.test.mjs public/js/admin/__tests__/cabinet-review-r8.test.mjs public/js/admin/__tests__/cabinet-diag-blank.test.mjs public/js/admin/__tests__/doc-rich-format.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/icons.test.mjs public/js/admin/__tests__/rpc-exists.test.mjs public/js/admin/__tests__/app-shell.test.mjs` — PASS.
- [ ] **Step 4: английская машина** — если в scratchpad есть предзагрузка `force-en.mjs` (CI идёт на en-US), повторить Step 3 для двух новых файлов с `--import "file:///…/force-en.mjs"`. Стенд кабинета сам ставит русский язык (`TEST_LOCALE_RU_V1`), поэтому ожидается PASS; падение — сравнение текста, зависящее от языка машины, а не от кода.
- [ ] **Step 5:** коммита нет. Сетевые падения `fetch failed / bad port` в файлах с настоящим портом — известный «флейк», перезапустить; любые другие — настоящие.

---

## Риски / что проверить исполнителю

1. **Здание.** Дизайн просит и «как у карты пациента», и «чужое здание не видно»; карта показывает приехавшие из филиала анализы с меткой «Филиал X». План фильтрует `sync_origin` (визиты и строки) — по тесту дизайна. Протоколы и файлы между зданиями не ездят вовсе, так что разница — только анализы, сделанные в соседнем здании. Если владелец скажет «показывать как в карте» — убрать два `ownWhere(...)` в `loadLines` и один в заключениях визита и поправить тест «чужое здание».
2. **Только подписанное.** Прежняя сводка при отсутствии подписи вставляла ЧЕРНОВИК; теперь черновик не документ. Анализ без показателей (назначен, не введён) в окне не показывается — вставлять нечего.
3. **Анализы — документом на визит**, панель — анализ («по визитам» дизайна, как «Результаты анализов» карты). Непроверенный анализ подписан в тексте вставки «(не проверено)» — это решение плана (безопасность), владельцу назвать.
4. **Заключение визита** (`visits.conclusion`) показывается только у визита без документов строк, иначе — двойной текст (его пишет сам кабинет). Старые визиты за пределом 300 строк могут показать заключение рядом со своей копией в архиве — редкий край.
5. **Размер.** Сервер разбирает `notes` до 300 строк и тела архива до 300 документов (тела диагностики с base64-снимками — тяжёлые, но так же поступает карта пациента). Ответ ограничен (`limit`, `SECTION_MAX`, `BUDGET`), изображения не уходят. Пейджинга нет — «Показаны последние N, остальные в карте».
6. **«Куда вставить?»** предлагает только разделы бланка «Приём» (`DOC_SECTIONS`); у бланка «Диагностика» поле «Описание» в нём не названо — так было и раньше, U3 это не меняет.
7. **Общие файлы.** U3 идёт после U10b: `service-workspace.js` уже правили U1 (`buildBlankData`, `diagDocData`), U2, U8 (`openRevisitModal`, панель листа), `i18n-strings.js`/`rpc/index.js`/`control/gate.js` — другие задачи. Правки привязаны к тексту; скрипт U3.6 сам останавливается, если блок не найден ровно один раз. Номера строк в «Files» — до выпуска.
8. `case-doc-sources.js` (панель истории болезни) не трогается — дизайн переводит её на ту же выборку «позже». В файле настоящий NUL-байт в строке ключа — Edit/Write его не возьмут.
9. Удалены стили `.st-*` и неприкреплённая кнопка `emrBtn` (в панели её не было). Если какой-то тест или экран вне кабинета ссылается на `.st-` — найдено поиском только в `admin-views.css` и мёртвом окне.
10. Подписи разделов (`Жалобы`…`Рецепт`, `Описание`, `Измерения`, разделы истории болезни) приходят с сервера по-русски и переводятся на экране словарём; в текст документа они вставляются по-русски — как и прежние вставки кабинета (`i18n-exempt` «содержимое бланка»).

## Проверка владельцем (вручную)

Откройте в кабинете приём пациента, у которого есть прошлый приём, УЗИ и анализы, → «Вставить результаты». УЗИ — во вкладке «Диагностика», анализы — в «Анализах» (введённые, но не проверенные помечены «не проверено»), прошлый приём — в «Консультациях» со всеми разделами (Жалобы, Анамнез, Терапия, Заключение); текущего приёма в списке нет.
Снимите галочку у одного раздела → «Вставить выбранное» → «Осмотр»: в документ попал полный текст только отмеченных разделов. Во вкладке «Файлы» загруженный скан открывается кнопкой «Открыть».
