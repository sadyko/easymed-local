// CLINIC_API_STEP7_V1 — ОБЩИЕ КУСОЧКИ ЭКРАНА «API И ПОДКЛЮЧЕНИЯ»: RPC, поле
// ключа, разделы и поля формы, права и журнал, окно. Их делят страница
// (api-connections.js), «Новое подключение» (api-connection-new.js) и карточка
// подключения (api-connection-card.js).
//
// Значение ключа или секрета живёт только в поле открытого окна — не в
// localStorage, не в адресе страницы, не в console. Скрытое поле держит маску;
// значение экран спрашивает у сервера (api_connection_reveal) только по нажатию
// «Показать» или «Скопировать» — каждое такое открытие сервер пишет в журнал.
// Буфер обмена браузер даёт только защищённой странице (https или localhost):
// в сети Easy-Med открывают по http — тогда значение выделяется для Ctrl+C.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, toast, fmtDate, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import {
  KINDS, KIND_INFO, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, RATE_LIMITS, KEY_TTLS, KEY_TTL_LABEL,
  NAME_MAX, CONTACT_MAX, keyExpiryState,
} from '../../shared/api-connections.js';

export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const e = new Error(error.message || 'Не удалось выполнить запрос.');
    e.code = error.code || '';
    throw e;
  }
  return data;
}

/** Ответ api_settings_get — с запасными значениями: сервер старше экрана присылает меньше. */
export function shapeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const can = r.can && typeof r.can === 'object' ? r.can : {};
  return {
    slug: String(r.slug || ''), base_url: String(r.base_url || ''), slug_suggestion: String(r.slug_suggestion || ''),
    public_server: !!r.public_server, building_role: r.building_role === 'secondary' ? 'secondary' : 'main',
    clinic_name: String(r.clinic_name || ''), company_website: String(r.company_website || ''),
    partner_address_missing: Array.isArray(r.partner_address_missing) ? r.partner_address_missing : [],
    can: { view: !!can.view, edit: !!can.edit, admin: !!can.admin },
    connections: Array.isArray(r.connections) ? r.connections : [],
  };
}

export async function copyText(text) {
  const cb = (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
  try {
    if (!cb || typeof cb.writeText !== 'function') throw new Error('no clipboard');
    await cb.writeText(text);
    toast(tr('Скопировано'), 'ok');
    return true;
  } catch {
    toast(tr('Скопируйте вручную'), 'info');
    return false;
  }
}

/**
 * Поле ключа, секрета или адреса: значение, «Показать» (если его надо спросить у
 * сервера), «Скопировать», по желанию — «Сгенерировать новый».
 *   value    — известное значение (черновик, только что выпущенный ключ, адрес API);
 *   mask     — маска, пока значение не спрошено;
 *   getValue — спросить значение у сервера (api_connection_reveal).
 */
export function secretField({ label, value = '', mask = '', getValue = null, regen = null, viewOk = false }) {
  let known = value || '';
  let shown = !!known;
  const input = h('input', { type: 'text', readonly: 'readonly', class: 'apic-secret cell-mono', spellcheck: 'false',
    translate: 'no', autocomplete: 'off', 'aria-label': label });
  input.value = known || mask;
  input.addEventListener('focus', () => { try { input.select(); } catch { /* выделение — удобство */ } });
  const ensure = async () => { if (!known && getValue) known = await getValue(); return known; };
  // CLINIC_API_STEP7_V1 (ревью №2, №6) — значение, пришедшее уже открытым, — кнопка
  // сразу «Скрыть»; viewOk — «Показать / Скопировать» не правка: рамка «только
  // просмотр» (view-only.js) их не перехватывает.
  const ok = viewOk ? { viewOk: '1' } : null;
  const showBtn = getValue ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-apic-act': 'show', dataset: ok }, shown ? 'Скрыть' : 'Показать') : null;
  if (showBtn) showBtn.addEventListener('click', async () => {
    if (shown) { shown = false; input.value = mask; showBtn.textContent = tr('Показать'); return; }
    try { input.value = await ensure(); shown = true; showBtn.textContent = tr('Скрыть'); }
    catch (e) { toast(tr(e.message), 'fail'); }
  });
  const copyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'copy', dataset: ok },
    Icon('Copy', { size: 13 }), ' ', 'Скопировать');
  copyBtn.addEventListener('click', async () => {
    let v;
    try { v = await ensure(); } catch (e) { toast(tr(e.message), 'fail'); return; }
    if (await copyText(v)) return;
    // Буфера нет — значение в поле и выделено: Ctrl+C его копирует.
    input.value = v; shown = true;
    if (showBtn) showBtn.textContent = tr('Скрыть');
    try { input.focus(); input.select(); } catch { /* выделение — удобство */ }
  });
  const regenBtn = regen
    ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-apic-act': 'regen' }, Icon('Refresh', { size: 13 }), ' ', regen.label)
    : null;
  if (regenBtn) regenBtn.addEventListener('click', () => regen.onClick());
  const box = h('div', { class: 'apic-keyfield' }, input, showBtn, copyBtn, regenBtn);
  box.setValue = (v) => { known = v; shown = true; input.value = v; if (showBtn) showBtn.textContent = tr('Скрыть'); };
  box.input = input;
  return box;
}

