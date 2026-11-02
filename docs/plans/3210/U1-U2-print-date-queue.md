# U1 + U2. Дата в печати протокола (PRINT_VISIT_DATE_V1) и завершённые приёмы не висят в очереди (QUEUE_FRESH_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal:**
- U1 — протокол приёма и лист диагностики датируются днём ПРИЁМА (местный день `visits.visit_date`), а не днём печати или подписи: на экране, в «Печати», в архивной копии при подписи и при перепечатке из карты. «Тип визита» на заключении — только настоящий (ступень цены строки), выдуманного «Первичный приём» больше нет.
- U2 — после «Завершить приём» строка сразу уходит из «Активных» в «Завершённые», а «Мой день» — в «Завершённые · N»; кабинет при возврате перечитывает очередь, не сбрасывая фильтр, период и поиск; у очереди есть «Обновить»; незавершённые строки прошлых дней — внизу «Активных» свёрнутой группой «Незавершённые с прошлых дней · N»; «Сохранить»/«Черновик» строку не трогают («Идёт приём» сверху).

**Architecture:**
- U1. Одна чистая функция `docDayText({ visitDate, history, now })` в `public/js/shared/cabinet-doc.js` (местный день визита → первая подпись → сегодня; строка `ДД.ММ.ГГГГ` через `dateNumeric`). `buildBlankData` кабинета (`service-workspace.js`) — единственный источник экрана, «Печати» (`docSnapshot`) и архива при подписи — берёт из неё `issueDate`, `diagDocData` ставит `dateOut = issueDate`; шапка формы («от …») — тоже. `doc-variants.js`: `visitTypeLabel(tier)` ('secondary' → «Второй визит», 'repeat' → «Повторный визит», иначе пусто), «Тип визита» рисуется только при значении; бланки диагностики читают `d.dateOut || d.issueDate || сегодня` — старые архивные листы без `dateOut` печатают свой `issueDate` без миграции. Очередь (`consultation.js`) читает `price_tier` строки и передаёт `__service.priceTier`.
- U2. Новый модуль без зависимостей `public/js/admin/queue-fresh.js` — «почта»: окно приёма после удачной подписи зовёт `noteLineStatus(id, 'completed')`; `consultation.js` и `doctor-dashboard.js` подписаны (`onLineStatus`) и ставят статус строке у себя сразу. Кабинет держит флаг `state.queueStale`; возврат из приёма идёт `onNavigate('consultation', { sub: 'work' })`, и оболочка отдаёт его уже смонтированной панели через существующий `ctx.onPayload` (CLINIC_API_STEP7_V1) — кабинет перечитывает очередь (`reloadQueue`, фильтр/поиск в `state` не трогаются, сбой чтения оставляет прежний список). Общий хук «при показе» в `admin.js` НЕ вводится (страж `app-shell.test.mjs`). Кнопка «Обновить» — тот же `reloadQueue`. Группа прошлых дней — чистые `isPastOpen`/`splitPastOpen` и строка-кнопка в `listView`.

**Tech Stack:** vanilla-JS SPA (`h()`, `Icon()`, `tr()`/`trf()`), node:test. Сервер и база не меняются: ни миграций, ни RPC, ни записей реестров.

**Состояние на старте:** ветка `rc/3.21.0`, HEAD `5fa59531` (= `347bfd3d` + раздел «К» дизайна про окно кассы «Платежи»; код тот же). U1 и U2 — первые задачи выпуска (порядок U1 → U2 → U4 → …). Номера строк ниже приблизительные — правки привязаны к тексту. Каждая правка и тесты проверены на копии `public/js` от `347bfd3d` (зелёные, в том числе с английской предзагрузкой и в поясах UTC / New York).

## Карта файлов

| Файл | Задача | Что |
|---|---|---|
| `public/js/shared/cabinet-doc.js` | U1.1 | + `docDayText()` (+ импорт `dateNumeric`) |
| `public/js/admin/views/doc-variants.js` | U1.1 | + `visitTypeLabel()`; «Тип визита» только при значении; бланки диагностики — `dateOut \|\| issueDate` |
| `public/js/admin/__tests__/print-visit-date.test.mjs` | U1.1 | новый |
| `public/js/admin/views/service-workspace.js` | U1.2, U2.2 | `buildBlankData.issueDate/visitType`, `diagDocData.dateOut`, шапка формы; сообщение о подписи, возврат `{ sub: 'work' }` |
| `public/js/admin/views/consultation.js` | U1.2, U2.3–U2.5 | `price_tier` → `priceTier`; почта, флаг, `reloadQueue`, `onPayload`, «Обновить», группа прошлых дней |
| `public/js/admin/__tests__/print-visit-date-cabinet.test.mjs` | U1.2 | новый |
| `public/js/admin/queue-fresh.js` | U2.1 | новый |
| `public/js/admin/__tests__/queue-fresh.test.mjs` | U2.1 | новый |
| `public/js/admin/__tests__/queue-fresh-sign.test.mjs` | U2.2 | новый |
| `public/js/admin/__tests__/queue-fresh-cabinet.test.mjs` | U2.3–U2.6 | новый (U2.3 создаёт, U2.4–U2.6 дописывают в конец) |
| `public/js/admin/i18n-strings.js` | U2.4, U2.5 | 2 новые фразы (ru/uz/en) |
| `public/js/admin/views/doctor-dashboard.js` | U2.6 | подписка «Моего дня» |

Существующие тесты, чьи ожидания меняются: **нет** (проверено: `Тип визита`/`Первичный приём` ни один тест бланка не ждёт; `onNavigate('consultation')` с одним аргументом ни один тест не ждёт — `cabinet-review-r5` проверяет только, что поздняя подпись НЕ уводит, это сохранено).

## Правила для всех задач

- Все команды — из корня `C:\Users\user\Desktop\implementation workflow\easymed.api5` (Git Bash). Тесты браузера: `node --experimental-vm-modules --test <файлы>` (явные пути). Каждый изменённый набор — ещё раз с английской предзагрузкой:
  `FE="file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"` и `node --import "$FE" --experimental-vm-modules --test <файлы>`.
- Правки — инструментом Edit (точный текст «найти» → «заменить»), новые файлы — Write. Не heredoc в Bash (ест обратную косую черту). Концы строк LF.
- `i18n-coverage.test.mjs` идёт больше минуты — это его обычная скорость.
- Коммит: сообщение пишется инструментом Write в `.git/U12_MSG.txt` (внутри `.git`, в индекс не попадает); перед `git add` индекс пуст (`git diff --cached --quiet`); добавляются только названные файлы; `git commit -F .git/U12_MSG.txt`; последняя строка сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Маркер каждой правки — `PRINT_VISIT_DATE_V1` (U1) или `QUEUE_FRESH_V1` (U2) в комментарии. Тексты интерфейса — ключи `i18n-strings.js` ru/uz/en (в uz/en без кириллицы); значки — только `Icon()`.
- `queue-fresh.js` импортируется ТОЛЬКО как `'../queue-fresh.js'` без `?v=`: адрес с `?v=` — второй экземпляр модуля со своими подписчиками, и сообщения молча не доходят.

---

### Task U1.1: «День документа» и листы: «Тип визита» только настоящий, лист диагностики — свой день

**Files:**
- Modify: `public/js/shared/cabinet-doc.js`
- Modify: `public/js/admin/views/doc-variants.js`
- Test (create): `public/js/admin/__tests__/print-visit-date.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/print-visit-date.test.mjs`:

```js
// PRINT_VISIT_DATE_V1 (3.21.0) — ДАТА В ПЕЧАТИ ПРОТОКОЛА — ДЕНЬ ПРИЁМА.
//
// Часть 1 — правило и листы, без кабинета:
//   • «день документа» (shared/cabinet-doc.js docDayText): местный день визита,
//     иначе первая подпись записи, иначе сегодня;
//   • заключение (doc-variants.js): «Тип визита» печатается только настоящий —
//     выдуманного «Первичный приём» по умолчанию больше нет;
//   • лист диагностики: день из данных (dateOut), старый архивный лист без
//     dateOut — свой issueDate, а не день перепечатки.
// Пояс задан явно — правило про МЕСТНЫЙ день клиники (как rpc/visits.local-day.test.js).
process.env.TZ = 'Asia/Tashkent';

const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { docDayText } = await import('../../shared/cabinet-doc.js');
const { dateNumeric } = await import('../../shared/date-words.js');
const { renderDesignedVariant, visitTypeLabel } = await import('../views/doc-variants.js');

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const TODAY = dateNumeric(new Date());

test('день документа — МЕСТНЫЙ день визита: приём в 00:30 по Ташкенту (вчерашние 19:30Z) — тот же день, не вчера', () => {
    assert.equal(docDayText({ visitDate: '2026-10-30T19:30:00.000Z' }), '31.10.2026');
    assert.equal(docDayText({ visitDate: '2026-10-31T09:00:00.000Z' }), '31.10.2026');
    assert.equal(docDayText({ visitDate: '2026-10-31' }), '31.10.2026', 'дата без времени — местная полночь, а не вчерашний день');
});

test('день документа: нет визита — день ПЕРВОЙ подписи; нет и её — сегодня', () => {
    const history = [
        { kind: 'draft', savedAt: '2026-09-30T10:00:00.000Z' },
        { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z' },
        { kind: 'signed', savedAt: '2026-10-05T08:00:00.000Z' },
    ];
    assert.equal(docDayText({ visitDate: null, history }), '01.10.2026', 'взята не первая подпись');
    assert.equal(docDayText({ visitDate: 'не дата', history }), '01.10.2026', 'испорченная дата визита напечаталась');
    assert.equal(docDayText({ history: [history[0]], now: new Date(2026, 10, 2, 15, 0) }), '02.11.2026', 'черновик — не подпись');
    assert.equal(docDayText(), TODAY);
});

test('«Тип визита» — ступень цены строки; «primary» и пусто — без строки', () => {
    assert.equal(visitTypeLabel('secondary'), 'Второй визит');
    assert.equal(visitTypeLabel('repeat'), 'Повторный визит');
    for (const t of ['primary', null, undefined, '', 'другое']) assert.equal(visitTypeLabel(t), '', String(t));
});

test('заключение (classic): «Тип визита» — только настоящий; «Первичный приём» по умолчанию не печатается', () => {
    const base = { patientName: 'Пациент Тест', mrn: 'P-1', doctorName: 'Врач Тест', issueDate: '28.10.2026', complaint: 'Кашель' };
    const none = text(renderDesignedVariant('conclusion', 'classic', S, base));
    assert.ok(!none.includes('Тип визита'), 'без данных строка «Тип визита» осталась');
    assert.ok(!none.includes('Первичный приём'), '«Первичный приём» по умолчанию остался');
    assert.match(none, /Дата приёма 28\.10\.2026/);
    const rep = text(renderDesignedVariant('conclusion', 'classic', S, { ...base, visitType: 'Повторный визит' }));
    assert.match(rep, /Тип визита Повторный визит/);
});

test('лист диагностики: dateOut — его день; старый архивный лист без dateOut — свой issueDate, не день перепечатки', () => {
    const diag = { patientName: 'Пациент Тест', mrn: 'P-1', service: 'УЗИ почек', description: 'Почки обычных размеров', conclusion: 'Норма' };
    for (const v of ['classic', 'compact']) {
        const archived = text(renderDesignedVariant('diag', v, S, { ...diag, issueDate: '05.10.2026' }));
        assert.ok(archived.includes('05.10.2026'), v + ': старый лист без dateOut не напечатал свой issueDate');
        if (TODAY !== '05.10.2026') assert.ok(!archived.includes(TODAY), v + ': старый лист датирован днём перепечатки');
        const fresh = text(renderDesignedVariant('diag', v, S, { ...diag, issueDate: '05.10.2026', dateOut: '04.10.2026' }));
        assert.ok(fresh.includes('04.10.2026') && !fresh.includes('05.10.2026'), v + ': dateOut не главнее issueDate');
        const bare = text(renderDesignedVariant('diag', v, S, diag));
        assert.ok(bare.includes(TODAY), v + ': лист без даты остался без даты');
    }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/print-visit-date.test.mjs
```
Expected: FAIL 5 из 5 — `TypeError: docDayText is not a function`, `visitTypeLabel is not a function`, «без данных строка «Тип визита» осталась», «classic: старый лист без dateOut не напечатал свой issueDate».

