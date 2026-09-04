// TWO_STEP_DISCHARGE_V1 — «Выписки к оформлению»: рабочее место СТАРШЕЙ
// МЕДСЕСТРЫ (Задача 8 плана docs/plans/2026-09-04-inpatient-workflow.md).
//
// ─── ЧЕЙ ЭТО ЭКРАН ──────────────────────────────────────────────────────────
//
// Второго шага выписки. Первый — заявку врача — подают из карты пациента: врач
// объявляет исход и публикует эпикриз, и на этом его часть кончается, койку он
// не освобождает. Здесь появляется всё, по чему заявка подана, и здесь выписку
// ОФОРМЛЯЮТ: фактическое время, чек-лист, долг, койка.
//
// ─── ЧТО СЧИТАЕТ СЕРВЕР, А НЕ ЭТОТ ФАЙЛ ─────────────────────────────────────
//
// ДОЛГ. `admission_discharge_queue` присылает его посчитанным (rpc/inpatient.js
// admissionBalance) вместе с тем, чего в него не вошло. Считать деньги в
// браузере нельзя по той же причине, по какой доска коек не считает занятость
// сама: вторая копия правила разошлась бы с первой молча — и разошлась бы в
// сторону «долга нет».
//
// ПРАВО НАЖАТЬ. `inpatient_capabilities` — один ответ на отрисовку: матрица
// прав живёт на сервере (rpc/inpatient-flow.js), и вторая её копия здесь
// показала бы кнопку тому, кому сервер откажет.
//
// Здесь — только экран: как это выглядит, что спрашивают у человека и в каком
// порядке. Чистые функции экспортируются и проверяются без браузера
// (__tests__/discharge-view.test.mjs).
//
// ─── ЧЕГО ЗДЕСЬ НЕТ ─────────────────────────────────────────────────────────
//
// Маршрута в меню. Экран не подключён к admin.js/permissions.js — их правит
// соседняя задача, и три экрана уже стоят в очереди на подключение. Что именно
// нужно добавить, перечислено в отчёте задачи.

