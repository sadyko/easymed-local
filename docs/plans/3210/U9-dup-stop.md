# U9. Жёсткий запрет повторного назначения в одном визите (DUP_STOP_V1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или executing-plans). Шаги — чекбоксы `- [ ]`.

**Goal:** сервер отказывает (409 `duplicate_order`, «Эта услуга уже назначена в этом визите: «…» — кем, когда, счёт № …») любой двери, которая заводит строку визита той же услуги, что уже назначена в ТОМ ЖЕ визите (консультация — тот же вид и тот же врач; у другого врача можно), если та строка не отменена и не отпущена с возвратом. Процедуры, товары и замена строки записи колл-центра не запрещаются. Администратор и главный врач назначают повтор с причиной (`__repeat_reason`, журнал счёта). Мастер визита и окна выбора гасят уже назначенное («уже назначено») и спрашивают сервер ДО `ensure_visit` — отказ не оставляет ни пустого визита, ни строки, ни счёта.

**Architecture:** одно правило «та же услуга» — чистый модуль `public/js/shared/dup-order.js` (`orderKey`, `repeatableLine`, шаблоны отказа), его берут сервер и экраны. Сервер — `server/services/domain/dup-order.js`: `liveOrders` (живые назначения визита: не `cancelled`, не товар, не процедура, не отпущенные с возвратом — то же условие, что `refundedOpenLineIds`), `duplicateHits` (совпадения с базой и внутри запроса), `checkOrders`/`assertOrders` (отказ или обход с причиной), `assertChangedOrder` (замена: проверка только при смене ключа), `logRepeatOrders` (строка `invoice_audit_log`, action `line_repeat_order`), `takeRepeatReason` (снимает `__repeat_reason` до `compile()`, как `takeNotesBase` снимает `__notes_base`). Поблажки дверей — без побочных эффектов: `bookedTwinFor` (правило R7b, вынесено из `retireBookedTwin`) и `autoTwinFor` (правило `wishYields`/`yieldAutoLine`). Двери: `/api/db` (вставка, пачка, upsert — рядом с `refuseVisitLineWrite`), `cashier_line_add`, `change_unpaid_service`/`cashier_line_change_service`, `cashier_line_set_doctor`, `patient_card_set_doctor`, `cashier_line_swap_paid`/`_quote`, `cashier_line_rebill_paid`/`_quote`, `create_invoice_for_visit` с `rebill_refunded`. Новый RPC только для чтения `visit_dup_check` (визит дня — тем же правилом, что `ensure_visit`, вынесенным в `dayVisitOf`). Клиент — `public/js/admin/views/dup-order-check.js` (`loadVisitOrders`, `orderedMatch`, `orderedLabel`, `blockedPickIds`, `precheckOrders`, `askRepeatReason`, `withRepeatReason`); мастер визита, калькулятор, быстрая регистрация, «Услуги приёма» кабинета врача и окно выбора услуги кассы (`pickService`: «Заменить услугу» в «Платежах», «Исправить услуги», «Ждут счёта» — раздел К1 спецификации).

**Миграция не нужна** (номер 271 не занимаем): индекс `idx_visit_services_visit (visit_id)` есть с миграции 004, отметки возврата — `pay_refund_releases` (162, индекс `kind, line_id`), журнал — `invoice_audit_log` (024; `invoice_id` допускает NULL). Триггер в базе не годится: строки соседних зданий приезжают синхронизацией (`branch-sync/records.js`), и запрет должен стоять на дверях, а не под ними.

**Состояние на старте:** ветка `rc/3.21.0` после U1 → U2 → U4 → U7 → U5 → U6 (U9 — седьмой); спецификация — с разделом К (5fa59531, касса «Платежи»: К1 — для U9, учтён в U9.5 и U9.10). Номера строк приблизительные; каждая правка привязана к тексту. Весь план проверен на копии 347bfd3d (вне репозитория): новые тесты зелёные (и красные до своей правки), полный прогон с прототипом дал 18 падений существующих тестов — все разобраны в задачах U9.4, U9.5 и U9.9 (см. «Существующие тесты»). U5/U6 меняют `visit-wizard.js`, `service-picker-modal.js`, `billing.js` (`issueVisitInvoice`, `create_invoice_for_visit`) — если точный текст «было» не находится, найти то же место по смыслу (ниже у каждой правки сказано, что это за место) и сохранить поведение обеих задач.

## Карта файлов

| Файл | Что |
|---|---|
| `public/js/shared/dup-order.js` | новый: правило «та же услуга», шаблоны отказа, ключ поля причины |
| `public/js/shared/dup-order.test.js` | новый |
| `public/js/admin/i18n-strings.js` | блок `// DUP_STOP_V1 … // /DUP_STOP_V1` (14 фраз) перед закрывающей `};` |
| `server/services/domain/dup-order.js` | новый: назначенное, совпадения, отказ, обход, журнал |
| `server/services/domain/dup-order.test.js` | новый |
| `server/services/crm/booked-twin.js` | `bookedTwinFor` (правило R7b без изменений базы); `retireBookedTwin` зовёт его |
| `server/services/crm/one-way.js` | `autoTwinFor` (правило «строка CRM уступает» без изменений базы) |
| `server/services/crm/twin-preview.test.js` | новый |
| `server/routes/db.js` | `takeRepeatReason`, `visitOrderCheck`, отказ 409 `duplicate_order`, журнал обхода после записи |
| `server/routes/dup-stop-db.test.js` | новый |
| `server/services/rpc/billing.js` | `cashier_line_add`, замена услуги (неоплаченный счёт), смена врача кассой, замена/возврат с новой в оплаченном, `rebill_refunded` |
| `server/services/rpc/patient-card.js` | `patient_card_set_doctor` |
| `server/services/rpc/dup-stop-rpc.test.js` | новый |
| `server/services/rpc/visits.js` | `dayVisitOf` (правило визита дня вынесено из `ensureVisit`) |
| `server/services/rpc/dup-order-check.js` | новый: RPC `visit_dup_check` |
| `server/services/rpc/index.js`, `server/services/control/gate.js` | регистрация RPC, «только чтение» |
| `public/js/admin/views/dup-order-check.js` | новый: помощник экранов |
| `public/js/admin/__tests__/dup-order-check.test.mjs` | новый |
| `public/js/admin/views/visit-wizard.js` | каталог гасит, смета не берёт, проверка до `ensure_visit`, причина в строки |
| `public/js/admin/__tests__/dup-stop-wizard.test.mjs` | новый |
| `public/js/admin/views/service-picker-modal.js` | калькулятор: проверка до `calendar_book`, причина в строки |
| `public/js/admin/views/service-workspace.js` | «Услуги приёма»: каталог гасит назначенное в визите |
| `public/js/admin/views/walk-in-booking.js` | быстрая регистрация: проверка до `ensure_visit`, причина в строки |
| `public/js/admin/__tests__/dup-stop-doors.test.mjs` | новый: калькулятор и кабинет (исходник) |
| `public/js/admin/views/cashier-line-fix.js` | `pickService({ visitId, exceptLineId })` гасит «уже назначено»; пять окон кассы передают визит (К1) |
| `public/js/admin/__tests__/dup-stop-cashier.test.mjs` | новый |
| `public/js/admin/__tests__/booked-rows-live.test.mjs` | + тест быстрой регистрации на настоящем сервере |
| `server/test-helpers/crm-link-all.js` | `addVisitLine({ repeatReason })`, `assertRepeatRefused` |
| существующие тесты (U9.4, U9.5, U9.9) | `crm-arrival-evidence`, `crm-link-all-twin`, `crm-one-way-r2-m2-twin`, `crm-one-way-r2-m2-r1`, `crm-unify-desk-money`, `package-stamp`, `refbill-review-http`, `billing.packages`, `billing`, `fast-registration`, `walk-in-booking` |

## Правила исполнения

- Все команды — из корня `C:\Users\user\Desktop\implementation workflow\easymed.api5`. Тесты — только названные файлы: `node --experimental-vm-modules --test <файлы>`.
- Правки — инструментами Edit/Write (не heredoc в Bash: он ест обратную косую черту). Концы строк LF.
- Сообщение коммита — инструментом Write в `.git/U9_MSG.txt`, затем `git commit -F .git/U9_MSG.txt`. Перед `git add` — `git diff --cached --name-only` пуст; добавлять только названные файлы.
- Маркер `DUP_STOP_V1` — в русском комментарии у каждой правки. Тексты интерфейса — ключи `i18n-strings.js` (ru/uz/en, в uz/en нет кириллицы). Значки — только `Icon()`.

---

### Task U9.1: правило «та же услуга» и слова отказа (общий модуль)

**Files:**
- Create: `public/js/shared/dup-order.js`
- Create: `public/js/shared/dup-order.test.js`
- Modify: `public/js/admin/i18n-strings.js` (блок перед закрывающей `};`)

- [ ] **Step 1: failing test** — создать `public/js/shared/dup-order.test.js`:

```js
// DUP_STOP_V1 (2026-11-02) — правило «та же услуга в визите»: ключ, повтор, причина.
// Одно на сервер (server/services/domain/dup-order.js) и экраны (views/dup-order-check.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderKey, repeatableLine, repeatReasonOk, REPEAT_REASON_KEY, REPEAT_ROLES,
  DUP_TEMPLATE_BILLED, DUP_TEMPLATE_UNBILLED, DUP_TEMPLATE_TWICE,
} from './dup-order.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('DUP_STOP_V1: ключ — услуга каталога без врача; консультация — вид (или услуга-консультация) и врач', () => {
  assert.equal(orderKey({ serviceId: 40, serviceType: 'lab', doctorId: 10 }), 's:40');
  assert.equal(orderKey({ serviceId: '40', serviceType: 'imaging' }), 's:40');
  assert.equal(orderKey({ serviceId: 30, serviceType: 'consultation', doctorId: 10 }), 's:30|d:10');
  assert.equal(orderKey({ serviceId: 30, serviceType: 'consultation' }), 's:30|d:');
  assert.equal(orderKey({ consultationTypeId: 5, doctorId: 11 }), 'c:5|d:11');
  assert.notEqual(orderKey({ consultationTypeId: 5, doctorId: 11 }), orderKey({ consultationTypeId: 5, doctorId: 12 }));
  assert.equal(orderKey({ serviceId: 'c|7|3' }), null, 'id выбора консультации каталога — не услуга');
  assert.equal(orderKey({}), null);
  assert.equal(orderKey({ serviceId: 40, consultationTypeId: 5, serviceType: 'lab' }), 's:40', 'услуга сильнее вида приёма');
});

test('DUP_STOP_V1: повтор разрешён товару и процедуре, остальным — нет', () => {
  assert.equal(repeatableLine({ clinicItemId: 3 }), true);
  assert.equal(repeatableLine({ serviceType: 'procedure' }), true);
  for (const t of ['lab', 'imaging', 'consultation', 'other', null]) assert.equal(repeatableLine({ serviceType: t }), false, String(t));
});

test('DUP_STOP_V1: причина обхода — не короче 3 знаков без пробелов по краям; поле и роли обхода', () => {
  assert.equal(repeatReasonOk('  ок '), false);
  assert.equal(repeatReasonOk('контроль'), true);
  assert.equal(repeatReasonOk(null), false);
  assert.equal(REPEAT_REASON_KEY, '__repeat_reason');
  assert.deepEqual([...REPEAT_ROLES], ['admin', 'head_doctor']);
});

test('DUP_STOP_V1: шаблоны отказа — в словаре на трёх языках, дырки сохранены, в uz/en нет кириллицы', () => {
  const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  for (const key of [DUP_TEMPLATE_BILLED, DUP_TEMPLATE_UNBILLED, DUP_TEMPLATE_TWICE]) {
    const e = STRINGS[key];
    assert.ok(e, 'нет в словаре: ' + key);
    for (const lang of ['uz', 'en']) {
      assert.ok(e[lang] && !/[Ѐ-ӿ]/.test(e[lang]), key + ' — ' + lang);
      assert.equal(holes(e[lang]), holes(key), key + ' — ' + lang + ': дырки');
    }
  }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/shared/dup-order.test.js`
  Expected: FAIL — `Cannot find module '…/public/js/shared/dup-order.js'`.

- [ ] **Step 3: implement** — создать `public/js/shared/dup-order.js`:

```js
// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — ОДНА УСЛУГА — ОДИН РАЗ В ВИЗИТЕ: ПРАВИЛО ДЛЯ СЕРВЕРА И ЭКРАНОВ
// ═══════════════════════════════════════════════════════════════════════════
//
// Решение владельца (3.21.0, п. 3): жёсткий запрет повторного направления — в пределах
// одного визита. На dev визит 411: врач направил на две услуги дважды с разницей в
// минуту, и все четыре строки ушли в счёт. Проверка жила только в браузере (мастер,
// SINGLE_PER_VISIT_V1) и только внутри одного сеанса.
//
// ПРАВИЛО «ТА ЖЕ УСЛУГА» (ключ orderKey):
//   • услуга каталога — та же услуга ('s:12');
//   • консультация — тот же вид И тот же врач: строка вида приёма ('c:5|d:10',
//     service_id пуст) или услуга типа «консультация» ('s:30|d:10'); консультация у
//     ДРУГОГО врача — другое назначение, её можно;
//   • повтор разрешён товару (clinic_item_id) и процедуре (services.type = 'procedure'):
//     у них количество, и капельница дважды за визит — обычное дело.
// Отменённая строка и строка, отпущенная со счёта с возвратом, — не назначение
// (это решает сервер, server/services/domain/dup-order.js).
//
// Чистый модуль, без DOM и базы: его берут и сервер, и экраны.

export const REPEAT_REASON_KEY = '__repeat_reason';   // DUP_STOP_V1 — снимается дверью до compile(), как __notes_base
export const REPEAT_REASON_MIN = 3;
export const REPEAT_REASON_MAX = 300;
export const REPEAT_ROLES = Object.freeze(['admin', 'head_doctor']);   // DUP_STOP_V1 — обход с причиной

// DUP_STOP_V1 — шаблоны отказа (ключи словаря public/js/admin/i18n-strings.js).
export const DUP_TEMPLATE_BILLED = 'Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёт № {invoice}.';
export const DUP_TEMPLATE_UNBILLED = 'Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёта ещё нет.';
export const DUP_TEMPLATE_TWICE = 'Услуга «{service}» выбрана дважды — в визит её назначают один раз.';

const pos = (v) => (v != null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** DUP_STOP_V1 — строке повтор разрешён: товар или процедура. */
export function repeatableLine({ clinicItemId = null, serviceType = null } = {}) {
  return pos(clinicItemId) != null || serviceType === 'procedure';
}

/**
 * DUP_STOP_V1 — ключ «та же услуга». null — сравнивать нечего (товар, пустая строка).
 * @param {{serviceId?:any, consultationTypeId?:any, doctorId?:any, serviceType?:string|null}} line
 */
export function orderKey({ serviceId = null, consultationTypeId = null, doctorId = null, serviceType = null } = {}) {
  const d = pos(doctorId);
  if (serviceId != null && serviceId !== '') {
    const s = pos(serviceId);
    if (s == null) return null;
    return serviceType === 'consultation' ? `s:${s}|d:${d ?? ''}` : `s:${s}`;
  }
  const c = pos(consultationTypeId);
  return c != null ? `c:${c}|d:${d ?? ''}` : null;
}

/** DUP_STOP_V1 — причина обхода годится: 3…300 знаков после обрезки пробелов. */
export function repeatReasonOk(reason) {
  return typeof reason === 'string' && reason.trim().length >= REPEAT_REASON_MIN;
}
```

Затем в `public/js/admin/i18n-strings.js` — вставить блок **непосредственно перед закрывающей строкой `};`** объекта `STRINGS` (последняя строка файла; блоки других задач выпуска не переставлять):

```js
  // DUP_STOP_V1 — повтор той же услуги в одном визите (shared/dup-order.js, views/dup-order-check.js, мастер, калькулятор, rpc/dup-order-check.js)
  "Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёт № {invoice}.": {"en":"This service is already ordered in this visit: “{service}” — {who}, {when}, invoice No. {invoice}.","ru":"Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёт № {invoice}.","uz":"Bu xizmat ushbu tashrifda allaqachon tayinlangan: «{service}» — {who}, {when}, hisob № {invoice}."},   // DUP_STOP_V1
  "Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёта ещё нет.": {"en":"This service is already ordered in this visit: “{service}” — {who}, {when}, not invoiced yet.","ru":"Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёта ещё нет.","uz":"Bu xizmat ushbu tashrifda allaqachon tayinlangan: «{service}» — {who}, {when}, hisob hali yo‘q."},   // DUP_STOP_V1
  "Услуга «{service}» выбрана дважды — в визит её назначают один раз.": {"en":"The service “{service}” is selected twice — it is ordered once per visit.","ru":"Услуга «{service}» выбрана дважды — в визит её назначают один раз.","uz":"«{service}» xizmati ikki marta tanlangan — tashrifga u bir marta tayinlanadi."},   // DUP_STOP_V1
  "Укажите визит или пациента и день.": {"en":"Specify the visit, or the patient and the day.","ru":"Укажите визит или пациента и день.","uz":"Tashrifni yoki bemor va kunni ko‘rsating."},   // DUP_STOP_V1
  "Слишком много услуг в одной проверке.": {"en":"Too many services in one check.","ru":"Слишком много услуг в одной проверке.","uz":"Bitta tekshiruvda xizmatlar juda ko‘p."},   // DUP_STOP_V1
  "уже назначено": {"en":"already ordered","ru":"уже назначено","uz":"allaqachon tayinlangan"},   // DUP_STOP_V1
  "уже назначено: {doctor}": {"en":"already ordered: {doctor}","ru":"уже назначено: {doctor}","uz":"allaqachon tayinlangan: {doctor}"},   // DUP_STOP_V1
  "«{name}» уже назначена в этом визите — повторно её не назначают.": {"en":"“{name}” is already ordered in this visit — it is not ordered again.","ru":"«{name}» уже назначена в этом визите — повторно её не назначают.","uz":"«{name}» ushbu tashrifda allaqachon tayinlangan — qayta tayinlanmaydi."},   // DUP_STOP_V1
  "Повторное назначение": {"en":"Repeat order","ru":"Повторное назначение","uz":"Qayta tayinlash"},   // DUP_STOP_V1
  "Повтор услуги в том же визите назначают только с причиной — она останется в журнале счёта.": {"en":"A service is repeated in the same visit only with a reason — it stays in the invoice log.","ru":"Повтор услуги в том же визите назначают только с причиной — она останется в журнале счёта.","uz":"Xizmat bir tashrifda faqat sabab bilan takrorlanadi — sabab hisob jurnalida qoladi."},   // DUP_STOP_V1
  "Например: контрольный анализ по просьбе врача": {"en":"For example: a control test at the doctor’s request","ru":"Например: контрольный анализ по просьбе врача","uz":"Masalan: shifokor iltimosiga ko‘ra nazorat tahlili"},   // DUP_STOP_V1
  "Укажите причину повторного назначения.": {"en":"Enter the reason for the repeat order.","ru":"Укажите причину повторного назначения.","uz":"Qayta tayinlash sababini kiriting."},   // DUP_STOP_V1
  "Назначить повторно": {"en":"Order again","ru":"Назначить повторно","uz":"Qayta tayinlang"},   // DUP_STOP_V1
  "Повторное назначение отменено — ничего не записано.": {"en":"The repeat order was cancelled — nothing was saved.","ru":"Повторное назначение отменено — ничего не записано.","uz":"Qayta tayinlash bekor qilindi — hech narsa saqlanmadi."},   // DUP_STOP_V1
  // /DUP_STOP_V1
```

(«Отмена» и «Вашей роли это действие недоступно.» в словаре уже есть — не дублировать.)

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/shared/dup-order.test.js public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`
  Expected: PASS (4 + оба стража словаря).

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: правило «та же услуга в визите» — один модуль для сервера и экранов

Ключ назначения: услуга каталога — сама услуга; консультация — вид и врач
(у другого врача — другое назначение). Повтор разрешён процедуре и товару.
Шаблоны отказа «уже назначена в этом визите: кем, когда, счёт №» и фразы
окна причины — в словаре на трёх языках.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/shared/dup-order.js public/js/shared/dup-order.test.js public/js/admin/i18n-strings.js
git commit -F .git/U9_MSG.txt
```

---

### Task U9.2: что уже назначено, отказ, обход с причиной и журнал (сервер)

**Files:**
- Create: `server/services/domain/dup-order.js`
- Create: `server/services/domain/dup-order.test.js`

- [ ] **Step 1: failing test** — создать `server/services/domain/dup-order.test.js`:

