// SERVICE_EDITOR_V1 — решения редактора услуги, отдельно от рисования.
// Дизайн: docs/plans/2026-08-31-service-editor-design.md. Тот же приём и по
// той же причине, что branch-sync-logic.js: ни сети, ни DOM — чистые функции,
// которые тест зовёт напрямую, а views/service-editor.js только рисует.
//
// Этот файл — ЕДИНСТВЕННОЕ место, где записано:
//   • какие разделы бывают и на какой services.type каждый маппится;
//   • что считается «тем же именем» в комбобоксе (клиент подсказывает,
//     rpc/service-save.js импортирует отсюда и решает авторитетно — одно
//     правило, два потребителя, двойник не рождается ни на одной стороне);
//   • как сливается users.service_rates — общий магазин с карточкой
//     сотрудника, который читает reports.js доктор-пэй ($.pct, DOC_RATE_JSON_V1).

// ---------------------------------------------------------------------------
// Раздел (маршрутизация) → СУЩЕСТВУЮЩИЙ enum services.type (CHECK из миграции
// 023). Никаких новых значений: каждый модуль системы уже читает эти шесть.
// Подписи — русские литералы: экран прогоняет их через tr() (как весь admin-UI),
// ru/uz/en живут в i18n-strings.js.
// ---------------------------------------------------------------------------
export const SERVICE_SECTIONS = [
  { type: 'consultation', label: 'Консультация' },
  { type: 'lab',          label: 'Лаборатория' },
  { type: 'procedure',    label: 'Процедура' },
  { type: 'imaging',      label: 'Диагностика' },
  { type: 'radiology',    label: 'Рентген' },
  { type: 'other',        label: 'Другое' },
];

/** Лабораторный блок (материал, единицы, референсы, пробирка) — только у лаборатории. */
export function labBlockVisible(type) {
  return type === 'lab';
}

// ---------------------------------------------------------------------------
// Комбобокс «выбери или впиши новую».
// ---------------------------------------------------------------------------

// «То же имя» = совпадение после NFC-нормализации, trim, без учёта регистра и
// с ё, сложенной в е. Эту ЖЕ функцию импортирует branch-sync/catalogue.js для
// усыновления — правило одно на редактор и синхронизацию, двигать его можно
// только здесь и только вместе (иначе то, что редактор считает «той же
// услугой», синхронизация продублирует).
//
//   NFC   — разложенная ё (е+U+0308) и й (и+U+0306) из копипасты байтово не
//           равны составным, глазом это не видно;
//   ё→е   — та же константа нормализации, что у поиска дублей пациентов
//           (patient-duplicates.js normalizeName): «Прием» и «Приём» пишут об
//           одной услуге;
//   JS, не SQL LOWER() — SQLite не складывает регистр кириллицы.
export const normName = (s) => String(s ?? '')
  .normalize('NFC')
  .trim()
  .toLowerCase()
  .replace(/ё/g, 'е');   // i18n-exempt: константа нормализации ё→е — данные алгоритма, не текст экрана

/**
 * Что делать с набранным в комбобоксе текстом.
 * @returns null — поле пустое; {id} — это выбор существующей строки (в любом
 * регистре и с любыми пробелами); {name} — создать новую, уже обрезанную.
 */
export function resolveCombobox(typed, rows) {
  const name = String(typed ?? '').trim();
  if (!name) return null;
  const hit = (rows || []).find((r) => r && normName(r.name) === normName(name));
  return hit ? { id: hit.id } : { name };
}

// ---------------------------------------------------------------------------
// Исполнители.
// ---------------------------------------------------------------------------

// is_doctor — ЕДИНСТВЕННЫЙ признак врача. НИКОГДА не role-текст и не
// specialty: админ-врач держит role='admin', а врач без специальности —
// пустую строку; на обоих однажды сломались шесть фильтров разом
// (инвариант проекта, см. EasyMed doctor detection).
const isDoctor = (u) => !!(u && u.is_doctor);

