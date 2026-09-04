// KITCHEN_SHEET_V1 — ПОРЦИОННИК: заказ на кухню на дату.
//
// Документ, ради которого лечебный стол вообще записывают. К девяти утра кухня
// должна знать, сколько сварить пятого стола и сколько девятого, и получить это
// НА БУМАГЕ: на пищеблоке нет компьютера, а лист с подписью старшей медсестры —
// то, что проверяющий спросит через полгода.
//
// Экран поэтому устроен под печать, а не под чтение: дата, отделение, итог по
// столам крупно сверху и таблица «палата · койка · пациент · стол», сгруппи-
// рованная по палатам ровно так, как медсестра пойдёт с ней по этажу.
//
// ─── ЧТО СЧИТАЕТ СЕРВЕР, А НЕ ЭТОТ ФАЙЛ ─────────────────────────────────────
//
// Кого кормить и на каком столе, решает RPC kitchen_sheet (rpc/diet.js): он
// берёт КАЖДУЮ госпитализацию в койке (IN_BED_STATUSES из
// shared/admission-status.js) и стол, действовавший НА ЭТУ ДАТУ. Считать это в
// браузере нельзя по той же причине, по какой доска коек не считает занятость
// сама: вторая копия правила «пациент в койке» разошлась бы с первой молча, и
// разошлась бы в сторону лишней порции выписанному.
//
// Здесь — только то, что относится к БУМАГЕ: группировка по палатам, подписи и
// печатная форма. Всё это чистые функции, и они экспортируются: тест
// (__tests__/kitchen-sheet.test.mjs) проверяет их без браузера.