```js
// DUP_STOP_V1 (2026-11-02) — что считается уже назначенным в визите, слова отказа,
// обход с причиной и журнал. Правило ключа — public/js/shared/dup-order.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  liveOrders, duplicateHits, checkOrders, assertOrders, assertChangedOrder, logRepeatOrders,
  takeRepeatReason, repeatReasonArg, canRepeatOrder, DUP_CODE,
} from './dup-order.js';

const REG = { id: 2, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const CHIEF = { id: 12, role: 'doctor', extra_roles: ['head_doctor'] };
const DOC = { id: 10, role: 'doctor', extra_roles: [] };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin', 0, '[]');
  u.run(2, 'reg', 'x', 'Регистратура', 'registrar', 0, '[]');
  u.run(10, 'doc', 'x', 'Иванов', 'doctor', 1, '[]');
  u.run(11, 'doc2', 'x', 'Петров', 'doctor', 1, '[]');
  u.run(12, 'chief', 'x', 'Главный', 'doctor', 1, '["head_doctor"]');
  const s = db.prepare('INSERT INTO services (id, name, price, type) VALUES (?,?,?,?)');
  s.run(30, 'Консультация терапевта', 100000, 'consultation');
  s.run(40, 'Анализ крови', 40000, 'lab');
  s.run(50, 'УЗИ брюшной полости', 80000, 'imaging');
  s.run(60, 'Капельница', 30000, 'procedure');
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  const v1 = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, '2026-11-02T05:00:00Z', 'arrived')").run().lastInsertRowid);
  const v2 = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, '2026-11-03T05:00:00Z', 'scheduled')").run().lastInsertRowid);
  return { db, v1, v2 };
}
function line(db, r) {
  const row = { quantity: 1, unit_price: 0, total: 0, status: 'added', created_by: 10, ...r };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
}
/** Строку — в счёт № A-000001 (без оплаты). */
function bill(db, vid, vsId) {
  const inv = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount, status) VALUES ('A-000001', ?, 77, 40000, 40000, 'unpaid')").run(vid).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 40, 'Анализ крови', 1, 40000, 40000)").run(inv).lastInsertRowid);
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, vsId);
  return inv;
}

test('DUP_STOP_V1: та же услуга в том же визите — повтор; в другом визите — нет', () => {
  const { db, v1, v2 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40 });
  const hits = duplicateHits(db, [{ visit_id: v1, service_id: 40 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].existing.id, x);
  assert.equal(duplicateHits(db, [{ visit_id: v2, service_id: 40 }]).length, 0, 'другой визит того же пациента');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 50 }]).length, 0, 'другая услуга');
});

test('DUP_STOP_V1: отменённая и отпущенная с возвратом строка — не назначение; выставленная заново — снова назначение', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: 40, status: 'cancelled' });
  const back = line(db, { visit_id: v1, service_id: 50, status: 'collected' });
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 999)").run(back);
  assert.deepEqual(liveOrders(db, v1).map((r) => r.id), []);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 40 }, { visit_id: v1, service_id: 50 }]).length, 0);
  // Выставили заново (ссылка на счёт есть) — снова живая строка.
  const inv = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, status) VALUES ('A-000009', ?, 77, 'unpaid')").run(v1).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 50, 'УЗИ', 1, 0, 0)").run(inv).lastInsertRowid);
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, back);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 50 }]).length, 1);
});

test('DUP_STOP_V1: процедура и товар не запрещаются', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: 60 });
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 60 }]).length, 0, 'процедура');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 60 }, { visit_id: v1, service_id: 60 }]).length, 0, 'процедура дважды в запросе');
  assert.equal(duplicateHits(db, [{ visit_id: v1, clinic_item_id: 3 }, { visit_id: v1, clinic_item_id: 3 }]).length, 0, 'товар');
});

test('DUP_STOP_V1: консультация — тот же вид и тот же врач — повтор; у другого врача — можно', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: null, consultation_type_id: 5, doctor_id: 10 });
  line(db, { visit_id: v1, service_id: 30, doctor_id: 10 });
  assert.equal(duplicateHits(db, [{ visit_id: v1, consultation_type_id: 5, doctor_id: 10 }]).length, 1, 'вид приёма у того же врача');
  assert.equal(duplicateHits(db, [{ visit_id: v1, consultation_type_id: 5, doctor_id: 11 }]).length, 0, 'вид приёма у другого врача');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 30, doctor_id: 10 }]).length, 1, 'услуга-консультация у того же врача');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 30, doctor_id: 11 }]).length, 0, 'услуга-консультация у другого врача');
});

test('DUP_STOP_V1: внутри одного запроса одна услуга дважды — повтор; разные визиты — нет', () => {
  const { db, v1, v2 } = clinic();
  const hits = duplicateHits(db, [{ visit_id: v1, service_id: 50 }, { visit_id: v1, service_id: 50 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].twice, true);
  assert.equal(hits[0].index, 1);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 50 }, { visit_id: v2, service_id: 50 }]).length, 0);
});

test('DUP_STOP_V1: отказ 409 duplicate_order называет услугу, кем, когда и счёт; без счёта — «счёта ещё нет»', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40, created_by: 10 });
  let out = checkOrders(db, [{ visit_id: v1, service_id: 40 }], { user: REG });
  assert.equal(out.error.status, 409);
  assert.equal(out.error.code, DUP_CODE);
  assert.match(out.error.message, /^Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, \d\d\.\d\d\.\d{4} \d\d:\d\d, счёта ещё нет\.$/);
  assert.equal(out.error.params.service, 'Анализ крови');
  bill(db, v1, x);
  out = checkOrders(db, [{ visit_id: v1, service_id: 40 }], { user: REG });
  assert.match(out.error.message, /, счёт № A-000001\.$/);
  assert.equal(out.error.params.invoice, 'A-000001');
  assert.ok(out.error.template.includes('{invoice}'));
  const twice = checkOrders(db, [{ visit_id: v1, service_id: 50 }, { visit_id: v1, service_id: 50 }], { user: REG });
  assert.equal(twice.error.message, 'Услуга «УЗИ брюшной полости» выбрана дважды — в визит её назначают один раз.');
  assert.throws(() => assertOrders(db, [{ visit_id: v1, service_id: 40 }], { user: DOC }), (e) => e.status === 409 && e.code === DUP_CODE);
});

test('DUP_STOP_V1: обход — администратор и главный врач с причиной; регистратор и врач — нет; без причины — нет', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: 40 });
  const ln = [{ visit_id: v1, service_id: 40 }];
  assert.equal(canRepeatOrder(ADMIN), true);
  assert.equal(canRepeatOrder(CHIEF), true);
  assert.equal(canRepeatOrder(REG), false);
  assert.equal(canRepeatOrder(DOC), false);
  assert.ok(checkOrders(db, ln, { user: ADMIN, reason: 'контрольный анализ' }).repeats);
  assert.ok(checkOrders(db, ln, { user: CHIEF, reason: 'повтор по показаниям' }).repeats);
  assert.ok(checkOrders(db, ln, { user: REG, reason: 'контрольный анализ' }).error, 'регистратор');
  assert.ok(checkOrders(db, ln, { user: ADMIN, reason: '  ок ' }).error, 'причина короче трёх знаков');
  assert.ok(checkOrders(db, ln, { user: ADMIN }).error, 'без причины');
});

test('DUP_STOP_V1: обход пишется в журнал счёта (line_repeat_order) с причиной, визитом и прежней строкой', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40, created_by: 10 });
  const inv = bill(db, v1, x);
  const out = checkOrders(db, [{ visit_id: v1, service_id: 40 }], { user: ADMIN, reason: '  контрольный анализ  ' });
  assert.equal(logRepeatOrders(db, out, ADMIN), 1);
  const rows = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visit_id, v1);
  assert.equal(rows[0].invoice_id, inv);
  assert.equal(rows[0].invoice_number, 'A-000001');
  assert.equal(rows[0].reason, 'контрольный анализ');
  assert.equal(rows[0].actor_user_id, 1);
  assert.match(rows[0].notes, /Повторное назначение «Анализ крови» \(уже было: Иванов, .+, счёт № A-000001\)/);
  assert.equal(logRepeatOrders(db, {}, ADMIN), 0, 'нет обхода — нет строки журнала');
});

test('DUP_STOP_V1: spare и excludeIds — строка, которую дверь уберёт, или сама изменяемая строка не мешают', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40 });
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 40 }], { spare: () => [x] }).length, 0);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 40 }], { excludeIds: [x] }).length, 0);
});

test('DUP_STOP_V1: замена — проверка только если ключ меняется; задвоенные до 3.21.0 строки правке врача не мешают', () => {
  const { db, v1 } = clinic();
  const a = line(db, { visit_id: v1, service_id: 40 });
  line(db, { visit_id: v1, service_id: 40 });   // задвоено до 3.21.0
  const u = line(db, { visit_id: v1, service_id: 50 });
  const rowOf = (id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
  assert.deepEqual(assertChangedOrder(db, rowOf(a), { ...rowOf(a), doctor_id: 11 }, { user: REG }), {}, 'анализ: другой исполнитель — тот же ключ');
  assert.throws(() => assertChangedOrder(db, rowOf(u), { ...rowOf(u), service_id: 40 }, { user: REG }), (e) => e.code === DUP_CODE, 'УЗИ → анализ, который уже есть');
  const c = line(db, { visit_id: v1, service_id: null, consultation_type_id: 5, doctor_id: 10 });
  const c2 = line(db, { visit_id: v1, service_id: null, consultation_type_id: 5, doctor_id: 11 });
  assert.throws(() => assertChangedOrder(db, rowOf(c2), { ...rowOf(c2), doctor_id: 10 }, { user: REG }), (e) => e.code === DUP_CODE, 'консультация к врачу, у которого этот вид уже есть');
  assert.deepEqual(assertChangedOrder(db, rowOf(c), { ...rowOf(c), doctor_id: 12 }, { user: REG }), {});
});

test('DUP_STOP_V1: __repeat_reason снимается со строк visit_services до compile(); у других таблиц не трогается', () => {
  const one = { table: 'visit_services', op: 'insert', values: { visit_id: 1, service_id: 40, __repeat_reason: 'контроль' } };
  assert.equal(takeRepeatReason(one), 'контроль');
  assert.equal('__repeat_reason' in one.values, false);
  const many = { table: 'visit_services', op: 'insert', values: [{ visit_id: 1, __repeat_reason: '' }, { visit_id: 1, __repeat_reason: 'повтор' }] };
  assert.equal(takeRepeatReason(many), 'повтор');
  assert.ok(many.values.every((r) => !('__repeat_reason' in r)));
  const other = { table: 'patients', op: 'insert', values: { full_name: 'X', __repeat_reason: 'x' } };
  assert.equal(takeRepeatReason(other), null);
  assert.equal(other.values.__repeat_reason, 'x', 'чужая таблица: поле остаётся, compile() откажет ему как неизвестной колонке');
  assert.equal(repeatReasonArg({ __repeat_reason: '  контроль ' }), '  контроль ');
  assert.equal(repeatReasonArg({ __repeat_reason: '   ' }), null);
  assert.equal(repeatReasonArg(null), null);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/domain/dup-order.test.js`
  Expected: FAIL — `Cannot find module '…/server/services/domain/dup-order.js'`.

- [ ] **Step 3: implement** — создать `server/services/domain/dup-order.js`:

```js
// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — ЖЁСТКИЙ ЗАПРЕТ ПОВТОРНОГО НАЗНАЧЕНИЯ В ОДНОМ ВИЗИТЕ
// ═══════════════════════════════════════════════════════════════════════════
//
// Правило «та же услуга» — public/js/shared/dup-order.js (orderKey). Здесь — что
// считается уже назначенным, слова отказа, обход с причиной и журнал.
//
// УЖЕ НАЗНАЧЕНО — строка того же визита, которая:
//   • не отменена (status <> 'cancelled');
//   • не товар (clinic_item_id пуст) и не процедура (services.type = 'procedure');
//   • не отпущена со счёта с возвратом (отметка 'out' в pay_refund_releases при
//     пустой ссылке на счёт — то же условие, что refundedOpenLineIds, REFUND_ANY_V1).
// Строки, которые дверь сама уберёт под новой (замена записи колл-центра — R7b,
// crm/booked-twin.js; строка CRM уступает строке человека — crm/one-way.js),
// вызывающий передаёт в spare: они не мешают.
//
// ОБХОД. Администратор и главный врач назначают повтор с причиной (≥ 3 знаков):
// /api/db — полем __repeat_reason строки (снимается до compile(), как __notes_base),
// RPC — аргументом __repeat_reason. Каждый обход — строка invoice_audit_log
// (action 'line_repeat_order': журнал правок строк, его не считают «работой визита»
// — discard_empty_visit пропускает line_*). Не бросает ничего, кроме отказа.
import { hasAnyRole } from '../roles.js';
import { actingActorName } from '../../../public/js/shared/act-as.js';
import { fillTemplate } from '../server-message.js';
import {
  orderKey, repeatableLine, repeatReasonOk, REPEAT_REASON_KEY, REPEAT_REASON_MAX, REPEAT_ROLES,
  DUP_TEMPLATE_BILLED, DUP_TEMPLATE_UNBILLED, DUP_TEMPLATE_TWICE,
} from '../../../public/js/shared/dup-order.js';

export const DUP_CODE = 'duplicate_order';

export class DuplicateOrderError extends Error {
  constructor({ template, params, existing = null, index = 0 }) {
    super(fillTemplate(template, params));
    this.status = 409;
    this.code = DUP_CODE;
    this.template = template;
    this.params = params;
    this.existing = existing;
    this.index = index;
  }
}

const pos = (v) => (v != null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Живые назначения визита (см. шапку) с тем, что нужно словам отказа. */
export function liveOrders(db, visitId) {
  const id = pos(visitId);
  if (id == null) return [];
  return db.prepare(`
    SELECT vs.id, vs.visit_id, vs.service_id, vs.consultation_type_id, vs.doctor_id, vs.status,
           vs.invoice_item_id, vs.created_by, vs.created_at,
           s.type AS service_type, s.name AS service_name,
           COALESCE(ct.name_ru, ct.name) AS consultation_name,
           u.full_name AS creator_name, d.full_name AS doctor_name,
           strftime('%d.%m.%Y %H:%M', vs.created_at, 'localtime') AS created_local,
           i.id AS invoice_id, i.invoice_number
      FROM visit_services vs
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
      LEFT JOIN users u ON u.id = vs.created_by
      LEFT JOIN users d ON d.id = vs.doctor_id
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i ON i.id = ii.invoice_id
     WHERE vs.visit_id = ? AND vs.status <> 'cancelled' AND vs.clinic_item_id IS NULL
       AND COALESCE(s.type, '') <> 'procedure'
       AND NOT (vs.invoice_item_id IS NULL
                AND EXISTS (SELECT 1 FROM pay_refund_releases prr WHERE prr.kind = 'out' AND prr.line_id = vs.id))
     ORDER BY vs.id`).all(id);
}

const serviceTypeStmt = (db) => db.prepare('SELECT type, name FROM services WHERE id = ?');

/** Ключ строки базы (или строки запроса в форме базы). */
export function keyOfRow(row, serviceType = row && row.service_type) {
  if (!row) return null;
  return orderKey({
    serviceId: row.service_id ?? null,
    consultationTypeId: row.service_id == null ? (row.consultation_type_id ?? null) : null,
    doctorId: row.doctor_id ?? null,
    serviceType: serviceType ?? null,
  });
}

/** Название назначения для отказа и журнала. */
function nameOf(db, row) {
  if (row.service_name) return row.service_name;
  if (row.consultation_name) return row.consultation_name;
  if (row.service_id != null) { const s = serviceTypeStmt(db).get(row.service_id); if (s) return s.name; }
  if (row.consultation_type_id != null) {
    const c = db.prepare('SELECT COALESCE(name_ru, name) AS n FROM consultation_types WHERE id = ?').get(row.consultation_type_id);
    if (c) return c.n;
  }
  return '—';
}

/** Отказ по совпадению (для двери и для visit_dup_check). */
export function refusalOf(db, hit) {
  if (hit.twice) {
    return new DuplicateOrderError({ template: DUP_TEMPLATE_TWICE, params: { service: nameOf(db, hit.line) }, index: hit.index });
  }
  const x = hit.existing;
  const params = {
    service: nameOf(db, x),
    who: x.creator_name || '—',
    when: x.created_local || '—',
  };
  if (x.invoice_number) params.invoice = x.invoice_number;
  return new DuplicateOrderError({
    template: x.invoice_number ? DUP_TEMPLATE_BILLED : DUP_TEMPLATE_UNBILLED,
    params, existing: { id: x.id, invoice_number: x.invoice_number || null }, index: hit.index,
  });
}

/**
 * Совпадения строк запроса с уже назначенным и между собой.
 * @param {object} db
 * @param {Array<{visit_id:any, service_id?:any, consultation_type_id?:any, doctor_id?:any, clinic_item_id?:any}>} lines
 * @param {{excludeIds?:number[], spare?:(line:object)=>number[]}} [opts]
 *   excludeIds — строки, которые эта операция сама меняет (замена услуги: сама строка);
 *   spare — строки, которые дверь уберёт под этой строкой (R7b, строка CRM).
 * @returns {Array<{index:number, line:object, existing?:object, twice?:boolean}>}
 */
export function duplicateHits(db, lines, { excludeIds = [], spare = null } = {}) {
  const typeOf = serviceTypeStmt(db);
  const skip = new Set((excludeIds || []).map(Number));
  const seen = new Set();
  const live = new Map();
  const hits = [];
  (lines || []).forEach((line, index) => {
    if (!line) return;
    const visitId = pos(line.visit_id);
    if (visitId == null) return;
    const svc = line.service_id != null && line.service_id !== '' ? typeOf.get(line.service_id) : null;
    const serviceType = svc ? svc.type : null;
    if (repeatableLine({ clinicItemId: line.clinic_item_id ?? null, serviceType })) return;
    const key = keyOfRow(line, serviceType);
    if (!key) return;
    const own = visitId + '#' + key;
    if (seen.has(own)) { hits.push({ index, line, twice: true }); return; }
    seen.add(own);
    if (!live.has(visitId)) live.set(visitId, liveOrders(db, visitId));
    const spared = new Set((spare ? spare(line) || [] : []).map(Number));
    const existing = live.get(visitId).find((r) => !skip.has(Number(r.id)) && !spared.has(Number(r.id)) && keyOfRow(r) === key);
    if (existing) hits.push({ index, line, existing });
  });
  return hits;
}

/** Обходить запрет может администратор и главный врач. */
export function canRepeatOrder(user) {
  return hasAnyRole(user, REPEAT_ROLES);
}

/**
 * Решение двери: { error } — отказ (DuplicateOrderError), { repeats } — обход с
 * причиной (журнал пишет logRepeatOrders ПОСЛЕ записи), {} — повторов нет.
 */
export function checkOrders(db, lines, { user = null, reason = null, excludeIds = [], spare = null } = {}) {
  const hits = duplicateHits(db, lines, { excludeIds, spare });
  if (!hits.length) return {};
  if (canRepeatOrder(user) && repeatReasonOk(reason)) return { repeats: hits, reason: String(reason).trim().slice(0, REPEAT_REASON_MAX) };
  return { error: refusalOf(db, hits[0]), hits };
}

/** RPC: бросить отказ или вернуть обходы для журнала. */
export function assertOrders(db, lines, opts = {}) {
  const out = checkOrders(db, lines, opts);
  if (out.error) throw out.error;
  return out;
}

/** Журнал обхода: строка invoice_audit_log на каждое повторное назначение. */
export function logRepeatOrders(db, out, user) {
  if (!out || !out.repeats || !out.repeats.length) return 0;
  const actor = user && user.id != null ? db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(user.id) : null;
  const ins = db.prepare(`INSERT INTO invoice_audit_log (invoice_id, invoice_number, visit_id, action, actor_user_id, actor_name, actor_role, reason, notes)
                          VALUES (?, ?, ?, 'line_repeat_order', ?, ?, ?, ?, ?)`);
  for (const h of out.repeats) {
    const x = h.existing || null;
    const name = nameOf(db, x || h.line);
    const before = x ? `${x.creator_name || '—'}, ${x.created_local || '—'}${x.invoice_number ? ', счёт № ' + x.invoice_number : ''}` : 'выбрана дважды в одном запросе';
    ins.run(x && x.invoice_id ? x.invoice_id : null, x && x.invoice_number ? x.invoice_number : null, Number(h.line.visit_id),
      actor ? actor.id : null, actor ? actingActorName(user, actor.full_name || null) : null, actor ? actor.role || null : null,
      out.reason, `Повторное назначение «${name}» (уже было: ${before})`);
  }
  return out.repeats.length;
}

/** /api/db: снять __repeat_reason со строк visit_services до compile(). */
export function takeRepeatReason(body) {
  if (!body || body.table !== 'visit_services') return null;
  const v = body.values;
  const rows = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
  let reason = null;
  for (const r of rows) {
    if (r && Object.prototype.hasOwnProperty.call(r, REPEAT_REASON_KEY)) {
      if (typeof r[REPEAT_REASON_KEY] === 'string' && r[REPEAT_REASON_KEY].trim()) reason = r[REPEAT_REASON_KEY];
      delete r[REPEAT_REASON_KEY];
    }
  }
  return reason;
}

/** RPC: причина обхода из аргументов. */
export function repeatReasonArg(args) {
  const r = args && args[REPEAT_REASON_KEY];
  return typeof r === 'string' && r.trim() ? r : null;
}

/**
 * Замена услуги или врача строки `before` на `after`: проверка — только если ключ
 * «та же услуга» меняется (новая услуга; у консультации — и новый врач). Сама строка
 * не мешает (excludeIds). Строки, задвоенные до 3.21.0, правке без смены ключа не мешают.
 */
export function assertChangedOrder(db, before, after, { user = null, reason = null, excludeIds = [] } = {}) {
  const typeOf = serviceTypeStmt(db);
  const t = (row) => (row && row.service_id != null ? (typeOf.get(row.service_id) || {}).type || null : null);
  const was = keyOfRow(before, t(before));
  const now = keyOfRow(after, t(after));
  if (!now || now === was) return {};
  return assertOrders(db, [after], { user, reason, excludeIds: [before.id, ...excludeIds].filter((x) => x != null) });
}
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/domain/dup-order.test.js server/i18n-server-messages.test.js`
  Expected: PASS (11 + страж сообщений сервера).

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: что уже назначено в визите, отказ 409 и обход с причиной (сервер)

