# U5 + U6. Нет времени сегодня — день выбирает регистратор (PICK_DAY_V1); новые услуги — в неоплаченный счёт (INVOICE_APPEND_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal.** U5: мастер визита (он же «Добавить услуги» после регистрации пациента, карта пациента и «Направить на услуги» врача) и калькулятор услуг ставят врачебной строке время сами ТОЛЬКО сегодня; нет времени сегодня — у строки нет дня, красная пометка «Сегодня у врача нет свободного времени», кнопки «Ближайшее: вт 3 ноября 09:00» и «Выбрать день», дальше шаг не пройти; смета на разные дни — заметное «Услуги на 2 дня → 2 визита, 2 счёта» и «Всё на один день». U6: `create_invoice_for_visit` дописывает новые строки в «редактируемый счёт пациента» визита (тот же номер, новая сумма, ответ `appended: true`); экраны говорят «Добавлено в счёт № … — новая сумма …» и печатают обновлённый счёт.

**Architecture.**
- U5 — чистый модуль `public/js/admin/views/pick-day.js` (подписи, поиск ближайшего слота, предупреждение о днях; один на мастер и калькулятор). `visit-wizard.js`: `autoPickSlot` — только сегодня, метка `line.ui.noToday`; `nearestSlot`/`pickNearest`/`needsDay`/`noTodayControls` (в строке каталога и в смете); `nextBlockReason` не пускает дальше; услуге без врача (`dateOnly`) слот единственного исполнителя больше не подбирается; в смете — `data-many-days` и «Всё на один день» (`moveAllToOneDay`). `service-picker-modal.js`: `catPickDoc` — только первый день окна, `catNoToday` (пометка, «Ближайшее», «Выбрать день»), в смете «Визит — вт 3 ноября: все услуги сметы в этот день», когда визит калькулятора (`cartVisitDateIso`) не сегодня; старый трёхколоночный `autoPickSlot` — только день окна.
- U6 — `server/services/rpc/billing.js` `issueVisitInvoice`: после оценки строк и проверки плательщика — `appendTargetInvoice` (пациенту, `unpaid`, `paid_amount = 0`, без платежей в истории, своё здание, не госпитализация, не DEP-/CARD-) и `appendToVisitInvoice` (позиции, `manual_discount`/`manual_base` = прежний остаток + остаток новой части, `repriceUnpaidInvoice(absolute)`, журнал счёта `line_add`). Номер счёта берётся только для нового счёта. Бесплатная новая часть — своим счётом (как прежде). Клиент: `public/js/admin/invoice-append.js` (`isAppended`, `invoiceAppendNote`, `appendedPartDiscount`) и пять дверей: мастер, быстрая регистрация (`walk-in-booking.js` + `fast-registration.js`), калькулятор, окно визита, «Счёт визита».

**Состояние на старте:** ветка `rc/3.21.0`, HEAD 347bfd3d (+ 5fa59531 — раздел К описания, только документ; его К2/К6 учтены в U6.1), порядок выпуска U1 → U2 → U4 → U7 → **U5 → U6** → U9 → … . Номера строк ниже приблизительные — каждая правка привязана к ТЕКСТУ «было». U1/U2/U4/U7 правят другие файлы, но `i18n-strings.js` трогают все: блоки словаря этой задачи вставляются сразу после строки `export const STRINGS = {` (она одна), каждый своим куском.

**Проверено на копии 347bfd3d** (весь код и все тесты ниже прогнаны): 2 814 тестов затронутых наборов — зелёные (плюс 4 правки чужих ожиданий из U6.1 и одна строка `print-auto.test.mjs` из U6.5); новые тесты на русской и на английской предзагрузке.

## Карта файлов

| Файл | Задача | Что |
|---|---|---|
| `public/js/admin/views/pick-day.js` | U5.1 | новый: `slotWhenLabel`, `dayWhenLabel`, `nearestFree`, `noFreeText`, `nearestButtonText`, `manyDaysWarning`, `visitDayNote`, `localIsoDay` |
| `public/js/admin/__tests__/pick-day.test.mjs` | U5.1 | новый |
| `public/js/admin/i18n-strings.js` | U5.1, U6.2 | блоки `// PICK_DAY_V1` (9 фраз) и `// INVOICE_APPEND_V1` (3 фразы) |
| `public/js/admin/views/visit-wizard.js` | U5.2, U5.3, U6.3 | автовыбор только сегодня, пометка, блок шага, `dateOnly`, «Всё на один день»; тост и потолок баланса/карты |
| `public/js/admin/__tests__/pick-day-wizard.test.mjs` | U5.2, U5.3, U6.3 | новый (стенд — копия `wizard-booking.test.mjs`) |
| `public/js/admin/__tests__/wizard-booking.test.mjs` | U5.2 | помощник `openWizardReadyWith` жмёт «Ближайшее» (иначе тест зависит от часа запуска) |
| `public/js/admin/views/service-picker-modal.js` | U5.4, U6.5 | `catPickDoc`, `catNoToday`, «Визит — …», старый `autoPickSlot`; тост и печать дописанного счёта, потолок карты |
| `public/js/admin/__tests__/pick-day-calculator.test.mjs` | U5.4 | новый (стенд — копия `picker-attach-package-day.test.mjs`) |
| `server/services/rpc/billing.js` | U6.1 | `appendTargetInvoice`, `appendToVisitInvoice`, ветка в `issueVisitInvoice` |
| `server/services/rpc/billing.invoice-append.test.js` | U6.1 | новый |
| `server/services/rpc/billing.refbill-review.test.js`, `cashier.coverage.test.js`, `cashier.test.js`, `invoice-delete.test.js` | U6.1 | правка ожиданий: второй счёт того же неоплаченного визита больше не появляется |
| `public/js/admin/invoice-append.js` | U6.2 | новый |
| `public/js/admin/__tests__/invoice-append.test.mjs` | U6.2 | новый |
| `public/js/admin/views/walk-in-booking.js`, `views/fast-registration.js` | U6.4 | `appended`/`appendedDiscount`; тост, итог своих строк, печать всего счёта |
| `public/js/admin/__tests__/walk-in-append.test.mjs` | U6.4 | новый |
| `public/js/admin/__tests__/fast-registration.test.mjs` | U6.4 | +1 переменная стенда, +1 тест |
| `public/js/admin/views/visit-modal.js`, `views/visit-bill.js` | U6.5 | тост, без второго «создан» в журнале |
| `public/js/admin/__tests__/picker-invoice.test.mjs`, `print-auto.test.mjs` | U6.5 | +2 теста; `CALLERS['service-picker-modal.js'].view` 2 → 3 |

## Правила

- Все команды — из корня `C:\Users\user\Desktop\implementation workflow\easymed.api5` (Git Bash). Тесты — только перечисленные файлы: `node --experimental-vm-modules --test <файлы>`. Наборы мастера/калькулятора идут по 1–3 минуты на файл (каждый тест поднимает базу с миграциями) — это нормально.
- Английская предзагрузка (на GitHub тесты идут на en-US): `--import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"` — в U5.5 и U6.6.
- Правки — инструментами Edit/Write (не heredoc в Bash: он ест обратную косую черту). Перед `git add` — `git diff --cached --name-only` пуст; добавлять только названные файлы. Сообщение коммита пишется инструментом Write в `.git/U5_MSG.txt` / `.git/U6_MSG.txt` (внутри `.git`, в индекс не попадает) и коммитится `git commit -F <файл>`; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Маркер в русском комментарии у каждой правки: `PICK_DAY_V1` / `INVOICE_APPEND_V1`. Тексты экрана — ключи `i18n-strings.js` (ru/uz/en, в uz/en без кириллицы); значки — только `Icon()` (`Warning`, `Calendar` есть в `icon-map.js`).
- `server/services/branch-sync/records-e2e.test.js` на чистой копии 347bfd3d в этом окружении падает 11 тестами и без этих правок (окружение релея): перед U5.1 прогнать его один раз и записать число падений — в U6.6 сравнить с ним, а не требовать зелёным.

---

## U5. Нет времени сегодня — регистратор выбирает день (PICK_DAY_V1)

**Сверено с кодом.**
- `visit-wizard.js` `autoPickSlot` (~:1514) перебирал 14 дней; звали его `addToCart` (единственный исполнитель, ~:1579), выбор врача в строке каталога (`pickDoc`, ~:1191), выбор врача в смете (~:2272) и подстановка из заявки CRM (~:864). Услуги без врача (`dateOnly`, ~:1569) — сегодня; корзина делится по `lineDay` (~:2692), `ensure_visit` и счёт — на каждый день.
- **Ещё одна дверь автопереноса, которой нет в описании:** услуга БЕЗ врача (`requires_doctor = 0`), у которой в «Услугах и ставках» отмечен ровно один исполнитель, получала `doctorId` и тот же `autoPickSlot` — её `when` становилось временем слота этого исполнителя, часто завтра, хотя `dateOnly` оставался `true`. Анализ уезжал на завтра вторым визитом. U5.2 закрывает и её (тест «ЭКГ остаётся сегодня»).
- Калькулятор (`service-picker-modal.js`, режим `calculator`): `catPickDoc` (~:1998) перебирал 7 дней `catDays()`; визит один, его день — самая ранняя строка со временем (`cartVisitDateIso`, ~:2609), строки без врача уходят в тот же день. Режим `attachMode` (окно визита) — `catDays()` уже один день (день визита), правило «первый день окна» для него — прежнее поведение. Трёхколоночный `autoPickSlot` (~:1154) — только при `showSchedule` без `calculator/attachMode`; сейчас такого вызова нет (окно визита идёт `attachMode`), правится для единства правила.
- К6 (окна кассы «Платежи»): U5 меняет только ДЕНЬ и время строк до записи; строки счёта, замену и возврат не трогает.
- **Без изменений (проверено):** быстрая регистрация (`walk-in-booking.js` — «пришёл сейчас», `book:` не шлёт, дата — сейчас; каталог в ней `requireSlot: false`), карточка CRM (`crm.js` ~:2848 `paintTime` — день выбирает оператор, автоподбора дня нет), заявки API (`crm-api-booking.js` — день из поля), календарь (`room-calendar.js` → калькулятор с `lockedDoctor` + `scheduledISO`: время задано кликом), кабинет врача («Добавить» — `requireSlot: false`). «Повторный визит» кабинета — U8.

### Task U5.1: модуль `pick-day.js` и словарь

**Files:**
- Create: `public/js/admin/views/pick-day.js`
- Create: `public/js/admin/__tests__/pick-day.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/pick-day.test.mjs`:

```js
// PICK_DAY_V1 — подписи и поиск ближайшего слота (views/pick-day.js): одни на
// мастер визита и калькулятор услуг.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// I18N_LOCALE_PIN_V1 — русский ДО импорта (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {} };   // i18n.js ставит documentElement.lang
globalThis.window = { dispatchEvent() {} };        // setLang шлёт 'langchange'
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { slotWhenLabel, dayWhenLabel, nearestFree, noFreeText, nearestButtonText, manyDaysWarning, visitDayNote } = await import('../views/pick-day.js');
const { setLang } = await import('../i18n.js');

test('«вт 3 ноября 09:00» — день недели, число, месяц словом и время', () => {
  assert.equal(slotWhenLabel('2026-11-03', 9 * 60), 'вт 3 ноября 09:00');
  assert.equal(slotWhenLabel('2026-11-08', 14 * 60 + 30), 'вс 8 ноября 14:30');
  assert.equal(dayWhenLabel('2026-12-01'), 'вт 1 декабря');
  assert.equal(nearestButtonText('2026-11-03', 540), 'Ближайшее: вт 3 ноября 09:00');
  assert.equal(visitDayNote('2026-11-03'), 'Визит — вт 3 ноября: все услуги сметы в этот день');
});

test('nearestFree — первый день списка, где есть свободное, и первое время в нём', () => {
  const free = { '2026-11-03': [], '2026-11-04': [600, 630], '2026-11-05': [540] };
  assert.deepEqual(nearestFree(Object.keys(free), (d) => free[d]), { iso: '2026-11-04', min: 600 });
  assert.equal(nearestFree(['2026-11-03'], (d) => free[d]), null);
  assert.equal(nearestFree([], () => [1]), null);
});

test('предупреждение о днях: 2–4 — «дня», 5 и больше — «дней»; один день — пусто', () => {
  assert.equal(manyDaysWarning(1), '');
  assert.equal(manyDaysWarning(2), 'Услуги на 2 дня → 2 визита, 2 счёта');
  assert.equal(manyDaysWarning(4), 'Услуги на 4 дня → 4 визита, 4 счёта');
  assert.equal(manyDaysWarning(5), 'Услуги на 5 дней → 5 визитов, 5 счетов');
  assert.equal(manyDaysWarning(12), 'Услуги на 12 дней → 12 визитов, 12 счетов');
});

test('пометка: сегодня — «Сегодня…», день визита — «В этот день…»', () => {
  assert.equal(noFreeText(true), 'Сегодня у врача нет свободного времени');
  assert.equal(noFreeText(false), 'В этот день у врача нет свободного времени');
});

test('узбекский и английский — без кириллицы', () => {
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    try {
      for (const s of [nearestButtonText('2026-11-03', 540), manyDaysWarning(2), manyDaysWarning(7), noFreeText(true), noFreeText(false), visitDayNote('2026-11-03')]) {
        assert.ok(!/[А-Яа-яЁё]/.test(s), lang + ': ' + s);
      }
    } finally { setLang('ru'); }
  }
});
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day.test.mjs
```

Ожидается: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/public/js/admin/views/pick-day.js'`, `ℹ fail 1`.

- [ ] **Step 3: implement** — создать `public/js/admin/views/pick-day.js`:

```js
// PICK_DAY_V1 (решение владельца 2026-11-02) — НЕТ ВРЕМЕНИ СЕГОДНЯ — ДЕНЬ
// ВЫБИРАЕТ РЕГИСТРАТОР.
//
// Мастер визита и калькулятор услуг сами ставили врачебной строке первый
// свободный слот за две недели. Вечером, в выходной врача или при занятом дне
// строка молча уезжала на завтра, а услуги без врача оставались сегодня —
// корзина делилась по дню на два визита и два счёта (на копии dev — все 12
// случаев «одна регистрация — два счёта»), и единственным сигналом было
// «(визитов: N)» на шаге подтверждения.
//
// Теперь автовыбор — только сегодня. Нет свободного времени сегодня — у строки
// нет ни дня, ни времени, красная пометка и две кнопки: «Ближайшее: вт 3 ноября
// 09:00» (ставит ближайший слот) и «Выбрать день». Дальше шаг не пройти, пока
// день не выбран или строка не убрана.
//
// Чистый модуль: подписи и поиск ближайшего слота одни на оба окна (мастер и
// калькулятор), и проверяются без DOM.
import { tr, trf, monthName } from '../i18n.js';

// Сокращения дней недели — ключи словаря (те же, что у дней калькулятора).
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Местный день 'ГГГГ-ММ-ДД' без toISOString (в UTC+5 полночь уехала бы на вчера). */
export function localIsoDay(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** «вт 3 ноября» — местный день на языке интерфейса. @param {string} dayIso 'ГГГГ-ММ-ДД' */
export function dayWhenLabel(dayIso) {
    const [y, m, d] = String(dayIso).split('-').map(Number);
    const day = new Date(y, m - 1, d);
    return tr(WD[day.getDay()]).toLowerCase() + ' ' + day.getDate() + ' ' + monthName(day.getMonth());
}

/**
 * «вт 3 ноября 09:00» — день и время предложенного слота на языке интерфейса.
 * @param {string} dayIso 'ГГГГ-ММ-ДД' — местный день
 * @param {number} minutes минуты от местной полуночи
 */
export function slotWhenLabel(dayIso, minutes) {
    const mins = Math.max(0, Math.round(Number(minutes) || 0));
    return dayWhenLabel(dayIso) + ' ' + pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60);
}

/** «Визит — вт 3 ноября: все услуги сметы в этот день» — калькулятор, визит не сегодня. */
export function visitDayNote(dayIso) {
    return trf('Визит — {day}: все услуги сметы в этот день', { day: dayWhenLabel(dayIso) });
}

/**
 * Первый свободный слот среди дней (по порядку списка): { iso, min } или null.
 * @param {string[]} dayIsos дни-кандидаты, ближайший первым
 * @param {(iso: string) => number[]} freeOf свободные начала дня (минуты), уже без занятого сметой
 */
export function nearestFree(dayIsos, freeOf) {
    for (const iso of dayIsos || []) {
        const free = (typeof freeOf === 'function' ? freeOf(iso) : null) || [];
        if (free.length) return { iso, min: free[0] };
    }
    return null;
}

/** Красная пометка строки: сегодня — «Сегодня…», другой день (окно визита) — «В этот день…». */
export function noFreeText(isToday) {
    return isToday ? tr('Сегодня у врача нет свободного времени') : tr('В этот день у врача нет свободного времени');
}

/** «Ближайшее: вт 3 ноября 09:00» — подпись кнопки, которая ставит этот слот. */
export function nearestButtonText(dayIso, minutes) {
    return trf('Ближайшее: {when}', { when: slotWhenLabel(dayIso, minutes) });
}

/**
 * «Услуги на 2 дня → 2 визита, 2 счёта» — предупреждение мастера, когда смета
 * разложится по разным дням (визит = один день, счёт — на визит).
 * Пустая строка — день один, предупреждать не о чем.
 */
export function manyDaysWarning(n) {
    const k = Number(n) || 0;
    if (k < 2) return '';
    const few = k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14);
    return few
        ? trf('Услуги на {n} дня → {n} визита, {n} счёта', { n: k })
        : trf('Услуги на {n} дней → {n} визитов, {n} счетов', { n: k });
}
```

В `public/js/admin/i18n-strings.js` — Edit, «было»:

```js
export const STRINGS = {
```

«стало»:

```js
export const STRINGS = {
  // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор (views/pick-day.js, visit-wizard.js, service-picker-modal.js)
  "Сегодня у врача нет свободного времени": {"en":"The doctor has no free time today","ru":"Сегодня у врача нет свободного времени","uz":"Bugun shifokorning bo‘sh vaqti yo‘q"},   // PICK_DAY_V1
  "В этот день у врача нет свободного времени": {"en":"The doctor has no free time on this day","ru":"В этот день у врача нет свободного времени","uz":"Bu kuni shifokorning bo‘sh vaqti yo‘q"},   // PICK_DAY_V1
  "Ближайшее: {when}": {"en":"Nearest: {when}","ru":"Ближайшее: {when}","uz":"Eng yaqini: {when}"},   // PICK_DAY_V1
  "Выбрать день": {"en":"Choose a day","ru":"Выбрать день","uz":"Kunni tanlash"},   // PICK_DAY_V1
  "Услуги на {n} дня → {n} визита, {n} счёта": {"en":"Services on {n} days → {n} visits, {n} invoices","ru":"Услуги на {n} дня → {n} визита, {n} счёта","uz":"Xizmatlar {n} kunga → {n} ta tashrif, {n} ta hisob"},   // PICK_DAY_V1
  "Услуги на {n} дней → {n} визитов, {n} счетов": {"en":"Services on {n} days → {n} visits, {n} invoices","ru":"Услуги на {n} дней → {n} визитов, {n} счетов","uz":"Xizmatlar {n} kunga → {n} ta tashrif, {n} ta hisob"},   // PICK_DAY_V1
  "Всё на один день": {"en":"All on one day","ru":"Всё на один день","uz":"Hammasi bir kunga"},   // PICK_DAY_V1
  "сегодня у врача нет свободного времени — выберите день или уберите услугу": {"en":"the doctor has no free time today — choose a day or remove the service","ru":"сегодня у врача нет свободного времени — выберите день или уберите услугу","uz":"bugun shifokorning bo‘sh vaqti yo‘q — kunni tanlang yoki xizmatni olib tashlang"},   // PICK_DAY_V1
  "Визит — {day}: все услуги сметы в этот день": {"en":"Visit — {day}: all services in the estimate on this day","ru":"Визит — {day}: все услуги сметы в этот день","uz":"Tashrif — {day}: smetadagi barcha xizmatlar shu kuni"},   // PICK_DAY_V1
```

(Дни недели `Вс`…`Сб` в словаре уже есть — стр. ~5476–5551.)

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs
```

Ожидается: `ℹ fail 0` (pick-day — 5 тестов).

- [ ] **Step 5: commit** — Write `.git/U5_MSG.txt`:

```
PICK_DAY_V1: общий модуль «нет времени сегодня» — подписи «Ближайшее: вт 3 ноября 09:00», поиск ближайшего слота, «Услуги на 2 дня → 2 визита, 2 счёта»; словарь ru/uz/en

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/pick-day.js public/js/admin/__tests__/pick-day.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/U5_MSG.txt
```

### Task U5.2: мастер визита — время само только сегодня, пометка и выбор дня, шаг не пройти

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js`
- Create: `public/js/admin/__tests__/pick-day-wizard.test.mjs`
- Modify: `public/js/admin/__tests__/wizard-booking.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/pick-day-wizard.test.mjs` (стенд скопирован из `wizard-booking.test.mjs`: поддельный DOM, настоящий реестр RPC и SQLite; врач НЕ работает в сегодняшний день недели — сегодня окон нет при любом часе запуска, ближайшее — завтра 10:00):

```js
// PICK_DAY_V1 (решение владельца 2026-11-02) — НЕТ ВРЕМЕНИ СЕГОДНЯ — ДЕНЬ
// ВЫБИРАЕТ РЕГИСТРАТОР.
//
// Мастер визита (visit-wizard.js) ставил врачебной строке первый свободный слот
// за 14 дней: вечером или в выходной врача строка молча уходила на завтра, а
// услуги без врача оставались сегодня — смета делилась на два визита и два
// счёта (на dev — все 12 случаев «одна регистрация — два счёта»).
//
// Стенд — тот же, что у wizard-booking.test.mjs: поддельный DOM, а за
// поддельным fetch — настоящий реестр RPC и настоящая SQLite после миграций
// (calendar_slots считает настоящий slot-engine). Врач НЕ работает в
// сегодняшний день недели — значит, сегодня у него нет ни одного окна при
// любом часе запуска, а ближайшее — завтра в 10:00.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM (как в wizard-booking.test.mjs) ─────────────────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() {
    const s = this;
    return {
      contains: (c) => String(s.className).split(/\s+/).includes(c),
      add(c) { if (!String(s.className).split(/\s+/).includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = String(s.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle() {},
    };
  }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
// I18N_LOCALE_PIN_V1 — русский ДО импорта видов (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
const RPC = [];

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    stampWriteBody(DB, body);
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'select') {
        const rows = DB.prepare(sql).all(...params);
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
      }
      if (meta.op === 'insert') {
        const info = DB.prepare(sql).run(...params);
        if (!meta.returning) return ok(null);
        const row = DB.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        if (meta.single === 'single') return ok(row);
        if (meta.single === 'maybe') return ok(row ?? null);
        return ok([row]);
      }
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { forgetSlots } = await import('../views/service-picker-modal.js');
const { nearestButtonText, manyDaysWarning } = await import('../views/pick-day.js');

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const localDayOfIso = (iso) => isoOf(new Date(iso));

/**
 * todayOff — врач не работает в сегодняшний день недели (окон сегодня нет при
 * любом часе запуска); иначе — работает каждый день с from до to.
 * 21 — консультация (нужен врач), 22 — анализ (без врача), 23 — ЭКГ без врача,
 * но с единственным назначенным исполнителем (врач 7, «Услуги и ставки»).
 */
function seed({ todayOff = true, from = '10:00', to = '16:00' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const todayKey = WD[new Date().getDay()];
  const wh = {};
  for (const k of WD) wh[k] = { enabled: !(todayOff && k === todayKey), from, to };
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?,?)")
    .run(JSON.stringify(wh), JSON.stringify([{ service_id: 23, pct: 10 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, requires_doctor) VALUES (21,'Консультация терапевта',100000,30,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  db.prepare("INSERT INTO services (id, name, price, requires_doctor) VALUES (23,'ЭКГ',50000,0)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return db;
}

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const overlay = () => document.body.children.find(isWizard);
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));

async function openWizard(presetServiceIds) {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, { presetServiceIds });
  await flush(20); await wait(80); await flush(20);   // autoPickSlot → calendar_slots (настоящий)
  assert.ok(overlay(), 'мастер визита не открылся');
}

/** «Далее / Сформировать счёт» — как человек: выключенную кнопку браузер не нажимает. */
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = overlay();
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON' && !('disabled' in n.attrs))
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit')) break;
  }
  await wait(80); await flush(30);
}

test('нет времени сегодня: у строки врача нет дня, красная пометка, «Ближайшее: …» — завтра 10:00; дальше не пройти', async () => {
  seed();
  await openWizard([21]);
  const ov = overlay();
  assert.ok(textOf(ov).includes('Сегодня у врача нет свободного времени'), 'нет красной пометки: ' + textOf(ov).slice(0, 400));
  const near = byAttr(ov, 'data-pick-nearest', 21);
  assert.ok(near, 'нет кнопки «Ближайшее»');
  assert.equal(textOf(near).replace(/\s+/g, ' ').trim(), nearestButtonText(isoOf(dayOffset(1)), 10 * 60));
  assert.ok(byAttr(ov, 'data-pick-day', 21), 'нет кнопки «Выбрать день»');
  assert.ok(textOf(ov).includes('сегодня у врача нет свободного времени — выберите день или уберите услугу'), 'шаг не говорит, почему дальше нельзя');
  await pressUntilCreate();
  assert.ok(!RPC.some((c) => c.name === 'ensure_visit'), 'строка без дня ушла в запись');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits').get().n, 0, 'визит заведён молча на другой день');
});

test('«Ближайшее» ставит строке завтрашний слот — и визит записывается на завтра 10:00', async () => {
  seed();
  await openWizard([21]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  assert.ok(!textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'пометка осталась после выбора дня');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  const start = new Date(ev.body.book.start);
  assert.equal(isoOf(start), isoOf(dayOffset(1)));
  assert.deepEqual([start.getHours(), start.getMinutes()], [10, 0]);
});

test('«Выбрать день» открывает календарь врача: выбранный день ставит время, пометка уходит', async () => {
  seed();
  await openWizard([21]);
  const pick = walk(overlay()).filter((n) => n.attrs && n.attrs['data-pick-day'] === '21');
  assert.ok(pick.length, 'нет кнопки «Выбрать день»');
  pick[0].click();   // кнопка в строке каталога — первая
  await wait(80); await flush(20);
  const pop = walk(overlay()).find((n) => n.style && n.style.width === '252px' && n.style.display === '');
  assert.ok(pop, 'календарь врача не открылся');
  const tomorrow = dayOffset(1);
  if (tomorrow.getMonth() !== new Date().getMonth()) {   // завтра — уже следующий месяц
    walk(pop).find((n) => n.tagName === 'BUTTON' && textOf(n).trim() === '›').click();
    await wait(80); await flush(20);
  }
  // Кнопка дня: первая строка — число месяца, вторая — «N окн».
  const dayBtn = walk(pop).find((n) => n.tagName === 'BUTTON' && !('disabled' in n.attrs)
    && n.children[0] && textOf(n.children[0]).trim() === String(tomorrow.getDate()));
  assert.ok(dayBtn, 'в календаре нет завтрашнего дня с окнами');
  dayBtn.click();
  await flush(20);
  assert.ok(!byAttr(overlay(), 'data-no-today'), 'пометка осталась после выбора дня');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи');
  assert.equal(isoOf(new Date(ev.body.book.start)), isoOf(tomorrow));
});

test('время сегодня есть — берётся сегодняшнее; на другой день строка сама не уходит никогда', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  await openWizard([21]);
  const ov = overlay();
  if (textOf(ov).includes('Сегодня у врача нет свободного времени')) {
    // Часы клиники на сегодня уже кончились: окон нет — и строка без дня, а не на завтра.
    await pressUntilCreate();
    assert.ok(!RPC.some((c) => c.name === 'ensure_visit'));
    return;
  }
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.equal(isoOf(new Date(ev.body.book.start)), isoOf(new Date()), 'время поставлено не на сегодня');
});

test('услуга без врача с единственным исполнителем остаётся сегодня — день врача ей не ставится', async () => {
  seed();   // врач 7 сегодня не работает; ЭКГ (23) назначена ему одному
  await openWizard([23]);
  assert.ok(!textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'услуге без врача не нужен день врача');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.ok(!ev.body.book, 'услуга без врача заняла время врача');
  assert.equal(localDayOfIso(ev.body.date), isoOf(new Date()), 'ЭКГ уехала на день врача');
});

test.after(() => { if (DB) DB.close(); DB = null; });
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day-wizard.test.mjs
```

Ожидается (проверено на 347bfd3d + U5.1): `✖ нет времени сегодня…` — `AssertionError: нет красной пометки: … 3 ноя · 12 окн. …` (мастер сам поставил завтра); `✖ «Ближайшее» ставит…` — `TypeError: Cannot read properties of undefined (reading 'click')`; `✖ «Выбрать день»…` — `нет кнопки «Выбрать день»`; `✖ услуга без врача…` — `ЭКГ уехала на день врача` (`actual: <завтра>`). Тест «время сегодня есть» вечером (после конца часов клиники) падает `время поставлено не на сегодня`, днём проходит — это страж, так и должно быть.

- [ ] **Step 3: implement** — `public/js/admin/views/visit-wizard.js`, шесть правок (Edit, «было» → «стало»).

3a. Импорт. «было»:

```js
import { actSheet, isDmsPayer } from './payer-act.js?v=act1';   // REFERRAL_BILL_V1 — акт плательщика одной сборкой с кассой
```

«стало»:

```js
import { actSheet, isDmsPayer } from './payer-act.js?v=act1';   // REFERRAL_BILL_V1 — акт плательщика одной сборкой с кассой
import { nearestFree, noFreeText, nearestButtonText } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
```

3b. `autoPickSlot` (~:1514). «было»:

```js
    async function autoPickSlot(line) {
        await loadBusy(line);   // прогреть у сервера 14 дней автоподбора
        if (line.booked) return;   // CRM_LINK_ALL_V1 (ред. 2) — у строки «из записи» время записи
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        for (let i = 0; i < 14; i++) {
            const day = d0.getTime() + i * 86400000;
            const slots = slotsForDay(line, day);
            if (slots.length) { line.ui.day = day; line.when = slotToLocalIso(slots[0]); return; }
        }
        line.when = null;
    }
```

«стало»:

```js
    // PICK_DAY_V1 (решение владельца 2026-11-02) — АВТОВЫБОР ТОЛЬКО НА СЕГОДНЯ.
    // Прежде здесь брался первый свободный слот за 14 дней: вечером, в выходной
    // врача или при занятом дне строка молча уезжала на завтра, услуги без врача
    // оставались сегодня, и смета делилась на два визита и два счёта (шапка
    // views/pick-day.js). Теперь: есть время сегодня — первое сегодняшнее; нет —
    // у строки нет ни дня, ни времени и метка ui.noToday: «Ближайшее: …» и
    // «Выбрать день» (noTodayControls), шаг не пройти (nextBlockReason).
    // 14 дней по-прежнему прогреваются — из них считается «Ближайшее».
    async function autoPickSlot(line) {
        await loadBusy(line);   // прогреть у сервера 14 дней: «Ближайшее» ищется в них
        if (line.booked) return;   // CRM_LINK_ALL_V1 (ред. 2) — у строки «из записи» время записи
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        const today = slotsForDay(line, d0.getTime());
        line.ui.day = d0.getTime();
        if (today.length) { line.when = slotToLocalIso(today[0]); line.ui.noToday = false; return; }
        line.when = null;
        line.ui.noToday = true;
    }

    /** PICK_DAY_V1 — ближайшее свободное время строки ПОСЛЕ сегодня (в прогретых 14 днях): { day, ms } или null. */
    function nearestSlot(line) {
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        const days = Array.from({ length: 13 }, (_, i) => d0.getTime() + (i + 1) * 86400000);
        const hit = nearestFree(days.map(isoDay), (iso) => slotsForDay(line, new Date(iso + 'T00:00:00').getTime())
            .map((ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); }));
        if (!hit) return null;
        const day = new Date(hit.iso + 'T00:00:00').getTime();
        return { day, iso: hit.iso, min: hit.min, ms: day + hit.min * 60000 };
    }

    /** PICK_DAY_V1 — «Ближайшее»: поставить строке ближайший слот. false — его нет. */
    function pickNearest(line) {
        const n = nearestSlot(line);
        if (!n) return false;
        line.ui.day = n.day;
        line.when = slotToLocalIso(n.ms);
        line.ui.noToday = false;
        return true;
    }

    /** PICK_DAY_V1 — у врачебной строки нет времени сегодня, и день ещё не выбран. */
    function needsDay(c) {
        return !!(c && c.ui && c.ui.noToday && !c.when && c.doctorId && !c.booked && !isLiveQueueDoc(c.doctorId));
    }

    /**
     * PICK_DAY_V1 — красная пометка строки и две кнопки: «Ближайшее: вт 3 ноября
     * 09:00» ставит ближайший слот, «Выбрать день» открывает календарь врача
     * (onPickDay — у каталога свой, у сметы свой).
     */
    function noTodayControls(line, onPickDay) {
        const near = nearestSlot(line);
        const after = () => { refreshTiers(); repaintRail(); if (wiz.step === 1) paint(); };
        return h('div', {
            'data-no-today': String(line.svc.id),
            style: { flexBasis: '100%', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '6px', padding: '8px 10px', borderRadius: '10px', background: 'var(--crit-50, #fef2f2)', border: '1px solid var(--crit-200, #fecaca)' },
        },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 700, color: 'var(--crit-700, #b91c1c)' } },
                Icon('Warning', { size: 13 }), noFreeText(true)),
            near ? h('button', {
                class: 'btn btn-sm btn-primary', type: 'button', 'data-pick-nearest': String(line.svc.id),
                onclick: () => { pickNearest(line); after(); },
            }, nearestButtonText(near.iso, near.min)) : null,
            h('button', {
                class: 'btn btn-sm btn-outline', type: 'button', 'data-pick-day': String(line.svc.id),
                onclick: onPickDay,
            }, Icon('Calendar', { size: 13 }), ' ', tr('Выбрать день')));
    }
```

(Все новые функции — объявления `function`: смета рисуется до того, как исполнение дойдёт сюда, — та же ловушка TDZ, что описана у `lineDuration`.)

3c. `addToCart` (~:1576): услуге без врача слот исполнителя не подбирается. «было»:

```js
        if (pool.length === 1) {
            line.doctorId = pool[0].id;
            if (isLiveQueueDoc(line.doctorId)) { line.when = null; repaintRail(); }
            else autoPickSlot(line).then(() => { repaintRail(); if (wiz.step === 1) paint(); });
        }
```

«стало»:

```js
        if (pool.length === 1) {
            line.doctorId = pool[0].id;
            if (isLiveQueueDoc(line.doctorId)) { line.when = null; repaintRail(); }
            // PICK_DAY_V1 — услуге без врача время врача не нужно: она «на дату»
            // (сегодня). Подбор слота единственного исполнителя ставил ей ДЕНЬ
            // этого слота — и анализ уезжал на завтра вторым визитом.
            else if (!line.dateOnly) autoPickSlot(line).then(() => { repaintRail(); if (wiz.step === 1) paint(); });
        }
```

3d. Пометка в строке каталога — конец `schedulePanel` (~:1358). «было»:

```js
                } else if (line.svc.requires_doctor && !line.doctorId) {
                    summary = h('span', { style: { fontSize: '12.5px', color: 'var(--crit-600, #dc2626)', whiteSpace: 'nowrap' } }, 'выберите врача');
                }

                return h('div', { style: { marginTop: '10px', borderTop: '1px dashed var(--ink-100)', paddingTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    docWrap, ...(liveQ ? [] : [dayWrap, timeSel]), summary);
```

«стало»:

```js
                } else if (line.svc.requires_doctor && !line.doctorId) {
                    summary = h('span', { style: { fontSize: '12.5px', color: 'var(--crit-600, #dc2626)', whiteSpace: 'nowrap' } }, 'выберите врача');
                }

                // PICK_DAY_V1 — сегодня у врача времени нет: пометка и выбор дня
                // прямо под строкой; «Выбрать день» открывает тот же календарь.
                const openCal = () => { if (calPop.style.display === 'none') dayBtn.click(); };
                if (line.ui.openCal) { line.ui.openCal = false; setTimeout(openCal, 0); }
                const noToday = !liveQ && needsDay(line) ? noTodayControls(line, openCal) : null;

                return h('div', { style: { marginTop: '10px', borderTop: '1px dashed var(--ink-100)', paddingTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    docWrap, ...(liveQ ? [] : [dayWrap, timeSel]), summary, noToday);
```

3e. Пометка в смете — цикл строк `repaintRail` (~:2240). «было»:

```js
                        style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--crit-500, #ef4444)', display: 'flex' },
                    }, Icon('X', { size: 13 })),
                ));
            }
            railEl.appendChild(list);
```

«стало»:

```js
                        style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--crit-500, #ef4444)', display: 'flex' },
                    }, Icon('X', { size: 13 })),
                ));
                // PICK_DAY_V1 — строка без времени сегодня видна и в смете: каталог
                // мог уйти на другой поиск. «Выбрать день» возвращает к её строке
                // каталога с открытым календарём врача.
                if (needsDay(c)) {
                    list.appendChild(noTodayControls(c, () => {
                        wiz.search = c.svc.name; wiz.cat = 'Все'; wiz.limit = PAGE_SIZE;
                        c.ui.openCal = true; wiz.step = 1; paint();
                    }));
                }
            }
            railEl.appendChild(list);
```

