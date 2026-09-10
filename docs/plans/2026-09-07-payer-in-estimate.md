# Плательщик в смете + акт с очередью — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Компанию-плательщика видно и выбирают в СМЕТЕ; шаг «Кто платит» подтверждает выбор кнопкой «Сменить»; акт печатает номер очереди и два места подписи.

**Architecture:** Источник правды не меняется — `wiz.payerId`. Смета и шаг «Кто платит» становятся двумя ВИДАМИ на это поле, оба зовут один `setPayer()`. Чистая логика выбора (одиночность, снятие, переполнение «Ещё N») выносится в новый модуль `payer-choice.js`, потому что `visit-wizard.js` ни один тест не импортирует — про него пишут проверки по исходнику. Акт получает уже написанный блок очереди из `doc-variants.js`, который для этого экспортируется.

**Tech Stack:** Vanilla ES modules, без сборки. `node --test` (node:test + assert). Печатные бланки проверяются через `buildSheetHtml()` из `public/js/shared/doc-render.js`.

**Spec:** `docs/specs/2026-09-07-payer-in-estimate-design.md`

**Branch:** `feat/payer-in-estimate` (уже создана, отходит от v1.0.2)

---

## Что важно знать до начала

1. **`visit-wizard.js` не импортируется тестами.** `booking-doors.test.mjs`,
   `wizard-booking.test.mjs` и `wizard-templates.test.mjs` читают его как ТЕКСТ
   (`fs.readFileSync`) и проверяют исходник. Поэтому поведение выбора живёт в
   отдельном модуле, а про сам экран пишутся проверки по исходнику — не
   «поленились», а единственный способ, которым этот файл проверяем.
2. **`i18n-coverage.test.mjs` — репозиторный сторож.** Любой новый русский
   литерал в экранном модуле обязан быть в `public/js/admin/i18n-strings.js`
   (все три языка), а собранные из кусков предложения запрещены — только
   `trf('{шаблон}', { … })`. Забыть = красный тест, а не «потом переведём».
3. **`setPayer('self')` НЕ годится для снятия отметки.** Он зовёт
   `setPayKind('self')`, то есть сбрасывает и ТИП плательщика — ряд компаний
   схлопнется целиком. Для снятия нужен отдельный `clearPayer()`.
4. **«Далее» уже блокируется**, когда тип выбран, а компания нет — в
   `nextBlockReason()` под маркером `PAYER_TYPE_THEN_COMPANY_V1`. Ничего
   добавлять не нужно.
5. **Флейк порт-тестов** (CLAUDE.md): сетевые ошибки в тестах, поднимающих
   порт, — известная среда, а не регрессия. Ошибки утверждений — настоящие.

## File Structure

| Файл | Что делает | Задача |
|---|---|---|
| `public/js/admin/views/payer-choice.js` | **создаётся.** Чистая логика ряда компаний: `splitCompanies()` (что показать, что под «Ещё N») и `toggleCompanyId()` (одиночный выбор со снятием). Без DOM, без импортов. | 1 |
| `public/js/admin/__tests__/payer-choice.test.mjs` | **создаётся.** Поведенческие тесты обеих функций. | 1 |
| `public/js/admin/views/visit-wizard.js` | ряд компаний в смете; `clearPayer()`; карточка «выбран в смете» + «Сменить» на шаге 3; очередь покрытых услуг в `printAkt`. Два маркера `PAYER_COMPANY_ON_STEP2_V1` переписываются. | 2, 3, 6 |
| `public/js/admin/i18n-strings.js` | новые строки на UZ/RU/EN. | 2, 3 |
| `public/js/admin/views/doc-variants.js` | `queueBlockHtml` и `QUEUE_CSS` становятся экспортируемыми. | 5 |
| `public/js/shared/doc-render.js` | `actBody`: третье место подписи убрать, блок очереди добавить. | 4, 5 |
| `public/js/admin/__tests__/act-sheet.test.mjs` | **создаётся.** Подписи и очередь на акте через `buildSheetHtml`. | 4, 5 |
| `public/js/admin/__tests__/estimate-payer-source.test.mjs` | **создаётся.** Проверки по исходнику `visit-wizard.js`. | 2, 3, 6 |

---

## Task 1: Чистая логика выбора компании

**Files:**
- Create: `public/js/admin/views/payer-choice.js`
- Test: `public/js/admin/__tests__/payer-choice.test.mjs`

- [ ] **Step 1: Написать падающий тест**

Создать `public/js/admin/__tests__/payer-choice.test.mjs`:

