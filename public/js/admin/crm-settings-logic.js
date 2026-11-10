// I18N_COVERAGE_V1 — fill() from updates-logic (pure, same dir): translate-
// then-substitute for the validation sentences without importing i18n.js,
// which this module must never do (crm-settings-logic.test.js imports it
// statically; i18n.js needs a DOM at load).
import { fill } from './updates-logic.js';

// CRM_CONFIG_V1 (docs/plans/2026-08-24-crm-kanban-settings.md) — every
// DECISION behind Настройки → «CRM-канбан» (views/crm-settings.js) AND behind
// the board that obeys it (views/crm.js), as pure functions: no DOM, no
// network, no clock — the same contract as telephony-logic.js next door, and
// for the same reason (see crm-settings-logic.test.js).
//
// Why the board's fallback lives HERE and not in crm.js: the settings screen
// validates a vocabulary, the board renders it, and the two must never drift.
// One module owns the vocabulary — the colour tokens, the default stages, the
// default sources, the Binotel disposition words — so a rule can only be
// changed in one place.
//
// The vocabulary here is the SAME one the server enforces (migration 077 and
// server/services/crm/config.js): the colour tokens, the key alphabet, the
// one-conversion rule, the rows that may be hidden but not deleted. It is
// restated on this side so the screen can refuse a bad edit before the round
// trip and name the row it is refusing — the server refuses it a second time
// regardless, which is where the rule actually lives.
//
// Every function still treats its input as possibly-thinner than the contract
// promises: a missing field, a stage row with no kind, a reply of {} from a
// clinic still on an older build — all degrade to today's hardcoded board,
// never to a blank screen and never to a throw.
//
// Labels are static Russian literals: they render through h(), whose
// text-child path runs tr(), so the ru/uz/en entries live in i18n-strings.js.

// The "server is older than this screen" test. Deliberately the SAME rule as
// telephony-logic.js's — it is about the /api/rpc route's 501 contract, not
// about Binotel — so it is imported rather than copied, which is what keeps
// the two screens from drifting apart when the route's shape changes.
import { isNotImplemented } from './telephony-logic.js';
// CRM_UNIFY_V1 — «Колонка записи»: одно правило с сервером (services/crm/config.js scheduledStageKey).
import { bookedStageKey } from '../shared/crm-booked-stage.js';
// CRM_STAGE_ROLES_V1 — роли колонок: та же проверка, что у сервера (services/crm/config.js saveStages).
import { STAGE_ROLES, roleKey, hasStageRoles, roleRefusal, roleLeaving } from '../shared/crm-booked-stage.js';
import { noShowAllowed } from '../shared/crm-booked-stage.js';   // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F1)

export { isNotImplemented };

// ---------------------------------------------------------------------------
// Colour vocabulary — the house tokens, NOT free hex
// ---------------------------------------------------------------------------
// A stage's colour is a token name from the set admin.css already ships as
// `.tag-*` classes. Free hex was refused on purpose: the board's tags, the
// funnel report and the list view all reuse those classes, so an arbitrary
// colour would either be ignored or land unreadable text on an unreadable
// background.
//
// The neutral/grey token is the EMPTY STRING, matching migration 077's
// `CHECK (color IN ('info','warn','purple','teal','ok','crit',''))` and
// STAGE_COLORS in server/services/crm/config.js — the same value Tag() wants
// for a tag with no `.tag-*` class. The plan's prose called it «none»; the
// server accepts that spelling as an alias, and so does isValidColor below,
// but '' is the one that is stored.
export const COLORS = [
    { token: 'info',   label: 'Синий' },
    { token: 'warn',   label: 'Жёлтый' },
    { token: 'purple', label: 'Фиолетовый' },
    { token: 'teal',   label: 'Бирюзовый' },
    { token: 'ok',     label: 'Зелёный' },
    { token: 'crit',   label: 'Красный' },
    { token: '',       label: 'Серый' },
];
const COLOR_TOKENS = COLORS.map((c) => c.token);

/** The stored form of a colour: 'none' folds to '' (the server's alias rule), anything else is returned as given. */
export function normalizeColor(token) {
    return token === 'none' ? '' : token;
}

/** Is this a colour the board can actually paint? Unknown tokens are refused at save time rather than rendered as a missing class. */
export function isValidColor(token) {
    return typeof token === 'string' && COLOR_TOKENS.includes(normalizeColor(token));
}

