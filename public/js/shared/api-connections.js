// CLINIC_API_STEP7_V1 — ПОДКЛЮЧЕНИЯ API: словарь видов, прав и событий; правила
// полей, имени в адресе, IP и срока ключа. Один модуль на экран «API и
// подключения» и сервер (services/api/connections.js): что не пропустит экран,
// то сервер отклонит теми же словами.
//
// Чистый модуль — без window, базы и перевода. Подписи и сообщения — ключи
// словаря (i18n-strings.js): экран переводит их tr(), сервер отдаёт как есть.
import { websiteProblem, normalizeWebsite } from './clinic-profile.js';

export const API_HOST = 'api.easymed.uz';   // решение владельца 7 (2026-10-10)

export const KINDS = Object.freeze(['site', 'symptex', 'partner']);
export const KIND_INFO = Object.freeze({
  site:    { label: 'Сайт клиники', icon: 'Globe', desc: 'Сайт, который Easy-Med делает для клиники, или собственный сайт клиники.' },
  symptex: { label: 'Symptex', icon: 'Sparkles', desc: 'Маркетплейс клиник: карточка клиники, врачи и онлайн-запись.' },
  partner: { label: 'Партнёр', icon: 'Link', desc: 'Площадки вроде med24.uz или clinics.uz: показывают клинику и присылают пациентов.' },
});

export const READ_SCOPES = Object.freeze(['clinic', 'branches', 'doctors', 'services', 'packages', 'slots']);
export const WRITE_SCOPES = Object.freeze(['requests', 'appointments', 'cancel']);
export const SCOPES = Object.freeze([...READ_SCOPES, ...WRITE_SCOPES]);
export const SCOPE_INFO = Object.freeze({
  clinic:       { label: 'О клинике', desc: 'Название, описание, логотипы, контакты, соцсети, карта' },
  branches:     { label: 'Филиалы', desc: 'Город и район (коды из справочника), адрес на трёх языках, телефоны, часы, маршрут' },
  doctors:      { label: 'Врачи', desc: 'Публичный профиль, специальности (коды из справочника), стаж, фото, цены консультаций' },
  services:     { label: 'Услуги и цены', desc: 'Пять групп: консультации, лаборатория, диагностика, процедуры, хирургия' },
  packages:     { label: 'Пакеты услуг', desc: 'Состав, цена без скидки и цена пакета, срок действия' },
  slots:        { label: 'Свободное время', desc: 'Окна по 15 минут на столько дней вперёд, на сколько открыта запись у врача (7, 14 или 30); у врачей с живой очередью — часы приёма' },   // DOCTOR_PROFILE_V1 — срок записи у каждого врача (Р8)
  requests:     { label: 'Заявки', desc: 'Пациент оставляет имя и телефон. В CRM появляется карточка заявки.' },
  appointments: { label: 'Запись на приём', desc: 'Пациент выбирает свободное время. В CRM появляется заявка с выбранным временем.' },
  cancel:       { label: 'Отмена записи', desc: 'Пациент отменяет свою запись на сайте или у партнёра.' },
});

// Четыре события макета и три исхода онлайн-записи — их шлёт окно заявки
// шага 8 («Подтвердить / Предложить другое время / Отклонить»).
export const EVENTS = Object.freeze(['request.accepted', 'appointment.created', 'booking.confirmed',
  'booking.offered_other_time', 'booking.declined', 'appointment.cancelled', 'appointment.arrived']);
export const EVENT_INFO = Object.freeze({
  'request.accepted':           { label: 'Заявка принята', desc: 'Администратор взял заявку в работу' },
  'appointment.created':        { label: 'Пациент записан', desc: 'Клиника записала пациента по заявке: время занято' },
  'booking.confirmed':          { label: 'Онлайн-запись подтверждена', desc: 'Администратор подтвердил время, которое выбрал пациент' },
  'booking.offered_other_time': { label: 'Предложено другое время', desc: 'Клиника предложила пациенту другое время вместо выбранного' },
  'booking.declined':           { label: 'Онлайн-запись отклонена', desc: 'Клиника не может принять пациента в выбранное время' },
  'appointment.cancelled':      { label: 'Запись отменена', desc: 'Клиника или пациент отменили запись' },
  'appointment.arrived':        { label: 'Пациент пришёл', desc: 'Регистратура отметила приход пациента' },
});

