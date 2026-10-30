// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — every
// display/validation DECISION behind the Settings → «Система» cards
// (views/updates.js and its sibling card modules views/system-*.js), as pure
// functions: no DOM, no clock of their own, no network — the same contract as
// updates-logic.js next door, and for the same reason: these are the parts
// worth unit-testing without a fake DOM (see system-logic.test.js).
//
// The server side (server/services/backup.js + the four RPCs) is being built
// in parallel to the SAME plan, so every function here treats its input as
// possibly-thinner than the contract promises: a missing clinic_id, a listing
// without sizes, a kind nobody taught it — all degrade to an em-dash or a
// calm fallback, never a throw and never "undefined" on a clinic's screen.

import { formatRuDate } from './updates-logic.js';

/** The em-dash the whole app renders for "we do not know" — one constant so a test can assert the exact character. */
// I18N_COVERAGE_V1 — fill() from updates-logic (same dir, pure): the
// translate-then-substitute pattern without importing i18n.js, which this
// module must never do (tests import it statically, i18n.js needs a DOM).
import { fill, gbValue } from './updates-logic.js';   // DISK_GUARD_V1 — gbValue

export const DASH = '—';

function pad2(n) { return String(n).padStart(2, '0'); }

/** Accepts ms-since-epoch, an ISO string, or a Date; null when unparseable. */
function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DD.MM.YYYY HH:mm — the clinic-facing timestamp (formatRuDate plus the time backups actually differ by: two backups on one day are told apart by the hour). */
export function formatRuDateTime(v) {
  const d = toDate(v);
  if (!d) return null;
  return `${formatRuDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Human file size, Russian units, comma decimal. One decimal only under 10
 * of a unit (where it carries real information: "1,2 МБ" vs "1 МБ"), whole
 * numbers above. Garbage/negative/missing → em-dash, never "NaN Б" — the
 * parallel-built server may omit `size` entirely.
 * DISK_GUARD_V1 — lang: десятичный знак по языку экрана (en — точка, ru и uz —
 * запятая, как и прежде по умолчанию).
 */
export function formatBytes(n, t = (s) => s, lang = 'ru') {
  const v = typeof n === 'number' ? n : (typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN);
  if (!Number.isFinite(v) || v < 0) return DASH;
  if (v < 1024) return fill(t('{n} Б'), { n: Math.round(v) });
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let val = v;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  const s = val < 10 ? val.toFixed(1).replace(/\.0$/, '').replace('.', lang === 'en' ? '.' : ',') : String(Math.round(val));
  return s + ' ' + t(units[i]);
}

/**
 * The backup kind, preferring the server's own `kind` field and falling back
 * to the filename prefix — the same prefix rule server/services/backup.js
 * derives kinds from (`<kind>-YYYYMMDD-HHmmss.db`), so a listing from an
 * older server that has no `kind` field yet still classifies identically.
 */
export function backupKind(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.kind === 'string' && row.kind) return row.kind;
  if (typeof row.name === 'string') {
    const m = /^([a-z]+)-/.exec(row.name);
    if (m) return m[1];
  }
  return null;
}

// Human words for the plan's five filename-prefix kinds, plus `replaced-`
// (what processPendingAction moves the live DB aside as during a restore) and
// `rollback-` (the same, left by recover.cmd's rollback). DISK_GUARD_V1 — the
// owner's wording, «До восстановления» / «До отката» (spec 3.18.1, п. 6).
// Static Russian literals: they render through h(), whose text-child path
// runs tr(), so the ru/uz/en entries live in i18n-strings.js.
const KIND_LABELS = {
  pre:      'перед обновлением',
  daily:    'ежедневная',
  manual:   'ручная',
  safety:   'страховочная (перед восстановлением)',
  final:    'перед удалением данных',
  wipe:     'перед удалением тестовых данных',   // TEST_DATA_WIPE_V1
  replaced: 'До восстановления',
  rollback: 'До отката',
};

/**
 * Kind → human label. An UNKNOWN kind shows its raw kind string rather than
 * the em-dash: a future server may add a sixth prefix, and "какая-то копия
 * без подписи" hides information the admin can act on, while the raw word
 * ("weekly") at least identifies the file.
 */
export function backupKindLabel(kind) {
  if (!kind || typeof kind !== 'string') return DASH;
  return KIND_LABELS[kind] || kind;
}

/** DD.MM.YYYY HH:mm for a backup row's mtime; em-dash when the server sent none. */
export function backupDateLabel(mtimeMs) {
  return formatRuDateTime(mtimeMs) || DASH;
}

/**
 * backup_list's reply → a safe array, newest first. The plan promises
 * `[{name, kind, size, mtimeMs}]` but leaves the RPC free to wrap it (a
 * free-space note travels with the listing), so both a bare array and
 * `{backups: [...]}` are accepted; anything else — including the `{}` an
 * older server answers before the RPC exists — degrades to an empty list.
 * Rows without a string `name` are dropped: name is the restore key, and a
 * row that cannot be restored must not offer the button.
 */
export function normalizeBackupList(data) {
  const arr = Array.isArray(data) ? data
    : (data && Array.isArray(data.backups)) ? data.backups
      : [];
  return arr
    .filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name !== '')
    .slice()
    // Newest first even though the server promises that order — a defensive
    // re-sort costs nothing and the table's whole meaning is "most recent
    // state on top". Missing mtimeMs sinks to the bottom, not the top.
    .sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));
}

/**
 * The quiet free-space line under the backups table — backup_list's reply
 * carries `free_bytes` when the platform could answer cheaply (the RPC's own
 * comment: a courtesy note, never a fact the feature depends on). Null when
 * absent/garbage: no line at all beats «Свободно на диске: —». Dynamic
 * Russian by concatenation, the house no-placeholder convention.
 */
export function freeSpaceNote(data, t = (s) => s) {
  // Only a real number counts — Number(null) is 0 (the same trap
  // updates-logic.js's coerceHour documents), and a server that answered
  // free_bytes:null must produce NO line, not «Свободно на диске: 0 Б».
  const free = data && typeof data === 'object' && typeof data.free_bytes === 'number'
    ? data.free_bytes : NaN;
  if (!Number.isFinite(free) || free < 0) return null;
  return fill(t('Свободно на диске: {size}'), { size: formatBytes(free, t) });
}

/**
 * The typed-confirmation rule for the factory reset: exactly «УДАЛИТЬ»,
 * surrounding whitespace forgiven (an invisible trailing space must not
 * gaslight a frightened admin), case and lookalikes NOT forgiven — the
 * server re-checks the same exact word (factory_reset's own rule is the
 * real one; this one exists so the mismatch is caught BEFORE the scary
 * click, not after).
 */
export function confirmWordOk(input) {
  return typeof input === 'string' && input.trim() === 'УДАЛИТЬ';   // i18n-exempt: контрольное слово сброса — сверяемая константа, намеренно одна во всех языках
}

/** DD.MM.YYYY for licence valid_until (ISO or ms); em-dash when the server has not learned to send it yet. */
export function validUntilLabel(v) {
  const d = toDate(v);
  return d ? formatRuDate(d) : DASH;
}

/**
 * The «Действует до» line: date and days-left folded into ONE honest string,
 * shaped by what the server actually delivered:
 *   both        → «12.09.2026 — осталось 22 дн.»
 *   only days   → «осталось 22 дн.»   (valid_until not shipped yet)
 *   only date   → «12.09.2026»        (locked: days_left is 0, saying
 *                                      "осталось 0 дн." next to a date reads
 *                                      like a countdown, not a fact)
 *   neither     → em-dash
 * Dynamic Russian, built by concatenation — the same no-placeholder
 * convention as updates-logic.js's formatScheduled().
 */
export function validityLabel(lic, t = (s) => s) {
  if (!lic || typeof lic !== 'object') return DASH;
  const until = validUntilLabel(lic.valid_until);
  const days = Number(lic.days_left);
  const hasDays = Number.isFinite(days) && days > 0;
  if (until !== DASH && hasDays) return fill(t('{until} — осталось {days} дн.'), { until, days: Math.floor(days) });
  if (until !== DASH) return until;
  if (hasDays) return fill(t('осталось {days} дн.'), { days: Math.floor(days) });
  return DASH;
}

/** DD.MM.YYYY HH:mm of the last successful check-in; em-dash before the first one (or before the server ships the field). */
export function lastCheckinLabel(v) {
  return formatRuDateTime(v) || DASH;
}

/** Plain value-or-dash for identity fields (clinic name, clinic id) the extended licence_status may not carry yet. */
export function dashWhenEmpty(v) {
  return (v == null || v === '') ? DASH : String(v);
}

/**
 * The status badge: state+reason → tag kind + wording, mirroring the exact
 * reason distinctions the ladder and activation screen already make — above
 * all the rule that a PAID clinic whose router died is never told it owes
 * money (reason defaults to 'offline' server-side when unsure; see
 * control/ladder.js's own comment). Kinds are ui.js Tag() vocabulary.
 * Dynamic day-count labels are code-built Russian (banner convention in
 * admin.js renderLicenceBanner); the static ones live in i18n-strings.js.
 */
export function subscriptionBadge(lic, t = (s) => s) {
  if (!lic || typeof lic !== 'object') return { kind: '', label: DASH };
  if (lic.reason === 'not_enrolled') return { kind: 'warn', label: 'Не активирована' };
  // Same `=== true` strictness as licence.js's isLicensed(): only a real
  // boolean true reads as locked, garbage falls through to the state ladder.
  if (lic.locked === true) {
    if (lic.reason === 'unpaid') return { kind: 'crit', label: 'Подписка не активна' };
    if (lic.reason === 'unlicensed') return { kind: 'crit', label: 'Лицензия недействительна' };
    return { kind: 'crit', label: 'Нет связи с Easy-Med — система заблокирована' };
  }
  if (lic.state === 'warn' || lic.state === 'notice') {
    // Floor at 1, same defensive rule as renderLicenceBanner: these rungs are
    // structurally days>0, but a malformed payload must never print «0 дн.».
    const days = Math.max(1, Number(lic.days_left) || 0);
    const label = lic.reason === 'unpaid'
      ? fill(t('Подписка заканчивается через {days} дн.'), { days })
      : fill(t('Нет связи с Easy-Med {days} дн.'), { days });
    return { kind: lic.state === 'warn' ? 'warn' : 'info', label };
  }
  // 'ok' — and also the pre-RPC 'unknown' fallback licence.js serves before
  // boot finishes: the badge follows what the rest of the app is already
  // telling the user (no banner, everything open), not a scarier guess.
  return { kind: 'ok', label: 'Подписка активна' };
}

// The modules this card lists by name — the CLIENT's sales vocabulary, same
// two keys as licensed-modules.js (marketing is deliberately absent there
// and therefore here: no screen exists to grant; see that file's own
// comment). Short nouns, not licensed-modules' benefit-led pitch titles —
// this is a settings inventory, not a sales surface.
const MODULE_VOCAB = [
  { key: 'crm', label: 'CRM и call-центр' },
  { key: 'telegram', label: 'Telegram-бот для пациентов' },
];

/**
 * The subscription card's module rows: the known vocabulary first, each
 * marked enabled/absent, then any GRANTED key the vocabulary does not know
 * (a vendor can grant ahead of this client's release — a paid-for module
 * must never be invisible, even if all we can print is its raw key).
 * A malformed `modules` (string, null — seen from hand-edited licences,
 * see licence.js) reads as "nothing enabled", never a throw.
 */
// V3120_FIX — имена модулей, которые продаются, но в перечне выше не стоят
// (их не предлагают купить с этой карточки, поэтому строкой «не подключён»
// они не рисуются). Выданный такой модуль раньше показывался сырым ключом —
// «marketing», «custdev» — посреди русского экрана. Ключ, которого не знает
// и этот список, по-прежнему печатается как есть: оплаченное не прячется.
const GRANTED_ONLY_LABELS = Object.freeze({
  callcenter: 'Телефония (журнал звонков)',
  marketing: 'Маркетинг',
  custdev: 'Опросы пациентов (CustDev)',
});

export function moduleRows(modules) {
  const enabled = Array.isArray(modules) ? modules.filter((k) => typeof k === 'string') : [];
  const rows = MODULE_VOCAB.map(({ key, label }) => ({ key, label, enabled: enabled.includes(key) }));
  for (const key of enabled) {
    if (!MODULE_VOCAB.some((m) => m.key === key)) {
      const label = Object.prototype.hasOwnProperty.call(GRANTED_ONLY_LABELS, key) ? GRANTED_ONLY_LABELS[key] : key;
      rows.push({ key, label, enabled: true });
    }
  }
  return rows;
}

/**
 * The EM- code entry belongs on the settings card ONLY while licence_status
 * says not enrolled — after a factory reset the first-run screen owns entry
 * (the plan's own rule), and an enrolled clinic re-typing a code would only
 * earn licence_enroll's `already_enrolled` refusal.
 */
export function enrollFormVisible(lic) {
  return !!(lic && lic.reason === 'not_enrolled');
}

/**
 * DD.MM.YYYY for module_request's requested_at — same 'ru-RU' rendering as
 * locked-module.js's formatRequestDate (kept in the same shape so the two
 * screens print the same request on the same day identically).
 */
export function requestDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
}

/**
 * DISK_GUARD_V1 (ревью C2) — отказ сервера «нет места на копию» на языке
 * экрана. Сервер (server/services/disk-guard.js noSpaceError) шлёт шаблон и
 * гигабайты ЧИСЛАМИ; десятичный знак ставится только здесь, для этой фразы:
 * ru и uz — запятая, en — точка, всегда один знак («0,0»), как в русской
 * фразе сервера. Общий tr() числа не трогает — там и суммы денег других
 * сообщений. t — перевод шаблона (tr экрана). null — это не отказ по месту
 * или ответ не того вида: экран покажет фразу сервера, как раньше.
 */
export function noSpaceText(err, lang, t = (s) => s) {
  if (!err || typeof err !== 'object' || err.code !== 'no_space' || typeof err.template !== 'string') return null;
  const p = err.params && typeof err.params === 'object' ? err.params : null;
  if (!p || !Number.isFinite(p.need) || !Number.isFinite(p.free)) return null;
  const sep = lang === 'en' ? '.' : ',';
  const gb = (v) => v.toFixed(1).replace('.', sep);
  return fill(t(err.template), { need: gb(p.need), free: gb(p.free) });
}

// ---------------------------------------------------------------------------
// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md,
// раздел 3, п. 2, 3, 5 и 8) — «Место на диске»: карточка на «Данных клиники»
// (views/system-disk.js) и колокол администратора (notifications.js). Ответ
// disk_usage — как есть; число, которого нет или которое не число, не
// выдумывается: нет строки и нет предупреждения. Десятичный знак — по языку
// экрана (lang): ru и uz — запятая, en — точка, как в noSpaceText.
// ---------------------------------------------------------------------------

const finiteBytes = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const objOrNull = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Гигабайты одним знаком для фраз «нужно / свободно» — «нужно» вверх, «свободно» вниз (updates-logic.js gbValue). */
function gbText(bytes, lang, up = false) {
  return gbValue(bytes, { up }).toFixed(1).replace('.', lang === 'en' ? '.' : ',');
}

// Ключ словаря — та же фраза, что присылает сервер (disk-guard.js COPY_REFUSED_TEMPLATE).
const COPY_REFUSED_TEMPLATE = 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.';

/** «Копия не сделана» (п. 2) с числами; без чисел — null (их пишет каждый отказ). */
function copyRefusedText(d, t, lang) {
  const c = objOrNull(d.copy_refused);
  if (!c) return null;
  const need = finiteBytes(c.need_bytes);
  const free = finiteBytes(c.free_bytes);
  if (need === null || free === null) return null;
  return fill(t(COPY_REFUSED_TEMPLATE), { need: gbText(need, lang, true), free: gbText(free, lang) });
}

/**
 * «Обновление не установлено» (п. 3). Числа есть — с числами; нет (диск
 * заполнился посреди копии перед обновлением — updater.js) — общей фразой.
 * Без версии отметка не правда (сервер такую снимает) — null.
 */
function updateRefusedText(d, t, lang) {
  const u = objOrNull(d.update_refused);
  const version = u && typeof u.version === 'string' && u.version ? u.version : null;
  if (!version) return null;
  const need = finiteBytes(u.need_bytes);
  const free = finiteBytes(u.free_bytes);
  if (need !== null && need > 0 && free !== null) {
    return fill(t('Обновление {version} не установлено — недостаточно места: нужно {need} ГБ, свободно {free} ГБ. Освободите место, и мы попробуем снова.'),
      { version, need: gbText(need, lang, true), free: gbText(free, lang) });
  }
  return fill(t('Обновление {version} не установлено — на диске не хватило места. Освободите место, и мы попробуем снова.'), { version });
}

/**
 * Ручные и финальные копии одни больше 30 % диска (п. 5). Предел по объёму их
 * не удаляет; по счёту хранятся 10 последних ручных и 5 последних перед
 * удалением данных (services/backup.js KEEP_BY_KIND) — лишнее администратор
 * удаляет сам.
 */
function keptOverCapText(d, t, lang) {
  const k = objOrNull(d.kept_over_cap);
  const bytes = k ? finiteBytes(k.bytes) : null;
  if (bytes === null) return null;
  return fill(t('Ручные копии и копии перед удалением данных занимают {size} — больше 30 % диска. Предел по объёму их не удаляет: хранятся 10 последних ручных и 5 последних перед удалением данных. Ненужные удалите вручную.'),
    { size: formatBytes(bytes, t, lang) });
}

// «Мало места» в колоколе — только когда копии и правда скоро перестанут
// делаться: свободно меньше max(5 ГБ, место на следующую копию), то же правило,
// что у чистки копий (server/services/backup.js pruneBySize). Диск 1 ТБ с 60 ГБ
// свободных — 6 %, красная строка на «Данных клиники» есть, а звонить на каждом
// экране не о чем. Старый сервер без copy_need_bytes — порог 5 ГБ.
const LOW_FREE_BYTES = 5 * 1024 ** 3;

/**
 * Строки «что сколько занимает», красные предупреждения и признак «мало
 * места». Подписи строк — русским исходником (переводит h()); значения и
 * предупреждения — уже на языке экрана. Папку, сосчитанную не до конца
 * (partial — предел обхода на сервере), показывает «не меньше»: «≥ 120 ГБ».
 */
export function diskUsageView(data, t = (s) => s, lang = 'ru') {
  const d = objOrNull(data) || {};
  const partial = Array.isArray(d.partial) ? d.partial : [];
  const rows = [];
  const add = (label, key) => {
    const n = finiteBytes(d[key]);
    if (n === null) return;
    const v = formatBytes(n, t, lang);
    rows.push({ label, value: partial.includes(key) ? '≥ ' + v : v });
  };
  add('База данных', 'db_bytes');
  add('Резервные копии', 'backups_bytes');
  add('Файлы (сканы и документы)', 'storage_bytes');
  add('Версии программы', 'versions_bytes');
  const free = finiteBytes(d.free_bytes);
  const total = finiteBytes(d.total_bytes);
  if (free !== null && total !== null) {
    rows.push({ label: 'Свободно', value: fill(t('{free} из {total}'), { free: formatBytes(free, t, lang), total: formatBytes(total, t, lang) }) });
  }

  const warnings = [];
  if (d.low === true && free !== null) {
    warnings.push(fill(t('Мало места на диске: свободно {free}. Освободите место, иначе копии базы и обновления перестанут делаться.'),
      { free: formatBytes(free, t, lang) }));
  }
  for (const w of [copyRefusedText(d, t, lang), updateRefusedText(d, t, lang), keptOverCapText(d, t, lang)]) {
    if (w) warnings.push(w);
  }
  return { rows, warnings, low: d.low === true };
}

/**
 * Что сказать колоколу администратора по ответу disk_usage {quick:true}.
 * Отказ в копии и отказ обновления — каждый своей строкой; при отказе
 * «мало места» не повторяется (числа и «освободите место» уже в отказе).
 * «Мало места» — только когда свободно меньше max(5 ГБ, место на следующую
 * копию) (LOW_FREE_BYTES выше). «Мало места» и ручные копии сверх предела —
 * только в колоколе (bellOnly): полоса поперёк каждого экрана была бы шумом,
 * а красное на «Данных клиники» и так видно. id постоянный
 * (у обновления — с версией): скрытое не возвращается каждую минуту, пока
 * место не освободят, и гаснет само, когда отметку снял сервер. [] — сказать
 * нечего.
 */
export function diskNotices(data, t = (s) => s, lang = 'ru') {
  const d = objOrNull(data);
  if (!d) return [];
  const list = [];
  const copy = copyRefusedText(d, t, lang);
  if (copy) list.push({ id: 'disk-copy', sev: 'danger', icon: 'Database', title: t('Резервная копия не сделана'), message: copy });
  const upd = updateRefusedText(d, t, lang);
  if (upd) {
    list.push({ id: 'disk-update:' + d.update_refused.version, sev: 'warn', icon: 'Download', title: t('Нет места для обновления'), message: upd });
  }
  const free = finiteBytes(d.free_bytes);
  const total = finiteBytes(d.total_bytes);
  const floor = Math.max(LOW_FREE_BYTES, finiteBytes(d.copy_need_bytes) || 0);
  if (!list.length && free !== null && total !== null && free < floor) {
    list.push({
      id: 'disk-low', sev: 'warn', icon: 'Warning', bellOnly: true,
      title: t('Мало места на диске'),
      message: fill(t('Свободно {free} из {total}. Освободите место, иначе копии базы и обновления перестанут делаться.'),
        { free: formatBytes(free, t, lang), total: formatBytes(total, t, lang) }),
    });
  }
  const kept = keptOverCapText(d, t, lang);
  if (kept) list.push({ id: 'disk-kept', sev: 'warn', icon: 'Database', bellOnly: true, title: t('Копии занимают много места'), message: kept });
  return list;
}