/**
 * Stored colour token → the `kind` Tag() wants. The neutral token (and
 * anything the screen has not learned) becomes '' — Tag('…', {kind:''}) is the
 * grey tag, which is exactly what today's board renders for «Обработка
 * остановлена» and «Нецелевой».
 */
export function tagKind(token) {
    return isValidColor(token) ? normalizeColor(token) : '';
}

/** Colour token → its Russian name, for the swatch's accessible name. Unknown → the raw token, never an empty button. */
export function colorLabel(token) {
    const c = COLORS.find((x) => x.token === normalizeColor(token));
    return c ? c.label : String(token || '');
}

// ---------------------------------------------------------------------------
// Rows the screen must not offer to delete
// ---------------------------------------------------------------------------
// Mirrors UNDELETABLE_STAGE_KEYS / UNDELETABLE_SOURCE_KEYS in
// server/services/crm/config.js. The server refuses these deletions with a 409
// and a clear sentence, so the rule is enforced there — this list only stops
// the screen from OFFERING a button that can never work.
//
//   in_process / call  are the DEFAULTs of crm_requests.status/source, written
//                      by /api/db whenever a screen omits the field.
//   telephony          is the source lead-from-call.js writes on a lead made
//                      from a phone call.
// All three can still be renamed, recoloured, reordered and hidden.
export const UNDELETABLE_STAGE_KEYS = ['in_process'];
export const UNDELETABLE_SOURCE_KEYS = ['call', 'telephony', 'meta_ads'];   // META_LEADS_V1 — источник заявок из рекламы Meta (services/meta/leads.js)
// The reason, in the owner's language, shown where the delete button would be.
export const UNDELETABLE_STAGE_REASON = 'Подставляется новым заявкам по умолчанию — можно скрыть, но не удалить.';
export const UNDELETABLE_SOURCE_REASON = 'На него ссылается сама система — можно скрыть, но не удалить.';

// The server truncates a label to 64 characters (normLabel). The input carries
// the same limit so a long name is refused while it is being typed, instead of
// coming back silently shortened after the save.
export const LABEL_MAX = 64;

// ---------------------------------------------------------------------------
// The fallback board — today's hardcoded arrays, kept ONLY as a fallback
// ---------------------------------------------------------------------------
// These are byte-for-byte the vocabularies views/crm.js hardcoded before this
// change (SOURCES / STATUSES, migration 046's CHECK constraints), plus the
// `kind` each stage always had implicitly: 'came' was CONVERT_STATUS,
// ACTIVE_STATUSES were the open ones, LOST_STATUSES the lost ones.
//
// They exist so that a failing crm_config_get — an unmerged server, a 501, a
// dropped connection, a settings screen that somehow saved nonsense — leaves
// the clinic looking at the board it had yesterday. A settings screen must
// never be able to blank the board.
//
// The list deliberately does NOT include the new 'telephony' source that
// migration 077 seeds: this array's job is "what the board looked like before
// any of this shipped". When the RPC answers, the seeded telephony source
// arrives with it.
// CRM_STAGE_ROLES_V1 — и роли, которые миграция 284 ставит сидовой воронке.
export const DEFAULT_STAGES = [
    { key: 'in_process',    label: 'В обработке',           color: 'info',   position: 1, is_active: 1, kind: 'open', role: null },
    { key: 'recall',        label: 'Перезвонить',           color: 'warn',   position: 2, is_active: 1, kind: 'open', role: null },
    { key: 'scheduled',     label: 'Записан',               color: 'purple', position: 3, is_active: 1, kind: 'open', role: 'booked' },
    { key: 'approved',      label: 'Подтверждён',           color: 'teal',   position: 4, is_active: 1, kind: 'open', role: 'confirmed' },
    { key: 'came',          label: 'Пришёл',                color: 'ok',     position: 5, is_active: 1, kind: 'won',  role: null },
    { key: 'no_show',       label: 'Не пришёл',             color: 'crit',   position: 6, is_active: 1, kind: 'lost', role: 'no_show' },
    { key: 'stopped',       label: 'Обработка остановлена', color: '',       position: 7, is_active: 1, kind: 'lost', role: null },
    { key: 'not_qualified', label: 'Нецелевой',             color: '',       position: 8, is_active: 1, kind: 'lost', role: null },
];