- [ ] **Step 3: implement**

**3.1** `public/js/shared/cabinet-doc.js` — найти:
```js
import { sanitizeStoredHtml, htmlToText, hasMarkup, textBreaks, richHasContent } from './rich-text.js';
```
заменить на:
```js
import { sanitizeStoredHtml, htmlToText, hasMarkup, textBreaks, richHasContent } from './rich-text.js';
import { dateNumeric } from './date-words.js';   // PRINT_VISIT_DATE_V1 — день документа местной датой ДД.ММ.ГГГГ
```

**3.2** Там же — конец `notesDocData` (конец файла). Найти:
```js
        diagnoses: (diagnoses || []).filter((x) => x && (x.code || x.name))
            .map((x) => ({ code: x.code, name: x.name, type: x.type, typeLabel: DX_TYPE_RU[x.type] || '' })),
    };
}
```
заменить на:
```js
        diagnoses: (diagnoses || []).filter((x) => x && (x.code || x.name))
            .map((x) => ({ code: x.code, name: x.name, type: x.type, typeLabel: DX_TYPE_RU[x.type] || '' })),
    };
}

/**
 * PRINT_VISIT_DATE_V1 (3.21.0) — ДЕНЬ ДОКУМЕНТА ПРИЁМА.
 *
 * Протокол приёма и лист диагностики датируются днём ПРИЁМА, а не днём, когда
 * их открыли, напечатали или подписали: экран, «Печать» и архивная копия при
 * подписи (buildBlankData кабинета) берут день отсюда. По порядку:
 *   1. местный день визита — visits.visit_date хранится ISO в UTC, и день из
 *      него берётся МЕСТНЫЙ (dateNumeric), а не slice(0, 10): приём в 00:30 по
 *      Ташкенту хранится вчерашним 19:30Z;
 *   2. нет визита — день ПЕРВОЙ подписи записи (history[].kind === 'signed');
 *   3. нет и её — сегодня.
 * Строка — как её печатает бланк: ДД.ММ.ГГГГ (MONTH_WORDS_V1).
 *
 * @param {{visitDate?: string|Date|null, history?: Array|null, now?: Date}} src
 * @returns {string}
 */
export function docDayText({ visitDate = null, history = null, now = new Date() } = {}) {
    const fromVisit = dateNumeric(visitDate);
    if (fromVisit) return fromVisit;
    const firstSigned = (Array.isArray(history) ? history : []).find((e) => e && e.kind === 'signed' && e.savedAt);
    const fromSign = firstSigned ? dateNumeric(firstSigned.savedAt) : '';
    return fromSign || dateNumeric(now);
}
```

**3.3** `public/js/admin/views/doc-variants.js` — найти:
```js
function lines(t) { return String(t || '').split(/\n+/).map(x => x.trim()).filter(Boolean); }
```
заменить на:
```js
function lines(t) { return String(t || '').split(/\n+/).map(x => x.trim()).filter(Boolean); }

// PRINT_VISIT_DATE_V1 (3.21.0) — «ТИП ВИЗИТА» НА ЗАКЛЮЧЕНИИ — ТОЛЬКО НАСТОЯЩИЙ.
// Было: «Первичный приём» стоял на КАЖДОМ заключении — visitType не задавал никто.
// Теперь — ступень цены строки (visit_services.price_tier, VISIT_TIER_PRICING_V1):
// 'secondary' — второй визит в окне, 'repeat' — повторный. 'primary' ставится и
// услугам без ступеней цены (domain/visit-tier.js tierFor → 'no_tiers') и
// первичного приёма не доказывает; у консультации ступени нет вовсе (null) —
// тогда строки «Тип визита» на листе нет. Слова — те же, что у цены в мастере
// (visit-tier-logic.js TIER_LABELS).
const VISIT_TIER_RU = { secondary: 'Второй визит', repeat: 'Повторный визит' };
export function visitTypeLabel(tier) {
    return VISIT_TIER_RU[tier] || '';
}
```

**3.4** Там же, в `conclusionClassic` — найти (строка одна в файле):
```js
    const fg = (l, uz, v, always) => (always || filled(v)) ? `<div class="fl">${esc(l)} <i>· ${esc(uz)}</i></div><div class="fv">${esc(filled(v) ? v : '—')}</div>` : '';
```
заменить на:
```js
    const fg = (l, uz, v, always) => (always || filled(v)) ? `<div class="fl">${esc(l)} <i>· ${esc(uz)}</i></div><div class="fv">${esc(filled(v) ? v : '—')}</div>` : '';
    // PRINT_VISIT_DATE_V1 — «Тип визита» — только настоящий (visitTypeLabel): нет данных — нет строки.
    const visitTypeChip = filled(d.visitType) ? `<span class="chip">Тип визита <b>${esc(d.visitType)}</b></span>` : '';
```

**3.5** Там же (строка `<div class="meta">` заключения, ~:669) — найти фрагмент:
```
<span class="chip">Тип визита <b>${esc(d.visitType || 'Первичный приём')}</b></span>
```
заменить на:
```
${visitTypeChip}
```

**3.6** Там же, `imagingClassic` — найти:
```js
    title: 'Результат диагностического исследования', uz: 'Diagnostika tekshiruvi natijasi',
    date: d.dateOut || dateNumeric(new Date()),
```
заменить на:
```js
    title: 'Результат диагностического исследования', uz: 'Diagnostika tekshiruvi natijasi',
    // PRINT_VISIT_DATE_V1 — день приёма (dateOut); старый архивный лист без dateOut —
    // свой issueDate (день подписи), а не день перепечатки.
    date: d.dateOut || d.issueDate || dateNumeric(new Date()),
```

**3.7** Там же, `imagingCompact` — найти:
```js
    const st = Object.assign({ kind: d.service || '' }, d.study || {});   // CABINET_FIX_V1_DIAG — см. imagingClassic
```
заменить на:
```js
    const st = Object.assign({ kind: d.service || '' }, d.study || {});   // CABINET_FIX_V1_DIAG — см. imagingClassic
    const issued = d.dateOut || d.issueDate || dateNumeric(new Date());   // PRINT_VISIT_DATE_V1 — «Выдан»: день приёма; старый лист — свой issueDate
```

**3.8** Там же, `imagingCompact` — найти фрагмент:
```
<span class="chip">Выдан <b>${esc(d.dateOut || dateNumeric(new Date()))}</b></span>
```
заменить на:
```
<span class="chip">Выдан <b>${esc(issued)}</b></span>
```
(Бланки анализов `labClassic`/`labCompact` с их `d.dateOut || dateNumeric(new Date())` НЕ трогать — это другие листы.)

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/print-visit-date.test.mjs public/js/admin/__tests__/cabinet-review-r1.test.mjs public/js/admin/__tests__/cabinet-review-r2.test.mjs public/js/admin/__tests__/cabinet-diag-blank.test.mjs public/js/admin/__tests__/print-skip-empty.test.mjs public/js/admin/__tests__/print-auto.test.mjs public/js/admin/__tests__/doc-rich-format.test.mjs public/js/admin/__tests__/doc-rich-template.test.mjs public/js/shared/doc-render.notice.test.js public/js/shared/doc-render.logo-name.test.js public/js/shared/doc-render.inpatient.test.js public/js/admin/__tests__/i18n-coverage.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS, ни одного ✖ (новый файл — 5 тестов).

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
Печать протокола: день документа — день приёма; «Тип визита» только настоящий (PRINT_VISIT_DATE_V1)

- shared/cabinet-doc.js docDayText: местный день визита (не день UTC: приём
  в 00:30 по Ташкенту — вчерашние 19:30Z), иначе первая подпись записи,
  иначе сегодня.
- Заключение: «Тип визита» — ступень цены строки (второй / повторный визит);
  нет данных — строки нет. «Первичный приём» больше не печатается на каждом
  листе.
- Лист диагностики читает dateOut, а старый архивный лист без dateOut — свой
  issueDate: перепечатка из карты больше не датирована сегодняшним днём.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/shared/cabinet-doc.js public/js/admin/views/doc-variants.js public/js/admin/__tests__/print-visit-date.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U1.2: Кабинет ставит день приёма на экран, в «Печать» и в архив; «Тип визита» из строки очереди

**Files:**
- Modify: `public/js/admin/views/service-workspace.js`
- Modify: `public/js/admin/views/consultation.js`
- Test (create): `public/js/admin/__tests__/print-visit-date-cabinet.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/print-visit-date-cabinet.test.mjs`:

```js
// PRINT_VISIT_DATE_V1 (3.21.0) — ДАТА В ПЕЧАТИ ПРОТОКОЛА — ДЕНЬ ПРИЁМА.
//
// Часть 2 — кабинет врача на НАСТОЯЩЕЙ форме (cabinet-harness.mjs): экран
// (шапка формы и бланк), «Печать» (docSnapshot) и архивная копия при подписи
// (visit_document_archive) датированы днём приёма — и у заключения, и у листа
// диагностики; «Тип визита» — ступень цены строки, а не «Первичный приём».
// Пояс задан явно — день МЕСТНЫЙ.
process.env.TZ = 'Asia/Tashkent';

const { default: nodeTest } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { readFileSync } = await import('node:fs');
const { installFakeDom, El } = await import('./cabinet-harness.mjs');

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const NOTES = new Map();
const ARCHIVE = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('/visit_document_archive')) ARCHIVE.push(body);
        if (u.endsWith('/refunded_lines')) return ok({ line_ids: [] });
        return ok({ id: 1 });
    }
    if (u === '/api/db' && body.table === 'visit_services') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.op === 'update') { if (body.values.notes) NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(body.op === 'select' && !body.single ? [] : null);
};
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });
const { renderDesignedVariant } = await import('../views/doc-variants.js');
const { dateNumeric } = await import('../../shared/date-words.js');

const DOCTOR = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
globalThis.window.easymed = { state: { user: DOCTOR } };
const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const TODAY = dateNumeric(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(10, 0, 0, 0); return d; };
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });

function cabinet(id, svc = {}, notes = notesOf({ chief_complaint: 'Кашель', conclusion_text: 'Здоров' }), type = 'conclusion') {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, onNavigate: () => {},
        patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
            __service: { id, name: 'Услуга ' + id, doctorName: 'Иванова А.', doctorSpec: 'Терапевт', ...svc } } };
    NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, type);
    return ctx;
}

test('приём 3 дня назад — заключение: шапка формы, «Печать» и архивная копия при подписи — день приёма', async () => {
    const day = daysAgo(3);
    const want = dateNumeric(day);
    const ctx = cabinet(71, { visitDate: day.toISOString() });
    await WS.hydrateLine(ctx);
    const lh = ctx.container.querySelector('.a4-lh-date');
    assert.ok(lh && lh.textContent.includes(want), 'шапка формы — не день приёма: ' + (lh && lh.textContent));
    const snap = WS.docSnapshot(ctx, 'conclusion');
    assert.equal(snap.issueDate, want, '«Печать» датирована не днём приёма');
    for (const v of ['classic', 'compact']) {
        const t = text(renderDesignedVariant('conclusion', v, S, snap));
        assert.ok(t.includes(want), v + ': на листе нет дня приёма');
        assert.ok(!t.includes(TODAY), v + ': на листе сегодняшний день');
    }
    ARCHIVE.length = 0;
    await WS.signDocument(ctx);
    assert.equal(ARCHIVE.length, 1, 'архивная копия не записана');
    assert.equal(ARCHIVE[0].doc_type, 'protocol');
    assert.equal(ARCHIVE[0].body.issueDate, want, 'архивная копия датирована днём подписи');
});

test('приём 3 дня назад — лист диагностики: «Выдан» на экране, в «Печати» и в архиве — день приёма', async () => {
    const day = daysAgo(3);
    const want = dateNumeric(day);
    const ctx = cabinet(72, { visitDate: day.toISOString(), name: 'УЗИ почек' },
        notesOf({ instrumental_text: 'Почки обычных размеров', primary_diagnosis: 'Патологии нет' }, { docType: 'diag' }), 'diag');
    await WS.hydrateLine(ctx);
    const snap = WS.docSnapshot(ctx, 'diag');
    assert.equal(snap.dateOut, want, 'у листа диагностики нет dateOut — бланк печатает сегодня');
    assert.equal(snap.issueDate, want);
    for (const v of ['classic', 'compact']) {
        const t = text(renderDesignedVariant('diag', v, S, snap));
        assert.ok(t.includes(want), v + ': на листе нет дня приёма');
        assert.ok(!t.includes(TODAY), v + ': на листе сегодняшний день');
    }
    ARCHIVE.length = 0;
    await WS.signDocument(ctx);
    assert.equal(ARCHIVE.length, 1, 'архивная копия не записана');
    assert.equal(ARCHIVE[0].doc_type, 'diag');
    assert.equal(ARCHIVE[0].body.dateOut, want, 'архивный лист диагностики датирован днём подписи');
});

test('визит в 00:30 по местному (вчерашний день UTC) — лист датирован МЕСТНЫМ днём', async () => {
    const local = new Date(2026, 9, 31, 0, 30);   // 31.10.2026 00:30 Ташкент = 30.10.2026 19:30Z
    assert.equal(local.toISOString(), '2026-10-30T19:30:00.000Z', 'стенд: пояс не Ташкент');
    const ctx = cabinet(73, { visitDate: local.toISOString() });
    await WS.hydrateLine(ctx);
    assert.equal(WS.docSnapshot(ctx, 'conclusion').issueDate, '31.10.2026');
});

test('нет дня визита — день первой подписи записи (переподпись не двигает дату)', async () => {
    const SIGNED = { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', by: 3, byName: 'Иванова А.', fields: { chief_complaint: 'Кашель' } };
    const ctx = cabinet(74, {}, notesOf({ chief_complaint: 'Кашель' }, { history: [SIGNED] }));
    await WS.hydrateLine(ctx);
    assert.equal(WS.docSnapshot(ctx, 'conclusion').issueDate, '01.10.2026');
});

test('«Тип визита» — ступень цены строки: повторный — печатается, первичная ступень и консультация — строки нет', async () => {
    const t = async (id, priceTier) => {
        const ctx = cabinet(id, { visitDate: daysAgo(1).toISOString(), priceTier });
        await WS.hydrateLine(ctx);
        const snap = WS.docSnapshot(ctx, 'conclusion');
        return { snap, html: text(renderDesignedVariant('conclusion', 'classic', S, snap)) };
    };
    const rep = await t(75, 'repeat');
    assert.equal(rep.snap.visitType, 'Повторный визит');
    assert.match(rep.html, /Тип визита Повторный визит/);
    const sec = await t(76, 'secondary');
    assert.match(sec.html, /Тип визита Второй визит/);
    for (const [id, tier] of [[77, 'primary'], [78, null]]) {
        const r = await t(id, tier);
        assert.ok(!r.html.includes('Тип визита') && !r.html.includes('Первичный приём'), String(tier) + ': выдуманный «Тип визита»');
    }
});

test('очередь кабинета передаёт в приём день визита и ступень цены строки', () => {
    const src = readFileSync(new URL('../views/consultation.js', import.meta.url), 'utf8');
    const load = (src.match(/async function loadServices\(\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.match(load, /consultation_type_id, price_tier,/, 'очередь не читает price_tier');
    assert.match(load, /priceTier:\s+r\.price_tier \|\| null,/);
    const open = (src.match(/async function openWorkspace\(r\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.match(open, /visitDate:\s+r\.visitDate \|\| null,/);
    assert.match(open, /priceTier:\s+r\.priceTier \|\| null,/, 'приём не получает ступень цены строки');
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/print-visit-date-cabinet.test.mjs
```
Expected: FAIL 6 из 6 — «шапка формы — не день приёма: от <сегодня>», «у листа диагностики нет dateOut — бланк печатает сегодня», `'02.11.2026' !== '31.10.2026'`-подобные расхождения, «очередь не читает price_tier».

- [ ] **Step 3: implement**

**3.1** `public/js/admin/views/service-workspace.js` — найти:
```js
import { renderDesignedVariant } from './doc-variants.js?v=cabr3';
```
заменить на (остаток строки — комментарий — не трогать):
```js
import { renderDesignedVariant, visitTypeLabel } from './doc-variants.js?v=cabr3';
```

**3.2** Там же — найти:
```js
import { fieldText, richForSheet, mainDxText, dxParts as dxPartsCore, entryDxText } from '../../shared/cabinet-doc.js';
```
заменить на (комментарий в конце строки сохранить):
```js
import { fieldText, richForSheet, mainDxText, dxParts as dxPartsCore, entryDxText, docDayText } from '../../shared/cabinet-doc.js';
```

**3.3** Там же, `soapForm` (шапка формы, ~:1041) — найти:
```js
                    title: 'Приём (осмотр, консультация)',
```
заменить на:
```js
                    title: 'Приём (осмотр, консультация)',
                    date: docDayText({ visitDate: svc.visitDate }),   // PRINT_VISIT_DATE_V1 — «от …» на экране — день приёма, а не сегодня
```

**3.4** Там же, `buildBlankData` (~:6497) — найти:
```js
        issueDate: new Date().toLocaleDateString('ru-RU'),
```
заменить на:
```js
        // PRINT_VISIT_DATE_V1 — день документа — день ПРИЁМА (shared/cabinet-doc.js docDayText), а
        // не день, когда лист открыли, напечатали или подписали: экран, «Печать» и архивная
        // копия при подписи собираются здесь. «Тип визита» — ступень цены строки (visitTypeLabel).
        issueDate: docDayText({ visitDate: svc.visitDate, history: wsState.payload && wsState.payload.history }),
        visitType: visitTypeLabel(svc.priceTier),
```

**3.5** Там же, `diagDocData` (~:6551) — найти:
```js
        radiologist: b.doctorName || '', radiologistSpec: b.doctorSpec || '', issueDate: b.issueDate || '',
```
заменить на:
```js
        radiologist: b.doctorName || '', radiologistSpec: b.doctorSpec || '', issueDate: b.issueDate || '',
        // PRINT_VISIT_DATE_V1 — «Выдан» листа диагностики — день приёма: бланк читает dateOut,
        // а его здесь не ставил никто, и любой лист (и перепечатка из архива) выходил сегодняшним.
        dateOut: b.issueDate || '',
```

**3.6** `public/js/admin/views/consultation.js`, `loadServices` — найти:
```js
            visit_id, service_id, doctor_id, consultation_type_id,
```
заменить на:
```js
            visit_id, service_id, doctor_id, consultation_type_id, price_tier,
```
(`price_tier` в `schema-registry.js` читается всеми сотрудниками — реестр не меняется.)

**3.7** Там же, конец отображения строки в `loadServices` — найти:
```js
            visitDate:       r.visits?.visit_date,
        };
```
заменить на:
```js
            visitDate:       r.visits?.visit_date,
            priceTier:       r.price_tier || null,   // PRINT_VISIT_DATE_V1 — «Тип визита» на заключении
        };
```

**3.8** Там же, `openWorkspace` → `__service` — найти:
```js
            visitDate:  r.visitDate || null,   // SERVICES_PACKAGES_V1 — день визита: каталог кабинета считает по нему срок пакета
```
заменить на:
```js
            visitDate:  r.visitDate || null,   // SERVICES_PACKAGES_V1 — день визита: каталог кабинета считает по нему срок пакета · PRINT_VISIT_DATE_V1 — и день документа
            priceTier:  r.priceTier || null,   // PRINT_VISIT_DATE_V1 — ступень цены строки → «Тип визита» на заключении
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/print-visit-date-cabinet.test.mjs public/js/admin/__tests__/print-visit-date.test.mjs public/js/admin/__tests__/cabinet-review-r1.test.mjs public/js/admin/__tests__/cabinet-review-r2.test.mjs public/js/admin/__tests__/cabinet-review-r3.test.mjs public/js/admin/__tests__/cabinet-review-r4.test.mjs public/js/admin/__tests__/cabinet-review-r5.test.mjs public/js/admin/__tests__/cabinet-review-r6.test.mjs public/js/admin/__tests__/cabinet-review-r7.test.mjs public/js/admin/__tests__/cabinet-review-r8.test.mjs public/js/admin/__tests__/cabinet-diag-blank.test.mjs public/js/admin/__tests__/cabinet-templates.test.mjs public/js/admin/__tests__/refund-any-cabinet.test.mjs public/js/admin/__tests__/act-as-sign-cabinet.test.mjs public/js/admin/__tests__/cabinet-queue-order.test.mjs public/js/admin/__tests__/refund-any-cabinet-queue.test.mjs public/js/admin/__tests__/dead-visit-lines.test.mjs public/js/admin/__tests__/service-workspace-add.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
Кабинет врача: день приёма на экране, в «Печати» и в архиве при подписи (PRINT_VISIT_DATE_V1)

Протокол и лист диагностики собирались с issueDate = сегодня: печать
вчерашнего приёма и архивная копия при подписи выходили днём печати или
подписи, а лист диагностики (бланк читает dateOut, его не ставил никто) —
всегда сегодняшним, и при перепечатке из карты тоже.

- buildBlankData: issueDate = docDayText (местный день визита, иначе первая
  подпись записи), visitType = ступень цены строки.
- diagDocData: dateOut = день приёма. Шапка формы «от …» — день приёма.
- «Мои приёмы» читают price_tier строки и передают его в приём.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/service-workspace.js public/js/admin/views/consultation.js public/js/admin/__tests__/print-visit-date-cabinet.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U2.1: Почта `queue-fresh.js` между окном приёма и кабинетом

**Files:**
- Create: `public/js/admin/queue-fresh.js`
- Test (create): `public/js/admin/__tests__/queue-fresh.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/queue-fresh.test.mjs`:

```js
// QUEUE_FRESH_V1 (3.21.0) — ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// queue-fresh.js — маленькая почта между окном приёма и кабинетом врача: окно
// сообщает «строка N получила статус S» сразу после записи на сервер, кабинет и
// «Мой день» подписаны. Здесь — сама почта: подписка, отписка, сбой одного
// подписчика не мешает другим, пустое сообщение никого не зовёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteLineStatus, onLineStatus } from '../queue-fresh.js';

test('подписчики получают номер строки и статус; отписка работает; сбой одного не мешает другим', () => {
    const got = [];
    const offA = onLineStatus(() => { throw new Error('сбой подписчика'); });
    const offB = onLineStatus((id, s) => got.push([id, s]));
    const warn = console.warn;
    console.warn = () => {};
    try { noteLineStatus(41, 'completed'); } finally { console.warn = warn; }
    assert.deepEqual(got, [[41, 'completed']]);
    offA(); offB();
    noteLineStatus(42, 'completed');
    assert.deepEqual(got, [[41, 'completed']], 'отписка не сработала');
});

