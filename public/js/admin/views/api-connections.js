// CLINIC_API_STEP7_V1 — Настройки → «API и подключения» (docs/specs/2026-10-06-clinic-api-design.md,
// шаг 7; макет mockups/api-settings/js/screen-api.js; план 2026-10-10-clinic-api-7-api-screen.md).
//
// Заменяет два экрана облачной эпохи: «Ключи API» (общий редактор справочника
// над заглушкой api_tokens — ключ вписывали руками, сервер его не проверял) и
// прежний views/api-settings.js (облачный шлюз /api/v1, офлайн его нет).
//
// Здесь: адрес клиники для подключений (https://api.easymed.uz/<имя>/v1/),
// подключения с ключом, правами, источником CRM и уведомлениями, журнал
// изменений. Чего ещё нет — и экран говорит это прямо: публичного сервера
// (шаг 8). Ключи можно выпустить и передать заранее; работать они начнут,
// когда его включат.
//
// Что можно этому человеку, говорит сервер (`can`): экран не угадывает права.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, Tag, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { refreshClinicBrand } from '../clinic-context.js';
import { API_HOST, KIND_INFO, normalizeSlug, slugProblem } from '../../shared/api-connections.js';
import { rpc, shapeSettings, copyText, secretField, permChips, expiryTag, journalTable, addressBlock } from './api-ui.js';
import { openNewConnection } from './api-connection-new.js';
import { openConnectionCard } from './api-connection-card.js';

const SUBTITLE = 'Сайт клиники, Symptex и партнёры получают отсюда врачей, свободное время, услуги и цены. Заявки и записи пациентов приходят в CRM с источником своего подключения.';
const PRIVACY = 'Данные пациентов наружу не передаются. Подключения видят только то, что клиника публикует: профиль клиники, врачей, свободное время, услуги и пакеты. Если лицензия Easy-Med закончится, сайт и партнёры перестанут получать данные и отправлять заявки, пока её не продлят.';

const state = { s: shapeSettings(null), journal: [], editSlug: false };
let refs = { root: null, body: null, onNavigate: null };

export async function renderApiConnections(container, { onNavigate = null, payload = null, onPayload = null } = {}) {
  clear(container);
  refs = { root: h('div', { class: 'fade-in apic' }), body: h('div', { class: 'apic-stack' }), onNavigate };
  state.editSlug = false;
  container.appendChild(refs.root);
  refs.root.appendChild(PageHead({ title: 'API и подключения', subtitle: SUBTITLE }));
  refs.root.appendChild(refs.body);
  // CLINIC_API_STEP7_V1 (ревью №3) — оболочка держит экран в кэше и второй раз его
  // не рисует: следующий переход с connection_id приходит сюда. Список
  // перечитывается — карточка открывается по свежим данным.
  if (typeof onPayload === 'function') {
    onPayload((p) => { if (p && p.connection_id) reload().then(() => openById(p.connection_id)); });
  }
  await reload();
  // Ссылка «Подключение» из CRM-канбана: открыть карточку сразу.
  openById(payload && payload.connection_id);
}
function openById(id) {
  const n = Number(id);
  const c = n ? state.s.connections.find((x) => x.id === n) : null;
  if (c) openCard(c);
}

async function reload() {
  clear(refs.body);
  refs.body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
  try {
    state.s = shapeSettings(await rpc('api_settings_get', {}));
    const j = await rpc('api_journal_list', { limit: 30 });
    state.journal = Array.isArray(j) ? j : [];
  } catch (e) {
    clear(refs.body);
    refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
      trf('Не удалось загрузить подключения: {msg}', { msg: tr(e.message) })));
    return;
  }
  paint();
}
// После изменения: перечитать и обновить window.CLINIC — «Компания» по нему
// ставит звёздочки адреса для партнёров (решение владельца 11).
async function changed() {
  await reload();
  refreshClinicBrand(supabase).catch(() => {});
}
// revealed — ключ, уже полученный от сервера (ревью №2): карточка показывает его, не спрашивая снова.
const openCard = (c, tab = 'main', revealed = null) => openConnectionCard({ settings: state.s, connection: c, onChanged: changed,
  onNavigate: refs.onNavigate, tab, revealed });

function paint() {
  clear(refs.body);
  const s = state.s;
  if (s.building_role === 'secondary') {
    refs.body.appendChild(h('p', { class: 'apic-note', role: 'note' }, Icon('Building', { size: 16 }),
      h('span', null, 'Подключения API настраиваются в главном здании клиники.')));
    return;
  }
  refs.body.appendChild(addressCard(s));
  refs.body.appendChild(connectionsCard(s));
  refs.body.appendChild(journalCard());
}