Назначение — строка визита не отменённая, не товар, не процедура и не
отпущенная со счёта с возвратом. Совпадение с базой и внутри одного запроса;
отказ называет услугу, кто и когда её назначил и счёт. Администратор и
главный врач назначают повтор с причиной — она в журнале счёта
(line_repeat_order). Замена проверяется, только если меняется ключ услуги.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/domain/dup-order.js server/services/domain/dup-order.test.js
git commit -F .git/U9_MSG.txt
```

---

### Task U9.3: «какую строку дверь уберёт» — без изменений в базе (R7b и строка CRM)

Запрет не должен отказывать строке регистратуры, которая займёт место строки записи колл-центра (`retireBookedTwin`, R7b) или под которой уступит строка CRM (`wishYields`). Правила выносятся в функции без побочных эффектов; сами сети не меняются.

**Files:**
- Modify: `server/services/crm/booked-twin.js`
- Modify: `server/services/crm/one-way.js`
- Create: `server/services/crm/twin-preview.test.js`

- [ ] **Step 1: failing test** — создать `server/services/crm/twin-preview.test.js`:

```js
// DUP_STOP_V1 (2026-11-02) — «какую строку дверь уберёт под новой» БЕЗ изменений в базе:
// bookedTwinFor (сеть R7b, crm/booked-twin.js) и autoTwinFor (строка CRM уступает строке
// человека, crm/one-way.js). Запрет повтора (domain/dup-order.js) спрашивает их, чтобы не
// отказать строке, которая займёт место строки записи. Сама сеть R7b не изменилась —
// server/routes/crm-link-all-twin.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../../test-helpers/crm-unify-app.js';
import { callcenterBook, vsOf } from '../../test-helpers/crm-link-all.js';
import { bookedTwinFor } from './booked-twin.js';
import { autoTwinFor } from './one-way.js';

const TODAY = localDay(0);

test('DUP_STOP_V1: bookedTwinFor — строка записи колл-центра для ещё не вставленной строки той же услуги; база не меняется', async () => {
  const t = await startCrmApp();
  try {
    const vid = await callcenterBook(t, TODAY, { hour: 23 });
    const x = vsOf(t, vid)[0];
    const snap = JSON.stringify(vsOf(t, vid));
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10 }).id, x.id);
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 11 }), null, 'консультация другого врача');
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10, quantity: 2 }), null, 'количество 2');
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10, status: 'in_progress' }), null, 'сразу в работе');
    assert.equal(bookedTwinFor(t.db, null), null);
    assert.equal(JSON.stringify(vsOf(t, vid)), snap, 'база изменилась');
  } finally { t.close(); }
});

test('DUP_STOP_V1: autoTwinFor — строка, которую CRM завела под желание, уступит строке той же услуги; база не меняется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const ev = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(TODAY, 23) });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    const auto = vsOf(t, vid).find((r) => r.service_id === 40);
    assert.ok(auto, 'желание карточки не село в визит');
    const snap = JSON.stringify(vsOf(t, vid));
    assert.equal(autoTwinFor(t.db, { visit_id: vid, service_id: 40 }).id, auto.id);
    assert.equal(autoTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10 }), null, 'другая услуга');
    assert.equal(autoTwinFor(t.db, { visit_id: vid, service_id: 40, clinic_item_id: 5 }), null, 'товар');
    assert.equal(JSON.stringify(vsOf(t, vid)), snap, 'база изменилась');
  } finally { t.close(); }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/crm/twin-preview.test.js`
  Expected: FAIL — `SyntaxError: The requested module './booked-twin.js' does not provide an export named 'bookedTwinFor'`.

- [ ] **Step 3: implement.**

`server/services/crm/booked-twin.js` — заменить блок от строки `/**\n * @param {object} db\n * @param {number} vsId — только что вставленная строка visit_services (Y)` до конца файла (функция `retireBookedTwin` целиком) на:

```js
/**
 * DUP_STOP_V1 — строка записи X, которую сеть R7b уберёт под строкой Y (правило — шапка).
 * Y — строка базы ИЛИ строка запроса (ещё не вставленная: id нет, статус по умолчанию 'added').
 * Ничего не меняет; её же зовёт запрет повтора (domain/dup-order.js), чтобы не отказать
 * строке, которая займёт место строки записи.
 * @returns {object|null} строка X
 */
export function bookedTwinFor(db, y) {
  if (!y || !lineKey(y) || (y.status ?? 'added') !== 'added' || y.invoice_item_id != null) return null;
  if (y.clinic_item_id != null || y.sync_origin != null || Number(y.quantity || 1) !== 1) return null;
  const v = visitRow(db, y.visit_id);
  if (!v || v.sync_origin != null) return null;
  const pre = PRE_ARRIVAL.includes(v.status);
  if (!pre && !(v.status === 'arrived' && v.day === today(db))) return null;
  const svc = y.service_id != null ? db.prepare('SELECT requires_doctor FROM services WHERE id = ?').get(y.service_id) : null;
  const needsDoctor = !!(svc && Number(svc.requires_doctor));
  const autoHeld = db.prepare(`SELECT 1 FROM crm_request_services
                                WHERE visit_service_id = ? AND visit_service_auto = 1 AND status <> 'cancelled' LIMIT 1`);
  const before = y.id != null ? Number(y.id) : Number.MAX_SAFE_INTEGER;
  return db.prepare(`SELECT * FROM visit_services
                         WHERE visit_id = ? AND id < ? AND status = 'added' AND invoice_item_id IS NULL
                           AND clinic_item_id IS NULL AND sync_origin IS NULL AND COALESCE(quantity, 1) = 1
                         ORDER BY id`).all(v.id, before)
    .find((c) => sameBookedService(lineOf(c), lineOf(y), { needsDoctor }) && vsFree(db, c) && (creatorIsCallcenter(db, c.created_by) || !!autoHeld.get(c.id))) || null;
}

/**
 * @param {object} db
 * @param {number} vsId — только что вставленная строка visit_services (Y)
 * @returns {number|null} id ушедшей строки записи (X) или null
 */
export function retireBookedTwin(db, vsId) {
  try {
    const y = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(Number(vsId));
    const x = bookedTwinFor(db, y);   // DUP_STOP_V1 — правило вынесено без изменений
    if (!x) return null;
    db.transaction(() => {
      relinkHeld(db, x.id, y.id);
      deleteVs(db, x.id);
    })();
    return Number(x.id);
  } catch (e) {
    console.error('[crm-twin] строка записи для', vsId, 'не разобрана:', e && e.message);   // CRM_LINK_ALL_V1
    return null;
  }
}
```

(Условия те же, что были в `retireBookedTwin`: Y `added`, без счёта и товара, своё здание, количество 1; визит до прихода или «Пришёл» сегодня; X раньше Y, `added`, свободна, количество 1, та же услуга, завёл колл-центр или её держит строка заявки `auto = 1`.)

`server/services/crm/one-way.js` — вставить перед комментарием, который начинается строкой `/**\n * CRM_UNIFY_V1 (финальное ревью, A-C2) · CRM_ONE_WAY_V1 — ЖЕЛАНИЕ СБЫЛОСЬ.` (это док-комментарий `adoptOne`, сразу после `wishYields`):

```js
/**
 * DUP_STOP_V1 — строка CRM, которая УСТУПИТ строке человека `y` (правило wishYields /
 * yieldAutoLine выше), без изменений в базе. `y` — строка запроса (id ещё нет) или базы.
 * Её зовёт запрет повтора (domain/dup-order.js): строка, под которой строка CRM уйдёт, —
 * не повтор.
 * @returns {object|null} строка visit_services, которая уйдёт
 */
export function autoTwinFor(db, y) {
  const v = y ? visitRow(db, y.visit_id) : null;
  if (!v || v.sync_origin != null || (!PRE_ARRIVAL.includes(v.status) && v.status !== 'arrived')) return null;
  if (!lineKey(y) || y.clinic_item_id != null || y.sync_origin != null || y.status === 'cancelled') return null;
  const x = { ...y, id: y.id != null ? Number(y.id) : 0 };
  const auto = autoLineFor(db, v.id, x);
  if (!auto) return null;
  const old = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(auto.visit_service_id);
  if (!old || old.visit_id !== v.id || !vsFree(db, old)) return null;
  if (!sameBookedService(lineOf(old), lineOf(x), { needsDoctor: needsDoctorOf(db, old) })) return null;
  return old;
}

```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/crm/twin-preview.test.js server/routes/crm-link-all-twin.test.js server/routes/crm-one-way-r2-m2-twin.test.js server/routes/crm-one-way-r3-same.test.js`
  Expected: PASS — новые 2; R7b-тесты не изменились и зелёные (правило вынесено без изменений).

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: правила R7b и «строка CRM уступает» — без изменений в базе

bookedTwinFor и autoTwinFor отвечают, какую строку записи дверь уберёт
под новой строкой той же услуги, ничего не меняя. retireBookedTwin зовёт
bookedTwinFor — правило прежнее. Их спросит запрет повтора, чтобы не
отказать строке регистратуры, занимающей место строки колл-центра.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/crm/booked-twin.js server/services/crm/one-way.js server/services/crm/twin-preview.test.js
git commit -F .git/U9_MSG.txt
```

---

### Task U9.4: дверь `/api/db` — вставка, пачка и upsert строки визита (+ существующие тесты)

**Files:**
- Modify: `server/routes/db.js`
- Create: `server/routes/dup-stop-db.test.js`
- Modify (тесты, ожидания которых меняются — см. Step 5): `server/test-helpers/crm-link-all.js`, `server/routes/crm-arrival-evidence.test.js`, `server/routes/crm-link-all-twin.test.js`, `server/routes/crm-one-way-r2-m2-twin.test.js`, `server/routes/crm-one-way-r2-m2-r1.test.js`, `server/routes/crm-unify-desk-money.test.js`, `server/routes/package-stamp.test.js`, `server/routes/refbill-review-http.test.js`

- [ ] **Step 1: failing test** — создать `server/routes/dup-stop-db.test.js`:

```js
// DUP_STOP_V1 (2026-11-02) — дверь /api/db: та же услуга второй раз в том же визите —
// 409 duplicate_order (вставка, пачка, upsert). Решение владельца (3.21.0, п. 3): запрет —
// в пределах одного визита. Случай с dev: визит 411, врач направил на две услуги дважды с
// разницей в минуту — все четыре строки ушли в счёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const pad = (n) => String(n).padStart(2, '0');
function localDay(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function at(dayIso, hh, mm = 0) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
const D = localDay(3);

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin', 0);
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar', 0);
  user.run(3, 'cc', hashPassword('password1'), 'Оператор', 'callcenter', 0);
  user.run(10, 'doc', hashPassword('password1'), 'Иванов', 'doctor', 1);
  user.run(11, 'doc2', hashPassword('password1'), 'Петров', 'doctor', 1);
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ брюшной полости',80000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (60,'Капельница',30000,'procedure')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент Тест','+998900000077')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'cc', 'doc']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + who);
    cookies[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const rpc = (name, who, args) => call('/api/rpc/' + name, who, args);
  const dbq = (who, desc) => call('/api/db', who, desc);
  return { db, server, rpc, dbq, close: () => { server.close(); db.close(); } };
}

function arrivedVisit(t, day = localDay(0)) {
  return Number(t.db.prepare("INSERT INTO visits (patient_id, visit_date, status, doctor_id) VALUES (77, ?, 'arrived', 10)").run(at(day, 9)).lastInsertRowid);
}
const ins = (t, who, values, extra = {}) => t.dbq(who, { table: 'visit_services', op: 'insert', values, ...extra });
const row = (vid, svc, more = {}) => ({ visit_id: vid, service_id: svc, quantity: 1, unit_price: 40000, total: 40000, status: 'added', ...more });
const live = (t, vid, svc) => t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND service_id IS ? AND status <> 'cancelled'").all(vid, svc).length;

test('DUP_STOP_V1: врач направил на ту же услугу второй раз в том же визите — 409 duplicate_order, строка одна', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const first = await ins(t, 'doc', row(v, 40));
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const again = await ins(t, 'doc', row(v, 40));
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.equal(again.json.error.code, 'duplicate_order');
    assert.match(again.json.error.message, /^Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, .+, счёта ещё нет\.$/);
    assert.ok(again.json.error.template && again.json.error.params, 'шаблон и значения — экран переведёт фразу');
    assert.equal(live(t, v, 40), 1);
  } finally { t.close(); }
});

test('DUP_STOP_V1: та же услуга в ДРУГОМ визите — можно; отменённая строка не мешает; процедура повторяется', async () => {
  const t = await start();
  try {
    const v1 = arrivedVisit(t);
    const v2 = arrivedVisit(t, localDay(-1));
    assert.equal((await ins(t, 'reg', row(v1, 40))).status, 200);
    assert.equal((await ins(t, 'reg', row(v2, 40))).status, 200, 'другой визит');
    const id = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 40').get(v1).id;
    const cancel = await t.dbq('reg', { table: 'visit_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: id }] });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
    assert.equal((await ins(t, 'reg', row(v1, 40))).status, 200, 'после отмены');
    assert.equal((await ins(t, 'reg', row(v1, 60))).status, 200);
    assert.equal((await ins(t, 'reg', row(v1, 60))).status, 200, 'процедура второй раз');
  } finally { t.close(); }
});

test('DUP_STOP_V1: консультация — у того же врача второй раз нельзя, у другого врача можно', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const ct = (doctor) => row(v, null, { service_id: null, consultation_type_id: 5, doctor_id: doctor });
    assert.equal((await ins(t, 'reg', ct(10))).status, 200);
    const same = await ins(t, 'reg', ct(10));
    assert.equal(same.status, 409, JSON.stringify(same.json));
    assert.equal(same.json.error.code, 'duplicate_order');
    assert.equal((await ins(t, 'reg', ct(11))).status, 200, 'другой врач');
  } finally { t.close(); }
});

test('DUP_STOP_V1: пачка (массив) с одной услугой дважды и upsert повтора — 409, ничего не записано', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    const pack = await ins(t, 'reg', [row(v, 50), row(v, 50)]);
    assert.equal(pack.status, 409, JSON.stringify(pack.json));
    assert.equal(pack.json.error.code, 'duplicate_order');
    assert.match(pack.json.error.message, /«УЗИ брюшной полости» выбрана дважды/);
    assert.equal(live(t, v, 50), 0, 'половина пачки легла');
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const up = await t.dbq('reg', { table: 'visit_services', op: 'upsert', onConflict: 'id', values: row(v, 40) });
    assert.equal(up.status, 409, JSON.stringify(up.json));
    assert.equal(up.json.error.code, 'duplicate_order');
    assert.equal(live(t, v, 40), 1);
  } finally { t.close(); }
});

test('DUP_STOP_V1: строка записи колл-центра той же услуги не мешает — строка регистратуры занимает её место (R7b)', async () => {
  const t = await start();
  try {
    const ev = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10) });
    assert.equal(ev.status, 200, JSON.stringify(ev.json));
    const v = ev.json.data.visit.id;
    const bl = await t.rpc('booking_lines_add', 'cc', { visit_id: v, lines: [{ service_id: 40 }] });
    assert.equal(bl.status, 200, JSON.stringify(bl.json));
    const x = bl.json.data.added[0].id;
    const y = await ins(t, 'reg', row(v, 40), { returning: true, single: 'single' });
    assert.equal(y.status, 200, JSON.stringify(y.json));
    assert.equal(live(t, v, 40), 1, 'вторая копия записанной услуги');
    assert.equal(t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(x), undefined, 'строка записи ушла под строкой регистратуры');
  } finally { t.close(); }
});