import { supabase } from '../../supabase.js';
import { h, clear, toast, Icon, Tag, checkField, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — переводим ПЕРВЫМ, подставляем ВТОРЫМ
// INPATIENT_ROLE_GATE_V1 — список ролей теперь ЧИТАЕТ и меню (permissions.js
// isModuleAllowed): он лежит там, где стоит гейт, и сюда возвращается тем же
// именем. До этого список существовал, был покрыт тестом — и не был подключён
// ни к чему: пункт меню открывался по одному ключу `beds`, который миграция 092
// выдала в том числе регистратуре.
import { INPATIENT_SCREEN_ROLES } from '../permissions.js';

// Кто открывает экран. Это очередь ОФОРМЛЕНИЯ, и держат её те, кто вправе
// оформить: старшая медсестра, главный врач, администратор
// ('discharging→discharged' в TRANSITION_ROLES). Обычной медсестры здесь нет —
// её работа кончается на койке; врача нет — он подал заявку и видит её судьбу в
// карте пациента (RPC очереди читает шире, чем этот экран показывает, и это
// намеренно: смотреть можно, оформлять — нет).
export const DISCHARGE_ROLES = INPATIENT_SCREEN_ROLES.discharge;

/**
 * Роли считаются ПО ОБЪЕДИНЕНИЮ основной и дополнительных — так же, как их
 * считает сервер (roles.js effectiveRoles). Старшая медсестра остаётся
 * медсестрой, главный врач — врачом: обе надстройки живут в extra_roles.
 */
export function canSeeDischarge(user) {
  if (!user || !user.role) return false;
  const extra = Array.isArray(user.extra_roles) ? user.extra_roles : [];
  return [user.role, ...extra].some((r) => DISCHARGE_ROLES.includes(r));
}

// Исход госпитализации словами. Ключ — код из миграции 097; порядок тот же, что
// на сервере (DISCHARGE_OUTCOMES).
const OUTCOME_TITLE = {
  home:     'Выписан домой',
  transfer: 'Переведён в другое учреждение',
  refuse:   'Отказ от лечения',
  death:    'Летальный исход',
};

// Те же четыре кода и в том же порядке, что у сервера (DISCHARGE_OUTCOMES в
// rpc/inpatient.js и CHECK миграции 097). Список ЭКСПОРТИРУЕТСЯ, потому что
// исход спрашивают в ДВУХ местах: здесь его показывают, а в карте
// госпитализации (views/admission-modal.js) его выбирает врач, подавая заявку.
// Вторая копия списка означала бы, что один экран знает исход, которого не
// знает другой, — и расходятся такие копии молча.
export const DISCHARGE_OUTCOMES = Object.freeze(Object.keys(OUTCOME_TITLE));

/** Подпись исхода. Заявка без исхода невозможна, но строка не должна пустеть. */
export function outcomeTitle(code) {
  return OUTCOME_TITLE[code] ? tr(OUTCOME_TITLE[code]) : tr('Исход не указан');
}

/** Деньги — как везде в программе: разряды пробелом и валюта словом. */
export function money(n) {
  return (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + ' ' + tr('сум');
}

/**
 * Долг ли это. Порог в копейку, а не `> 0`: сумма приходит после округления до
 * двух знаков, и остаток вида 0.004 — это не долг, а арифметика.
 */
export function hasDebt(balance) {
  return !!balance && Number(balance.balance) > 0.005;
}

/**
 * Из чего сложился остаток — тремя строками, а не одним числом. Человек,
 * который ставит подпись под долгом, обязан видеть, ЧТО он подписывает:
 * «не выставлено» и «выставлено, но не оплачено» — разные разговоры с кассой.
 */
export function balanceLines(balance) {
  if (!balance) return [];
  const out = [{ label: tr('Начислено, не выставлено'), value: money(balance.unbilled) }];
  if (balance.invoice_count) {
    out.push({ label: tr('Выставлено счетами'), value: money(balance.invoiced) });
    out.push({ label: tr('Оплачено'), value: money(balance.paid) });
  }
  return out;
}

/**
 * ЧЕГО ЭТО ЧИСЛО НЕ ПОКРЫВАЕТ — вслух. Показать границу честнее, чем выдать
 * ровную сумму, которой человек поверит целиком: приём в поликлинике во время
 * лежания в долг стационара не входит, и узнать об этом у кассы через день
 * хуже, чем прочитать здесь.
 */
export function excludeNotes(balance) {
  const ex = (balance && balance.excludes) || {};
  const out = [];
  if (ex.internal_lines) {
    out.push(trf('строки в учёте расходов: {count} на {amount}',
      { count: ex.internal_lines, amount: money(ex.internal_amount) }));
  }
  if (ex.void_invoices) {
    out.push(trf('аннулированные счета: {count}', { count: ex.void_invoices }));
  }
  out.push(tr('приёмы вне стационара и то, что ещё не внесено строкой'));
  return out;
}

/**
 * ACCOMMODATION_GAP_V1 — КОЙКО-ДНИ, ЗА КОТОРЫМИ НЕТ СТРОКИ.
 *
 * Долг под подписью считает `admissionBalance`, и считает он ЧЕСТНО — по
 * строкам `admission_services`. Но проживание становится такой строкой только
 * когда человек нажмёт «Внести проживание» (ACCOMMODATION_AS_SERVICE_V1): не
 * нажали — строки нет, и трёхсуточная госпитализация показывает здесь долг в
 * 25 000, пока 450 000 койко-дней нигде не числятся. Экран не может это
 * посчитать сам (ставка, режим палаты и уже выставленные сутки — работа
 * сервера), но обязан НАЗВАТЬ пропажу: `accommodation_state` отдаёт срок
 * (stay_units), выставленное (invoiced.units) и открытую строку (billed).
 * Разница между ними — сутки, за которые не выставят никогда, если промолчать
 * сейчас.
 *
 * Возвращает null, когда называть нечего: срок покрыт строками, или ставка
 * нулевая (бесплатная койка — это решение клиники, а не пропажа).
 */
export function accommodationGap(state) {
  if (!state) return null;
  const stay = Number(state.stay_units) || 0;
  const invoiced = Number(state.invoiced && state.invoiced.units) || 0;
  const open = Number(state.billed && state.billed.units) || 0;
  const units = Math.max(0, stay - invoiced - open);
  if (units <= 0) return null;
  const cur = state.current || {};
  const rate = Number(cur.rate) || 0;
  if (rate <= 0) return null;
  const mode = cur.mode === 'hourly' ? 'hourly' : 'daily';
  return { units, rate, mode, amount: Math.round(units * rate) };
}

/** Пропажа словами: сколько суток и на какую сумму. Пусто — значит, всё внесено. */
export function accommodationWarning(gap) {
  if (!gap) return '';
  return trf('Проживание не внесено: {units} {unit} на {amount} — эта сумма в остаток не вошла.', {
    units: gap.units,
    unit: gap.mode === 'hourly' ? tr('ч.') : tr('сут.'),
    amount: money(gap.amount),
  });
}

/** Палата и койка одной подписью; пациент без койки из списка не исчезает. */
export function placeTitle(row) {
  const ward = (row && row.ward_name) || tr('Без палаты');
  return row && row.bed_code ? ward + ' · ' + row.bed_code : ward;
}

/**
 * «Сейчас» в том виде, какой понимает <input type="datetime-local">. Время
 * МЕСТНОЕ: медсестра пишет то, что на часах у поста, а не UTC.
 */
export function nowLocalInput(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `T${p(now.getHours())}:${p(now.getMinutes())}`;
}

/**
 * Местное время из поля → то, что хранит база (UTC, 'YYYY-MM-DDTHH:MM:SSZ').
 * Пустое поле — null: «время не указали», и тогда сервер поставит своё.
 */
export function localToUtcIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19) + 'Z';
}

