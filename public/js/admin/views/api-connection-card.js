// CLINIC_API_STEP7_V1 — карточка подключения (макет screen-api.js: MODALS.conn,
// keyPanel). Вкладки: Основное · Доступ · Уведомления · Ключ · Журнал.
//
// Сохраняет только ИЗМЕНЁННОЕ и только то, что этому человеку можно (`can` от
// сервера): «Изменение» — включить, название, сайт, контакт; администратор —
// ещё права, уведомления, безопасность. Ключ и секрет — только администратору:
// «Показать» спрашивает сервер (журнал «Ключ открыт»), «Выпустить новый» — после
// подтверждения, прежний перестаёт подходить сразу. Удаление — архив (Р12), с
// подтверждением; подключение сайта клиники не удаляется.
import { h, Icon, Tag, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { KIND_INFO, KEY_TTL_LABEL, normalizeConnection, connectionProblems, orderedScopes, orderedEvents, normalizeIpList } from '../../shared/api-connections.js';
import { rpc, secretField, section, basicsFields, accessSections, hooksSection, securityFields, activeField, openModal,
  openModalByKey, addressBlock, journalTable, expiryTag } from './api-ui.js';
import { openHandover } from './api-connection-new.js';

const TABS = [['main', 'Основное'], ['access', 'Доступ'], ['hooks', 'Уведомления'], ['key', 'Ключ'], ['log', 'Журнал']];
const EDIT_FIELDS = ['name', 'site_url', 'contact', 'active'];
const ADMIN_FIELDS = ['scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow'];
const TAB_OF = { name: 'main', site_url: 'main', contact: 'main', active: 'main', rate_limit: 'main', key_ttl: 'main', ip_allow: 'main',
  scopes: 'access', webhook_url: 'hooks', webhook_events: 'hooks' };
const comparable = (k, v) => (k === 'scopes' ? orderedScopes(v) : k === 'webhook_events' ? orderedEvents(v)
  : k === 'ip_allow' ? normalizeIpList(v) : k === 'active' ? !!v : v);

export function openConnectionCard({ settings, connection: c, onChanged = null, onNavigate = null, tab = 'main', revealed = null }) {
  // CLINIC_API_STEP7_V1 (ревью №11) — карточка этого подключения уже открыта (Enter
  // дважды на строке, ссылка из CRM) — вторую не строить: фокус в открытую.
  const opened = openModalByKey('conn:' + c.id);
  if (opened) { opened.focus(); return opened; }
  const can = settings.can;
  const d = { kind: c.kind, name: c.name, site_url: c.site_url, contact: c.contact, scopes: [...c.scopes], active: c.active,
    webhook_url: c.webhook_url, webhook_events: [...c.webhook_events], rate_limit: c.rate_limit, key_ttl: c.key_ttl, ip_allow: c.ip_allow };
  let current = tab;
  let errs = {};
  let confirm = '';   // 'key' | 'secret' | 'delete'
  let fail = '';
  let journal = null;
  let m = null;
  const reveal = (what) => async () => (await rpc('api_connection_reveal', { id: c.id, what })).value;
  // CLINIC_API_STEP7_V1 (ревью №2) — ключ, уже открытый «Скопировать ключ» таблицы
  // без буфера обмена, приходит сюда: поле показывает его сразу, второго
  // открытия (и второй строки журнала) нет.
  const shownKey = can.admin && revealed && revealed.key ? String(revealed.key) : '';
  const keyBox = can.admin ? secretField({ label: 'Ключ доступа', mask: c.key_mask, value: shownKey, getValue: reveal('key') }) : null;
  const secretBox = can.admin ? secretField({ label: 'Секрет для подписи уведомлений', mask: c.secret_mask, getValue: reveal('secret'),
    regen: { label: 'Новый секрет', onClick: () => { confirm = 'secret'; paint(); } } }) : null;
  const body = h('div', { class: 'modal-body apic-modal-body' });
  const tabs = h('div', { class: 'tabs apic-tabs', role: 'tablist' });

  function confirmBlock(text, act, label, onYes) {
    const yes = h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-apic-act': act }, label);
    yes.addEventListener('click', onYes);
    const no = h('button', { class: 'btn btn-sm', type: 'button' }, 'Отмена');
    no.addEventListener('click', () => { confirm = ''; paint(); });
    return h('div', { class: 'apic-confirm', role: 'alertdialog' }, h('p', null, text), h('div', { class: 'apic-row' }, yes, no));
  }
  function paintTabs() {
    clear(tabs);
    for (const [k, l] of TABS) {
      const b = h('button', { class: 'tab' + (current === k ? ' on' : ''), type: 'button', role: 'tab',
        'aria-selected': String(current === k), 'data-apic-tab': k }, l);
      b.addEventListener('click', () => { current = k; confirm = ''; paint(); });
      tabs.appendChild(b);
    }
  }
  function paint() {
    paintTabs();
    clear(body);
    if (fail) body.appendChild(addressBlock(fail, onNavigate, () => m.close()));
    if (current === 'main') paintMain();
    else if (current === 'access') {
      body.appendChild(accessSections(d, errs, { disabled: !can.admin }));
      if (!can.admin) body.appendChild(h('p', { class: 'hint' }, 'Права подключения меняет администратор.'));
    } else if (current === 'hooks') paintHooks();
    else if (current === 'key') paintKey();
    else paintLog();
  }
  function paintMain() {
    if (confirm === 'delete') {
      body.appendChild(confirmBlock(trf('Удалить подключение «{name}»? Ключ и секрет сотрутся и больше не заработают. Заявки, которые уже пришли, останутся в CRM со своим источником.', { name: c.name }),
        'delete-yes', tr('Удалить'), remove));
    }
    body.appendChild(activeField(d, { disabled: !can.edit, ready: settings.partner_address_missing.length === 0 || c.active }));
    const K = KIND_INFO[c.kind] || KIND_INFO.partner;
    body.appendChild(section('Основное', '',
      h('dl', { class: 'apic-kv' },
        h('dt', null, 'Тип'), h('dd', null, K.label, c.kind === 'site' ? [' · ', 'создано автоматически'] : null),
        h('dt', null, 'Создано'), h('dd', null, fmtDateTime(c.created_at), c.created_by_name ? [' · ', c.created_by_name] : null)),
      basicsFields(d, errs, { disabled: !can.edit, sourceLabel: c.crm_source_label, companyWebsite: settings.company_website })));
    body.appendChild(securityFields(d, errs, { disabled: !can.admin }));
  }
  function paintHooks() {
    if (confirm === 'secret') {
      body.appendChild(confirmBlock('Выпустить новый секрет? Прежний перестанет подходить сразу — передайте новый подключению.',
        'secret-yes', tr('Выпустить новый секрет'), () => regenerate('secret')));
    }
    body.appendChild(hooksSection(d, errs, { disabled: !can.admin, secretEl: secretBox,
      secretNote: can.admin ? null : h('p', { class: 'hint' }, 'Секрет видит и меняет только администратор.') }));
    body.appendChild(section('Последние уведомления', '',
      h('div', { class: 'empty' }, 'Уведомлений ещё не было: они пойдут, когда в Easy-Med включат публичный сервер.')));
  }
  function paintKey() {
    if (!can.admin) { body.appendChild(h('p', { class: 'hint' }, 'Ключ видит и меняет только администратор.')); return; }
    const facts = h('dl', { class: 'apic-kv' },
      h('dt', null, 'Выпущен'), h('dd', null, fmtDateTime(c.key_issued_at), c.key_issued_by_name ? [' · ', c.key_issued_by_name] : null),
      h('dt', null, 'Действует до'), h('dd', null, c.key_expires_at ? fmtDateTime(c.key_expires_at) : KEY_TTL_LABEL.never, expiryTag(c)),
      h('dt', null, 'Последний запрос'), h('dd', null, c.last_used_at ? fmtDateTime(c.last_used_at) : 'ещё не было'),
      h('dt', null, 'Как передавать'), h('dd', null, h('code', { translate: 'no' }, 'Authorization: Bearer <ключ>')));
    const rotate = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'rotate' }, Icon('Refresh', { size: 13 }), ' ', 'Выпустить новый ключ');
    rotate.addEventListener('click', () => { confirm = 'key'; paint(); });
    body.appendChild(section('Ключ доступа', '', keyBox,
      h('p', { class: 'hint' }, 'Ключ видят и копируют только администраторы клиники. Если он мог попасть к чужим людям, выпустите новый.'),
      facts,
      confirm === 'key'
        ? confirmBlock('Подключение получит новый ключ, а прежний перестанет работать сразу. Передайте новый ключ подключению.',
            'rotate-yes', tr('Выпустить новый ключ'), () => regenerate('key'))
        : h('div', { class: 'apic-row' }, rotate, h('span', { class: 'hint' }, 'Если ключ потерян или мог попасть к чужим людям.'))));
  }
  async function paintLog() {
    body.appendChild(section('Запросы с этим ключом', '',
      h('div', { class: 'empty' }, 'Запросов с этим ключом ещё не было: они появятся здесь, когда в Easy-Med включат публичный сервер.')));
    const box = h('div', null, h('div', { class: 'muted' }, 'Загрузка…'));
    body.appendChild(section('Изменения настроек', 'без ключей и секретов', box));
    if (journal === null) {
      try { journal = await rpc('api_journal_list', { connection_id: c.id, limit: 50 }); } catch { journal = []; }
    }
    clear(box);
    box.appendChild(journalTable(journal, { withConnection: false }));
  }

  async function regenerate(what) {
    try {
      const r = await rpc('api_connection_regenerate', { id: c.id, what, confirm: true });
      confirm = '';
      if (onChanged) onChanged();
      if (what === 'key') {
        m.close();
        openHandover({ settings, connection: r.connection || c, key: r.value, baseUrl: settings.base_url, rotated: true });
        return;
      }
      secretBox.setValue(r.value);
      paint();
      toast(tr('Новый секрет сохранён — передайте его подключению.'), 'success');
    } catch (e) { toast(tr(e.message), 'fail'); }
  }
  async function remove() {
    try {
      await rpc('api_connection_delete', { id: c.id, confirm: true });
      m.close();
      toast(trf('Подключение «{name}» удалено, ключ стёрт.', { name: c.name }), 'success');
      if (onChanged) onChanged();
    } catch (e) { toast(tr(e.message), 'fail'); }
  }
  async function save() {
    const allowed = can.admin ? [...EDIT_FIELDS, ...ADMIN_FIELDS] : EDIT_FIELDS;
    const patch = {};
    for (const k of allowed) {
      if (c.kind === 'site' && k === 'site_url') continue;
      // Права и события — упорядоченными, IP — по одному в строке: как их хранит сервер.
      if (JSON.stringify(comparable(k, d[k])) !== JSON.stringify(comparable(k, c[k]))) patch[k] = comparable(k, d[k]);
    }
    if (!Object.keys(patch).length) { m.close(); return; }
    const v = normalizeConnection(patch);
    errs = connectionProblems(v, { partial: true });
    fail = '';
    const first = Object.keys(errs)[0];
    if (first) { current = TAB_OF[first] || 'main'; paint(); toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
    try {
      await rpc('api_connection_update', { id: c.id, ...v });
      m.close();
      toast(tr('Сохранено'), 'success');
      if (onChanged) onChanged();
    } catch (e) {
      if (e.code === 'partner_address_required') { fail = e.message; current = 'main'; paint(); return; }
      toast(tr(e.message), 'fail');
    }
  }

  const foot = [];
  if (can.admin && c.kind !== 'site') {
    const del = h('button', { class: 'btn btn-ghost', type: 'button', 'data-apic-act': 'delete', style: { color: 'var(--crit-700)' } },
      Icon('Trash', { size: 15 }), ' ', 'Удалить подключение');
    del.addEventListener('click', () => { confirm = 'delete'; current = 'main'; paint(); });
    foot.push(del);
  } else if (c.kind === 'site') {
    foot.push(h('span', { class: 'hint' }, 'Подключение сайта клиники создано автоматически: удалить его нельзя, выключить можно.'));
  }
  foot.push(h('span', { class: 'grow' }));
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Отмена');
  foot.push(cancel);
  if (can.edit) {
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'save' }, 'Сохранить');
    saveBtn.addEventListener('click', save);
    foot.push(saveBtn);
  }
  paint();
  m = openModal({ name: 'conn', key: 'conn:' + c.id, tabs, body, foot,
    title: [h('span', { class: 'apic-ico t-' + c.kind }, Icon((KIND_INFO[c.kind] || KIND_INFO.partner).icon, { size: 16 })), ' ', c.name, ' ',
      Tag(c.active ? 'Включено' : 'Выключено', { kind: c.active ? 'ok' : '', dot: true })] });
  cancel.addEventListener('click', () => m.close());
  // Ключ пришёл открытым — фокус в его поле и выделение: Ctrl+C его копирует.
  if (shownKey && current === 'key') { try { keyBox.input.focus(); keyBox.input.select(); } catch { /* выделение — удобство */ } }
  return m;
}
