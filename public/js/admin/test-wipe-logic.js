// TEST_DATA_WIPE_V1 (docs/specs/2026-10-29-3190-refund-swap-test-wipe-design.md,
// раздел 3) — решения карточки «Удалить тестовые данные» на «Данных клиники»
// (views/system-test-wipe.js) чистыми функциями: без DOM, без i18n.js, без
// сети — как system-logic.js по соседству. Подписи — русские строки-ключи
// словаря: их переводит h() (текст ребёнка идёт через tr()) или trf() экрана.
//
// Списки ниже — то, что человек читает ПЕРЕД удалением, поэтому они обязаны
// совпадать с решениями сервера (server/services/test-data-wipe-plan.js): что
// там «удалять» — здесь в «Будут удалены», что «оставить» — в «Останутся».
// Документы — все загруженные, и сканы в карте пациента без визита тоже
// (поправка 6); стадии карточек CRM удаление не меняет (поправка 8). Ревью C5 —
// названо и то, что легко не заметить: рекомендованные услуги
// (recommended_services), карточки обзвона Cust Dev (custdev_cards), отправки
// документов в Telegram (telegram_deliveries); и что остаётся, но
// сбрасывается: подарочные карты из настроек (patient_discounts reset) и
// койки (beds clear).

export const WIPE_DELETES = Object.freeze([
  'визиты и их услуги, рекомендованные услуги, талоны очереди, показатели (давление, вес и т. п.)',
  'журнал действий по визитам и карточки обзвона после визита (Cust Dev)',
  'лаборатория: результаты анализов и сообщения анализаторов',
  'документы и их файлы — и документы визитов, и сканы в карте пациента; отправки документов в Telegram',
  'стационар: госпитализации, назначения и выполнения',
  'деньги: счета, платежи, возвраты, кассовые смены, движения по балансу пациентов, проданные подарочные карты, начисления врачам',
  'склад: движения, инвентаризации, закупки — остатки товаров начнутся с нуля',
  'брони онлайн-записи',
]);

// Визиты — это и записи в календаре: удаляются ВСЕ, будущие тоже (сервер не
// отличает учебную запись от настоящей). Окно говорит это отдельной красной
// строкой — это единственная потеря, которой администратор может не ждать.
export const WIPE_CALENDAR_WARNING = 'Удаляются ВСЕ записи в календаре — и прошедшие, и будущие, в том числе записи настоящих пациентов. Если они уже есть, сохраните их список: после удаления их придётся записать заново.';

export const WIPE_KEEPS = Object.freeze([
  'карты пациентов: ФИО, телефоны, номера карт, фото, представители, хронические болезни и аллергии',
  'CRM: карточки, задачи, метки, журнал звонков, чаты и рассылки Telegram; стадии карточек не меняются, даже если их запись удалена',
  'настройки, роли, права, сотрудники, услуги, цены, лабораторные панели, приборы, кабинеты и койки, шаблоны, подключения, лицензия',
  'подарочные карты, заведённые в настройках, — снова с полным номиналом; занятые койки освобождаются',
]);

// Отказ клинике, связанной с другими зданиями, — та же фраза, что у сервера
// (server/services/rpc/backup.js PAIRED_REFUSAL; тест сверяет их): карточка
// говорит её заранее, а словарь переводит её одним ключом.
export const PAIRED_TEXT = 'Клиника связана с другими зданиями. Удаление ушло бы в другое здание и стёрло бы там '
  + 'настоящие данные, поэтому удалить тестовые данные здесь нельзя. Если связь не нужна, нажмите «Отвязать» '
  + 'на экране «Филиалы» и удалите тестовые данные до того, как связывать клинику снова.';

// Отказ «нет места на журнал удаления» при запуске — та же фраза, что у
// сервера (server/services/test-data-wipe.js WIPE_NO_SPACE_TEMPLATE; тест
// сверяет): итог прошлого удаления несёт её числа в params.
export const WIPE_NO_SPACE_TEMPLATE = 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Тестовые данные не удалены.';

// Строки итога прошлого удаления (test_data_wipe_status.last): откуда число и
// подпись. Ключи deleted — те же, что SUMMARY_KEYS сервера (тест сверяет).
const SUMMARY = Object.freeze([
  ['deleted', 'visits', 'Визиты'],
  ['deleted', 'visit_services', 'Услуги визитов'],
  ['deleted', 'lab_results', 'Результаты анализов'],
  ['deleted', 'visit_documents', 'Документы'],
  ['files', 'removed', 'Файлы документов'],
  ['deleted', 'admissions', 'Госпитализации'],
  ['deleted', 'invoices', 'Счета'],
  ['deleted', 'payments', 'Платежи'],
  ['deleted', 'patient_deposits', 'Движения по балансу пациентов'],
  ['deleted', 'cash_shifts', 'Кассовые смены'],
  ['deleted', 'stock_movements', 'Движения склада'],
  ['cleared', 'products', 'Товары с обнулённым остатком'],
  ['deleted', 'api_requests', 'Брони онлайн-записи'],
  ['cleared', 'crm_request_services', 'Услуги в карточках CRM, отвязанные от визитов'],
]);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};
const objOrNull = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Итог удавшегося удаления → [{label, n}]; не удалось или итога нет — []. */
export function wipeSummaryRows(last) {
  const l = objOrNull(last);
  if (!l || l.ok !== true) return [];
  return SUMMARY.map(([group, key, label]) => ({ label, n: num(objOrNull(l[group]) && l[group][key]) }));
}