```js
// PAYER_COMPANY_IN_ESTIMATE_V1 — поведение ряда компаний в СМЕТЕ.
//
// Эти две функции существуют отдельно от visit-wizard.js по причине, а не для
// красоты: тот файл тесты не импортируют (он тянет supabase, иконки и весь
// экран), про него пишут проверки по ИСХОДНИКУ. Одиночность выбора, снятие
// повторным кликом и переполнение «Ещё N» исходником не проверяются — их
// проверяют настоящими вызовами, здесь.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitCompanies, toggleCompanyId } from '../views/payer-choice.js';

const P = (id, name) => ({ id, name });
const FIVE = [P(1, 'Cenergo'), P(2, 'Grandpharm'), P(3, 'Uzbekinvest'), P(4, 'Kafolat'), P(5, 'Alskom')];

test('короткий список показывается целиком, «Ещё N» не появляется', () => {
  const r = splitCompanies(FIVE.slice(0, 3), 'self');
  assert.equal(r.shown.length, 3);
  assert.equal(r.hiddenCount, 0);
});

test('список ровно в предел не прячет ничего', () => {
  const r = splitCompanies(FIVE.slice(0, 4), 'self');
  assert.equal(r.shown.length, 4);
  assert.equal(r.hiddenCount, 0);
});

test('длинный список прячет хвост под «Ещё N»', () => {
  const r = splitCompanies(FIVE, 'self');
  assert.equal(r.shown.length, 4);
  assert.equal(r.hiddenCount, 1);
  assert.deepEqual(r.hidden.map(p => p.name), ['Alskom']);
});

// Ряд без единой отметки — это ряд, который врёт: компания выбрана, а глазами
// этого не видно, и регистратор выбирает её второй раз.
test('выбранная компания из хвоста поднимается в видимые', () => {
  const r = splitCompanies(FIVE, 5);
  assert.ok(r.shown.some(p => String(p.id) === '5'), 'выбранная видна');
  assert.equal(r.shown.length, 4, 'ряд не разросся');
  assert.equal(r.hiddenCount, 1, 'вытесненная ушла в хвост');
  assert.ok(r.hidden.some(p => String(p.id) === '4'), 'вытеснена именно последняя видимая');
});

test('пустой и мусорный вход не роняют', () => {
  for (const bad of [undefined, null, [], [null, undefined]]) {
    const r = splitCompanies(bad, 'self');
    assert.equal(r.shown.length, 0);
    assert.equal(r.hiddenCount, 0);
  }
});

// У визита ровно один payer_id: отметка на второй компании обязана снять первую.
test('клик по другой компании переносит выбор', () => {
  assert.equal(toggleCompanyId(1, 2), '2');
});

test('повторный клик по выбранной снимает выбор', () => {
  assert.equal(toggleCompanyId(2, 2), 'self');
  assert.equal(toggleCompanyId('2', 2), 'self', 'число и строка — один и тот же плательщик');
});

test('клик при пустом выборе выбирает', () => {
  assert.equal(toggleCompanyId('self', 3), '3');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test public/js/admin/__tests__/payer-choice.test.mjs`
Expected: FAIL — `Cannot find module .../views/payer-choice.js`

- [ ] **Step 3: Написать модуль**

Создать `public/js/admin/views/payer-choice.js`:

```js
// PAYER_COMPANY_IN_ESTIMATE_V1 — чистая логика ряда компаний в СМЕТЕ.
//
// Почему отдельным файлом. visit-wizard.js ни один тест не импортирует: он
// тянет supabase, иконки и весь экран, и про него пишут проверки по исходнику
// (booking-doors.test.mjs, wizard-templates.test.mjs). Одиночность выбора и
// переполнение исходником не проверяются, а сломаться могут молча — поэтому
// они здесь, где их можно ВЫЗВАТЬ.
//
// Без DOM и без импортов: всё, что нужно, приходит аргументами.

// Четыре — сколько помещается в колонку сметы в два ряда, не съедая её высоту.
const DEFAULT_LIMIT = 4;

/**
 * Что показать сразу и что спрятать под «Ещё N».
 *
 * Выбранная компания показывается ВСЕГДА, даже если по порядку попала в
 * хвост: ряд без единой отметки выглядит как «ничего не выбрано», и компанию
 * выбирают второй раз. Она меняется местами с последней видимой, поэтому
 * длина ряда не скачет.
 *
 * @param {Array<{id:*, name:string}>} list  компании одного типа
 * @param {*} selectedId                     wiz.payerId ('self', если нет)
 * @param {number} [limit]
 * @returns {{shown:Array, hidden:Array, hiddenCount:number}}
 */
export function splitCompanies(list, selectedId, limit = DEFAULT_LIMIT) {
    const all = (Array.isArray(list) ? list : []).filter(Boolean);
    if (all.length <= limit) return { shown: all, hidden: [], hiddenCount: 0 };
    const shown = all.slice(0, limit);
    const hidden = all.slice(limit);
    const i = hidden.findIndex(p => String(p.id) === String(selectedId));
    if (i !== -1) {
        const displaced = shown[limit - 1];
        shown[limit - 1] = hidden[i];
        hidden[i] = displaced;
    }
    return { shown, hidden, hiddenCount: hidden.length };
}

/**
 * Что должно стать выбранным после клика по фишке.
 *
 * Выбор ОДИНОЧНЫЙ — у визита ровно один payer_id, поэтому клик по другой
 * компании переносит отметку, а не добавляет вторую. Повторный клик по
 * выбранной снимает её и возвращает 'self'; ТИП плательщика при этом остаётся,
 * и «Далее» не пропустит (nextBlockReason, PAYER_TYPE_THEN_COMPANY_V1).
 *
 * @returns {string} id компании или 'self'
 */
export function toggleCompanyId(currentId, clickedId) {
    return String(currentId) === String(clickedId) ? 'self' : String(clickedId);
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `node --test public/js/admin/__tests__/payer-choice.test.mjs`
Expected: PASS, 8 тестов

- [ ] **Step 5: Коммит**

```bash
git add public/js/admin/views/payer-choice.js public/js/admin/__tests__/payer-choice.test.mjs
git commit -m "feat(payers): чистая логика ряда компаний — одиночный выбор и «Ещё N»"
```

---

## Task 2: Ряд компаний в смете

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js` (импорт; `clearPayer()`; блок `dmsHint`; сборка карточки; два маркера `PAYER_COMPANY_ON_STEP2_V1`)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/estimate-payer-source.test.mjs`

- [ ] **Step 1: Написать падающий тест**

Создать `public/js/admin/__tests__/estimate-payer-source.test.mjs`:

```js
// PAYER_COMPANY_IN_ESTIMATE_V1 — проверки по ИСХОДНИКУ visit-wizard.js.
//
// Файл не импортируется тестами (supabase, иконки, весь экран), поэтому здесь
// закрепляется то, что видно в тексте: ряд компаний собран, снятие идёт через
// clearPayer (а не через setPayer('self'), который сбросил бы ТИП), и надпись
// «выберете на следующем шаге» не вернулась.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'visit-wizard.js'), 'utf8');