// ---- адрес клиники для подключений ---------------------------------------------------
function addressCard(s) {
  const body = h('div', { class: 'apic-body' });
  if (!s.slug || state.editSlug) body.appendChild(slugEditor(s));
  else {
    // CLINIC_API_STEP7_V1 (ревью №2) — адрес в поле только для чтения: без буфера
    // обмена (http в сети клиники) «Скопировать» выделяет его для Ctrl+C.
    // Копирование — не правка: в рамке «только просмотр» оно работает.
    const url = secretField({ label: 'Адрес API', value: s.base_url, viewOk: true });
    const edit = s.can.admin
      ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-apic-act': 'slug-edit' }, Icon('Edit', { size: 13 }), ' ', 'Изменить имя')
      : null;
    if (edit) edit.addEventListener('click', () => { state.editSlug = true; paint(); });
    body.appendChild(h('div', { class: 'apic-row apic-urlrow' },
      h('span', { class: 'apic-url-lock', 'aria-hidden': 'true' }, Icon('Lock', { size: 14 })), url, edit));
  }
  if (s.partner_address_missing.length) {
    body.appendChild(addressBlock('Адрес для партнёров в «Компании» не заполнен: пока его нет, подключения нельзя включить.', refs.onNavigate));
  }
  const fact = (icon, dt, dd) => h('div', null, h('dt', null, dt), h('dd', null, Icon(icon, { size: 15 }), h('span', null, dd)));
  body.appendChild(h('dl', { class: 'apic-facts' },
    fact('Shield', 'Защита', 'Только HTTPS, у каждого подключения свой ключ'),
    fact('Warning', 'Публичный сервер', 'Ещё не включён. Ключи можно выпустить и передать заранее: подключения начнут получать данные и присылать заявки, когда в Easy-Med включат публичный сервер.'),
    fact('Send', 'Заявки и записи', 'Будут приходить в CRM «Заявки» с источником своего подключения')));
  body.appendChild(h('p', { class: 'apic-note' }, Icon('Info', { size: 16 }), h('span', null, PRIVACY)));
  return h('section', { class: 'card apic-card', 'data-apic': 'address' },
    h('div', { class: 'card-header' }, h('h3', null, Icon('Globe', { size: 18 }), ' ', 'Адрес клиники для подключений'),
      h('span', { class: 'grow' }), Tag('Ещё не работает', { kind: 'warn', dot: true })),
    body);
}
function slugEditor(s) {
  if (!s.can.admin) return h('p', { class: 'hint' }, 'Имя клиники в адресе ещё не задано — его задаёт администратор.');
  const input = h('input', { type: 'text', id: 'apic-slug', autocomplete: 'off', spellcheck: 'false', translate: 'no', maxlength: '40' });
  input.value = s.slug || s.slug_suggestion || '';
  const err = h('div', { class: 'apic-err', role: 'alert' });
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-apic-act': 'slug-save' }, 'Сохранить');
  save.addEventListener('click', async () => {
    const v = normalizeSlug(input.value);
    const p = slugProblem(v);
    err.textContent = p ? tr(p) : '';
    if (p) return;
    try {
      const r = await rpc('api_slug_save', { slug: v });
      state.editSlug = false;
      toast(tr(r && r.site_created ? 'Адрес сохранён. Подключение «Сайт клиники» создано выключенным — его ключ в карточке подключения.' : 'Адрес сохранён.'), 'success');
      await changed();
    } catch (e) { err.textContent = tr(e.message); }
  });
  const cancel = s.slug ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.editSlug = false; paint(); } }, 'Отмена') : null;
  return h('div', { class: 'apic-slug' },
    h('div', { class: 'field' },
      h('label', { for: 'apic-slug' }, 'Короткое имя клиники в адресе'),
      h('div', { class: 'apic-prefix' }, h('span', { translate: 'no' }, 'https://' + API_HOST + '/'), input, h('span', { translate: 'no' }, '/v1/')),
      h('div', { class: 'hint' }, 'Латинские буквы, цифры и дефис, от 3 до 40 знаков. Занято ли имя другой клиникой, проверит публичный сервер, когда его включат.'),
      s.slug && s.connections.length ? h('div', { class: 'hint apic-warn' }, 'Адрес уже передан подключениям: после смены сообщите им новый.') : null,
      err),
    h('div', { class: 'apic-row' }, save, cancel));
}