3f. Шаг не пройти — `nextBlockReason` (~:2633). «было»:

```js
            if (wiz.cart.length === 0) return 'добавьте хотя бы одну услугу';
            // SCHED_V1 — врачебной услуге нужны врач и слот прямо в карточке услуги
```

«стало»:

```js
            if (wiz.cart.length === 0) return 'добавьте хотя бы одну услугу';
            // PICK_DAY_V1 — сегодня у врача времени нет, а день не выбран: дальше
            // нельзя, пока регистратор не выберет день или не уберёт строку.
            if (wiz.cart.some(needsDay)) return 'сегодня у врача нет свободного времени — выберите день или уберите услугу';
            // SCHED_V1 — врачебной услуге нужны врач и слот прямо в карточке услуги
```

(`createVisit` перепроверяет шаги 1–3 тем же `nextBlockReason` — запись без дня невозможна и мимо кнопки.)

3g. `public/js/admin/__tests__/wizard-booking.test.mjs` — помощник `openWizardReadyWith`: его врач работает 10:00–16:00, и вечером сегодня окон нет. «было»:

```js
  item.dispatchEvent({ type: 'mousedown', preventDefault() {}, currentTarget: item });
  await wait(60); await flush(20);   // autoPickSlot → calendar_slots (настоящий) → время строки
  return { overlay: () => document.body.children.find(isWizard), day: s.day, dayIso: s.dayIso, saved: () => saved };
```

«стало»:

```js
  item.dispatchEvent({ type: 'mousedown', preventDefault() {}, currentTarget: item });
  await wait(60); await flush(20);   // autoPickSlot → calendar_slots (настоящий) → время строки
  // PICK_DAY_V1 — время ставится само только СЕГОДНЯ. Врач посева работает
  // 10:00–16:00: вечером сегодня окон нет, и строка ждёт выбора дня — стенд
  // жмёт «Ближайшее», как регистратор (иначе тест зависел бы от часа запуска).
  const near = walk(document.body.children.find(isWizard)).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-pick-nearest'] !== undefined);
  if (near) { near.click(); await flush(20); }
  return { overlay: () => document.body.children.find(isWizard), day: s.day, dayIso: s.dayIso, saved: () => saved };
```

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day-wizard.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/wizard-desk.test.mjs public/js/admin/__tests__/wizard-templates.test.mjs public/js/admin/views/doctor-refer-wizard.test.js public/js/admin/__tests__/i18n-coverage.test.mjs
```

Ожидается: `ℹ fail 0` (pick-day-wizard — 5 тестов). Без правки 3g вечером (после 16:00, когда окон врача посева сегодня уже нет) тесты `wizard-booking.test.mjs` «МАСТЕР: …» не доходят до `ensure_visit` и падают.

- [ ] **Step 5: commit** — Write `.git/U5_MSG.txt`:

```
PICK_DAY_V1: мастер визита ставит время сам только сегодня; нет времени — пометка «Сегодня у врача нет свободного времени», «Ближайшее: …» и «Выбрать день», дальше шаг не пройти; услуге без врача день исполнителя не ставится

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/visit-wizard.js public/js/admin/__tests__/pick-day-wizard.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs
git commit -F .git/U5_MSG.txt
```

### Task U5.3: мастер — «Услуги на 2 дня → 2 визита, 2 счёта» и «Всё на один день»

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js`
- Modify: `public/js/admin/__tests__/pick-day-wizard.test.mjs`

- [ ] **Step 1: failing test** — в `pick-day-wizard.test.mjs` Edit, «было»:

```js
test('«Выбрать день» открывает календарь врача: выбранный день ставит время, пометка уходит', async () => {
```

«стало» (новый тест перед ним):

```js
test('смета на два дня — «Услуги на 2 дня → 2 визита, 2 счёта»; «Всё на один день» сводит анализ к дню приёма: один визит, один счёт', async () => {
  seed();
  await openWizard([21, 22]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  const box = byAttr(overlay(), 'data-many-days', 2);
  assert.ok(box, 'нет предупреждения о двух днях');
  assert.ok(textOf(box).includes(manyDaysWarning(2)), textOf(box));
  assert.equal(manyDaysWarning(2), 'Услуги на 2 дня → 2 визита, 2 счёта');
  const one = byAttr(box, 'data-one-day');
  assert.ok(one, 'нет кнопки «Всё на один день»');
  one.click();
  await flush(20);
  assert.ok(!byAttr(overlay(), 'data-many-days'), 'предупреждение осталось — строки не сведены');
  await pressUntilCreate();
  const evs = RPC.filter((c) => c.name === 'ensure_visit');
  assert.equal(evs.length, 1, 'визитов больше одного: ' + JSON.stringify(evs.map((e) => e.body.date)));
  assert.equal(localDayOfIso(evs[0].body.date), isoOf(dayOffset(1)), 'визит не на день приёма');
  const inv = RPC.filter((c) => c.name === 'create_invoice_for_visit');
  assert.equal(inv.length, 1, 'счетов больше одного');
  assert.equal(inv[0].body.visit_service_ids.length, 2);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 3').get().n, 1);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM invoices').get().n, 1);
});

test('«Выбрать день» открывает календарь врача: выбранный день ставит время, пометка уходит', async () => {
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test --test-name-pattern="смета на два дня" public/js/admin/__tests__/pick-day-wizard.test.mjs
```

Ожидается: `AssertionError: нет предупреждения о двух днях`.

- [ ] **Step 3: implement** — `visit-wizard.js`, три правки.

3a. Импорт (поправка U5.2). «было»:

```js
import { nearestFree, noFreeText, nearestButtonText } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
```

«стало»:

```js
import { nearestFree, noFreeText, nearestButtonText, manyDaysWarning } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
```

3b. Функции дней — сразу после `noTodayControls` из U5.2. «было» (последние строки `noTodayControls`):

```js
            h('button', {
                class: 'btn btn-sm btn-outline', type: 'button', 'data-pick-day': String(line.svc.id),
                onclick: onPickDay,
            }, Icon('Calendar', { size: 13 }), ' ', tr('Выбрать день')));
    }
```

«стало»:

```js
            h('button', {
                class: 'btn btn-sm btn-outline', type: 'button', 'data-pick-day': String(line.svc.id),
                onclick: onPickDay,
            }, Icon('Calendar', { size: 13 }), ' ', tr('Выбрать день')));
    }

    /** PICK_DAY_V1 — дни сметы (местные), по которым её разложит createVisit. */
    function cartDays() {
        return [...new Set(visibleCart().map((c) => lineDay(c)).filter(Boolean))].sort();
    }

    /** PICK_DAY_V1 — день, к которому «Всё на один день» сводит строки без врача: день головной строки врача. */
    function oneDayTarget() {
        const head = headTimedLine(visibleCart());
        return head ? String(head.when).slice(0, 10) : null;
    }

    /** PICK_DAY_V1 — есть ли что сводить: строка без врача (не «из записи») на другом дне, чем строка врача. */
    function canMoveToOneDay() {
        const day = oneDayTarget();
        return !!day && visibleCart().some((c) => c.dateOnly && !c.booked && lineDay(c) !== day);
    }

    /** PICK_DAY_V1 — «Всё на один день»: строки без врача переходят на день строки врача. */
    function moveAllToOneDay() {
        const day = oneDayTarget();
        if (!day) return;
        for (const c of wiz.cart) {
            if (!c.dateOnly || c.booked) continue;   // строку «из записи» переносит только календарь
            c.when = day + 'T00:00';
            c.ui.day = new Date(day + 'T00:00:00').getTime();
        }
        refreshTiers();
        repaintRail();
        if (wiz.step === 1) paint();
    }
```

(`lineDay` — стрелка в начале `openVisitWizard` (~:374), объявлена до первого `paint()`; `headTimedLine` — объявление функции.)

3c. Предупреждение в смете — после блока «Выберите врача — N услуг(и) ждут» (~:2282). «было»:

```js
                railEl.appendChild(wait);
            }
        }

        // ---- REFERRAL_TICK_V1
```

«стало»:

```js
                railEl.appendChild(wait);
            }
            // PICK_DAY_V1 — смета на разные дни — это разные визиты и разные
            // счета (визит = один день). Сказать об этом здесь, а не одним
            // «(визитов: N)» на подтверждении, и дать собрать всё в один день.
            const nDays = cartDays().length;
            if (nDays > 1) {
                railEl.appendChild(h('div', {
                    'data-many-days': String(nDays),
                    style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '9px 10px', background: 'var(--warn-50, #fffbeb)', border: '1px solid var(--warn-200, #fde68a)', borderRadius: '10px' },
                },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 700, color: 'var(--warn-700, #a16207)' } },
                        Icon('Warning', { size: 13 }), manyDaysWarning(nDays)),
                    canMoveToOneDay()
                        ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-one-day': '', style: { alignSelf: 'flex-start' }, onclick: moveAllToOneDay },
                            Icon('Calendar', { size: 13 }), ' ', tr('Всё на один день'))
                        : null));
            }
        }

        // ---- REFERRAL_TICK_V1
```

(Смета видна на всех шагах — предупреждение тоже. «(визитов: N)» на шаге 4 остаётся.)

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day-wizard.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs
```

Ожидается: `ℹ fail 0` (pick-day-wizard — 6 тестов).

- [ ] **Step 5: commit** — Write `.git/U5_MSG.txt`:

```
PICK_DAY_V1: смета мастера на разные дни — «Услуги на 2 дня → 2 визита, 2 счёта» и «Всё на один день» (строки без врача — на день приёма)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/visit-wizard.js public/js/admin/__tests__/pick-day-wizard.test.mjs
git commit -F .git/U5_MSG.txt
```

### Task U5.4: калькулятор услуг — время само только в первый день окна; «Визит — …» в смете

**Files:**
- Modify: `public/js/admin/views/service-picker-modal.js`
- Create: `public/js/admin/__tests__/pick-day-calculator.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/pick-day-calculator.test.mjs` (стенд — `picker-attach-package-day.test.mjs`: поддельный DOM, настоящие `/api/db` и `/api/rpc`, а `calendar_slots` подменён — врач УЗИ свободен в 10:00 каждый день, `busyToday` — сегодня занят):

```js
// PICK_DAY_V1 (решение владельца 2026-11-02) — КАЛЬКУЛЯТОР УСЛУГ: время
// ставится само только сегодня.
//
// catPickDoc брал первый свободный слот из семи дней каталога: врач сегодня
// занят — строка молча получала завтра, а с ней и ВЕСЬ визит калькулятора
// (cartVisitDateIso — день самой ранней строки со временем): анализ, который
// пациент сдаёт сейчас, уезжал на завтра. Теперь: сегодня нет времени —
// красная пометка, «Ближайшее: …», дальше нельзя; выбранный другой день виден
// в смете («Визит — …»).
//
// Стенд — как у picker-attach-package-day.test.mjs: поддельный DOM, /api/db и
// /api/rpc — настоящие сервер и дверь в памяти; calendar_slots — врач УЗИ
// свободен в 10:00 каждый день, busyToday — сегодня занят.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.checked = false; this.disabled = false;
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') { c._parent = this; c.parentElement = this; } return c; }
    append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
    contains() { return false; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = FakeNode;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const BODY = mkEl('body');
const TOAST_EL = new FakeNode('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set() {}, configurable: true });
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
// I18N_LOCALE_PIN_V1 — русский ДО импорта видов.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, CLINIC: {}, open: () => null, easymed: { state: { user: null } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ').replace(/\s+/g, ' ');
const byClass = (root, c) => walk(root).filter((e) => String(e.className || '').split(/\s+/).includes(c));
const byAttr = (root, k, v) => walk(root).find((e) => e.attrs && e.attrs[k] !== undefined && (v === undefined || e.attrs[k] === String(v)));
const until = async (cond, what, ms = 8000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('не дождались: ' + what);
        await new Promise((r) => setTimeout(r, 15));
    }
};

process.env.LIS_ENABLED = '0';
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns, jsonColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');

const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayAt = (off) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d; };

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
let busyToday = false;
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { code: 'bad_request', message } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') {
        // Врач УЗИ свободен с 10:00 каждый день; busyToday — сегодня занят.
        if (busyToday && body.date === ymd(new Date())) return ok({ date: body.date, slots: [], busy: [] });
        return ok({ date: body.date, slots: [{ start: '10:00', end: '10:30' }], busy: [] });
    }
    if (u.startsWith('/api/rpc/')) {
        const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
        if (!handler) return fail(501, 'RPC not implemented');
        try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message); }
    }
    if (u === '/api/db') {
        stampWriteBody(DB, body);
        let compiled;
        try { compiled = compile(body, USER, { db: DB }); } catch (e) { return fail(403, e.message); }
        const { sql, params, meta } = compiled;
        if (meta.op === 'insert' && meta.returning) {
            const info = DB.prepare(sql).run(...params);
            const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
            return ok(meta.single ? row : [row]);
        }
        const rows = meta.op === 'select' ? DB.prepare(sql).all(...params) : (DB.prepare(sql).run(...params), []);
        for (const r of rows) for (const c of jsonColumns(meta.table)) if (r && typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { /* как есть */ } }
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
    }
    return fail(404, 'no route ' + u);
};

const { openServicePickerModal, forgetSlots } = await import('../views/service-picker-modal.js');
const { nearestButtonText } = await import('../views/pick-day.js');

// ОАК — без врача; УЗИ — врач нужен, назначен один (каталог выберет его сам).
function seed() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Иванов Иван')").run();
    const lab = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    db.prepare("INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, code) VALUES (21,'ОАК',100000,?,'lab',1,0,'S-21'), (22,'УЗИ',50000,?,'imaging',1,1,'S-22')").run(lab, lab);
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,'[{"service_id":22,"pct":10}]')`).run();
    if (DB) DB.close();
    DB = db;
}

/** Калькулятор на пациента 3; в смету — УЗИ. */
async function openWithUzi() {
    seed();
    forgetSlots();
    BODY.children.length = 0;
    openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {},
        patient: { id: 3, fullName: 'Иванов Иван', lastName: 'Иванов', firstName: 'Иван', mrn: 'P-3', phone: '' } });
    const top = () => BODY.children[BODY.children.length - 1];
    const addOf = (name) => byClass(top(), 'wzc-svc').filter((r) => textOf(r).includes(name)).map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
    await until(() => addOf('УЗИ'), 'строка УЗИ в каталоге');
    addOf('УЗИ').click();
    return { top, addOf };
}

test('врач сегодня занят: строка без времени, красная пометка, «Ближайшее» — завтра 10:00; смету дальше не отправить', async () => {
    busyToday = true;
    try {
        const { top } = await openWithUzi();
        await until(() => byAttr(top(), 'data-pick-nearest', 22), 'кнопка «Ближайшее»');
        assert.equal(textOf(byAttr(top(), 'data-pick-nearest', 22)).trim(), nearestButtonText(ymd(dayAt(1)), 600));
        assert.ok(byAttr(top(), 'data-pick-day', 22), 'нет «Выбрать день»');
        assert.ok(textOf(top()).includes('Сегодня у врача нет свободного времени'), 'нет пометки');
        assert.equal(byClass(top(), 'wzc-cta')[0].disabled, true, 'смета без времени ушла бы дальше');
        assert.ok(!byAttr(top(), 'data-visit-day'), 'визит уже «перенесён», хотя день никто не выбирал');
    } finally { busyToday = false; }
});

test('«Ближайшее» ставит завтра 10:00 — смета готова, и в ней сказано, что визит завтра (cartVisitDateIso)', async () => {
    busyToday = true;
    try {
        const { top } = await openWithUzi();
        await until(() => byAttr(top(), 'data-pick-nearest', 22), 'кнопка «Ближайшее»');
        byAttr(top(), 'data-pick-nearest', 22).click();
        await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
        const note = byAttr(top(), 'data-visit-day');
        assert.ok(note, 'перенос визита на завтра не виден в смете');
        assert.equal(note.attrs['data-visit-day'], ymd(dayAt(1)));
        assert.ok(!byAttr(top(), 'data-no-today'), 'пометка осталась после выбора дня');
    } finally { busyToday = false; }
});

test('время сегодня есть — каталог ставит его сам; визит — сегодня, пометок нет', async () => {
    const { top } = await openWithUzi();
    await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
    assert.ok(!byAttr(top(), 'data-no-today'));
    assert.ok(!byAttr(top(), 'data-visit-day'), 'визит не сегодня');
    assert.match(textOf(top()), /сегодня 10:00/);
});

test.after(() => { if (DB) DB.close(); DB = null; });
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day-calculator.test.mjs
```

Ожидается (проверено): два первых — `Error: не дождались: кнопка «Ближайшее»` (каталог сам поставил завтра); третий проходит (страж).

- [ ] **Step 3: implement** — `public/js/admin/views/service-picker-modal.js`, пять правок.

3a. Импорт. «было»:

```js
import { packageTermsText } from './template-picker-modal.js?v=tpl1';
```

«стало»:

```js
import { packageTermsText } from './template-picker-modal.js?v=tpl1';
import { nearestFree, noFreeText, nearestButtonText, visitDayNote } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
```

3b. `catPickDoc` (~:1998) — только первый день окна, и помощники рядом. «было»:

```js
        await ensureDocSlots(doc.id, item.durationMinutes);
        if (item.doctor !== doc || !state.added.includes(item)) return;   // CATALOG_WIZARD_V2 — stale: switched/removed mid-fetch
        for (const d of catDays()) {
            const f = freeStarts(doc.id, d.iso, item.durationMinutes, item);
            if (f.length) { item.__dayIso = d.iso; catPickTime(item, d.iso, f[0], !!auto); return; }
        }
        item.__dayIso = catDays()[0].iso;
        paintCatalog();
    }
```

«стало»:

```js
        await ensureDocSlots(doc.id, item.durationMinutes);
        if (item.doctor !== doc || !state.added.includes(item)) return;   // CATALOG_WIZARD_V2 — stale: switched/removed mid-fetch
        // PICK_DAY_V1 — время ставится само ТОЛЬКО в первый день окна (сегодня;
        // у окна на визите — день визита). Прежде брался первый свободный из
        // семи дней: вечером или в выходной врача строка молча уезжала на
        // завтра, а с ней и весь визит (cartVisitDateIso — по самой ранней
        // строке со временем). Нет времени — пометка и выбор дня (catNoToday).
        const first = catDays()[0];
        item.__dayIso = first.iso;
        const f = freeStarts(doc.id, first.iso, item.durationMinutes, item);
        if (f.length) { item.__noToday = false; catPickTime(item, first.iso, f[0], !!auto); return; }
        item.__noToday = true;
        paintCatalog();
    }
    /** PICK_DAY_V1 — ближайший свободный слот строки после первого дня окна: { iso, min } или null. */
    function catNearest(item) {
        if (!item || !item.doctor) return null;
        return nearestFree(catDays().slice(1).map((d) => d.iso), (iso) => freeStarts(item.doctor.id, iso, item.durationMinutes, item));
    }
    /** PICK_DAY_V1 — строка врача без времени в первый день окна, и день не выбран. */
    function catNeedsDay(a) {
        return !!(a && a.__noToday && a.doctor && !a.startISO && requireSlot
            && (a.doctor.scheduling_mode || 'schedulable') !== 'live_queue');
    }
    /** PICK_DAY_V1 — красная пометка и «Ближайшее: …» / «Выбрать день» у строки каталога. */
    function catNoToday(item) {
        const near = catNearest(item);
        return h('div', { class: 'wzc-noday', 'data-no-today': String(item.service.id),
            style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px', padding: '8px 10px', borderRadius: '10px', background: 'var(--crit-50, #fef2f2)', border: '1px solid var(--crit-200, #fecaca)' } },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 700, color: 'var(--crit-700, #b91c1c)' } },
                Icon('Warning', { size: 13 }), noFreeText(catDays()[0].today)),
            near ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-pick-nearest': String(item.service.id),
                onclick: () => { item.__noToday = false; catPickTime(item, near.iso, near.min, false); } },
                nearestButtonText(near.iso, near.min)) : null,
            near ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-pick-day': String(item.service.id),
                onclick: () => { item.__dayIso = near.iso; paintCatalog(); } },
                Icon('Calendar', { size: 13 }), ' ', tr('Выбрать день')) : null);
    }
```

(«Выбрать день» калькулятора — его полоса дней уже на экране: кнопка открывает в ней ближайший день с окнами, время выбирает регистратор. В окне визита (`attachMode`) день один — кнопок нет, только пометка «В этот день у врача нет свободного времени».)

3c. Пометка в строке каталога — `catPickerPanel` (~:2227). «было»:

```js
            box.appendChild(strip);
            const slots = freeStarts(item.doctor.id, item.__dayIso, item.durationMinutes, item);
```

«стало»:

```js
            box.appendChild(strip);
            if (catNeedsDay(item)) box.appendChild(catNoToday(item));   // PICK_DAY_V1
            const slots = freeStarts(item.doctor.id, item.__dayIso, item.durationMinutes, item);
```

3d. Смета: причина словами и «Визит — …» — `paintCatRail` (~:2289 и ~:2326). «было»:

```js
                    onclick: () => { cat2.q = a.service.name; cat2.group = ''; cat2.win = CAT_PAGE;
                        if (catSearchEl) catSearchEl.value = cat2.q; paintCatalog(); } },
                    'выберите врача и время');
```

«стало»:

```js
                    onclick: () => { cat2.q = a.service.name; cat2.group = ''; cat2.win = CAT_PAGE;
                        if (catSearchEl) catSearchEl.value = cat2.q; paintCatalog(); } },
                    // PICK_DAY_V1 — причина словами: не «выберите время», а «сегодня времени нет».
                    catNeedsDay(a) ? noFreeText(catDays()[0].today) : 'выберите врача и время');
```

и «было»:

```js
            catRailEl.appendChild(rowsWrap);   // WIZ_RAIL_SCROLL_V1
        } else {
```

«стало»:

```js
            catRailEl.appendChild(rowsWrap);   // WIZ_RAIL_SCROLL_V1
            // PICK_DAY_V1 — визит калькулятора один, и его день — самая ранняя
            // строка со временем (cartVisitDateIso): услуги без врача идут в тот
            // же день. Не сегодня — сказать вслух, а не переносить молча.
            const vday = localDayOf(cartVisitDateIso());
            if (!attachMode && vday && vday !== localYmd()) {
                catRailEl.appendChild(h('div', { class: 'wzc-visit-day', 'data-visit-day': vday,
                    style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '6px 0', padding: '7px 9px', borderRadius: '9px', fontSize: '12.5px', fontWeight: 700, color: 'var(--warn-700, #a16207)', background: 'var(--warn-50, #fffbeb)', border: '1px solid var(--warn-200, #fde68a)' } },
                    Icon('Calendar', { size: 13 }), visitDayNote(vday)));
            }
        } else {
```

3e. Старый трёхколоночный `autoPickSlot` (~:1154, режим `showSchedule` без каталога). «было»:

```js
    // Walk forward day-by-day from today to the first day that has a free slot.
    function autoPickSlot() {
        const doctor = currentDoctor();
        if (!doctor) return;
        for (let i = 0; i < SCHED_WINDOW_DAYS; i++) {
            const iso  = schedAddDays(schedBaseIso(), i);
            const free = schedFreeStarts(iso);
            if (free.length) {
                state.schedViewIso  = iso;
                state.schedDateIso  = iso;
                state.schedStartMin = free[0];
                return;
            }
        }
        state.schedDateIso  = null;
        state.schedStartMin = null;
    }
```

«стало»:

```js
    // PICK_DAY_V1 — время ставится само только в ПЕРВЫЙ день окна (сегодня или
    // день визита, schedBaseIso). Прежде перебирались 14 дней вперёд и запись
    // молча уезжала на первый свободный. Нет времени в этот день — время не
    // выбрано: регистратор листает дни сам (‹ ›), «Готово» без времени не
    // запишет приём на время.
    function autoPickSlot() {
        const doctor = currentDoctor();
        if (!doctor) return;
        const iso  = schedBaseIso();
        const free = schedFreeStarts(iso);
        state.schedViewIso = iso;
        if (free.length) {
            state.schedDateIso  = iso;
            state.schedStartMin = free[0];
            return;
        }
        state.schedDateIso  = null;
        state.schedStartMin = null;
    }
```

(`SCHED_WINDOW_DAYS` остаётся — им прогревается окно дней в `loadDoctorVisitsWindow`.)

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day-calculator.test.mjs public/js/admin/__tests__/picker-attach-package-day.test.mjs public/js/admin/__tests__/picker-attach-estimate.test.mjs public/js/admin/__tests__/picker-invoice.test.mjs public/js/admin/__tests__/service-picker-attach.test.mjs public/js/admin/__tests__/service-picker-crm.test.mjs public/js/admin/__tests__/service-picker-groups.test.mjs public/js/admin/__tests__/service-picker-quick-patient.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs
```

Ожидается: `ℹ fail 0` (pick-day-calculator — 3 теста; в `picker-attach-package-day` тест «врач УЗИ сегодня занят» по-прежнему: времени на завтра нет, смету не отправить).

- [ ] **Step 5: commit** — Write `.git/U5_MSG.txt`:

```
PICK_DAY_V1: калькулятор услуг ставит время сам только в первый день окна; нет времени — пометка, «Ближайшее» и «Выбрать день»; визит не сегодня назван в смете; трёхколоночный выбор тоже не уходит на другой день сам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/service-picker-modal.js public/js/admin/__tests__/pick-day-calculator.test.mjs
git commit -F .git/U5_MSG.txt
```

### Task U5.5: прогон соседей U5 (ru и en)

**Files:** — (только проверка)

- [ ] **Step 1: ru**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day.test.mjs public/js/admin/__tests__/pick-day-wizard.test.mjs public/js/admin/__tests__/pick-day-calculator.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/wizard-desk.test.mjs public/js/admin/__tests__/wizard-templates.test.mjs public/js/admin/__tests__/picker-attach-package-day.test.mjs public/js/admin/__tests__/picker-invoice.test.mjs public/js/admin/__tests__/patient-create-modal.test.mjs public/js/admin/__tests__/doctor-dashboard.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs
```

- [ ] **Step 2: en** — те же файлы с `--import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"` перед `--test`. Ожидается: `ℹ fail 0` в обоих. Падение — чинить в задаче U5.x, к которой относится тест, отдельным коммитом с тем же маркером.

---

## U6. Новые услуги — в неоплаченный счёт (INVOICE_APPEND_V1)

**Сверено с кодом.**
- `issueVisitInvoice` (`billing.js` ~:435) всегда делал `INSERT INTO invoices` (~:630) и брал номер (`nextInvoiceNumber`, ~:605) ДО проверки плательщика. Строки обязаны быть одного визита (~:468), не в счёте (~:471), не отменены (~:477), не возвращены без `rebill_refunded` (~:491). Повтор того же вызова отказывает «Услуга №… уже в счёте» — это и есть идемпотентность `create_invoice_for_visit` (ключа `idempotency_key` у него нет и не было); дописывание идёт ПОСЛЕ этих проверок, значит повтор по-прежнему отказывает, а счёт не меняется (тест).
- Двери, которые выставляют счёт пациенту этим RPC: мастер визита (`visit-wizard.js` ~:2950, в том числе «Направить на услуги» врача — `doctorOnly`), быстрая регистрация (`walk-in-booking.js` ~:335), калькулятор (`service-picker-modal.js` `invoicePickerLines` ~:3838), окно визита «Сформировать счёт» (`visit-modal.js` ~:1188), «Счёт визита» (`visit-bill.js` ~:347); `cashier_line_add` (`addServiceToVisitInvoice`, ~:1684) зовёт `issueVisitInvoice`, только когда редактируемого счёта не нашёл сам (его правило шире — дописывание внутри `issueVisitInvoice` в этом случае цели не найдёт). Счёт плательщику (`cashier-line-fix.js` ~:846, мастер/калькулятор с `payer_id`) — не трогается.
- «Только врач» (REFERRAL_BILL_V1 / REFBILL_REVIEW_V1): `doctorInvoiceRefusal` (скидка, плательщик, плательщик в карте) — до транзакции; `doctorLinesRefusal(db, visit, rows, user)` — по `rows`, то есть по НОВЫМ строкам. Дописывание ставится после них — проверки врача касаются только новых строк, строки регистратуры в счёте врачу не мешают.
- Скидка: при выставлении `restDiscount = min(max(ручная, пол группы), база строк без своей скидки)`. `repriceUnpaidInvoice(absolute)` берёт ручную часть из `invoices.manual_discount/manual_base` (мигр. 219) и даёт `max(ручная × доля базы, пол группы по всей базе)`. Если записать туда «сырую» ручную скидку, сумма двух частей НЕ складывается (первая часть с полом группы 10 000 + вторая с ручной 20 000 дали бы `max(20 000, 15 000)` = 20 000 вместо 30 000). Поэтому `manual_discount` = прежний остаток скидки счёта (`discount_amount − свои скидки позиций`) + `restDiscount` новой части, `manual_base` = вся база: `repriceUnpaidInvoice` даёт ровно сумму двух частей (тесты «скидка»). `rest_discount` ответа = `restDiscount` новой части — перенос скидки мастера по дням (DISCOUNT_CARRY_V1) не меняется.
- Очередь: строки неоплаченного счёта ждут оплаты; `record_payment` ставит в очередь все строки счёта (тест). Номер очереди мастер и быстрая регистрация по-прежнему спрашивают сразу (`issue_queue_numbers`) — без изменений.
- CRM: приход доказывает оплата (`crmInvoiceEvidence` — по счёту, его визит) — не меняется; `pruneAutoLinesOnInvoice` работает только при ПЕРВОМ счёте визита — не меняется.
- Филиалы: счёт и позиции ездят триггерами журнала 087/212 (`subtotal`, `discount_amount`, `total_amount`, `status` и `INSERT` позиции) — та же дорога, что у `cashier_line_add` (тест: журнал видит новую сумму и новую позицию). Чужой счёт (`sync_origin`) не выбирается.
- Список кассы (`cashier.js` `cashierInvoices`) — строка на счёт; после дописывания — одна строка с двумя позициями (тест).
- **Раздел К описания (5fa59531).** К2: возврат кассы — это строка `payments` с минусом (`issueRefund`, ~:2222), а «Вернуть услугу» (`refund_invoice_line`) и «Заменить услугу» в оплаченном счёте (`cashier_line_swap_paid`) бывают только по счёту с деньгами — `NOT EXISTS payments` в `appendTargetInvoice` их отсекает, новые услуги идут новым счётом. Замена в неоплаченном счёте (`cashier_line_change_service` / `change_unpaid_service`) денег не двигает — такой счёт остаётся редактируемым. Двери замены и возврата не меняются. К6: оба окна проверены тестами U6.1 («К2: …») и прогоном их наборов в U6.1 Step 4.

### Task U6.1: сервер — `create_invoice_for_visit` дописывает в неоплаченный счёт визита

**Files:**
- Modify: `server/services/rpc/billing.js`
- Create: `server/services/rpc/billing.invoice-append.test.js`
- Modify (ожидания): `server/services/rpc/billing.refbill-review.test.js`, `server/services/rpc/cashier.coverage.test.js`, `server/services/rpc/cashier.test.js`, `server/services/rpc/invoice-delete.test.js`

- [ ] **Step 1: failing test** — создать `server/services/rpc/billing.invoice-append.test.js`:

```js
// INVOICE_APPEND_V1 (решение владельца 2026-11-02) — НОВЫЕ УСЛУГИ — В
// НЕОПЛАЧЕННЫЙ СЧЁТ ВИЗИТА.
//
// Каждый шаг регистрации выставлял НОВЫЙ счёт (create_invoice_for_visit всегда
// делал INSERT): мастер, быстрая регистрация, калькулятор, направление врача,
// окно визита. На dev 17 счетов созданы, пока предыдущий счёт того же визита
// ещё не был оплачен. Теперь строки дописываются в «редактируемый счёт
// пациента» визита — тот же номер, новая сумма; счёт плательщику, оплаченный,
// частично оплаченный, долг, отменённый, с платежами в прошлом, чужого здания и
// госпитализации не трогается никогда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { cashierInvoices } from './cashier.js';
import { RPC } from './index.js';

const DOC = 20;
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const doctor = { id: DOC, role: 'doctor', full_name: 'Врач' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач', 1, '[]');
  const CONS = Number(db.prepare("INSERT INTO services (name, price) VALUES ('Приём терапевта', 100000)").run().lastInsertRowid);
  const LAB = Number(db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('Анализ крови', 40000, 1)").run().lastInsertRowid);
  const ECG = Number(db.prepare("INSERT INTO services (name, price) VALUES ('ЭКГ', 50000)").run().lastInsertRowid);
  const FREE = Number(db.prepare("INSERT INTO services (name, price) VALUES ('Повторный осмотр', 0)").run().lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, created_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 7)").run(pid).lastInsertRowid);
  return { db, CONS, LAB, ECG, FREE, pid, payer, vid };
}

/** Строка визита «в смете» — цена от браузера (1 сум), счёт оценит сам. */
function line(db, vid, serviceId, by = 7, doctorId = null) {
  return Number(db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, 1, 1, 1, 'added', ?)",
  ).run(vid, serviceId, doctorId, by).lastInsertRowid);
}
const bill = (db, vid, ids, user = registrar, extra = {}) =>
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null, ...extra }, user);
const invoicesOf = (db, vid) => db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id').all(vid);
const seqNow = (db) => JSON.stringify(db.prepare('SELECT year, next_seq FROM invoice_counters ORDER BY year').all());

test('второй вызов, пока первый счёт не оплачен, — ТОТ ЖЕ счёт: номер прежний, сумма новая, номер не израсходован', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const a = line(db, vid, CONS);
  const first = bill(db, vid, [a]);
  assert.equal(first.appended, undefined, 'первый счёт — новый');
  const seq = seqNow(db);
  const b = line(db, vid, LAB);
  const second = bill(db, vid, [b]);
  assert.equal(second.appended, true);
  assert.equal(second.invoice.id, first.invoice.id, 'строки легли в прежний счёт');
  assert.equal(second.invoice.invoice_number, first.invoice.invoice_number);
  assert.deepEqual([second.invoice.subtotal, second.invoice.discount_amount, second.invoice.total_amount, second.invoice.status],
    [140000, 0, 140000, 'unpaid']);
  assert.deepEqual(second.items.map((i) => [i.description, i.total]), [['Анализ крови', 40000]], 'items — позиции НОВОЙ части');
  assert.equal(second.rest_discount, 0);
  assert.equal(invoicesOf(db, vid).length, 1, 'второго счёта нет');
  assert.equal(seqNow(db), seq, 'номер счёта не израсходован');
  const vs = db.prepare('SELECT invoice_item_id, unit_price FROM visit_services WHERE id = ?').get(b);
  assert.equal(db.prepare('SELECT invoice_id FROM invoice_items WHERE id = ?').get(vs.invoice_item_id).invoice_id, first.invoice.id);
  assert.equal(vs.unit_price, 40000, 'строка визита — по цене счёта');
  const audit = db.prepare("SELECT action, notes, amount FROM invoice_audit_log WHERE invoice_id = ? AND action = 'line_add'").all(first.invoice.id);
  assert.equal(audit.length, 1, 'дописывание записано в журнал счёта');
  assert.match(audit[0].notes, /Анализ крови/);
  assert.equal(audit[0].amount, 140000);
  // Через карту RPC — та же дверь.
  const c = line(db, vid, ECG);
  assert.equal(RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [c] }, registrar).appended, true);
});

test('повтор того же вызова (те же строки) — отказ «уже в счёте», счёт не меняется', () => {
  const { db, CONS, LAB, vid } = seed();
  bill(db, vid, [line(db, vid, CONS)]);
  const b = line(db, vid, LAB);
  const once = bill(db, vid, [b]);
  assert.throws(() => bill(db, vid, [b]), (e) => e.status === 400 && /уже в счёте/.test(e.message));
  const now = db.prepare('SELECT subtotal, total_amount FROM invoices WHERE id = ?').get(once.invoice.id);
  assert.deepEqual({ ...now }, { subtotal: 140000, total_amount: 140000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(once.invoice.id).n, 2);
});

// Каждое из состояний первого счёта — второй вызов выставляет НОВЫЙ счёт.
const NOT_EDITABLE = [
  ['оплачен частично', (db, inv) => recordPayment(db, { invoice_id: inv.id, amount: 30000, method: 'cash' }, cashier)],
  ['оплачен полностью', (db, inv) => recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier)],
  ['переведён в долг', (db, inv) => RPC.mark_invoice_debt(db, { invoice_id: inv.id }, cashier)],
  ['отменён', (db, inv) => db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(inv.id)],
  ['по нему были платежи (оплата и возврат)', (db, inv) => {
    db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(inv.id, 30000);
    db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(inv.id, -30000);
  }],
  ['приехал из другого здания', (db, inv) => db.prepare("UPDATE invoices SET sync_origin = 'B' WHERE id = ?").run(inv.id)],
  ['счёт госпитализации', (db, inv) => {
    const adm = db.prepare('INSERT INTO admissions (patient_id) VALUES (?)').run(inv.patient_id).lastInsertRowid;
    db.prepare('UPDATE invoices SET admission_id = ? WHERE id = ?').run(adm, inv.id);
  }],
];
for (const [what, make] of NOT_EDITABLE) {
  test(`первый счёт ${what} — второй вызов выставляет НОВЫЙ счёт`, () => {
    const { db, CONS, LAB, vid } = seed();
    const first = bill(db, vid, [line(db, vid, CONS)]);
    make(db, first.invoice);
    const before = db.prepare('SELECT subtotal, total_amount, status FROM invoices WHERE id = ?').get(first.invoice.id);
    const second = bill(db, vid, [line(db, vid, LAB)]);
    assert.notEqual(second.invoice.id, first.invoice.id, 'дописано в счёт, который ' + what);
    assert.equal(second.appended, undefined);
    assert.equal(second.invoice.total_amount, 40000);
    assert.deepEqual(db.prepare('SELECT subtotal, total_amount, status FROM invoices WHERE id = ?').get(first.invoice.id), before,
      'первый счёт изменился');
  });
}

test('счёт плательщику не сливается никогда: ни пациентский в него, ни он в пациентский', () => {
  const { db, CONS, LAB, ECG, vid, payer } = seed();
  const pay = bill(db, vid, [line(db, vid, CONS)], registrar, { payer_id: payer });
  const own = bill(db, vid, [line(db, vid, LAB)]);
  assert.notEqual(own.invoice.id, pay.invoice.id, 'строки пациента легли в счёт страховой');
  assert.equal(own.appended, undefined);
  const pay2 = bill(db, vid, [line(db, vid, ECG)], registrar, { payer_id: payer });
  assert.notEqual(pay2.invoice.id, own.invoice.id, 'строки страховой легли в счёт пациента');
  assert.equal(pay2.appended, undefined);
  assert.equal(invoicesOf(db, vid).length, 3);
});

test('бесплатная новая часть — своим счётом (закрыт сразу, строка в очереди), а бесплатный первый счёт не дописывается', () => {
  const { db, CONS, FREE, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const f = line(db, vid, FREE);
  const free = bill(db, vid, [f]);
  assert.notEqual(free.invoice.id, first.invoice.id);
  assert.equal(free.invoice.status, 'paid');
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = ?').get(f).status, 'queued', 'бесплатная строка ждала бы оплаты чужого счёта');
  const s = seed();
  const zero = bill(s.db, s.vid, [line(s.db, s.vid, s.FREE)]);
  const paid = bill(s.db, s.vid, [line(s.db, s.vid, s.CONS)]);
  assert.notEqual(paid.invoice.id, zero.invoice.id, 'платная строка легла в закрытый бесплатный счёт');
});

test('визит другой: счёт соседнего визита пациента не трогается', () => {
  const { db, CONS, LAB, pid, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const vid2 = Number(db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 day'))").run(pid).lastInsertRowid);
  const second = bill(db, vid2, [line(db, vid2, LAB)]);
  assert.notEqual(second.invoice.id, first.invoice.id);
  assert.equal(second.invoice.visit_id, vid2);
});

test('оплата дописанного счёта ставит в очередь ВСЕ его строки', () => {
  const { db, CONS, LAB, vid } = seed();
  const a = line(db, vid, CONS);
  bill(db, vid, [a]);
  const b = line(db, vid, LAB);
  const inv = bill(db, vid, [b]).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  assert.deepEqual(db.prepare('SELECT status FROM visit_services WHERE id IN (?, ?) ORDER BY id').all(a, b).map((r) => r.status), ['queued', 'queued']);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'paid');
});

test('скидка: ручная скидка новой части прибавляется, скидка выставленной части не меняется (и пол группы тоже)', () => {
  const { db, CONS, LAB, ECG, pid, vid } = seed();
  const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  // Первая часть — без ручной скидки: действует пол группы 10 % = 10 000.
  const first = bill(db, vid, [line(db, vid, CONS)]);
  assert.equal(first.invoice.discount_amount, 10000);
  // Вторая — с ручной 20 000 на 40 000 (больше пола 4 000): +20 000.
  const second = bill(db, vid, [line(db, vid, LAB)], registrar, { discount_amount: 20000 });
  assert.equal(second.appended, true);
  assert.equal(second.rest_discount, 20000, 'rest_discount — скидка НОВОЙ части (перенос скидки мастера)');
  assert.deepEqual([second.invoice.subtotal, second.invoice.discount_amount, second.invoice.total_amount], [140000, 30000, 110000],
    'прежняя часть сохранила свои 10 000, новая дала 20 000');
  // Третья — без ручной: пол группы новой части, 5 000.
  const third = bill(db, vid, [line(db, vid, ECG)]);
  assert.equal(third.rest_discount, 5000);
  assert.deepEqual([third.invoice.subtotal, third.invoice.discount_amount, third.invoice.total_amount], [190000, 35000, 155000]);
});

test('скидка: ручная скидка первой части остаётся, новая часть получает только свой пол группы', () => {
  const { db, CONS, LAB, pid, vid } = seed();
  const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  const first = bill(db, vid, [line(db, vid, CONS)], registrar, { discount_amount: 30000 });
  assert.equal(first.invoice.discount_amount, 30000);
  const second = bill(db, vid, [line(db, vid, LAB)]);
  assert.equal(second.rest_discount, 4000);
  assert.deepEqual([second.invoice.discount_amount, second.invoice.total_amount], [34000, 106000]);
});

test('врач без денежной роли дописывает СВОИ строки в счёт регистратуры; проверки врача — только по новым строкам', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const regLine = line(db, vid, CONS, 7);
  const first = bill(db, vid, [regLine], registrar, { discount_amount: 15000 });
  const own = line(db, vid, LAB, DOC);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [own] }, doctor);
  assert.equal(out.appended, true, 'строка регистратуры в счёте не мешает врачу дописать свою');
  assert.equal(out.invoice.id, first.invoice.id);
  assert.equal(out.invoice.discount_amount, 15000, 'ручная скидка регистратуры осталась');
  assert.equal(out.invoice.total_amount, 125000);
  // Чужую строку врач по-прежнему не выставляет — ни новым счётом, ни дописыванием.
  const foreign = line(db, vid, ECG, 7);
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [foreign] }, doctor),
    (e) => e.status === 403 && /только за услуги, которые добавил сам/.test(e.message));
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [line(db, vid, ECG, DOC)], discount_amount: 1000 }, doctor),
    (e) => e.status === 403 && /Скидку в счёт ставят/.test(e.message));
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(first.invoice.id).total_amount, 125000, 'отказ не тронул счёт');
});

test('список кассы — одна строка на счёт: две регистрации одного визита — один счёт с двумя позициями', () => {
  const { db, CONS, LAB, vid } = seed();
  bill(db, vid, [line(db, vid, CONS)]);
  bill(db, vid, [line(db, vid, LAB)]);
  const rows = cashierInvoices(db, {}, admin).rows.filter((r) => r.visit_id === vid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].items_count, 2);
  assert.equal(rows[0].total_amount, 140000);
});

// К2 / К6 (владелец, 2026-11-02) — окно кассы «Платежи»: после «Вернуть услугу»
// новые услуги идут новым счётом; «Заменить услугу» в оплаченном счёте — тоже;
// замена в неоплаченном (без денег) счёте дописывание не ломает. Сами двери
// замены и возврата не меняются.
test('К2: после «Вернуть услугу» (refund_invoice_line) новые услуги идут новым счётом, возвращённый счёт не меняется', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const a = line(db, vid, CONS);
  const b = line(db, vid, LAB);
  const inv = bill(db, vid, [a, b]).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  const itemB = db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(b).invoice_item_id;
  RPC.refund_invoice_line(db, { invoice_item_id: itemB, reason: 'передумал' }, cashier);
  const before = db.prepare('SELECT subtotal, total_amount, paid_amount, status FROM invoices WHERE id = ?').get(inv.id);
  const next = bill(db, vid, [line(db, vid, ECG)]);
  assert.notEqual(next.invoice.id, inv.id, 'дописано в счёт с возвратом');
  assert.equal(next.appended, undefined);
  assert.equal(next.invoice.total_amount, 50000);
  assert.deepEqual(db.prepare('SELECT subtotal, total_amount, paid_amount, status FROM invoices WHERE id = ?').get(inv.id), before);
});

test('К2: «Заменить услугу» в оплаченном счёте — новые услуги новым счётом; замена в неоплаченном — дописывание по-прежнему', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const a = line(db, vid, CONS);
  const inv = bill(db, vid, [a]).invoice;
  RPC.cashier_line_change_service(db, { visit_service_id: a, new_service_id: LAB }, admin);   // замена без денег
  const app = bill(db, vid, [line(db, vid, ECG)]);
  assert.equal(app.appended, true, 'замена в неоплаченном счёте сломала дописывание');
  assert.equal(app.invoice.id, inv.id);
  assert.equal(app.invoice.total_amount, 90000, 'анализ 40 000 (после замены) + ЭКГ 50 000');
  const s = seed();
  const a2 = line(s.db, s.vid, s.CONS);
  const inv2 = bill(s.db, s.vid, [a2]).invoice;
  recordPayment(s.db, { invoice_id: inv2.id, amount: inv2.total_amount, method: 'cash' }, cashier);
  RPC.cashier_line_swap_paid(s.db, { visit_service_id: a2, new_service_id: s.LAB, to_balance: true }, admin);
  const next = bill(s.db, s.vid, [line(s.db, s.vid, s.ECG)]);
  assert.notEqual(next.invoice.id, inv2.id, 'дописано в оплаченный счёт после замены');
  assert.equal(next.appended, undefined);
});

test('филиалы: дописанный счёт уезжает соседям — журнал видит новую сумму и новую позицию', () => {
  const { db, CONS, LAB, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const mark = db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM sync_journal').get().m;
  const second = bill(db, vid, [line(db, vid, LAB)]);
  const inv = db.prepare('SELECT uid FROM invoices WHERE id = ?').get(first.invoice.id);
  const item = db.prepare('SELECT uid FROM invoice_items WHERE id = ?').get(second.items[0].id);
  const j = db.prepare('SELECT tbl, uid, cols FROM sync_journal WHERE seq > ?').all(mark);
  assert.ok(j.some((r) => r.tbl === 'invoices' && r.uid === inv.uid && /total_amount/.test(r.cols)), 'новая сумма счёта не попала в журнал: ' + JSON.stringify(j));
  assert.ok(j.some((r) => r.tbl === 'invoice_items' && r.uid === item.uid), 'новая позиция не попала в журнал');
});
```

Правка ожиданий четырёх существующих тестов (они строили «второй неоплаченный счёт того же визита»):

`server/services/rpc/billing.refbill-review.test.js` — «было»:

```js
  const vid = visit(db, pid, { by: 7 });
  for (const who of [doctorCashier, cashier, registrar, admin]) {
    const l = line(db, vid, { service_id: CARD, by: 7, tier: 'secondary' });
    assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, who).invoice.total_amount, 60000, who.full_name);
  }
```

«стало»:

```js
  const vid = visit(db, pid, { by: 7 });
  for (const who of [doctorCashier, cashier, registrar, admin]) {
    const l = line(db, vid, { service_id: CARD, by: 7, tier: 'secondary' });
    // INVOICE_APPEND_V1 — со второго вызова строки дописываются в тот же
    // неоплаченный счёт визита: сверяется позиция ЭТОЙ строки.
    const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, who);
    assert.equal(out.items[0].total, 60000, who.full_name);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(vid).n, 1, 'один счёт на визит');
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount, 240000);
```

`server/services/rpc/cashier.coverage.test.js` — «было»:

```js
test('with no payer invoices the queue is unchanged (no regression)', () => {
  const { db, vs } = seed();
  const a = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]] }, registrar);
  const b = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]] }, registrar);
  const { rows, counts } = cashierInvoices(db, {}, cashier);
  assert.deepEqual(rows.map(r => r.id).sort(), [a.invoice.id, b.invoice.id].sort());
  assert.equal(counts.unpaid.sum, 80000);
});
```

«стало»:

```js
// INVOICE_APPEND_V1 — второй вызов по визиту, пока счёт пациента не оплачен,
// дописывает строки в него: в кассе одна строка на 80 000, а не две.
test('with no payer invoices the queue is unchanged (no regression)', () => {
  const { db, vs } = seed();
  const a = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]] }, registrar);
  const b = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]] }, registrar);
  assert.equal(b.appended, true);
  assert.equal(b.invoice.id, a.invoice.id);
  const { rows, counts } = cashierInvoices(db, {}, cashier);
  assert.deepEqual(rows.map(r => r.id), [a.invoice.id]);
  assert.equal(rows[0].items_count, 2);
  assert.equal(counts.unpaid.n, 1);
  assert.equal(counts.unpaid.sum, 80000);
});
```

`server/services/rpc/cashier.test.js` (тест `void_invoice cancels only money-free invoices…`) — «было»:

```js
  const { db, vid, vs1, vs2 } = seed();
  const inv1 = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar).invoice;
  const inv2 = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar).invoice;
  openCashShift(db, { opening_float: 0 }, cashier);
  recordPayment(db, { invoice_id: inv2.id, amount: 5000, method: 'cash' }, cashier);

  const res = voidInvoice(db, { invoice_id: inv1.id }, cashier);
```

«стало»:

```js
  const { db, vid, vs1, vs2 } = seed();
  // INVOICE_APPEND_V1 — второй счёт того же визита появляется, только когда
  // первый уже не редактируемый (по нему приняты деньги): сначала inv2 и оплата.
  const inv2 = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar).invoice;
  openCashShift(db, { opening_float: 0 }, cashier);
  recordPayment(db, { invoice_id: inv2.id, amount: 5000, method: 'cash' }, cashier);
  const inv1 = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar).invoice;
  assert.notEqual(inv1.id, inv2.id);

  const res = voidInvoice(db, { invoice_id: inv1.id }, cashier);
```

`server/services/rpc/invoice-delete.test.js` (тест `соседние счета не затрагиваются`) — «было»:

```js
  const { db, vid, invoice } = seed();
  const sid2 = db.prepare("INSERT INTO services (name, price) VALUES ('УЗИ', 50000)").run().lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,50000,50000,'added')").run(vid, sid2).lastInsertRowid;
  const other = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, REG).invoice;
```

«стало»:

```js
  const { db, pid, invoice } = seed();
  // INVOICE_APPEND_V1 — второй неоплаченный счёт ТОГО ЖЕ визита не появляется
  // (строки дописываются в первый): соседний счёт — у соседнего визита.
  const vid2 = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 day'))").run(pid).lastInsertRowid;
  const sid2 = db.prepare("INSERT INTO services (name, price) VALUES ('УЗИ', 50000)").run().lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,50000,50000,'added')").run(vid2, sid2).lastInsertRowid;
  const other = createInvoiceForVisit(db, { visit_id: vid2, visit_service_ids: [vs2] }, REG).invoice;
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test server/services/rpc/billing.invoice-append.test.js server/services/rpc/billing.refbill-review.test.js server/services/rpc/cashier.coverage.test.js
```

Ожидается (проверено на 347bfd3d): в `billing.invoice-append.test.js` падают 9 из 20 — `actual: undefined, expected: true` (`appended`; в «К2: «Заменить услугу»…» — `замена в неоплаченном счёте сломала дописывание`), `actual: { subtotal: 40000, … } expected: { subtotal: 140000, … }`, `actual: [ 'added', 'queued' ]`, `actual: [ 4000, 36000 ] expected: [ 34000, 106000 ]`, `список кассы … actual: 2, expected: 1`, `новая сумма счёта не попала в журнал`; 11 стражей проходят и до правки (7 × «первый счёт … — НОВЫЙ счёт», «счёт плательщику…», «бесплатная…», «визит другой», «К2: после «Вернуть услугу»…»). `refbill-review` — `один счёт на визит` (`actual: 4`); `cashier.coverage` — `actual: undefined, expected: true`.

- [ ] **Step 3: implement** — `server/services/rpc/billing.js`, три правки.

3a. Номер счёта — не до выбора. «было»:

```js
    const total = round2(subtotal - discount);
    const invoiceNumber = nextInvoiceNumber(db);
    // A zero-balance invoice
```

«стало»:

```js
    const total = round2(subtotal - discount);
    // INVOICE_APPEND_V1 — номер счёта берётся ниже, после выбора «дописать или
    // новый»: дописывание в счёт номера не тратит.
    // A zero-balance invoice
```

3b. Выбор «дописать» — после проверки плательщика. «было»:

```js
      if (!payer.active) {
        throw rpcT(RpcError, 'Плательщик №{id} выключен.', { id: payerRaw }, 400);
      }
    }

    const insertInvoice = db.prepare(`