test('DUP_STOP_V1: обход — администратор с причиной (__repeat_reason) назначает повтор, журнал счёта помнит; регистратор с причиной — 409', async () => {
  const t = await start();
  try {
    const v = arrivedVisit(t);
    assert.equal((await ins(t, 'reg', row(v, 40))).status, 200);
    const reg = await ins(t, 'reg', row(v, 40, { __repeat_reason: 'контрольный анализ' }));
    assert.equal(reg.status, 409, JSON.stringify(reg.json));
    const short = await ins(t, 'boss', row(v, 40, { __repeat_reason: 'ок' }));
    assert.equal(short.status, 409, 'причина короче трёх знаков');
    const boss = await ins(t, 'boss', row(v, 40, { __repeat_reason: 'контрольный анализ' }));
    assert.equal(boss.status, 200, JSON.stringify(boss.json));
    assert.equal(live(t, v, 40), 2);
    const log = t.db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
    assert.equal(log.length, 1);
    assert.equal(log[0].reason, 'контрольный анализ');
    assert.equal(log[0].visit_id, v);
    assert.equal(log[0].actor_user_id, 1);
  } finally { t.close(); }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/routes/dup-stop-db.test.js`
  Expected: FAIL — 4 из 6: `actual: 200, expected: 409` (повтор проходит; у пачки — тоже), у теста обхода — `actual: 400` (`__repeat_reason` — неизвестная колонка для `compile()`). Тесты «другой визит / отменённая / процедура» и «R7b» зелёные и до правки — они сторожат то, что разрешено.

- [ ] **Step 3: implement** — `server/routes/db.js`:

(а) Импорт: строку
```js
import { retireBookedTwin } from '../services/crm/booked-twin.js';   // CRM_LINK_ALL_V1 (R7b)
```
заменить на
```js
import { retireBookedTwin, bookedTwinFor } from '../services/crm/booked-twin.js';   // CRM_LINK_ALL_V1 (R7b) · DUP_STOP_V1 (bookedTwinFor)
import { autoTwinFor } from '../services/crm/one-way.js';   // DUP_STOP_V1 — строка CRM, которая уступит новой
import { checkOrders, logRepeatOrders, takeRepeatReason, DUP_CODE } from '../services/domain/dup-order.js';   // DUP_STOP_V1
```

(б) Сразу после функции `refuseVisitLineWrite` (её последние строки `  return null;\n}` перед комментарием `// CABINET_FIX_V1_R4 (ревью 4, п. 2) · CABINET_FIX_V1_R5 (ревью 5, A) — ЗАПИСИ КАБИНЕТА`) вставить:

```js
// DUP_STOP_V1 — ПОВТОРНОЕ НАЗНАЧЕНИЕ В ТОМ ЖЕ ВИЗИТЕ (domain/dup-order.js): вставка,
// пачка и upsert строк визита. Не мешают строки, которые эта же дверь уберёт под новой:
// строка CRM, уступающая строке человека (onVisitLinesAdded — все вставки), и строка
// записи колл-центра (R7b — только одиночная вставка, retireBookedTwin ниже).
// { error } — отказ 409; { repeats } — обход с причиной, журнал — после записи.
function visitOrderCheck(db, meta, body, user, reason) {
  if (!meta || meta.table !== 'visit_services' || (meta.op !== 'insert' && meta.op !== 'upsert')) return {};
  const rows = Array.isArray(body && body.values) ? body.values : (body && body.values ? [body.values] : []);
  const single = meta.op === 'insert' && !meta.multi;
  const spare = (line) => {
    const out = [];
    const auto = autoTwinFor(db, line);
    if (auto) out.push(auto.id);
    if (single) { const x = bookedTwinFor(db, line); if (x) out.push(x.id); }
    return out;
  };
  return checkOrders(db, rows, { user, reason, spare });
}

```

(в) В обработчике `r.post('/', …)` после строки
```js
    const notesBase = takeNotesBase(req.body);   // CABINET_FIX_V1_R5
```
добавить
```js
    const repeatReason = takeRepeatReason(req.body);   // DUP_STOP_V1 — причина повтора — не колонка
```

(г) Сразу после блока
```js
    const visitLineRefusal = refuseVisitLineWrite(db, compiled.meta, req.body, req.user);
    if (visitLineRefusal) {
      return res.status(409).json({ error: { code: 'conflict', message: visitLineRefusal } });
    }
```
добавить
```js
    // DUP_STOP_V1 — та же услуга уже назначена в этом визите: см. visitOrderCheck.
    const orders = visitOrderCheck(db, compiled.meta, req.body, req.user, repeatReason);
    if (orders.error) return res.status(409).json({ error: errorBody(DUP_CODE, orders.error) });
```

(д) Журнал обхода — после записи, в трёх местах:
- пачка вставки: после `mirrorAfter(db, mirror, meta, req.body, req.user);   // CRM_CALENDAR_MIRROR_V1` и `rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1` внутри `if (meta.multi) {` — перед `return res.json({ data: null });` добавить `          logRepeatOrders(db, orders, req.user);   // DUP_STOP_V1 — обход с причиной — в журнал`;
- одиночная вставка: после строки `        mirrorAfter(db, mirror, meta, req.body, req.user, { insertedId: Number(info.lastInsertRowid) });   // CRM_CALENDAR_MIRROR_V1` добавить `        logRepeatOrders(db, orders, req.user);   // DUP_STOP_V1`;
- upsert: в блоке `if (meta.op === 'upsert') {` после `rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1` добавить `        logRepeatOrders(db, orders, req.user);   // DUP_STOP_V1`.

(`errorBody` уже импортирован из `../services/server-message.js`; он кладёт `template` и `params` — экран переводит отказ.)

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/routes/dup-stop-db.test.js`
  Expected: PASS (6).

- [ ] **Step 5: существующие тесты.** Run:
  `node --experimental-vm-modules --test server/routes/crm-arrival-evidence.test.js server/routes/crm-link-all-twin.test.js server/routes/crm-one-way-r2-m2-twin.test.js server/routes/crm-one-way-r2-m2-r1.test.js server/routes/crm-unify-desk-money.test.js server/routes/package-stamp.test.js server/routes/refbill-review-http.test.js`
  Expected: FAIL 14 — все вставляют ту же услугу второй раз в тот же визит (`actual: 409, expected: 200`). Разбор и правки:

  **Удобство приспособления (правка приспособления, смысл теста прежний):**
  - `crm-arrival-evidence.test.js` «услуга, заведённая в смету, заявку не трогает» — в визите 500 уже стоит строка 900 той же консультации. После `try {` этого теста, перед `const cookie = await login(base);`, вставить:
    ```js
        // DUP_STOP_V1 — в визите уже стоит строка 900 той же консультации: вставка была бы повтором (409).
        // Проверка — про смету и заявку, поэтому строка 900 здесь отменена.
        db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = 900").run();
    ```
  - `package-stamp.test.js` «строке из пакета дверь ставит цену…» — третья строка пачки (вне пакета) — анализ 2 второй раз. После `db.prepare("INSERT INTO services (id, name, price, type) VALUES (2,'Анализ',50000,'lab')").run();` добавить `db.prepare("INSERT INTO services (id, name, price, type) VALUES (3,'Анализ мочи',50000,'lab')").run();   // DUP_STOP_V1 — строка вне пакета — другая услуга`; в третьей строке пачки `{ visit_id: 500, service_id: 2, quantity: 1, unit_price: 50000, total: 50000, status: 'added', package_price: 1 },` заменить `service_id: 2` на `service_id: 3` (комментарий `// DUP_STOP_V1 — анализ 2 уже в пачке`); в ожидании `[2, null, null, null, 50000, 50000]` → `[3, null, null, null, 50000, 50000]`.
  - `package-stamp.test.js` «шаблон сметы — обычные строки…» — то же УЗИ второй раз. Между `db.prepare('UPDATE service_templates SET is_package = 1 WHERE id = 2').run();` и вторым `assert.equal((await addLine(base, cookie, 2)).status, 200);` вставить:
    ```js
        // DUP_STOP_V1 — то же УЗИ второй раз в визите — повтор: первая строка (шаблон) отменяется.
        db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE visit_id = 500").run();
    ```
    (`PKG_ROWS` статус не читает — ожидание прежнее.)
  - `refbill-review-http.test.js` «C1 (probe-http)…» — «честная» строка — тот же приём у того же врача. После `assert.deepEqual({ ...line }, { status: 'added', invoice_item_id: null }, 'строка не ушла в очередь «оплаченной»');` вставить:
    ```js
        // DUP_STOP_V1 — тот же приём у того же врача второй раз — повтор: «нечестную» строку снимаем.
        t.db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(ins.json.data.id);
    ```

  **Смысл поменялся (тест закреплял второе назначение той же услуги — решение владельца его запрещает):** такие тесты теперь проверяют, что регистратуре отказ 409, а повтор (чтобы проверить, что сеть R7b не трогает строку записи) назначает администратор с причиной.
  - `server/test-helpers/crm-link-all.js` — заменить функцию `addVisitLine` и добавить помощника:
    ```js
    export async function addVisitLine(t, who, vid, { svc = 30, doctor = 10, quantity = 1, repeatReason = null } = {}) {
      const p = priceOf(t, svc);
      const values = { visit_id: vid, service_id: svc, doctor_id: doctor, quantity, unit_price: p, total: p * quantity, price_tier: 'primary', status: 'added' };
      if (repeatReason) values.__repeat_reason = repeatReason;   // DUP_STOP_V1 — повтор в визите: администратор с причиной
      const r = await t.dbq(who, { table: 'visit_services', op: 'insert', returning: true, single: 'single', values });
      assert.equal(r.status, 200, r.text);
      return r.json.data.id;
    }

    /** DUP_STOP_V1 — та же услуга второй раз в том же визите: дверь /api/db отказывает 409 duplicate_order. */
    export async function assertRepeatRefused(t, who, vid, { svc = 30, doctor = 10, quantity = 1 } = {}) {
      const p = priceOf(t, svc);
      const r = await t.dbq(who, { table: 'visit_services', op: 'insert',
        values: { visit_id: vid, service_id: svc, doctor_id: doctor, quantity, unit_price: p, total: p * quantity, price_tier: 'primary', status: 'added' } });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error.code, 'duplicate_order');
    }
    ```
  - `crm-link-all-twin.test.js` — импорт: `import { vsOf, cardLines, addVisitLine, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';` → `import { vsOf, cardLines, addVisitLine, callcenterBook, deskRegister, assertRepeatRefused } from '../test-helpers/crm-link-all.js';   // DUP_STOP_V1 — assertRepeatRefused`. Затем:
    - «настоящий повтор, другой врач и количество 2»: `const y2 = await addVisitLine(t, 'reg', bid);` → две строки
      ```js
          // DUP_STOP_V1 — второй такой же приём регистратуре — 409; администратор назначает с причиной.
          await assertRepeatRefused(t, 'reg', bid);
          const y2 = await addVisitLine(t, 'boss', bid, { repeatReason: 'второй приём по показаниям' });
      ```
      и во второй половине `const y = await addVisitLine(t2, 'reg', bid, { quantity: 2 });` →
      ```js
          await assertRepeatRefused(t2, 'reg', bid, { quantity: 2 });   // DUP_STOP_V1
          const y = await addVisitLine(t2, 'boss', bid, { quantity: 2, repeatReason: 'два приёма подряд' });
      ```
      (`const other = await addVisitLine(t, 'reg', bid, { doctor: 11 });` — консультация другого врача — без изменений.)
    - «строка записи в счёте — не трогается (I4)»: `const y = await addVisitLine(t, 'reg', bid);` →
      ```js
          // DUP_STOP_V1 — выставленная строка записи — назначение: та же консультация второй раз — 409.
          await assertRepeatRefused(t, 'reg', bid);
          const y = await addVisitLine(t, 'boss', bid, { repeatReason: 'повторный приём' });
      ```
    - «строку регистратуры (не колл-центр, не зеркало) вставка не заменяет»: `const y = await addVisitLine(t, 'reg', vid);` →
      ```js
          await assertRepeatRefused(t, 'reg', vid);   // DUP_STOP_V1
          const y = await addVisitLine(t, 'boss', vid, { repeatReason: 'повторный приём' });
      ```
  - `crm-one-way-r2-m2-twin.test.js` (M2-T3, 5 из 6 вариантов: billed, started, qty2, registrarLine, yQty2) — импорт `import { vsOf, callcenterBook, addVisitLine } from '../test-helpers/crm-link-all.js';` → `import { vsOf, callcenterBook, addVisitLine, assertRepeatRefused } from '../test-helpers/crm-link-all.js';   // DUP_STOP_V1 — assertRepeatRefused`; строку
    ```js
          const y = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: kind === 'otherDoctor' ? 11 : 10, quantity: kind === 'yQty2' ? 2 : 1 });
    ```
    заменить на
    ```js
          // DUP_STOP_V1 — та же консультация у того же врача — повтор: регистратуре 409, администратор
          // назначает с причиной; у другого врача — можно без причины.
          const repeat = kind !== 'otherDoctor';
          if (repeat) await assertRepeatRefused(t, 'reg', vid, { svc: 30, doctor: 10, quantity: kind === 'yQty2' ? 2 : 1 });
          const y = await addVisitLine(t, repeat ? 'boss' : 'reg', vid, { svc: 30, doctor: kind === 'otherDoctor' ? 11 : 10, quantity: kind === 'yQty2' ? 2 : 1, repeatReason: repeat ? 'повтор по показаниям' : null });
    ```
  - `crm-one-way-r2-m2-r1.test.js` (M2-B1) — импорт `import { link, vsOf, calendarBook, callcenterBook, deskRegister, addVisitLine } from '../test-helpers/crm-link-all.js';` → добавить `assertRepeatRefused` (комментарий `// DUP_STOP_V1 — assertRepeatRefused`); строку `    await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });` (перед `assert.equal(snap(), before);`) заменить на
    ```js
        // DUP_STOP_V1 — «позже та же услуга»: регистратуре — 409; администратор с причиной — строка встаёт,
        // выставленное не меняется.
        await assertRepeatRefused(t, 'reg', vid, { svc: 30, doctor: 10 });
        await addVisitLine(t, 'boss', vid, { svc: 30, doctor: 10, repeatReason: 'повторный приём' });
    ```
  - `crm-unify-desk-money.test.js` (C1d «строка зеркала, которая сама уже в счёте, не трогается») — блок от `const ins = await t.dbq('reg', …` до `'выставленная строка зеркала исчезла');` заменить на
    ```js
        // DUP_STOP_V1 — выставленная строка зеркала — назначение: тот же анализ регистратуре — 409,
        // администратор назначает с причиной; выставленная строка цела в обоих случаях.
        const refused = await t.dbq('reg', { table: 'visit_services', op: 'insert',
          values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json.error.code, 'duplicate_order');
        assert.deepEqual(liveOf(t.db, vid, 40).map((x) => x.id), [auto]);
        const ins = await t.dbq('boss', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
          values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added', __repeat_reason: 'контрольный анализ' } });
        assert.equal(ins.status, 200, ins.text);
        assert.deepEqual(liveOf(t.db, vid, 40).map((x) => x.id).sort((p, q) => p - q), [auto, ins.json.data.id].sort((p, q) => p - q),
          'выставленная строка зеркала исчезла');
    ```

- [ ] **Step 6: run** — та же команда, что в Step 5, плюс `server/routes/dup-stop-db.test.js server/routes/visit-lines-v3120-final.test.js server/routes/surgery-needs-bed.test.js server/routes/crm-link-all-twin-line.test.js server/routes/crm-unify-desk.test.js`
  Expected: PASS.

- [ ] **Step 7: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: дверь /api/db не заводит ту же услугу второй раз в визите

Вставка, пачка и upsert строки визита той же услуги, что уже назначена в
этом визите, — 409 duplicate_order со словами «кем, когда, счёт №». Внутри
одной пачки — тоже. Строка записи колл-центра (R7b) и строка CRM, которые
дверь сама уберёт под новой, не мешают. Администратор и главный врач —
с причиной (__repeat_reason), журнал счёта. Тесты, закреплявшие второе
назначение той же услуги, проверяют отказ и обход с причиной.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/routes/db.js server/routes/dup-stop-db.test.js server/test-helpers/crm-link-all.js server/routes/crm-arrival-evidence.test.js server/routes/crm-link-all-twin.test.js server/routes/crm-one-way-r2-m2-twin.test.js server/routes/crm-one-way-r2-m2-r1.test.js server/routes/crm-unify-desk-money.test.js server/routes/package-stamp.test.js server/routes/refbill-review-http.test.js
git commit -F .git/U9_MSG.txt
```

---

### Task U9.5: двери RPC — касса добавляет, заменяет и возвращает; смена врача; повторное выставление возвращённой строки

**Files:**
- Modify: `server/services/rpc/billing.js`
- Modify: `server/services/rpc/patient-card.js`
- Create: `server/services/rpc/dup-stop-rpc.test.js`
- Modify: `server/services/rpc/billing.packages.test.js`, `server/services/rpc/billing.test.js`

- [ ] **Step 1: failing test** — создать `server/services/rpc/dup-stop-rpc.test.js`:

```js
// DUP_STOP_V1 (2026-11-02) — двери RPC, которые заводят или меняют строку визита:
// касса добавляет услугу (cashier_line_add), заменяет услугу или врача в неоплаченном
// счёте (cashier_line_change_service, change_unpaid_service, cashier_line_set_doctor,
// patient_card_set_doctor), в оплаченном (cashier_line_swap_paid / _quote), возврат с новой
// услугой (cashier_line_rebill_paid), повторное выставление возвращённой строки
// (create_invoice_for_visit + rebill_refunded); и проверка экранов visit_dup_check.
// Всё — через настоящую карту RPC (index.js) и SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { hashPassword } from '../auth.js';

const admin = { id: 1, role: 'admin', extra_roles: [], full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', extra_roles: [], full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', extra_roles: [], full_name: 'Кассир' };
const callcenter = { id: 8, role: 'callcenter', extra_roles: [], full_name: 'Оператор' };
const DOC = 20, DOC2 = 21;
const DAY = '2026-09-10T05:00:00Z';

function clinic() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, extra_roles) VALUES (?,?,?,?,?,?,1,?)');
  u.run(1, 'adm', hashPassword('password1'), 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0, '[]');
  u.run(8, 'cc', 'x', 'callcenter', 'Оператор', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач Первый', 1, '[]');
  u.run(DOC2, 'doc2', 'x', 'doctor', 'Врач Второй', 1, '[]');
  const s = db.prepare('INSERT INTO services (id, name, price, type, requires_doctor) VALUES (?,?,?,?,?)');
  s.run(30, 'Приём терапевта', 100000, 'consultation', 1);
  s.run(40, 'Анализ крови', 40000, 'lab', 0);
  s.run(50, 'УЗИ', 80000, 'imaging', 0);
  s.run(60, 'Капельница', 30000, 'procedure', 0);
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  const perms = JSON.stringify({ sections: [], levels: {}, grants: { 'cashier.lines': 'edit' } });
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions').run('cashier', perms);
  openCashShift(db, { opening_float: 0 }, cashier);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY).lastInsertRowid);
  return { db, pid, vid };
}
const line = (db, vid, r) => {
  const row = { visit_id: vid, quantity: 1, unit_price: 0, total: 0, status: 'added', created_by: 7, ...r };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
};
const call = (name, db, args, user) => RPC[name](db, args, user);
const dup = (fn) => assert.throws(fn, (e) => e.status === 409 && e.code === 'duplicate_order' && /уже назначена в этом визите/.test(e.message));
const count = (db, vid, svc) => db.prepare("SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND service_id = ? AND status <> 'cancelled'").get(vid, svc).n;

test('DUP_STOP_V1: cashier_line_add — услуга уже в визите — 409, строки и счёта не прибавилось; процедура — можно', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const invBefore = db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  dup(() => call('cashier_line_add', db, { visit_id: vid, service_id: 40 }, cashier));
  assert.equal(count(db, vid, 40), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, invBefore, 'отказ не выставил счёт');
  line(db, vid, { service_id: 60 });
  assert.ok(call('cashier_line_add', db, { visit_id: vid, service_id: 60 }, cashier).line, 'процедура второй раз');
  assert.ok(call('cashier_line_add', db, { visit_id: vid, service_id: 50 }, cashier).line, 'новая услуга');
});

test('DUP_STOP_V1: cashier_line_add — администратор с причиной назначает повтор, журнал счёта помнит; кассир с причиной — 409', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  dup(() => call('cashier_line_add', db, { visit_id: vid, service_id: 40, __repeat_reason: 'контрольный анализ' }, cashier));
  const out = call('cashier_line_add', db, { visit_id: vid, service_id: 40, __repeat_reason: 'контрольный анализ' }, admin);
  assert.ok(out.line);
  assert.equal(count(db, vid, 40), 2);
  const log = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
  assert.deepEqual(log.map((r) => [r.visit_id, r.reason]), [[vid, 'контрольный анализ']]);
});

test('DUP_STOP_V1: замена услуги в неоплаченном счёте на уже назначенную — 409; на новую — можно', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const usg = line(db, vid, { service_id: 50 });
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [usg] }, registrar);
  dup(() => call('cashier_line_change_service', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  dup(() => call('change_unpaid_service', db, { visit_service_id: usg, new_service_id: 40 }, admin));
  assert.equal(db.prepare('SELECT service_id FROM visit_services WHERE id = ?').get(usg).service_id, 50, 'строка не изменилась');
  assert.equal(call('cashier_line_change_service', db, { visit_service_id: usg, new_service_id: 60 }, cashier).changed, true);
});

test('DUP_STOP_V1: смена врача консультации на врача, у которого этот вид уже назначен, — 409 (касса и карта пациента)', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: null, consultation_type_id: 5, doctor_id: DOC });
  const b = line(db, vid, { service_id: null, consultation_type_id: 5, doctor_id: DOC2 });
  dup(() => call('cashier_line_set_doctor', db, { visit_service_id: b, doctor_id: DOC }, cashier));
  dup(() => call('patient_card_set_doctor', db, { visit_service_id: b, doctor_id: DOC }, admin));
  assert.equal(db.prepare('SELECT doctor_id FROM visit_services WHERE id = ?').get(b).doctor_id, DOC2);
  // Анализ у другого исполнителя — тот же ключ (врач не входит): правка проходит.
  const lab = line(db, vid, { service_id: 40, doctor_id: DOC });
  line(db, vid, { service_id: 40, doctor_id: DOC2, status: 'cancelled' });
  assert.equal(call('patient_card_set_doctor', db, { visit_service_id: lab, doctor_id: DOC2 }, admin).doctor_id, DOC2);
});

test('DUP_STOP_V1: замена в оплаченном счёте и её предпросмотр — новая услуга уже в визите — 409, деньги не двигались', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const usg = line(db, vid, { service_id: 50 });
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [usg] }, registrar).invoice;
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);
  dup(() => call('cashier_line_swap_quote', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  dup(() => call('cashier_line_swap_paid', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE amount < 0').get().n, 0, 'возврата не было');
});

test('DUP_STOP_V1: возврат с новой услугой — новая уже в визите — 409; та же услуга у другого врача — можно (прежняя строка отпущена)', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const usg = line(db, vid, { service_id: 50, doctor_id: DOC });
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [usg] }, registrar).invoice;
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(usg);
  dup(() => call('cashier_line_rebill_quote', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  dup(() => call('cashier_line_rebill_paid', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: usg, new_service_id: 50, doctor_id: DOC2 }, cashier);
  assert.equal(r.rebill, true);
  assert.equal(count(db, vid, 50), 2, 'прежняя строка в визите (отпущена с возвратом) и новая');
});

test('DUP_STOP_V1: возвращённую строку снова выставляют (rebill_refunded) — если та же услуга уже назначена заново, 409', () => {
  const { db, vid } = clinic();
  const old = line(db, vid, { service_id: 40, status: 'collected' });
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 1)").run(old);
  const fresh = line(db, vid, { service_id: 40 });   // назначили заново — можно: прежняя отпущена
  dup(() => call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [old], rebill_refunded: true }, registrar));
  assert.ok(call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [fresh] }, registrar).invoice);
});

test('DUP_STOP_V1 (К1): «Вернуть услугу» — возвращённая строка с начатой работой больше не мешает назначить ту же услугу снова', () => {
  const { db, vid } = clinic();
  const lab = line(db, vid, { service_id: 40 });
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [lab] }, registrar).invoice;
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = ?").run(lab);   // проба взята — строка останется в визите
  dup(() => call('cashier_line_add', db, { visit_id: vid, service_id: 40 }, cashier));   // пока не возвращена — повтор
  const item = db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(lab).invoice_item_id;
  call('refund_invoice_line', db, { invoice_item_id: item, reason: 'пациент отказался' }, cashier);
  assert.ok(db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(lab), 'начатая работа осталась в визите');
  assert.ok(call('cashier_line_add', db, { visit_id: vid, service_id: 40 }, cashier).line, 'возвращённая строка мешает назначить анализ снова');
  assert.equal(count(db, vid, 40), 2);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/dup-stop-rpc.test.js`
  Expected: FAIL 8 из 8 — `Missing expected exception` (двери пропускают повтор).

- [ ] **Step 3: implement** — `server/services/rpc/billing.js`:

(а) Импорт: строку
```js
import { onVisitLinesAdded, releaseVisitLine } from '../crm/one-way.js';   // CRM_ONE_WAY_V1 — касса и строки записи карточки
```
заменить на
```js
import { onVisitLinesAdded, releaseVisitLine, autoTwinFor } from '../crm/one-way.js';   // CRM_ONE_WAY_V1 — касса и строки записи карточки · DUP_STOP_V1 (autoTwinFor)
import { assertOrders, assertChangedOrder, logRepeatOrders, repeatReasonArg } from '../domain/dup-order.js';   // DUP_STOP_V1
```

(б) `issueVisitInvoice` — повторное выставление возвращённой строки. Сразу после блока отказа
```js
    if (refundedIds.length && !(args.rebill_refunded === true || args.rebill_refunded === 1)) {
      throw new RpcError(refundedIds.length === 1
        ? 'За эту услугу пациенту уже вернули деньги — снова её выставляют только явным выбором («выставить заново»).'
        : 'За ' + refundedIds.length + ' из выбранных услуг пациенту уже вернули деньги — снова их выставляют только явным выбором («выставить заново»).', 409);
    }