test('смета собирает ряд компаний', () => {
  assert.match(src, /companyRow/, 'ряд есть');
  assert.match(src, /splitCompanies|toggleCompanyId/, 'логика взята из payer-choice.js, а не написана заново');
  assert.match(src, /from '\.\/payer-choice\.js/, 'модуль импортирован');
});

// setPayer('self') зовёт setPayKind('self') и сбрасывает ТИП — ряд компаний
// схлопнулся бы целиком. Ровно эту ошибку тест и держит закрытой.
test('снятие отметки не сбрасывает тип плательщика', () => {
  assert.match(src, /function clearPayer\(\)/, 'отдельная функция снятия');
  const at = src.indexOf('function clearPayer()');
  const body = src.slice(at, at + 260);
  assert.doesNotMatch(body, /setPayKind/, 'clearPayer не трогает тип');
  assert.match(body, /payerId\s*=\s*'self'/);
});

test('надпись «выберете на шаге» не вернулась', () => {
  assert.doesNotMatch(src, /компанию выберете на шаге/, 'её место занял настоящий список');
});

// Комментарии в этом проекте — единственная запись о том, ПОЧЕМУ код такой.
// Развернуть решение и оставить прежний довод стоять = спор с призраком.
test('прежний маркер переписан, а не удалён молча', () => {
  assert.doesNotMatch(src, /ряд компаний из СМЕТЫ убран/, 'старая формулировка снята');
  assert.match(src, /PAYER_COMPANY_IN_ESTIMATE_V1/, 'новый маркер на месте');
  assert.match(src, /PAYER_COMPANY_ON_STEP2_V1/, 'и ссылка на отменённое решение сохранена');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test public/js/admin/__tests__/estimate-payer-source.test.mjs`
Expected: FAIL — «ряд есть» (`companyRow` отсутствует)

- [ ] **Step 3: Добавить строку в словарь**

В `public/js/admin/i18n-strings.js` добавить запись (формат файла — одна строка
на запись):

```js
  "Ещё {n}": {"en":"{n} more","ru":"Ещё {n}","uz":"Yana {n} ta"},
```

И УДАЛИТЬ ставшую ненужной запись целиком:

```js
  "компанию выберете на шаге «Кто платит»": {"en":"you pick the company on the “Who pays” step","ru":"компанию выберете на шаге «Кто платит»","uz":"kompaniyani «Kim to'laydi» bosqichida tanlaysiz"},
```

- [ ] **Step 4: Импорт и `clearPayer()`**

В `public/js/admin/views/visit-wizard.js` рядом с прочими импортами вида
`import { … } from './…js'` добавить:

```js
import { splitCompanies, toggleCompanyId } from './payer-choice.js';
```

Сразу после закрывающей скобки `function setPayer(choiceId) { … }` добавить:

```js
    // Снятие отметки. НЕ через setPayer('self'): тот зовёт setPayKind('self') и
    // сбросил бы ТИП плательщика — ряд компаний схлопнулся бы целиком, хотя
    // регистратор всего лишь передумал насчёт конкретной компании. Тип
    // остаётся, «Далее» не пропустит (nextBlockReason).
    function clearPayer() {
        wiz.payerId = 'self';
        paint();
    }
```

- [ ] **Step 5: Переписать маркер под `setPayer`**

Заменить блок:

```js
    // PAYER_COMPANY_ON_STEP2_V1 - ряд компаний и всплывающий список «Ещё N»
    // удалены вместе с выбором компании в СМЕТЕ: компанию выбирают на шаге
    // «Кто платит», где рядом видно и что она покрывает.
```

на:

```js
    // PAYER_COMPANY_IN_ESTIMATE_V1 (2026-09-07) — ряд компаний и «Ещё N»
    // ВЕРНУЛИСЬ в смету, отменяя PAYER_COMPANY_ON_STEP2_V1.
    //
    // Тот довод был: «держать один выбор в двух местах — два источника правды».
    // Довод про ДАННЫЕ, и к делу он не относился: источник один и остаётся один
    // — wiz.payerId. Смета и шаг «Кто платит» два ВИДА на одно поле, оба зовут
    // setPayer(); разойтись в том, кто выбран, они не могут по построению.
    // Прежняя формулировка спутала «выбор в двух местах» с «двумя состояниями».
    //
    // А платила она тем, что регистратор не мог узнать ИЗ СМЕТЫ, заведена ли у
    // клиники нужная страховая: вместо списка стояла надпись «выберете на
    // следующем шаге», то есть просьба поверить на слово и идти дальше.
```

- [ ] **Step 6: Собрать ряд компаний**

Заменить целиком блок от комментария
`// PAYER_COMPANY_ON_STEP2_V1 — ряд компаний из СМЕТЫ убран:` до конца
присваивания `const dmsHint = … ;` на:

```js
        // PAYER_COMPANY_IN_ESTIMATE_V1 — сам ряд. Компанию видно и выбирают
        // здесь; шаг «Кто платит» её подтверждает и делит услуги.
        const _payer = wiz.payers.find(p => String(p.id) === String(wiz.payerId));
        const companyRow = (() => {
            if (wiz.payKind === 'self') return null;
            const list = payersOfKind(wiz.payKind);
            if (!list.length) return null;
            const { shown, hiddenCount } = wiz.payersExpanded
                ? { shown: list, hiddenCount: 0 }
                : splitCompanies(list, wiz.payerId);
            const chip = (p) => {
                const on = String(wiz.payerId) === String(p.id);
                return h('button', {
                    type: 'button', title: p.name,
                    onclick: () => {
                        const next = toggleCompanyId(wiz.payerId, p.id);
                        if (next === 'self') clearPayer(); else setPayer(next);
                    },
                    style: {
                        padding: '7px 9px', borderRadius: '9px', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: '12px', fontWeight: 700,
                        display: 'flex', alignItems: 'center', gap: '6px',
                        minWidth: 0, boxSizing: 'border-box', minHeight: '34px',
                        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                        textAlign: 'left',
                        background: on ? 'var(--primary-50, #f2faf8)' : 'var(--white, #fff)',
                        border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-200)'),
                        boxShadow: on ? 'inset 0 0 0 1px var(--primary-500)' : 'none',
                        color: on ? 'var(--primary-700)' : 'var(--ink-700)',
                    },
                },
                    h('span', {
                        style: {
                            flex: '0 0 auto', width: '14px', height: '14px', borderRadius: '4px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: on ? 'var(--primary-500)' : 'var(--white, #fff)',
                            border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-300, #c7d0d6)'),
                            color: 'var(--white, #fff)',
                        },
                    }, on ? Icon('Check', { size: 10 }) : null),
                    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, p.name));
            };
            const row = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '6px' } },
                ...shown.map(chip));
            if (hiddenCount) {
                row.appendChild(h('button', {
                    type: 'button',
                    onclick: () => { wiz.payersExpanded = true; paint(); },
                    style: {
                        padding: '7px 9px', borderRadius: '9px', cursor: 'pointer', minHeight: '34px',
                        fontFamily: 'inherit', fontSize: '12px', fontWeight: 700,
                        background: 'var(--white, #fff)', border: '1px dashed var(--ink-200)',
                        color: 'var(--ink-700)',
                    },
                }, trf('Ещё {n}', { n: hiddenCount })));
            }
            return row;
        })();

        // COVERAGE_SPLIT_V1 — итог: на кого пойдёт счёт и сколько из сметы он
        // берёт на себя. Остаётся под рядом, как и было.
        const dmsHint = (wiz.payKind === 'self' || !_payer)
            ? null
            : h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                trf('{name} · покрывает {covered} из {total} сум', { name: _payer.name, covered: fmtPrice(coveredTotal()), total: fmtPrice(cartTotal()) }));
```

- [ ] **Step 7: Завести состояние раскрытия и сбрасывать его**

В объекте начального состояния `wiz`, рядом со строкой `payerId: 'self',`, добавить:

```js
        payersExpanded: false,   // PAYER_COMPANY_IN_ESTIMATE_V1 — раскрыт ли «Ещё N»
```

Первой строкой тела `function setPayKind(kindId) {` добавить:

```js
        wiz.payersExpanded = false;   // у другого типа свой список — раскрытие не переносится
```

- [ ] **Step 8: Вставить ряд в карточку сметы**

Заменить

```js
            payRow,
            noPayersHint,
            dmsHint,
```

на

```js
            payRow,
            companyRow,
            noPayersHint,
            dmsHint,
```

- [ ] **Step 9: Запустить тесты**

Run: `node --test public/js/admin/__tests__/estimate-payer-source.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
Expected: PASS оба файла

- [ ] **Step 10: Коммит**

```bash
git add public/js/admin/views/visit-wizard.js public/js/admin/i18n-strings.js public/js/admin/__tests__/estimate-payer-source.test.mjs
git commit -m "feat(visit): компанию-плательщика видно и выбирают в смете"
```

---

## Task 3: Шаг «Кто платит» подтверждает выбор

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js` (`wiz`, `setPayer`, `paintStep3`)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/estimate-payer-source.test.mjs` (дописать)

- [ ] **Step 1: Дописать падающий тест**

В конец `public/js/admin/__tests__/estimate-payer-source.test.mjs` добавить:

```js
// Компания уже выбрана в смете — спрашивать её второй раз значит делать вид,
// что первый выбор не считался.
test('шаг «Кто платит» подтверждает выбор, а не спрашивает заново', () => {
  assert.match(src, /выбран в смете/, 'карточка подтверждения');
  assert.match(src, /payerPickerOpen/, 'состояние раскрытия сетки');
  assert.match(src, /'Сменить'|"Сменить"/, 'кнопка возврата к сетке');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test public/js/admin/__tests__/estimate-payer-source.test.mjs`
Expected: FAIL — «карточка подтверждения»

- [ ] **Step 3: Добавить строки в словарь**

В `public/js/admin/i18n-strings.js`:

```js
  "Сменить": {"en":"Change","ru":"Сменить","uz":"O'zgartirish"},
  "{kind} · выбран в смете": {"en":"{kind} · picked in the estimate","ru":"{kind} · выбран в смете","uz":"{kind} · smetada tanlangan"},
```

- [ ] **Step 4: Завести состояние раскрытия сетки**

В объекте `wiz`, рядом с `payersExpanded: false,`, добавить:

```js
        payerPickerOpen: false,   // PAYER_COMPANY_IN_ESTIMATE_V1 — раскрыта ли сетка на шаге «Кто платит»
```

В `function setPayer(choiceId) { … }` перед завершающим `paint();` добавить:

```js
        wiz.payerPickerOpen = false;   // выбрали — сетка сворачивается обратно в карточку
```

- [ ] **Step 5: Карточка вместо сетки**

В `paintStep3`, после цикла `for (const p of list) { … }`, добавить:

```js
        // PAYER_COMPANY_IN_ESTIMATE_V1 — компанию выбрали в смете, и этот шаг
        // её ПОДТВЕРЖДАЕТ. Спрашивать второй раз значит делать вид, что первый
        // выбор не считался; «Сменить» раскрывает прежнюю сетку на месте, без
        // возврата на шаг назад.
        const chosen = wiz.payers.find(p => String(p.id) === String(wiz.payerId));
        const picker = (chosen && !wiz.payerPickerOpen)
            ? h('div', {
                style: {
                    display: 'flex', alignItems: 'center', gap: '12px', maxWidth: '520px',
                    padding: '14px 16px', borderRadius: '12px',
                    border: '1px solid var(--primary-500)', background: 'var(--primary-50, #f2faf8)',
                },
            },
                h('span', { style: { color: 'var(--primary-700)', display: 'flex' } }, Icon('Check', { size: 16 })),
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, chosen.name),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '3px' } },
                        trf('{kind} · выбран в смете', { kind: payerKindRu(chosen.kind) }))),
                h('button', {
                    type: 'button',
                    onclick: () => { wiz.payerPickerOpen = true; paint(); },
                    style: {
                        padding: '8px 14px', borderRadius: '9px', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 700,
                        background: 'var(--white, #fff)', border: '1px solid var(--ink-200)',
                        color: 'var(--ink-700)',
                    },
                }, tr('Сменить')))
            : grid;