/**
 * Ревью C5 — было ли что удалять: любое число больше нуля в итоге — в deleted,
 * cleared (не только строки таблицы: журнал действий, освобождённая койка —
 * тоже удаление) или удалённых файлах документов. Нет — экран скажет
 * «удалять было нечего».
 */
export function wipeHadData(last) {
  const l = objOrNull(last);
  if (!l) return false;
  const any = (o) => !!o && Object.values(o).some((v) => num(v) > 0);
  return any(objOrNull(l.deleted)) || any(objOrNull(l.cleared)) || num(objOrNull(l.files) && l.files.removed) > 0;
}

// Ревью C5 (M3) — отказ «неверный пароль» узнаётся по фразе сервера
// (rpc/backup.js requirePassword; код у него общий с «не администратор» —
// forbidden). Экран после него стирает поле пароля.
const WRONG_PASSWORD = 'Неверный пароль.';
export function isWrongPassword(err) {
  return !!err && typeof err === 'object' && err.message === WRONG_PASSWORD;
}

/**
 * Кто и когда попросил удалить (ревью C4: requested_by — номер пользователя,
 * requested_at — время просьбы). Только то, что похоже на правду: номер —
 * целое больше нуля, время — разбираемая строка; иначе null.
 */
export function wipeRequestInfo(last) {
  const l = objOrNull(last);
  if (!l) return { by: null, at: null };
  const by = Number.isSafeInteger(l.requested_by) && l.requested_by > 0 ? l.requested_by : null;
  const at = typeof l.requested_at === 'string' && Number.isFinite(Date.parse(l.requested_at)) ? l.requested_at : null;
  return { by, at };
}

// Гигабайты одним знаком, десятичный знак по языку экрана — как
// system-logic.js noSpaceText (ru и uz — запятая, en — точка).
const gb = (v, lang) => v.toFixed(1).replace('.', lang === 'en' ? '.' : ',');

/**
 * Что сказать под итогом: почему удаления не было, или что осталось не так.
 * Возвращает [{template, params}] — экран переводит шаблон (trf).
 *   • отказ: клиника связана со зданиями; нет места (с числами на языке
 *     экрана — lang); нет копии «Перед удалением» (ревью C5 — своя причина
 *     no_copy); сбой — база не тронута;
 *   • удалось: карточки CRM, потерявшие учебную запись (их стадии не
 *     менялись — поправка 8); файлы документов, оставленные на диске (их нет
 *     в копии — ревью C4 — или их держала другая программа: это не сбой);
 *     файл базы не уменьшен.
 */
export function wipeLastNotes(last, lang = 'ru') {
  const l = objOrNull(last);
  if (!l) return [];
  if (l.ok !== true) {
    if (l.reason === 'paired') return [{ template: 'Тестовые данные не удалены: клиника связана с другими зданиями.', params: {} }];
    if (l.reason === 'no_space') {
      const p = objOrNull(l.params);
      if (p && Number.isFinite(p.need) && Number.isFinite(p.free)) {
        return [{ template: WIPE_NO_SPACE_TEMPLATE, params: { need: gb(p.need, lang), free: gb(p.free, lang) } }];
      }
      return [{ template: 'Тестовые данные не удалены: не хватило места на диске.', params: {} }];
    }
    if (l.reason === 'no_copy') {
      return [{ template: 'Тестовые данные не удалены: копия «Перед удалением тестовых данных» не найдена. База не тронута.', params: {} }];
    }
    return [{ template: 'Тестовые данные не удалены: при удалении произошёл сбой, база не тронута. Обратитесь в поддержку Easy-Med.', params: {} }];
  }
  const out = [];
  const cards = num(l.crm_cards_unbooked);
  if (cards) out.push({ template: 'Карточек CRM без учебной записи: {n} — их стадии не менялись.', params: { n: cards } });
  const kept = num(objOrNull(l.files) && l.files.failed);
  if (kept) {
    out.push({
      template: 'Файлов документов оставлено на диске: {n} — их нет в копии «Перед удалением тестовых данных» (например, загружены после неё) или их держала другая программа. Всё остальное удалено.',
      params: { n: kept },
    });
  }
  const v = objOrNull(l.vacuum);
  if (v && v.done !== true) {
    out.push({
      template: v.reason === 'no_space'
        ? 'Файл базы не уменьшен: не хватило места на диске. Данные при этом удалены.'
        : 'Файл базы не уменьшен. Данные при этом удалены.',
      params: {},
    });
  }
  return out;
}