// ---------------------------------------------------------------------------
// CRM_STAGE_ROLES_V1 (3.23.0) — роли колонок
// ---------------------------------------------------------------------------
// Владелец: «we need to add a booking tick (like conversion) so the system won't break».
// Три колонки, на которые завязана автоматика, — отметки (crm_stages.role, миграция 284):
//   booked    — «запись»: сюда переходит карточка, когда пациента записали;
//   confirmed — «подтверждение»: сюда её ведёт отметка «Подтверждён» в календаре;
//   no_show   — «не пришёл»: сюда её уводит неявка (проход наутро, отметка в календаре).
// Бейджи — как «конверсия» (Tag), подписи — строки словаря (переводит h()).
export const ROLE_BADGES = Object.freeze({
    booked: Object.freeze({ label: 'запись', kind: 'purple' }),
    confirmed: Object.freeze({ label: 'подтверждение', kind: 'teal' }),
    no_show: Object.freeze({ label: 'не пришёл', kind: 'crit' }),
});
/**
 * Какие роли можно отметить у колонки: открытой — запись, подтверждение и «не пришёл», проигрышной —
 * «не пришёл», конверсии — никакие. CRM_NO_SHOW_ANY_COLUMN_V1 (3.23.0) — «не пришёл» и у открытой
 * (владелец: «we also need to add the "unarrived" status tick»).
 */
export function roleOptionsFor(stage, { stages = null, routed = [] } = {}) {
    const kind = stage && stage.kind;
    // CRM_STAGE_ROLES_V1 (ревью потока E, F5) — у колонки одна роль: у колонки с ролью — только её галочка
    // (снять); вторую не предложить (прежде она молча вытесняла первую).
    if (stage && STAGE_ROLES.includes(stage.role)) return [stage.role];
    if (kind === 'open') {
        // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F1) — «не пришёл» у открытой — только там, где его можно сохранить
        // (после колонки записи, не начальная, без правила звонков); воронки нет — не предлагается.
        const ok = Array.isArray(stages) && noShowAllowed(stages, stage.key, { routed });
        return ok ? ['booked', 'confirmed', 'no_show'] : ['booked', 'confirmed'];
    }
    if (kind === 'lost') return ['no_show'];
    return [];
}
// Тексты отказов — те же фразы, что у сервера (services/crm/config.js ROLE_REFUSALS,
// ROLE_LEAVING): экран отказывает до сервера, сервер — ещё раз.
const ROLE_REFUSALS = {
    role_twice: 'Каждую роль можно отметить только у одной колонки.',
    booked_order: 'Колонка записи должна быть открытой видимой колонкой перед колонкой-конверсией.',
    confirmed_order: 'Колонка подтверждения должна быть открытой видимой колонкой после колонки записи и перед колонкой-конверсией.',
    no_show_kind: 'Колонкой «Не пришёл» может быть только видимая колонка, кроме колонки-конверсии.',   // CRM_NO_SHOW_ANY_COLUMN_V1
    // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F1) — открытая колонка «Не пришёл».
    no_show_order: 'Открытая колонка «Не пришёл» должна стоять после колонки записи и перед колонкой-конверсией.',
    no_show_default: 'Начальная колонка (в неё попадают новые заявки) не может быть колонкой «Не пришёл».',
    no_show_routed: 'В эту колонку звонки заводят новые заявки — колонкой «Не пришёл» она быть не может. Сначала поменяйте правило звонков в разделе «Телефония».',
};
const ROLE_LEAVING = {
    booked: 'Колонка «{label}» — колонка записи: сначала передайте роль другой колонке.',
    confirmed: 'Колонка «{label}» — колонка подтверждения: сначала передайте роль другой колонке.',
    no_show: 'Колонка «{label}» — колонка «Не пришёл»: сначала передайте роль другой колонке.',
};
export const DEFAULT_SOURCES = [
    { key: 'call',      label: 'Звонок',       position: 1, is_active: 1 },
    { key: 'instagram', label: 'Instagram',    position: 2, is_active: 1 },
    { key: 'telegram',  label: 'Telegram',     position: 3, is_active: 1 },
    { key: 'website',   label: 'Сайт',         position: 4, is_active: 1 },
    { key: 'walk_in',   label: 'Пришёл сам',   position: 5, is_active: 1 },
    { key: 'referral',  label: 'Рекомендация', position: 6, is_active: 1 },
    { key: 'other',     label: 'Другое',       position: 7, is_active: 1 },
];
// The stage the conversion flow keys off when the config cannot say. It is a
// BEHAVIOUR, not a label: this is the only status that opens the patient
// registration popup, so it can never be undefined.
export const FALLBACK_CONVERT_STAGE = 'came';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
// A stage/source key ends up in a foreign-key column, in `data-col` on the
// board and in exported spreadsheets, so it is restricted to the shape the
// migration's own guard uses.
export const KEY_RE = /^[a-z0-9_]{1,32}$/;
const KEY_MAX = 32;