export function section(title, sub, ...children) {
  return h('section', { class: 'apic-sec' },
    h('h4', { class: 'apic-sec-title' }, title, sub ? h('span', { class: 'apic-sec-sub' }, sub) : null), ...children);
}
export function fieldBox(label, control, error, hint, { required = false, id = null } = {}) {
  return h('div', { class: 'field' + (error ? ' has-error' : '') },
    h('label', id ? { for: id } : null, label, required ? h('span', { class: 'req' }, ' *') : null),
    control,
    hint ? h('div', { class: 'hint' }, hint) : null,
    error ? h('div', { class: 'apic-err', role: 'alert' }, error) : null);
}
export function textInput(id, value, onInput, { disabled = false, placeholder = '', maxlength = 0, inputmode = '' } = {}) {
  const el = h('input', { type: 'text', id, placeholder, disabled, autocomplete: 'off',
    maxlength: maxlength ? String(maxlength) : null, inputmode: inputmode || null });
  el.value = value || '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}
export function checkList(name, keys, info, chosen, onToggle, { disabled = false, cls = '' } = {}) {
  return h('div', { class: 'apic-checks' + (cls ? ' ' + cls : '') }, ...keys.map((k) => {
    const id = 'apic-' + name + '-' + k.replace(/\./g, '-');
    const box = h('input', { type: 'checkbox', id, value: k, disabled, checked: chosen.includes(k) });
    box.addEventListener('change', () => onToggle(k, !!box.checked));
    return h('label', { class: 'apic-check', for: id }, box, h('b', null, info[k].label), h('span', null, info[k].desc));
  }));
}
export function kindPicker(current, onPick, { siteTaken = true } = {}) {
  return h('div', { class: 'apic-kinds', role: 'radiogroup', 'aria-label': 'Кто подключается' }, ...KINDS.map((k) => {
    const K = KIND_INFO[k];
    // Р10 — сайт клиники создаётся сам и один: в окне он виден, но не выбирается.
    const off = k === 'site' && siteTaken;
    const b = h('button', { class: 'apic-kind', type: 'button', role: 'radio', 'aria-checked': String(current === k),
      'data-apic-kind': k, disabled: off },
      h('span', { class: 'apic-ico t-' + k }, Icon(K.icon, { size: 18 })),
      h('span', null, h('b', null, K.label), h('span', { class: 'apic-sub' }, off ? 'Подключение сайта клиники уже есть — оно создаётся само.' : K.desc)));
    if (!off) b.addEventListener('click', () => onPick(k));
    return b;
  }));
}
export function permChips(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const read = READ_SCOPES.filter((k) => list.includes(k));
  const write = WRITE_SCOPES.filter((k) => list.includes(k));
  const chips = [];
  if (read.length === READ_SCOPES.length) chips.push(h('span', { class: 'apic-chip' }, 'Все данные клиники'));
  else for (const k of read) chips.push(h('span', { class: 'apic-chip' }, SCOPE_INFO[k].label));
  for (const k of write) chips.push(h('span', { class: 'apic-chip w' }, SCOPE_INFO[k].label));
  if (!write.length) chips.push(h('span', { class: 'apic-chip ro' }, 'Только просмотр'));
  return h('div', { class: 'apic-chips' }, ...chips);
}
/** Метка срока ключа: за 14 дней — «истекает», после — «истёк». */
export function expiryTag(c, now = Date.now()) {
  const st = keyExpiryState(c.key_expires_at, now);
  if (st === 'expired') return Tag(tr('Ключ истёк'), { kind: 'crit' });
  if (st === 'soon') return Tag(trf('Ключ истекает {date}', { date: fmtDate(c.key_expires_at) }), { kind: 'warn' });
  return null;
}

export const ACTION_LABEL = Object.freeze({
  slug_saved: 'Изменено имя в адресе', created: 'Подключение создано', updated: 'Настройки изменены',
  enabled: 'Подключение включено', disabled: 'Подключение выключено', key_revealed: 'Ключ открыт',
  key_regenerated: 'Выпущен новый ключ', secret_revealed: 'Секрет открыт', secret_regenerated: 'Выпущен новый секрет',
  deleted: 'Подключение удалено',
});
const FIELD_LABEL = Object.freeze({
  name: 'Название', site_url: 'Адрес сайта', contact: 'Контакт', scopes: 'Права', webhook_url: 'Адрес для уведомлений',
  webhook_events: 'События уведомлений', rate_limit: 'Лимит запросов', key_ttl: 'Срок действия ключа', ip_allow: 'Разрешённые IP-адреса',
});
export function actionText(r) {
  const head = tr(ACTION_LABEL[r.action] || r.action);
  const d = r.detail || {};
  if (r.action === 'slug_saved') return head + ': ' + (d.from || '—') + ' → ' + (d.to || '—');
  if (r.action === 'updated' && Array.isArray(d.fields)) return head + ': ' + d.fields.map((f) => tr(FIELD_LABEL[f] || f)).join(', ');
  return head;
}
export function journalTable(rows, { withConnection = true } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return h('div', { class: 'empty' }, 'Изменений пока не было.');
  const tb = h('tbody');
  for (const r of list) {
    tb.appendChild(h('tr', null,
      h('td', { class: 'apic-nowrap' }, fmtDateTime(r.at)),
      h('td', null, r.user_name || '—'),
      withConnection ? h('td', null, r.connection_name || '—') : null,
      h('td', null, actionText(r))));
  }
  return h('div', { class: 'apic-tblwrap' }, h('table', { class: 'tbl apic-tbl' },
    h('thead', null, h('tr', null, h('th', null, 'Когда'), h('th', null, 'Кто'),
      withConnection ? h('th', null, 'Подключение') : null, h('th', null, 'Что сделано'))), tb));
}

// CLINIC_API_STEP7_V1 (ревью №11) — открытые окна экрана, верхнее — последнее:
// Escape закрывает только его; по ключу (`key`) то же окно не открывается дважды.
const openModals = [];
let modalSeq = 0;
const FOCUSABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);
/** Первое доступное поле или кнопка внутри root — обход детей, без селекторов. */
function firstFocusable(root) {
  for (const n of Array.from((root && root.children) || [])) {
    const off = !!(n.hasAttribute && (n.hasAttribute('disabled') || n.hasAttribute('hidden')))
      || (n.style && n.style.display === 'none')
      || (n.getAttribute && n.getAttribute('type') === 'hidden');
    if (off) continue;
    if (FOCUSABLE.has(String(n.tagName || '').toUpperCase())) return n;
    const inner = firstFocusable(n);
    if (inner) return inner;
  }
  return null;
}
// Окно, которое убрали из документа мимо close() (перерисовка оболочки), — уже не
// открыто: его запись и слушатель Escape снимаются.
const inBody = (el) => Array.from((document.body && document.body.children) || []).includes(el);
function pruneModals() {
  for (const x of [...openModals]) if (!inBody(x.handle.overlay)) x.dispose();
}
/** Уже открытое окно с этим ключом — или null. */
export function openModalByKey(key) {
  pruneModals();
  const entry = key ? openModals.find((x) => x.key === key) : null;
  return entry ? entry.handle : null;
}