/** Разбить персонал на врачей и остальных — для переключателя «Врач». */
export function splitPerformers(users) {
  const list = users || [];
  return {
    doctors: list.filter((u) => isDoctor(u)),
    others:  list.filter((u) => !isDoctor(u)),
  };
}

/**
 * users.service_rates в любом реальном виде -> {rates: [], corrupt}.
 * Колонка объявлена TEXT NOT NULL DEFAULT '' (миграция 021), шим отдаёт её
 * уже распарсенной (schema-registry json:), а руки и старые данные могут
 * хранить что угодно. corrupt — это «непустое, но не массив»: такое НЕ
 * заменяется пустым списком, потому что затирание чужих ставок хуже отказа.
 */
export function ratesArray(raw) {
  if (raw == null || raw === '') return { rates: [], corrupt: false };
  if (Array.isArray(raw)) return { rates: raw, corrupt: false };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { rates: parsed, corrupt: false };
    } catch (e) { /* обрабатывается ниже как corrupt */ }
  }
  return { rates: [], corrupt: true };
}

/** Кто уже исполняет услугу — начальные галочки диалога. Мусор в чьей-то
 * колонке не роняет открытие: этот человек просто не показан отмеченным. */
export function currentPerformerIds(users, serviceId) {
  const sid = Number(serviceId);
  return (users || [])
    .filter((u) => ratesArray(u && u.service_rates).rates
      .some((e) => e && Number(e.service_id) === sid))
    .map((u) => u.id);
}

/**
 * «Услугу оказывает специалист» без единого исполнителя — отказ (поведение
 * опубликованной системы, сохранено намеренно: услуга, которую некому
 * оказывать, — это очередь в никуда).
 */
export function performerGate(requiresDoctor, performerCount) {
  if (requiresDoctor && !(Number(performerCount) > 0)) {
    return { ok: false, error: 'Отметьте хотя бы одного исполнителя (врача или медсестру).' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Слияние users.service_rates.
// ---------------------------------------------------------------------------

// Тот же зажим, что parseRates в routes/users.js кладёт на приёме: проценты
// вне 0..100 не имеют смысла нигде ниже по течению.
const clampPct = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
};

/**
 * Слить членство ОДНОЙ услуги в ставки ОДНОГО человека.
 *
 * Диалог решает только членство; ставки — карточка сотрудника. Поэтому:
 *   тик, записи нет  -> добавить {service_id, pct: <доля по умолчанию>,
 *                       branches} — ровно форма, которую читает reports.js
 *                       (DOC_RATE_JSON_V1: service_id, pct, fix?, branches)
 *                       и принимает parseRates (routes/users.js);
 *   тик, запись есть -> НЕ ТРОГАТЬ: pct/fix/price там — персональные
 *                       переопределения из карточки;
 *   нет тика         -> убрать запись ЭТОЙ услуги; записи других услуг
 *                       проходят насквозь нетронутыми, с любыми полями.
 *
 * @returns {{changed: boolean, rates: Array|null, corrupt?: true}}
 *   changed=false — писать нечего (rpc не делает пустых UPDATE);
 *   corrupt=true — колонку нельзя было прочитать, rates=null, писать НЕЛЬЗЯ.
 */
export function mergeServiceRates(raw, serviceId, isPerformer, defaultPct, branchIds) {
  const { rates, corrupt } = ratesArray(raw);
  if (corrupt) return { changed: false, rates: null, corrupt: true };

  const sid = Number(serviceId);
  const mine = rates.find((e) => e && Number(e.service_id) === sid);

  if (isPerformer) {
    if (mine) return { changed: false, rates };
    return {
      changed: true,
      rates: [...rates, { service_id: sid, pct: clampPct(defaultPct), branches: Array.isArray(branchIds) ? branchIds : [] }],
    };
  }

  if (!mine) return { changed: false, rates };
  return { changed: true, rates: rates.filter((e) => !(e && Number(e.service_id) === sid)) };
}