export function isValidKey(k) {
    return typeof k === 'string' && KEY_RE.test(k);
}

// Cyrillic → latin. A plain practical transliteration (the one Uzbek clinics
// already read on their own documents), NOT GOST-7.79: the key is a machine
// identifier that a human occasionally has to recognise in an export, so
// «Перезвонить» → `perezvonit` is worth far more than a reversible `pereizvonit`.
// ъ and ь map to nothing — they carry no sound to spell.
const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * A Russian (or latin, or Uzbek-latin) label → the key it is stored under.
 *
 * Rules, in order: lower-case → transliterate cyrillic → everything that is
 * not [a-z0-9] becomes '_' → collapse and trim underscores → cut to 32.
 *
 * If nothing survives — a label written in Arabic script, in emoji-free but
 * key-free punctuation, in a script this table has never seen — it falls back
 * to a STABLE generated key `<prefix>_<n>`, where n is the smallest number
 * that is free. A generated key is ugly in an export but it is a real,
 * valid, unique identifier; refusing to add the column instead would tell the
 * owner their perfectly reasonable label is "wrong".
 *
 * `taken` is the list of keys already in use (both active and hidden ones —
 * a hidden stage still owns its key). A collision gets `_2`, `_3`, … with the
 * base trimmed so the result still fits in 32 characters.
 */
export function deriveKey(label, taken = [], prefix = 'col') {
    const src = typeof label === 'string' ? label.toLowerCase() : '';
    let out = '';
    for (const ch of src) {
        if (Object.prototype.hasOwnProperty.call(TRANSLIT, ch)) out += TRANSLIT[ch];
        else if (/[a-z0-9]/.test(ch)) out += ch;
        else out += '_';
    }
    let base = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, KEY_MAX).replace(/_+$/g, '');
    const used = new Set((Array.isArray(taken) ? taken : []).filter((k) => typeof k === 'string'));
    if (!base) {
        // Nothing transliterable — a stable generated key, not a random one:
        // running the same label twice on two machines must not produce two
        // different columns.
        let n = 1;
        while (used.has(`${prefix}_${n}`)) n++;
        return `${prefix}_${n}`;
    }
    if (!used.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
        const suffix = '_' + n;
        const candidate = base.slice(0, KEY_MAX - suffix.length).replace(/_+$/g, '') + suffix;
        if (!used.has(candidate)) return candidate;
    }
    return `${prefix}_${Date.now()}`.slice(0, KEY_MAX);   // unreachable in practice; still a valid key
}

// ---------------------------------------------------------------------------
// Reordering
// ---------------------------------------------------------------------------
/**
 * Move one row up (-1) or down (+1). Returns a NEW array — the caller keeps
 * the old one until the move is accepted — and returns an equal copy when the
 * move would fall off either end, so «↑» on the first row is a no-op rather
 * than a wrap-around to the bottom (which reads as data loss).
 */
export function moveItem(list, index, delta) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const to = index + delta;
    if (index < 0 || index >= arr.length || to < 0 || to >= arr.length) return arr;
    const [row] = arr.splice(index, 1);
    arr.splice(to, 0, row);
    return arr;
}

/**
 * Stamp `position` from the array's own order, 1-based. The screen edits the
 * ORDER (a list you drag ↑/↓); the table stores a NUMBER. This is the one
 * place the two meet, and it runs immediately before every save so a reorder
 * cannot be half-applied.
 */
export function withPositions(list) {
    return (Array.isArray(list) ? list : []).map((row, i) => ({ ...row, position: i + 1 }));
}

/** Sort a config list by position, tolerantly: a missing/garbage position sinks to the bottom, ties break by key so the order is at least stable. */
export function sortByPosition(list) {
    return (Array.isArray(list) ? list : []).slice().sort((a, b) => {
        const pa = Number.isFinite(Number(a && a.position)) ? Number(a.position) : Number.MAX_SAFE_INTEGER;
        const pb = Number.isFinite(Number(b && b.position)) ? Number(b.position) : Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        return String((a && a.key) || '').localeCompare(String((b && b.key) || ''));
    });
}