// ---- подключения ---------------------------------------------------------------------
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };
function connectionsCard(s) {
  const add = s.can.admin
    ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-apic-act': 'conn-new', disabled: !s.slug },
        Icon('Plus', { size: 14 }), ' ', 'Добавить подключение')
    : null;
  if (add) add.addEventListener('click', () => openNewConnection({ settings: s, onCreated: changed, onNavigate: refs.onNavigate }));
  const body = h('div', { class: 'apic-body' });
  if (s.can.admin && !s.slug) body.appendChild(h('p', { class: 'hint' }, 'Сначала задайте короткое имя клиники в адресе API.'));
  if (!s.can.admin) {
    body.appendChild(h('p', { class: 'hint' }, s.can.reveal
      ? 'Новое подключение создаёт администратор с правом «Изменение»: вместе с ним выпускается ключ.'   // ревью №1
      : 'Новое подключение создаёт администратор: вместе с ним выпускается ключ.'));
  }
  if (!s.connections.length) {
    body.appendChild(h('div', { class: 'empty' }, 'Подключений пока нет.'));
  } else {
    const tb = h('tbody');
    for (const c of s.connections) tb.appendChild(connRow(c, s));
    body.appendChild(h('div', { class: 'apic-tblwrap' }, h('table', { class: 'tbl apic-tbl' },
      h('thead', null, h('tr', null, ...['Подключение', 'Ключ', 'Что разрешено', 'Источник в CRM', 'Уведомления', 'Последний запрос', 'Статус']
        .map((t) => h('th', null, t)))), tb)));
    body.appendChild(h('p', { class: 'hint' }, 'Нажмите на строку, чтобы открыть подключение.'));
  }
  return h('section', { class: 'card apic-card', 'data-apic': 'connections' },
    h('div', { class: 'card-header' }, h('h3', null, Icon('Key', { size: 18 }), ' ', 'Подключения и ключи'), h('span', { class: 'grow' }), add),
    body);
}
function keyCell(c, s) {
  // CLINIC_API_STEP7_V1 (ревью №1, решение владельца 5) — ключ видит любой
  // администратор (can.reveal), и на «Просмотре»; копирование — не правка.
  if (!s.can.reveal) return h('span', { class: 'muted' }, 'Скрыт');
  const btn = h('button', { class: 'apic-ibtn', type: 'button', 'aria-label': 'Скопировать ключ', title: 'Скопировать ключ', 'data-apic-act': 'copy-key' },
    Icon('Copy', { size: 14 }));
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await rpc('api_connection_reveal', { id: c.id, what: 'key' });
      // Буфера нет — карточка на вкладке «Ключ» с ЭТИМ значением, выделенным для
      // Ctrl+C (ревью №2): одно копирование — одно открытие ключа в журнале.
      if (!(await copyText(r.value))) openCard(c, 'key', { key: r.value });
    } catch (err) { toast(tr(err.message), 'fail'); }
  });
  return h('span', { class: 'apic-nowrap' }, h('span', { class: 'cell-mono', translate: 'no' }, c.key_mask), ' ', btn);
}
function connRow(c, s) {
  const K = KIND_INFO[c.kind] || KIND_INFO.partner;
  const where = c.kind === 'site' ? hostOf(s.company_website) : hostOf(c.site_url);
  const row = h('tr', { class: 'row-click', tabindex: '0', 'data-apic-conn': String(c.id) },
    h('td', null, h('div', { class: 'apic-who' },
      h('span', { class: 'apic-ico t-' + c.kind }, Icon(K.icon, { size: 18 })),
      h('div', null, h('div', { class: 'apic-name' }, c.name),
        h('span', { class: 'apic-sub' }, K.label,
          c.kind === 'site' ? [' · ', 'создано автоматически'] : null,
          where ? [' · ', h('span', { translate: 'no' }, where)] : null)))),
    h('td', null, keyCell(c, s)),
    h('td', null, permChips(c.scopes)),
    h('td', null, h('span', { class: 'apic-chip api' }, c.crm_source_label)),
    h('td', null, c.webhook_url
      ? [h('span', { class: 'cell-mono apic-small', translate: 'no' }, hostPath(c.webhook_url)),
         h('span', { class: 'apic-sub' }, trf('событий: {n}', { n: (c.webhook_events || []).length }))]
      : h('span', { class: 'muted' }, 'Не настроены')),
    h('td', null, c.last_used_at ? fmtDateTime(c.last_used_at) : h('span', { class: 'muted' }, 'ещё не было')),
    h('td', null, Tag(c.active ? 'Включено' : 'Выключено', { kind: c.active ? 'ok' : '', dot: true }), expiryTag(c)));
  row.addEventListener('click', () => openCard(c));
  row.addEventListener('keydown', (e) => {
    // CLINIC_API_STEP7_V1 (ревью №12) — нажатие на кнопке внутри строки («Скопировать
    // ключ») принадлежит кнопке: строка его не перехватывает и не отменяет.
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(c); }
  });
  return row;
}

// ---- журнал изменений -------------------------------------------------------------------
function journalCard() {
  return h('section', { class: 'card apic-card', 'data-apic': 'journal' },
    h('div', { class: 'card-header' }, h('h3', null, Icon('Activity', { size: 18 }), ' ', 'Журнал изменений')),
    h('div', { class: 'apic-body' }, journalTable(state.journal),
      h('p', { class: 'hint' }, 'В журнале нет ключей и секретов — только кто, что и когда сделал.')));
}