/**
 * Окно. Закрытие убирает его из документа — значения в полях уходят вместе с ним.
 * Ревью №11: имя окна для читалки — его заголовок (aria-labelledby); фокус при
 * открытии — на первом поле (или `initialFocus`), при закрытии — обратно туда,
 * откуда окно открыли; Escape слушает document, а не окно (фокус мог остаться на
 * строке таблицы), и слушатель снимается при закрытии; окно с тем же `key` второй
 * раз не открывается — возвращается открытое.
 */
export function openModal({ title, body, foot, tabs = null, width = 920, name = '', key = '', initialFocus = null }) {
  const already = openModalByKey(key);
  if (already) { try { already.focus(); } catch { /* фокус — удобство */ } return already; }
  const titleId = 'apic-modal-title-' + (++modalSeq);
  const opener = (typeof document !== 'undefined' && document.activeElement) || null;
  const overlay = h('div', { class: 'modal apic-modal', 'data-apic-modal': name });
  let closed = false;
  const entry = { key, handle: null, dispose: null };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    pruneModals();
    if (openModals[openModals.length - 1] !== entry) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    close();
  };
  entry.dispose = () => {
    closed = true;
    document.removeEventListener('keydown', onKey);
    const i = openModals.indexOf(entry);
    if (i > -1) openModals.splice(i, 1);
  };
  function close() {
    if (closed) return;
    entry.dispose();
    try { document.body.removeChild(overlay); } catch { overlay.remove(); }
    if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) {
      try { opener.focus(); } catch { /* фокус — удобство */ }
    }
  }
  const closeBtn = h('button', { class: 'modal-close', type: 'button', onclick: close }, '×');
  const footEl = h('footer', { class: 'modal-foot' }, ...foot);
  const card = h('div', { class: 'modal-card apic-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
    h('header', { class: 'modal-head' }, h('h2', { id: titleId }, ...title), closeBtn),
    tabs, body, footEl);
  overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  const focusInto = () => {
    const target = initialFocus || firstFocusable(body) || firstFocusable(footEl) || closeBtn;
    try { target.focus(); } catch { /* фокус — удобство */ }
  };
  entry.handle = { overlay, close, focus: focusInto };
  openModals.push(entry);
  focusInto();
  return entry.handle;
}