test('пустой номер или статус — никого не зовут; подписка не-функцией — безвредна', () => {
    const got = [];
    const off = onLineStatus((id, s) => got.push([id, s]));
    noteLineStatus(null, 'completed');
    noteLineStatus('', 'completed');
    noteLineStatus(5, '');
    off();
    assert.deepEqual(got, []);
    const noop = onLineStatus('не функция');
    assert.equal(typeof noop, 'function');
    noop();
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/queue-fresh.test.mjs
```
Expected: FAIL — `ERR_MODULE_NOT_FOUND: Cannot find module '…\public\js\admin\queue-fresh.js'`.

- [ ] **Step 3: implement** — создать `public/js/admin/queue-fresh.js`:

```js
// QUEUE_FRESH_V1 (3.21.0) — ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// Кабинет врача («Мои приёмы» и «Мой день») — панель из кэша оболочки: при
// возврате её показывают снова и НЕ перерисовывают (admin.js «Already mounted?
// Show it again — never re-render», страж app-shell.test.mjs). После «Завершить
// приём» врач возвращался к старой копии: строка «Идёт приём / Продолжить»
// висела сверху до F5.
//
// Окно приёма сообщает сюда номер строки и её новый статус сразу после записи
// на сервер (noteLineStatus); кабинет и «Мой день» подписаны (onLineStatus),
// ставят статус у себя и помечают очередь устаревшей. Общего хука «при показе»
// в admin.js нет и не вводится.
//
// Модуль без зависимостей. Импорт — только '../queue-fresh.js' без ?v=: его
// грузят и кабинет, и окно приёма, и экземпляр обязан быть ОДИН (адрес с ?v= —
// второй экземпляр со своими подписчиками, и почта молча не доходит).
const LISTENERS = new Set();

/** Строка визита `lineId` получила статус `status` — сервер его уже записал. */
export function noteLineStatus(lineId, status) {
    if (lineId == null || lineId === '' || !status) return;
    for (const fn of [...LISTENERS]) {
        try { fn(lineId, String(status)); } catch (e) { console.warn('[queue-fresh]', e); }
    }
}

/** Подписка на сообщения; возвращает отписку. */
export function onLineStatus(fn) {
    if (typeof fn !== 'function') return () => {};
    LISTENERS.add(fn);
    return () => { LISTENERS.delete(fn); };
}
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/queue-fresh.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS.

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
Кабинет врача: почта «строка получила статус» между приёмом и очередью (QUEUE_FRESH_V1)

Кабинет — панель из кэша оболочки, при возврате её не перерисовывают, и
после «Завершить приём» строка «Идёт приём» висела сверху до F5.
queue-fresh.js: noteLineStatus / onLineStatus, без зависимостей и без ?v= —
один экземпляр на окно приёма, «Мои приёмы» и «Мой день».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/queue-fresh.js public/js/admin/__tests__/queue-fresh.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U2.2: Окно приёма сообщает о завершении и возвращает в «Мои приёмы» с адресом вкладки

**Files:**
- Modify: `public/js/admin/views/service-workspace.js`
- Test (create): `public/js/admin/__tests__/queue-fresh-sign.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/queue-fresh-sign.test.mjs`:

```js
// QUEUE_FRESH_V1 (3.21.0) — ОКНО ПРИЁМА СООБЩАЕТ КАБИНЕТУ, ЧТО ПРИЁМ ЗАВЕРШЁН.
//
// «Завершить приём» (подпись) пишет строке 'completed' — и сразу сообщает об
// этом кабинету (queue-fresh.js), а возвращает врача в «Мои приёмы» адресом с
// вкладкой ({ sub: 'work' }): по нему кэшированный кабинет перечитывает очередь
// (ctx.onPayload). «Черновик» статус не меняет и ничего не сообщает — строка
// остаётся «Идёт приём». Настоящая форма кабинета на стенде cabinet-harness.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom, El } from './cabinet-harness.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const NOTES = new Map();
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('/refunded_lines')) return ok({ line_ids: [] });
        return ok({ id: 1 });
    }
    if (u === '/api/db' && body.table === 'visit_services') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.op === 'update') { if (body.values.notes) NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(body.op === 'select' && !body.single ? [] : null);
};
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });
const QF = await import('../queue-fresh.js');
const NOTED = [];
QF.onLineStatus((id, s) => NOTED.push([id, s]));

const DOCTOR = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
globalThis.window.easymed = { state: { user: DOCTOR } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function cabinet(id, nav) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, onNavigate: (v, p) => nav.push([v, p]),
        patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
            __service: { id, name: 'Услуга ' + id, doctorName: 'Иванова А.', doctorSpec: 'Терапевт' } } };
    NOTES.set(id, JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель', conclusion_text: 'Здоров' }, history: [] }));
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    return ctx;
}

test('«Завершить приём»: кабинет узнаёт сразу (строка → completed), врача ведут в «Мои приёмы» с адресом вкладки', async () => {
    const NAV = [];
    const ctx = cabinet(81, NAV);
    await WS.hydrateLine(ctx);
    NOTED.length = 0;
    await WS.signDocument(ctx);
    assert.deepEqual(NOTED, [[81, 'completed']], 'кабинету не сообщили о завершённой строке');
    await tick(700);
    assert.deepEqual(NAV, [['consultation', { sub: 'work' }]], 'возврат без адреса вкладки — кэшированный кабинет его не заметит');
});

test('«Черновик» — статус не меняется: кабинету сообщать нечего, строка остаётся «Идёт приём»', async () => {
    const NAV = [];
    const ctx = cabinet(82, NAV);
    await WS.hydrateLine(ctx);
    NOTED.length = 0;
    assert.ok(await WS.saveDraft(ctx, { silent: true }), 'черновик не записан');
    assert.deepEqual(NOTED, []);
    assert.deepEqual(NAV, []);
});

test('источник: один экземпляр почты (импорт без ?v=); «Пауза» тоже возвращает в «Мои приёмы»', () => {
    const src = readFileSync(new URL('../views/service-workspace.js', import.meta.url), 'utf8');
    assert.match(src, /\nimport \{ noteLineStatus \} from '\.\.\/queue-fresh\.js';/);
    const pause = (src.match(/async function pauseAndLeave\(ctx\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.match(pause, /ctx\.onNavigate\('consultation', \{ sub: 'work' \}\)/);
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/queue-fresh-sign.test.mjs
```
Expected: FAIL 2 из 3 — «кабинету не сообщили о завершённой строке» и «The input did not match the regular expression /\nimport \{ noteLineStatus \}…/». Тест «Черновик» проходит и до правки — он сторожит, что правка его не сломает.

- [ ] **Step 3: implement**

**3.1** `public/js/admin/views/service-workspace.js` — найти:
```js
import { REFUNDED_LINE_MARK, REFUNDED_SIGN_REFUSAL } from '../../shared/refunded-line.js';   // REFUND_ANY_V1 — «Услуга возвращена»
```
заменить на:
```js
import { REFUNDED_LINE_MARK, REFUNDED_SIGN_REFUSAL } from '../../shared/refunded-line.js';   // REFUND_ANY_V1 — «Услуга возвращена»
import { noteLineStatus } from '../queue-fresh.js';   // QUEUE_FRESH_V1 — подписанная строка сразу «завершена» в кабинете (один экземпляр: без ?v=)
```

**3.2** Там же, `handleSignFinalize` → `afterSigned` — найти (пара строк — одна в файле; в `handleSaveDraft` перед `clearUnsaved` другой строки нет):
```js
        LINE_SIGNING.delete(vsKey);
        clearUnsaved(ctx, tCollect);   // CABINET_FIX_V1_R4 ([U])
```
заменить на:
```js
        LINE_SIGNING.delete(vsKey);
        clearUnsaved(ctx, tCollect);   // CABINET_FIX_V1_R4 ([U])
        // QUEUE_FRESH_V1 — строка подписана и на сервере уже 'completed': кабинет («Мои
        // приёмы», «Мой день») узнаёт это сразу, а не после F5 (queue-fresh.js).
        noteLineStatus(ctx.visitServiceId, 'completed');
```
(`afterSigned` зовётся только после удачной записи `status: 'completed'` — и сразу, и при поздней подписи.)

**3.3** Там же, конец `afterSigned` — найти:
```js
        if (ctx.onNavigate && !late) setTimeout(() => { if (wsState.ctx === ctx) ctx.onNavigate('consultation'); }, 600);
```
заменить на:
```js
        // QUEUE_FRESH_V1 — назад с адресом вкладки ({ sub: 'work' }): кэшированный кабинет
        // получает его через ctx.onPayload и перечитывает устаревшую очередь.
        if (ctx.onNavigate && !late) setTimeout(() => { if (wsState.ctx === ctx) ctx.onNavigate('consultation', { sub: 'work' }); }, 600);
```

**3.4** Там же, `pauseAndLeave` — найти:
```js
    if (ctx.onNavigate) ctx.onNavigate('consultation');
```
заменить на:
```js
    if (ctx.onNavigate) ctx.onNavigate('consultation', { sub: 'work' });   // QUEUE_FRESH_V1 — в «Мои приёмы», как после подписи
```
(`liveStrip` с кнопкой «← Мои услуги» нигде не вызывается — не трогать.)

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/queue-fresh-sign.test.mjs public/js/admin/__tests__/queue-fresh.test.mjs public/js/admin/__tests__/cabinet-review-r1.test.mjs public/js/admin/__tests__/cabinet-review-r2.test.mjs public/js/admin/__tests__/cabinet-review-r3.test.mjs public/js/admin/__tests__/cabinet-review-r4.test.mjs public/js/admin/__tests__/cabinet-review-r5.test.mjs public/js/admin/__tests__/cabinet-review-r6.test.mjs public/js/admin/__tests__/cabinet-review-r7.test.mjs public/js/admin/__tests__/cabinet-review-r8.test.mjs public/js/admin/__tests__/refund-any-cabinet.test.mjs public/js/admin/__tests__/act-as-sign-cabinet.test.mjs public/js/admin/__tests__/print-visit-date-cabinet.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS (в том числе `cabinet-review-r5` «поздняя подпись не уводит врача» — `NAV` по-прежнему пуст).

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
Окно приёма: «Завершить приём» сразу сообщает кабинету и возвращает в «Мои приёмы» (QUEUE_FRESH_V1)

- После удачной подписи (и при поздней) — noteLineStatus(строка, 'completed').
- Возврат после подписи и «Пауза» — onNavigate('consultation', { sub: 'work' }):
  оболочка отдаёт адрес уже смонтированному кабинету через ctx.onPayload.
- «Черновик» статус не меняет и ничего не сообщает.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/service-workspace.js public/js/admin/__tests__/queue-fresh-sign.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U2.3: «Мои приёмы»: строка сразу «Осмотрен», возврат перечитывает очередь, фильтр и поиск на месте

**Files:**
- Modify: `public/js/admin/views/consultation.js`
- Test (create): `public/js/admin/__tests__/queue-fresh-cabinet.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/queue-fresh-cabinet.test.mjs`:

```js
// QUEUE_FRESH_V1 (3.21.0) — «МОИ ПРИЁМЫ»: ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// Кабинет — панель из кэша оболочки: при возврате его показывают, а не
// перерисовывают (admin.js, страж app-shell.test.mjs). Владелец: после
// «Завершить приём» строка «Идёт приём / Продолжить» висела сверху до F5.
//
// Что здесь закреплено:
//   1. Окно приёма сообщило «строка завершена» (queue-fresh.js) — строка СРАЗУ
//      уходит из «Активных»; возврат ({ sub: 'work' } → ctx.onPayload)
//      перечитывает очередь, а фильтр и поиск врача остаются.
//   2. Возврат без сообщения (черновик, «Пауза») — ничего не перечитывается:
//      строка остаётся «Идёт приём» сверху.
//   3. Сбой перечитывания — прежний список на месте, следующий возврат пробует снова.
// Стенд тот же, что у cabinet-queue-order.test.mjs: честный /api/db с фильтрами.

import { test } from 'node:test';
import assert from 'node:assert';

// --- fake DOM (тот же харнесс, что у cabinet-queue-order.test.mjs) ----------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 _desc(o=[]){for(const c of this.children||[]){o.push(c);if(c._desc)c._desc(o);}return o;}
 _sel(n,s){ if(s[0]==='#')return (n.attrs&&n.attrs.id)===s.slice(1);
            if(s[0]==='.')return String(n.className||'').split(/\s+/).includes(s.slice(1));
            return String(n.tagName||'').toLowerCase()===s.toLowerCase(); }
 querySelector(s){return this._desc().find((n)=>this._sel(n,s))||null;}
 querySelectorAll(s){return this._desc().filter((n)=>this._sel(n,s));}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
};
function makeLocalStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null),
           setItem: (k, v) => { store.set(k, String(v)); },
           removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js выбирает язык ОДИН раз при загрузке модуля.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: null } },
  confirm: () => true,
  easymedSetTabSub() {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState(st) { this.state = st; }, pushState(st) { this.state = st; } };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const buttonByText = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ПОСЕВ: четыре услуги одного врача на сегодня (сервер отдаёт новые сверху).
// ---------------------------------------------------------------------------
const DOC = { id: 'u-doc', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor' };
const SVC = { name: 'Приём терапевта', type: 'consultation', duration_minutes: 30,
              service_types: { name: 'Консультация' }, departments: { kind: 'consultation' } };
const dayAt = (offset, hh = 9) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
const TODAY = dayAt(0);
let seq = 0;
const created = () => { const d = new Date(); d.setHours(8, 59 - (seq++), 0, 0); return d.toISOString(); };
const vs = (id, status, last, first, visitDate = TODAY) => ({
  id, status, quantity: 1, unit_price: 100000, total: 100000, created_at: created(), price_tier: null,
  invoice_item_id: null, visit_id: 'v-' + id, service_id: 's-1', doctor_id: 'u-doc',
  consultation_type_id: null, sync_origin: null, services: SVC, consultation_types: null,
  users: { full_name: DOC.full_name, specialty: DOC.specialty, rooms: null },
  visits: { visit_date: visitDate, patient_id: 'p-' + id, status: 'arrived',
            patients: { full_name: last + ' ' + first, last_name: last, first_name: first, mrn: 'MRN-' + id, phone: '' } },
});
const BASE = [
  vs('q1', 'queued',      'Аминов',  'Олим'),
  vs('p1', 'in_progress', 'Гаипов',  'Тимур'),
  vs('q2', 'queued',      'Зокиров', 'Бобур'),
  vs('c1', 'completed',   'Бакиев',  'Санжар'),
];
let ROWS = BASE.map((r) => ({ ...r }));
const reseed = () => { ROWS = BASE.map((r) => ({ ...r })); };
const setServerStatus = (id, status) => { ROWS = ROWS.map((r) => (r.id === id ? { ...r, status } : r)); };
let VISITS = [];
let FAIL_QUEUE = false;
let QUEUE_READS = 0;
let REFUNDED = new Set();   // строки, за которые касса вернула деньги (REFUND_ANY_V1, окно «Платежи»)

function matches(row, f) {
  if (f.or) return true;
  const v = row[f.col];
  switch (f.op) {
    case 'eq':  return String(v) === String(f.val);
    case 'is':  return f.val === null ? (v === null || v === undefined) : v === f.val;
    case 'in':  return (f.val || []).map(String).includes(String(v));
    case 'gte': return String(v) >= String(f.val);
    case 'lt':  return String(v) <  String(f.val);
    default:    return true;
  }
}
const TABLES = () => ({ users: [DOC], visit_services: ROWS, invoice_items: [], visits: VISITS, recommended_services: [], admissions: [], patients: [] });
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (String(url).startsWith('/api/db')) {
    // Чтение ОЧЕРЕДИ кабинета — то, у которого есть присоединение consultation_types(…).
    const isQueue = body.table === 'visit_services' && /consultation_types\(/.test(String(body.columns || ''));
    if (isQueue) {
      QUEUE_READS++;
      if (FAIL_QUEUE) return { ok: false, status: 500, json: async () => ({ error: { message: 'сбой сервера' } }) };
    }
    let rows = TABLES()[body.table] || [];
    for (const f of (body.filters || [])) rows = rows.filter((r) => matches(r, f));
    for (const o of (body.order || []).slice().reverse()) {
      rows = rows.slice().sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
    }
    if (body.limit) rows = rows.slice(0, body.limit);
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (String(url) === '/api/rpc/refunded_lines') {
    return { ok: true, json: async () => ({ data: { line_ids: (body.line_ids || []).filter((id) => REFUNDED.has(Number(id))) } }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const cabinet = await import('../views/consultation.js');
const QF = await import('../queue-fresh.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');
window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };

let HOOK = null;
const NAV = [];
async function openWork() {
  NAV.length = 0;
  HOOK = null;
  const root = mk('div');
  await cabinet.renderConsultation(root, {
    onNavigate: (v, p) => NAV.push([v, p]), tabId: 'consultation', payload: { sub: 'work' },
    onPayload: (fn) => { HOOK = fn; },
  });
  await tick(60);
  return root;
}
const NAMES = () => ROWS.map((r) => r.visits.patients.full_name);
const statusSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT');
const selectedStatus = (root) => statusSelect(root).value;
const pickStatus = (root, value) => { const sel = statusSelect(root); sel.dispatchEvent({ type: 'change', target: { value }, currentTarget: sel }); };
const bodyRows = (root) => { const tb = walk(root).find((n) => n.tagName === 'TBODY'); return tb ? tb.children.filter((n) => n.tagName === 'TR') : []; };
const nameOf = (tr) => NAMES().find((n) => textOf(tr).includes(n)) || null;
const visibleNames = (root) => bodyRows(root).map(nameOf).filter(Boolean);
const rowOf = (root, name) => bodyRows(root).find((tr) => nameOf(tr) === name);
const searchInput = (root) => walk(root).find((n) => n.tagName === 'INPUT');
async function typeSearch(root, value) {
  const inp = searchInput(root);
  inp.dispatchEvent({ type: 'input', target: { value }, currentTarget: inp });
  await tick(600);   // поиск — с задержкой (SEARCH_DEBOUNCE_V1, 500 мс)
}
const tileByLabel = (root, label) => byClass(root, 'ws-kpi-card').find((c) => textOf(c).includes(label));
const tileValue = (tile) => textOf(byClass(tile, 'ws-kpi-val')[0]).trim();

// ===========================================================================
test('подписан приём: строка СРАЗУ уходит из «Активных»; возврат перечитывает очередь, фильтр и поиск врача на месте', async (t) => {
  const root = await openWork();
  t.after(async () => { reseed(); await typeSearch(root, ''); });   // поиск живёт в модуле — вернуть соседним проверкам
  assert.strictEqual(typeof HOOK, 'function', 'кабинет не подписан на возврат (ctx.onPayload)');
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Аминов Олим', 'Зокиров Бобур'], 'стенд: «Идёт приём» не сверху');
  await typeSearch(root, 'Гаипов');
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур']);
  // Окно приёма подписало строку: сервер уже 'completed', кабинету сообщено.
  setServerStatus('p1', 'completed');
  QF.noteLineStatus('p1', 'completed');
  assert.deepStrictEqual(visibleNames(root), [], 'завершённый приём остался в «Активных» до возврата');
  const reads = QUEUE_READS;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads + 1, 'возврат не перечитал очередь');
  assert.strictEqual(selectedStatus(root), 'active', 'возврат сбросил фильтр');
  assert.strictEqual(searchInput(root).value, 'Гаипов', 'возврат сбросил поиск');
  assert.deepStrictEqual(visibleNames(root), []);
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур'], 'завершённый приём не в «Завершённых»');
  assert.ok(textOf(rowOf(root, 'Гаипов Тимур')).includes('Осмотрен'));
  assert.strictEqual(tileValue(tileByLabel(root, 'Осмотрено сегодня')), '2');
});

test('возврат без сообщения (черновик, «Пауза») — очередь не перечитывается, «Идёт приём» сверху с «Продолжить»', async (t) => {
  t.after(reseed);
  const root = await openWork();
  const reads = QUEUE_READS;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads, 'возврат без изменений перечитал очередь');
  const rows = bodyRows(root);
  assert.strictEqual(nameOf(rows[0]), 'Гаипов Тимур');
  assert.ok(textOf(rows[0]).includes('Идёт приём') && textOf(rows[0]).includes('Продолжить'), 'черновик выбил строку из «Идёт приём»');
});

test('сбой перечитывания: прежний список на месте, флаг «устарела» остаётся — следующий возврат пробует снова', async (t) => {
  t.after(() => { reseed(); FAIL_QUEUE = false; });
  const root = await openWork();
  setServerStatus('q1', 'completed');
  QF.noteLineStatus('q1', 'completed');
  FAIL_QUEUE = true;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Зокиров Бобур'], 'сбой чтения опустошил список');
  FAIL_QUEUE = false;
  const reads = QUEUE_READS;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads + 1, 'после сбоя очередь больше не перечитывается');
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), ['Аминов Олим', 'Бакиев Санжар']);
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
```
Expected: FAIL 3 из 3 — «кабинет не подписан на возврат (ctx.onPayload)» и `TypeError: HOOK is not a function`.

- [ ] **Step 3: implement** — `public/js/admin/views/consultation.js`:

**3.1** Найти:
```js
import { loadRefundedLineIds } from '../refunded-lines.js';   // REFUND_ANY_V1 (ревью B4) — один вопрос refunded_lines на список
```
заменить на:
```js
import { loadRefundedLineIds } from '../refunded-lines.js';   // REFUND_ANY_V1 (ревью B4) — один вопрос refunded_lines на список
import { onLineStatus } from '../queue-fresh.js';   // QUEUE_FRESH_V1 — окно приёма сообщает новый статус строки (один экземпляр: без ?v=)
```

**3.2** В объекте `state` — найти:
```js
    search:       '',
```
заменить на:
```js
    search:       '',
    // QUEUE_FRESH_V1 — очередь устарела: окно приёма завершило строку (queue-fresh.js).
    // Экран перечитывает её при возврате (ctx.onPayload) и при переходе на вкладку.
    queueStale:   false,
```

**3.3** Найти:
```js
let queueLoaded = false;      // рабочий список грузится, когда его открыли
```
заменить на:
```js
let queueLoaded = false;      // рабочий список грузится, когда его открыли
// QUEUE_FRESH_V1 — перечитывание «в пути» (два вызова подряд — одно чтение) и
// сообщения о статусе строк с их номером по порядку: сообщение, пришедшее,
// пока шло чтение, не теряется (reloadQueue).
let queueReload = null;
let lineNoteSeq = 0;
const LINE_NOTES = new Map();   // id строки → { status, seq }
```

**3.4** Найти:
```js
export async function renderConsultation(container, { onNavigate, payload, tabId } = {}) {
```
заменить на:
```js
export async function renderConsultation(container, { onNavigate, payload, tabId, onPayload } = {}) {
```

**3.5** Там же (в `renderConsultation`) — найти (строка одна в файле):
```js
    queueLoaded = false;
```
заменить на:
```js
    queueLoaded = false;
    state.queueStale = false;   // QUEUE_FRESH_V1 — список и так читается заново
    // QUEUE_FRESH_V1 — панель кабинета живёт в кэше оболочки, и при возврате её не
    // перерисовывают (admin.js; страж app-shell.test.mjs). Возврат из приёма приходит
    // сюда новым payload ({ sub: 'work' }) — устаревшая очередь перечитывается.
    // Общего хука «при показе» в admin.js нет и не вводится.
    if (typeof onPayload === 'function') onPayload(() => onCabinetShownAgain());
```

**3.6** Конец `loadQueueOnce` — найти:
```js
    state.rows = fresh;
    queueLoaded = true;
}
```
заменить на:
```js
    state.rows = fresh;
    queueLoaded = true;
}

// QUEUE_FRESH_V1 (3.21.0) — ПЕРЕЧИТАТЬ ОЧЕРЕДЬ, НЕ ТРОГАЯ ВЫБОР ВРАЧА.
// Фильтр, период и поиск живут в state и здесь не сбрасываются — их сбрасывает
// только новое открытие кабинета (renderConsultation). Сбой чтения — на экране
// остаётся прежний список (loadServices уже сказал об ошибке), флаг «устарела»
// остаётся: следующий возврат попробует снова. Сообщение о статусе, пришедшее,
// пока шло чтение, ложится и на новые строки: сервер мог ответить до подписи.
async function reloadQueue() {
    if (queueReload) return queueReload;
    queueReload = (async () => {
        const seq = lineNoteSeq;
        const shown = state.rows;
        const ok = await loadServices();
        const fresh = state.rows;
        state.rows = shown;
        if (!ok) return false;
        await markRefundedRows(fresh);   // REFUND_ANY_V1 — те же отметки, что у первой загрузки
        for (const r of fresh) {
            const n = LINE_NOTES.get(String(r.id));
            if (n && n.seq > seq) r.status = n.status;
        }
        state.rows = fresh;
        queueLoaded = true;
        if (lineNoteSeq === seq) state.queueStale = false;
        return true;
    })();
    try { return await queueReload; } finally { queueReload = null; }
}

// QUEUE_FRESH_V1 — окно приёма записало строке новый статус (queue-fresh.js).
// Строка меняется СРАЗУ, до возврата и до перечитывания: «Активные» и
// «Завершённые» не ждут сервера. Перерисовывается только список (без подгонки
// высоты окна — панель сейчас скрыта); плитки — при возврате. Очередь
// помечается устаревшей. Экспорт — для проверки.
export function applyLineStatus(lineId, status) {
    const key = String(lineId);
    LINE_NOTES.set(key, { status: String(status), seq: ++lineNoteSeq });
    let hit = false;
    for (const r of state.rows) if (String(r.id) === key) { r.status = String(status); hit = true; }
    state.queueStale = true;
    if (hit && containerRef && state.tab === 'appointments') paintBody();
    return hit;
}
onLineStatus(applyLineStatus);

// QUEUE_FRESH_V1 — кабинет показали снова (возврат из приёма, ctx.onPayload).
// Устаревшая очередь: сначала известное (подписанная строка уже «Осмотрен»,
// плитки пересчитаны), потом — с сервера, с тем же фильтром и поиском.
function onCabinetShownAgain() {
    if (!state.queueStale) return;
    paint();
    reloadQueue().then((ok) => { if (ok && state.tab === 'appointments') paint(); });
}
```

**3.7** `loadServices`, ветка ошибки — найти:
```js
        state.rows = [];
        return;
    }
    // SERVICE_ROUTING: lab services go to the Laboratory module, not the doctor queue.
```
заменить на:
```js
        state.rows = [];
        return false;   // QUEUE_FRESH_V1 — перечитывание узнаёт о сбое и оставляет прежний список
    }
    // SERVICE_ROUTING: lab services go to the Laboratory module, not the doctor queue.
```

**3.8** Конец `loadServices` — найти:
```js
    });
}

// Today's referrals THIS doctor recommended
```
заменить на:
```js
    });
    return true;   // QUEUE_FRESH_V1 — чтение удалось (reloadQueue)
}

// Today's referrals THIS doctor recommended
```
(`loadQueueOnce` ответ не читает — его поведение прежнее, `dead-visit-lines.test.mjs` смотрит тот же исходник `loadServices`.)

**3.9** `ensureTabData` — найти:
```js
    if (id === 'appointments') return loadQueueOnce();
```
заменить на:
```js
    if (id === 'appointments') return state.queueStale ? reloadQueue() : loadQueueOnce();   // QUEUE_FRESH_V1 — устаревшая очередь перечитывается и на вкладке
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/queue-fresh-cabinet.test.mjs public/js/admin/__tests__/queue-fresh-sign.test.mjs public/js/admin/__tests__/cabinet-queue-order.test.mjs public/js/admin/__tests__/refund-any-cabinet-queue.test.mjs public/js/admin/__tests__/head-doctor-cabinet.test.mjs public/js/admin/__tests__/admin-doctor-local.test.mjs public/js/admin/__tests__/cabinet-self-doctor.test.mjs public/js/admin/__tests__/doctor-dashboard.test.mjs public/js/admin/__tests__/doctor-pay.test.mjs public/js/admin/__tests__/dead-visit-lines.test.mjs public/js/admin/__tests__/app-shell.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
«Мои приёмы»: подписанный приём сразу «Осмотрен», возврат перечитывает очередь (QUEUE_FRESH_V1)

- Подписка на queue-fresh.js: строка меняет статус сразу (список
  перерисовывается без подгонки высоты — панель скрыта), очередь помечается
  устаревшей.
- Возврат из приёма ({ sub: 'work' } → ctx.onPayload): известное сразу, потом
  reloadQueue — фильтр, период и поиск врача не сбрасываются; сбой чтения
  оставляет прежний список и флаг. Переход на вкладку тоже перечитывает
  устаревшую очередь. Общий хук «при показе» в admin.js не вводится.
- loadServices отвечает true/false.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/consultation.js public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U2.4: Кнопка «Обновить» у очереди

**Files:**
- Modify: `public/js/admin/views/consultation.js`
- Modify: `public/js/admin/i18n-strings.js`
- Test (modify): `public/js/admin/__tests__/queue-fresh-cabinet.test.mjs` — дописать в конец

- [ ] **Step 1: failing test** — дописать в конец `queue-fresh-cabinet.test.mjs`:

```js

// --- «Обновить» у очереди ---------------------------------------------------
const rangeBtn = (root, label) => walk(root).find((n) => n.attrs && n.attrs.id === 'svc-range').children.find((b) => textOf(b).trim() === label);

test('«Обновить» перечитывает очередь, а фильтр, период и поиск врача остаются', async (t) => {
  const root = await openWork();
  // Поиск и период живут в модуле кабинета и между открытиями — вернуть их соседним проверкам.
  t.after(async () => { reseed(); await typeSearch(root, ''); rangeBtn(root, 'Период').click(); await tick(); });
  pickStatus(root, 'all');
  rangeBtn(root, 'Неделя').click();
  await tick();
  await typeSearch(root, 'Аминов');
  assert.deepStrictEqual(visibleNames(root), ['Аминов Олим']);
  setServerStatus('q1', 'completed');   // другой экран (касса, второе окно) завершил строку
  const btn = buttonByText(root, /Обновить/);
  assert.ok(btn, 'у очереди нет кнопки «Обновить»');
  assert.strictEqual(btn.attrs.title, 'Перечитать список приёмов');
  const reads = QUEUE_READS;
  btn.click();
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads + 1, '«Обновить» не перечитал очередь');
  assert.strictEqual(selectedStatus(root), 'all', '«Обновить» сбросил фильтр');
  assert.ok(hasClass(rangeBtn(root, 'Неделя'), 'on'), '«Обновить» сбросил период');
  assert.strictEqual(searchInput(root).value, 'Аминов', '«Обновить» сбросил поиск');
  assert.ok(textOf(rowOf(root, 'Аминов Олим')).includes('Осмотрен'), 'перечитанный статус не показан');
});

test('подписи «Обновить» — в словаре на трёх языках, uz/en без кириллицы', async () => {
  const { STRINGS } = await import('../i18n-strings.js');
  for (const key of ['Обновить', 'Перечитать список приёмов']) {
    const e = STRINGS[key];
    assert.ok(e && e.ru && e.uz && e.en, 'нет ключа словаря: ' + key);
    for (const lang of ['uz', 'en']) assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, key + ': ' + lang);
  }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
```
Expected: FAIL 2 новых — «у очереди нет кнопки «Обновить»», «нет ключа словаря: Перечитать список приёмов». Три теста U2.3 — PASS.

- [ ] **Step 3: implement**

**3.1** `public/js/admin/views/consultation.js`, `appointmentsView` — найти:
```js
                    rangeFilter(),   // NO_GREETING_V1 — relocated out of the band
```
заменить на:
```js
                    rangeFilter(),   // NO_GREETING_V1 — relocated out of the band
                    // QUEUE_FRESH_V1 — «Обновить»: очередь перечитывается с сервера, а фильтр,
                    // период и поиск врача остаются как были (reloadQueue).
                    h('button', {
                        class: 'btn btn-outline btn-sm', type: 'button', 'data-queue-refresh': '',
                        title: 'Перечитать список приёмов',
                        onclick: (ev) => {
                            if (ev && ev.currentTarget) ev.currentTarget.disabled = true;
                            Promise.all([reloadQueue(), loadTodayReferrals()])
                                .then(() => { if (state.tab === 'appointments') paint(); });
                        },
                    }, Icon('Refresh', { size: 13 }), ' Обновить'),
```
(«Обновить» уже есть в словаре: `"Обновить": {"en": "Refresh", …, "uz": "Yangilash"}`; значок `Refresh` — тот же, что у «Обновить» вкладки «Стационар».)

**3.2** `public/js/admin/i18n-strings.js` — найти (строка одна в файле):
```js
  "Завершённые · {n}": {"en": "Completed · {n}", "ru": "Завершённые · {n}", "uz": "Yakunlangan · {n}"},
```
заменить на:
```js
  "Завершённые · {n}": {"en": "Completed · {n}", "ru": "Завершённые · {n}", "uz": "Yakunlangan · {n}"},
  // QUEUE_FRESH_V1 — «Мои приёмы» кабинета врача: «Обновить» очереди и группа незавершённых прошлых дней
  "Перечитать список приёмов": {"en":"Reload the appointment list","ru":"Перечитать список приёмов","uz":"Qabullar ro‘yxatini qayta yuklash"},   // QUEUE_FRESH_V1
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/queue-fresh-cabinet.test.mjs public/js/admin/__tests__/cabinet-queue-order.test.mjs public/js/admin/__tests__/refund-any-cabinet-queue.test.mjs public/js/admin/__tests__/head-doctor-cabinet.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS.

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
«Мои приёмы»: кнопка «Обновить» у очереди (QUEUE_FRESH_V1)

Очередь перечитывается с сервера (reloadQueue) вместе с рекомендациями дня;
фильтр, период и поиск врача остаются. Подсказка — «Перечитать список
приёмов» (ru/uz/en).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/consultation.js public/js/admin/i18n-strings.js public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U2.5: «Незавершённые с прошлых дней · N» — свёрнутой группой внизу «Активных»

**Files:**
- Modify: `public/js/admin/views/consultation.js`
- Modify: `public/js/admin/i18n-strings.js`
- Test (modify): `public/js/admin/__tests__/queue-fresh-cabinet.test.mjs` — дописать в конец

- [ ] **Step 1: failing test** — дописать в конец `queue-fresh-cabinet.test.mjs`:

```js

// --- незавершённые прошлых дней ----------------------------------------------
const pastToggle = (root) => walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && 'data-past-toggle' in n.attrs);

test('незавершённые прошлых дней — внизу «Активных» свёрнутой группой; раскрывается; новое открытие кабинета её сворачивает', async (t) => {
  ROWS = [...BASE.map((r) => ({ ...r })),
    vs('o1', 'queued',      'Юсупов',   'Акмал', dayAt(-1)),
    vs('o2', 'in_progress', 'Хасанова', 'Лола',  dayAt(-3)),
    vs('o3', 'completed',   'Шарипов',  'Ильёс', dayAt(-1)),
    vs(905,  'queued',      'Рахимов',  'Анвар', dayAt(-2))];   // касса вернула деньги («Платежи» → «Вернуть услугу»)
  REFUNDED = new Set([905]);
  t.after(() => { reseed(); REFUNDED = new Set(); });
  const root = await openWork();
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Аминов Олим', 'Зокиров Бобур'],
    'вчерашние незавершённые стоят среди сегодняшней работы');
  const head = pastToggle(root);
  assert.ok(head, 'группы «Незавершённые с прошлых дней» нет');
  assert.ok(textOf(head).includes('Незавершённые с прошлых дней · 2'), textOf(head));
  assert.strictEqual(head.attrs['aria-expanded'], 'false', 'группа открылась раскрытой');
  head.click();
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Аминов Олим', 'Зокиров Бобур', 'Хасанова Лола', 'Юсупов Акмал'],
    'раскрытая группа — не внизу или не те строки');
  assert.strictEqual(pastToggle(root).attrs['aria-expanded'], 'true');
  // «Все статусы» — без группы: строки на своих местах, как раньше.
  pickStatus(root, 'all');
  assert.strictEqual(pastToggle(root), undefined, 'группа видна вне «Активных»');
  assert.ok(visibleNames(root).includes('Юсупов Акмал') && visibleNames(root).includes('Шарипов Ильёс'));
  // Возвращённая строка — не работа (REFUND_ANY_V1): ни в «Активных», ни в группе; видна в «Все статусы».
  assert.ok(visibleNames(root).includes('Рахимов Анвар'), 'возвращённая строка пропала из «Все статусы»');
  // Новое открытие кабинета — группа снова свёрнута.
  const again = await openWork();
  assert.strictEqual(pastToggle(again).attrs['aria-expanded'], 'false');
  assert.ok(!visibleNames(again).includes('Юсупов Акмал'));
});

test('isPastOpen / splitPastOpen: рабочая строка визита раньше сегодняшнего МЕСТНОГО дня; группа — только в «Активных»', () => {
  const now = new Date(2026, 10, 2, 10, 0);
  const at = (y, m, d, hh, mm = 0) => new Date(y, m, d, hh, mm).toISOString();
  const rows = [
    { id: 'a', status: 'queued',      visitDate: at(2026, 10, 1, 23, 50) },   // вчера поздно вечером
    { id: 'b', status: 'in_progress', visitDate: at(2026, 10, 2, 0, 30) },    // сегодня 00:30 — не прошлый день
    { id: 'c', status: 'completed',   visitDate: at(2026, 9, 30, 9) },        // завершён — не «незавершённый»
    { id: 'd', status: 'added',       visitDate: at(2026, 9, 28, 9) },
    { id: 'e', status: 'queued',      visitDate: null },
  ];
  assert.deepStrictEqual(rows.filter((r) => cabinet.isPastOpen(r, now)).map((r) => r.id), ['a', 'd']);
  const s = cabinet.splitPastOpen(rows, 'active', now);
  assert.deepStrictEqual([s.main.map((r) => r.id), s.past.map((r) => r.id)], [['b', 'c', 'e'], ['a', 'd']]);
  assert.deepStrictEqual(cabinet.splitPastOpen(rows, 'all', now).past, []);
});

test('подпись группы — в словаре на трёх языках, с {n}, uz/en без кириллицы', async () => {
  const { STRINGS } = await import('../i18n-strings.js');
  const e = STRINGS['Незавершённые с прошлых дней · {n}'];
  assert.ok(e && e.ru && e.uz && e.en, 'нет ключа словаря');
  for (const lang of ['uz', 'en']) {
    assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, lang);
    assert.ok(e[lang].includes('{n}'), lang + ' без {n}');
  }
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
```
Expected: FAIL 3 новых — «вчерашние незавершённые стоят среди сегодняшней работы», `TypeError: cabinet.isPastOpen is not a function`, «нет ключа словаря».

- [ ] **Step 3: implement**

**3.1** `public/js/admin/views/consultation.js`, `state` — найти (добавлено в U2.3):
```js
    queueStale:   false,
```
заменить на:
```js
    queueStale:   false,
    // QUEUE_FRESH_V1 — группа «Незавершённые с прошлых дней» раскрыта? Каждое
    // открытие кабинета её сворачивает (renderConsultation), внутри — выбор держится.
    pastOpen:     false,
```

**3.2** `renderConsultation` — найти (строка одна в файле, ровно с 4 пробелами):
```js
    state.statusFilter = 'active';
```
заменить на:
```js
    state.statusFilter = 'active';
    state.pastOpen = false;   // QUEUE_FRESH_V1 — группа прошлых дней при каждом открытии свёрнута
```

**3.3** Конец `sortQueue` — найти:
```js
    const key = (r) => queueRank(r) * 2 + (isTodayDate(r && r.visitDate) ? 0 : 1);
    return (rows || []).slice().sort((a, b) => key(a) - key(b));
}
```
заменить на:
```js
    const key = (r) => queueRank(r) * 2 + (isTodayDate(r && r.visitDate) ? 0 : 1);
    return (rows || []).slice().sort((a, b) => key(a) - key(b));
}

// QUEUE_FRESH_V1 (3.21.0) — НЕЗАВЕРШЁННЫЕ СТРОКИ ПРОШЛЫХ ДНЕЙ. Рабочая строка
// (запланирована / в очереди / идёт приём), чей визит раньше сегодняшнего
// МЕСТНОГО дня, — не работа сегодняшнего дня: в «Активных» она уходит вниз,
// в свёрнутую группу «Незавершённые с прошлых дней · N» (решение владельца
// 2026-11-02). Из списка она не пропадает: группу раскрывают, строку открывают
// и завершают. В остальных фильтрах — как была. Экспорт — для проверки.
const OPEN_STATUSES = ['added', 'queued', 'in_progress'];
export function isPastOpen(r, now = new Date()) {
    if (!r || !OPEN_STATUSES.includes(r.status)) return false;
    const d = visitDay(r.visitDate);
    if (!d) return false;
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
}
export function splitPastOpen(rows, filter, now = new Date()) {
    const list = rows || [];
    if (filter !== 'active') return { main: list, past: [] };
    const main = [], past = [];
    for (const r of list) (isPastOpen(r, now) ? past : main).push(r);
    return { main, past };
}
```
(`visitDay` — объявление функции ниже в том же модуле, поднимается.)

**3.4** Конец `paintBody` — найти:
```js
    body.appendChild(listView(filtered));
}
```
заменить на:
```js
    // QUEUE_FRESH_V1 — незавершённые прошлых дней — внизу «Активных» свёрнутой группой.
    const { main, past } = splitPastOpen(filtered, state.statusFilter);
    body.appendChild(listView(main, past));
}
```
(Календарь `calendarView(filtered)` и счётчик «Показано» по-прежнему получают все отобранные строки.)

**3.5** Найти:
```js
function listView(rows) {
```
заменить на:
```js
function listView(rows, past = []) {
```

**3.6** Конец `listView` — найти:
```js
        h('tbody', null, ...rows.map((r, i) => listRow(r, i))),
    );
}
```
заменить на:
```js
        h('tbody', null, ...rows.map((r, i) => listRow(r, i)),
            // QUEUE_FRESH_V1 — незавершённые прошлых дней: строка-кнопка внизу, свёрнуто.
            past.length ? pastGroupRow(past.length) : null,
            ...(past.length && state.pastOpen ? past.map((r, i) => listRow(r, rows.length + i)) : [])),
    );
}

// QUEUE_FRESH_V1 — заголовок группы «Незавершённые с прошлых дней · N»: шеврон
// системы (свёрнуто — вправо, раскрыто — вниз), как «Завершённые · N» в «Моём
// дне». Щелчок перерисовывает только список.
function pastGroupRow(n) {
    return h('tr', { 'data-past-group': '' },
        h('td', { colspan: '8', style: { padding: '8px 12px', background: 'var(--ink-25)' } },
            h('button', {
                type: 'button', class: 'btn btn-ghost btn-sm', 'data-past-toggle': '',
                'aria-expanded': state.pastOpen ? 'true' : 'false',
                onclick: () => { state.pastOpen = !state.pastOpen; paintBody(); },
            },
                h('span', { style: { display: 'inline-flex', transition: 'transform .15s', transform: state.pastOpen ? 'rotate(90deg)' : 'none' } },
                    Icon('ChevronRight', { size: 14 })),
                ' ', trf('Незавершённые с прошлых дней · {n}', { n }))));
}
```

**3.7** `public/js/admin/i18n-strings.js` — найти (добавлено в U2.4):
```js
  "Перечитать список приёмов": {"en":"Reload the appointment list","ru":"Перечитать список приёмов","uz":"Qabullar ro‘yxatini qayta yuklash"},   // QUEUE_FRESH_V1
```
заменить на:
```js
  "Перечитать список приёмов": {"en":"Reload the appointment list","ru":"Перечитать список приёмов","uz":"Qabullar ro‘yxatini qayta yuklash"},   // QUEUE_FRESH_V1
  "Незавершённые с прошлых дней · {n}": {"en":"Unfinished from previous days · {n}","ru":"Незавершённые с прошлых дней · {n}","uz":"Oldingi kunlardan yakunlanmaganlar · {n}"},   // QUEUE_FRESH_V1
```

- [ ] **Step 4: run — должен пройти**

```bash
C="public/js/admin/__tests__/queue-fresh-cabinet.test.mjs public/js/admin/__tests__/cabinet-queue-order.test.mjs public/js/admin/__tests__/refund-any-cabinet-queue.test.mjs public/js/admin/__tests__/head-doctor-cabinet.test.mjs public/js/admin/__tests__/doctor-dashboard.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS.

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
«Мои приёмы»: незавершённые строки прошлых дней — свёрнутой группой внизу «Активных» (QUEUE_FRESH_V1)

Рабочая строка (запланирована / в очереди / идёт приём) визита раньше
сегодняшнего местного дня больше не стоит среди сегодняшней работы: внизу
«Активных» — «Незавершённые с прошлых дней · N», свёрнуто; раскрывается,
строку можно открыть и завершить. В остальных фильтрах — как было. Каждое
открытие кабинета группу сворачивает. Строка, за которую касса вернула
деньги, в группу не попадает (как и в «Активные»). Решение владельца 2026-11-02.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/consultation.js public/js/admin/i18n-strings.js public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

### Task U2.6: «Мой день» — завершённый визит сразу в «Завершённые · N»

**Files:**
- Modify: `public/js/admin/views/doctor-dashboard.js`
- Test (modify): `public/js/admin/__tests__/queue-fresh-cabinet.test.mjs` — дописать в конец

Группа «Завершённые · N» в «Моём дне» уже есть (CABINET_ACTIVE_FIRST_V1, `foldDayColumn`): визит в ней, когда ВСЕ его строки врача `completed`. Ломалась не группа, а свежесть: дашборд читает день один раз на открытие кабинета. Здесь — строка дня получает статус из почты сразу.

- [ ] **Step 1: failing test** — дописать в конец `queue-fresh-cabinet.test.mjs`:

```js

// --- «Мой день» -------------------------------------------------------------
test('«Мой день»: подписанный приём сразу уходит в «Завершённые · N» — без F5', async (t) => {
  VISITS = BASE.filter((r) => r.status !== 'completed').map((r) => ({
    id: r.visit_id, visit_date: r.visits.visit_date, status: 'arrived', patient_id: r.visits.patient_id,
    service_id: 's-1', doctor_id: 'u-doc', sync_origin: null, duration_minutes: 30, room_id: null,
    patients: { id: r.visits.patient_id, mrn: r.visits.patients.mrn, full_name: r.visits.patients.full_name,
                last_name: r.visits.patients.last_name, first_name: r.visits.patients.first_name },
    services: { id: 's-1', name: 'Приём терапевта' }, rooms: null }));
  t.after(() => { VISITS = []; reseed(); });
  const root = await openWork();
  const dayCards = () => byClass(root, 'dd-appt');
  const doneHead = () => byClass(root, 'dd-done-h')[0];
  buttonByText(root, /Дашборд/).click();
  await tick(80);
  assert.ok(dayCards().some((c) => textOf(c).includes('Гаипов')), 'стенд: в «Моём дне» нет идущего приёма');
  assert.strictEqual(doneHead(), undefined, 'стенд: завершённых сегодня ещё нет');
  buttonByText(root, /Мои приёмы/).click();
  await tick(60);
  // Окно приёма подписало строку p1.
  setServerStatus('p1', 'completed');
  QF.noteLineStatus('p1', 'completed');
  buttonByText(root, /Дашборд/).click();   // сразу, без ожидания сервера
  assert.ok(doneHead() && textOf(doneHead()).includes('Завершённые · 1'), '«Мой день» не увёл завершённый приём в «Завершённые»');
  assert.ok(!dayCards().some((c) => textOf(c).includes('Гаипов')), 'завершённый приём остался в ленте дня');
  assert.ok(dayCards().some((c) => textOf(c).includes('Аминов')), 'незавершённые пропали из ленты');
  await tick(80);
  assert.ok(doneHead() && textOf(doneHead()).includes('Завершённые · 1'));
});
```

- [ ] **Step 2: run — должен упасть**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
```
Expected: FAIL 1 — ««Мой день» не увёл завершённый приём в «Завершённые»». Остальные 8 — PASS.

- [ ] **Step 3: implement** — `public/js/admin/views/doctor-dashboard.js`:

**3.1** Найти:
```js
import { loadRefundedLineIds } from '../refunded-lines.js';   // REFUND_ANY_V1 (ревью B4, п. 9c) — возвращённые строки не считаются
```
заменить на:
```js
import { loadRefundedLineIds } from '../refunded-lines.js';   // REFUND_ANY_V1 (ревью B4, п. 9c) — возвращённые строки не считаются
import { onLineStatus } from '../queue-fresh.js';   // QUEUE_FRESH_V1 — подписанный приём сразу «завершён» в «Моём дне» (один экземпляр: без ?v=)
```

**3.2** Найти:
```js
let openInpatientsRef = null;   // HEAD_DOCTOR_WARD_VIEW_V1
```
заменить на:
```js
let openInpatientsRef = null;   // HEAD_DOCTOR_WARD_VIEW_V1

// QUEUE_FRESH_V1 (3.21.0) — «МОЙ ДЕНЬ» НЕ ЖДЁТ F5. Окно приёма записало строке
// новый статус (queue-fresh.js): строка дня меняется сразу, и завершённый визит
// уходит в «Завершённые · N» при первом же показе дашборда — buildDayColumn
// считает визит завершённым, когда завершены все его строки, а дашборд рисуется
// из этого состояния. Сам дашборд здесь не перерисовывается (панель кабинета
// сейчас скрыта) и день не перечитывает: числа денег обновит его «Обновить» или
// новое открытие кабинета. Экспорт — для проверки.
export function noteDashLineStatus(lineId, status) {
    let hit = false;
    for (const s of state.services) if (String(s.id) === String(lineId)) { s.status = String(status); hit = true; }
    return hit;
}
onLineStatus(noteDashLineStatus);
```

- [ ] **Step 4: run — должен пройти** (итоговый прогон U1 + U2)

```bash
C="public/js/admin/__tests__/queue-fresh-cabinet.test.mjs public/js/admin/__tests__/queue-fresh-sign.test.mjs public/js/admin/__tests__/queue-fresh.test.mjs public/js/admin/__tests__/print-visit-date.test.mjs public/js/admin/__tests__/print-visit-date-cabinet.test.mjs public/js/admin/__tests__/doctor-dashboard.test.mjs public/js/admin/__tests__/doctor-pay.test.mjs public/js/admin/__tests__/cabinet-queue-order.test.mjs public/js/admin/__tests__/refund-any-cabinet-queue.test.mjs public/js/admin/__tests__/head-doctor-cabinet.test.mjs public/js/admin/__tests__/cabinet-self-doctor.test.mjs public/js/admin/__tests__/admin-doctor-local.test.mjs public/js/admin/__tests__/app-shell.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs"
node --experimental-vm-modules --test $C
node --import "$FE" --experimental-vm-modules --test $C
```
Expected: PASS, ни одного ✖.

- [ ] **Step 5: commit** — `.git/U12_MSG.txt` (Write):
```
«Мой день»: подписанный приём сразу в «Завершённые · N» (QUEUE_FRESH_V1)

Дашборд читает день один раз на открытие кабинета, и после «Завершить приём»
визит стоял в ленте дня до F5. Теперь строка дня получает статус из почты
queue-fresh.js сразу; группа «Завершённые · N» (CABINET_ACTIVE_FIRST_V1)
считает визит завершённым при первом же показе. День не перечитывается —
деньги обновит «Обновить» дашборда или новое открытие кабинета.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```
```bash
git diff --cached --quiet || { echo "В индексе уже что-то есть — остановитесь"; exit 1; }
git add public/js/admin/views/doctor-dashboard.js public/js/admin/__tests__/queue-fresh-cabinet.test.mjs
git diff --cached --stat
git commit -F .git/U12_MSG.txt
```

---

## Поправки к дизайну (проверено по коду)

1. **«Тип визита» по `price_tier` может честно сказать только «второй» и «повторный».** `price_tier = 'primary'` ставится и услугам БЕЗ ступеней цены (`domain/visit-tier.js` `tierFor` → `'no_tiers'`), то есть первичного приёма не доказывает; у консультаций (`consultation_type_id`) `price_tier` всегда `NULL` (мастер: `price_tier: isConsult ? null : …`, окно визита: `isConsultPick(service) ? null : …`). Поэтому план печатает «Тип визита» только для `'secondary'` («Второй визит») и `'repeat'` («Повторный визит»); первичная ступень и консультации — без строки («нет данных — строки нет»). Если владелец хочет «Первичный / Повторный приём» и на консультациях — настоящий источник есть: `consultation_types.api_kind` (`initial`/`repeat`); для этого в `schema-registry.js` у присоединения `visit_services → consultation_types` (~:399, колонки `['id','name','name_ru','name_uz','price']`) нужно добавить `api_kind` и прочитать его в очереди. В этот план не входит — решение за владельцем.
2. **«Флаг, который проверяет экран» — через `ctx.onPayload`, а он срабатывает только на переход С payload.** Окно приёма возвращалось `onNavigate('consultation')` без payload — такой переход кэшированной панели ничего не говорит. План меняет возврат после подписи и «Паузу» на `{ sub: 'work' }` (панель кабинета, из которой открыт приём, всегда на вкладке `work`; выпавшая из кэша открывается сразу на «Моих приёмах», а не на дашборде). Возврат пунктом меню или кнопкой «Назад» браузера `onPayload` не вызывает (`skipHistory`) — там список строк обновлён сразу почтой (`paintBody`), а плитки и перечитывание с сервера — при следующем переходе на вкладку, «Обновить» или новом открытии кабинета.
3. **«Мой день: завершённые сразу уходят в «Завершённые · N»» — группа уже есть** (CABINET_ACTIVE_FIRST_V1). Чинится свежесть: строка дня получает статус из почты. День при этом не перечитывается: перечитывание «на лету» из `renderDoctorDashboard` рисовало бы полузагруженное состояние (`loadDoctorDashboard` обнуляет `payLines` в начале) — плитки денег мигали бы нулём.
4. **Плитка «В очереди / готовы к осмотру» и «Показано N» продолжают считать строки прошлых дней** — они в свёрнутой группе под той же плиткой, правило «число = строк под ним» (CABINET_ACTIVE_FIRST_V1) сохраняется вместе с группой.
5. **Раздел «К» (окно кассы «Платежи»).** U1/U2 строк визита и счетов не пишут — только читают, поэтому К6 для них сводится к поведению: «Заменить услугу» меняет услугу и `price_tier` в ТОЙ ЖЕ строке (`billing.js` `swapPaidLineTx`) — кабинет покажет новую услугу и её «Тип визита» после возврата/«Обновить»; «Вернуть эту услугу и выставить новую» даёт новую строку — она приходит тем же перечитыванием; строка, за которую касса вернула деньги (REFUND_ANY_V1), не бывает ни в «Активных», ни в группе прошлых дней (фильтр `inStatusFilter` убирает её раньше `splitPastOpen`; закреплено в тесте группы U2.5), подписать её нельзя — значит, и сообщения о ней нет.

## Risks / implementer must check

- **Общие строки с другими задачами выпуска.** U1/U2 правят строки импорта в `service-workspace.js` (`doc-variants.js?v=cabr3`, `cabinet-doc.js`, `refunded-line.js`), `consultation.js` (`refunded-lines.js`, строку `select` очереди), `doctor-dashboard.js` (`refunded-lines.js`) и словарь после `"Завершённые · {n}"`. Задачи U3/U8/U10b, привязанные к тем же строкам, после U1–U2 должны искать место по смыслу, не перетирая добавленное здесь.
- **`queue-fresh.js` — только `'../queue-fresh.js'` без `?v=`** во всех трёх импортах; иначе второй экземпляр, и подписанный приём молча не доходит до кабинета (тест `queue-fresh-sign` проверяет текст импорта окна приёма).
- **Поиск и период кабинета живут в модуле между открытиями** (было и раньше); тесты `queue-fresh-cabinet` возвращают их в `t.after` — при дописывании своих проверок в этот файл делать так же.
- **Карта пациента, подписанная запись без архивной копии** (`patient-card.js` `printWsDoc`, WS_DERIVED_DOCS_V1) по-прежнему датируется последней подписью (`last.savedAt`) — бывает, только если архивная копия при подписи не записалась; в U1 не входит.
- **Побочный (желательный) эффект U1.1:** листы диагностики из `patient-documents.js` `printConclusion` и `case-file-tabs.js` передавали `issueDate`, а бланк его не читал и печатал сегодня — теперь они печатают свою дату.
- Тесты U1 задают `process.env.TZ = 'Asia/Tashkent'` до первого `Date` (динамические импорты после) — не переносить импорты наверх статическими.

## Manual check for the owner

1. Кабинет врача → открыть приём вчерашнего (или более раннего) дня → «Печать»: в шапке листа — день приёма, не сегодня; подписать и перепечатать из карты пациента («Документы») — та же дата; то же у листа УЗИ/диагностики. «Тип визита» на листе — только у второго/повторного визита по услуге со ступенями цены.
2. «Завершить приём» → кабинет: пациент сразу в «Завершённые», не «Идёт приём»; «Сохранить» без завершения — остаётся «Идёт приём» сверху; «Обновить» не сбрасывает фильтр и поиск; вчерашние незавершённые — внизу «Активных» свёрнутой группой; во вкладке «Дашборд» — визит в «Завершённые · N».