```

«стало»:

```js
      if (!payer.active) {
        throw rpcT(RpcError, 'Плательщик №{id} выключен.', { id: payerRaw }, 400);
      }
    }

    // INVOICE_APPEND_V1 (решение владельца 2026-11-02) — у визита уже есть
    // неоплаченный счёт пациента, к которому не прикасались деньги: новые строки
    // ложатся В НЕГО (тот же номер, новая сумма), а не вторым счётом. Счёт
    // плательщику не дописывается никогда (payerRaw), бесплатная новая часть —
    // своим счётом, как прежде: она закрыта сразу и строки идут в очередь
    // (FREE_SERVICE_V1), а в чужом неоплаченном счёте ждали бы кассу.
    if (payerRaw === null && total > 0) {
      const target = appendTargetInvoice(db, visitId);
      if (target) return appendToVisitInvoice(db, target, { visitId, priced, subtotal, restSubtotal, restDiscount }, user);
    }
    const invoiceNumber = nextInvoiceNumber(db);   // INVOICE_APPEND_V1 — только у нового счёта

    const insertInvoice = db.prepare(`
```

3c. Две функции — сразу после `issueVisitInvoice`. «было»:

```js
  if (out.invoice && out.invoice.payer_id) crmVisitEvidence(db, visitId);
  return out;
}

export function recordPayment(db, args, user) {
```

«стало»:

```js
  if (out.invoice && out.invoice.payer_id) crmVisitEvidence(db, visitId);
  return out;
}

// INVOICE_APPEND_V1 — «РЕДАКТИРУЕМЫЙ СЧЁТ ПАЦИЕНТА» ВИЗИТА: куда дописываются
// новые строки вместо второго счёта. Правило то же, что у cashier_line_add
// (editableInvoiceRefusal), но строже: только 'unpaid' (бесплатный, закрытый
// при выставлении, не берётся — его строки уже в очереди), и без отказа словами
// — подходящего нет, значит будет новый счёт:
//   • пациенту (payer_id IS NULL) — счёт плательщику не сливается никогда;
//   • 'unpaid' и paid_amount = 0, и по нему НИКОГДА не было платежей (оплата и
//     возврат оставляют post_sale_discount и возвраты по строкам);
//   • своего здания (sync_origin IS NULL — BRANCH_MONEY_GUARD_V1);
//   • не госпитализация и не DEP-/CARD- (у них visit_id и так NULL — страж на
//     случай, если появится).
// Самый новый — как у cashier_line_add.
function appendTargetInvoice(db, visitId) {
  return db.prepare(`
    SELECT i.* FROM invoices i
     WHERE i.visit_id = ?
       AND i.payer_id IS NULL
       AND i.admission_id IS NULL
       AND i.status = 'unpaid'
       AND COALESCE(i.paid_amount, 0) = 0
       AND i.sync_origin IS NULL
       AND COALESCE(i.invoice_number, '') NOT LIKE 'DEP-%'
       AND COALESCE(i.invoice_number, '') NOT LIKE 'CARD-%'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)
     ORDER BY i.id DESC
     LIMIT 1`).get(visitId) || null;
}

// INVOICE_APPEND_V1 — ДОПИСАТЬ ОЦЕНЁННЫЕ СТРОКИ В СЧЁТ. Строки оценены, как
// для нового счёта (issueVisitInvoice: цена, своя скидка пакета, пол группы и
// ручная скидка НОВОЙ части — restDiscount). Скидка уже выставленной части не
// меняется: ручная часть счёта (manual_discount, мигр. 219) = прежний остаток
// скидки счёта + остаток новой части, база (manual_base) = вся база строк без
// своей скидки; repriceUnpaidInvoice(absolute) собирает итог тем же правилом,
// что cashier_line_add и правки строк кассы, и закрывает ноль (settleZeroTotal).
// rest_discount — скидка НОВОЙ части: мастер переносит остаток своей скидки на
// счёт следующего дня (DISCOUNT_CARRY_V1) и вычитает ровно её.
// items — позиции НОВОЙ части в порядке строк вызова (BILLING_AUDIT_FIX_V1 A2:
// быстрая регистрация сверяет их со своими строками по месту).
function appendToVisitInvoice(db, target, { visitId, priced, subtotal, restSubtotal, restDiscount }, user) {
  assertOwnBuilding(db, target, 'Счёт');
  const oldOwn = invoiceOwnDiscount(db, target.id);
  const oldBase = invoiceRestBase(db, target.id);
  const oldRest = Math.max(round2((Number(target.discount_amount) || 0) - oldOwn), 0);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, discount_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const linkVisitService = db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?');
  const syncVisitService = db.prepare('UPDATE visit_services SET unit_price = ?, total = ? WHERE id = ?');
  const itemIds = [];
  for (const { row, unit, qty, line, svcName, ownDiscount } of priced) {
    const itemInfo = insertItem.run(target.id, row.service_id, svcName || '', qty, unit, line, ownDiscount);
    itemIds.push(Number(itemInfo.lastInsertRowid));
    linkVisitService.run(itemInfo.lastInsertRowid, row.id);
    clearRefundRelease(db, 'out', [row.id]);   // FINAL_MONEY_FIX_V1 (M1) — как при новом счёте
    syncVisitService.run(unit, line, row.id);
  }
  const base = round2(oldBase + restSubtotal);
  db.prepare('UPDATE invoices SET manual_discount = ?, manual_base = ? WHERE id = ?')
    .run(round2(oldRest + restDiscount), base, target.id);
  const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(target.id);
  const invoice = repriceUnpaidInvoice(db, fresh, oldOwn, { oldBase: base, absolute: true });
  lineAudit(db, {
    inv: invoice, number: target.invoice_number, visitId, action: 'line_add',
    fromStatus: target.status, toStatus: invoice.status, amount: invoice.total_amount,
    notes: 'Добавлено в счёт: ' + priced.map((p) => lineLabel(db, p.row, { description: p.svcName })).join('; ') + ' · ' + moneyWords(subtotal),
  }, user);
  const items = db.prepare(`SELECT * FROM invoice_items WHERE id IN (${itemIds.map(() => '?').join(',')}) ORDER BY id`).all(...itemIds);
  return { invoice, items, rest_discount: restDiscount, appended: true };
}

export function recordPayment(db, args, user) {
```

(`invoiceOwnDiscount`, `invoiceRestBase`, `repriceUnpaidInvoice`, `lineAudit`, `lineLabel`, `moneyWords`, `clearRefundRelease`, `assertOwnBuilding` — объявления функций этого модуля или импорт, видны отсюда. В SQL из запроса подставляется только число `?` по длине своего массива — значения связаны параметрами.)

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test server/services/rpc/billing.invoice-append.test.js server/services/rpc/billing.refbill-review.test.js server/services/rpc/cashier.coverage.test.js server/services/rpc/cashier.test.js server/services/rpc/invoice-delete.test.js server/services/rpc/billing.test.js server/services/rpc/billing.referral-bill.test.js server/services/rpc/billing.packages.test.js server/services/rpc/billing.free.test.js server/services/rpc/billing.split.test.js server/services/rpc/billing.final-money.test.js server/services/rpc/billing.audit-fix.test.js server/services/rpc/billing.coverage.test.js server/services/rpc/cashier-head.test.js server/services/rpc/cashier-paid-swap.test.js server/services/rpc/cashier-unbilled.test.js server/services/rpc/category-discount.test.js server/services/rpc/refund-any.cancelled-invoice.test.js server/routes/referral-bill-flow.test.js server/routes/refbill-review-http.test.js server/routes/package-stamp.test.js
```

Ожидается: `ℹ fail 0` (`billing.invoice-append` — 20 тестов). Окна кассы «Платежи» (К6) — ещё `server/services/rpc/cashier-paid-swap.test.js server/services/rpc/refund-swap.test.js server/services/rpc/refund-swap-rebill.test.js server/services/rpc/refund-any.keep.test.js server/services/rpc/refund-any.work.test.js public/js/admin/__tests__/cashier-paid-swap.test.mjs public/js/admin/__tests__/cashier-refund-any.test.mjs public/js/admin/__tests__/refund-swap.test.mjs` — `ℹ fail 0` (двери замены и возврата не меняются). Полный набор файлов, где встречается `create_invoice_for_visit` (103 файла, CRM-маршруты, филиалы) — в U6.6.

- [ ] **Step 5: commit** — Write `.git/U6_MSG.txt`:

```
INVOICE_APPEND_V1: create_invoice_for_visit дописывает новые строки в неоплаченный счёт пациента визита (тот же номер, новая сумма, appended: true); счёт плательщику, с деньгами, долг, отменённый, чужого здания и госпитализации — никогда; скидка выставленной части не меняется; номер счёта не тратится

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add server/services/rpc/billing.js server/services/rpc/billing.invoice-append.test.js server/services/rpc/billing.refbill-review.test.js server/services/rpc/cashier.coverage.test.js server/services/rpc/cashier.test.js server/services/rpc/invoice-delete.test.js
git commit -F .git/U6_MSG.txt
```

### Task U6.2: клиентская фраза «Добавлено в счёт № …» — `invoice-append.js`

**Files:**
- Create: `public/js/admin/invoice-append.js`
- Create: `public/js/admin/__tests__/invoice-append.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/invoice-append.test.mjs`:

```js
// INVOICE_APPEND_V1 — одна фраза на все двери (invoice-append.js): «Добавлено в
// счёт № … — новая сумма …», и скидка своей части дописанного счёта.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// I18N_LOCALE_PIN_V1 — русский ДО импорта (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {} };   // i18n.js ставит documentElement.lang
globalThis.window = { dispatchEvent() {} };        // setLang шлёт 'langchange'
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { isAppended, invoiceAppendNote, appendedPartDiscount } = await import('../invoice-append.js');
const { setLang } = await import('../i18n.js');

const res = { appended: true, invoice: { id: 5, invoice_number: 'INV-A-26-00012', total_amount: 1150000 }, items: [{ discount_amount: 2000 }, { discount_amount: 0 }], rest_discount: 5000 };

test('дописано — фраза с номером и новой суммой; новый счёт — пусто', () => {
  assert.equal(isAppended(res), true);
  assert.equal(invoiceAppendNote(res), 'Добавлено в счёт № INV-A-26-00012 — новая сумма 1 150 000 сум');
  assert.equal(isAppended({ invoice: { id: 1 } }), false);
  assert.equal(invoiceAppendNote({ invoice: { id: 1, invoice_number: 'INV-A-26-00001' } }), '');
  assert.equal(invoiceAppendNote(null), '');
  assert.equal(invoiceAppendNote({ appended: true, invoice: { id: 9, total_amount: 0 } }), 'Добавлено в счёт № 9 — новая сумма 0 сум');
});

test('скидка своей части — свои скидки позиций плюс rest_discount', () => {
  assert.equal(appendedPartDiscount(res), 7000);
  assert.equal(appendedPartDiscount({}), 0);
});

test('узбекский и английский — без кириллицы', () => {
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    try { assert.ok(!/[А-Яа-яЁё]/.test(invoiceAppendNote(res)), lang + ': ' + invoiceAppendNote(res)); }
    finally { setLang('ru'); }
  }
});
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/invoice-append.test.mjs
```

Ожидается: `ERR_MODULE_NOT_FOUND … public/js/admin/invoice-append.js`.

- [ ] **Step 3: implement** — создать `public/js/admin/invoice-append.js`:

```js
// INVOICE_APPEND_V1 (решение владельца 2026-11-02) — услуги, добавленные, пока
// счёт пациента не оплачен, ложатся В ТОТ ЖЕ СЧЁТ: create_invoice_for_visit
// дописывает их и отвечает { invoice, appended: true } (server/services/rpc/
// billing.js appendToVisitInvoice). Экран говорит об этом одной фразой —
// «Добавлено в счёт № … — новая сумма …», — одной на все двери: мастер визита,
// быстрая регистрация, калькулятор, окно визита и «Счёт визита».
import { trf } from './i18n.js';

const fmtSum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** true — ответ сервера дописал строки в уже выставленный счёт. */
export function isAppended(res) {
    return !!(res && res.appended && res.invoice);
}

/** «Добавлено в счёт № INV-A-26-00012 — новая сумма 150 000 сум» или '' (новый счёт). */
export function invoiceAppendNote(res) {
    if (!isAppended(res)) return '';
    const inv = res.invoice;
    return trf('Добавлено в счёт № {no} — новая сумма {sum} сум', {
        no: inv.invoice_number || String(inv.id),
        sum: fmtSum(inv.total_amount),
    });
}

/**
 * Скидка НОВОЙ части дописанного счёта: свои скидки её позиций (пакет) и
 * rest_discount (ручная / группа). Экран с итогом своих строк (быстрая
 * регистрация) показывает её, а не скидку всего счёта.
 */