/** Отказ «нет адреса для партнёров» (решение владельца 11) — с дорогой в «Компанию». */
export function addressBlock(message, onNavigate, onLeave = null) {
  const go = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'open-company' },
    Icon('MapPin', { size: 13 }), ' ', 'Открыть «Компанию»');
  go.addEventListener('click', () => { if (onLeave) onLeave(); if (onNavigate) onNavigate('documents-settings'); });
  return h('div', { class: 'apic-confirm', role: 'alert' }, h('p', null, message), h('div', { class: 'apic-row' }, go));
}

// ---- поля подключения (окно «Новое подключение» и карточка) ---------------------
export function basicsFields(d, errs, { disabled = false, isNew = false, sourceLabel = '', companyWebsite = '' } = {}) {
  const kind = d.kind;
  const name = textInput('apic-f-name', d.name, (v) => { d.name = v; }, { disabled, maxlength: NAME_MAX,
    placeholder: kind === 'partner' ? 'Например, med24.uz' : kind === 'symptex' ? 'Symptex' : 'Сайт клиники' });
  // Р10 — адрес сайта клиники один: поле «Сайт» в «Компании»; здесь он только виден.
  const site = kind === 'site'
    ? h('div', { class: 'apic-readonly cell-mono', translate: 'no' }, companyWebsite || '—')
    : textInput('apic-f-site', d.site_url, (v) => { d.site_url = v; }, { disabled, placeholder: 'https://', inputmode: 'url' });
  const siteHint = kind === 'site'
    ? 'Адрес — из «Компании», поле «Сайт»: меняется там. Если сайт делает Easy-Med, адрес подставится сам.'
    : 'Для справки: где подключение показывает клинику.';
  const contact = kind === 'site' ? null : textInput('apic-f-contact', d.contact, (v) => { d.contact = v; },
    { disabled, maxlength: CONTACT_MAX, placeholder: 'Имя, телефон или почта' });
  const source = isNew
    ? h('p', { class: 'apic-src' }, 'Для заявок этого подключения в CRM появится свой источник с его названием. В настройках CRM его нельзя переименовать, скрыть или удалить.')
    : h('span', { class: 'apic-chip api' }, sourceLabel);
  return h('div', { class: 'apic-grid2' },
    fieldBox('Название', name, errs.name, null, { required: true, id: 'apic-f-name' }),
    fieldBox(kind === 'partner' ? 'Сайт партнёра' : 'Адрес сайта', site, errs.site_url, siteHint, { id: kind === 'site' ? null : 'apic-f-site' }),
    contact ? fieldBox('Контакт у партнёра', contact, errs.contact, 'Кому звонить, если с подключением что-то не так.', { id: 'apic-f-contact' }) : null,
    fieldBox('Источник заявок в CRM', source, null, null));
}
export function accessSections(d, errs, { disabled = false } = {}) {
  const toggle = (k, on) => { d.scopes = on ? [...new Set([...d.scopes, k])] : d.scopes.filter((x) => x !== k); };
  return h('div', null,
    section('Что можно получать', 'данные, которые видит подключение', checkList('read', READ_SCOPES, SCOPE_INFO, d.scopes, toggle, { disabled })),
    section('Что можно отправлять в клинику', 'заявки и записи пациентов', checkList('write', WRITE_SCOPES, SCOPE_INFO, d.scopes, toggle, { disabled, cls: 'three' })),
    errs.scopes ? h('div', { class: 'apic-err', role: 'alert' }, errs.scopes) : null);
}
export function hooksSection(d, errs, { disabled = false, secretEl = null, secretNote = null } = {}) {
  const url = textInput('apic-f-hook', d.webhook_url, (v) => { d.webhook_url = v; },
    { disabled, placeholder: 'https://partner.uz/hooks/easymed', inputmode: 'url' });
  const toggle = (k, on) => { d.webhook_events = on ? [...new Set([...d.webhook_events, k])] : d.webhook_events.filter((x) => x !== k); };
  // Р15 — пробное уведомление честно отправит только публичный сервер (шаг 8):
  // кнопка видна, но выключена, и рядом сказано почему.
  const test = h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: true, 'data-apic-act': 'hook-test',
    'aria-describedby': 'apic-hook-test-why' }, Icon('Send', { size: 13 }), ' ', 'Проверить адрес');
  return section('Уведомления о заявках (вебхук)', 'Easy-Med сообщает подключению, что стало с его заявкой',
    fieldBox('Адрес для уведомлений', url, errs.webhook_url, 'Пусто — уведомления не отправляем. Принимаем только https://.', { id: 'apic-f-hook' }),
    h('div', { class: 'apic-row' }, test,
      h('span', { class: 'hint', id: 'apic-hook-test-why' }, 'Пробное уведомление можно будет отправить, когда в Easy-Med включат публичный сервер.')),
    checkList('events', EVENTS, EVENT_INFO, d.webhook_events, toggle, { disabled }),
    errs.webhook_events ? h('div', { class: 'apic-err', role: 'alert' }, errs.webhook_events) : null,
    secretEl
      ? h('div', { class: 'field' }, h('label', null, 'Секрет для подписи уведомлений'), secretEl,
          h('div', { class: 'hint' }, 'Каждое уведомление будет подписано этим секретом (заголовок X-EasyMed-Signature): так подключение проверит, что уведомление пришло от клиники.'))
      : secretNote,
    h('dl', { class: 'apic-kv' }, h('dt', null, 'Если адрес не ответит'), h('dd', null, 'Повторим 5 раз: через 1, 5, 10, 30 и 60 минут')),
    h('p', { class: 'apic-note' }, Icon('Info', { size: 16 }), h('span', null, 'Уведомления начнут уходить, когда в Easy-Med включат публичный сервер.')));
}
export function securityFields(d, errs, { disabled = false } = {}) {
  const rate = h('select', { id: 'apic-f-rate', disabled },
    ...RATE_LIMITS.map((n) => h('option', { value: String(n) }, trf('{n} в минуту', { n }))));
  rate.value = String(d.rate_limit);
  rate.addEventListener('change', () => { d.rate_limit = Number(rate.value); });
  const ttl = h('select', { id: 'apic-f-ttl', disabled }, ...KEY_TTLS.map((k) => h('option', { value: k }, KEY_TTL_LABEL[k])));
  ttl.value = d.key_ttl;
  ttl.addEventListener('change', () => { d.key_ttl = ttl.value; });
  const ips = h('textarea', { id: 'apic-f-ips', rows: '3', disabled, placeholder: 'По одному на строку', spellcheck: 'false', translate: 'no' });
  ips.value = d.ip_allow || '';
  ips.addEventListener('input', () => { d.ip_allow = ips.value; });
  return section('Безопасность', '',
    h('div', { class: 'apic-grid2' },
      fieldBox('Лимит запросов', rate, errs.rate_limit, 'Сверх лимита подключение получит ответ «429, подождите».', { id: 'apic-f-rate' }),
      fieldBox('Срок действия ключа', ttl, errs.key_ttl, 'За 14 дней до конца срока здесь появится напоминание.', { id: 'apic-f-ttl' })),
    fieldBox('Разрешённые IP-адреса', ips, errs.ip_allow, 'Необязательно. Пусто — запросы с любого адреса, но только с ключом.', { id: 'apic-f-ips' }),
    h('p', { class: 'apic-note' }, Icon('Info', { size: 16 }),
      h('span', null, 'Лимит, срок ключа и разрешённые адреса начнут действовать, когда в Easy-Med включат публичный сервер. Только HTTPS — всегда.')));
}
export function activeField(d, { disabled = false, ready = true } = {}) {
  const box = h('input', { type: 'checkbox', id: 'apic-f-active', checked: !!d.active, disabled });
  box.addEventListener('change', () => { d.active = !!box.checked; });
  return section('Состояние', '',
    h('label', { class: 'apic-check', for: 'apic-f-active' }, box, h('b', null, 'Подключение включено'),
      h('span', null, 'Выключенное подключение не получает данные и не присылает заявки. Настройки сохраняются, включить можно в любой момент.')),
    ready ? null : h('p', { class: 'apic-note warn' }, Icon('Warning', { size: 16 }),
      h('span', null, 'Адрес для партнёров в «Компании» не заполнен: подключение можно сохранить только выключенным. Заполните адрес и включите его.')));
}