```
добавить
```js
    // DUP_STOP_V1 — возвращённая строка, выставленная заново, снова назначение: если та же
    // услуга уже назначена в визите (или выбрана дважды) — отказ. Журнал обхода — в этой же
    // транзакции: отказ ниже откатит и его.
    if (refundedIds.length) {
      const back = new Set(refundedIds.map(Number));
      logRepeatOrders(db, assertOrders(db, rows.filter((r) => back.has(Number(r.id))), { user, reason: repeatReasonArg(args) }), user);
    }
```
(U6 перестраивает `issueVisitInvoice`/`create_invoice_for_visit`; место — сразу после отказа «За эту услугу пациенту уже вернули деньги…», внутри транзакции, где `rows` уже собраны.)

(в) `changeUnpaidService` — после строки
```js
    { const r = surgeryWithoutBedRefusal(db, newServiceId, vs.visit_id); if (r) throw new RpcError(r, 400); }

    const item = vs.invoice_item_id != null
```
(первое вхождение — в `changeUnpaidService`, ~:1300) вставить между ними:
```js
    // DUP_STOP_V1 — новая услуга уже назначена в этом визите — отказ (или обход с причиной).
    const orders = assertChangedOrder(db, vs, { ...vs, service_id: newServiceId, consultation_type_id: null }, { user, reason: repeatReasonArg(args) });
```
и после строки
```js
      .run(newServiceId, unit, lineTotal, tier, vsId);

    let invoice = null;
```
вставить перед `let invoice = null;`:
```js
    logRepeatOrders(db, orders, user);   // DUP_STOP_V1
```

(г) `setUnpaidLineDoctor` — после строки
```js
    if (Number(vs.doctor_id) === doctorId) return idemRemember(db, rpc, args, user, { changed: false, line: vs, invoice: inv });
```
вставить
```js
    // DUP_STOP_V1 — консультация к врачу, у которого этот вид уже назначен в визите, — повтор.
    const orders = assertChangedOrder(db, vs, { ...vs, doctor_id: doctorId }, { user, reason: repeatReasonArg(args) });
```
и после
```js
    db.prepare('UPDATE visit_services SET doctor_id = ?, unit_price = ?, total = ?, queue_key = NULL, queue_no = NULL WHERE id = ?')
      .run(doctorId, unit, lineTotal, vsId);
```
(первое вхождение — в `setUnpaidLineDoctor`) вставить
```js
    logRepeatOrders(db, orders, user);   // DUP_STOP_V1
```

(д) `addServiceToVisitInvoice` (`cashier_line_add`) — перед строкой
```js
    const tier = quoteTier(db, visit, visitId, serviceId);
    const unit = round2(lineUnitPrice(db, { service_id: serviceId, doctor_id: doctorId, price_tier: tier, clinic_item_id: null, consultation_type_id: null }, { service: svc }));
```
вставить
```js
    // DUP_STOP_V1 — та же услуга уже назначена в этом визите — отказ. Строка CRM, которая
    // уступит этой (onVisitLinesAdded ниже), повтором не считается.
    const orders = assertOrders(db, [{ visit_id: visitId, service_id: serviceId, doctor_id: doctorId }], {
      user, reason: repeatReasonArg(args), spare: (l) => { const a = autoTwinFor(db, l); return a ? [a.id] : []; },
    });

```
и сразу после строки вставки строки
```js
      VALUES (?, ?, ?, 1, ?, ?, 'added', ?, ?)`).run(visitId, serviceId, doctorId, unit, unit, tier, user.id).lastInsertRowid);
```
добавить
```js
    logRepeatOrders(db, orders, user);   // DUP_STOP_V1
```

(е) `swapPaidLineTx` — после блока
```js
  if (!serviceChanges && Number(targetDoctor) === Number(vs.doctor_id)) {
    return { changed: false, refunded: 0, due: 0, refund_plan: [], invoice: inv, line: vs };
  }
```
вставить
```js
  // DUP_STOP_V1 — новая услуга (у консультации — и новый врач) уже назначена в этом
  // визите — отказ, и в предпросмотре тоже. У возврата с новой услугой прежняя строка
  // уходит со счёта с возвратом — она не мешает (excludeIds через assertChangedOrder).
  const orders = assertChangedOrder(db, rebill ? { ...vs, service_id: null, consultation_type_id: null } : vs,
    serviceChanges
      ? { ...vs, service_id: newServiceId, consultation_type_id: null, doctor_id: targetDoctor }
      : { ...vs, doctor_id: targetDoctor },
    { user, reason: repeatReasonArg(args), excludeIds: [vsId] });
```
и перед строками
```js
  // 4. Журнал.
  const after = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(lineId);
```
вставить
```js
  if (!dryRun) logRepeatOrders(db, orders, user);   // DUP_STOP_V1
```
(У возврата с новой услугой `before` без ключа — проверка идёт всегда; прежняя строка исключена: она уходит со счёта с возвратом.)

`server/services/rpc/patient-card.js`:
- импорт — после первой строки `import` файла добавить `import { assertChangedOrder, logRepeatOrders, repeatReasonArg } from '../domain/dup-order.js';   // DUP_STOP_V1`;
- в `patientCardSetServiceDoctor` строки
```js
  db.prepare('UPDATE visit_services SET doctor_id = ? WHERE id = ?').run(doctorId, vsId);
  return { id: vsId, doctor_id: doctorId };
```
заменить на
```js
  // DUP_STOP_V1 — консультация к врачу, у которого этот вид уже назначен в визите, — повтор.
  const vsNow = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
  const orders = assertChangedOrder(db, vsNow, { ...vsNow, doctor_id: doctorId }, { user, reason: repeatReasonArg(args) });
  db.prepare('UPDATE visit_services SET doctor_id = ? WHERE id = ?').run(doctorId, vsId);
  logRepeatOrders(db, orders, user);   // DUP_STOP_V1
  return { id: vsId, doctor_id: doctorId };
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/dup-stop-rpc.test.js`
  Expected: PASS (8).

- [ ] **Step 5: существующие тесты.** Run: `node --experimental-vm-modules --test server/services/rpc/billing.packages.test.js server/services/rpc/billing.test.js`
  Expected: FAIL 2 — оба меняют услугу строки на уже стоящую в визите (удобство приспособления):
  - `billing.packages.test.js` «замена услуги в строке пакета снимает с неё пакет и его скидку»: строку
    ```js
      const out = changeUnpaidService(c.db, { visit_service_id: a, new_service_id: 2 }, admin);
    ```
    заменить на
    ```js
      // DUP_STOP_V1 — анализ 2 уже в визите: замена на него — повтор; меняем на другой анализ той же цены.
      c.db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3, 'Анализ мочи', 50000, 0, 'lab')").run();
      const out = changeUnpaidService(c.db, { visit_service_id: a, new_service_id: 3 }, admin);
    ```
    (ожидания `subtotal 100000`, скидка 0 — прежние: цена та же.)
  - `billing.test.js` «товарную строку нельзя ПОДМЕНИТЬ услугой…»: строки
    ```js
      const ok = changeUnpaidService(db, { visit_service_id: vs1, new_service_id: s2 }, registrar);
      assert.equal(ok.changed, true);
      assert.equal(db.prepare('SELECT service_id FROM visit_services WHERE id=?').get(vs1).service_id, s2);
    ```
    заменить на
    ```js
      // DUP_STOP_V1 — X-ray (s2) уже в визите: замена на неё — повтор; меняем на третью услугу.
      const s3 = Number(db.prepare("INSERT INTO services (name, price) VALUES ('ECG', 40000)").run().lastInsertRowid);
      const ok = changeUnpaidService(db, { visit_service_id: vs1, new_service_id: s3 }, registrar);
      assert.equal(ok.changed, true);
      assert.equal(db.prepare('SELECT service_id FROM visit_services WHERE id=?').get(vs1).service_id, s3);
    ```

- [ ] **Step 6: run** — `node --experimental-vm-modules --test server/services/rpc/dup-stop-rpc.test.js server/services/rpc/billing.packages.test.js server/services/rpc/billing.test.js server/services/rpc/cashier-head.test.js server/services/rpc/cashier-paid-swap.test.js server/services/rpc/refund-swap.test.js server/services/rpc/refund-swap-rebill.test.js server/services/rpc/refund-any.cancelled-invoice.test.js server/services/rpc/own-price-repeat.test.js server/services/rpc/cashier-unbilled.window.test.js`
  Expected: PASS.

- [ ] **Step 7: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: касса и карта пациента не заводят ту же услугу второй раз в визите

Добавление услуги кассой, замена услуги и врача в неоплаченном и оплаченном
счёте (и предпросмотр), возврат с новой услугой и повторное выставление
возвращённой строки отказывают 409, если новая услуга (у консультации —
вид у того же врача) уже назначена в этом визите. Строка CRM, уступающая
строке кассы, и строка, возвращённая «Вернуть услугу», не мешают (К1).
Обход — администратор и главный врач с причиной.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/rpc/billing.js server/services/rpc/patient-card.js server/services/rpc/dup-stop-rpc.test.js server/services/rpc/billing.packages.test.js server/services/rpc/billing.test.js
git commit -F .git/U9_MSG.txt
```

---

### Task U9.6: RPC `visit_dup_check` — что уже назначено в визите дня (только чтение)

**Files:**
- Modify: `server/services/rpc/visits.js` (`dayVisitOf`)
- Create: `server/services/rpc/dup-order-check.js`
- Modify: `server/services/rpc/index.js`, `server/services/control/gate.js`
- Modify: `server/services/rpc/dup-stop-rpc.test.js` (+2 теста в конец)

- [ ] **Step 1: failing test** — дописать в конец `server/services/rpc/dup-stop-rpc.test.js`:

```js

test('DUP_STOP_V1: visit_dup_check — визит дня пациента, назначенное, повторы, поблажки и право обхода', () => {
  const { db, pid, vid } = clinic();
  const day = db.prepare("SELECT date(visit_date, 'localtime') d FROM visits WHERE id = ?").get(vid).d;
  line(db, vid, { service_id: 40, created_by: DOC });
  line(db, vid, { service_id: 60 });
  line(db, vid, { service_id: 50, status: 'cancelled' });
  const out = call('visit_dup_check', db, { patient_id: pid, date: day, lines: [{ service_id: 40 }, { service_id: 50 }, { service_id: 60 }] }, registrar);
  assert.equal(out.visit_id, vid);
  assert.deepEqual(out.ordered.map((o) => [o.service_id, o.key, o.who]), [[40, 's:40', 'Врач Первый']], 'процедура и отменённая — не назначение');
  assert.deepEqual(out.duplicates.map((d) => d.index), [0]);
  assert.match(out.duplicates[0].message, /«Анализ крови» — Врач Первый/);
  assert.ok(out.duplicates[0].template && out.duplicates[0].params);
  assert.equal(out.can_override, false);
  assert.equal(call('visit_dup_check', db, { visit_id: vid, lines: [] }, admin).can_override, true);
  assert.deepEqual(call('visit_dup_check', db, { patient_id: pid, date: '2030-01-01', lines: [{ service_id: 40 }] }, registrar),
    { visit_id: null, ordered: [], duplicates: [], can_override: false }, 'визита в этот день нет — повторов нет');
  assert.equal(call('visit_dup_check', db, { visit_id: vid, lines: [{ service_id: 40 }], exclude_ids: [out.ordered[0].id] }, registrar).duplicates.length, 0, 'строку, которую экран снимет сам, не считаем');
  assert.throws(() => call('visit_dup_check', db, { lines: [] }, registrar), (e) => e.status === 400);
  assert.throws(() => call('visit_dup_check', db, { visit_id: vid }, { id: 99, role: 'lab', extra_roles: [] }), (e) => e.status === 403);
});

test('DUP_STOP_V1: visit_dup_check — строка записи колл-центра — не «уже назначено»: строка регистратуры займёт её место', () => {
  const { db, pid } = clinic();
  const future = new Date(); future.setDate(future.getDate() + 3); future.setHours(10, 0, 0, 0);
  const v = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, future.toISOString()).lastInsertRowid);
  const added = call('booking_lines_add', db, { visit_id: v, lines: [{ service_id: 40 }] }, callcenter).added;
  assert.equal(added.length, 1);
  const out = call('visit_dup_check', db, { visit_id: v, lines: [{ service_id: 40 }] }, registrar);
  assert.deepEqual(out.ordered, []);
  assert.deepEqual(out.duplicates, []);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test server/services/rpc/dup-stop-rpc.test.js`
  Expected: FAIL 2 новых — `TypeError: RPC[name] is not a function` (RPC нет).

- [ ] **Step 3: implement.**

`server/services/rpc/visits.js` — перед комментарием `// args: { patient_id, date (ISO datetime or YYYY-MM-DD), doctor_id?,` (шапка `ensureVisit`) вставить:
```js
// DUP_STOP_V1 — ВИЗИТ ДНЯ ПАЦИЕНТА — одно правило для ensure_visit и visit_dup_check
// (rpc/dup-order-check.js): местный день, свой (sync_origin пуст), не отменён и не «не
// пришёл». BILLING_AUDIT_FIX_V1 (A1, A8) — почему именно так, см. ensureVisit ниже.
const DAY_VISIT_SQL = `
  SELECT * FROM visits
   WHERE patient_id = ? AND ${localDate('visit_date')} = ?
     AND status NOT IN ('cancelled', 'no_show')
     AND sync_origin IS NULL
   ORDER BY id LIMIT 1`;
/** @returns {object|null} визит дня `day` ('YYYY-MM-DD', местный) пациента или null */
export function dayVisitOf(db, patientId, day) {
  return db.prepare(DAY_VISIT_SQL).get(patientId, day) || null;
}

```
В `ensureVisit` блок
```js
  const DAY_VISIT_SQL = `
    SELECT * FROM visits
     WHERE patient_id = ? AND ${localDate('visit_date')} = ?
       AND status NOT IN ('cancelled', 'no_show')
       AND sync_origin IS NULL
     ORDER BY id LIMIT 1`;
  const dayVisit = () => db.prepare(DAY_VISIT_SQL).get(patientId, day);
```
заменить на
```js
  const dayVisit = () => dayVisitOf(db, patientId, day);   // DUP_STOP_V1 — правило вынесено (dayVisitOf)
```
и строку `    const existing = db.prepare(DAY_VISIT_SQL).get(patientId, day);` — на `    const existing = dayVisitOf(db, patientId, day);   // DUP_STOP_V1`.

Создать `server/services/rpc/dup-order-check.js`:
```js
// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — visit_dup_check: ЧТО УЖЕ НАЗНАЧЕНО В ВИЗИТЕ ДНЯ
// ═══════════════════════════════════════════════════════════════════════════
//
// Только чтение. Экраны записи (мастер визита, калькулятор услуг, быстрая регистрация,
// кабинет врача) спрашивают ДО первой записи — до ensure_visit и calendar_book: отказ
// не оставляет ни пустого визита, ни строк, ни счёта. Последнее слово — у дверей
// записи (routes/db.js visitOrderCheck, RPC кассы): здесь то же правило
// (domain/dup-order.js) и те же поблажки двери /api/db (строка записи колл-центра под
// одиночной вставкой — R7b; строка CRM, уступающая строке человека).
//
// args: { visit_id } | { patient_id, date ('YYYY-MM-DD' местный день или ISO) },
//       lines?: [{ service_id?, consultation_type_id?, doctor_id? }] (до 50),
//       exclude_ids?: [visit_service_id] — строки, которые экран сам снимет до записи.
// → { visit_id|null, ordered: [...], duplicates: [{ index, message, template, params, line_id }], can_override }
//   ordered — назначенное (без строк, которые уступят новой строке той же услуги): по нему
//   каталоги гасят услуги («уже назначено»).
import { hasAnyRole } from '../roles.js';
import { localDate } from '../domain/day.js';
import { liveOrders, duplicateHits, refusalOf, canRepeatOrder, keyOfRow } from '../domain/dup-order.js';
import { dayVisitOf } from './visits.js';
import { bookedTwinFor } from '../crm/booked-twin.js';
import { autoTwinFor } from '../crm/one-way.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'callcenter'];
const MAX_LINES = 50;
const pos = (v) => (v != null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function visitDupCheck(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Вашей роли это действие недоступно.', 403);
  const a = args || {};
  let visitId = pos(a.visit_id);
  if (visitId == null) {
    const patientId = pos(a.patient_id);
    const raw = typeof a.date === 'string' ? a.date.trim() : '';
    if (patientId == null || !/^\d{4}-\d{2}-\d{2}/.test(raw)) throw new RpcError('Укажите визит или пациента и день.', 400);
    const day = raw.length > 10 ? db.prepare(`SELECT ${localDate('?')} AS d`).get(raw).d : raw.slice(0, 10);
    const v = day ? dayVisitOf(db, patientId, day) : null;
    visitId = v ? Number(v.id) : null;
  }
  const raw = Array.isArray(a.lines) ? a.lines : [];
  if (raw.length > MAX_LINES) throw new RpcError('Слишком много услуг в одной проверке.', 400);
  const canOverride = canRepeatOrder(user);
  if (visitId == null) return { visit_id: null, ordered: [], duplicates: [], can_override: canOverride };

  const exclude = (Array.isArray(a.exclude_ids) ? a.exclude_ids : []).map(pos).filter((x) => x != null);
  // Поблажки двери /api/db: строка записи колл-центра (R7b) и строка CRM уступят новой.
  const spare = (line) => [bookedTwinFor(db, line), autoTwinFor(db, line)].filter(Boolean).map((x) => Number(x.id));
  const lines = raw.map((l) => ({
    visit_id: visitId,
    service_id: pos(l && l.service_id),
    consultation_type_id: pos(l && l.consultation_type_id),
    doctor_id: pos(l && l.doctor_id),
  }));
  const hits = duplicateHits(db, lines, { excludeIds: exclude, spare });
  const ordered = liveOrders(db, visitId)
    .filter((r) => !exclude.includes(Number(r.id)))
    .filter((r) => !spare({ visit_id: visitId, service_id: r.service_id, consultation_type_id: r.service_id == null ? r.consultation_type_id : null, doctor_id: r.doctor_id }).includes(Number(r.id)))
    .map((r) => ({
      id: r.id, service_id: r.service_id, consultation_type_id: r.service_id == null ? r.consultation_type_id : null,
      doctor_id: r.doctor_id, service_type: r.service_type || null, key: keyOfRow(r),
      name: r.service_name || r.consultation_name || '', doctor_name: r.doctor_name || '',
      who: r.creator_name || '', when: r.created_local || '', invoice_number: r.invoice_number || null,
    }));
  const duplicates = hits.map((h) => {
    const e = refusalOf(db, h);
    return { index: h.index, message: e.message, template: e.template, params: e.params, line_id: h.existing ? h.existing.id : null };
  });
  return { visit_id: visitId, ordered, duplicates, can_override: canOverride };
}
```

`server/services/rpc/index.js`: после `import { ensureVisit, discardEmptyVisit } from './visits.js';` добавить
```js
import { visitDupCheck } from './dup-order-check.js';   // DUP_STOP_V1 — что уже назначено в визите дня (только чтение)
```
после строки `  discard_empty_visit:       (db, args, user) => discardEmptyVisit(db, args, user),` добавить
```js
  // DUP_STOP_V1 — экраны записи спрашивают ДО ensure_visit: та же услуга уже назначена в
  // визите дня — отказ без пустого визита и счёта (dup-order-check.js).
  visit_dup_check:           (db, args, user) => visitDupCheck(db, args, user),
```

`server/services/control/gate.js` — в `READ_ONLY_RPCS` после строки `  'cashier_line_performers',` добавить
```js
  // DUP_STOP_V1 — что уже назначено в визите дня (экраны записи до первой записи). Чистое чтение.
  'visit_dup_check',
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test server/services/rpc/dup-stop-rpc.test.js server/services/rpc/visits.test.js server/services/rpc/visits.local-day.test.js server/services/rpc/client-rpc-coverage.test.js server/i18n-server-messages.test.js`
  Expected: PASS (10 в `dup-stop-rpc`; визит дня прежний). `server/services/rpc/index.test.js` (обход всех RPC, 10–15 минут) — в U9.11.

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: visit_dup_check — что уже назначено в визите дня (только чтение)

Экраны записи спрашивают до ensure_visit и calendar_book: назначенное в
визите дня пациента (для «уже назначено» в каталогах), какие строки сметы —
повтор (словами отказа сервера) и может ли сотрудник назначить повтор с
причиной. Визит дня — тем же правилом, что ensure_visit (dayVisitOf).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add server/services/rpc/visits.js server/services/rpc/dup-order-check.js server/services/rpc/index.js server/services/control/gate.js server/services/rpc/dup-stop-rpc.test.js
git commit -F .git/U9_MSG.txt
```

---

### Task U9.7: помощник экранов «уже назначено» (клиент)

**Files:**
- Create: `public/js/admin/views/dup-order-check.js`
- Create: `public/js/admin/__tests__/dup-order-check.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/dup-order-check.test.mjs`:

```js
// DUP_STOP_V1 (2026-11-02) — экранный помощник «уже назначено в этом визите»
// (views/dup-order-check.js) на настоящем RPC visit_dup_check: фальшивый fetch
// пропускает вызовы через реестр RPC и SQLite в памяти, прошедшую миграции.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM ──────────────────────────────────────────────────────────
class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); } removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} querySelector() { return null; } querySelectorAll() { return []; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add(c) { s.className = (s.className + ' ' + c).trim(); }, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };

// ─── настоящая база и реестр RPC за фальшивым fetch ─────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
let DB = null;
let USER = { id: 2, role: 'registrar', extra_roles: [] };
let FAIL = false;
const CALLS = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  if (!u.startsWith('/api/rpc/')) return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
  const name = decodeURIComponent(u.slice('/api/rpc/'.length));
  CALLS.push({ name, body });
  if (FAIL) return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } }) };
  try { return { ok: true, status: 200, json: async () => ({ data: await getRpc(name)(DB, body, USER) }) }; }
  catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message } }) }; }
};

const { loadVisitOrders, orderedMatch, orderedLabel, blockedPickIds, precheckOrders, withRepeatReason } = await import('../views/dup-order-check.js');

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin', 0, '[]');
  u.run(2, 'reg', 'x', 'Регистратура', 'registrar', 0, '[]');
  u.run(10, 'doc', 'x', 'Иванов', 'doctor', 1, '[]');
  u.run(11, 'doc2', 'x', 'Петров', 'doctor', 1, '[]');
  const s = db.prepare('INSERT INTO services (id, name, price, type) VALUES (?,?,?,?)');
  s.run(30, 'Консультация терапевта', 100000, 'consultation');
  s.run(40, 'Анализ крови', 40000, 'lab');
  s.run(60, 'Капельница', 30000, 'procedure');
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  const now = new Date(); now.setHours(9, 0, 0, 0);
  const v = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, 'arrived')").run(now.toISOString()).lastInsertRowid);
  const ln = db.prepare("INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, ?, 1, 0, 0, 'added', 10)");
  ln.run(v, 40, null, null);
  ln.run(v, 30, null, 10);
  ln.run(v, null, 5, 11);
  if (DB) DB.close();
  DB = db;
  const p = (n) => String(n).padStart(2, '0');
  return { v, day: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` };
}

test('DUP_STOP_V1: loadVisitOrders — назначенное визита дня; каталог гасит анализ, консультацию — только у того же врача', async () => {
  const { v, day } = seed();
  const got = await loadVisitOrders({ patientId: 77, day });
  assert.equal(got.visitId, v);
  assert.equal(got.canOverride, false);
  assert.deepEqual(got.ordered.map((o) => o.key).sort(), ['c:5|d:11', 's:30|d:10', 's:40']);
  assert.equal(orderedMatch({ id: 40, type: 'lab' }, got.ordered).blocked, true);
  assert.equal(orderedMatch({ id: 60, type: 'procedure' }, got.ordered), null, 'процедура — повтор можно');
  const cons = orderedMatch({ id: 30, type: 'consultation' }, got.ordered);
  assert.equal(cons.blocked, false, 'консультация без выбранного врача — подсказка, не запрет');
  assert.equal(orderedLabel(cons), 'уже назначено: Иванов');
  assert.equal(orderedMatch({ id: 30, type: 'consultation' }, got.ordered, 10).blocked, true);
  assert.equal(orderedMatch({ id: 'c|11|5', __consult: true, consultation_type_id: 5, __consultDoctorId: 11 }, got.ordered).blocked, true);
  assert.equal(orderedMatch({ id: 'c|10|5', __consult: true, consultation_type_id: 5, __consultDoctorId: 10 }, got.ordered), null);
  assert.deepEqual(blockedPickIds(got.ordered).sort(), [40, 'c|11|5'].sort());
  assert.deepEqual(await loadVisitOrders({ patientId: 77 }), { visitId: null, ordered: [], canOverride: false }, 'нет дня — не спрашиваем');
});

test('DUP_STOP_V1: precheckOrders — повтор: отказ словами сервера, писать нельзя; новое — можно; сервер молчит — решит дверь', async () => {
  const { day } = seed();
  CALLS.length = 0;
  const bad = await precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /^Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, .+, счёта ещё нет\.$/);
  assert.equal(CALLS[0].name, 'visit_dup_check');
  assert.deepEqual(await precheckOrders({ patientId: 77, day, lines: [{ service_id: 60 }, { consultation_type_id: 5, doctor_id: 10 }] }), { ok: true, reason: null });
  assert.deepEqual(await precheckOrders({ patientId: 77, day, lines: [] }), { ok: true, reason: null });
  FAIL = true;
  try { assert.deepEqual(await precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] }), { ok: true, reason: null }); }
  finally { FAIL = false; }
});

test('DUP_STOP_V1: администратор — окно причины; причина уходит в строку, отказ от окна — ничего не пишем', async () => {
  const { day } = seed();
  USER = { id: 1, role: 'admin', extra_roles: [] };
  try {
    const pending = precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] });
    for (let i = 0; i < 20 && !document.body.children.length; i++) await new Promise((r) => setTimeout(r, 5));
    const modal = document.body.children[document.body.children.length - 1];
    const area = walk(modal).find((n) => n.tagName === 'TEXTAREA');
    const ok = walk(modal).find((n) => n.tagName === 'BUTTON' && n.dataset && 'repeatConfirm' in n.dataset);
    area.value = 'ок';
    ok.click();
    assert.ok(TOASTS.some((t) => t.includes('Укажите причину повторного назначения')), 'короткая причина не принята');
    area.value = '  контрольный анализ ';
    ok.click();
    const res = await pending;
    assert.deepEqual(res, { ok: true, reason: 'контрольный анализ' });
    assert.deepEqual(withRepeatReason({ visit_id: 1 }, res.reason), { visit_id: 1, __repeat_reason: 'контрольный анализ' });
    assert.deepEqual(withRepeatReason({ visit_id: 1 }, null), { visit_id: 1 });

    const second = precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] });
    for (let i = 0; i < 20 && !document.body.children.length; i++) await new Promise((r) => setTimeout(r, 5));
    const m2 = document.body.children[document.body.children.length - 1];
    walk(m2).find((n) => n.tagName === 'BUTTON' && /Отмена/.test(walk(n).map((x) => x._t).join(''))).click();
    assert.deepEqual(await second, { ok: false, text: null });
  } finally { USER = { id: 2, role: 'registrar', extra_roles: [] }; }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-order-check.test.mjs`
  Expected: FAIL — `Cannot find module '…/views/dup-order-check.js'`.

- [ ] **Step 3: implement** — создать `public/js/admin/views/dup-order-check.js`:

```js
// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — «УЖЕ НАЗНАЧЕНО В ЭТОМ ВИЗИТЕ»: ЭКРАНЫ СПРАШИВАЮТ ДО ЗАПИСИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Сервер отказывает повтору той же услуги в том же визите (409 duplicate_order —
// routes/db.js, RPC кассы). Экраны записи спрашивают об этом заранее (RPC
// visit_dup_check, только чтение):
//   • каталоги гасят уже назначенное («уже назначено») — loadVisitOrders, orderedMatch;
//   • мастер, калькулятор и быстрая регистрация проверяют смету ДО ensure_visit и
//     calendar_book — precheckOrders: отказ не оставляет ни пустого визита, ни счёта;
//   • администратор и главный врач назначают повтор с причиной (askRepeatReason) —
//     она уходит в строку полем __repeat_reason (withRepeatReason) и в журнал счёта.
// Сервер не ответил — экран не отказывает: последнее слово за дверью записи.
import { supabase } from '../../supabase.js';
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { orderKey, repeatableLine, REPEAT_REASON_KEY, REPEAT_REASON_MIN } from '../../shared/dup-order.js';

const isPosInt = (v) => v != null && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) > 0;
const EMPTY = Object.freeze({ visitId: null, ordered: [], canOverride: false });

function target({ visitId = null, patientId = null, day = null } = {}) {
    if (isPosInt(visitId)) return { visit_id: Number(visitId) };
    if (isPosInt(patientId) && typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)) return { patient_id: Number(patientId), date: day };
    return null;
}

/** Назначенное в визите (id визита или пациент + местный день 'YYYY-MM-DD'). Сбой — пусто. */
export async function loadVisitOrders(where = {}) {
    const args = target(where);
    if (!args) return { ...EMPTY };
    try {
        const { data, error } = await supabase.rpc('visit_dup_check', { ...args, lines: [] });
        if (error || !data) return { ...EMPTY };
        return { visitId: data.visit_id ?? null, ordered: Array.isArray(data.ordered) ? data.ordered : [], canOverride: !!data.can_override };
    } catch (_) { return { ...EMPTY }; }
}

/**
 * Выбор каталога против назначенного. svc — услуга каталога ({id, type}) или консультация
 * врача ({__consult, consultation_type_id, __consultDoctorId}). → null | { blocked, row }:
 * blocked — повтор запрещён; не blocked — та же услуга-консультация у другого врача (можно,
 * но экран называет, у кого она уже есть).
 */
export function orderedMatch(svc, ordered, doctorId = null) {
    if (!svc || !Array.isArray(ordered) || !ordered.length) return null;
    if (svc.__consult) {
        const key = orderKey({ consultationTypeId: svc.consultation_type_id, doctorId: svc.__consultDoctorId ?? doctorId });
        const hit = key && ordered.find((o) => o.key === key);
        return hit ? { blocked: true, row: hit } : null;
    }
    if (repeatableLine({ serviceType: svc.type || null })) return null;
    const rows = ordered.filter((o) => o.service_id != null && Number(o.service_id) === Number(svc.id));
    if (!rows.length) return null;
    if (svc.type !== 'consultation') return { blocked: true, row: rows[0] };
    const mine = isPosInt(doctorId) ? rows.find((o) => Number(o.doctor_id) === Number(doctorId)) : null;
    return mine ? { blocked: true, row: mine } : { blocked: false, row: rows[0] };
}

/** Подпись строки каталога. */
export function orderedLabel(match) {
    if (!match) return '';
    const doc = match.row && match.row.doctor_name;
    return !match.blocked && doc ? trf('уже назначено: {doctor}', { doctor: doc }) : tr('уже назначено');
}

/** id для excludeServiceIds каталога (service-picker-modal): услуги и консультации врача, повтор которых запрещён. */
export function blockedPickIds(ordered) {
    const out = [];
    for (const o of ordered || []) {
        if (o.service_id != null) {
            if (o.service_type !== 'consultation' && o.service_type !== 'procedure') out.push(Number(o.service_id));
        } else if (o.consultation_type_id != null && o.doctor_id != null) {
            out.push(`c|${o.doctor_id}|${o.consultation_type_id}`);
        }
    }
    return [...new Set(out)];
}

/** Строке — причина обхода (сервер снимет поле до записи и положит причину в журнал). */
export function withRepeatReason(row, reason) {
    if (row && typeof reason === 'string' && reason.trim()) row[REPEAT_REASON_KEY] = reason.trim();
    return row;
}

/**
 * Проверка ДО первой записи. lines — [{ service_id?, consultation_type_id?, doctor_id? }].
 * → { ok: true, reason } — писать (reason — причина обхода или null);
 *   { ok: false, text } — не писать; text — отказ словами (null — человек сам отказался).
 * Ничего не показывает: что сказать и где — решает экран.
 */
export async function precheckOrders({ visitId = null, patientId = null, day = null, lines = [], excludeIds = [] } = {}) {
    const want = (lines || []).filter(Boolean);
    const args = target({ visitId, patientId, day });
    if (!want.length || !args) return { ok: true, reason: null };
    let data = null;
    try {
        const res = await supabase.rpc('visit_dup_check', { ...args, lines: want, exclude_ids: (excludeIds || []).filter(isPosInt).map(Number) });
        if (res.error || !res.data) return { ok: true, reason: null };
        data = res.data;
    } catch (_) { return { ok: true, reason: null }; }
    const hits = Array.isArray(data.duplicates) ? data.duplicates : [];
    if (!hits.length) return { ok: true, reason: null };
    const text = hits.map((d) => (d.template ? trf(d.template, d.params || {}) : tr(d.message || ''))).join('\n');
    if (!data.can_override) return { ok: false, text };
    const reason = await askRepeatReason(text);
    return reason ? { ok: true, reason } : { ok: false, text: null };
}

/**
 * Обход с причиной (администратор, главный врач): тот же вид окна, что у экстренной записи
 * (service-picker-modal.js askEmergencyReason). Promise<string|null>.
 */
export function askRepeatReason(conflictText) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'modal', style: { zIndex: '190' } });
        let done = false;
        const finish = (v) => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', onEsc); resolve(v); };
        const onEsc = (e) => { if (e.key === 'Escape') finish(null); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => finish(null) }));
        const reason = h('textarea', { class: 'rcal-reason', rows: '3', dataset: { repeatReason: '' },
            placeholder: tr('Например: контрольный анализ по просьбе врача') });
        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Warning', { size: 16 }), ' ', tr('Повторное назначение')),
                h('button', { class: 'modal-close', type: 'button', onclick: () => finish(null) }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { class: 'rcal-conflict', style: { whiteSpace: 'pre-line' } }, conflictText),
                h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '12px 0 6px' } },
                    tr('Повтор услуги в том же визите назначают только с причиной — она останется в журнале счёта.')),
                reason),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-outline', type: 'button', onclick: () => finish(null) }, tr('Отмена')),
                h('button', {
                    class: 'btn btn-primary', type: 'button', dataset: { repeatConfirm: '' }, onclick: () => {
                        const text = (reason.value || '').trim();
                        if (text.length < REPEAT_REASON_MIN) { toast(tr('Укажите причину повторного назначения.'), 'fail'); return; }
                        finish(text);
                    },
                }, tr('Назначить повторно')))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
        reason.focus();
    });
}
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-order-check.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
  Expected: PASS.

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: помощник экранов «уже назначено в этом визите»

Назначенное в визите дня (каталоги гасят такие услуги), проверка сметы до
первой записи словами сервера, окно причины для администратора и главного
врача и поле причины в строке. Сервер не ответил — экран не отказывает:
последнее слово за дверью записи.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/dup-order-check.js public/js/admin/__tests__/dup-order-check.test.mjs
git commit -F .git/U9_MSG.txt
```

---

### Task U9.8: мастер визита — каталог гасит, смета не берёт, проверка до `ensure_visit`

Мастер — он же «Направить на услуги» из кабинета врача (DOCTOR_REFER_WIZARD_V1), то есть путь визита 411.

**Files:**
- Modify: `public/js/admin/views/visit-wizard.js`
- Create: `public/js/admin/__tests__/dup-stop-wizard.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/dup-stop-wizard.test.mjs`:

```js
// DUP_STOP_V1 (2026-11-02) — мастер визита и повтор услуги в визите дня.
//   • каталог гасит уже назначенное («уже назначено»), смета его не берёт;
//   • услуга, назначенная в визите, пока смета собиралась (второй регистратор, врач), —
//     отказ ДО ensure_visit: ни визита, ни строки, ни счёта;
//   • администратор называет причину — строка уходит с __repeat_reason, повтор записан.
// Стенд — тот же, что у server/routes/crm-one-way-r2-m2-wizard.test.js (фальшивый DOM,
// настоящая SQLite и реестр RPC за фальшивым fetch). Дверь /api/db здесь — compile() с тем
// же снятием __repeat_reason, что у routes/db.js; отказ сервера проверяют
// server/routes/dup-stop-db.test.js и server/services/rpc/dup-stop-rpc.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { takeRepeatReason } = await import('../../../../server/services/domain/dup-order.js');
const { forgetSlots } = await import('../views/service-picker-modal.js');

let USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
const RPC = [];
const WRITES = [];   // тела вставок /api/db ДО снятия __repeat_reason

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
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params, template: e.template } }) }; }
  }
  if (u === '/api/db') {
    if (body.op === 'insert') WRITES.push(JSON.parse(JSON.stringify(body)));
    takeRepeatReason(body);   // как routes/db.js: причина повтора — не колонка
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
        const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
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

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (2,'boss','x','Админ','admin',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (23,'Анализ мочи',30000,'lab',1,0)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
}
/** Визит пациента сегодня («Пришёл») со строкой анализа крови, выставленной врачом. */
function orderedToday() {
  const now = new Date(); now.setHours(0, 30, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (3, 7, ?, 'arrived', 7)").run(now.toISOString()).lastInsertRowid);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 22, 1, 40000, 40000, 'queued', 7)").run(vid);
  return vid;
}

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (svc) => DB.prepare("SELECT COUNT(*) n FROM visit_services WHERE service_id = ? AND status <> 'cancelled'").get(svc).n;
const rowOf = (ov, id) => walk(ov).find((n) => n.dataset && n.dataset.svcRow === String(id));
const addBtn = (row) => walk(row).find((n) => n.tagName === 'BUTTON' && /Добавить/.test(textOf(n)));
async function open() {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0; WRITES.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, {});
  await flush(30);
  return document.body.children.find(isWizard);
}
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = document.body.children.find(isWizard);
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON')
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit') || TOASTS.some((t) => /уже назначена в этом визите/.test(t))) break;
  }
  await wait(80); await flush(30);
}

test('DUP_STOP_V1: мастер — анализ, уже назначенный в визите дня, погашен «уже назначено», в смету не берётся', async () => {
  seed();
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  orderedToday();
  const ov = await open();
  assert.ok(ov, 'мастер не открылся');
  assert.ok(RPC.some((c) => c.name === 'visit_dup_check'), 'мастер не спросил, что уже назначено');
  const row = rowOf(ov, 22);
  assert.ok(row, 'строки каталога «Анализ крови» нет');
  assert.match(textOf(row), /уже назначено/);
  assert.ok('disabled' in addBtn(row).attrs, '«Добавить» у назначенной услуги нажимается');
  assert.ok(!/уже назначено/.test(textOf(rowOf(ov, 23))), 'новая услуга погашена');
});

test('DUP_STOP_V1: мастер — услугу назначили, пока смета собиралась: отказ до ensure_visit, ничего не записано', async () => {
  seed();
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  const ov = await open();
  addBtn(rowOf(ov, 22)).click();
  await flush(20);
  orderedToday();   // второй регистратор успел первым
  const visitsBefore = DB.prepare('SELECT COUNT(*) n FROM visits').get().n;
  await pressUntilCreate();
  assert.ok(TOASTS.some((t) => /^Эта услуга уже назначена в этом визите: «Анализ крови» — Петров Пётр/.test(t)), 'нет отказа словами сервера: ' + JSON.stringify(TOASTS));
  assert.equal(RPC.some((c) => c.name === 'ensure_visit'), false, 'визит дня заведён до отказа');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits').get().n, visitsBefore, 'появился визит');
  assert.equal(lines(22), 1, 'вторая строка анализа');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'счёт выставлен');
});

test('DUP_STOP_V1: мастер — администратор назначает повтор с причиной: строка уходит с __repeat_reason', async () => {
  seed();
  USER = { id: 2, role: 'admin', extra_roles: [] };
  try {
    orderedToday();
    const ov = await open();
    const row = rowOf(ov, 22);
    assert.match(textOf(row), /уже назначено/, 'администратору тоже видно, что услуга уже есть');
    assert.ok(!('disabled' in addBtn(row).attrs), 'администратору «Добавить» доступно');
    addBtn(row).click();
    await flush(20);
    const run = pressUntilCreate();
    let modal = null;
    for (let i = 0; i < 100 && !modal; i++) {
      await wait(20);
      modal = document.body.children.find((n) => walk(n).some((x) => x.dataset && 'repeatConfirm' in x.dataset));
    }
    assert.ok(modal, 'окно причины не открылось: ' + JSON.stringify(TOASTS));
    walk(modal).find((n) => n.tagName === 'TEXTAREA').value = 'контрольный анализ';
    walk(modal).find((n) => n.dataset && 'repeatConfirm' in n.dataset).click();
    await run;
    await wait(100); await flush(30);
    const ins = WRITES.filter((w) => w.table === 'visit_services');
    assert.equal(ins.length, 1, JSON.stringify(TOASTS));
    assert.equal(ins[0].values.__repeat_reason, 'контрольный анализ');
    assert.equal(lines(22), 2);
  } finally { USER = { id: 1, role: 'registrar', extra_roles: [] }; }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-wizard.test.mjs`
  Expected: FAIL 3 — «мастер не спросил, что уже назначено»; «нет отказа словами сервера: ["Услуги добавлены. …"]» (стенд пишет строки через `compile()` мимо `routes/db.js`, поэтому повтор ложится — экран обязан поймать его сам); «окно причины не открылось».

- [ ] **Step 3: implement** — `public/js/admin/views/visit-wizard.js`:

(а) Импорт — после строки `import { surgeryBedRefusal } from './visit-line-row.js';   // LIVE_AUDIT_FIX_V1 (A5) — хирургия без койки: отказ до визита` добавить
```js
import { loadVisitOrders, orderedMatch, orderedLabel, precheckOrders, withRepeatReason } from './dup-order-check.js';   // DUP_STOP_V1 — уже назначено в визите дня
```

(б) Состояние `wiz` — после строки `        bookedTodaySvc: null, // CRM_LINK_ALL_V1 (ред. 2) — услуги, уже стоящие в визите записи на сегодня` добавить
```js
        ordered: [],         // DUP_STOP_V1 — уже назначенное в визите дня (visit_dup_check): каталог гасит, смета не берёт
        canRepeat: false,    // DUP_STOP_V1 — администратор и главный врач назначают повтор с причиной
```

(в) Загрузка — строку `    await prefillFromBooking();   // CRM_LINK_ALL_V1 (R7a) — сначала то, что уже в визите записи` предварить строкой
```js
    await loadOrdered();          // DUP_STOP_V1 — до подстановок: они идут через addToCart
```
и перед `    async function prefillFromBooking() {` вставить
```js
    // DUP_STOP_V1 — ЧТО УЖЕ НАЗНАЧЕНО В ВИЗИТЕ ДНЯ. Сервер отказывает повтору той же услуги
    // в том же визите (409 duplicate_order). Мастер знает это заранее: каталог гасит такие
    // услуги («уже назначено»), смета их не берёт. День — день мастера; строки других дней
    // проверяет createVisit перед первой записью (precheckOrders).
    async function loadOrdered() {
        const day = String(wiz.when || '').slice(0, 10);
        if (!patient || !patient.id || !day) return;
        const r = await loadVisitOrders({ patientId: patient.id, day });
        wiz.ordered = r.ordered;
        wiz.canRepeat = r.canOverride;
        if (wiz.ordered.length) paint();   // каталог уже нарисован — погасить назначенное
    }
    /** DUP_STOP_V1 — назначенное, кроме строк «из записи», которые регистратор убрал (снимутся до записи). */
    function orderedNow() { return wiz.ordered.filter(o => !wiz.dropBooked.includes(o.id)); }

```
(`orderedNow` — объявление функции, не `const`: каталог рисуется раньше, чем исполнение дойдёт до этого места.)

(г) `addToCart` — после блока
```js
            item.qty += 1;
            repaintRail();
            return;
        }
```
добавить
```js
        // DUP_STOP_V1 — услуга уже назначена в визите дня: остальным смета её не берёт;
        // администратору и главному врачу — можно, причину спросит createVisit.
        const already = orderedMatch(svc, orderedNow());
        if (already && already.blocked && !wiz.canRepeat) {
            toast(trf('«{name}» уже назначена в этом визите — повторно её не назначают.', { name: svc.name }), 'info');
            return;
        }
```
(U5 меняет хвост `addToCart` — вставка стоит до `const d0 = new Date()…`, где строка сметы только создаётся.)

(д) Каталог (`paintList`) — строки
```js
                const inCart = wiz.cart.find(c => c.svc.id === s.id);
                const headRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
```
заменить на
```js
                const inCart = wiz.cart.find(c => c.svc.id === s.id);
                const onVisit = inCart ? null : orderedMatch(s, orderedNow());   // DUP_STOP_V1
                const locked = !!(onVisit && onVisit.blocked && !wiz.canRepeat);   // DUP_STOP_V1
                const headRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', opacity: locked ? '0.55' : '1' } },
```
в той же строке-заголовке после бейджа «из заявки» (`… 'из заявки')\n                                : null),`) — заменить `: null),` на
```js
                                : null,
                            // DUP_STOP_V1 — уже назначено в визите дня (у консультации — у кого)
                            onVisit
                                ? h('span', { dataset: { orderedTag: '' }, style: { marginLeft: '8px', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-500)' } }, ' — ', orderedLabel(onVisit))
                                : null),
```
и у кнопки «Добавить» строки
```js
                            class: 'btn btn-primary btn-sm', type: 'button',
                            style: { borderRadius: '999px', minWidth: '96px' },
                            onclick: () => {
                                addToCart(s);
```
заменить на
```js
                            class: 'btn btn-primary btn-sm', type: 'button',
                            style: { borderRadius: '999px', minWidth: '96px' },
                            disabled: locked,   // DUP_STOP_V1 — уже назначено в этом визите
                            title: locked ? tr('уже назначено') : undefined,
                            onclick: () => {
                                if (locked) return;   // DUP_STOP_V1
                                addToCart(s);
```

(е) `createVisit` — после строки `            if (noBed) { toast(noBed, 'fail'); wiz.creating = false; repaintRail(); return; }` (до снятия строк записи `wiz.dropBooked` и до `gateDaySlots`) вставить
```js
            // DUP_STOP_V1 — ПОВТОР ТОЙ ЖЕ УСЛУГИ В ВИЗИТЕ ДНЯ — ОТКАЗ ДО ПЕРВОЙ ЗАПИСИ. Сервер
            // откажет строке (409 duplicate_order), но визит дня и строки до неё уже были бы
            // записаны. Спрашиваем по каждому дню сметы; строки «из записи» не вставляются, а
            // убранные строки записи снимутся до записи (excludeIds). Администратор и главный
            // врач называют причину — она уходит в строки дня (__repeat_reason) и в журнал счёта.
            const repeatByDay = new Map();
            for (const [day, lines] of byDay) {
                const want = lines.filter(c => !c.booked).map(c => ({
                    service_id: c.svc.id,
                    doctor_id: Number(c.doctorId || (c.svc.requires_doctor ? wiz.doctorId : null)) || null,
                }));
                const pre = await precheckOrders({ patientId: patient.id, day, lines: want, excludeIds: wiz.dropBooked });
                if (!pre.ok) {
                    if (pre.text) toast(pre.text, 'fail');
                    wiz.creating = false; repaintRail();
                    return;
                }
                if (pre.reason) repeatByDay.set(day, pre.reason);
            }
```
и в цикле строк дня строки
```js
                    if (uid != null) row.created_by = uid;
                    const res = await supabase.from('visit_services').insert(row).select().single();
```
заменить на
```js
                    if (uid != null) row.created_by = uid;
                    withRepeatReason(row, repeatByDay.get(day));   // DUP_STOP_V1 — обход с причиной (сервер снимет поле)
                    const res = await supabase.from('visit_services').insert(row).select().single();
```

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-wizard.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/wizard-templates.test.mjs public/js/admin/__tests__/booking-doors.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs server/routes/crm-one-way-r2-m2-wizard.test.js server/routes/referral-bill-flow.test.js server/routes/crm-schedule.test.js`
  Expected: PASS (3 новых; прежние мастера не изменились — их визиты без повторов).

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: мастер визита — «уже назначено», проверка до записи визита

Каталог мастера гасит услуги, уже назначенные в визите дня («уже
назначено»; у консультации — у какого врача), смета их не берёт. Перед
первой записью мастер спрашивает сервер по каждому дню сметы: повтор —
отказ словами сервера без визита, строк и счёта. Администратор и главный
врач назначают повтор с причиной. То же — в «Направить на услуги» врача.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/visit-wizard.js public/js/admin/__tests__/dup-stop-wizard.test.mjs
git commit -F .git/U9_MSG.txt
```

---

### Task U9.9: калькулятор, «Услуги приёма» врача, быстрая регистрация

**Files:**
- Modify: `public/js/admin/views/service-picker-modal.js`
- Modify: `public/js/admin/views/service-workspace.js`
- Modify: `public/js/admin/views/walk-in-booking.js`
- Create: `public/js/admin/__tests__/dup-stop-doors.test.mjs`
- Modify: `public/js/admin/__tests__/booked-rows-live.test.mjs` (+1 тест в конец)
- Modify: `public/js/admin/__tests__/fast-registration.test.mjs`, `public/js/admin/__tests__/walk-in-booking.test.mjs` (ожидания — Step 4)

- [ ] **Step 1: failing tests.**

Создать `public/js/admin/__tests__/dup-stop-doors.test.mjs`:
```js
// DUP_STOP_V1 (2026-11-02) — калькулятор услуг и «Услуги приёма» кабинета врача спрашивают
// «уже назначено» ДО записи. Исходником, как соседние пины (service-workspace-add.test.mjs):
// у окон нет DOM-стенда; поведение помощника — dup-order-check.test.mjs, мастер —
// dup-stop-wizard.test.mjs, быстрая регистрация — booked-rows-live.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', 'views', f), 'utf8');
const code = (s) => s.replace(/\/\/[^\n]*/g, '');

test('DUP_STOP_V1: калькулятор — проверка повтора до calendar_book; строки уходят с причиной обхода', () => {
  const src = code(read('service-picker-modal.js'));
  const pre = src.indexOf('await precheckOrders(');
  const book = src.indexOf('await calendarBookOrAsk({');
  assert.ok(pre > 0, 'калькулятор не спрашивает «уже назначено»');
  assert.ok(book > pre, 'проверка повтора — после записи визита: отказ оставит визит');
  assert.match(src.slice(pre, book), /if \(!pre\.ok\)[\s\S]*return;/, 'отказ не останавливает запись');
  assert.match(src, /insertRow\('visit_services', withRepeatReason\(\{/, 'строка без причины обхода');
  assert.match(src, /\}, pre\.reason\)\);/);
});

test('DUP_STOP_V1: «Услуги приёма» — каталог гасит и назначенное в визите другими', () => {
  const src = read('service-workspace.js');
  const card = src.match(/function servicesCard\(ctx\)[\s\S]*?\n\}/);
  assert.ok(card, 'карточка «Услуги приёма» не найдена');
  const c = code(card[0]);
  assert.match(c, /await loadVisitOrders\(\{ visitId: ctx\.visitId \}\)/, 'каталог не спрашивает, что уже назначено в визите');
  assert.match(c, /excludeServiceIds:[^\n]*serviceId[^\n]*blockedPickIds\(ordered\)/, 'каталог гасит только пункты карточки');
});

test('DUP_STOP_V1: быстрая регистрация — проверка повтора до ensure_visit', () => {
  const src = code(read('walk-in-booking.js'));
  const fn = src.slice(src.indexOf('export async function registerWalkIn('));
  const pre = fn.indexOf('await precheckOrders(');
  const ev = fn.indexOf("supabase.rpc('ensure_visit'");
  assert.ok(pre > 0 && ev > pre, 'проверка повтора — после визита дня');
  assert.match(fn, /withRepeatReason\(row, pre\.reason\)/, 'строка без причины обхода');
});
```

Дописать в конец `public/js/admin/__tests__/booked-rows-live.test.mjs`:
```js

// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — БЫСТРАЯ РЕГИСТРАЦИЯ: УСЛУГА УЖЕ НАЗНАЧЕНА В ВИЗИТЕ ДНЯ — ОТКАЗ ДО
// ВИЗИТА. Пациент сегодня уже пришёл, врач назначил анализ крови (выставлен, в очереди). Стойка
// оформляет тот же анализ ещё раз — registerWalkIn отказывает словами сервера (visit_dup_check) ДО
// ensure_visit: ни строки, ни счёта. На настоящем сервере дверь /api/db отказала бы и сама (409).
// ═══════════════════════════════════════════════════════════════════════════
test('DUP_STOP_V1 (настоящий сервер): registerWalkIn — анализ уже назначен в визите дня: отказ до визита, в базе ничего не изменилось', async () => {
  const t = await live(() => {});
  try {
    const now = new Date(); now.setHours(0, 30, 0, 0);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'arrived', 10)").run(now.toISOString()).lastInsertRowid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 40, 1, 40000, 40000, 'queued', 10)").run(vid);
    const before = moneySnap(t, vid);
    sent.length = 0;
    const lab = { id: 40, name: 'Анализ крови', price: 40000, requires_doctor: 0, type: 'lab', tax_rate: 0 };
    await assert.rejects(
      registerWalkIn({ patientId: 77, actorRole: 'registrar', createdBy: 2, lines: [{ service: lab }] }),
      /^Error: Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, .+, счёта ещё нет\.$/);
    assert.deepEqual(writesOf().map((s) => s.name || s.table), ['visit_dup_check'], 'до отказа ушла запись');
    assert.equal(moneySnap(t, vid), before, 'база изменилась');
  } finally { t.close(); }
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-doors.test.mjs public/js/admin/__tests__/booked-rows-live.test.mjs`
  Expected: FAIL 4 — три пина («не спрашивает «уже назначено»» / «проверка повтора — после визита дня») и живой тест: registerWalkIn доходит до `ensure_visit`, отказ приходит от двери `/api/db` (U9.4) уже после визита — текст `Услуга «Анализ крови»: Эта услуга уже назначена…` не совпадает с ожидаемым началом `Error: Эта услуга…`.

- [ ] **Step 3: implement.**

`public/js/admin/views/service-picker-modal.js`:
- импорт — перед строкой `import { surgeryBedRefusal, linePerformer } from './visit-line-row.js';` добавить
  ```js
  import { precheckOrders, withRepeatReason } from './dup-order-check.js';   // DUP_STOP_V1 — повтор услуги в визите дня — отказ до записи
  ```
- в `wizSave` после строк
  ```js
              const noBed = await surgeryBedRefusal(p.id, state.added.map(a => a.service));
              if (noBed) { toast(noBed, 'fail'); if (btn && btn.isConnected) btn.disabled = false; return; }
  ```
  (одно вхождение, ~:3063 в `wizSave`, сразу перед `const booked = await calendarBookOrAsk({`) вставить
  ```js
              // DUP_STOP_V1 — та же услуга уже назначена в визите дня пациента: отказ ДО записи
              // (calendar_book найдёт или заведёт визит дня, и строки ниже легли бы в него).
              // Администратор и главный врач называют причину — она уходит в строки.
              const pre = await precheckOrders({
                  patientId: p.id, day: localDayOf(visitDate),
                  lines: state.added.map((a) => (a.service.__consult
                      ? { consultation_type_id: a.service.consultation_type_id || null, doctor_id: a.doctor?.id || a.service.__consultDoctorId || null }
                      : { service_id: a.service.id, doctor_id: a.doctor?.id || null })),
              });
              if (!pre.ok) {
                  if (pre.text) toast(pre.text, 'fail');
                  if (btn && btn.isConnected) btn.disabled = false;
                  return;
              }
  ```
- строку `                const { data: vs, error: vsErr } = await insertRow('visit_services', {` заменить на `                const { data: vs, error: vsErr } = await insertRow('visit_services', withRepeatReason({   // DUP_STOP_V1 — причина обхода (сервер снимет поле)`, а закрывающую этот объект строку
  ```js
                      package_id:   (!isConsult && a.package && packageValidOn(a.package, localDayOf(visitDate))) ? a.package.id : null,
                  });
  ```
  — на
  ```js
                      package_id:   (!isConsult && a.package && packageValidOn(a.package, localDayOf(visitDate))) ? a.package.id : null,
                  }, pre.reason));
  ```
  (Если U5 переименует `visitDate`/`cartVisitDateIso` — взять тот день, на который калькулятор записывает визит.)

`public/js/admin/views/service-workspace.js`:
- импорт — после `import { openServicePickerModal } from './service-picker-modal.js?v=ownrep4';` добавить
  ```js
  import { loadVisitOrders, blockedPickIds } from './dup-order-check.js';   // DUP_STOP_V1 — назначенное в визите приёма
  ```
- в `servicesCard` строку
  ```js
              patientTabCanEdit('services') && h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openServicePickerModal({
  ```
  заменить на
  ```js
              patientTabCanEdit('services') && h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
                  // DUP_STOP_V1 — каталог гасит и назначенное в этом визите другими (регистратура,
                  // касса, другой врач), а не только пункты этой карточки. Повтор отказывает сервер.
                  const { ordered } = await loadVisitOrders({ visitId: ctx.visitId });
                  openServicePickerModal({
  ```
  и строки
  ```js
                  excludeServiceIds: (wsState.payload?.services || []).map(s => s.serviceId).filter(Boolean),
                  onPick: (p) => addOwnService(ctx, p.service, p.doctor, p.package),   // SERVICES_PACKAGES_V1 — пакет из каталога не теряется
              }) }, Icon('Plus', { size: 12 }), ' Добавить'),
  ```
  — на
  ```js
                  excludeServiceIds: [...(wsState.payload?.services || []).map(s => s.serviceId).filter(Boolean), ...blockedPickIds(ordered)],   // DUP_STOP_V1 — и назначенное в визите
                  onPick: (p) => addOwnService(ctx, p.service, p.doctor, p.package),   // SERVICES_PACKAGES_V1 — пакет из каталога не теряется
                  });
              } }, Icon('Plus', { size: 12 }), ' Добавить'),
  ```
  (Отказ сервера по строке `addOwnService` бросает дальше — каталог (`attachCartToVisit`) уже называет причину.)

`public/js/admin/views/walk-in-booking.js`:
- импорт — перед строкой `import { lineIdentity, isConsultPick, consultDoctorId, surgeryBedRefusal } from './visit-line-row.js';` добавить
  ```js
  import { precheckOrders, withRepeatReason } from './dup-order-check.js';   // DUP_STOP_V1 — повтор услуги в визите дня — отказ до визита
  ```
- в `registerWalkIn` перед комментарием `    // CRM_LINK_ALL_V1 (R7a) — строки записи, которые регистратор убрал, снимаются` вставить
  ```js
      // DUP_STOP_V1 — та же услуга уже назначена в визите дня пациента (сегодня) — отказ ДО
      // визита: иначе ensure_visit и строки до повтора уже были бы записаны. Строки «из записи»
      // не вставляются, убранные строки записи снимутся ниже. Причина обхода (администратор,
      // главный врач) — в строки.
      const nowD = new Date(now());
      const pad2 = (n) => String(n).padStart(2, '0');
      const pre = await precheckOrders({
          patientId: pid, day: `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())}`,
          lines: items.filter((l) => !isPosInt(l.bookedVsId)).map((l) => {
              const ident = lineIdentity(l.service) || {};
              return { service_id: ident.service_id ?? null, consultation_type_id: ident.consultation_type_id ?? null, doctor_id: lineDoctorOf(l) };
          }),
          excludeIds: (Array.isArray(dropVsIds) ? dropVsIds : []).filter(isPosInt).map(Number),
      });
      if (!pre.ok) throw new Error(pre.text || tr('Повторное назначение отменено — ничего не записано.'));

  ```