export const RATE_LIMITS = Object.freeze([30, 60, 120, 300]);
export const KEY_TTLS = Object.freeze(['never', '3m', '6m', '1y']);
export const KEY_TTL_LABEL = Object.freeze({ never: 'Без срока', '3m': '3 месяца', '6m': '6 месяцев', '1y': '1 год' });
const TTL_MONTHS = Object.freeze({ '3m': 3, '6m': 6, '1y': 12 });
export const EXPIRY_WARN_DAYS = 14;

const ALL_EVENTS_BUT_ARRIVED = EVENTS.filter((e) => e !== 'appointment.arrived');
export const DEFAULTS = Object.freeze({
  site:    Object.freeze({ scopes: [...SCOPES], events: [], rate_limit: 120, key_ttl: 'never' }),
  symptex: Object.freeze({ scopes: [...SCOPES], events: [...EVENTS], rate_limit: 300, key_ttl: 'never' }),
  partner: Object.freeze({ scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'],
    events: ALL_EVENTS_BUT_ARRIVED, rate_limit: 60, key_ttl: '1y' }),
});

export const KEY_PREFIX = 'em_live_';
export const SECRET_PREFIX = 'em_whsec_';
// Без 0/O и 1/l/I: ключ иногда диктуют по телефону. 32 знака ≈ 187 бит.
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const KEY_BODY_LEN = 32;
export const KEY_RE = new RegExp('^' + KEY_PREFIX + '[' + KEY_ALPHABET + ']{' + KEY_BODY_LEN + '}$');
export const SECRET_RE = new RegExp('^' + SECRET_PREFIX + '[' + KEY_ALPHABET + ']{' + KEY_BODY_LEN + '}$');

export const NAME_MAX = 64;
export const CONTACT_MAX = 120;
export const URL_MAX = 300;
export const IP_MAX = 20;
export const RESERVED_SLUGS = Object.freeze(['api', 'www', 'admin', 'app', 'docs', 'status', 'help', 'support',
  'static', 'cdn', 'assets', 'auth', 'login', 'settings', 'billing', 'v1', 'easymed']);

export const API_MESSAGES = Object.freeze({
  kind:                    'Неизвестный вид подключения.',
  name:                    'Введите название подключения.',
  nameLong:                'Название — не длиннее 64 знаков.',
  contactLong:             'Контакт — не длиннее 120 знаков.',
  httpRefused:             'Адрес должен начинаться с https://. Обычный http не принимаем: по нему заявки шли бы открытым текстом.',
  webhookUrl:              'Введите полный адрес в интернете, например https://partner.uz/hooks/easymed',
  urlLong:                 'Адрес — не длиннее 300 знаков.',
  scopesEmpty:             'Отметьте хотя бы одно право.',
  scopesUnknown:           'Неизвестное право подключения.',
  appointmentsNeedSlots:   'Запись на приём требует права «Свободное время».',
  cancelNeedsAppointments: 'Отмена записи требует права «Запись на приём».',
  eventsUnknown:           'Неизвестное событие уведомлений.',
  rate:                    'Лимит запросов — 30, 60, 120 или 300 в минуту.',
  ttl:                     'Срок действия ключа — без срока, 3 месяца, 6 месяцев или 1 год.',
  ipFormat:                'Разрешённые IP-адреса — по одному в строке, например 203.0.113.7 или 203.0.113.0/24.',
  ipTooMany:               'Не больше 20 разрешённых адресов.',
  active:                  'Неверное значение «Подключение включено».',
  slugFormat:              'Только латинские буквы, цифры и дефис, от 3 до 40 знаков; без дефиса в начале и в конце.',
  slugReserved:            'Это имя занято адресами самого Easy-Med — выберите другое.',
});