export function appendedPartDiscount(res) {
    const items = (res && Array.isArray(res.items)) ? res.items : [];
    const own = items.reduce((s, it) => s + (Number(it && it.discount_amount) || 0), 0);
    return Math.round((own + (Number(res && res.rest_discount) || 0)) * 100) / 100;
}
```

`public/js/admin/i18n-strings.js` — Edit, «было»:

```js
export const STRINGS = {
```

«стало» (блок U5 остаётся ниже — этот встаёт перед ним):

```js
export const STRINGS = {
  // INVOICE_APPEND_V1 — новые услуги — в неоплаченный счёт (invoice-append.js, fast-registration.js)
  "Добавлено в счёт № {no} — новая сумма {sum} сум": {"en":"Added to invoice no. {no} — new total {sum} UZS","ru":"Добавлено в счёт № {no} — новая сумма {sum} сум","uz":"{no}-son hisobga qo‘shildi — yangi summa {sum} so‘m"},   // INVOICE_APPEND_V1
  "Счёт не напечатан: {msg}": {"en":"The invoice was not printed: {msg}","ru":"Счёт не напечатан: {msg}","uz":"Hisob chop etilmadi: {msg}"},   // INVOICE_APPEND_V1
  "В счёте нет позиций.": {"en":"The invoice has no items.","ru":"В счёте нет позиций.","uz":"Hisobda pozitsiyalar yo‘q."},   // INVOICE_APPEND_V1
```

(«В счёте нет позиций.» — причина отказа `printInvoiceSheetById`, её показывает быстрая регистрация в U6.4; ключа в словаре до сих пор не было.)

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/invoice-append.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs
```

Ожидается: `ℹ fail 0`.

- [ ] **Step 5: commit** — Write `.git/U6_MSG.txt`:

```
INVOICE_APPEND_V1: одна фраза на все двери — «Добавлено в счёт № … — новая сумма …» (invoice-append.js), скидка своей части дописанного счёта; словарь ru/uz/en

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/invoice-append.js public/js/admin/__tests__/invoice-append.test.mjs public/js/admin/i18n-strings.js
git commit -F .git/U6_MSG.txt
```

### Task U6.3: мастер визита — «Добавлено в счёт № …», баланс и карта не платят за прежние строки

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js`
- Modify: `public/js/admin/__tests__/pick-day-wizard.test.mjs`

- [ ] **Step 1: failing test** — в `pick-day-wizard.test.mjs` Edit, «было»:

```js
test.after(() => { if (DB) DB.close(); DB = null; });
```

«стало»:

```js
// INVOICE_APPEND_V1 — у пациента сегодня визит с неоплаченным счётом (анализ):
// мастер добавляет ЭКГ в тот же визит, и сервер дописывает её в тот же счёт.
test('INVOICE_APPEND_V1: мастер — визит дня с неоплаченным счётом: ЭКГ в тот же счёт, тост «Добавлено в счёт № …»', async () => {
  seed();
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (3, ?, 'arrived', 1)").run(today.toISOString()).lastInsertRowid);
  const lab = Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 22, 1, 40000, 40000, 'added', 1)").run(vid).lastInsertRowid);
  const first = getRpc('create_invoice_for_visit')(DB, { visit_id: vid, visit_service_ids: [lab] }, USER).invoice;
  await openWizard([23]);
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  const inv = DB.prepare('SELECT * FROM invoices').all();
  assert.equal(inv.length, 1, 'второй счёт за один визит: ' + JSON.stringify(inv.map((i) => [i.invoice_number, i.total_amount])));
  assert.equal(inv[0].id, first.id);
  assert.equal(inv[0].total_amount, 90000, 'анализ 40 000 + ЭКГ 50 000');
  assert.ok(TOASTS.some((t) => t.includes('Добавлено в счёт № ' + first.invoice_number + ' — новая сумма 90 000 сум')), 'нет фразы: ' + JSON.stringify(TOASTS));
});

test.after(() => { if (DB) DB.close(); DB = null; });
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test --test-name-pattern="INVOICE_APPEND_V1" public/js/admin/__tests__/pick-day-wizard.test.mjs
```

Ожидается: `AssertionError: нет фразы: [… "Услуги добавлены. Счёт пациента выставлен — виден в кассе." …]` (счёт уже один — это сделал U6.1; на 347bfd3d падало бы раньше: `второй счёт за один визит`).

- [ ] **Step 3: implement** — `visit-wizard.js`, пять правок.

3a. Импорт. «было»:

```js
import { nearestFree, noFreeText, nearestButtonText, manyDaysWarning } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
```

«стало»:

```js
import { nearestFree, noFreeText, nearestButtonText, manyDaysWarning } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
import { isAppended, invoiceAppendNote } from '../invoice-append.js';   // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
```

3b. Счётчик фраз (`createVisit`, ~:2728). «было»:

```js
            let invoicesOk = 0, invoiceFail = '';
            let billedLines = 0;                           // REFERRAL_BILL_V1 — сколько строк легло в счета
```

«стало»:

```js
            let invoicesOk = 0, invoiceFail = '';
            let billedLines = 0;                           // REFERRAL_BILL_V1 — сколько строк легло в счета
            const appendNotes = [];                        // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
```

3c. После удачного счёта (~:2960). «было»:

```js
                        invoicesOk++;
                        billedLines += job.ids.length;   // REFERRAL_BILL_V1
```

«стало»:

```js
                        invoicesOk++;
                        billedLines += job.ids.length;   // REFERRAL_BILL_V1
                        // INVOICE_APPEND_V1 — строки легли в уже выставленный
                        // неоплаченный счёт визита: тот же номер, новая сумма.
                        if (isAppended(iRes)) appendNotes.push(invoiceAppendNote(iRes));
```

(Перенос скидки по дням (`discountLeft − iRes.rest_discount`) не меняется: сервер отдаёт `rest_discount` НОВОЙ части. Печать — `printInvoiceSheetById` по каждому счёту пациента из строк сервера — уже печатает обновлённый счёт целиком; у врача по-прежнему печатается «Маршрутный лист» кабинета.)

3d. Баланс и карта (~:3024). «было»:

```js
            const wallet = wiz.useBalance ? Number(wiz.balance) || 0 : 0;
            const card = wiz.card ? { id: wiz.card.id, remaining: cardRemaining(wiz.card) } : null;
```

«стало»:

```js
            // INVOICE_APPEND_V1 — счёт пациента мог оказаться ДОПИСАННЫМ: в нём и
            // строки, выставленные раньше. Баланс и карта платят не больше этой
            // сметы — прежде счета мастера были только её, и это было так само.
            const wallet = wiz.useBalance ? Math.min(Number(wiz.balance) || 0, grandTotal()) : 0;
            const card = wiz.card ? { id: wiz.card.id, remaining: Math.min(cardRemaining(wiz.card), grandTotal()) } : null;
```

3e. Итоговый тост (~:3110). «было»:

```js
                !canInvoice ? ' ' + tr('Счёт выставит касса.') : '',
                cashInvoices > 0 ? ' ' + tr('Счёт пациента выставлен — виден в кассе.') : '',
```

«стало»:

```js
                !canInvoice ? ' ' + tr('Счёт выставит касса.') : '',
                cashInvoices - appendNotes.length > 0 ? ' ' + tr('Счёт пациента выставлен — виден в кассе.') : '',
                appendNotes.length ? ' ' + appendNotes.join('. ') + '.' : '',   // INVOICE_APPEND_V1
```

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/pick-day-wizard.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs
```

Ожидается: `ℹ fail 0` (pick-day-wizard — 7 тестов; в `wizard-booking` «МАСТЕР: VIP + пакет» по-прежнему 1 или 2 счёта — визиты разных дней не сливаются).

- [ ] **Step 5: commit** — Write `.git/U6_MSG.txt`:

```
INVOICE_APPEND_V1: мастер визита говорит «Добавлено в счёт № … — новая сумма …»; баланс и карта платят не больше этой сметы (в дописанном счёте есть прежние строки)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/visit-wizard.js public/js/admin/__tests__/pick-day-wizard.test.mjs
git commit -F .git/U6_MSG.txt
```

### Task U6.4: быстрая регистрация — тот же счёт, итог своих строк, печать всего счёта

**Files:**
- Modify: `public/js/admin/views/walk-in-booking.js`
- Modify: `public/js/admin/views/fast-registration.js`
- Create: `public/js/admin/__tests__/walk-in-append.test.mjs`
- Modify: `public/js/admin/__tests__/fast-registration.test.mjs`

- [ ] **Step 1: failing tests**

1a. Создать `public/js/admin/__tests__/walk-in-append.test.mjs` (стенд — как у `walk-in-booking.test.mjs`):

```js
// INVOICE_APPEND_V1 (решение владельца 2026-11-02) — БЫСТРАЯ РЕГИСТРАЦИЯ
// ВТОРОЙ РАЗ ЗА ДЕНЬ, ПОКА ПЕРВЫЙ СЧЁТ НЕ ОПЛАЧЕН: строки ложатся в ТОТ ЖЕ счёт.
//
// registerWalkIn (walk-in-booking.js) переиспользует визит дня (ensure_visit) и
// раньше выставлял на новые строки ВТОРОЙ счёт. Теперь create_invoice_for_visit
// дописывает их в неоплаченный счёт визита и отвечает appended: true; модуль
// отдаёт это экрану вместе со скидкой своей части (appendedDiscount), а items —
// только позиции этой регистрации (по ним экран сверяет цены своих строк).
//
// Стенд — как у walk-in-booking.test.mjs: настоящий реестр RPC, настоящий
// компилятор /api/db и настоящая SQLite в памяти за фальшивым fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {}, body: null, createElement: () => ({ style: {}, appendChild() {} }) };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc' } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: e.status || 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'select') {
        const rows = DB.prepare(sql).all(...params);
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
      }
      if (meta.op === 'insert') {
        const info = DB.prepare(sql).run(...params);
        if (!meta.returning) return ok(null);
        const row = DB.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        if (meta.single === 'single') return ok(row);
        if (meta.single === 'maybe') return ok(row ?? null);
        return ok([row]);
      }
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { registerWalkIn } = await import('../views/walk-in-booking.js');

const CONSULT = 21;
const LAB = 22;
const DOCTOR = 7;
const PATIENT = 3;

function seed({ vip = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,'doc','x','Петров Пётр','doctor',1,'терапевт')").run(DOCTOR);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (?, 'Иванов Иван')").run(PATIENT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type) VALUES (?,'Консультация терапевта',100000,0,30,1,'consultation')").run(CONSULT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type, is_lab) VALUES (?,'Общий анализ крови',40000,0,15,0,'lab',1)").run(LAB);
  if (vip) {
    const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
    db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, PATIENT);
  }
  if (DB) DB.close();
  DB = db;
}
const svc = (id) => DB.prepare('SELECT id, name, price, requires_doctor FROM services WHERE id = ?').get(id);

test('вторая регистрация за день, первый счёт не оплачен — тот же счёт: appended, items — только новые позиции', async () => {
  seed();
  const first = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(CONSULT), doctorId: DOCTOR }], createdBy: 1 });
  assert.equal(first.appended, undefined, 'первый счёт — новый');
  const second = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(LAB), doctorId: null }], createdBy: 1 });
  assert.equal(second.visit.id, first.visit.id, 'визит дня не переиспользован — проверяется не то');
  assert.equal(second.appended, true);
  assert.equal(second.invoice.id, first.invoice.id, 'второй счёт за один приход');
  assert.equal(second.invoice.invoice_number, first.invoice.invoice_number);
  assert.equal(second.invoice.total_amount, 140000);
  assert.equal(second.items.length, 1, 'items — позиции ЭТОЙ регистрации');
  assert.deepEqual(second.lines.map((l) => l.unitPrice), [40000]);
  assert.equal(second.appendedDiscount, 0);
  assert.equal(DB.prepare('SELECT COUNT(*) c FROM invoices').get().c, 1);
});

test('скидка своей части — пол группы пациента новой части, а не скидка всего счёта', async () => {
  seed({ vip: true });
  await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(CONSULT), doctorId: DOCTOR }], createdBy: 1 });
  const second = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(LAB), doctorId: null }], createdBy: 1 });
  assert.equal(second.appended, true);
  assert.equal(second.appendedDiscount, 4000, '10 % от 40 000');
  assert.equal(second.invoice.discount_amount, 14000, 'скидка счёта — 10 000 прежней части + 4 000 новой');
  assert.equal(second.invoice.total_amount, 126000);
});

test.after(() => { if (DB) DB.close(); DB = null; });
```

1b. `public/js/admin/__tests__/fast-registration.test.mjs` — стенд отвечает «дописано», когда тест попросит. Три правки.

«было»:

```js
let invoiceTotal = 152000;   // total_amount ответа create_invoice_for_visit
```

«стало»:

```js
let invoiceTotal = 152000;   // total_amount ответа create_invoice_for_visit
let invoiceAppended = false; // INVOICE_APPEND_V1 — сервер дописал строки в неоплаченный счёт визита
```

«было»:

```js
      return ok({ data: { invoice: { id: 9, invoice_number: 'INV-9', total_amount: invoiceTotal }, items: [] } });
```

«стало»:

```js
      return ok({ data: { invoice: { id: 9, invoice_number: 'INV-9', total_amount: invoiceTotal }, items: [],
        ...(invoiceAppended ? { appended: true, rest_discount: 0 } : {}) } });   // INVOICE_APPEND_V1
```

«было»:

```js
  quotes = null; invoiceTotal = 152000; queueTickets = null; holdRpc = null;
```

«стало»:

```js
  quotes = null; invoiceTotal = 152000; queueTickets = null; holdRpc = null;
  invoiceAppended = false;   // INVOICE_APPEND_V1
```

И новый тест перед разделом про номер очереди. «было»:

```js
// ===========================================================================
// НОМЕР ОЧЕРЕДИ — ЭТО НОМЕР, А НЕ ДВЕРЬ.
```

«стало»:

```js
// ===========================================================================
// INVOICE_APPEND_V1 — пациент уже стоит в неоплаченном счёте визита дня: сервер
// дописал строки в него (тот же номер, новая сумма). Окно говорит об этом,
// итог таблицы — её строки, а «Печать» берёт ВЕСЬ счёт с сервера, а не
// собирает бланк из строк таблицы (номер и сумма разошлись бы с бумагой).
// ===========================================================================
test('INVOICE_APPEND_V1: строки легли в неоплаченный счёт визита — «Добавлено в счёт № …», итог — своих строк, печать — весь счёт с сервера', async () => {
  reset();
  invoiceAppended = true;
  invoiceTotal = 300000;   // в счёте и прежние строки: 148 000 + эти 152 000
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();
  dlg.state.addLine(SERVICES[1], null);
  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);
  assert.ok(dlg.state.result && dlg.state.result.appended, 'регистрация не дошла до дописанного счёта');
  assert.ok(toasts.includes('Добавлено в счёт № INV-9 — новая сумма 300 000 сум'), 'нет фразы о дописанном счёте: ' + JSON.stringify(toasts));
  const tbl = textOf(dlg.table).replace(/\s+/g, ' ');
  assert.ok(tbl.includes('152 000'), '«Итого» таблицы — не её строки: ' + tbl.slice(-160));
  assert.ok(!tbl.includes('300 000'), '«Итого» таблицы — сумма всего счёта');
  calls.length = 0;
  btnByText(dlg.card, 'Печать').click();
  await tick(40);
  assert.ok(calls.some((c) => c.kind === 'select' && c.table === 'invoices'), 'дописанный счёт печатается не с сервера');
  assert.strictEqual(printed.length, 0, 'напечатан бланк, собранный из строк таблицы');
  dlg.close();
});

// ===========================================================================
// НОМЕР ОЧЕРЕДИ — ЭТО НОМЕР, А НЕ ДВЕРЬ.
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/walk-in-append.test.mjs public/js/admin/__tests__/fast-registration.test.mjs
```

Ожидается: `walk-in-append` — оба `actual: undefined, expected: true` (`second.appended`); `fast-registration` — новый тест `регистрация не дошла до дописанного счёта`.

- [ ] **Step 3: implement**

3a. `public/js/admin/views/walk-in-booking.js` — импорт. «было»:

```js
import { isBookedTwin } from './booked-rows.js';   // CRM_LINK_ALL_V1 (ред. 2) — строка той же услуги, что строка записи
```

«стало»:

```js
import { isBookedTwin } from './booked-rows.js';   // CRM_LINK_ALL_V1 (ред. 2) — строка той же услуги, что строка записи
import { isAppended, appendedPartDiscount } from '../invoice-append.js';   // INVOICE_APPEND_V1 — строки легли в неоплаченный счёт визита
```

Ответ. «было»:

```js
    const out = {
        visit,
        invoice: (inv && inv.invoice) || null,
        items: (inv && inv.items) || [],
        queue,
        lines: saved,
    };
```

«стало»:

```js
    const out = {
        visit,
        invoice: (inv && inv.invoice) || null,
        items: (inv && inv.items) || [],
        queue,
        lines: saved,
    };
    // INVOICE_APPEND_V1 — строки легли в уже выставленный неоплаченный счёт
    // визита дня (тот же номер, новая сумма): items — только позиции ЭТОЙ
    // регистрации, invoice — весь счёт; скидка своей части — appendedDiscount.
    if (isAppended(inv)) {
        out.appended = true;
        out.appendedDiscount = appendedPartDiscount(inv);
    }
```

Шапка (правда о повторе). «было»:

```js
 * ЭТА ФУНКЦИЯ НЕ ИДЕМПОТЕНТНА. Второй вызов в тот же день не «повторит»
 * регистрацию, а допишет строки в тот же визит дня и выставит ВТОРОЙ счёт на
 * них. Поэтому вызывающий обязан выключить свою кнопку на время вызова и
 * ОСТАВИТЬ её выключенной после успеха: пациент с двумя счетами за один приход
 * разбирается уже в кассе, а не на экране.
```

«стало»:

```js
 * ЭТА ФУНКЦИЯ НЕ ИДЕМПОТЕНТНА. Второй вызов в тот же день не «повторит»
 * регистрацию, а допишет строки в тот же визит дня — и, пока первый счёт не
 * оплачен, в ТОТ ЖЕ счёт (INVOICE_APPEND_V1: тот же номер, сумма выросла на
 * задвоенные услуги; оплачен — вторым счётом). Поэтому вызывающий обязан
 * выключить свою кнопку на время вызова и ОСТАВИТЬ её выключенной после
 * успеха: задвоенные услуги разбираются уже в кассе, а не на экране.
```

и «было»:

```js
 *     quoteError?: string, queueError?: string }
```

«стало»:

```js
 *     quoteError?: string, queueError?: string,
 *     appended?: true, appendedDiscount?: number }   // INVOICE_APPEND_V1 — дописано в неоплаченный счёт визита
```

3b. `public/js/admin/views/fast-registration.js` — четыре правки.

Импорт. «было»:

```js
import { packageItemName, packageLabel } from './receipt-print.js?v=rp1';     // PACKAGES_V1 — пакет и скидка позиции на бланке; CLINIC_API_FIX_V1 — packageLabel
```

«стало»:

```js
import { packageItemName, packageLabel, printInvoiceSheetById } from './receipt-print.js?v=rp1';     // PACKAGES_V1 — пакет и скидка позиции на бланке; CLINIC_API_FIX_V1 — packageLabel; INVOICE_APPEND_V1 — дописанный счёт целиком
import { invoiceAppendNote } from '../invoice-append.js';                      // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
```

Итог таблицы. «было»:

```js
    function totalDue() {
        const inv = state.result && state.result.invoice;
        const total = inv && Number(inv.total_amount);
```

«стало»:

```js
    function totalDue() {
        // INVOICE_APPEND_V1 — строки легли в уже выставленный счёт: его сумма
        // включает и прежние услуги. Таблица показывает СВОИ строки — итог её
        // строк минус скидка своей части (walk-in-booking.js appendedDiscount).
        if (state.result && state.result.appended) {
            return Math.max(0, totalGross() - (Number(state.result.appendedDiscount) || 0));
        }
        const inv = state.result && state.result.invoice;
        const total = inv && Number(inv.total_amount);
```

(`discountApplied()` = `totalGross() − totalDue()` — сам становится скидкой своей части.)

Тост. «было»:

```js
        paintTable();
        toast(tr('Пациент зарегистрирован, счёт выставлен.'));
    }
```

«стало»:

```js
        paintTable();
        // INVOICE_APPEND_V1 — тот же номер, новая сумма: так и сказано.
        toast(state.result && state.result.appended
            ? invoiceAppendNote({ appended: true, invoice: inv })
            : tr('Пациент зарегистрирован, счёт выставлен.'));
    }
```

Печать. «было»:

```js
    function printInvoice() {
        const inv = state.result && state.result.invoice;
        if (!inv) return;
```

«стало»:

```js
    function printInvoice() {
        const inv = state.result && state.result.invoice;
        if (!inv) return;
        // INVOICE_APPEND_V1 — дописанный счёт печатается ЦЕЛИКОМ, из строк сервера
        // (receipt-print.js, как в мастере визита): бланк ниже собран из строк
        // этой таблицы и разошёлся бы с номером и суммой счёта.
        if (state.result.appended) {
            printInvoiceSheetById({ supabase, printableSheet, invoiceId: inv.id, title: 'Амбулаторные услуги', withPerformer: true })   // i18n-exempt: печатный счёт (бланк) — печатный документ
                .then((r) => { if (r && !r.ok) toast(trf('Счёт не напечатан: {msg}', { msg: tr(r.reason) }), 'fail'); })
                .catch((e) => toast(trf('Счёт не напечатан: {msg}', { msg: (e && e.message) || e }), 'fail'));
            return;
        }
```

(«Печать» здесь — нажатая кнопка: печать сразу, без `autoPrint: false` — так и записано в `print-auto.test.mjs` CALLERS для `fast-registration.js`; `printInvoiceSheetById` вызов `printableSheet(` не добавляет. Талоны очереди печатает тот же бланк: `loadInvoiceLines` спрашивает `issue_queue_numbers` по всем строкам счёта.)

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/walk-in-append.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/print-auto.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs
```

Ожидается: `ℹ fail 0`.

- [ ] **Step 5: commit** — Write `.git/U6_MSG.txt`:

```
INVOICE_APPEND_V1: быстрая регистрация — повторный приход в тот же день, пока счёт не оплачен, ложится в тот же счёт: «Добавлено в счёт № …», итог таблицы — её строки, «Печать» — весь счёт с сервера

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/walk-in-booking.js public/js/admin/views/fast-registration.js public/js/admin/__tests__/walk-in-append.test.mjs public/js/admin/__tests__/fast-registration.test.mjs
git commit -F .git/U6_MSG.txt
```

### Task U6.5: калькулятор, окно визита, «Счёт визита»

**Files:**
- Modify: `public/js/admin/views/service-picker-modal.js`
- Modify: `public/js/admin/views/visit-modal.js`
- Modify: `public/js/admin/views/visit-bill.js`
- Modify: `public/js/admin/__tests__/picker-invoice.test.mjs`
- Modify: `public/js/admin/__tests__/print-auto.test.mjs`

- [ ] **Step 1: failing tests**

1a. `picker-invoice.test.mjs` — два теста в конец файла. «было» (последний тест файла):

```js
  assert.match(src, /const inPkg = [^;]*packageValidOn\(a\.package, localDayOf\(cartVisitDateIso\(\)\)\)/, 'таблица подтверждения — пакетная цена только в срок пакета');
});
```

«стало»:

```js
  assert.match(src, /const inPkg = [^;]*packageValidOn\(a\.package, localDayOf\(cartVisitDateIso\(\)\)\)/, 'таблица подтверждения — пакетная цена только в срок пакета');
});

// INVOICE_APPEND_V1 — второй «Сформировать счёт» окна визита, пока первый счёт
// не оплачен: строки ложатся в ТОТ ЖЕ счёт; тост называет номер и новую сумму,
// «создан» второй раз в журнал счёта не пишется (сервер записал «line_add»).
test('INVOICE_APPEND_V1: окно визита — второй счёт по неоплаченному визиту дописывается в первый', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101]), () => {});
  const first = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  assert.ok(first, 'первый счёт не создан: ' + JSON.stringify(RPC));
  const created = () => DB.prepare("SELECT COUNT(*) c FROM invoice_audit_log WHERE invoice_id = ? AND action = 'created'").get(first.id).c;
  const before = created();
  TOASTS.length = 0;
  await VM.generateInvoiceFromSelection(vmState(), new Set([102]), () => {});
  const all = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').all();
  assert.equal(all.length, 1, 'второй счёт по неоплаченному визиту');
  assert.equal(all[0].total_amount, 980000, '900 000 + 80 000 по пакету');
  assert.ok(TOASTS.some((t) => t === 'Добавлено в счёт № ' + first.invoice_number + ' — новая сумма 980 000 сум'), 'нет фразы: ' + TOASTS.join(' | '));
  assert.equal(created(), before, '«создан» записан второй раз');
  assert.equal(DB.prepare("SELECT COUNT(*) c FROM invoice_audit_log WHERE invoice_id = ? AND action = 'line_add'").get(first.id).c, 1);
});