- строки
  ```js
          if (isPosInt(createdBy)) row.created_by = Number(createdBy);
          const res = await supabase.from('visit_services').insert(row).select().single();
  ```
  заменить на
  ```js
          if (isPosInt(createdBy)) row.created_by = Number(createdBy);
          withRepeatReason(row, pre.reason);   // DUP_STOP_V1 — обход с причиной (сервер снимет поле)
          const res = await supabase.from('visit_services').insert(row).select().single();
  ```

- [ ] **Step 4: существующие тесты.** Run: `node --experimental-vm-modules --test public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs`
  Expected: FAIL 2:
  - `fast-registration.test.mjs` «сохранение: пациент → визит → строки с врачом → счёт → очередь…»: цепочка записей теперь `… rpc:crm_link_new_patient → rpc:visit_dup_check → rpc:ensure_visit …`. Смысл поменялся (новый шаг ДО визита — ровно то, что требует решение), правка ожидания: в списке `assert.deepStrictEqual(chain, [` после `'rpc:crm_link_new_patient',` добавить строку
    ```js
        'rpc:visit_dup_check',   // DUP_STOP_V1 — «уже назначено в визите дня» спрашивается ДО визита
    ```
  - `walk-in-booking.test.mjs` «ТОТ ЖЕ ДЕНЬ, ТА ЖЕ УСЛУГА: строка, уже лежащая на сегодняшнем визите, не делает новую «повторной»» — `Error: Эта услуга уже назначена в этом визите: «Приём кардиолога» — —, …` (приспособление: та же консультация без врача дважды). Проверка — про тариф дня, поэтому первая строка — приём у врача 7 (у другого врача — можно). Строку
    ```js
      DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (91, ?, 1, 200000, 200000, 'added')").run(TIERED);
    ```
    заменить на
    ```js
      // DUP_STOP_V1 — первая строка — приём у врача 7: тот же приём без врача — другое назначение
      // (у того же врача это был бы повтор в визите — 409, проверка тарифа здесь о другом).
      DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (91, ?, ?, 1, 200000, 200000, 'added')").run(TIERED, DOCTOR);
    ```

- [ ] **Step 5: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-doors.test.mjs public/js/admin/__tests__/booked-rows-live.test.mjs public/js/admin/__tests__/service-workspace-add.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/service-picker-attach.test.mjs public/js/admin/__tests__/service-picker-crm.test.mjs public/js/admin/__tests__/picker-invoice.test.mjs public/js/admin/__tests__/picker-attach-estimate.test.mjs public/js/admin/__tests__/picker-attach-package-day.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs server/routes/crm-one-way-r2-m2-fastreg.test.js`
  Expected: PASS.

- [ ] **Step 6: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: калькулятор, «Услуги приёма» врача и быстрая регистрация

Калькулятор и быстрая регистрация проверяют смету до записи визита: повтор
услуги в визите дня — отказ словами сервера без визита, строк и счёта;
администратор и главный врач — с причиной. Каталог «Услуги приёма» в
кабинете врача гасит и то, что в этом визите уже назначили другие.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/service-picker-modal.js public/js/admin/views/service-workspace.js public/js/admin/views/walk-in-booking.js public/js/admin/__tests__/dup-stop-doors.test.mjs public/js/admin/__tests__/booked-rows-live.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs
git commit -F .git/U9_MSG.txt
```

---

### Task U9.10: касса — окно выбора услуги отмечает «уже назначено» (раздел К1 спецификации)