/** 1/0/true/false/'1' → boolean. The RPC may serialize SQLite integers either way; the screen must not paint a checkbox off because it got the number 1 instead of true. */
export function truthy(v) {
    return !(v === 0 || v === '0' || v === false || v == null || v === '');
}

// ---------------------------------------------------------------------------
// Validation — the rules the screen refuses to save, in the owner's language
// ---------------------------------------------------------------------------
// Each returns { ok: true } or { ok: false, error: '<russian sentence>' }.
// A refusal names the row it is about: "«» — название не может быть пустым"
// tells nobody which of eleven columns is meant.

const KIND_VALUES = ['open', 'won', 'lost'];

/**
 * CRM_STAGE_ROLES_V1 — `prev` (то, что последним отдал сервер): с ним проверяются и роли —
 * колонку с ролью не скрыть и не удалить, не передав роль; правила ролей по воронке.
 */
export function validateStages(stages, t = (s) => s, prev = null, opts = {}) {
    const arr = Array.isArray(stages) ? stages : [];
    if (!arr.length) return { ok: false, error: 'Нужна хотя бы одна колонка канбана.' };

    const seen = new Set();
    let wonCount = 0;
    let activeCount = 0;
    for (const s of arr) {
        const label = typeof (s && s.label) === 'string' ? s.label.trim() : '';
        if (!label) return { ok: false, error: t('У каждой колонки должно быть название.') };
        if (!isValidKey(s && s.key)) {
            return { ok: false, error: fill(t('Ключ колонки «{label}» задан неверно: разрешены латинские буквы, цифры и подчёркивание, до 32 знаков.'), { label }) };
        }
        if (seen.has(s.key)) return { ok: false, error: fill(t('Ключ «{key}» уже занят другой колонкой.'), { key: s.key }) };
        seen.add(s.key);
        if (!isValidColor(s && s.color)) return { ok: false, error: fill(t('У колонки «{label}» выбран неизвестный цвет.'), { label }) };
        if (!KIND_VALUES.includes(s && s.kind)) return { ok: false, error: fill(t('У колонки «{label}» не задан тип.'), { label }) };
        if (s.kind === 'won') {
            wonCount++;
            // A hidden conversion column would leave the clinic with no way to
            // register the patient who actually arrived.
            if (!truthy(s.is_active)) return { ok: false, error: fill(t('Колонка конверсии «{label}» не может быть скрыта.'), { label }) };
        }
        if (truthy(s.is_active)) activeCount++;
    }
    if (wonCount === 0) return { ok: false, error: 'Нужна колонка конверсии — через неё регистрируется пациент.' };
    if (wonCount > 1) return { ok: false, error: 'Колонка конверсии должна быть ровно одна.' };
    if (!activeCount) return { ok: false, error: 'Хотя бы одна колонка должна быть видимой.' };
    // CRM_STAGE_ROLES_V1 — роли колонок.
    if (prev) {
        // Ревью: экран шлёт роли — удалённая колонка уносит снятую роль (как «снять и скрыть»).
        const leaving = roleLeaving(prev, arr, { deletions: false });
        if (leaving) return { ok: false, error: fill(t(ROLE_LEAVING[leaving.role]), { label: leaving.label }) };
    }
    const why = roleRefusal(arr, prev, { routed: (opts && opts.routed) || [] });   // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F1) — и колонки звонков
    if (why) return { ok: false, error: t(ROLE_REFUSALS[why]) };
    return { ok: true };
}

export function validateSources(sources, t = (s) => s) {
    const arr = Array.isArray(sources) ? sources : [];
    if (!arr.length) return { ok: false, error: 'Нужен хотя бы один источник.' };

    const seen = new Set();
    let activeCount = 0;
    for (const s of arr) {
        const label = typeof (s && s.label) === 'string' ? s.label.trim() : '';
        if (!label) return { ok: false, error: t('У каждого источника должно быть название.') };
        if (!isValidKey(s && s.key)) {
            return { ok: false, error: fill(t('Ключ источника «{label}» задан неверно: разрешены латинские буквы, цифры и подчёркивание, до 32 знаков.'), { label }) };
        }
        if (seen.has(s.key)) return { ok: false, error: fill(t('Ключ «{key}» уже занят другим источником.'), { key: s.key }) };
        seen.add(s.key);
        if (truthy(s.is_active)) activeCount++;
    }
    if (!activeCount) return { ok: false, error: 'Хотя бы один источник должен быть видимым.' };
    return { ok: true };
}

