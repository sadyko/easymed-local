// CLINIC_API_STEP7_V1 — окна «Новое подключение» и «Что передать подключению»
// (макет screen-api.js: conn-new, conn-key).
//
// Ключ и секрет вебхука видны ещё до создания — их выпускает сервер
// (api_connection_draft, черновик на 30 минут), «Сгенерировать новый» просит
// новый у того же черновика. При создании браузер называет черновик и НЕ
// присылает ключ: значение берёт сервер (Р6 плана). Проверки полей — те же, что
// у сервера (shared/api-connections.js), до запроса. После «Создать» — окно
// «Что передать подключению» с «Скопировать всё».
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { DEFAULTS, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, normalizeConnection, connectionProblems } from '../../shared/api-connections.js';
import { rpc, secretField, section, fieldBox, kindPicker, basicsFields, accessSections, hooksSection, securityFields,
  activeField, openModal, addressBlock, isAddressRefusal, permChips, copyText } from './api-ui.js';

const KEY_HINT = 'Ключ создан сам. Скопируйте его и передайте вместе с адресом API. Он сохранится, когда вы нажмёте «Создать подключение и ключ»; позже его можно открыть в карточке подключения — видят его только администраторы.';
const defaultsOf = (k) => { const d = DEFAULTS[k] || DEFAULTS.partner; return { scopes: [...d.scopes], webhook_events: [...d.events], rate_limit: d.rate_limit, key_ttl: d.key_ttl }; };

export async function openNewConnection({ settings, onCreated = null, onNavigate = null }) {
  let draft;
  try { draft = await rpc('api_connection_draft', {}); } catch (e) { toast(tr(e.message), 'fail'); return null; }
  const ready = settings.partner_address_missing.length === 0;
  const d = { kind: 'partner', name: '', site_url: '', contact: '', webhook_url: '', ip_allow: '', active: ready, ...defaultsOf('partner') };
  let errs = {};
  let fail = '';   // отказ сервера «нет адреса для партнёров» — с дорогой в «Компанию»
  let failBranches = false;   // CLINIC_API_STEP7_V1 — или в «Филиалы»: адрес филиала на сайте
  let m = null;
  const keyBox = secretField({ label: 'Ключ доступа', value: draft.key, regen: { label: 'Сгенерировать новый', onClick: () => renew('key') } });
  const secretBox = secretField({ label: 'Секрет для подписи уведомлений', value: draft.secret, regen: { label: 'Новый секрет', onClick: () => renew('secret') } });
  const body = h('div', { class: 'modal-body apic-modal-body' });

  async function renew(what) {
    try {
      draft = await rpc('api_connection_draft', { draft_id: draft.draft_id, renew: what });
      keyBox.setValue(draft.key);
      secretBox.setValue(draft.secret);
      toast(tr(what === 'key' ? 'Новый ключ сгенерирован' : 'Новый секрет сгенерирован'), 'ok');
    } catch (e) { toast(tr(e.message), 'fail'); }
  }
  function paint() {
    clear(body);
    if (fail) body.appendChild(addressBlock(fail, onNavigate, () => m.close(), { branches: failBranches }));
    body.appendChild(section('Кто подключается', '', kindPicker(d.kind, (k) => { Object.assign(d, { kind: k }, defaultsOf(k)); paint(); })));
    body.appendChild(section('Основное', '', basicsFields(d, errs, { isNew: true })));
    body.appendChild(section('Ключ доступа', 'подключение передаёт его в каждом запросе', keyBox, h('p', { class: 'hint' }, KEY_HINT)));
    body.appendChild(accessSections(d, errs));
    body.appendChild(hooksSection(d, errs, { secretEl: secretBox }));
    body.appendChild(securityFields(d, errs));
    body.appendChild(activeField(d, { ready }));
  }
  const createBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'create' },
    Icon('Key', { size: 15 }), ' ', 'Создать подключение и ключ');
  createBtn.addEventListener('click', async () => {
    const v = normalizeConnection({ kind: d.kind, name: d.name, site_url: d.site_url, contact: d.contact, scopes: d.scopes,
      webhook_url: d.webhook_url, webhook_events: d.webhook_events, rate_limit: d.rate_limit, key_ttl: d.key_ttl,
      ip_allow: d.ip_allow, active: d.active });
    errs = connectionProblems(v);
    fail = '';
    paint();
    if (Object.keys(errs).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
    createBtn.disabled = true;
    try {
      const r = await rpc('api_connection_create', { draft_id: draft.draft_id, ...v });
      m.close();
      openHandover({ settings, connection: r.connection, key: r.key, secret: r.secret, baseUrl: r.base_url });
      if (onCreated) onCreated();
    } catch (e) {
      createBtn.disabled = false;
      if (isAddressRefusal(e)) { fail = e.message; failBranches = e.code === 'branch_address_required'; d.active = false; paint(); return; }
      toast(tr(e.message), 'fail');
    }
  });
  paint();
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Отмена');
  m = openModal({ name: 'conn-new', title: [Icon('Plus', { size: 18 }), ' ', tr('Новое подключение')], body,
    foot: [cancel, h('span', { class: 'grow' }), createBtn] });
  cancel.addEventListener('click', () => m.close());
  return m;
}