// INVOICE_APPEND_V1 — калькулятор: счёт по визиту, у которого уже есть
// неоплаченный счёт (запись легла в существующий приём), — дописывание.
// Экран калькулятора говорит «Добавлено в счёт № …» и печатает ВЕСЬ счёт с
// сервера, а не бланк из позиций этого вызова; «Счёт визита» — та же фраза.
test('INVOICE_APPEND_V1: калькулятор и «Счёт визита» — дописанный счёт: appended доходит до экрана, тост и печать всего счёта', async () => {
  seed();
  const one = await invoicePickerLines({ visitId: 40, lines: [LINES[0]] });
  assert.equal(one.error, null);
  const two = await invoicePickerLines({ visitId: 40, lines: [LINES[1]] });
  assert.equal(two.error, null);
  assert.equal(two.data.appended, true);
  assert.equal(two.data.invoice.id, one.data.invoice.id);
  assert.equal(DB.prepare('SELECT COUNT(*) c FROM invoices WHERE visit_id = 40').get().c, 1);
  const fs = await import('node:fs');
  const spm = fs.readFileSync(new URL('../views/service-picker-modal.js', import.meta.url), 'utf8');
  assert.match(spm, /const appended = isAppended\(bill\.data\);/, 'калькулятор не читает appended');
  assert.match(spm, /note = appended \? ', ' \+ invoiceAppendNote\(bill\.data\)/, 'калькулятор не говорит «Добавлено в счёт № …»');
  assert.match(spm, /if \(appended\) \{\s*try \{\s*const r = await printInvoiceSheetById\(\{ supabase, printableSheet, invoiceId: inv\.id,/, 'дописанный счёт печатается не с сервера');
  const vb = fs.readFileSync(new URL('../views/visit-bill.js', import.meta.url), 'utf8');
  assert.match(vb, /toast\(isAppended\(data\) \? invoiceAppendNote\(data\) : 'Счёт выставлен', 'ok'\);/, '«Счёт визита» молчит о дописывании');
});
```

1b. `print-auto.test.mjs` — калькулятор получает ещё один «только показ» (печать дописанного счёта после сохранения). «было»:

```js
  'service-picker-modal.js': { calls: 2, view: 2 },   // счёт и акт мастера после сохранения
```

«стало»:

```js
  'service-picker-modal.js': { calls: 2, view: 3 },   // счёт и акт мастера после сохранения; INVOICE_APPEND_V1 — дописанный счёт (printInvoiceSheetById) — тоже показ
```

- [ ] **Step 2: run, expect FAIL**

```bash
node --experimental-vm-modules --test --test-name-pattern="INVOICE_APPEND_V1|все вызовы printableSheet" public/js/admin/__tests__/picker-invoice.test.mjs public/js/admin/__tests__/print-auto.test.mjs
```

Ожидается: окно визита — `нет фразы: Счёт INV-… создан — передан в кассу.`; калькулятор — `калькулятор не читает appended`; `print-auto` — `deepEqual … view: 2 … view: 3`.

- [ ] **Step 3: implement**

3a. `service-picker-modal.js` — импорты. «было»:

```js
import { nearestFree, noFreeText, nearestButtonText, visitDayNote } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
```

«стало»:

```js
import { nearestFree, noFreeText, nearestButtonText, visitDayNote } from './pick-day.js';   // PICK_DAY_V1 — нет времени сегодня — день выбирает регистратор
import { isAppended, invoiceAppendNote } from '../invoice-append.js';   // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
import { printInvoiceSheetById } from './receipt-print.js?v=rp1';   // INVOICE_APPEND_V1 — дописанный счёт печатается целиком, из строк сервера
```

(`receipt-print.js` импортирует только `shared/` — кольца импортов нет.)

3b. `wizSave` — тост (~:3224). «было»:

```js
                    const inv = bill.data.invoice;
                    note = inv.invoice_number ? ', ' + trf('счёт №{no}', { no: inv.invoice_number }) : ', ' + tr('счёт выставлен');
```

«стало»:

```js
                    const inv = bill.data.invoice;
                    const appended = isAppended(bill.data);   // INVOICE_APPEND_V1 — строки легли в уже выставленный счёт визита
                    note = appended ? ', ' + invoiceAppendNote(bill.data)
                        : inv.invoice_number ? ', ' + trf('счёт №{no}', { no: inv.invoice_number }) : ', ' + tr('счёт выставлен');
```

3c. Карта не платит за прежние строки (~:3232). «было»:

```js
                    const cardCap = cardRow && canSpendStoredValue() ? { id: cardRow.id, remaining: cardRemaining(cardRow) } : null;
```

«стало»:

```js
                    // INVOICE_APPEND_V1 — дописанный счёт держит и прежние строки: карта платит не больше этой сметы.
                    const cardCap = cardRow && canSpendStoredValue() ? { id: cardRow.id, remaining: Math.min(cardRemaining(cardRow), tNow.payable) } : null;
```

(Баланс здесь уже ограничен сметой: `Math.min(tNow.bal, invTotal)`, а `tNow.bal ≤ tNow.payable`.)

3d. Печать дописанного счёта целиком (~:3241). «было»:

```js
                    invTotal = Number(inv.total_amount || 0);
                    // WIZ_INVOICE_PRINT_V1 — сразу открываем печатную форму счёта для
                    // пациента (тот же printableSheet/бланк, которым печатается акт).
                    // RPC_PORT_V1 — строки бланка — ответ сервера, то есть ровно то,
                    // что выставлено.
                    try {
```

«стало»:

```js
                    invTotal = Number(inv.total_amount || 0);
                    // INVOICE_APPEND_V1 — дописанный счёт печатается ЦЕЛИКОМ, из строк
                    // сервера (receipt-print.js, как в мастере визита): бланк ниже
                    // собран из позиций ЭТОГО вызова и разошёлся бы с номером и суммой.
                    if (appended) {
                        try {
                            const r = await printInvoiceSheetById({ supabase, printableSheet, invoiceId: inv.id, title: 'Амбулаторные услуги', withPerformer: true, autoPrint: false });   // i18n-exempt: печатный счёт (бланк) — печатный документ
                            if (r && !r.ok) console.warn('[wizard] invoice print:', inv.id, r.reason);
                        } catch (e) { console.warn('[wizard] invoice print:', e); }
                    }
                    // WIZ_INVOICE_PRINT_V1 — сразу открываем печатную форму счёта для
                    // пациента (тот же printableSheet/бланк, которым печатается акт).
                    // RPC_PORT_V1 — строки бланка — ответ сервера, то есть ровно то,
                    // что выставлено.
                    if (!appended) try {
```

(Прежний бланк с блоком очереди остаётся для нового счёта; у дописанного талоны печатает `printInvoiceSheetById` по всем строкам счёта.)

3e. `public/js/admin/views/visit-modal.js` — импорт. «было»:

```js
import { printInvoiceSheetById } from './receipt-print.js?v=rp1';   // V3120_FIX — счёт визита той же сборкой, что у кассы
```

«стало»:

```js
import { printInvoiceSheetById } from './receipt-print.js?v=rp1';   // V3120_FIX — счёт визита той же сборкой, что у кассы
import { isAppended, invoiceAppendNote } from '../invoice-append.js';   // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
```

`generateInvoiceFromSelection` (~:1199). «было»:

```js
    const inv = res.invoice;
    const subtotal = Number(inv.subtotal || 0);
    await logInvoiceAction(state, inv, {
        action: 'created',
        fromStatus: null,
        toStatus:   'unpaid',
        amount:     Number(inv.total_amount || subtotal),
        notes:      `${lineItems.length} line item${lineItems.length === 1 ? '' : 's'}`,
    });
    await logPatientActivity({
        patientId:   state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'invoice',
        entityId:    inv.id,
        entityLabel: inv.invoice_number || String(inv.id),
        action:      'created',
        summary:     `Invoice for ${Number(inv.total_amount || 0).toLocaleString('ru-RU')} UZS · ${lineItems.length} service${lineItems.length === 1 ? '' : 's'}`,
    });
    toast(trf('Счёт {number} создан — передан в кассу.', { number: inv.invoice_number || String(inv.id) }));
```

«стало»:

```js
    const inv = res.invoice;
    const subtotal = Number(inv.subtotal || 0);
    // INVOICE_APPEND_V1 — строки легли в уже выставленный неоплаченный счёт
    // визита: «создан» в журнал счёта не пишется (сервер сам записал
    // «line_add»), и тост называет тот же номер и новую сумму.
    const appended = isAppended(res);
    if (!appended) {
        await logInvoiceAction(state, inv, {
            action: 'created',
            fromStatus: null,
            toStatus:   'unpaid',
            amount:     Number(inv.total_amount || subtotal),
            notes:      `${lineItems.length} line item${lineItems.length === 1 ? '' : 's'}`,
        });
    }
    await logPatientActivity({
        patientId:   state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'invoice',
        entityId:    inv.id,
        entityLabel: inv.invoice_number || String(inv.id),
        action:      appended ? 'updated' : 'created',
        summary:     `Invoice for ${Number(inv.total_amount || 0).toLocaleString('ru-RU')} UZS · ${lineItems.length} service${lineItems.length === 1 ? '' : 's'}${appended ? ' added' : ''}`,
    });
    toast(appended ? invoiceAppendNote(res) : trf('Счёт {number} создан — передан в кассу.', { number: inv.invoice_number || String(inv.id) }));
```

(Печать ниже — `openInvoicePrintWindow(state, inv, …)` собирает бланк по id счёта (V3120_FIX) — после дописывания печатается обновлённый счёт целиком; строку не трогать — её ловит регэксп `print-auto.test.mjs`.)

3f. `public/js/admin/views/visit-bill.js` — импорт. «было»:

```js
import { hasActorRole } from '../permissions.js';   // LIVE_AUDIT_FIX_V1
```

«стало»:

```js
import { hasActorRole } from '../permissions.js';   // LIVE_AUDIT_FIX_V1
import { isAppended, invoiceAppendNote } from '../invoice-append.js';   // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
```

«Выставить счёт» (~:347). «было»:

```js
            const { error } = await supabase.rpc('create_invoice_for_visit', {
                visit_id: visit.id,
                visit_service_ids: unInvoicedIds.slice(),
            });
            if (error) throw error;
            toast('Счёт выставлен', 'ok');
```

«стало»:

```js
            const { data, error } = await supabase.rpc('create_invoice_for_visit', {
                visit_id: visit.id,
                visit_service_ids: unInvoicedIds.slice(),
            });
            if (error) throw error;
            // INVOICE_APPEND_V1 — строки легли в уже выставленный неоплаченный счёт: тот же номер, новая сумма.
            toast(isAppended(data) ? invoiceAppendNote(data) : 'Счёт выставлен', 'ok');
```

- [ ] **Step 4: run, expect PASS**

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/picker-invoice.test.mjs public/js/admin/__tests__/print-auto.test.mjs public/js/admin/views/visit-bill-origin.test.js public/js/admin/__tests__/picker-attach-package-day.test.mjs public/js/admin/__tests__/pick-day-calculator.test.mjs public/js/admin/__tests__/cashier-line-fix.test.mjs public/js/admin/__tests__/cashier-unbilled.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs
```

Ожидается: `ℹ fail 0`.

- [ ] **Step 5: commit** — Write `.git/U6_MSG.txt`:

```
INVOICE_APPEND_V1: калькулятор, окно визита и «Счёт визита» говорят «Добавлено в счёт № … — новая сумма …»; калькулятор печатает дописанный счёт целиком с сервера, карта платит не больше сметы; окно визита не пишет второе «создан»

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git add public/js/admin/views/service-picker-modal.js public/js/admin/views/visit-modal.js public/js/admin/views/visit-bill.js public/js/admin/__tests__/picker-invoice.test.mjs public/js/admin/__tests__/print-auto.test.mjs
git commit -F .git/U6_MSG.txt
```

### Task U6.6: прогон всех наборов, где встречается выставление счёта (ru и en)

**Files:** — (только проверка)

- [ ] **Step 1: список** — все тесты, которые зовут счёт, мастер, калькулятор, быструю регистрацию, окно и счёт визита или словарь (на копии 347bfd3d — 213 файлов, 2 814 тестов):

```bash
{ grep -rlE "create_invoice_for_visit|createInvoiceForVisit|cashier_line_add|addServiceToVisitInvoice|registerWalkIn|openVisitWizard|invoicePickerLines|visit-wizard|service-picker-modal|fast-registration|walk-in-booking|visit-modal|visit-bill|i18n-strings|pick-day|invoice-append" --include=*.test.js --include=*.test.mjs server public tests; } | sort -u | grep -v "branch-sync/records-e2e" > .git/u56-tests.txt
wc -l .git/u56-tests.txt
```

- [ ] **Step 2: ru** (идёт 15–20 минут):

```bash
node --experimental-vm-modules --test $(cat .git/u56-tests.txt | tr '\n' ' ') > .git/u56-ru.log 2>&1; grep -E "^ℹ (tests|pass|fail)" .git/u56-ru.log; grep -n "^✖" .git/u56-ru.log | head -40
```

- [ ] **Step 3: en** — то же с `--import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"` (лог — `.git/u56-en.log`).

- [ ] **Step 4:** `node --experimental-vm-modules --test server/services/branch-sync/records-e2e.test.js` — число падений должно совпасть с прогоном ДО U5.1 (его записать перед началом U5: на чистой копии 347bfd3d в этом окружении он падал 11 тестами и без правок — дело в окружении релея, не в коде). Ожидается: `ℹ fail 0` в шагах 2–3; падение — чинить в задаче, к которой относится тест, отдельным коммитом с тем же маркером. `.git/u56-*.txt`, `.git/u56-*.log` после прогона удалить.

---

## Расхождения с описанием (решено в плане так; показать координатору)

1. **«То же правило, что у `cashier_line_add`»** — не совсем: `cashier_line_add` берёт и бесплатный счёт, закрытый при выставлении (`paid`, итог 0). Описание владельца перечисляет `status = 'unpaid'` — план следует ему: дописывание в бесплатный счёт перевело бы его в «к оплате» и сняло бы номер очереди у уже стоящей в очереди бесплатной консультации (`settleZeroTotal`).
2. **Бесплатная новая часть** (итог 0: бесплатная услуга, 100 % скидка) — своим, сразу закрытым счётом, как прежде, а не в неоплаченный: иначе её строка ждала бы оплаты чужих услуг (FREE_SERVICE_V1). В кассе такие счета не видны (итог 0).
3. **«Ручная скидка новой части добавляется … пересчёт `repriceUnpaidInvoice(absolute)`»** — буквально так не складывается: `repriceUnpaidInvoice` даёт `max(ручная, пол группы по всей базе)`, и часть с полом группы + часть с ручной скидкой теряли бы деньги (10 000 + 20 000 → 20 000). План пишет в `manual_discount` прежний ОСТАТОК скидки счёта + остаток новой части — `repriceUnpaidInvoice(absolute)` даёт ровно сумму. Следствие — в «Рисках», п. 4.
4. **«Номера очереди выдаются при оплате, как сейчас»** — сейчас мастер и быстрая регистрация спрашивают номер СРАЗУ после записи (`issue_queue_numbers`), а при оплате строки только переходят в `queued`. План это не меняет.
5. **«Идемпотентность `create_invoice_for_visit`»** — ключа повтора у этого RPC нет и не было; защита от повтора — отказ «Услуга №… уже в счёте». Дописывание стоит после неё, повтор по-прежнему отказывает и счёт не меняет (тест U6.1).
6. **«Услуги на 2 дня → 2 визита, 2 счёта» / «Всё на один день»** — есть только в мастере. Калькулятор всегда заводит ОДИН визит (день — самая ранняя строка со временем, `cartVisitDateIso`), двух визитов у него не бывает; вместо предупреждения — «Визит — вт 3 ноября: все услуги сметы в этот день», когда визит не сегодня.
7. **Лишняя дверь автопереноса, которой нет в описании** — услуга без врача с одним назначенным исполнителем получала день его слота (часто завтра). Закрыта в U5.2.
8. **Быстрая регистрация, карточка CRM, заявки API, календарь** — автопереноса на другой день у них нет (проверено), правок нет. Трёхколоночный `autoPickSlot` калькулятора сейчас не вызывается ни одним окном — правлен для единства правила.
9. **«Печать обновлённого маршрутного листа»** — маршрутный лист врача — это список ЕГО направлений (номера счёта на нём нет и не было); после дописывания он печатается как прежде, номер и новую сумму называет тост мастера. Номер счёта на листе — отдельная мелкая задача, если владелец захочет.

## Risks / implementer must check

1. **Порядок `i18n-strings.js`.** Оба блока словаря вставляются сразу после `export const STRINGS = {`; если к U5 там уже стоят блоки U1–U7 — вставлять так же (новый блок первым), чужие строки не переставлять. Ключи «Выбрать день», «Всё на один день», «В счёте нет позиций.» на 347bfd3d отсутствуют — если более ранняя задача выпуска добавит такой же ключ, второй не добавлять (дубликат ключа объекта молча перекроет первый).
2. **U9 (DUP_STOP_V1) идёт после U6** и правит те же двери мастера (`createVisit`) и `issueVisitInvoice`-соседей: сохранить `appendNotes`, `needsDay`, ветку `appendTargetInvoice` при слиянии. U10b правит `fast-registration.js`/мастер — сохранить `state.result.appended` в `totalDue`/`printInvoice`/`toSavedState`.
3. **Номера строк** приблизительные: каждая правка привязана к тексту «было». Если «было» не находится из-за правки более ранней задачи — найти то же место по смыслу.
4. **Деньги — граничные случаи, принятые в плане:**
   - `manual_discount` дописанного счёта = прежний ОСТАТОК скидки (ручная и пол группы вместе) + остаток новой части. Иначе скидка двух частей не складывается (см. «Сверено с кодом»). Следствие: если позже у пациента снимут группу, пол группы первой части останется в счёте «ручной» до его оплаты — проверить, что это приемлемо владельцу.
   - Округление: пол группы считается от суммы баз (`round2(база × %)`), а части — каждая от своей; на дробных суммах возможна разница 0,01 сум в пользу пациента.
   - Бесплатная новая часть (итог 0) — своим, сразу закрытым счётом, как прежде (иначе бесплатная консультация ждала бы оплаты анализа). Бесплатный закрытый счёт (status `paid`, итог 0) не дописывается — `cashier_line_add` его берёт, `create_invoice_for_visit` нет (иначе его строки ушли бы из очереди: `settleZeroTotal` снимает номер у «снова к оплате»).
   - «Баланс: использовать» и подарочная карта в мастере и калькуляторе ограничены суммой ЭТОЙ сметы — прежние строки дописанного счёта они не оплачивают.
5. **Отчёты.** У дописанного счёта прежние `created_at` и `created_by`: в «Счета» и «По строкам» (`reports.js` ~:1181, ~:3037 — колонка «Регистратор» = создатель счёта) новые строки числятся за тем, кто выставил счёт первым, и в его день. Визит = один день, так что день обычно тот же; исключение — «Сформировать счёт» окна визита по старому неоплаченному визиту (раньше — новый счёт сегодняшним числом). Показать владельцу в заметках к выпуску.
6. **Филиалы.** Дописывание едет теми же триггерами, что `cashier_line_add` (тест U6.1); `manual_discount/manual_base` не едут (местный учёт, как и прежде). Счёт, приехавший из другого здания, не дописывается — строки получают новый свой счёт.
7. **Мастер и часы клиники.** «Сегодня» для автовыбора — местный день браузера, окна считает сервер (`calendar_slots`, часы врача и клиники). Вечером после конца часов клиники пометка «Сегодня у врача нет свободного времени» появится и у врача, который работает «до 23:59» — это правда (клиника закрыта), «Ближайшее» поставит завтра.
8. **`wizard-booking.test.mjs`** зависел от часа запуска только потому, что мастер сам уходил на завтра; правка 3g в U5.2 обязательна — без неё вечерний прогон CI падает.
9. **Не проверено в браузере:** раскладка красной пометки в узкой смете (520 px) и в строке каталога калькулятора; открытие календаря по «Выбрать день» из сметы (через перерисовку шага 1). Проверить руками на копии тестовой клиники (R).

## Manual check for the owner

1. Вечером (или у врача с выходным сегодня) «Добавить услуги» → консультация: красная строка «Сегодня у врача нет свободного времени», кнопка «Ближайшее: …»; без выбора дня «Далее» серая. Нажать «Ближайшее» и добавить анализ — в смете «Услуги на 2 дня → 2 визита, 2 счёта», «Всё на один день» — предупреждение уходит, сохраняется один визит и один счёт.
2. Зарегистрировать пациента со счётом, не платить, и сразу добавить ему ещё услугу (мастер, быстрая регистрация или окно визита): «Добавлено в счёт № … — новая сумма …», в кассе один счёт с обеими услугами; после оплаты обе услуги в очереди.
3. Оплатить счёт частично и снова добавить услугу — появляется второй счёт (оплаченный не меняется).