/**
 * CRM_HEAD_MERGE_TAGS_V1 — метки карточек. Пустой список — нормально: клиника
 * без меток их просто не заводит. Остальные правила — как у источников, плюс
 * цвет из тех же токенов, что у колонок.
 */
export function validateTags(tags, t = (s) => s) {
    const arr = Array.isArray(tags) ? tags : [];
    const seen = new Set();
    for (const s of arr) {
        const label = typeof (s && s.label) === 'string' ? s.label.trim() : '';
        if (!label) return { ok: false, error: t('У каждой метки должно быть название.') };
        if (!isValidKey(s && s.key)) {
            return { ok: false, error: fill(t('Ключ метки «{label}» задан неверно: разрешены латинские буквы, цифры и подчёркивание, до 32 знаков.'), { label }) };
        }
        if (seen.has(s.key)) return { ok: false, error: fill(t('Ключ «{key}» уже занят другой меткой.'), { key: s.key }) };
        seen.add(s.key);
        if (!isValidColor(s && s.color)) return { ok: false, error: fill(t('У метки «{label}» выбран неизвестный цвет.'), { label }) };
    }
    return { ok: true };
}

/**
 * Routing rows against the stage list they point at. A «создать заявку» row
 * that names no column — or names a hidden one — would drop a real call on
 * the floor silently, which is the one failure a call-centre never notices.
 */