/**
 * Можно ли нажать «Оформить выписку».
 *
 * ДОЛГ НЕ ЗАПРЕЩАЕТ ВЫПИСКУ — он требует подписи. Кнопка гаснет ровно до
 * галочки «Долг согласован», и это единственное, что её гасит: ни незакрытый
 * лист назначений, ни невыданные документы выписку не держат (план: «деньги и
 * документы предупреждают, но пускают»).
 */
export function canSubmit(row, form) {
  if (!row) return false;
  return !hasDebt(row.balance) || !!(form && form.debt_ack);
}

export async function renderDischarge(root, ctx = {}) {
  // ACCOMMODATION_GAP_V1 — расчёт проживания по каждой строке очереди:
  // admission_id → ответ accommodation_state.
  const state = { wardId: '', wards: [], rows: [], can: {}, loading: true, accommodation: new Map() };

  const wrap = h('div', { class: 'fade-in' });
  root.appendChild(wrap);

  wrap.appendChild(h('div', { class: 'page-head' },
    h('div', null,
      h('h1', { class: 'page-title' }, 'Выписки к оформлению'),
      h('p', { class: 'page-subtitle' },
        'Пациенты, по которым лечащий врач подал заявку на выписку. Оформление закрывает госпитализацию и отправляет койку на уборку.'))));

  const wardSelect = h('select', { class: 'input' }, h('option', { value: '' }, 'Все отделения'));
  const reloadBtn = h('button', { class: 'btn' }, Icon('Refresh'), tr('Обновить'));
  wrap.appendChild(h('div', { class: 'card', style: { display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '14px' } },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Отделение'), wardSelect),
    reloadBtn));

  const body = h('div', null);
  wrap.appendChild(body);

  async function loadWards() {
    const { data } = await supabase.from('wards').select('id,name');
    state.wards = Array.isArray(data) ? data : [];
    for (const w of state.wards) wardSelect.appendChild(h('option', { value: String(w.id) }, w.name || ''));
  }

  // Расчёт проживания спрашивается ПО КАЖДОМУ, кого сегодня оформляют — очередь
  // выписки это несколько человек, а не отделение. Отказ не роняет экран:
  // выписку он не держит, он только называет пропажу.
  async function loadAccommodation() {
    const map = new Map();
    await Promise.all(state.rows.map(async (r) => {
      try {
        const { data } = await supabase.rpc('accommodation_state', { admission_id: r.admission_id });
        if (data && typeof data === 'object') map.set(r.admission_id, data);
      } catch (e) { /* без расчёта проживания экран работает, но пропажу не назовёт */ }
    }));
    state.accommodation = map;
  }

  /** Пропажа проживания по строке очереди — или null, если всё внесено. */
  function gapOf(row) {
    return accommodationGap(state.accommodation.get(row && row.admission_id));
  }

  async function loadCapabilities() {
    const { data } = await supabase.rpc('inpatient_capabilities', {});
    state.can = (data && data.can) || {};
  }

  async function load() {
    clear(body);
    body.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
    const args = {};
    if (state.wardId) args.ward_id = Number(state.wardId);
    const { data, error } = await supabase.rpc('admission_discharge_queue', args);
    clear(body);
    if (error || !data) {
      state.rows = [];
      body.appendChild(h('div', { class: 'card muted' }, 'Не удалось загрузить очередь выписок.'));
      return;
    }
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    await loadAccommodation();
    render();
  }

  function render() {
    clear(body);
    if (!state.rows.length) {
      body.appendChild(h('div', { class: 'card muted' }, 'Заявок на выписку нет — оформлять некого.'));
      return;
    }
    const rows = state.rows.map((r) => {
      const debt = hasDebt(r.balance);
      const gap = gapOf(r);
      const act = state.can.discharge
        ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => openFinalize(r) }, tr('Оформить выписку'))
        : h('span', { class: 'muted' }, tr('Оформляет старшая медсестра'));
      return h('tr', null,
        h('td', null, h('b', null, r.patient_name || '—'),
          r.admission_no ? h('div', { class: 'muted' }, r.admission_no) : null),
        h('td', null, placeTitle(r)),
        h('td', null, r.attending_name || '—'),
        h('td', null, outcomeTitle(r.discharge_outcome),
          r.discharge_destination ? h('div', { class: 'muted' }, r.discharge_destination) : null),
        h('td', null, r.discharge_requested_at ? fmtDateTime(r.discharge_requested_at) : '—',
          r.requested_by_name ? h('div', { class: 'muted' }, r.requested_by_name) : null),
        h('td', { class: 'num' }, debt
          ? Tag(money(r.balance.balance), { kind: 'warn' })
          : h('span', { class: 'muted' }, tr('Долга нет')),
          // ACCOMMODATION_GAP_V1 — пропажу видно РЯДОМ С ОСТАТКОМ, а не в
          // окне: именно на это число человек смотрит, решая, отпускать ли.
          gap ? h('div', null, Tag(trf('проживание не внесено: {amount}', { amount: money(gap.amount) }), { kind: 'crit', dot: true })) : null),
        h('td', { class: 'num' }, r.active_orders
          ? trf('идёт: {count}', { count: r.active_orders })
          : tr('закрыт')),
        h('td', null, act));
    });
    body.appendChild(h('div', { class: 'card' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null,
          h('th', null, 'Пациент'), h('th', null, 'Палата и койка'),
          h('th', null, 'Лечащий врач'), h('th', null, 'Исход'),
          h('th', null, 'Заявка подана'), h('th', null, 'Остаток по счёту'),
          h('th', null, 'Лист назначений'), h('th', null, ''))),
        h('tbody', null, ...rows))));
  }

  // ─── Окно оформления ──────────────────────────────────────────────────────
  //
  // Порядок полей — порядок действий у поста: сперва КОГДА (это факт, и его
  // пишут первым), потом что осталось сделать, потом деньги, потом подпись.
  function openFinalize(row) {
    const form = {
      at: nowLocalInput(), close_orders: !!row.active_orders,
      bill_settled: false, docs_given: false, debt_ack: false, note: '',
    };
    const debt = hasDebt(row.balance);

    const atInput = h('input', { type: 'datetime-local', class: 'input', value: form.at });
    atInput.addEventListener('change', () => { form.at = atInput.value; });

    const closeOrders = h('input', { type: 'checkbox' });
    closeOrders.checked = form.close_orders;
    closeOrders.addEventListener('change', () => { form.close_orders = !!closeOrders.checked; });

    const billBox = h('input', { type: 'checkbox' });
    billBox.addEventListener('change', () => { form.bill_settled = !!billBox.checked; });
    const docsBox = h('input', { type: 'checkbox' });
    docsBox.addEventListener('change', () => { form.docs_given = !!docsBox.checked; });

    const noteInput = h('input', { class: 'input', placeholder: tr('Например: перевозка забрала в 15:40') });
    noteInput.addEventListener('input', () => { form.note = noteInput.value; });

    const ackBox = h('input', { type: 'checkbox' });
    const submitBtn = h('button', { class: 'btn btn-primary', type: 'button' }, tr('Оформить выписку'));
    const syncSubmit = () => { submitBtn.disabled = !canSubmit(row, form); };
    ackBox.addEventListener('change', () => { form.debt_ack = !!ackBox.checked; syncSubmit(); });

    const orderLine = row.active_orders
      ? checkField(trf('Закрыть оставшиеся назначения ({count}) с причиной «Выписка»', { count: row.active_orders }), closeOrders)
      : h('div', { class: 'muted' }, 'Лист назначений закрыт.');

    // ДЕНЬГИ ПРЕДУПРЕЖДАЮТ, А НЕ ЗАПРЕЩАЮТ. Блок с долгом объясняет сумму и
    // называет, чего в неё не вошло, — и просит подпись, а не оплату.
    const debtBlock = debt
      ? h('div', { class: 'card', style: { marginTop: '10px' } },
          h('div', { class: 'card-title' }, trf('Остаток по счёту: {amount}', { amount: money(row.balance.balance) })),
          ...balanceLines(row.balance).map((l) => h('div', { class: 'muted' }, l.label + ': ' + l.value)),
          h('div', { class: 'muted', style: { marginTop: '6px' } }, 'В сумму не входит:'),
          ...excludeNotes(row.balance).map((n) => h('div', { class: 'muted' }, '— ' + n)),
          h('div', { style: { marginTop: '8px' } }, 'Долг выписке не мешает — подтвердите, что он согласован.'),
          checkField(tr('Долг согласован (гарантия / рассрочка)'), ackBox))
      : h('div', { class: 'muted', style: { marginTop: '10px' } }, 'Долга по госпитализации нет.');

    // ACCOMMODATION_GAP_V1 — пропажа стоит В ОКНЕ ТОЖЕ, и НЕ внутри блока долга:
    // самый опасный случай — «долга нет» при трёх невыставленных койко-днях,
    // и как раз тогда блока долга на экране нет вовсе.
    const gap = gapOf(row);
    const gapBlock = gap
      ? h('div', {
          class: 'card',
          style: { marginTop: '10px', border: '1px solid rgba(179,38,30,.35)', background: 'rgba(179,38,30,.08)' },
        },
          h('div', { class: 'card-title' }, tr('Проживание не внесено в счёт')),
          h('div', null, accommodationWarning(gap)),
          h('div', { class: 'muted', style: { marginTop: '6px' } },
            tr('Внесите проживание в карте госпитализации — иначе за эти сутки клиника не выставит ничего.')))
      : null;

    modal(tr('Оформление выписки') + ' — ' + (row.patient_name || ''), 'Check', [
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Фактическое время выписки'), atInput),
      h('div', { class: 'muted' }, outcomeTitle(row.discharge_outcome)
        + (row.discharge_destination ? ' · ' + row.discharge_destination : '')),
      row.discharge_recommendations
        ? h('div', { style: { marginTop: '8px' } },
            h('div', { class: 'field-label' }, 'Рекомендации'),
            h('div', { class: 'muted' }, row.discharge_recommendations))
        : null,
      h('div', { class: 'field-label', style: { marginTop: '10px' } }, 'Перед выпиской'),
      orderLine,
      checkField(tr('Счёт закрыт'), billBox),
      checkField(tr('Документы выданы на руки'), docsBox),
      h('label', { class: 'field', style: { marginTop: '10px' } },
        h('span', { class: 'field-label' }, 'Примечание'), noteInput),
      gapBlock,
      debtBlock,
    ], submitBtn, async () => {
      const { data, error } = await supabase.rpc('admission_discharge_finalize', {
        admission_id: row.admission_id,
        at: localToUtcIso(form.at),
        close_orders: !!form.close_orders,
        bill_settled: !!form.bill_settled,
        docs_given: !!form.docs_given,
        debt_ack: !!form.debt_ack,
        note: form.note || '',
      });
      if (error || !data) {
        toast((error && error.message) || tr('Не удалось оформить выписку.'), 'fail');
        return false;
      }
      toast(tr('Выписка оформлена. Койка отправлена на уборку.'), 'ok');
      await load();
      return true;
    });
    syncSubmit();
  }

  // Маленькое окно того же вида, что у остальных экранов (ward-beds.js):
  // подложка закрывает, крестик закрывает, кнопка действия — справа.
  function modal(title, icon, bodyEls, submitBtn, onSubmit) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    submitBtn.addEventListener('click', async () => {
      const prev = submitBtn.textContent;
      submitBtn.disabled = true; submitBtn.textContent = tr('Выполняем…');
      let ok = false;
      try { ok = await onSubmit(); } catch (e) { toast((e && e.message) || tr('Не удалось оформить выписку.'), 'fail'); }
      if (ok) { close(); return; }
      submitBtn.disabled = false; submitBtn.textContent = prev;
    });
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
      h('header', { class: 'modal-head' },
        h('h2', null, Icon(icon, { size: 16 }), ' ', title),
        h('button', { class: 'modal-close', onclick: close }, '×')),
      h('div', { class: 'modal-body', style: { alignContent: 'start' } }, ...bodyEls.filter(Boolean)),
      h('footer', { class: 'modal-foot' },
        h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
        h('span', { class: 'grow' }), submitBtn)));
    document.body.appendChild(overlay);
    return { overlay, close };
  }

  wardSelect.addEventListener('change', () => { state.wardId = wardSelect.value; load(); });
  reloadBtn.addEventListener('click', () => load());

  await loadWards();
  await loadCapabilities();
  await load();
  return { state, reload: load, openFinalize };
}
