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
// SERVICE_TYPES_FIVE_V1 — пять разделов, и каждый ведёт СВОИМ маршрутом
// (владелец: «lab goes to lab route, consultation goes to doctors cabinet,
// procedure is procedure route, diagnostics too goes to the doctors cabinet,
// and the surgery is bundled so it goes with the hospitalization»).
//
//   Консультация → кабинет врача
//   Лаборатория  → окно забора (одна очередь на клинику)
//   Процедура    → процедурный маршрут
//   Диагностика  → кабинет врача. РАНЬШЕ была очередь на аппарат, но
//                  диагностику ведёт врач, а не машина.
//   Хирургия     → талона нет вовсе: операция оформляется на госпитализацию.
//
// «Рентген» убран: своей ветки в маршрутизаторе у него не было, он падал в тот
// же else, что и «Другое», — два пункта, одно поведение. «Другое» убрано
// вместе с ним, его услуги переведены в процедуры (миграция 109).
export const SERVICE_SECTIONS = [
  { type: 'consultation', label: 'Консультация' },
  { type: 'lab',          label: 'Лаборатория' },
  { type: 'procedure',    label: 'Процедура' },
  { type: 'imaging',      label: 'Диагностика' },
  // Значение в базе — 'other', и это НЕ описка. Отдельного 'surgery' в
  // services.type нет: чтобы его завести, пришлось бы менять CHECK, то есть
  // пересобирать таблицу, а пересборка при включённых внешних ключах роняет
  // запуск программы у клиники с данными (см. миграцию 109). Хирургия и
  // хранилась под 'other' всегда — в настройках услуг этот тип так и подписан.
  { type: 'other',        label: 'Хирургия' },
];

/** Лабораторный блок (материал, единицы, референсы, пробирка) — только у лаборатории. */
export function labBlockVisible(type) {
  return type === 'lab';
}

// ---------------------------------------------------------------------------
// DOCTOR_TIER_V2 — три ступени доли исполнителя по объёму (миграции 140 + 147).
// Владелец: «another 2 (overall 3) steps of the percentage for the service».
// Правило ПОРЯДКА — одно на три потребителя: rpc/service-save.js (отказ 400),
// редактор (курсор в нужное поле) и импорт Excel (ступень не сохраняется):
//   • каждая ступень — парой: порог И доля, или ничего;
//   • ступени заполняются по порядку: 3 без 2 и 2 без 1 не действуют;
//   • пороги строго растут. Проценты — как решит клиника, о них ни слова.
// ---------------------------------------------------------------------------
export const TIER_STEP_COLUMNS = [
    { n: 1, from: 'doctor_tier_from',   pct: 'doctor_tier_percent' },
    { n: 2, from: 'doctor_tier_from_2', pct: 'doctor_tier_percent_2' },
    { n: 3, from: 'doctor_tier_from_3', pct: 'doctor_tier_percent_3' },
];

const TIER_PAIR_MSG = {
    1: 'Ступень задаётся парой: порог услуг в месяц И доля выше порога.',
    2: 'Ступень 2 задаётся парой: порог услуг в месяц И доля выше порога.',
    3: 'Ступень 3 задаётся парой: порог услуг в месяц И доля выше порога.',
};
const TIER_ORDER_MSG = {
    2: 'Ступени заполняются по порядку: ступень 2 без ступени 1 не действует.',
    3: 'Ступени заполняются по порядку: ступень 3 без ступени 2 не действует.',
};
const TIER_ASC_MSG = {
    2: 'Порог ступени 2 должен быть больше порога ступени 1.',
    3: 'Порог ступени 3 должен быть больше порога ступени 2.',
};

/**
 * Первая проблема в ступенях или null. steps — три элемента {from, pct}
 * (числа, 0 = пусто) по порядку ступеней; null на месте ступени — «неизвестно»
 * (у импорта нет её колонок в файле): проверки с ней пропускаются.
 * -> { step, field: 'from'|'pct', message } | null
 */
export function tierStepsProblem(steps) {
    const on = (st) => !!st && Number(st.from) > 0;
    for (let i = 0; i < 3; i++) {
        const st = steps[i];
        if (!st) continue;
        const hasFrom = Number(st.from) > 0, hasPct = Number(st.pct) > 0;
        if (hasFrom !== hasPct) return { step: i + 1, field: hasFrom ? 'pct' : 'from', message: TIER_PAIR_MSG[i + 1] };
    }
    for (let i = 1; i < 3; i++) {
        const st = steps[i], prev = steps[i - 1];
        if (!on(st) || !prev) continue;
        if (!on(prev)) return { step: i + 1, field: 'from', message: TIER_ORDER_MSG[i + 1] };
        if (Number(st.from) <= Number(prev.from)) return { step: i + 1, field: 'from', message: TIER_ASC_MSG[i + 1] };
    }
    return null;
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
 *                       и принимает parseRates (routes/users.js).
 *                       ДОЛЯ 0/ПУСТАЯ -> ключа pct НЕТ ВОВСЕ: измерено на
 *                       настоящем зарплатном отчёте — pct:0 перекрывает
 *                       карточную ставку врача нулём, а запись без pct
 *                       отдаёт расчёт COALESCE-у (dr.percent NULL ->
 *                       doc.service_rate_default). «Я не задал долю» — это
 *                       не «врачу не платить»;
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
    const pct = clampPct(defaultPct);
    const entry = { service_id: sid, branches: Array.isArray(branchIds) ? branchIds : [] };
    // 0 — это «не задано», и тогда ключа нет (см. шапку: карточная ставка
    // должна остаться решающей).
    if (pct > 0) entry.pct = pct;
    return { changed: true, rates: [...rates, entry] };
  }

  if (!mine) return { changed: false, rates };
  return { changed: true, rates: rates.filter((e) => !(e && Number(e.service_id) === sid)) };
}

// ---------------------------------------------------------------------------
// Ошибки rpc service_save с динамикой (имя, id, таблица).
// ---------------------------------------------------------------------------

// Склеенная фраза («Сотрудник 7 не найден.») непереводима в принципе: tr()
// ищет в словаре строку ЦЕЛИКОМ. Поэтому сервер шлёт {code, params}, а экран
// переводит ШАБЛОН и подставляет значения ПОСЛЕ перевода (trf) — тот же приём,
// что у branch-sync-logic.js и updates-logic.js. Шаблоны ниже — ключи словаря
// i18n-strings.js, дырки обязаны совпадать во всех трёх языках.
const RPC_ERROR_TEMPLATES = {
  ref_row_missing: 'Справочник {table}: строка {id} не найдена.',
  employee_missing: 'Сотрудник {id} не найден.',
  rates_corrupt: 'У сотрудника «{name}» повреждён список ставок — откройте его карточку и сохраните её заново, затем повторите.',
};

/**
 * Ошибка RPC -> {template, params} для trf, либо null — и тогда экран
 * показывает message как раньше (старый сервер, чужой код — деградация без
 * пустого тоста). params могут не доехать: trf оставит дырку видимой.
 */
export function rpcErrorTemplate(error) {
  const template = error && error.code ? RPC_ERROR_TEMPLATES[error.code] : null;
  if (!template) return null;
  return { template, params: (error && error.params) || {} };
}