```

Затем в финальном `root.appendChild(h('div', { class: 'card', … }, …))` этого
шага заменить аргумент `grid` на `picker`.

- [ ] **Step 6: Запустить тесты**

Run: `node --test public/js/admin/__tests__/estimate-payer-source.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add public/js/admin/views/visit-wizard.js public/js/admin/i18n-strings.js public/js/admin/__tests__/estimate-payer-source.test.mjs
git commit -m "feat(visit): шаг «Кто платит» подтверждает компанию и даёт «Сменить»"
```

---

## Task 4: Акт — два места подписи

**Files:**
- Modify: `public/js/shared/doc-render.js` (`actBody`, маркер `ACT_PROTOCOL_SIGN_V1`)
- Test: `public/js/admin/__tests__/act-sheet.test.mjs`

- [ ] **Step 1: Написать падающий тест**

Создать `public/js/admin/__tests__/act-sheet.test.mjs`:

```js
// ACT_SHEET_V1 — акт оказанных услуг: места подписи и номер очереди.
//
// Печатает акт actBody() из doc-render.js: renderDesignedVariant() для
// type='act' ветки не имеет и возвращает undefined, поэтому designed-вариант
// его не перехватывает (в отличие от чека — см. fiscal-receipt.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml } from '../../shared/doc-render.js';