export function validateRouting(routing, stages, t = (s) => s) {
    const arr = Array.isArray(routing) ? routing : [];
    const active = new Set((Array.isArray(stages) ? stages : [])
        .filter((s) => s && truthy(s.is_active)).map((s) => s.key));
    for (const r of arr) {
        const name = t(dispositionRu(r && r.disposition));
        if (!r || (r.action !== 'create' && r.action !== 'ignore')) {
            return { ok: false, error: fill(t('Для «{name}» не выбрано действие.'), { name }) };
        }
        if (r.action === 'create' && !active.has(r.stage_key)) {
            return { ok: false, error: fill(t('Для «{name}» не выбрана видимая колонка.'), { name }) };
        }
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Binotel dispositions in plain Russian
// ---------------------------------------------------------------------------
// The routing screen is read by the person who answers the phone, not by an
// integrator: they must recognise the outcome, not the API word. The raw code
// still shows next to the label on screen so a support call can quote it.
//
// Some words differ from telephony-logic.js's call-log labels ON PURPOSE:
// the log describes ONE call that already happened («Отвечен»), while this
// screen describes a RULE about a class of calls («Ответили» → make a card).
//
// «Занято» is written bare here even though telephony-logic.js avoided it for
// the call log — see the note in dispositionRu below.
const DISPOSITION_RU = {
    ANSWER:       'Ответили',
    NOANSWER:     'Не ответили',
    // NOT the bare «Занято»: that source string is already in i18n-strings.js
    // as the bed board's "Occupied", and tr() is keyed by the source string —
    // a busy phone line would translate as an occupied bed in EN/UZ. Same
    // trap telephony-logic.js hit; same escape.
    BUSY:         'Линия занята',
    CANCEL:       'Отменён',
    TRANSFER:     'Переведён',
    ONLINE:       'Идёт разговор',
    CONGESTION:   'Не удалось соединить',
    CHANUNAVAIL:  'Не удалось соединить',
    VM:           'Голосовая почта',
    'VM-SUCCESS': 'Голосовая почта',
    // Binotel reports fax results as bare SUCCESS/FAILED — no other event
    // type uses those two words, so they are unambiguous despite the names.
    SUCCESS:      'Факс',
    FAILED:       'Факс',
};

/**
 * disposition code → the Russian words the routing screen shows. Every SMS-*
 * code (SMS-SENT, SMS-DELIVERED, SMS-FAILED, …) collapses to «SMS»: they are
 * one routing decision, and Binotel keeps adding members to that family.
 * An unknown code shows its RAW string rather than an em-dash — a rule the
 * owner cannot name is a rule they cannot set, and the raw word at least
 * identifies it.
 */
export function dispositionRu(code) {
    if (typeof code !== 'string' || code.trim() === '') return '—';
    const c = code.trim().toUpperCase();
    if (c.startsWith('SMS-') || c === 'SMS') return 'SMS';
    return DISPOSITION_RU[c] || code.trim();
}

/** The two things a routing row can do, in the order the screen offers them. */
export const ROUTING_ACTIONS = [
    { value: 'create', label: 'Создать заявку' },
    { value: 'ignore', label: 'Не создавать' },
];

// ---------------------------------------------------------------------------
// crm_config_get's reply → what each consumer needs
// ---------------------------------------------------------------------------

// A row is usable if it can be rendered and referenced at all. Deliberately
// looser than validateStages(): this is READ path — the board shows what the
// database holds even if a hand-edited row would not pass the save guards.
function usableRow(r) {
    return !!r && typeof r === 'object'
        && typeof r.key === 'string' && r.key.trim() !== ''
        && typeof r.label === 'string' && r.label.trim() !== '';
}

/**
 * The settings screen's view of the reply: the three lists, always arrays,
 * always ordered, with is_active normalised to 1/0 and a `kind` on every
 * stage. Anything unusable falls back to today's board so the screen has
 * something real to edit rather than an empty form.
 */
export function shapeConfig(data) {
    const raw = (data && typeof data === 'object') ? data : {};
    let stages = sortByPosition((Array.isArray(raw.stages) ? raw.stages : []).filter(usableRow));
    let sources = sortByPosition((Array.isArray(raw.sources) ? raw.sources : []).filter(usableRow));
    if (!stages.length) stages = DEFAULT_STAGES.slice();
    if (!sources.length) sources = DEFAULT_SOURCES.slice();

    const norm = (r, extra) => ({
        key: r.key,
        label: r.label,
        position: Number(r.position) || 0,
        // A row that does not SAY whether it is active is treated as visible.
        // truthy() alone would read a missing field as "hidden", and an older
        // server that omits the column would empty the board — the exact
        // failure this whole fallback exists to prevent. Only an explicit 0 /
        // false hides a row.
        is_active: (r.is_active == null || truthy(r.is_active)) ? 1 : 0,
        ...extra(r),
    });
    return {
        stages: withPositions(stages.map((s) => norm(s, (r) => ({
            // '' is the real neutral token; 'none' is folded into it here so
            // the swatch row can compare with ===, and so a save never sends
            // the alias back.
            color: isValidColor(r.color) ? normalizeColor(r.color) : '',
            // A stage with no kind is an 'open' one: that is the harmless
            // default — it neither claims the conversion flow nor counts as
            // a loss in the funnel.
            kind: KIND_VALUES.includes(r.kind) ? r.kind : 'open',
            role: STAGE_ROLES.includes(r.role) ? r.role : null,   // CRM_STAGE_ROLES_V1
        })))),
        // CRM_NO_SHOW_ANY_COLUMN_V1 (ревью F1) — колонки, в которые звонки заводят заявки (любая АТС):
        // открытой колонкой «Не пришёл» им не быть. Сервер старше экрана — пусто (откажет сервер).
        routed: (Array.isArray(raw.routed_stages) ? raw.routed_stages : []).filter((k) => typeof k === 'string' && k),
        // CRM_STAGE_ROLES_V1 — прислал ли сервер роли (запасная воронка — с ролями миграции 284).
        // Нет — сервер старше экрана: доска угадывает колонку записи по-старому.
        hasRoles: Array.isArray(raw.stages) && raw.stages.filter(usableRow).length ? hasStageRoles(raw.stages) : true,
        // CLINIC_API_STEP7_V1 — источник подключения API: чей и свой ли
        // (services/crm/config.js listSources). Своих экран не правит.
        sources: withPositions(sources.map((s) => norm(s, (r) => ({
            api: r.api && typeof r.api === 'object'
                ? { connection_id: Number(r.api.connection_id) || null, connection_name: String(r.api.connection_name || ''),
                    owned: !!r.api.owned, archived: !!r.api.archived }
                : null,
        })))),
        // CRM_HEAD_MERGE_TAGS_V1 — метки. Запасного набора у них нет: пусто —
        // значит клиника меток не завела (или сервер старше экрана).
        tags: withPositions(sortByPosition((Array.isArray(raw.tags) ? raw.tags : []).filter(usableRow))
            .map((s) => norm(s, (r) => ({ color: isValidColor(r.color) ? normalizeColor(r.color) : '' })))),
        routing: (Array.isArray(raw.routing) ? raw.routing : [])
            .filter((r) => r && typeof r === 'object' && typeof r.disposition === 'string' && r.disposition.trim() !== '')
            .map((r) => ({
                provider: typeof r.provider === 'string' && r.provider ? r.provider : 'binotel',
                disposition: r.disposition.trim(),
                action: r.action === 'create' ? 'create' : 'ignore',
                stage_key: typeof r.stage_key === 'string' && r.stage_key ? r.stage_key : null,
            })),
        // CRM_UNIFY_V1 — «Колонка записи» и окно повторного обращения (crm_settings,
        // мигр. 237). Сервер старше экрана настроек не присылает — правило по
        // умолчанию и 72 часа. «Колонка конверсии» здесь не нужна: это вид won.
        settings: {
            booked_stage: raw.settings && typeof raw.settings.booked_stage === 'string' && raw.settings.booked_stage ? raw.settings.booked_stage : null,
            window_hours: raw.settings && Number(raw.settings.window_hours) > 0 ? Number(raw.settings.window_hours) : 72,
        },
    };
}

/**
 * The BOARD's view of the reply (views/crm.js). Returns exactly the shapes
 * crm.js's ~20 call sites already expect, so wiring the config in did not
 * mean rewriting the board:
 *
 *   statuses  [[key, label, tagKind]]  — ACTIVE stages only, in order: the columns
 *   statusRu  {key: [label, tagKind]}  — ALL stages, active or not
 *   sources   [[key, label]]           — ACTIVE sources only, in order: the chips
 *   sourceRu  {key: label}             — ALL sources
 *
 * The *_RU maps deliberately cover the HIDDEN rows too. Hiding a stage stops
 * the board offering it; it does not delete the leads already sitting in it,
 * and those cards must still say «Нецелевой» rather than `not_qualified`.
 *
 * lostStatuses likewise counts hidden stages: a lead lost in a column the
 * clinic has since retired is still a lost lead in the funnel report.
 */
export function boardConfig(data) {
    const cfg = shapeConfig(data);
    const won = cfg.stages.find((s) => s.kind === 'won');
    const noShowKey = cfg.hasRoles ? roleKey(cfg.stages, 'no_show') : null;   // CRM_NO_SHOW_ANY_COLUMN_V1
    return {
        statuses: cfg.stages.filter((s) => s.is_active).map((s) => [s.key, s.label, tagKind(s.color)]),
        statusRu: Object.fromEntries(cfg.stages.map((s) => [s.key, [s.label, tagKind(s.color)]])),
        sources: cfg.sources.filter((s) => s.is_active).map((s) => [s.key, s.label]),
        sourceRu: Object.fromEntries(cfg.sources.map((s) => [s.key, s.label])),
        // No `won` row at all (an older/hand-edited table) → today's 'came'.
        // CONVERT_STATUS can never be undefined: it is the only path that
        // registers a patient.
        convertStatus: won ? won.key : FALLBACK_CONVERT_STAGE,
        // CRM_NO_SHOW_ANY_COLUMN_V1 — колонка с ролью «не пришёл» бывает открытой: для доски она неявка
        // (как у сервера, config.js openStageKeys / lostStageKeys) — не среди активных, среди потерянных.
        activeStatuses: cfg.stages.filter((s) => s.is_active && s.kind === 'open' && s.key !== noShowKey).map((s) => s.key),
        lostStatuses: [...cfg.stages.filter((s) => s.kind === 'lost').map((s) => s.key),
            ...cfg.stages.filter((s) => s.kind === 'open' && s.key === noShowKey).map((s) => s.key)],
        // CRM_HEAD_MERGE_TAGS_V1 — метки: tags [[key, label, tagKind]] — ВИДИМЫЕ,
        // их предлагают окно заявки и фильтр; tagRu {key: [label, tagKind]} —
        // ВСЕ, потому что скрытая метка на карточке, где уже стоит, остаётся
        // подписанной (как скрытая колонка в statusRu).
        tags: cfg.tags.filter((s) => s.is_active).map((s) => [s.key, s.label, tagKind(s.color)]),
        tagRu: Object.fromEntries(cfg.tags.map((s) => [s.key, [s.label, tagKind(s.color)]])),
        // CRM_UNIFY_V1 — «Колонка записи»: куда доска ставит заявку с датой записи.
        // То же правило, что у сервера; null — у воронки без открытой видимой
        // колонки до конверсии (доска тогда статус не трогает).
        // CRM_STAGE_ROLES_V1 — колонка с ролью «запись»; сервер без ролей — прежняя догадка.
        bookedStatus: cfg.hasRoles ? roleKey(cfg.stages, 'booked') : bookedStageKey(cfg.stages, cfg.settings.booked_stage),
    };
}