Спецификация, раздел К1 (добавлен 5fa59531): «Замена услуги (обычная и «Вернуть эту услугу и выставить новую») отказывает, если новая услуга уже открыта в этом визите; окно выбора отмечает такие услуги «уже назначено». Возвращённая строка больше не мешает назначить ту же услугу снова». Отказ сервера — U9.5; здесь — окно выбора услуги кассы (`cashier-line-fix.js` `pickService`), общее для пяти мест: «Заменить услугу» в окне «Платежи» (`openRefundSwap`), «Исправить услуги» — неоплаченный счёт, оплаченный счёт, «+ Добавить услугу» (`openLineFix`) и «Ждут счёта» (`openRebill`). Обхода с причиной в окнах кассы нет (поля причины там нет): администратор назначает повтор мастером или окном визита.

**Files:**
- Modify: `public/js/admin/views/cashier-line-fix.js`
- Create: `public/js/admin/__tests__/dup-stop-cashier.test.mjs`

- [ ] **Step 1: failing test** — создать `public/js/admin/__tests__/dup-stop-cashier.test.mjs`:

```js
// DUP_STOP_V1 (2026-11-02, раздел К1 спецификации) — касса: окно выбора услуги в «Заменить
// услугу», «Вернуть эту услугу и выставить новую», «Исправить услуги» и «Ждут счёта»
// (cashier-line-fix.js pickService) гасит услуги, уже назначенные в этом визите («уже
// назначено»): замена или добавление на них — повтор, сервер откажет. Строка, которую
// меняют, не мешает. Настоящий RPC visit_dup_check и настоящий compile() за фальшивым fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); } removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} querySelector() { return null; } querySelectorAll() { return []; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add(c) { s.className = (s.className + ' ' + c).trim(); }, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, easymed: { state: { user: { id: 9, role: 'cashier' } } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join('');

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const USER = { id: 9, role: 'cashier', extra_roles: [] };
let DB = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  try {
    if (u.startsWith('/api/rpc/')) return ok(await getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)))(DB, body, USER));
    if (u === '/api/db') { const { sql, params } = compile(body, USER); return ok(DB.prepare(sql).all(...params)); }
  } catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message } }) }; }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
};

const { pickService } = await import('../views/cashier-line-fix.js');

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (9, 'cash', 'x', 'Кассир', 'cashier', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (10, 'doc', 'x', 'Иванов', 'doctor', 1)").run();
  const s = db.prepare('INSERT INTO services (id, name, price, type, active) VALUES (?,?,?,?,1)');
  s.run(40, 'Анализ крови', 40000, 'lab');
  s.run(50, 'УЗИ', 80000, 'imaging');
  s.run(60, 'Капельница', 30000, 'procedure');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, '2026-11-02T05:00:00Z', 'arrived')").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 1, 0, 0, 'added', 10)");
  const lab = Number(ins.run(vid, 40).lastInsertRowid);
  const usg = Number(ins.run(vid, 50).lastInsertRowid);
  ins.run(vid, 60);
  DB = db;
  return { vid, lab, usg };
}
async function openPicker(args) {
  document.body.children.length = 0;
  const pending = pickService('Заменить услугу', args);
  for (let i = 0; i < 50 && !walk(document.body).some((n) => n.attrs && n.attrs['data-service-id']); i++) await new Promise((r) => setTimeout(r, 10));
  const btn = (id) => walk(document.body).find((n) => n.attrs && n.attrs['data-service-id'] === String(id));
  return { pending, btn };
}

test('DUP_STOP_V1 (К1): окно выбора услуги кассы гасит назначенное в визите; заменяемая строка и процедура — не мешают', async () => {
  const { vid, usg } = seed();
  const { pending, btn } = await openPicker({ visitId: vid, exceptLineId: usg });
  assert.ok('disabled' in btn(40).attrs, 'анализ уже в визите — его можно выбрать');
  assert.match(textOf(btn(40)), /уже назначено/);
  assert.ok(!('disabled' in btn(50).attrs), 'заменяемую строку (УЗИ) нельзя заменить на ту же услугу у другого врача');
  assert.ok(!('disabled' in btn(60).attrs), 'процедура погашена');
  btn(40).click();
  btn(60).click();
  assert.equal((await pending).id, 60, 'погашенная услуга выбрана');
});

test('DUP_STOP_V1 (К1): без визита окно выбора ничего не гасит (как прежде)', async () => {
  seed();
  const { pending, btn } = await openPicker({});
  assert.ok(!('disabled' in btn(40).attrs));
  btn(40).click();
  assert.equal((await pending).id, 40);
});

test('DUP_STOP_V1 (К1): все окна кассы передают визит в окно выбора услуги', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'cashier-line-fix.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const callsOf = [...src.matchAll(/pickService\(tr\('[^']+'\)([^)]*\))/g)].map((m) => m[1]);
  assert.equal(callsOf.length, 5, 'окон выбора услуги в кассе не пять: ' + callsOf.length);
  for (const c of callsOf) assert.match(c, /visitId:/, 'окно выбора без визита: ' + c);
});
```

- [ ] **Step 2: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-cashier.test.mjs`
  Expected: FAIL 2 — «анализ уже в визите — его можно выбрать» и «окно выбора без визита» (второй тест зелёный и до правки).

- [ ] **Step 3: implement** — `public/js/admin/views/cashier-line-fix.js`:

(а) Импорт — после строки `import { supabase } from '../../supabase.js';` добавить
```js
import { loadVisitOrders, orderedMatch, orderedLabel } from './dup-order-check.js';   // DUP_STOP_V1 — «уже назначено» в окне выбора услуги
```

(б) `pickService` — заголовок
```js
/**
 * Выбор услуги: поиск по названию. Промис: услуга или null (закрыли окно).
 */
export function pickService(title) {
```
заменить на
```js
/**
 * Выбор услуги: поиск по названию. Промис: услуга или null (закрыли окно).
 * DUP_STOP_V1 — `visitId`: услуги, уже назначенные в этом визите, погашены («уже
 * назначено») — замена или добавление на них — повтор, сервер откажет (409). Строка,
 * которую меняют (`exceptLineId`), не мешает: ту же услугу у другого врача выбрать можно.
 */
export function pickService(title, { visitId = null, exceptLineId = null } = {}) {
```
строку `        let all = [];` (внутри `pickService`, перед `const paint = () => {`) — на
```js
        let all = [];
        let ordered = [];   // DUP_STOP_V1 — назначенное в визите
```
цикл строк и загрузку
```js
            for (const svc of rows) {
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-service-id': String(svc.id),
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left' },
                    onclick: () => { finish(svc); s.overlay.remove(); },
                }, h('span', null, svc.name || '—'), h('span', { class: 'num muted' }, fmtSum(svc.price), ' ', tr('сум'))));
            }
        };
        search.addEventListener('input', paint);
        loadServices().then((rows) => { all = rows; paint(); })
```
— на
```js
            for (const svc of rows) {
                const onVisit = orderedMatch(svc, ordered);   // DUP_STOP_V1
                const locked = !!(onVisit && onVisit.blocked);
                list.appendChild(h('button', {
                    type: 'button', class: 'btn btn-ghost', 'data-service-id': String(svc.id), disabled: locked,
                    title: locked ? tr('уже назначено') : undefined,
                    style: { justifyContent: 'space-between', display: 'flex', width: '100%', textAlign: 'left', opacity: locked ? '0.55' : '1' },
                    onclick: () => { if (locked) return; finish(svc); s.overlay.remove(); },
                }, h('span', null, svc.name || '—',
                    onVisit ? h('span', { class: 'muted', 'data-ordered': '' }, ' — ', orderedLabel(onVisit)) : null),
                h('span', { class: 'num muted' }, fmtSum(svc.price), ' ', tr('сум'))));
            }
        };
        search.addEventListener('input', paint);
        Promise.all([loadServices(), loadVisitOrders({ visitId })]).then(([rows, got]) => {
            all = rows;
            ordered = (got.ordered || []).filter((o) => Number(o.id) !== Number(exceptLineId));   // DUP_STOP_V1
            paint();
        })
```
(следующая строка `            .catch((e) => { clear(list); …` остаётся как была).

(в) Пять вызовов (у трёх одинаковое начало — привязка по следующей строке):
- `openRefundSwap` → `chooseService`: `        const picked = await pickService(tr('Новая услуга'));` → `        const picked = await pickService(tr('Новая услуга'), { visitId: inv && inv.visit_id, exceptLineId: line && line.id });   // DUP_STOP_V1`
- `openLineFix`, неоплаченный счёт — строка `const svc = await pickService(tr('Заменить услугу'));`, за которой идёт `if (await runRpc('cashier_line_change_service', { visit_service_id: line.id, …`: → `const svc = await pickService(tr('Заменить услугу'), { visitId: st.invoice.visit_id, exceptLineId: line.id });   // DUP_STOP_V1`
- `openLineFix`, оплаченный счёт — та же строка, за которой идёт `await openSwapConfirm({ visit_service_id: line.id, new_service_id: svc.id }, …`: → то же `{ visitId: st.invoice.visit_id, exceptLineId: line.id }`
- `openLineFix`, «+ Добавить услугу»: `        const svc = await pickService(tr('Добавить услугу'));` → `        const svc = await pickService(tr('Добавить услугу'), { visitId: current.visit_id });   // DUP_STOP_V1`
- `openRebill` («Ждут счёта») — строка `const svc = await pickService(tr('Заменить услугу'));`, за которой идёт `if (await runRpc('cashier_line_change_service', { visit_service_id: id, …`: → `const svc = await pickService(tr('Заменить услугу'), { visitId: row.visit_id, exceptLineId: id });   // DUP_STOP_V1`

- [ ] **Step 4: run** — `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-cashier.test.mjs public/js/admin/__tests__/cashier-line-fix.test.mjs public/js/admin/__tests__/cashier-paid-swap.test.mjs public/js/admin/__tests__/refund-swap.test.mjs public/js/admin/__tests__/cashier-refund-any.test.mjs public/js/admin/__tests__/cashier-unbilled.test.mjs public/js/admin/__tests__/cashier-v3120.test.mjs public/js/admin/__tests__/visit-refund-door.test.mjs public/js/admin/__tests__/visit-refund-window.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
  Expected: PASS (прежние тесты кассы отвечают на `visit_dup_check` пустым — окно ничего не гасит, как прежде).

- [ ] **Step 5: commit** — Write `.git/U9_MSG.txt`:

```
DUP_STOP_V1: касса — окно выбора услуги отмечает «уже назначено»

«Заменить услугу» в окне «Платежи», «Вернуть эту услугу и выставить новую»,
«Исправить услуги» и «Ждут счёта» гасят услуги, уже назначенные в этом
визите: замена или добавление на них — повтор, сервер откажет. Заменяемая
строка не мешает — ту же услугу у другого врача выбрать можно (К1).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```
git add public/js/admin/views/cashier-line-fix.js public/js/admin/__tests__/dup-stop-cashier.test.mjs
git commit -F .git/U9_MSG.txt
```

---

### Task U9.11: итоговый прогон задачи

- [ ] **Step 1:** все файлы, которых касалась U9 (сервер и клиент), одной командой:
  `node --experimental-vm-modules --test public/js/admin/__tests__/dup-stop-cashier.test.mjs public/js/shared/dup-order.test.js server/services/domain/dup-order.test.js server/services/crm/twin-preview.test.js server/routes/dup-stop-db.test.js server/services/rpc/dup-stop-rpc.test.js public/js/admin/__tests__/dup-order-check.test.mjs public/js/admin/__tests__/dup-stop-wizard.test.mjs public/js/admin/__tests__/dup-stop-doors.test.mjs public/js/admin/__tests__/booked-rows-live.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs server/routes/crm-arrival-evidence.test.js server/routes/crm-link-all-twin.test.js server/routes/crm-one-way-r2-m2-twin.test.js server/routes/crm-one-way-r2-m2-r1.test.js server/routes/crm-unify-desk-money.test.js server/routes/package-stamp.test.js server/routes/refbill-review-http.test.js server/services/rpc/billing.packages.test.js server/services/rpc/billing.test.js server/i18n-server-messages.test.js public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs`
  Expected: PASS.
- [ ] **Step 2:** то же с английской предзагрузкой (тесты на GitHub идут на английской машине): та же команда с `--import "file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs"` после `--test`. Expected: PASS (сообщения сравниваются по-русски: `tr()` в тестах с `admin.lang = ru`; сервер говорит по-русски всегда).
- [ ] **Step 3:** `node --experimental-vm-modules --test server/services/rpc/index.test.js` (обход всех RPC, 10–15 минут — так и должно быть). Expected: PASS (`visit_dup_check` с пустыми аргументами — осознанный отказ 400).
- [ ] **Step 4:** коммита нет; полный прогон выпуска — задача R.

---

## Существующие тесты, ожидания которых меняются

Полный прогон всех 12 743 тестов на копии 347bfd3d с прототипом (тот же код, что в задачах) и повторный прогон всех 4 629 клиентских тестов после правок экранов: **18 падений** (ещё одно — «symlinks/junctions» — артефакт копии с junction на `node_modules`, к U9 не относится). 17 — та же услуга второй раз в том же визите, 1 — новый шаг цепочки быстрой регистрации. С правками ниже весь набор зелёный:

| Файл | Тесты | Причина | Решение |
|---|---|---|---|
| `server/routes/crm-arrival-evidence.test.js` | 1 | приспособление: строка 900 той же консультации уже в визите | отменить 900 в этом тесте (U9.4) |
| `server/routes/package-stamp.test.js` | 2 | приспособление: анализ 2 / УЗИ дважды для удобства | третья услуга; отменить первую строку (U9.4) |
| `server/routes/refbill-review-http.test.js` | 1 | приспособление: «нечестная» и «честная» строка — одна услуга одного врача | снять «нечестную» перед «честной» (U9.4) |
| `server/services/rpc/billing.packages.test.js` | 1 | приспособление: замена на услугу, которая уже в счёте | третья услуга той же цены (U9.5) |
| `server/services/rpc/billing.test.js` | 1 | приспособление: замена на услугу, которая уже в визите | третья услуга (U9.5) |
| `server/routes/crm-link-all-twin.test.js` | 3 | смысл: «настоящий повтор остаётся второй строкой» | отказ 409 регистратуре + повтор администратором с причиной (U9.4) |
| `server/routes/crm-one-way-r2-m2-twin.test.js` | 5 (M2-T3) | смысл: тот же повтор (billed/started/qty2/registrarLine/yQty2) | то же (U9.4) |
| `server/routes/crm-one-way-r2-m2-r1.test.js` | 1 (M2-B1) | смысл: «позже та же услуга» в оплаченной записи | то же (U9.4) |
| `server/routes/crm-unify-desk-money.test.js` | 1 (C1d) | смысл: вторая строка рядом с выставленной строкой зеркала | то же (U9.4) |
| `public/js/admin/__tests__/fast-registration.test.mjs` | 1 | смысл: цепочка записей сохранения получила `visit_dup_check` до `ensure_visit` | дописать шаг в ожидаемый список (U9.9) |
| `public/js/admin/__tests__/walk-in-booking.test.mjs` | 1 | приспособление: тот же приём без врача дважды в визите дня (тест — про тариф) | первая строка — у врача 7 (U9.9) |

Законных исключений (тест должен проходить как есть) среди упавших нет: процедуры, товары, консультации других врачей и замена строки записи колл-центра — проходят и с запретом (в прогоне зелёные: `crm-link-all-twin` «мастер на записанный слот», `crm-unify-desk*`, `booked-rows-live`, `fast-registration`, `wizard-booking`, `crm-one-way-r2-m2-twin` otherDoctor и др.). Тесты, которые вставляют повторы прямо в SQLite (`line(db, …)` в `cashier-head`, `visit-lines-v3120-final`, `lis/ingest` и пр.), дверей не проходят и не затронуты.

## Что в задании не сходится с кодом (решено так)

1. **`booking_lines_add` уже не создаёт повторов** — пропускает услугу, которая есть в записи (`skipped`), причём строже нового правила: ключ без врача и отменённые строки тоже считает. Дверь до прихода и без счёта; оставлена как есть (молчаливый пропуск вместо 409 — поведение колл-центра, на которое опираются его экраны).
2. **Зеркало CRM (`attachWish` → `insertBookingLine`)** повтор не заводит: `wishHome` указывает на готовую строку той же услуги. Отдельной проверки не нужно.
3. **«Замена записи колл-центра» на кассе.** `cashier_line_add` не зовёт сеть R7b (её зовёт только одиночная вставка `/api/db`), поэтому строка записи колл-центра для кассы — назначение: касса получает отказ «уже назначена… (Оператор), счёта ещё нет» и выставляет саму строку записи. Строка CRM `auto = 1` уступает и кассе (`wishYields`) — она не мешает.
4. **«Консультация — тот же вид и тот же врач».** У строки вида приёма вид — `consultation_type_id`; у услуги каталога типа «консультация» видом считается сама услуга (`s:<id>|d:<врач>`). `services.type` по умолчанию `'consultation'` (миграция 022), поэтому услуга без проставленного типа сравнивается с врачом: такая услуга у другого исполнителя пройдёт. Для лаборатории и диагностики с типом это не так — врач не сравнивается.
5. **Процедура — только `services.type = 'procedure'`**, как в решении. Мастер (`isMultiQty`) разрешает количество и по имени («массаж», «капельница»…) — это количество в одной строке, не вторая строка; услуга «Массаж» с типом по умолчанию, уже назначенная в визите, получит отказ. Тип таким услугам проставляют в «Настройки → Услуги».
6. **Дверь `/api/db` `update`** (вернуть отменённую строку в работу, сменить `consultation_type_id` неоплаченной строки) не проверяется: ни один экран этого не делает (поиск по `public/js` — нет). Если экран появится — добавить в `visitOrderCheck` по образцу `assertChangedOrder`.
7. **Рекомендации врача (`recommended_services`)** — не строки визита; запрет их не касается (решение «в пределах визита»).
8. **Обход с причиной в окнах кассы** (К1) не предусмотрен: у `pickService` и окон кассы нет поля причины, и запрет там жёсткий для всех; RPC кассы принимают `__repeat_reason`, но экран его не шлёт. Администратор назначает повтор мастером или окном визита (там окно причины). Если владелец захочет обход и у кассы — отдельная правка окна.
9. **«Возвращённая строка больше не мешает» (К1)** — уже следует из правила U9.2: строка, отпущенная со счёта с возвратом и не выставленная заново, не назначение (то же условие, что `refundedOpenLineIds`). Неначатую строку «Вернуть услугу» и так снимает с визита. Тест на настоящем `refund_invoice_line` — в U9.5.

## Risks / implementer must check

- **Порядок с соседями.** U5 и U6 меняют `visit-wizard.js` (автовыбор дня, «Всё на один день», `create_invoice_for_visit`), `service-picker-modal.js` (`catPickDoc`, `cartVisitDateIso`), `billing.js` (`issueVisitInvoice` → дописывание в неоплаченный счёт). Правки U9 привязаны к местам, которые U5/U6 не трогают (начало `addToCart` после блока `item.qty += 1`, `createVisit` после `noBed`, отказ «уже вернули деньги»); если текст сдвинулся — по смыслу. **U8 (после U9) добавляет строку консультации в `calendar_book` в одной транзакции — эта новая дверь обязана звать `assertOrders(db, [{ visit_id, service_id | consultation_type_id, doctor_id }], { user, reason: repeatReasonArg(args) })`** (для повторного визита — новый визит, повторов обычно нет; но «Добавить в этот визит» U8 убирает, а календарь — нет).
- **`retireBookedTwin` вынесен без изменений** — U9.3 Step 4 гоняет R7b-тесты до правок U9.4; если они красные — правило сдвинулось, вернуть один в один.
- **Окно причины в браузере**: `askRepeatReason` — тот же `.modal`, что «Экстренная запись»; проверить на экране, что окно поверх мастера (z-index 190, как у экстренной записи) и Esc закрывает только его.
- **Скорость**: `liveOrders` — один запрос по индексу `visit_id` на дверь; `visit_dup_check` в мастере — по запросу на день сметы. На визитах с сотнями строк (стационар идёт через `admission_services`, не сюда) — не проблема.
- **Перевод отказа**: дверь отдаёт `template` + `params`; `db-client.js` и `supabase.js` запоминают их (`rememberServerMessage`) — проверить узбекский экран: тост мастера и отказ кассы по-узбекски.
- **Журнал обхода** пишет `invoice_audit_log` с `invoice_id = NULL`, если прежняя строка без счёта; экран «Журнал счёта» такие строки (без счёта) может не показывать — запись в базе есть; показ — отдельная задача, если владелец попросит.
- **Задвоенные до 3.21.0 визиты** (визит 411 на dev и подобные): правки строк без смены услуги проходят (`assertChangedOrder` проверяет только смену ключа), новые повторы — нет. Чистить старые повторы U9 не берётся.

## Manual check for the owner

1. Регистратура: пациент сегодня уже пришёл, ему выставлен «Анализ крови». Откройте «Добавить услуги» — у «Анализ крови» серым «уже назначено», кнопка не нажимается. В кассе «Платежи» → «Заменить услугу» — то же: на «Анализ крови» заменить нельзя.
2. Врач: в кабинете дважды «Направить на услуги» на один и тот же анализ — второй раз появится «Эта услуга уже назначена в этом визите: … кем, когда, счёт № …», второго счёта и пустого визита нет. Консультацию к другому врачу направить можно.
3. Администратор: то же повторное назначение — появится окно «Повторное назначение»; с причиной строка встаёт, причина видна в журнале счёта.