const S = { clinicName: 'Novo Medics' };
const act = (extra) => buildSheetHtml({
  type: 'act', s: S,
  data: {
    title: 'Акт оказанных медицинских услуг',
    docNo: 'АКТ INV-26-03031',
    coverage: 'По договору',
    patient: [['ФИО', 'Мамашарипова Нилуфар Туйчиевна'], ['Карта №', 'P-26-71065']],
    payer: [['Организация', '"Cenergo" ООО']],
    items: [{ name: 'CA 15-3 (Онкомаркер)', qty: 1, price: 80000 }],
    ...extra,
  },
});

const signPlaces = (html) => (html.match(/подпись \/ Ф\.И\.О\./g) || []).length;

// Решение владельца 2026-09-07: мест подписи два — Пациент и Врач. Третье
// («Представитель страховой») печаталось на КАЖДОМ акте, включая договорные,
// где страховой в сделке нет вообще.
test('акт печатает ровно два места подписи', () => {
  assert.equal(signPlaces(act()), 2);
});

test('«Представитель страховой» с акта убран', () => {
  assert.doesNotMatch(act(), /Представитель страховой/);
});

test('место печати и дата остались', () => {
  const html = act();
  assert.match(html, /М\.П\./);
  assert.match(html, /Дата/);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test public/js/admin/__tests__/act-sheet.test.mjs`
Expected: FAIL — «ровно два места подписи» (получено 3) и «убран»

- [ ] **Step 3: Убрать третью колонку**

В `public/js/shared/doc-render.js`, в блоке под `<!-- ACT_PROTOCOL_SIGN_V1 -->`,
удалить строку:

```html
                <div style="flex:1;border-top:1px solid ${s.ink};padding-top:6px;">Представитель страховой<br><span style="font-size:10px;color:#8a96a0;">подпись / Ф.И.О.</span></div>
```

и дописать к маркеру причину:

```js
        <div style="margin-top:40px;font-size:11.5px;color:#55636d;"><!-- ACT_PROTOCOL_SIGN_V1 -->
            <!-- Решение владельца 2026-09-07: мест подписи два. Третье,
                 «Представитель страховой», печаталось на КАЖДОМ акте — и на
                 договорном, где страховой в сделке нет, и подписывать его было
                 некому: пустая линия на документе, который подшивают. -->
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `node --test public/js/admin/__tests__/act-sheet.test.mjs`
Expected: PASS, 3 теста

- [ ] **Step 5: Коммит**

```bash
git add public/js/shared/doc-render.js public/js/admin/__tests__/act-sheet.test.mjs
git commit -m "fix(act): два места подписи вместо трёх"
```

---

## Task 5: Акт — блок номера очереди

**Files:**
- Modify: `public/js/admin/views/doc-variants.js` (экспорт `queueBlockHtml`, `QUEUE_CSS`)
- Modify: `public/js/shared/doc-render.js` (импорт и `actBody`)
- Test: `public/js/admin/__tests__/act-sheet.test.mjs` (дописать)

- [ ] **Step 1: Дописать падающий тест**

В конец `public/js/admin/__tests__/act-sheet.test.mjs` добавить:

```js
// Акт служит и талоном: с ним идут в лабораторию. Номер очереди на нём —
// то же, что на чеке, и по той же причине (RECEIPT_QUEUE_V1).
test('акт печатает номер очереди', () => {
  const html = act({ queue: [{ service: 'CA 15-3 (Онкомаркер)', label: 'Лаборатория', number: 28 }] });
  assert.match(html, /Номер очереди/, 'блок подписан');
  assert.match(html, /Лаборатория/, 'куда идти — без этого номер бессмыслен');
  assert.match(html, />28</, 'сам номер');
});

test('несколько талонов печатаются все', () => {
  const html = act({ queue: [
    { service: 'CA 15-3 (Онкомаркер)', label: 'Лаборатория', number: 28 },
    { service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 7 },
  ] });
  assert.match(html, /Лаборатория/);
  assert.match(html, /Набиев Ойбек/);
  assert.match(html, />28</);
  assert.match(html, />7</);
});

test('без талонов пустой блок не печатается', () => {
  for (const empty of [undefined, null, []]) {
    assert.doesNotMatch(act({ queue: empty }), /Номер очереди/, JSON.stringify(empty));
  }
});

test('талон без номера пропускается', () => {
  assert.doesNotMatch(act({ queue: [{ service: 'X', label: 'Y', number: null }] }), /Номер очереди/);
});

test('данные талона экранируются', () => {
  const html = act({ queue: [{ service: 'S', label: '<img src=x onerror=alert(1)>', number: 3 }] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test public/js/admin/__tests__/act-sheet.test.mjs`
Expected: FAIL — «блок подписан» (в акте нет «Номер очереди»)

- [ ] **Step 3: Экспортировать блок из doc-variants.js**

В `public/js/admin/views/doc-variants.js` сделать два объявления
экспортируемыми (тела не трогать):

```js
export const QUEUE_CSS = `
```

```js
export function queueBlockHtml(d) {
```

- [ ] **Step 4: Отрисовать блок в акте**

В `public/js/shared/doc-render.js` расширить существующий импорт:

```js
import { renderDesignedVariant, queueBlockHtml, QUEUE_CSS } from '../admin/views/doc-variants.js?v=noqr1';
```

В `actBody(s, data)` добавить стили в начало возвращаемой строки:

```js
        <style>${QUEUE_CSS}</style>
```

и сам блок ПЕРЕД местами подписи, то есть непосредственно перед
`<div style="margin-top:40px;…"><!-- ACT_PROTOCOL_SIGN_V1 -->`:

```js
        ${queueBlockHtml(data)}
```

Порядок именно такой: очередь — то, ради чего документ несут дальше, и она
должна попасть на глаза раньше, чем линии для подписей.

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run: `node --test public/js/admin/__tests__/act-sheet.test.mjs`
Expected: PASS, 8 тестов

- [ ] **Step 6: Коммит**

```bash
git add public/js/admin/views/doc-variants.js public/js/shared/doc-render.js public/js/admin/__tests__/act-sheet.test.mjs
git commit -m "feat(act): номер очереди на акте — с ним идут в лабораторию"
```

---

## Task 6: Очередь на акте — по услугам акта

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js` (`printAkt` и место её вызова)
- Test: `public/js/admin/__tests__/estimate-payer-source.test.mjs` (дописать)

- [ ] **Step 1: Дописать падающий тест**

В конец `public/js/admin/__tests__/estimate-payer-source.test.mjs` добавить:

```js
// Счёт пациента и акт плательщика содержат ПРОТИВОПОЛОЖНЫЕ наборы услуг
// (COVERAGE_SPLIT_V1). Отдать акту готовый queueRows счёта значит напечатать
// на нём номера к услугам, которых в нём нет, и потерять номера к тем, что есть.
//
// И отбор идёт по строкам КОНКРЕТНОГО акта, а не по «всем покрытым»: актов
// печатается по одному на плательщика (цикл по aktJobs), и на акте «Cenergo»
// не должно быть номера к услуге, которую оплачивает другая организация.
test('акт получает очередь по СВОИМ услугам, а не по услугам счёта пациента', () => {
  const at = src.indexOf('function printAkt(');
  assert.notEqual(at, -1, 'printAkt на месте');
  const fn = src.slice(at, at + 2200);
  assert.match(fn, /\bqueue\b/, 'printAkt принимает и передаёт очередь');
  assert.match(src, /aktQueue/, 'очередь для акта собирается отдельно');
  const loop = src.slice(src.indexOf('for (const job of aktJobs)'), src.indexOf('for (const job of aktJobs)') + 600);
  assert.match(loop, /job\.lines/, 'отбор по строкам ЭТОГО акта, а не по общему набору');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node --test public/js/admin/__tests__/estimate-payer-source.test.mjs`
Expected: FAIL — «printAkt принимает и передаёт очередь»

- [ ] **Step 3: Принять и передать очередь**

В `printAkt` изменить сигнатуру:

```js
    function printAkt({ invoice, payerId, lines, visitDate, queue }) {
```

и в объекте `data:` рядом с `items:` добавить:

```js
                // ACT_SHEET_V1 — очередь по услугам АКТА. Готовый queueRows
                // счёта здесь не годится: он собран для услуг ПАЦИЕНТА, то есть
                // ровно для тех, которых в акте нет (COVERAGE_SPLIT_V1).
                queue: queue || [],
```

- [ ] **Step 4: Отобрать талоны услуг ЭТОГО акта на вызове**

Вызов стоит В ЦИКЛЕ: актов печатается по одному на плательщика. Поэтому отбор
идёт по строкам конкретного `job`, а не по общему набору покрытых услуг —
иначе на акте одной организации оказались бы номера к услугам другой.
`queueRows` объявлен выше в той же функции (`let queueRows = []`, маркер
`QUEUE_TICKET_V1`), поэтому в цикле он виден.

Заменить

```js
            for (const job of aktJobs) {
                try { printAkt(job); } catch (e) { console.warn('[wizard] akt print:', e); }
            }
```

на

```js
            for (const job of aktJobs) {
                // ACT_SHEET_V1 — талон связан с услугой полем service, и берём
                // мы только строки ЭТОГО акта: у второго плательщика свой акт и
                // свои номера, чужие на нём — прямая дезинформация регистратуры.
                const names = new Set((job.lines || []).map(c => c.svc.name));
                const aktQueue = queueRows.filter(q => names.has(q.service));
                try { printAkt({ ...job, queue: aktQueue }); } catch (e) { console.warn('[wizard] akt print:', e); }
            }
```

- [ ] **Step 5: Запустить тесты**

Run: `node --test public/js/admin/__tests__/estimate-payer-source.test.mjs`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add public/js/admin/views/visit-wizard.js public/js/admin/__tests__/estimate-payer-source.test.mjs
git commit -m "fix(act): на акте номера очереди его собственных услуг"
```

---

## Task 7: Полный прогон и живая проверка

- [ ] **Step 1: Весь набор**

Run: `npm test`
Expected: 0 падений. Сетевые ошибки в файлах, поднимающих порт
(`fetch failed / bad port`) — известный флейк среды (CLAUDE.md), перезапустить.
Ошибка утверждения — настоящая, разбирать.

- [ ] **Step 2: Посмотреть на экран**

Run: `npm start` → http://localhost:8000 → Пациенты → пациент → «Новый визит».

Проверить руками:
1. Добавить услугу, нажать «Страховая» — под кнопками появился ряд компаний.
2. Отметить компанию; отметить вторую — первая снялась.
3. Нажать по отмеченной ещё раз — отметка снялась, ТИП «Страховая» остался,
   «Далее» не пускает.
4. Если компаний больше четырёх — видно «Ещё N», раскрывается.
5. «Далее: Кто платит» — вместо сетки карточка с названием и «Сменить»;
   «Сменить» раскрывает сетку.
6. Довести визит до конца с плательщиком, напечатать акт: два места подписи,
   «Представитель страховой» нет, номер очереди на месте и относится к услуге
   плательщика.

Остановить: `Ctrl+C` в окне либо `stop-easymed.bat`.

- [ ] **Step 3: Прочитать свой дифф**

```bash
git status
git diff main...HEAD
```

Ничего из `data/`, никаких `*.db`, никаких ключей.

- [ ] **Step 4: ОСТАНОВИТЬСЯ И ЖДАТЬ ВЛАДЕЛЬЦА**

Правило владельца (CLAUDE.md, шаг 3): зелёные тесты — не то же самое, что
правильная работа, и смотрит он на dev-сервере. **Не пушить, пока не скажет.**
После «хорошо» — пуш ветки и PR; тег и релиз — отдельный вопрос владельцу.