import { supabase } from '../../supabase.js';
import { h, clear, toast, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — переводим ПЕРВЫМ, подставляем ВТОРЫМ
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1
// INPATIENT_ROLE_GATE_V1 — тот же список читает и меню (permissions.js
// isModuleAllowed): одна копия, и лежит она у гейта.
import { INPATIENT_SCREEN_ROLES } from '../permissions.js';

// Кто открывает порционник. Врач в списке есть только главный: обычному врачу
// заказ на кухню по всему отделению не нужен — стол своего пациента он видит в
// его карте. Кассы и склада здесь нет: это не документ на деньги.
export const KITCHEN_SHEET_ROLES = INPATIENT_SCREEN_ROLES['kitchen-sheet'];

/**
 * Роли считаются ПО ОБЪЕДИНЕНИЮ основной и дополнительных — так же, как их
 * считает сервер (roles.js effectiveRoles). Старшая медсестра остаётся
 * медсестрой, главный врач — врачом, и обе надстройки живут в extra_roles.
 */
export function canSeeKitchenSheet(user) {
  if (!user || !user.role) return false;
  const extra = Array.isArray(user.extra_roles) ? user.extra_roles : [];
  return [user.role, ...extra].some((r) => KITCHEN_SHEET_ROLES.includes(r));
}

/**
 * Строки порционника — по палатам, в порядке, в каком их прислал сервер.
 *
 * Порядок НЕ пересортировывается: сервер уже отдал их «палата → койка →
 * пациент», а второй порядок сортировки в браузере значил бы, что печатный лист
 * и экран расходятся, стоит одному из двух измениться.
 *
 * Палата без имени собирается в отдельную группу с ward_id = null — пациент без
 * палаты из документа не выпадает: не накормить его хуже, чем напечатать
 * некрасивую строку.
 */
export function groupByWard(rows) {
  const out = [];
  const index = new Map();
  for (const r of rows || []) {
    const key = r && r.ward_id != null ? String(r.ward_id) : '';
    if (!index.has(key)) {
      const g = { ward_id: r && r.ward_id != null ? r.ward_id : null, ward_name: (r && r.ward_name) || null, rows: [] };
      index.set(key, g);
      out.push(g);
    }
    index.get(key).rows.push(r);
  }
  return out;
}

/** Подпись палаты: её имя или «Без палаты». */
export function wardTitle(group) {
  return (group && group.ward_name) ? group.ward_name : tr('Без палаты');
}

/** Подпись стола в строке: имя из справочника или «Стол не назначен». */
export function dietTitle(row) {
  return (row && row.diet_name) ? row.diet_name : tr('Стол не назначен');
}

/**
 * Строка итога для кухни: «Стол №5 — 12 порций».
 *
 * Собирается через trf (перевод ПЕРВЫМ, подстановка ВТОРОЙ): склеенная из
 * кусков строка не переводится ни на один язык, потому что tr() ищет ЦЕЛЫЕ
 * строки (I18N_COVERAGE_V1).
 */
export function portionLine(total) {
  const diet = (total && total.diet_name) ? total.diet_name : tr('Стол не назначен');
  return trf('{diet} — {portions} порц.', { diet, portions: (total && total.portions) || 0 });
}

/** «4-разовое» — разовость питания словами. */
export function mealsTitle(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? trf('{n}-разовое', { n: v }) : '—';
}

// ─── СЛОВАРЬ ПИТАНИЯ — ОДИН НА ВСЕ ЭКРАНЫ ───────────────────────────────────
//
// Приёмы пищи и отметки называются в трёх местах: карта госпитализации
// (разовость), лист медсестры (полоса приёмов) и этот порционник. Три копии
// названий разошлись бы молча — «Полдник» на одном экране и «Полдник» на
// другом перестали бы быть одним и тем же приёмом ровно в тот день, когда
// один из списков поправят. Поэтому список ОДИН, и живёт он там же, где
// остальная кухня.
//
// КЛЮЧИ И ПОРЯДОК — СЕРВЕРНЫЕ (MEAL_KEYS / MEAL_STATUSES в rpc/diet.js).
// Здесь только подписи: и какие приёмы входят в N-разовое питание, и в каком
// порядке они идут, решает сервер (mealsForFrequency) — это факт диетологии, а
// не свойство массива, и второй его копии в браузере нет.
const MEAL_LABEL = {
  breakfast: 'Завтрак',
  breakfast2: 'Второй завтрак',
  lunch: 'Обед',
  tea: 'Полдник',
  dinner: 'Ужин',
  night: 'На ночь',
};

/** Подпись приёма пищи; неизвестный ключ называется собой, а не пустотой. */
export function mealTitle(key) {
  return MEAL_LABEL[key] ? tr(MEAL_LABEL[key]) : String(key || '');
}

// Отметки. 'waiting' — не отметка, а её отсутствие: сервер кладёт его
// умолчанием, и медсестра его не выбирает. Остальные шесть — то, что реально
// случилось с порцией у койки.
export const MEAL_STATUS_OPTIONS = [
  ['served', 'Подан'],
  ['eaten', 'Съеден'],
  ['partial', 'Съеден частично'],
  ['refused', 'Отказ'],
  ['npo', 'НПО (не кормить)'],
  ['missed', 'Пропущен'],
];

const MEAL_STATUS_LABEL = Object.fromEntries([['waiting', 'Не отмечено'], ...MEAL_STATUS_OPTIONS]);

/** Подпись отметки приёма пищи; неотмеченный приём говорит это словом. */
export function mealStatusTitle(status) {
  const key = MEAL_STATUS_LABEL[status] || MEAL_STATUS_LABEL.waiting;
  return tr(key);
}

// Отказ и НПО — не «сделано»: строка обязана читаться с расстояния вытянутой
// руки как проблема, а не как галочка. Тона — те же, что у Tag в остальном
// стационаре.
const MEAL_STATUS_TONE = { eaten: 'ok', served: 'ok', partial: 'warn', refused: 'crit', npo: 'crit', missed: 'crit' };

/** Тон плашки отметки: съеденное зелёное, отказ и НПО красные. */
export function mealStatusTone(status) {
  return MEAL_STATUS_TONE[status] || '';
}

// Разовость питания: 3/4/5/6. Сервер отвергнет любое другое число
// (MEAL_FREQUENCIES в rpc/diet.js) — здесь тот же список, потому что выбор
// нужен ДО запроса, а не после отказа.
export const MEAL_FREQUENCIES = [3, 4, 5, 6];

// ─── Печатная форма ─────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Печатный лист порционника — целиком строкой, без DOM.
 *
 * Ни одной русской буквы в статическом тексте шаблонов: все подписи приходят
 * через tr()/trf() внутри подстановок, поэтому лист печатается на языке, на
 * котором работает клиника, и i18n-аудит (I18N_COVERAGE_V1) его видит.
 *
 * @param {{date:string, wardName?:string|null, totals:Array, rows:Array, totalPortions:number}} sheet
 */
export function kitchenSheetHtml(sheet) {
  const s = sheet || {};
  const groups = groupByWard(s.rows);
  const head = [tr('Палата'), tr('Койка'), tr('Пациент'), tr('Стол'), tr('Разовость'), tr('Примечание')];

  const totalsHtml = (s.totals || [])
    .map((t) => `<span class="p-chip">${esc(portionLine(t))}</span>`).join('');

  const tables = groups.map((g) => `
    <h2 class="p-ward">${esc(wardTitle(g))}</h2>
    <table class="p-tbl">
      <thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${g.rows.map((r) => `<tr>
        <td>${esc(g.ward_name || '')}</td>
        <td>${esc(r.bed_code || '')}</td>
        <td>${esc(r.patient_name || '')}</td>
        <td><b>${esc(dietTitle(r))}</b></td>
        <td>${esc(mealsTitle(r.meals_per_day))}</td>
        <td>${esc(r.diet_note || '')}</td>
      </tr>`).join('')}</tbody>
    </table>`).join('');

  const empty = `<p class="p-empty">${esc(tr('В отделении никто не лежит — порционник пуст.'))}</p>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(trf('Порционник на {date}', { date: s.date || '' }))}</title>
<style>
${PRINT_FONT_FACE_CSS}
@page { size: A4; margin: 12mm; }
body { font-family: 'Onest', -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111; margin: 0; }
h1 { font-size: 20px; margin: 0 0 2px; }
.p-sub { font-size: 13.5px; color: #666; margin: 0 0 14px; }
.p-totals { margin: 0 0 16px; }
.p-chip { display: inline-block; border: 1px solid #ccc; border-radius: 6px; padding: 4px 9px; margin: 0 6px 6px 0; font-size: 13.5px; font-weight: 600; }
.p-ward { font-size: 15px; margin: 16px 0 6px; }
.p-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.p-tbl th { text-align: left; border-bottom: 1.5px solid #333; padding: 5px 6px; font-weight: 700; }
.p-tbl td { border-bottom: 1px solid #ddd; padding: 5px 6px; vertical-align: top; }
.p-empty { font-size: 13.5px; color: #666; }
.p-sign { margin-top: 26px; font-size: 13.5px; color: #333; }
tr, table { page-break-inside: auto; }
thead { display: table-header-group; }
</style></head><body>
<h1>${esc(trf('Порционник на {date}', { date: s.date || '' }))}</h1>
<p class="p-sub">${esc(s.wardName ? s.wardName : tr('Все отделения'))} · ${esc(trf('Всего порций: {count}', { count: s.totalPortions || 0 }))}</p>
<div class="p-totals">${totalsHtml}</div>
${groups.length ? tables : empty}
<p class="p-sign">${esc(tr('Старшая медсестра'))} ______________</p>
<script>window.onload = function () { (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { try { window.focus(); window.print(); } catch (e) {} }); };</scr` + `ipt>
</body></html>`;
}

/** Открыть печатное окно с готовым листом. */
export function printKitchenSheet(sheet) {
  const w = window.open('', '_blank');
  if (!w) { toast('Разрешите всплывающие окна для печати.', 'fail'); return null; }
  w.document.write(kitchenSheetHtml(sheet));
  w.document.close();
  return w;
}

// ─── Экран ──────────────────────────────────────────────────────────────────

const todayLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export async function renderKitchenSheet(root, ctx = {}) {
  const state = { date: todayLocal(), wardId: '', wards: [], sheet: null };

  const wrap = h('div', { class: 'fade-in' });
  root.appendChild(wrap);

  wrap.appendChild(h('div', { class: 'page-head' },
    h('div', null,
      h('h1', { class: 'page-title' }, 'Порционник'),
      h('p', { class: 'page-subtitle' }, 'Заказ на кухню: палата, койка, пациент и лечебный стол на выбранную дату.'))));

  const dateInput = h('input', { type: 'date', class: 'input', value: state.date });
  const wardSelect = h('select', { class: 'input' }, h('option', { value: '' }, 'Все отделения'));
  const printBtn = h('button', { class: 'btn btn-primary' }, Icon('Print'), tr('Печать'));
  const bar = h('div', { class: 'card', style: { display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '14px' } },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Дата'), dateInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Отделение'), wardSelect),
    printBtn);
  wrap.appendChild(bar);

  const body = h('div', null);
  wrap.appendChild(body);

  async function loadWards() {
    const { data } = await supabase.from('wards').select('id,name');
    state.wards = Array.isArray(data) ? data : [];
    for (const w of state.wards) wardSelect.appendChild(h('option', { value: String(w.id) }, w.name || ''));
  }

  async function load() {
    clear(body);
    body.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
    const args = { date: state.date };
    if (state.wardId) args.ward_id = Number(state.wardId);
    const { data, error } = await supabase.rpc('kitchen_sheet', args);
    clear(body);
    if (error || !data) {
      body.appendChild(h('div', { class: 'card muted' }, 'Не удалось загрузить порционник.'));
      state.sheet = null;
      return;
    }
    state.sheet = data;
    render();
  }

  function render() {
    clear(body);
    const s = state.sheet || { rows: [], totals: [], total_portions: 0 };

    // Итог по столам — самое крупное на листе: кухня читает его первым и
    // чаще всего единственным.
    const chips = h('div', { class: 'card', style: { marginBottom: '14px' } },
      h('div', { class: 'card-title' }, 'Итого по столам'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' } },
        ...(s.totals || []).map((t) => h('span', { class: 'tag' }, portionLine(t))),
        h('span', { class: 'tag' }, trf('Всего порций: {count}', { count: s.total_portions || 0 }))));
    body.appendChild(chips);

    const groups = groupByWard(s.rows);
    if (!groups.length) {
      body.appendChild(h('div', { class: 'card muted' }, 'В отделении никто не лежит — порционник пуст.'));
      return;
    }
    for (const g of groups) {
      const rows = g.rows.map((r) => h('tr', null,
        h('td', null, r.bed_code || '—'),
        h('td', null, r.patient_name || '—'),
        h('td', null, h('b', null, dietTitle(r))),
        h('td', null, mealsTitle(r.meals_per_day)),
        h('td', null, r.diet_note || '')));
      body.appendChild(h('div', { class: 'card', style: { marginBottom: '14px' } },
        h('div', { class: 'card-title' }, wardTitle(g)),
        h('table', { class: 'table' },
          h('thead', null, h('tr', null,
            h('th', null, 'Койка'), h('th', null, 'Пациент'), h('th', null, 'Стол'),
            h('th', null, 'Разовость'), h('th', null, 'Примечание'))),
          h('tbody', null, ...rows))));
    }
  }

  dateInput.addEventListener('change', () => { state.date = dateInput.value || todayLocal(); load(); });
  wardSelect.addEventListener('change', () => { state.wardId = wardSelect.value; load(); });
  printBtn.addEventListener('click', () => {
    if (!state.sheet) return;
    const ward = state.wards.find((w) => String(w.id) === String(state.wardId));
    printKitchenSheet({
      date: state.sheet.date,
      wardName: ward ? ward.name : null,
      totals: state.sheet.totals,
      rows: state.sheet.rows,
      totalPortions: state.sheet.total_portions,
    });
  });

  await loadWards();
  await load();
  return { state, reload: load };
}
