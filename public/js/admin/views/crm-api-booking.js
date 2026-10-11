// PUBLIC_API_V1 — «ОНЛАЙН-ЗАПИСЬ ЧЕРЕЗ API» В КАРТОЧКЕ ЗАЯВКИ CRM и строка
// онлайн-записи на карточке доски (макет screen-crm.js: «Карточка заявки из
// API», «Пациент выбрал», «Ждёт подтверждения … держим до 14:32», выбор карты,
// «Подтвердить запись / Предложить другое время / Отклонить»).
//
// Решение владельца 3: заявка карту пациента не заводит. Регистратор выбирает,
// кто придёт (на одном номере бывает вся семья), или заводит новую карту — и
// только тогда «Подтвердить запись» включается. Всё решает сервер
// (rpc/api-bookings.js): экран показывает, что можно, и зовёт RPC.
//
// Данные клиники и пациента (имена, номера, комментарий) — текстовыми узлами,
// не через tr(): это не фразы интерфейса.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, toast, fmtDate, fmtDateTime, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { STATUS_LABEL, DECLINE_LABEL, STAFF_DECLINE_REASONS } from '../../shared/api-booking.js';

const txt = (s) => document.createTextNode(String(s == null ? '' : s));
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
// PUBLIC_API_V1 — решения владельца 18–19: время держится 30 РАБОЧИХ минут главного
// здания от приёма заявки клиникой — срок может кончиться завтра утром или после
// выходных (принята в субботу в 17:45 — держится до понедельника 08:15). Строка
// «до 08:15» без дня тогда читается как «сегодня»: день пишется, как только срок
// кончается не сегодня. Коротко, потому что строка стоит и на карточке доски:
// сегодня — «08:15», завтра — «завтра 08:15», дальше — «11.03 08:15».
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export function untilText(iso, now = Date.now()) {
  const d = new Date(iso == null ? NaN : iso);
  if (iso == null || iso === '' || Number.isNaN(d.getTime())) return '';
  const time = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const today = new Date(now);
  if (sameDay(d, today)) return time;
  if (sameDay(d, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))) return trf('завтра {time}', { time });
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + time;
}
const sum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const TONE = Object.freeze({ new: 'info', accepted: 'teal', pending: 'warn', confirming: 'warn', offered: 'info', confirmed: 'ok',
  arrived: 'ok', declined: 'crit', expired: 'crit', cancelled: '', no_show: 'crit' });

// Имя обёртки начинается с «rpc»: страж client-rpc-coverage (server/services/rpc)
// видит имена RPC этого экрана и сверяет их с картой сервера.
async function rpcCall(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const e = new Error(error.message || 'Не удалось выполнить запрос.');
    e.code = error.code || '';
    e.params = error.params || null;
    throw e;
  }
  return data;
}

/** Отказ сервера словами: «время занято» — шаблоном с подстановкой, остальное — словарём (сервер шлёт шаблоны). */
export function errorText(e) {
  if (e && e.code === 'slot_taken' && e.params) {
    return trf('Это время занято: у врача {doctor} уже есть приём {from}–{to}. Выберите другое время.', e.params);
  }
  return tr((e && e.message) || 'Не удалось выполнить запрос.');
}

/** Статус заявки: метка и что это значит сейчас. `now` — мгновение «сейчас» (мс): срок держания — со днём, если не сегодня. */
export function statusLine(it, now = Date.now()) {
  const tag = Tag(STATUS_LABEL[it.status] || it.status, { kind: TONE[it.status] || '' });
  let note = null;
  if (it.status === 'pending' && it.hold_until) note = trf('время держим за пациентом до {time}', { time: untilText(it.hold_until, now) });
  else if (it.status === 'offered') note = trf('предложено {when}; ждём ответа партнёра до {time}', { when: fmtDateTime(it.offered_start), time: untilText(it.offer_until, now) });
  else if (it.status === 'confirmed' && it.partner_cancel_at) note = tr('Партнёр сообщил об отмене, но визит уже в работе. Решите вручную.');
  else if (it.status === 'confirmed') note = tr('визит создан, партнёр получит уведомление');
  else if ((it.status === 'declined' || it.status === 'expired') && it.decline_reason) note = tr(DECLINE_LABEL[it.decline_reason] || '');
  return h('span', { class: 'apib-status' }, tag, note ? h('span', { class: 'muted apib-note' }, note) : null);
}