// ---- имя в адресе ------------------------------------------------------------
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export function normalizeSlug(v) { return String(v ?? '').trim().toLowerCase(); }
export function slugProblem(v) {
  const s = normalizeSlug(v);
  if (!SLUG_RE.test(s)) return API_MESSAGES.slugFormat;
  return RESERVED_SLUGS.includes(s) ? API_MESSAGES.slugReserved : '';
}
// Предложение из латинских названий «Компании» (name_en, name_uz): первое, из
// которого вышло допустимое имя. Кириллица не транслитерируется — пусто.
export function suggestSlug(...names) {
  for (const n of names) {
    const s = String(n || '').toLowerCase().replace(/[‘’ʻʼ'`]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    if (s && !slugProblem(s)) return s;
  }
  return '';
}
export function apiBaseUrl(slug) {
  const s = normalizeSlug(slug);
  return s && !slugProblem(s) ? 'https://' + API_HOST + '/' + s + '/v1/' : '';
}

// ---- адреса ------------------------------------------------------------------
// Сайт подключения проверяется ТЕМ ЖЕ правилом, что «Сайт» в «Компании»
// (shared/clinic-profile.js): одно правило на одно понятие.
export const siteUrlProblem = (v) => websiteProblem(v);
export function normalizeUrl(v) {
  const s = String(v ?? '').trim();
  return /^https:\/\//i.test(s) ? 'https://' + s.slice(8) : s;
}
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const PUBLIC_HOST_RE = new RegExp('^(?:' + LABEL + '\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$');
const LOCAL_TLD_RE = /\.(?:local|localhost|internal|lan|home|corp|test|invalid|example)$/;
// Вебхук: https и доменное имя в интернете — не IP, не localhost, не .local.
// Отправлять будет публичный сервер (шаг 8): адрес его собственной сети был бы
// подделкой запроса изнутри (SSRF). Шаг 8 проверяет ещё раз при отправке.
export function webhookUrlProblem(v) {
  const s = normalizeUrl(v);
  if (!s) return '';
  if (s.length > URL_MAX) return API_MESSAGES.urlLong;
  if (/^http:\/\//i.test(s)) return API_MESSAGES.httpRefused;
  let u;
  try { u = new URL(s); } catch { return API_MESSAGES.webhookUrl; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password) return API_MESSAGES.webhookUrl;
  if (!PUBLIC_HOST_RE.test(host) || LOCAL_TLD_RE.test(host)) return API_MESSAGES.webhookUrl;
  return '';
}

// ---- разрешённые IP ----------------------------------------------------------
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}(?:\\/(?:3[0-2]|[12]?\\d))?$');
const IPV6_RE = /^[0-9a-f:]{2,39}(?:\/(?:12[0-8]|1[01]\d|[1-9]?\d))?$/i;
function ipv6Ok(s) {
  if (!IPV6_RE.test(s) || !s.includes(':')) return false;
  const addr = s.split('/')[0];
  const doubles = (addr.match(/::/g) || []).length;
  if (doubles > 1) return false;
  const groups = addr.split(':').filter((g) => g !== '');
  return groups.every((g) => g.length <= 4) && (doubles ? groups.length < 8 : groups.length === 8);
}
export function normalizeIpList(v) {
  return String(v ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).join('\n');
}
export function ipListProblem(v) {
  const list = normalizeIpList(v).split('\n').filter(Boolean);
  if (list.length > IP_MAX) return API_MESSAGES.ipTooMany;
  return list.every((s) => IPV4_RE.test(s) || ipv6Ok(s)) ? '' : API_MESSAGES.ipFormat;
}

// ---- права и события -----------------------------------------------------------
export function scopesProblem(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) return API_MESSAGES.scopesEmpty;
  if (scopes.some((s) => !SCOPES.includes(s)) || new Set(scopes).size !== scopes.length) return API_MESSAGES.scopesUnknown;
  if (scopes.includes('appointments') && !scopes.includes('slots')) return API_MESSAGES.appointmentsNeedSlots;
  if (scopes.includes('cancel') && !scopes.includes('appointments')) return API_MESSAGES.cancelNeedsAppointments;
  return '';
}
export function eventsProblem(events) {
  if (!Array.isArray(events) || events.some((e) => !EVENTS.includes(e)) || new Set(events).size !== events.length) {
    return API_MESSAGES.eventsUnknown;
  }
  return '';
}
export const orderedScopes = (list) => SCOPES.filter((s) => (list || []).includes(s));
export const orderedEvents = (list) => EVENTS.filter((e) => (list || []).includes(e));

// ---- подключение целиком ----------------------------------------------------------
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Только присланные поля: правка карточки шлёт изменённое. */
export function normalizeConnection(v = {}) {
  const out = {};
  for (const k of ['kind', 'name', 'contact']) if (own(v, k)) out[k] = String(v[k] ?? '').trim();
  if (own(v, 'site_url')) out.site_url = normalizeWebsite(v.site_url);
  if (own(v, 'webhook_url')) out.webhook_url = normalizeUrl(v.webhook_url);
  for (const k of ['scopes', 'webhook_events']) if (own(v, k)) out[k] = Array.isArray(v[k]) ? v[k].map((x) => String(x)) : v[k];
  if (own(v, 'rate_limit')) out.rate_limit = Number(v.rate_limit);
  if (own(v, 'key_ttl')) out.key_ttl = String(v.key_ttl ?? '');
  if (own(v, 'ip_allow')) out.ip_allow = normalizeIpList(v.ip_allow);
  if (own(v, 'active')) out.active = v.active === true || v.active === 1 ? 1 : v.active === false || v.active === 0 ? 0 : v.active;
  return out;
}
/** { поле: сообщение }. partial — проверить только присланное. */
export function connectionProblems(v, { partial = false } = {}) {
  const p = {};
  const has = (k) => !partial || own(v, k);
  if (has('kind') && !KINDS.includes(v.kind)) p.kind = API_MESSAGES.kind;
  if (has('name')) {
    const n = String(v.name ?? '');
    if (!n) p.name = API_MESSAGES.name; else if (n.length > NAME_MAX) p.name = API_MESSAGES.nameLong;
  }
  if (has('site_url')) { const m = siteUrlProblem(v.site_url || ''); if (m) p.site_url = m; }
  if (has('contact') && String(v.contact ?? '').length > CONTACT_MAX) p.contact = API_MESSAGES.contactLong;
  if (has('scopes')) { const m = scopesProblem(v.scopes); if (m) p.scopes = m; }
  if (has('webhook_url')) { const m = webhookUrlProblem(v.webhook_url || ''); if (m) p.webhook_url = m; }
  if (has('webhook_events')) { const m = eventsProblem(v.webhook_events ?? []); if (m) p.webhook_events = m; }
  if (has('rate_limit') && own(v, 'rate_limit') && !RATE_LIMITS.includes(v.rate_limit)) p.rate_limit = API_MESSAGES.rate;
  if (has('key_ttl') && own(v, 'key_ttl') && !KEY_TTLS.includes(v.key_ttl)) p.key_ttl = API_MESSAGES.ttl;
  if (has('ip_allow') && own(v, 'ip_allow')) { const m = ipListProblem(v.ip_allow); if (m) p.ip_allow = m; }
  if (has('active') && own(v, 'active') && v.active !== 0 && v.active !== 1) p.active = API_MESSAGES.active;
  return p;
}

export function maskSecret(prefix, tail) { return tail ? prefix + '••••' + tail : ''; }

// Источник CRM подключения: api_<латиница названия>, иначе по виду; свободный.
export function apiSourceKey(name, kind, taken = []) {
  const used = new Set(taken);
  const latin = String(name || '').toLowerCase().replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/, '');
  const base = 'api_' + (latin || (kind === 'symptex' ? 'symptex' : 'partner'));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const k = base.slice(0, 32 - String(n).length - 1).replace(/_+$/, '') + '_' + n;
    if (!used.has(k)) return k;
  }
  throw new Error('no free CRM source key');
}

// ---- срок ключа --------------------------------------------------------------------
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export function keyExpiresAt(issuedIso, ttl) {
  const months = TTL_MONTHS[ttl];
  if (!months) return null;
  const d = new Date(issuedIso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
/** 'none' | 'ok' | 'soon' (≤ 14 дней) | 'expired'. */
export function keyExpiryState(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'none';
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 'none';
  if (t <= now) return 'expired';
  return t - now <= EXPIRY_WARN_DAYS * 86400000 ? 'soon' : 'ok';
}