/** Текст «Скопировать всё»: одним сообщением всё, что нужно подключению. */
export function handoverText({ clinic, baseUrl, key, secret, scopes }) {
  const allowed = [...READ_SCOPES, ...WRITE_SCOPES].filter((k) => (scopes || []).includes(k)).map((k) => tr(SCOPE_INFO[k].label));
  const lines = [trf('Подключение к API клиники «{clinic}»', { clinic }), trf('Адрес API: {url}', { url: baseUrl })];
  if (key) lines.push(trf('Ключ: {key}', { key }));
  lines.push(tr('Передавайте ключ в каждом запросе: Authorization: Bearer <ключ>'));
  if (secret) lines.push(trf('Секрет для проверки уведомлений: {secret}', { secret }));
  lines.push(trf('Разрешено: {list}', { list: allowed.join(', ') }));
  lines.push(tr('Работать начнёт, когда в Easy-Med включат публичный сервер.'));
  return lines.join('\n');
}

/** «Что передать подключению» — после создания и после выпуска нового ключа. */
export function openHandover({ settings, connection: c, key, secret = '', baseUrl, rotated = false }) {
  const withSecret = !!(secret && c.webhook_url);
  const text = handoverText({ clinic: settings.clinic_name, baseUrl, key, secret: withSecret ? secret : '', scopes: c.scopes });
  const area = h('textarea', { class: 'apic-handover cell-mono', readonly: 'readonly', rows: '7', translate: 'no', 'aria-label': 'Текст для отправки' });
  area.value = text;
  const lead = rotated
    ? 'Новый ключ сохранён, прежний больше не подходит. Отправьте подключению новый ключ — проще всего кнопкой «Скопировать всё».'
    : 'Ключ сохранён. Отправьте подключению адрес и ключ — проще всего кнопкой «Скопировать всё». Работать они начнут, когда в Easy-Med включат публичный сервер.';
  const body = h('div', { class: 'modal-body apic-modal-body' },
    h('p', { class: 'apic-note ok' }, Icon('Check', { size: 16 }), h('span', null, lead)),
    fieldBox('Адрес API', secretField({ label: 'Адрес API', value: baseUrl }), null, null),
    fieldBox('Ключ', secretField({ label: 'Ключ', value: key }), null, null),
    withSecret ? fieldBox('Секрет для проверки уведомлений', secretField({ label: 'Секрет для проверки уведомлений', value: secret }), null, null) : null,
    section('Что ещё знать', '', h('dl', { class: 'apic-kv' },
      h('dt', null, 'Разрешено'), h('dd', null, permChips(c.scopes)),
      // CLINIC_API_STEP7_V1 (ревью №5) — у сайта клиники имя и источник системные, по-русски
      // («Сайт клиники», «Сайт»): tr() до подстановки в фразу.
      h('dt', null, 'Заявки в CRM'), h('dd', null, trf('с источником «{label}»', { label: tr(c.crm_source_label) })),
      h('dt', null, 'Как передавать ключ'), h('dd', null, h('code', { translate: 'no' }, 'Authorization: Bearer <ключ>')),
      h('dt', null, 'Ключ потом'), h('dd', null, 'Его можно открыть и скопировать в карточке подключения, вкладка «Ключ».'))),
    fieldBox('Текст для отправки', area, null, null));
  const copyAll = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'copy-all' }, Icon('Copy', { size: 15 }), ' ', 'Скопировать всё');
  copyAll.addEventListener('click', async () => {
    if (!(await copyText(text))) { try { area.focus(); area.select(); } catch { /* выделение — удобство */ } }
  });
  const close = h('button', { class: 'btn', type: 'button' }, 'Закрыть');
  const m = openModal({ name: 'conn-key', width: 680, body,
    title: [Icon('Key', { size: 18 }), ' ', rotated ? trf('Новый ключ для «{name}»', { name: tr(c.name) }) : trf('Подключение «{name}» создано', { name: tr(c.name) })],
    foot: [close, h('span', { class: 'grow' }), copyAll] });
  close.addEventListener('click', () => m.close());
  return m;
}