function choiceEl(it) {
  const top = h('span', null);
  if (it.doctor) top.appendChild(h('b', null, txt(it.doctor.name)));
  if (it.what) {
    top.appendChild(txt(' · '));
    top.appendChild(txt(it.what.name));
    top.appendChild(txt(' · '));
    top.appendChild(txt(trf('{sum} сум', { sum: sum(it.what.price) })));
  }
  const when = h('span', { class: 'apib-when' }, txt(fmtDateTime(it.start_at)));
  if (it.branch) { when.appendChild(txt(' · ')); when.appendChild(txt(it.branch.name)); }
  return h('span', { class: 'apib-choice' }, top, when);
}

/**
 * Окно «Онлайн-запись через API» карточки заявки. Пока у карточки нет заявок из
 * API — пустой скрытый блок (карточки из звонков его не видят).
 * @param {{id:number}} card строка crm_requests
 * @param {{onChanged?:Function, newPatient?:(prefill:{full_name:string, phone:string})=>Promise<{id:number, full_name:string, mrn?:string}|null>, now?:()=>number}} opts
 *   now — «сейчас» для строки срока держания (тестам; по умолчанию часы машины)
 */
export function apiBookingBox(card, { onChanged = () => {}, newPatient = null, now = () => Date.now() } = {}) {
  const root = h('div', { class: 'apib-box', 'data-api-booking': String(card && card.id) });
  root.style.display = 'none';
  let items = [];
  const picked = new Map();
  const candidates = new Map();
  const open = new Map();    // id заявки → 'offer' | 'decline'
  // Открытая форма переживает перерисовку (выбор карты, догрузка кандидатов):
  // выбранные день и время не сбрасываются, свободное время не спрашивается заново.
  const forms = new Map();   // id заявки → { kind, el }
  let focusWant = '';        // что взять в фокус после перерисовки (клавиатура не теряет место)
  let focusEl = null;
  let busy = false;
  const wantFocus = (key, el) => { if (focusWant && focusWant === key) focusEl = el; return el; };

  async function load() {
    try { items = ((await rpcCall('api_booking_list', { crm_request_id: card.id })) || {}).items || []; } catch { items = []; }
    forms.clear();
    paint();
  }
  async function loadCandidates(it) {
    if (candidates.has(it.id)) return;
    candidates.set(it.id, null);
    try { candidates.set(it.id, ((await rpcCall('api_booking_candidates', { id: it.id })) || {}).items || []); } catch { candidates.set(it.id, []); }
    paint();
  }
  async function act(fn, okText) {
    if (busy) return;
    busy = true;
    try {
      const out = await fn();
      toast(okText(out), 'ok');
      open.clear();
      forms.clear();
      onChanged(out);
      await load();
    } catch (e) {
      toast(errorText(e), 'fail');
    } finally { busy = false; }
  }
  function pick(it, p, focus = 'confirm:') {
    picked.set(it.id, p);
    focusWant = focus + it.id;
    paint();
  }

  function pickerEl(it) {
    const list = candidates.get(it.id);
    if (list === undefined) loadCandidates(it);
    const chosen = picked.get(it.id) || null;
    const rows = (list || []).map((p) => h('div', { class: 'apib-cand' + (chosen && chosen.id === p.id ? ' on' : ''), 'data-candidate': String(p.id) },
      h('span', null, h('b', null, txt(p.full_name)), p.date_of_birth ? txt(' · ' + fmtDate(p.date_of_birth)) : null,
        h('span', { class: 'muted' }, ' — ', p.why === 'phone_name' ? 'тот же телефон и имя' : 'тот же телефон')),
      chosen && chosen.id === p.id ? Tag('Выбрана', { kind: 'ok' })
        : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => pick(it, p) }, 'Выбрать')));
    const createRow = newPatient ? h('div', { class: 'apib-cand apib-cand-new' + (chosen && chosen.created ? ' on' : '') },
      h('span', null, chosen && chosen.created ? txt(chosen.full_name) : 'Нет в списке'),
      chosen && chosen.created ? Tag('Новая карта', { kind: 'ok' })
        : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
          const p = await newPatient({ full_name: it.patient_name, phone: it.patient_phone });
          if (!p || !p.id) return;
          // Окно регистрации отдаёт и карту, выбранную его стражем дубликатов: если
          // она уже в списке — выбрана она, а не «новая».
          const known = (candidates.get(it.id) || []).find((c) => c.id === p.id);
          pick(it, known || { ...p, created: true });
        } }, Icon('Plus', { size: 14 }), ' ', 'Создать карту')) : null;
    return h('div', { class: 'apib-picker' },
      h('p', { class: 'apib-h' }, 'Карта пациента'),
      h('p', { class: 'muted apib-hint' }, 'Заявка карту не создаёт. Выберите, кто придёт на приём, или заведите новую карту — затем подтвердите запись.'),
      list === null || list === undefined ? h('p', { class: 'muted' }, 'Загрузка…') : null,
      ...rows, createRow);
  }

  function offerForm(it) {
    const date = wantFocus('offer:' + it.id, h('input', { type: 'date', value: dayOf(it.start_at), 'aria-label': 'Дата' }));
    const time = h('select', { 'aria-label': 'Время' });
    const empty = h('p', { class: 'muted', style: { display: 'none' } }, 'Свободного времени в этот день нет.');
    async function fill() {
      clear(time);
      empty.style.display = 'none';
      let slots = [];
      try {
        slots = ((await rpcCall('calendar_slots', { doctor_id: it.doctor.id, date: date.value, duration_minutes: it.duration_minutes, step_minutes: 15 })) || {}).slots || [];
      } catch { slots = []; }
      for (const s of slots) time.appendChild(h('option', { value: s.start_iso }, txt(s.start)));
      if (slots.length) time.value = slots[0].start_iso;
      else empty.style.display = '';
    }
    date.addEventListener('change', fill);
    fill();
    const send = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => {
      if (!time.value) { toast('Выберите время.', 'warn'); return; }
      const p = picked.get(it.id);
      act(() => rpcCall('api_booking_offer', { id: it.id, start: time.value, ...(p ? { patient_id: p.id } : {}) }),
        () => tr('Партнёру предложено другое время. Оно держится 30 минут.'));
    } }, Icon('Send', { size: 14 }), ' ', 'Отправить предложение');
    return h('div', { class: 'apib-form', 'data-apib-form': 'offer' }, date, time, send, empty);
  }

  function declineForm(it) {
    const reason = wantFocus('decline:' + it.id, h('select', { 'aria-label': 'Причина' },
      h('option', { value: '' }, 'Выберите причину'),
      ...STAFF_DECLINE_REASONS.map((r) => h('option', { value: r }, DECLINE_LABEL[r]))));
    const send = h('button', { class: 'btn btn-outline btn-sm apib-danger', type: 'button', onclick: () => {
      if (!reason.value) { toast('Выберите причину отказа.', 'warn'); return; }
      act(() => rpcCall('api_booking_decline', { id: it.id, reason: reason.value }), () => tr('Запись отклонена. Партнёр получит уведомление.'));
    } }, 'Отклонить запись');
    return h('div', { class: 'apib-form', 'data-apib-form': 'decline' }, reason, send);
  }

  function formOf(it) {
    const kind = open.get(it.id);
    if (!kind) { forms.delete(it.id); return null; }
    const kept = forms.get(it.id);
    if (kept && kept.kind === kind) return kept.el;
    const el = kind === 'offer' ? offerForm(it) : declineForm(it);
    forms.set(it.id, { kind, el });
    return el;
  }

  function actionsEl(it) {
    const chosen = picked.get(it.id) || null;
    const confirm = wantFocus('confirm:' + it.id, h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: !it.can.confirm || !chosen, 'data-apib': 'confirm',
      onclick: () => {
        const p = picked.get(it.id);
        if (!p) { toast('Выберите карту пациента или заведите новую.', 'warn'); return; }
        act(() => rpcCall('api_booking_confirm', { id: it.id, patient_id: p.id }), (out) => (out && out.cross_branch && !out.cross_branch.published
          ? tr('Запись подтверждена, но в том здании о ней ещё не знают: обмен подтвердит позже.')
          : tr('Запись подтверждена. Визит в календаре врача, партнёр получит уведомление.')));
      } }, Icon('Check', { size: 14 }), ' ', 'Подтвердить запись'));
    const toggle = (kind) => {
      const next = open.get(it.id) === kind ? null : kind;
      open.set(it.id, next);
      focusWant = next ? next + ':' + it.id : '';
      paint();
    };
    const offer = h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: !it.can.offer, 'data-apib': 'offer', 'aria-expanded': open.get(it.id) === 'offer' ? 'true' : 'false', onclick: () => toggle('offer') },
      Icon('Calendar', { size: 14 }), ' ', 'Предложить другое время');
    const decline = h('button', { class: 'btn btn-ghost btn-sm apib-danger', type: 'button', disabled: !it.can.decline, 'data-apib': 'decline', 'aria-expanded': open.get(it.id) === 'decline' ? 'true' : 'false', onclick: () => toggle('decline') },
      'Отклонить');
    return h('div', null, h('div', { class: 'apib-actions' }, it.can.confirm ? confirm : null, offer, decline), formOf(it));
  }

  function itemEl(it) {
    const rows = [
      ['Подключение', txt(it.connection && it.connection.name)],
      ['Номер у партнёра', it.external_id ? h('span', { class: 'cell-mono' }, txt(it.external_id)) : txt('—')],
      ['Пришла', txt(fmtDateTime(it.received_at))],
    ];
    if (it.kind === 'appointment') rows.push(['Пациент выбрал', choiceEl(it)]);
    rows.push(['Статус', statusLine(it, now())]);
    if (it.patient) rows.push(['Карта пациента', txt(it.patient.full_name + (it.patient.mrn ? ' · ' + it.patient.mrn : ''))]);
    const parts = [
      h('h5', { class: 'apib-title' }, Icon('Key', { size: 15 }), ' ', it.kind === 'appointment' ? 'Онлайн-запись через API' : 'Заявка через API'),
      h('dl', { class: 'apib-kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    ];
    if (it.comment) parts.push(h('div', { class: 'apib-comment' }, h('span', { class: 'muted' }, 'Комментарий пациента'), h('p', null, txt(it.comment))));
    if (it.can.confirm) parts.push(pickerEl(it));
    if (it.can.confirm || it.can.offer || it.can.decline) parts.push(actionsEl(it));
    if (it.can.accept) {
      parts.push(h('div', { class: 'apib-actions' }, h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-apib': 'accept',
        onclick: () => act(() => rpcCall('api_request_accept', { id: it.id }), () => tr('Заявка взята в работу. Партнёр получит уведомление.')) },
      Icon('Check', { size: 14 }), ' ', 'Взять в работу')));
    }
    return h('div', { class: 'apib-item', 'data-api-request': String(it.id) }, ...parts);
  }

  function paint() {
    focusEl = null;
    clear(root);
    root.style.display = items.length ? '' : 'none';
    for (const it of items) root.appendChild(itemEl(it));
    focusWant = '';
    if (focusEl) { try { focusEl.focus(); } catch { /* фокус — удобство */ } focusEl = null; }
  }

  root.reload = load;
  load();
  return root;
}

/** Строки онлайн-записи доски одним запросом: { [id карточки]: [...] }. Ошибка — пусто, доска рисуется как была. */
export async function loadApiMarks() {
  try { return ((await rpcCall('api_board_marks', {})) || {}).marks || {}; } catch { return {}; }
}

/** Строка на карточке доски: «med24.uz · API — ждёт подтверждения до 14:32» (не сегодня — со днём, см. untilText). */
export function apiBoardLine(marks, now = Date.now()) {
  const m = Array.isArray(marks) && marks.length ? marks[0] : null;
  if (!m) return null;
  let what;
  if (m.status === 'pending') what = trf('ждёт подтверждения до {time}', { time: untilText(m.hold_until, now) });
  else if (m.status === 'offered') what = trf('предложено другое время, ждём ответа до {time}', { time: untilText(m.offer_until, now) });
  else if (m.kind === 'request') what = m.status === 'new' ? tr('новая заявка') : tr('заявка в работе');
  else what = tr(STATUS_LABEL[m.status] || '');
  return h('div', { class: 'crm-card-api', 'data-api-mark': m.status },
    Icon('Key', { size: 12 }), h('b', null, txt(m.connection_name), txt(' · API')), h('span', null, what));
}
