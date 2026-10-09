// Generic Excel import + sample-download + export-to-Excel for the CRUD
// section pages. Every section with a `table` + `fields` in sections.js
// gets an importer automatically (config is derived from the field list).
// Hand-tuned overrides live in IMPORT_CONFIGS below — those keep their
// curated column order, sample rows, and autoCreate hints.
//
// section-crud.js asks `hasImporter()` to know whether to show the Sample
// + Import buttons. Export works on every section regardless because we
// just dump whatever columns the list view shows.
//
// SheetJS is loaded lazily from the CDN — no HTML changes needed.

import { supabase } from '../../supabase.js';
import { gw } from '../gateway.js';   // CUSTOM_CLINIC_V3
import { currentClinicId } from '../tenant-tables.js';   // OPENING_STOCK_IMPORT_V1

// SERVICE_GROUP_ROUTING_V1 — the «Раздел» classifier. Its value maps to
// services.type, which routes the service: lab -> #labs, procedure ->
// #procedures, everything else -> the doctor cabinet. Accepts RU + EN aliases.
/* i18n-exempt-start: словарь соответствий импорта (заголовки/значения Excel) — контракт файла, не текст экрана */
const SERVICE_GROUP_LABELS = ['Консультация', 'Лаборатория', 'Процедуры', 'Диагностика', 'Хирургия'];
const SERVICE_GROUP_MAP = {
    'консультация':'consultation','consultation':'consultation','приём':'consultation','прием':'consultation','кабинет':'consultation',
    'лаборатория':'lab','laboratory':'lab','lab':'lab','лаб':'lab','анализ':'lab','анализы':'lab',
    'процедуры':'procedure','процедура':'procedure','procedure':'procedure','procedures':'procedure','манипуляция':'procedure','инъекция':'procedure',
    'диагностика':'imaging','diagnostics':'imaging','imaging':'imaging','узи':'imaging','мрт':'imaging','кт':'imaging','рентген':'imaging',
    'хирургия':'other','surgery':'other','операция':'other','other':'other',
};

// PROCUREMENT_IMPORT_V1 — mirror of PROCUREMENT_CATEGORIES_V1 (procurement.js).
// Fixed catalog categories: stored in clinic_items.procurement_category as the
// stable key; is_drug is derived (key === 'medicines'). Keep the two lists in
// sync when a category is added.
const PROCUREMENT_CATEGORY_LABELS = [
    'Лекарственные средства', 'Медицинские расходные материалы', 'Медицинское оборудование',
    'Лабораторные материалы', 'Стоматологические материалы', 'Материалы для радиологии',
    'Офисные и IT-принадлежности', 'Хозяйственные материалы и обслуживание',
];
const PROCUREMENT_CATEGORY_MAP = {
    // ru labels
    'лекарственные средства': 'medicines', 'медицинские расходные материалы': 'consumables',
    'медицинское оборудование': 'equipment', 'лабораторные материалы': 'lab_supplies',
    'стоматологические материалы': 'dental', 'материалы для радиологии': 'radiology',
    'офисные и it-принадлежности': 'office_it', 'хозяйственные материалы и обслуживание': 'facility',
    // en labels + raw keys
    'medicines': 'medicines', 'medical consumables': 'consumables', 'consumables': 'consumables',
    'medical equipment': 'equipment', 'equipment': 'equipment',
    'laboratory supplies': 'lab_supplies', 'lab_supplies': 'lab_supplies',
    'dental supplies': 'dental', 'dental': 'dental',
    'radiology supplies': 'radiology', 'radiology': 'radiology',
    'office & it supplies': 'office_it', 'office_it': 'office_it',
    'facility & maintenance supplies': 'facility', 'facility': 'facility',
    // short ru shortcuts users actually type
    'лекарства': 'medicines', 'препараты': 'medicines', 'расходники': 'consumables',
    'расходные материалы': 'consumables', 'оборудование': 'equipment', 'лаборатория': 'lab_supplies',
    'стоматология': 'dental', 'радиология': 'radiology', 'офис': 'office_it', 'хозяйственные': 'facility',
};

// STAFF_IMPORT_V1 — mirrors server/services/roles.js PRIMARY_ROLES and the
// STAFF_TYPES list in server/routes/users.js. Both are validated server-side;
// these copies only drive the template's Excel dropdowns and the hints.
//
// INPATIENT_FLOW_V1 — 'head_doctor'/'senior_nurse' здесь НЕТ намеренно: это
// колонка ОСНОВНОЙ роли, а надстроечные роли основными быть не могут (сервер
// проверяет по PRIMARY_ROLES и ответил бы «Unknown role.»). Их выдают в
// карточке сотрудника, в «Дополнительных ролях».
const VALID_ROLE_KEYS = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];   // CALLCENTER_ROLE_V1
const STAFF_TYPE_KEYS = ['doctor', 'admin_staff', 'mid_low'];

// Employee writes go through the admin-only REST routes, not /api/db.
async function usersApi(path, opts = {}) {
    const res = await fetch('/api/users' + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || ('Request failed (' + res.status + ')'));
    return json;
}

// PROCUREMENT_IMPORT_V2 — units of measure for the «Ед.изм» template dropdown.
// Free text is still accepted on import (the product modal is free text too);
// the dropdown just keeps typos out of fresh files. Blank -> 'шт' (matches the
// Add-product modal default).
const PROCUREMENT_UNITS = ['шт', 'уп', 'табл', 'капс', 'амп', 'фл', 'мл', 'л', 'г', 'кг', 'м', 'пара', 'компл', 'наб', 'доза'];

/* i18n-exempt-end */
function _downloadBuffer(buf, filename) {
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// SheetJS community can't write data validation, so post-process the xlsx zip
// (fflate) and inject <dataValidations> right after </sheetData>. SERVICE_GROUP_ROUTING_V1.
async function _injectDataValidations(buf, cfg, XLSX) {
    const { unzipSync, zipSync, strToU8, strFromU8 } = await import('/js/vendor/fflate.js');
    const files = unzipSync(new Uint8Array(buf));
    const path = Object.keys(files).find(k => /worksheets\/sheet1\.xml$/.test(k));
    if (!path) return buf;
    let xml = strFromU8(files[path]);
    const dvs = (cfg.validations || []).map(v => {
        const idx = cfg.columns.findIndex(c => c.key === v.column);
        if (idx < 0) return '';
        const col = XLSX.utils.encode_col(idx);
        return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${col}2:${col}10000"><formula1>&quot;${v.list.join(',')}&quot;</formula1></dataValidation>`;
    }).filter(Boolean);
    if (!dvs.length) return buf;
    xml = xml.replace('</sheetData>', '</sheetData>' + `<dataValidations count="${dvs.length}">${dvs.join('')}</dataValidations>`);
    files[path] = strToU8(xml);
    return zipSync(files);
}
import { h, Icon, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { TIER_STEP_COLUMNS, tierStepsProblem, tierStepRangeProblem } from '../service-editor-logic.js';   // DOCTOR_TIER_V2
import { SECTIONS, FK_LABEL_COLUMN } from '../sections.js?v=noikpu1';
import { mrnSeriesRefusal } from '../patient-duplicates.js';   // MRN_BEYOND_99999_V1 — номер, исчерпавший бы серию года

// CLINIC_API_FIX_V1 — колонки цен второго/повторного визита и их окон: пусто
// значит «не задано» (null), а не 0 (см. transform услуг).
// CLINIC_API_FIX_V1 (ревью итога) — money: цена визита — деньги (не число у
// новой услуги — строка не ввозится); дни — нет.
const VISIT_TIER_COLUMNS = [
    { key: 'price_secondary', money: true }, { key: 'secondary_days_from', int: true }, { key: 'secondary_days_to', int: true },
    { key: 'price_repeat', money: true },    { key: 'repeat_days_from', int: true },    { key: 'repeat_days_to', int: true },
];

// CLINIC_API_FIX_V1 (ревью) — строка услуг ОБНОВИТ существующую услугу, а не
// ляжет новой: стоит «Обновлять существующие» (lookups.__wantUpdate — окно
// импорта кладёт галочку туда и пересобирает строки, когда её меняют) и услуга
// с таким названием есть (lookups.__stored — по normKey названия, так же
// runImport сопоставляет строки по matchField 'name').
function serviceRowUpdates(payload, lookups) {
    return !!(lookups && lookups.__wantUpdate && lookups.__stored
        && lookups.__stored.has(normKey(payload && payload.name)));
}

// CLINIC_API_FIX_V1 (ревью) — правила цен второго и повторного визита из окна
// услуги: server/services/rpc/service-save.js (VISIT_TIER_PRICING_V1 /
// REPEAT_WINDOW_V1), те же проверки и тем же порядком. `t` — значения, которые
// окажутся у услуги (null — не задано). Возвращает переведённую причину или null.
function visitTierProblem(t) {
    const priceBad = (k) => t[k] !== null && !(Number.isFinite(t[k]) && t[k] >= 0);
    const daysBad = (k) => t[k] !== null && !(Number.isInteger(t[k]) && t[k] >= 0);
    const noPrice = t.price_secondary === null && t.price_repeat === null;
    for (const k of ['price_secondary', 'price_repeat']) {
        if (priceBad(k)) return trf('{col} — неотрицательное число.', { col: k });
    }
    for (const k of ['secondary_days_from', 'secondary_days_to']) {
        if (daysBad(k)) return trf('{col} — целое неотрицательное число дней.', { col: k });
    }
    if (t.secondary_days_from !== null && t.secondary_days_to !== null && t.secondary_days_to < t.secondary_days_from) {
        return tr('Окно второго визита: «по день» не может быть раньше «со дня».');
    }
    if ((t.secondary_days_from !== null || t.secondary_days_to !== null) && noPrice) {
        return tr('Укажите цену второго визита — иначе окно дней не на что применить.');
    }
    for (const k of ['repeat_days_from', 'repeat_days_to']) {
        if (daysBad(k)) return trf('{col} — целое неотрицательное число дней.', { col: k });
    }
    if (t.repeat_days_from !== null && t.repeat_days_to !== null && t.repeat_days_to < t.repeat_days_from) {
        return tr('Окно повторного визита: «не позже чем через» не может быть раньше «не раньше чем через».');
    }
    if ((t.repeat_days_from !== null || t.repeat_days_to !== null) && noPrice) {
        return tr('Укажите цену повторного визита — иначе окно дней не на что применить.');
    }
    return null;
}

// EXCEL_SELF_HOST_V1 — served from our own origin (CSP allows 'self'); the
// SheetJS CDN is NOT in the site CSP, so the external import was blocked and
// Sample/Import/Export failed. Normalise default/named exports so XLSX.utils
// resolves regardless of the module namespace shape.
const SHEETJS_URL = '/js/vendor/xlsx-0.20.3.js';
let _xlsxPromise = null;
function loadXlsx() {
    if (!_xlsxPromise) _xlsxPromise = import(/* @vite-ignore */ SHEETJS_URL)
        .then(m => (m && m.utils) ? m : (m && m.default && m.default.utils) ? m.default : m);
    return _xlsxPromise;
}

// ---------------------------------------------------------------------------
// Per-section import config
// ---------------------------------------------------------------------------
// columns[]:
//   key       - column header in the Excel file (also payload field name)
//   required  - true → missing value blocks the row (status=error)
//   fk        - { source: 'table_name', keyField: 'name'|'code', target: 'col_id',
//                 autoCreate?: true }
//               resolves the cell against an existing row in `source` and
//               writes the id into `target`. Missing match → warning by
//               default; with `autoCreate: true` the row is created on the
//               fly so the import never silently drops a label.
//   coerce    - 'num' | 'int' | 'bool' (numeric/boolean parsing)
//   defaultNum / defaultBool - fallback when the cell is blank
//   percent   - CLINIC_API_FIX_V1: a numeric column that also accepts «40%»
//   money     - CLINIC_API_FIX_V1: a money column (price, VAT, any share or
//               percent, visit-tier prices, salary): a non-number here never
//               imports as a new row (status=error); an updating row keeps
//               the saved value
//   raw       - CLINIC_API_FIX_V1: the section's transform reads this numeric
//               column from the sheet row itself; buildRow leaves it alone
//   captureNum - CLINIC_API_FIX_V1: a captured column that holds a number
//   hint      - per-column comment baked into the sample file's header row
// sampleRows[] - pre-filled rows in the downloadable template.
// ---------------------------------------------------------------------------
/* i18n-exempt-start: IMPORT_CONFIGS — контракт Excel-импорта: ключи и алиасы колонок,
   допустимые значения и токены парсинга обязаны оставаться ровно теми словами, которые
   пользователь пишет в файле, на любом языке интерфейса. Подсказки (hint) переведены
   словарём и показываются через tr()/trf(); проверка покрытия для этого блока снята
   сознательно, как для серверных REASONS. */
const IMPORT_CONFIGS = {
    // ITEMS_IMPORT_V1 — clinic products & drugs. Writes go via the gateway.
    clinic_items: {
        table:      'clinic_items',
        sheetName:  'Items',
        sampleFile: 'clinic_items',
        gatewayCrud: true,
        matchField: 'name',
        columns: [
            { key: 'name',     required: true, hint: 'Наименование (обязательно)' },
            { key: 'is_drug',  coerce: 'bool', defaultBool: true,  hint: 'true / false — препарат (лекарство)' },
            { key: 'price',    coerce: 'num',  defaultNum: 0,  money: true, hint: 'Цена, число — напр. 1500' },   // CLINIC_API_FIX_V1 — не число: строка не ввозится
            { key: 'unit',     hint: 'Единица: amp, tab, ml, fl…' },
            { key: 'form',     hint: 'Форма: таблетка, ампула, раствор…' },
            { key: 'strength', hint: 'Дозировка: напр. 500 мг' },
            { key: 'tax_rate', coerce: 'num',  defaultNum: 12, percent: true, money: true, hint: 'НДС % (по умолчанию 12)' },
            { key: 'code',     hint: 'Внутренний код (необязательно)' },
            { key: 'active',   coerce: 'bool', defaultBool: true,  hint: 'true / false (по умолчанию true)' },
        ],
        sampleRows: [
            { name: 'Парацетамол 500 мг',   is_drug: true,  price: 1500, unit: 'tab', form: 'таблетка', strength: '500 мг', tax_rate: 12, active: true },
            { name: 'Натрия хлорид 0.9%',   is_drug: true,  price: 8000, unit: 'fl',  form: 'раствор',  strength: '400 мл', tax_rate: 12, active: true },
            { name: 'Цефтриаксон 1 г',      is_drug: true,  price: 12000, unit: 'amp', form: 'порошок', strength: '1 г',    tax_rate: 12, active: true },
            { name: 'Шприц 5 мл',           is_drug: false, price: 1200, unit: 'pcs', form: '',         strength: '',       tax_rate: 12, active: true },
        ],
    },

    // PROCUREMENT_IMPORT_V1 — «Товары» import for the Procurement module,
    // shaped after the warehouse export the clinics already have (columns
    // КОД / Товар / Остаток / Себестоимость / Цена / ИКПУ). Header row is
    // auto-detected (`headerRow: 'auto'`) because those exports carry a
    // title + blank row above the real header. «Остаток» + «Себестоимость»
    // are captured (not item columns) and posted as opening-stock receipt
    // movements by afterImport — the DB trigger then upserts item_stock.
    // Re-imports never double stock: items that already have a
    // reference_type='import' movement are skipped.
    procurement_items: {
        table:      'clinic_items',
        sheetName:  'Товары',
        sampleFile: 'tovary',
        gatewayCrud: true,
        matchField: 'name',
        headerRow:  'auto',
        validations: [
            { column: 'категория', list: PROCUREMENT_CATEGORY_LABELS },   // native Excel dropdowns
            { column: 'ед.изм',    list: PROCUREMENT_UNITS },             // PROCUREMENT_IMPORT_V2
            { column: 'базовая ед.', list: PROCUREMENT_UNITS },           // PROD_IMPORT_FULL_V1
            { column: 'ед. выдачи',  list: PROCUREMENT_UNITS },
            { column: 'ед. закупки', list: PROCUREMENT_UNITS },
        ],
        transform: function (payload) {
            // PROCUREMENT_CATEGORIES_V1 — is_drug is derived from the category.
            payload.is_drug = payload.procurement_category === 'medicines';
            payload.active  = true;
            // PROCUREMENT_IMPORT_V2 — blank unit counts in pieces, like the
            // Add-product modal default.
            if (!payload.unit) payload.unit = 'шт';
            // PROD_IMPORT_FULL_V1 — blank unit-engine cells must NOT overwrite
            // an existing product's configured units on a matched update.
            if (!payload.base_unit) delete payload.base_unit;
            if (!payload.consumption_unit) delete payload.consumption_unit;
            if (payload.consumption_factor == null || payload.consumption_factor === '' || !(Number(payload.consumption_factor) > 0)) delete payload.consumption_factor;
        },
        columns: [
            { key: 'товар',         target: 'name', required: true, aliases: ['name', 'наименование', 'название'],
              hint: 'Название товара (обязательно). Совпадение по названию обновляет карточку вместо дубля.' },
            { key: 'код',           target: 'code', aliases: ['code', 'артикул'], tmpl: false,   // TMPL_SLIM_V1
              hint: 'Код из старой системы (необязательно).' },
            { key: 'категория',     target: 'procurement_category', map: PROCUREMENT_CATEGORY_MAP, lenient: true,
              aliases: ['category', 'тип'],
              allowedLabel: PROCUREMENT_CATEGORY_LABELS.join(' · '),
              hint: trf('Категория — из списка: {list}. «Лекарственные средства» автоматически помечает товар как препарат. Неизвестное значение пропускается с предупреждением.', { list: PROCUREMENT_CATEGORY_LABELS.join(' · ') }) },
            // PROCUREMENT_IMPORT_V2 — unit of measure. NOTE: the legacy export's
            // «Ед.из» column holds numeric tasnif codes, not readable units, so
            // it is deliberately NOT an alias here — those codes must not leak
            // into clinic_items.unit.
            { key: 'ед.изм',        target: 'unit', aliases: ['unit', 'единица', 'ед.изм.'], tmpl: false,
              hint: trf('Единица измерения — из списка: {list}. Пусто → шт.', { list: PROCUREMENT_UNITS.join(' · ') }) },
            { key: 'цена',          target: 'price', coerce: 'num', defaultNum: 0, money: true, aliases: ['price'], tmpl: false,   // CLINIC_API_FIX_V1
              hint: 'Цена продажи, число — напр. 3210.' },
            { key: 'икпу',          aliases: ['ikpu', 'икпу_код'], tmpl: false,
              fk: { source: 'ikpu_codes', keyField: 'code', target: 'ikpu_code_id', autoCreate: true },
              hint: 'Код ИКПУ (17 цифр) — необязательно; отсутствующие коды создаются автоматически.' },
            { key: 'остаток',       capture: 'qty', captureNum: true, aliases: ['остатки', 'количество', 'qty'], tmpl: false,   // CLINIC_API_FIX_V1 — captureNum: правило числа
              hint: 'Текущий остаток — станет приходом на склад (филиал по умолчанию). Пусто/0 — без прихода.' },
            { key: 'себестоимость', capture: 'cost', captureNum: true, money: true, aliases: ['cost', 'закупочная'], tmpl: false,
              hint: 'Себестоимость — цена прихода для остатка (необязательно).' },
            // PROD_IMPORT_FULL_V1 — the unit engine, as in the product editor.
            { key: 'базовая ед.',   target: 'base_unit', aliases: ['base_unit', 'базовая единица'],
              hint: 'Базовая единица — в ней считается остаток (самая мелкая). Пусто → «ед.изм».' },
            { key: 'ед. выдачи',    target: 'consumption_unit', aliases: ['consumption_unit', 'единица выдачи'],
              hint: 'Как выдаёте пациенту. Обычно совпадает с базовой — можно оставить пусто.' },
            { key: 'кол-во в ед. выдачи', target: 'consumption_factor', coerce: 'num', aliases: ['consumption_factor'],
              hint: 'Сколько базовых единиц в единице выдачи (обычно 1).' },
            // PROD_IMPORT_FULL_V1 — the supplier block, as in the product editor.
            // CLINIC_API_FIX_V1 (ревью 3) — четыре колонки поставщика, пока привязка
            // поставщиков выключена (SUPPLIER_LINK_ON, решение владельца), —
            // просто текст: значение выбрасывается, поэтому ни проверки числа, ни
            // отказа строке. Подсказки шаблона говорят это честно.
            { key: 'поставщик',     capture: 'supplier', aliases: ['supplier'],
              hint: 'Поставщик — пока не используется: из файла поставщики не создаются и к товару не привязываются.' },
            { key: 'цена закупки',  capture: 'supPrice', aliases: ['закупочная цена'],
              hint: 'Цена закупки у поставщика — пока не используется: из файла не сохраняется.' },
            { key: 'ед. закупки',   capture: 'supUnit', aliases: ['единица закупки'],
              hint: 'Единица закупки у поставщика — пока не используется: из файла не сохраняется.' },
            { key: 'кол-во в ед. закупки', capture: 'supPack', aliases: ['кратность закупки'],
              hint: 'Сколько базовых единиц в единице закупки — пока не используется: из файла не сохраняется.' },
        ],
        sampleRows: [
            { 'товар': 'Система трансфузионная стерильная', 'код': '10329', 'категория': 'Медицинские расходные материалы', 'ед.изм': 'шт', 'базовая ед.': 'шт', 'ед. выдачи': 'шт', 'кол-во в ед. выдачи': 1, 'цена': 3210, 'икпу': '03003001018000000', 'остаток': 50,  'себестоимость': 3000, 'поставщик': 'Aventus',  'цена закупки': 3000, 'ед. закупки': 'уп', 'кол-во в ед. закупки': 10 },
            { 'товар': 'Шапочка одноразовая',               'код': '10328', 'категория': 'Медицинские расходные материалы', 'ед.изм': 'уп', 'базовая ед.': 'шт', 'ед. выдачи': 'шт', 'кол-во в ед. выдачи': 1, 'цена': 749,  'икпу': '03003001018000000', 'остаток': 200, 'себестоимость': 700, 'поставщик': 'EasyFarm', 'цена закупки': 700, 'ед. закупки': 'уп', 'кол-во в ед. закупки': 100 },
            { 'товар': 'Перекись водорода 3% 100мл',        'код': '10327', 'категория': 'Лекарственные средства',          'ед.изм': 'фл', 'базовая ед.': 'фл', 'ед. выдачи': 'фл', 'кол-во в ед. выдачи': 1, 'цена': 1225, 'икпу': '03004326008132006', 'остаток': 77,  'себестоимость': 1145, 'поставщик': 'Aventus', 'цена закупки': 1145, 'ед. закупки': 'кор', 'кол-во в ед. закупки': 40 },
            { 'товар': 'Тонометр автоматический',            'код': '10326', 'категория': 'Медицинское оборудование',        'ед.изм': 'шт', 'базовая ед.': 'шт', 'ед. выдачи': 'шт', 'кол-во в ед. выдачи': 1, 'цена': 250000, 'икпу': '', 'остаток': 3, 'себестоимость': 220000, 'поставщик': '', 'цена закупки': '', 'ед. закупки': '', 'кол-во в ед. закупки': '' },
        ],
        // OPENING_STOCK_IMPORT_V1 — post the captured «Остаток» rows as
        // receipt movements into the clinic's primary branch.
        afterImport: async function (validRows) {
            const cid = currentClinicId();
            if (!cid) return null;

            // PROD_IMPORT_FULL_V1 — «Поставщик» column: link (or create) the
            // supplier and store the purchase terms on item_suppliers
            // (last_price / purchase_unit / pack_factor) — the same data the
            // product editor holds. Runs even when the file has no «Остаток».
            async function linkSuppliers() {
                const srows = validRows.filter(r => (r.captures?.supplier || '').trim() && r.payload.name);
                if (!srows.length) return null;
                const supNames = [...new Set(srows.map(r => r.captures.supplier.trim()))];
                const supByName = new Map();
                for (let i = 0; i < supNames.length; i += 100) {
                    const { data } = await supabase.from('suppliers').select('id, name')
                        .eq('company_id', cid).in('name', supNames.slice(i, i + 100));
                    for (const s of (data || [])) supByName.set(normKey(s.name), s.id);
                }
                let created = 0;
                for (const nm of supNames) {
                    if (supByName.has(normKey(nm))) continue;
                    const { data, error } = await supabase.from('suppliers')
                        .insert({ company_id: cid, name: nm, active: true }).select('id').single();
                    if (!error && data) { supByName.set(normKey(nm), data.id); created++; }
                }
                const itemNames = [...new Set(srows.map(r => r.payload.name))];
                const itemByName = new Map();
                for (let i = 0; i < itemNames.length; i += 100) {
                    const { data } = await supabase.from('clinic_items').select('id, name')
                        .eq('company_id', cid).in('name', itemNames.slice(i, i + 100));
                    for (const it of (data || [])) if (!itemByName.has(normKey(it.name))) itemByName.set(normKey(it.name), it.id);
                }
                let linked = 0;
                for (const r of srows) {
                    const itemId = itemByName.get(normKey(r.payload.name));
                    const supId  = supByName.get(normKey(r.captures.supplier.trim()));
                    if (!itemId || !supId) continue;
                    const patch = {};
                    if (r.captures.supPrice != null && r.captures.supPrice !== '' && !isNaN(Number(r.captures.supPrice))) patch.last_price = Number(r.captures.supPrice);
                    if ((r.captures.supUnit || '').trim()) patch.purchase_unit = String(r.captures.supUnit).trim();
                    if (r.captures.supPack != null && r.captures.supPack !== '' && Number(r.captures.supPack) > 0) patch.pack_factor = Number(r.captures.supPack);
                    const { data: ex } = await supabase.from('item_suppliers').select('id')
                        .eq('company_id', cid).eq('item_id', itemId).eq('supplier_id', supId).limit(1);
                    if (ex && ex.length) {
                        if (Object.keys(patch).length) await supabase.from('item_suppliers').update(patch).eq('id', ex[0].id);
                    } else {
                        const { error } = await supabase.from('item_suppliers').insert({ company_id: cid, item_id: itemId, supplier_id: supId, ...patch });
                        if (error) continue;
                    }
                    linked++;
                }
                let m = trf('Поставщики: {n} связок', { n: linked });
                if (created) m += ', ' + trf('создано новых: {n}', { n: created });
                return m;
            }
            // CLINIC_API_FIX_V1 (ревью итога) — создавать поставщиков и их связки из файла — РЕШЕНИЕ ВЛАДЕЛЬЦА; выключено, как и было на деле (колонка «поставщик» читалась как null).
            const SUPPLIER_LINK_ON = false;
            let supMsg = null;
            if (SUPPLIER_LINK_ON) {
                try { supMsg = await linkSuppliers(); }
                catch (e) { supMsg = trf('Поставщики: ошибка — {msg}', { msg: (e && e.message) || e }); }
            }

            const rows = validRows.filter(r => Number(r.captures?.qty || 0) > 0 && r.payload.name);
            if (!rows.length) return supMsg;
            const { data: br } = await supabase.from('branches').select('id')
                .eq('company_id', cid).eq('active', true)
                .order('created_at', { ascending: true }).limit(1);
            const branchId = br && br[0] && br[0].id;
            if (!branchId) return [supMsg, 'Остатки пропущены — у клиники нет активного филиала.'].filter(Boolean).join(' · ');

            // Resolve item ids by name (the importer matched/created them just now).
            const byName = new Map();
            const names = [...new Set(rows.map(r => r.payload.name))];
            for (let i = 0; i < names.length; i += 100) {
                const { data } = await supabase.from('clinic_items').select('id, name')
                    .eq('company_id', cid).in('name', names.slice(i, i + 100));
                for (const it of (data || [])) {
                    const k = normKey(it.name);
                    if (!byName.has(k)) byName.set(k, it.id);
                }
            }

            // Idempotency: an item with an existing import-receipt never gets another.
            const ids = [...new Set(byName.values())];
            const already = new Set();
            for (let i = 0; i < ids.length; i += 100) {
                const { data } = await supabase.from('stock_movements').select('item_id')
                    .eq('company_id', cid).eq('reference_type', 'import')
                    .in('item_id', ids.slice(i, i + 100));
                for (const m of (data || [])) already.add(m.item_id);
            }

            const moves = [];
            let noCard = 0;
            for (const r of rows) {
                const itemId = byName.get(normKey(r.payload.name));
                if (!itemId) { noCard++; continue; }
                if (already.has(itemId)) continue;
                already.add(itemId);   // also guards duplicate names inside one file
                moves.push({
                    company_id: cid, item_id: itemId, branch_id: branchId,
                    kind: 'receipt', qty: Number(r.captures.qty),
                    unit_cost: (r.captures.cost != null && r.captures.cost !== '') ? Number(r.captures.cost) : null,
                    reference_type: 'import', reference_id: null,
                    note: 'Начальный остаток (импорт Excel)',
                });
            }

            let posted = 0;
            for (let i = 0; i < moves.length; i += 100) {
                const batch = moves.slice(i, i + 100);
                const { error } = await supabase.from('stock_movements').insert(batch);
                if (error) return trf('Остатки: создано {n} приходов, дальше ошибка: {msg}', { n: posted, msg: error.message });
                posted += batch.length;
            }
            const skippedDup = rows.length - moves.length - noCard;
            let msg = trf('Остатки: {n} приходов на склад', { n: posted });
            if (skippedDup > 0) msg += ', ' + trf('{n} пропущено (приход уже был)', { n: skippedDup });
            if (noCard > 0) msg += ', ' + trf('{n} без карточки товара', { n: noCard });
            return [supMsg, msg].filter(Boolean).join(' · ');   // PROD_IMPORT_FULL_V1
        },
    },

    services: {
        table:      'services',
        sheetName:  'Services',
        sampleFile: 'services',
        // When `Update existing rows` is ticked in the importer modal, rows
        // whose `name` matches an existing service are UPDATEd (their type /
        // category / department FKs get filled in) instead of inserting a
        // duplicate. Match is case-insensitive and whitespace-normalised.
        matchField: 'name',
        // CLINIC_API_FIX_V1 (ревью) — строка обновит существующую услугу:
        // колонки с keepIfAbsent, которых нет в листе, её не меняют (buildRow).
        rowUpdates: function (r, lookups) { return serviceRowUpdates({ name: r.name }, lookups); },
        // LOCAL_BUILD_V1 — the upstream SaaS wrote services through the
        // service-role gateway because RLS blocked custom services. This build
        // has no gateway (`/api/v1` is not mounted — see server/app.js) and no
        // RLS: `services` is admin-writable straight through /api/db, and
        // leaving `gatewayCrud` on made every service import fail with a 404.
        validations: [{ column: 'group', list: SERVICE_GROUP_LABELS }],   // native Excel dropdown
        // SERVICE_GROUP_ROUTING_V1 — «Раздел» both ROUTES (services.type) and GROUPS
        // (mirrored into a service_type / type_id) so a 7-column sheet is enough.
        transform: function (payload, r, ctx) {
            // CLINIC_API_FIX_V1 (ревью) — колонки «type» в листе нет, а строка
            // ОБНОВЛЯЕТ услугу с тем же «Разделом» — тип не трогается: правка
            // одних цен сбрасывала тип, выбранный клиникой, на тип раздела.
            // Сменился «Раздел» — тип по новому разделу, как раньше.
            var keepType = !('type' in r) && serviceRowUpdates(payload, ctx && ctx.lookups)
                && String((ctx.lookups.__stored.get(normKey(payload.name)) || {}).type || '') === String(payload.type || '');
            if (keepType) delete payload.type_id;
            else if (payload.type && payload.type_id == null) {
                var lbl = { consultation: 'Консультации', lab: 'Лаборатория', procedure: 'Процедуры', imaging: 'Диагностика', other: 'Хирургия' }[payload.type];
                if (lbl) payload.type_id = { __autoCreate: { table: 'service_types', keyField: 'name', value: lbl } };
            }
            // EXTERNAL_LAB_V1 — «Внешняя лаборатория»: заголовка в листе нет —
            // отметка не трогается (тот же договор, что у ступеней ниже); у
            // не-лабораторной услуги отметки не бывает (как в service_save).
            if (!('external_lab' in r)) delete payload.external_lab;
            else payload.external_lab = payload.type === 'lab' ? !!payload.external_lab : false;
            // CLINIC_API_FIX_V1 — онлайн-запись по правилу окна услуги
            // (service_save, SERVICE_NAMES_ONLINE_V1): включить её можно только
            // с узбекским названием — русское (name) обязательно у любой строки.
            // Раньше флаг ложился в колонку как есть. Строка без узбекского
            // названия ввозится без онлайн-записи и говорит об этом с номером
            // строки файла. Заголовка online_booking в листе нет — отметка не
            // трогается (тот же договор, что у external_lab и ступеней): файл,
            // выгруженный до онлайн-записи, не выключает её при обновлении.
            //
            // CLINIC_API_FIX_V1 (ревью) — при ОБНОВЛЕНИИ существующей услуги
            // узбекское название — то, что у неё окажется: пустая текстовая
            // ячейка в запись не идёт (сохранённое остаётся), колонки может не
            // быть вовсе. Сохранённое считается, только если строка правда
            // обновит услугу (serviceRowUpdates: «Обновлять существующие» и
            // услуга с этим названием есть); новая услуга его не получит.
            var storedUz = serviceRowUpdates(payload, ctx && ctx.lookups)
                ? String((ctx.lookups.__stored.get(normKey(payload.name)) || {}).name_uz || '').trim() : '';
            if (!('online_booking' in r)) delete payload.online_booking;
            else if (payload.online_booking && !String(payload.name_uz || '').trim() && !storedUz) {
                payload.online_booking = false;
                if (ctx) ctx.warn(trf('Строка {n}, «{service}»: онлайн-запись не включена: нет названия на узбекском.',
                    { n: ctx.rowNum, service: String(payload.name || '').trim() }));
            }
            // CLINIC_API_FIX_V1 — цены второго и повторного визита и их окна
            // (VISIT_TIER_PRICING_V1 / REPEAT_WINDOW_V1) ПУСТЫЕ, пока клиника их
            // не задала: пусто — «как первый визит». Числовая колонка писала 0
            // и без заголовка в листе, и под пустой ячейкой (выгрузка пишет
            // пустую ячейку у каждой услуги без ступеней). А 0 для цены визита —
            // «бесплатно»: visit-tier.js видел у услуги ступени с окном 0…0 дней,
            // и второй визит в тот же день выставлялся по 0. Теперь: заголовка
            // нет — не трогается; ячейка пустая или не число («—», «нет») — не
            // задано (null); число — как есть (0 — осознанное «бесплатно»).
            //
            // CLINIC_API_FIX_V1 (ревью) — не число в непустой ячейке строка
            // называет (номер строки, колонка, значение). Дни не округляются:
            // дробный день — нарушение правила ниже, как в окне услуги.
            //
            // CLINIC_API_FIX_V1 (ревью итога) — ячейка читается общим правилом
            // числа (readImportNumber: «60 000», «12,5»; «1,5» дня — не 15).
            // Не число в строке, ОБНОВЛЯЮЩЕЙ услугу, — поле не пишется:
            // сохранённая цена остаётся (раньше она стиралась в «не задано»).
            var svcName = String(payload.name || '').trim();
            var tierUpdating = serviceRowUpdates(payload, ctx && ctx.lookups);
            VISIT_TIER_COLUMNS.forEach(function (c) {
                if (!(c.key in r)) { delete payload[c.key]; return; }
                var read = readImportNumber(r[c.key], false);
                // Ревью 3 (решение) — пустая цена визита у обновляемой услуги
                // оставляет сохранённую; дни окна (не деньги) — «не задано», как было.
                if (read.empty && c.money && tierUpdating) {
                    delete payload[c.key];
                    if (ctx) ctx.note(trf('Строка {n}: {col} пусто — оставлено как было.', { n: ctx.rowNum, col: c.key }));
                    return;
                }
                if (!('bad' in read)) { payload[c.key] = read.empty ? null : read.n; return; }
                if (tierUpdating) {
                    delete payload[c.key];
                    if (ctx) ctx.warn(trf('Строка {n}: в колонке {col} не число («{v}») — оставлено сохранённое значение.',
                        { n: ctx.rowNum, col: c.key, v: read.bad }));
                    return;
                }
                // CLINIC_API_FIX_V1 (ревью итога, решение) — цена визита — деньги:
                // новая услуга с не числом в ней не ввозится (как с ценой). Дни —
                // не задано, вслух.
                if (c.money) {
                    if (ctx) ctx.fail(trf('Строка {n}: в колонке {col} не число («{v}») — строка не импортирована.',
                        { n: ctx.rowNum, col: c.key, v: read.bad }));
                    return;
                }
                payload[c.key] = null;
                if (ctx) ctx.warn(trf('Строка {n}: в колонке {col} не число («{v}») — не записано.',
                    { n: ctx.rowNum, col: c.key, v: read.bad }));
            });
            // CLINIC_API_FIX_V1 (ревью) — правила окна услуги (service_save:
            // цена — неотрицательное число, дни — целые неотрицательные, «по»
            // не раньше «с», окно без цены не задаётся) — по тому, что окажется
            // у услуги: файл поверх сохранённого, когда строка её обновляет.
            // Нарушила — цены второго и повторного визита из этой строки не
            // пишутся (остаются прежние / не заданы), строка говорит почему.
            var tierStored = serviceRowUpdates(payload, ctx && ctx.lookups)
                ? (ctx.lookups.__stored.get(normKey(payload.name)) || {}) : {};
            var tierEff = {};
            VISIT_TIER_COLUMNS.forEach(function (c) {
                var v = (c.key in payload) ? payload[c.key] : tierStored[c.key];
                tierEff[c.key] = v === undefined || v === null || v === '' ? null : Number(v);
            });
            var tierProblem = visitTierProblem(tierEff);
            if (tierProblem) {
                VISIT_TIER_COLUMNS.forEach(function (c) { delete payload[c.key]; });
                if (ctx) ctx.warn(trf('Строка {n}, «{service}»: {problem} Цены второго и повторного визита из этой строки не сохранены.',
                    { n: ctx.rowNum, service: svcName, problem: tierProblem }));
            }
            // DOCTOR_TIER_V1 — КОЛОНКИ, КОТОРОЙ В ФАЙЛЕ НЕТ, В ПАМЯТИ НЕ БЫВАЕТ.
            // Числовые колонки пишутся в payload всегда, даже когда заголовка в
            // листе нет вовсе: обновление услуг файлом, выгруженным ДО ступеней,
            // писало ступени в ноль и молча стирало настройку по всему
            // прайс-листу. `in r` — это «заголовок был в листе» (buildRow кладёт
            // ключ на каждый ЗАГОЛОВОК, даже с пустой ячейкой), а не «ячейка
            // заполнена»: пустая ячейка под своим заголовком по-прежнему значит
            // «ступени нет», и это осознанное решение клиники.
            //
            // DOCTOR_TIER_V2 — то же для каждой из трёх ступеней по отдельности:
            // ступень, чьих колонок в листе нет, остаётся как была.
            //
            // Правки ревью:
            //  • границы чисел — те же отказы, что у service_save
            //    (tierStepRangeProblem): 7.5 или 120 % не округляются молча, а
            //    ступень из файла не сохраняется, и строка говорит почему;
            //  • порядок проверяется по СЛИТЫМ ступеням — файл поверх
            //    СОХРАНЁННЫХ (ctx.lookups.__stored, по названию). Файл,
            //    выгруженный до ступеней 2–3, поднимал порог 1 выше
            //    сохранённого порога 2, и отчёт молча переставал платить
            //    ступени 2–3. Теперь при нарушении не пишется НИ ОДНА колонка
            //    ступеней этой строки, а строка называет услугу и правило.
            var HALF_MSG = {
                1: 'Ступень: заполните и порог, и долю — полупара не сохранена',
                2: 'Ступень 2: заполните и порог, и долю — полупара не сохранена',
                3: 'Ступень 3: заполните и порог, и долю — полупара не сохранена',
            };
            var who = String(payload.name || '').trim();
            var storedMap = ctx && ctx.lookups && ctx.lookups.__stored;
            var stored = storedMap ? (storedMap.get(normKey(who)) || null) : null;
            // CLINIC_API_FIX_V1 (ревью итога) — ячейки ступени читаются общим
            // правилом числа (readImportNumber; доля — колонка процентов: «40%»).
            // Не число — ступень из файла не пишется (сохранённая остаётся), и
            // строка называет колонку и ячейку.
            var fileSteps = TIER_STEP_COLUMNS.map(function (c) {
                if (!(c.from in r) && !(c.pct in r)) {
                    delete payload[c.from]; delete payload[c.pct];
                    return null;
                }
                var rf = readImportNumber(r[c.from], false), rp = readImportNumber(r[c.pct], true);
                var bad = ('bad' in rf) ? [c.from, rf.bad] : ('bad' in rp) ? [c.pct, rp.bad] : null;
                // CLINIC_API_FIX_V1 (ревью итога, решение) — доля ступени — деньги:
                // у новой услуги не число в ней строку не ввозит.
                // Ревью 3 — и доля вне 0…100 % (у обновляемой услуги её назовёт
                // проверка границ ниже, а ступень из файла не запишется).
                var pctWhy = ('n' in rp) && (rp.n > 100 || rp.n < 0) ? tr(rp.n > 100 ? 'доля больше 100%' : 'доля меньше 0%') : null;
                if ((('bad' in rp) || pctWhy) && !serviceRowUpdates(payload, ctx && ctx.lookups)) {
                    delete payload[c.from]; delete payload[c.pct];
                    if (ctx) ctx.fail(pctWhy
                        ? trf('Строка {n}: в колонке {col} {why} («{v}») — строка не импортирована.',
                            { n: ctx.rowNum, col: c.pct, why: pctWhy, v: String(r[c.pct]).trim() })
                        : trf('Строка {n}: в колонке {col} не число («{v}») — строка не импортирована.',
                            { n: ctx.rowNum, col: c.pct, v: rp.bad }));
                    return null;
                }
                if (bad) {
                    delete payload[c.from]; delete payload[c.pct];
                    if (ctx) ctx.warn(trf('Строка {n}, «{service}»: в колонке {col} не число («{v}») — ступень {step} из файла не сохранена.',
                        { n: ctx.rowNum, service: who, col: bad[0], v: bad[1], step: c.n }));
                    return null;
                }
                var rawFrom = rf.empty ? '' : String(rf.n), rawPct = rp.empty ? '' : String(rp.n);
                // Ревью 3 (решение) — у обновляемой услуги пустая ступень (обе
                // ячейки пусты) оставляет сохранённую, а не обнуляет её.
                var stepUpdating = serviceRowUpdates(payload, ctx && ctx.lookups);
                if (stepUpdating && rf.empty && rp.empty) {
                    delete payload[c.from]; delete payload[c.pct];
                    if (ctx) ctx.note(trf('Строка {n}: {col} пусто — оставлено как было.', { n: ctx.rowNum, col: c.from + ' / ' + c.pct }));
                    return null;
                }
                var range = tierStepRangeProblem(c.n, rawFrom, rawPct);
                if (range) {
                    delete payload[c.from]; delete payload[c.pct];
                    if (ctx) ctx.warn(trf('«{service}»: {problem} Ступень {n} из файла не сохранена.', { service: who, problem: tr(range), n: c.n }));
                    return null;
                }
                payload[c.from] = Number(rawFrom) || 0;
                payload[c.pct] = Number(rawPct) || 0;
                // Пара или ничего: полупара из файла застряла бы в редакторе
                // (service_save отказывает половине настройки). Отброшенная
                // полупара называется вслух.
                if (!payload[c.from] || !payload[c.pct]) {
                    var half = payload[c.from] || payload[c.pct];
                    // Ревью 3 (решение) — у обновляемой услуги полупара не
                    // обнуляет сохранённую ступень: ступень из файла не пишется.
                    if (half && stepUpdating) {
                        delete payload[c.from]; delete payload[c.pct];
                        if (ctx) ctx.warn(tr(HALF_MSG[c.n]));
                        return null;
                    }
                    payload[c.from] = 0; payload[c.pct] = 0;
                    if (half && ctx) ctx.warn(tr(HALF_MSG[c.n]));
                }
                return { from: payload[c.from], pct: payload[c.pct] };
            });
            if (fileSteps.every(function (st) { return !st; })) return;
            var merged = TIER_STEP_COLUMNS.map(function (c, k) {
                if (fileSteps[k]) return fileSteps[k];
                return stored ? { from: Number(stored[c.from]) || 0, pct: Number(stored[c.pct]) || 0 } : { from: 0, pct: 0 };
            });
            var problem = tierStepsProblem(merged);
            if (problem) {
                TIER_STEP_COLUMNS.forEach(function (c) { delete payload[c.from]; delete payload[c.pct]; });
                if (ctx) ctx.warn(trf('«{service}»: {problem} Ступени из файла не сохранены — остаются прежние.', { service: who, problem: tr(problem.message) }));
            }
        },
        // DOCTOR_TIER_V2 — сохранённые ступени услуг (по названию) для сверки
        // порядка при обновлении: loadLookups кладёт их в lookups.__stored.
        // CLINIC_API_FIX_V1 (ревью) — и узбекское название: онлайн-запись
        // при обновлении услуги без name_uz в файле (serviceRowUpdates); и
        // «Раздел» с типом: обновление без колонки типа тип не сбрасывает; и
        // цены второго/повторного визита с окнами — правила окна услуги
        // проверяются по тому, что окажется у услуги (visitTierProblem).
        storedColumns: ['doctor_tier_from', 'doctor_tier_percent', 'doctor_tier_from_2', 'doctor_tier_percent_2', 'doctor_tier_from_3', 'doctor_tier_percent_3', 'name_uz', 'type', 'type_id',
            'price_secondary', 'secondary_days_from', 'secondary_days_to', 'price_repeat', 'repeat_days_from', 'repeat_days_to'],
        columns: [
            { key: 'name',             required: true, hint: 'Название услуги (обязательно)' },
            { key: 'group',            target: 'type', map: SERVICE_GROUP_MAP, required: true,
              // DATA_TRANSFER_V1 — many labels map onto one value, so name the
              // one an export writes back (otherwise «lab» could come out as
              // «анализ» and the round-trip would look lossy).
              reverseMap: { consultation: 'Консультация', lab: 'Лаборатория', procedure: 'Процедуры', imaging: 'Диагностика', other: 'Хирургия' },
              allowedLabel: SERVICE_GROUP_LABELS.join(' · '),
              hint: 'Раздел — из списка (обязательно): Консультация · Лаборатория · Процедуры · Диагностика · Хирургия. Куда попадает услуга: Лаборатория→лаб.модуль, Процедуры→процедурный лист, остальное→кабинет врача.' },
            // SERVICE_IMPORT_TYPECAT_V1 — optional classification (create-or-get, company-scoped)
            // SERVICE_IMPORT_TYPE_NO_AUTOCREATE_V1 — the registration picker's group
            // rail lists service_types (CUSTOM_CLINIC_V1), so an import must not
            // invent new groups. Unknown type values warn and fall back to the
            // «Раздел» mirror type via transform; category/department still auto-create.
            { key: 'type',             fk: { source: 'service_types',      keyField: 'name', target: 'type_id' }, hint: 'Тип услуги — только из существующих типов клиники; необязательно. Пусто или неизвестное значение → тип подставляется по «Разделу».' },
            // CLINIC_API_FIX_V1 (ревью) — keepIfAbsent: колонки нет в листе —
            // обновляемая услуга её не меняет (было: стирались категория,
            // отделение, кабинет; цена, НДС, длительность, доля, «нужен врач» и
            // «активна» — по умолчанию). Новая услуга получает то же, что и раньше.
            { key: 'category',         keepIfAbsent: true, fk: { source: 'service_categories', keyField: 'name', target: 'category_id',   autoCreate: true }, hint: 'Категория/направление (напр. МРТ головного мозга) — необязательно; создаётся автоматически.' },
            { key: 'department',       keepIfAbsent: true, fk: { source: 'departments',        keyField: 'name', target: 'department_id', autoCreate: true }, hint: 'Отделение — необязательно; создаётся автоматически.' },
            // IMPORT_PRICE_OPTIONAL_V1 — price used to be required, which blocked
            // importing price-lists that get priced after upload. Missing price
            // now imports as 0 with a warning instead of an error.
            // CLINIC_API_FIX_V1 (ревью итога) — money: не число в цене (НДС, доле,
            // цене визита…) новой услуги — строка не ввозится (у обновляемой —
            // поле остаётся прежним).
            // CLINIC_API_FIX_V1 (ревью 3, решение) — requiredOnNew: новая услуга без
            // цены не ввозится («укажите цену (0 — если бесплатно)»); у обновляемой
            // пустая ячейка оставляет сохранённую цену.
            { key: 'price',            keepIfAbsent: true, coerce: 'num',  defaultNum: 0,  money: true, requiredOnNew: true, hint: 'Цена, число — напр. 150000 (0 — бесплатно)' },
            // FULL_EXPORT_V1 (2026-09-14) — owner: «exporting and importing are not
            // giving all the information». Every field the service editor holds now
            // travels: code, the visit-tier prices (VISIT_TIER_PRICING_V1), the
            // performer share, the room, and the lab block. All optional; a sheet
            // without these columns imports exactly as before.
            { key: 'code',             hint: 'Внутренний код (необязательно)' },
            // SERVICE_NAMES_ONLINE_V1 — the uz/en names and the online flag.
            // CLINIC_API_FIX_V1 — an online row without a uz name imports with
            // the flag off and a warning (transform above), as the dialog refuses it.
            { key: 'name_uz',          hint: 'Название на узбекском (обязательно для онлайн-записи)' },
            { key: 'name_en',          hint: 'Название на английском (необязательно)' },
            { key: 'online_booking',   coerce: 'bool', defaultBool: false, hint: 'true / false — доступна для онлайн-записи (нужны названия ru и uz)' },
            // CLINIC_API_FIX_V1 (ревью итога) — raw: эти колонки читает transform
            // выше из строки листа (тем же readImportNumber), buildRow их не трогает.
            { key: 'price_secondary',  coerce: 'num', raw: true, hint: 'Цена второго визита (пусто — как первый)' },
            { key: 'secondary_days_from', coerce: 'int', raw: true, hint: 'Второй визит — не раньше чем через N дней после предыдущего' },
            { key: 'secondary_days_to',   coerce: 'int', raw: true, hint: 'и не позже чем через M дней (пусто — без предела)' },
            { key: 'price_repeat',     coerce: 'num', raw: true, hint: 'Цена повторного визита, третий и далее (0 — бесплатно; пусто — как второй)' },
            { key: 'repeat_days_from', coerce: 'int', raw: true, hint: 'Повторный визит — не раньше чем через N дней после предыдущего (пусто — как у второго)' },
            { key: 'repeat_days_to',   coerce: 'int', raw: true, hint: 'и не позже чем через M дней (пусто — как у второго)' },
            { key: 'tax_rate',         keepIfAbsent: true, coerce: 'num',  defaultNum: 12, percent: true, money: true, hint: 'НДС % (по умолчанию 12, если пусто)' },
            { key: 'duration_minutes', keepIfAbsent: true, coerce: 'int',  defaultNum: 30, hint: 'Длительность, мин (по умолчанию 30, если пусто)' },
            { key: 'requires_doctor',  keepIfAbsent: true, coerce: 'bool', defaultBool: true, hint: 'true / false — нужен врач (по умолчанию true)' },
            { key: 'default_doctor_percent', keepIfAbsent: true, coerce: 'num', percent: true, money: true, hint: 'Доля исполнителя по умолчанию, % (необязательно)' },
            // CLINIC_API_FIX_V1 (ревью итога) — ступени тоже читает transform (raw).
            { key: 'doctor_tier_from',    coerce: 'num', raw: true, hint: 'Ступень: порог услуг в месяц — повышенная доля начинается со следующей услуги (0 или пусто — ступени нет)' },
            { key: 'doctor_tier_percent', coerce: 'num', raw: true, hint: 'Ступень: доля исполнителя выше порога, % (задаётся вместе с порогом)' },
            // DOCTOR_TIER_V2 — ступени 2 и 3: пороги строго растут, заполняются по порядку.
            { key: 'doctor_tier_from_2',    coerce: 'num', raw: true, hint: 'Ступень 2: порог услуг в месяц — больше порога ступени 1 (0 или пусто — ступени нет)' },
            { key: 'doctor_tier_percent_2', coerce: 'num', raw: true, hint: 'Ступень 2: доля исполнителя выше порога, % (задаётся вместе с порогом)' },
            { key: 'doctor_tier_from_3',    coerce: 'num', raw: true, hint: 'Ступень 3: порог услуг в месяц — больше порога ступени 2 (0 или пусто — ступени нет)' },
            { key: 'doctor_tier_percent_3', coerce: 'num', raw: true, hint: 'Ступень 3: доля исполнителя выше порога, % (задаётся вместе с порогом)' },
            { key: 'room',             keepIfAbsent: true, fk: { source: 'rooms', keyField: 'name', target: 'room_id' }, hint: 'Кабинет (очередь диагностики) — по названию из справочника; необязательно' },
            { key: 'specimen',         hint: 'Лаборатория: материал (кровь, моча…) — необязательно' },
            { key: 'tube_color',       hint: 'Лаборатория: пробирка — light_blue, red, gold, green, lavender, pink, grey, royal_blue, yellow_acd, black, none' },
            // EXTERNAL_LAB_V1 — только подпись; пустая ячейка под заголовком = нет.
            { key: 'external_lab',     coerce: 'bool', defaultBool: false, hint: 'Лаборатория: true / false — внешняя лаборатория (анализ делает другая клиника, результат вносится у нас)' },
            { key: 'active',           keepIfAbsent: true, coerce: 'bool', defaultBool: true, hint: 'true / false — активна (по умолчанию true)' },
        ],
        // SERVICE_IMPORT_TYPE_NO_AUTOCREATE_V1 — sample rows leave `type` blank so
        // the template demonstrates the safe default (group comes from «Раздел»).
        sampleRows: [
            { name: 'Приём кардиолога',      group: 'Консультация', category: 'Приём кардиолога',   department: 'Поликлиника', price: 250000, tax_rate: 12, duration_minutes: 30, requires_doctor: true,  active: true },
            { name: 'МРТ головного мозга',   group: 'Диагностика',  category: 'МРТ головного мозга', department: 'Диагностика', price: 400000, tax_rate: 12, duration_minutes: 30, requires_doctor: false, active: true },
            { name: 'Общий анализ крови',    group: 'Лаборатория',  category: 'ОАК',                department: 'Лаборатория', price: 80000,  tax_rate: 12, duration_minutes: 15, requires_doctor: false, active: true },
            { name: 'Внутривенная инъекция', group: 'Процедуры',    category: 'В/в инъекции',       department: 'Процедурная', price: 30000,  tax_rate: 12, duration_minutes: 10, requires_doctor: false, active: true },
        ],
    },

    patients: {
        table:      'patients',
        sheetName:  'Patients',
        sampleFile: 'patients',
        // Dedup on MRN first, then PINFL. An exported file always carries an MRN
        // (it is assigned on registration), so export -> edit -> import updates
        // people instead of duplicating the register; a hand-written sheet
        // usually has only a PINFL, which still matches. Rows with neither always
        // insert, so the sample imports cleanly. DATA_TRANSFER_V1.
        matchFields: ['mrn', 'national_id'],
        // MRN_BEYOND_99999_V1 (ревью 1) — новая карта с номером 999 999 000…
        // 999 999 999 не ввозится: триггер номера (миграция 232) дальше такого
        // номера не выдаёт, и одна заглушка остановила бы регистрацию до конца
        // года. Строка отказывается с причиной, остальные ложатся.
        validateInsert: (payload) => mrnSeriesRefusal(payload.mrn),
        columns: [
            { key: 'last_name',          required: true, hint: 'Family name (required)' },
            { key: 'first_name',         required: true, hint: 'Given name (required)' },
            { key: 'middle_name',        hint: 'Patronymic / middle name (optional)' },
            // IMPORT_DATE_V1 — accepts Excel date cells (which arrive as a serial
            // number like 32874), plus 12.04.1990 / 12/04/1990 / 1990-04-12.
            { key: 'date_of_birth',      coerce: 'date',
              hint: 'Дата — 1990-04-12, 12.04.1990, 12/04/1990 или дата из Excel. День впереди при неоднозначности.' },
            { key: 'gender',             hint: 'male / female (also accepts m · f · erkak · ayol · муж · жен)' },
            { key: 'phone',              hint: 'Contact phone — e.g. +998901234567' },
            { key: 'email',              hint: 'Email (optional)' },
            { key: 'national_id',        hint: 'PINFL — 14 digits. Used to avoid duplicates on re-import.' },
            { key: 'nationality',        hint: 'Nationality — e.g. Uzbek' },
            { key: 'address',            hint: 'Street address (optional)' },
            // LOCAL_BUILD_V1 — `passport_number`, `region` and `district` used to
            // be listed here, but this build's `patients` table has no such
            // columns (see server/db/migrations). The write layer silently drops
            // unknown keys, so those three sat in the template and the export
            // looking supported while importing into nothing.
            { key: 'blood_type',         hint: 'Blood group — one of: A+ A- B+ B- AB+ AB- O+ O- unknown' },
            { key: 'allergies',          hint: 'Comma-separated — e.g. Penicillin, Latex. Leave blank for none.' },
            { key: 'chronic_conditions', hint: 'Comma-separated — e.g. Hypertension, Diabetes.' },
            // FULL_EXPORT_V1 (2026-09-14) — the rest of the patient window, so an
            // export carries the whole card and an edited sheet brings it back.
            // PATIENT_FORM_ONE_V1 gave these columns a home (migration 129).
            { key: 'category',           fk: { source: 'patient_categories', keyField: 'name', target: 'category_id' }, hint: 'Категория пациента — по названию из справочника (VIP, Сотрудник…); необязательно' },
            { key: 'phone_secondary',    hint: 'Доп. номер телефона' },
            { key: 'passport_number',    hint: 'Паспорт / документ №' },
            { key: 'citizenship',        hint: 'resident / nonresident' },
            { key: 'language',           hint: 'Предпочитаемый язык: Узбекский, Русский, Английский, Каракалпакский' },
            { key: 'country',            hint: 'Страна (по названию из Настройки → География)' },
            { key: 'region',             hint: 'Регион' },
            { key: 'district',           hint: 'Район' },
            { key: 'mahalla',            hint: 'Махалля' },
            { key: 'occupation',         hint: 'Профессия' },
            { key: 'marital_status',     hint: 'Семейное положение: single / married / divorced / widowed' },
            { key: 'emergency_contact_name',     hint: 'Экстренный контакт — имя' },
            { key: 'emergency_contact_phone',    hint: 'Экстренный контакт — телефон' },
            { key: 'emergency_contact_relation', hint: 'Экстренный контакт — кем приходится' },
            { key: 'behavior_note',      hint: 'Поведение / предупреждение для регистратуры' },
            { key: 'insurance_policy_number', hint: 'Номер страхового полиса' },
            { key: 'insurance_expiry_date',   coerce: 'date', hint: 'Полис действует до — 2027-05-01, 01.05.2027 или дата из Excel' },
            { key: 'registration_date',  coerce: 'date', hint: 'Дата регистрации (пусто — сегодня)' },
            { key: 'notes',              hint: 'Заметки' },
            // BRANCH_IDENTITY_V1 (migration 080) — the prefix is no longer the
            // literal 'P': it is the letter of the branch this install IS, so the
            // main branch mints A-26-00042 and a secondary mints C-26-00042. The
            // hint names the shape rather than a letter, because the same template
            // is downloaded on every branch's PC.
            //
            // Bare literal, NOT tr(), and deliberately: none of the sixteen hints
            // in this file is in STRINGS, so wrapping only this one would make the
            // downloaded template fifteen English hints plus one Russian. These
            // strings are also baked into the .xlsx as header-cell comments from a
            // module-level const, so a tr() here would resolve once at import and
            // ignore a later language switch. Translating the template is a real
            // change — all sixteen, evaluated when the file is built — not a
            // drive-by on the one line that had the wrong format in it.
            { key: 'mrn',                hint: 'Leave blank — assigned automatically: branch letter, year, number (e.g. A-26-00042).' },
            { key: 'active',             coerce: 'bool', defaultBool: true, hint: 'true / false (default true)' },
        ],
        // Schema requires full_name NOT NULL; synthesize it from the name
        // parts when the cell is blank, and normalise gender to the DB values.
        transform: (payload) => {
            if (payload.gender) {
                const g = String(payload.gender).trim().toLowerCase();
                payload.gender = ['m', 'male', 'erkak', 'м', 'муж', 'мужской'].includes(g) ? 'male'
                               : ['f', 'female', 'ayol', 'ж', 'жен', 'женский'].includes(g) ? 'female'
                               : g;
            }
            if (!payload.full_name) {
                payload.full_name = [payload.last_name, payload.first_name, payload.middle_name]
                    .filter(Boolean).join(' ').trim();
            }
            return payload;
        },
        sampleRows: [
            { last_name: 'Karimova',      first_name: 'Aziza',    middle_name: 'R.',           date_of_birth: '1990-04-12', gender: 'female', phone: '+998901234567', email: 'aziza.k@example.com', national_id: '31204900010011', nationality: 'Uzbek', address: 'Amir Temur 12, apt. 47', blood_type: 'A+', allergies: 'Penicillin', chronic_conditions: 'Hypertension', mrn: '', active: true },
            { last_name: 'Azizxojayev',   first_name: 'Iskandar', middle_name: '',             date_of_birth: '1992-01-12', gender: 'male',   phone: '+998895555555', email: '',                    national_id: '',               nationality: 'Uzbek', address: '',                       blood_type: 'O+', allergies: '',           chronic_conditions: '',             mrn: '', active: true },
            { last_name: 'Rakhimkhujaev', first_name: 'Dilshod',  middle_name: 'Ramiz oʻgʻli', date_of_birth: '1995-06-22', gender: 'male',   phone: '+998950768008', email: '',                    national_id: '',               nationality: 'Uzbek', address: '',                       blood_type: 'B+', allergies: '',           chronic_conditions: '',             mrn: '', active: true },
        ],
    },

    // STAFF_IMPORT_V1 — employees / doctors. `users` is READ-ONLY through
    // /api/db (server/db/schema-registry.js grants no insert/update roles), so
    // writes go through the admin-only REST routes at /api/users, which own the
    // password hashing, role validation and the last-admin guard. `restCrud`
    // below is the importer's third write path alongside supabase + gateway.
    users: {
        table:      'users',
        sheetName:  'Employees',
        sampleFile: 'employees',
        // A username is a person's login — it is the only stable identity in
        // the sheet, so re-importing a roster updates staff instead of failing
        // on "Username already exists".
        matchField: 'username',
        restCrud: {
            insert: (payload) => usersApi('', { method: 'POST',  body: JSON.stringify(payload) }),
            update: (id, payload) => usersApi('/' + id, { method: 'PATCH', body: JSON.stringify(payload) }),
        },
        transform: function (payload) {
            // POST /api/users derives full_name from the parts when any part is
            // present; send it anyway so a sheet with only `full_name` works too.
            if (!payload.full_name) {
                payload.full_name = [payload.last_name, payload.first_name, payload.middle_name]
                    .filter(Boolean).join(' ').trim();
            }
            if (payload.username) payload.username = String(payload.username).trim().toLowerCase();
            // The route validates these as enums and rejects the whole row on a
            // typo; blank is always allowed, so drop empties rather than send ''.
            for (const k of ['staff_type', 'doctor_category', 'employment_type', 'salary_type', 'scheduling_mode']) {
                if (payload[k] === '' || payload[k] == null) delete payload[k];
            }
            // PASSWORD_CHANGE_V2 — пароль «1» или «0» из Excel приходит ЧИСЛОМ: прежнее
            // `!payload.password` выбрасывало 0, а сервер число не принимает вовсе.
            if (payload.password == null || payload.password === '') delete payload.password;   // updates keep the existing one
            else payload.password = String(payload.password);
            if (payload.role) payload.role = String(payload.role).trim().toLowerCase();
        },
        // Only NEW employees need a password — an existing one keeps theirs, so
        // this cannot be a plain `required` column without breaking re-imports.
        validateInsert: (payload) => {
            if (!/^[a-z0-9._-]{3,30}$/.test(String(payload.username || ''))) {
                return 'логин должен быть 3–30 символов: латиница, цифры, . _ -';
            }
            if (!VALID_ROLE_KEYS.includes(payload.role)) {
                return trf('роль «{role}» неизвестна ({list})', { role: payload.role || '', list: VALID_ROLE_KEYS.join(' · ') });
            }
            if (!String(payload.password ?? '').length) {   // PASSWORD_CHANGE_V2 — любой непустой
                return 'новому сотруднику нужен пароль';
            }
            return null;
        },
        validations: [
            { column: 'role',       list: VALID_ROLE_KEYS },
            { column: 'staff_type', list: STAFF_TYPE_KEYS },
        ],
        columns: [
            { key: 'username',   required: true, hint: 'Логин (обязательно) — 3–30 символов: латиница, цифры, . _ -. По нему находится сотрудник при повторном импорте.' },
            { key: 'password',   hint: 'Пароль для НОВОГО сотрудника — любой, хоть из одного символа. Для существующего оставьте пусто: текущий пароль сохранится.' },
            { key: 'role',       required: true, hint: trf('Роль доступа (обязательно): {list}', { list: VALID_ROLE_KEYS.join(' · ') }) },
            { key: 'last_name',  hint: 'Фамилия' },
            { key: 'first_name', hint: 'Имя' },
            { key: 'middle_name', hint: 'Отчество' },
            { key: 'staff_type', hint: 'Категория: doctor · admin_staff · mid_low (пусто — не задана)' },
            { key: 'is_doctor',  coerce: 'bool', defaultBool: false, hint: 'true / false — врач (попадает в список врачей клиники)' },
            // SPECIALTY_LIST_V1 — «Должность» убрана вместе с полем в карточке
            // сотрудника. Специальность теперь выбирается из списка
            // (public/js/admin/specialties.js); Excel-подсказка перечислить его
            // целиком не может — встроенный список проверки ограничен 255
            // символами, а список длиннее, поэтому здесь только примеры.
            { key: 'specialty',  hint: 'Специальность — из списка в карточке сотрудника: Терапевт · Кардиолог · Педиатр · Хирург · …' },
            { key: 'phone',      hint: 'Телефон — напр. +998901234567' },
            { key: 'email',      hint: 'Email (необязательно)' },
            { key: 'department', fk: { source: 'departments', keyField: 'name', target: 'department_id', autoCreate: true }, hint: 'Отдел — необязательно; отсутствующий создаётся автоматически.' },
            { key: 'branch',     fk: { source: 'branches',    keyField: 'name', target: 'branch_id' }, hint: 'Филиал — только из существующих; неизвестный импортируется без филиала с предупреждением.' },
            { key: 'license_number', hint: 'Номер лицензии (необязательно)' },
            { key: 'license_expiry_date', coerce: 'date', hint: 'Лицензия действует до — 2027-05-01, 01.05.2027 или дата из Excel.' },
            { key: 'hire_date',  coerce: 'date', hint: 'Дата приёма — 2026-01-15, 15.01.2026 или дата из Excel.' },
            { key: 'salary_type', hint: 'Тип зарплаты: fixed · percentage · fix_plus_kpi (пусто — не задан)' },
            { key: 'salary_fixed',   coerce: 'num', money: true, hint: 'Оклад, сум' },
            { key: 'salary_percent', coerce: 'num', percent: true, money: true, hint: 'Процент, 0–100' },
            { key: 'is_active',  coerce: 'bool', defaultBool: true, hint: 'true / false — активен (по умолчанию true)' },
        ],
        sampleRows: [
            { username: 'a.yusupov', password: 'ChangeMe123', role: 'doctor',    last_name: 'Юсупов',  first_name: 'Азиз',   middle_name: 'Рустамович', staff_type: 'doctor',      is_doctor: true,  specialty: 'Кардиолог', phone: '+998901234567', email: 'a.yusupov@example.uz', department: 'Поликлиника', branch: '', license_number: 'AA-000123', license_expiry_date: '2028-05-01', hire_date: '2026-01-15', salary_type: 'percentage', salary_fixed: 0, salary_percent: 30, is_active: true },
            { username: 'm.saidova', password: 'ChangeMe123', role: 'nurse',     last_name: 'Саидова', first_name: 'Малика', middle_name: '',           staff_type: 'mid_low',     is_doctor: false, specialty: '',          phone: '+998901112233', email: '',                    department: 'Процедурная', branch: '', license_number: '',         license_expiry_date: '',           hire_date: '2026-02-01', salary_type: 'fixed',      salary_fixed: 4000000, salary_percent: 0, is_active: true },
            { username: 'd.registrar', password: 'ChangeMe123', role: 'registrar', last_name: 'Каримова', first_name: 'Дилноза', middle_name: '',        staff_type: 'admin_staff', is_doctor: false, specialty: '',          phone: '+998903334455', email: '',                    department: 'Регистратура', branch: '', license_number: '',        license_expiry_date: '',           hire_date: '2026-02-10', salary_type: 'fixed',      salary_fixed: 3500000, salary_percent: 0, is_active: true },
        ],
    },

    service_categories: {
        table:      'service_categories',
        sheetName:  'Product categories',
        sampleFile: 'product_categories',
        matchField: 'name',
        columns: [
            { key: 'name',        required: true, hint: 'Category name (required, unique)' },
            { key: 'parent',      fk: { source: 'service_categories', keyField: 'name', target: 'parent_id' }, hint: 'Parent category name — leave blank for a top-level category' },
            { key: 'description', hint: 'Short description (optional)' },
            { key: 'code',        hint: 'Leave blank — auto: <name-letter><seq>' },
            { key: 'active',      coerce: 'bool', defaultBool: true, hint: 'true / false (default true)' },
        ],
        sampleRows: [
            { name: 'Cardiology',    parent: '',           description: 'Heart and vascular services',     code: '', active: true },
            { name: 'Hematology',    parent: '',           description: 'Blood tests and disorders',       code: '', active: true },
            { name: 'Imaging',       parent: '',           description: 'Ultrasound, X-ray, MRI, CT',      code: '', active: true },
            { name: 'Pediatric ECG', parent: 'Cardiology', description: 'ECG specifically for children',   code: '', active: true },
        ],
    },
};

/* i18n-exempt-end */
export function hasImporter(sectionKey) {
    return !!getCfg(sectionKey);
}

// Returns either the hand-tuned config (services / service_categories) or
// an auto-derived one for any other CRUD section that has a table + fields.
function getCfg(sectionKey) {
    if (IMPORT_CONFIGS[sectionKey]) return IMPORT_CONFIGS[sectionKey];
    return autoConfigFor(sectionKey);
}

/** CLINIC_API_FIX_V1 (ревью 3) — подсказки колонок раздела { ключ: подсказка } (для тестов). */
export function importColumnHints(sectionKey) {
    const cfg = getCfg(sectionKey);
    return cfg ? Object.fromEntries(cfg.columns.filter(c => c.hint).map(c => [c.key, c.hint])) : {};
}

/** FULL_EXPORT_V1 — the column keys a section's Excel file carries (for tests and screens). */
export function exportColumnKeys(sectionKey) {
    const cfg = getCfg(sectionKey);
    return cfg ? cfg.columns.filter(c => !c.capture && c.tmpl !== false).map(c => c.key) : [];
}

/**
 * DOCTOR_TIER_V1 — one sheet row as the importer reads it: the payload that
 * would be written, its status and its notes. Exported so a test can pin what
 * an import DOES to a column (writing a zero over a live setting is a data
 * loss, and only the payload shows it) without a browser and an .xlsx file.
 * `raw` is keyed by the sheet's headers — a key present with an empty value
 * means "the column is in the file and blank", a missing key means "no such
 * column in the file", and the two must not mean the same thing.
 */
export function buildImportRow(sectionKey, raw, { rowNum = 2, lookups = {} } = {}) {
    const cfg = getCfg(sectionKey);
    return cfg ? buildRow(raw, rowNum, lookups, cfg) : null;
}

// Field types we deliberately skip in the auto-derived importer — they
// can't be expressed as a single Excel cell.
const SKIP_FIELD_TYPES = new Set([
    'password',          // hashed server-side, not a plain text cell
    'weekly_hours',      // structured JSONB for working hours
    'doctor_services',   // structured JSONB (users.service_rates)
    'section_picker',    // permissions JSON
    'multi_fk',          // writes to a junction table, not the row itself
    'multi_select',      // text[] array — awkward in a single cell
]);

// Build an importer config from sections.js. Returns null for non-CRUD
// sections (workflow / report / placeholder).
function autoConfigFor(sectionKey) {
    const def = SECTIONS[sectionKey];
    if (!def || !def.table || !Array.isArray(def.fields) || def.fields.length === 0) return null;

    const cols = [];
    for (const f of def.fields) {
        if (SKIP_FIELD_TYPES.has(f.type)) continue;
        const col = { key: f.key, hint: f.label || f.key };
        if (f.required) col.required = true;

        if (f.type === 'number') {
            col.coerce = (f.step === '1' || f.step == null || /int/i.test(f.label || '')) ? 'num' : 'num';
            if (f.default != null) col.defaultNum = f.default;
            // CLINIC_API_FIX_V1 — «40%» читается в колонке процентов. Ревью 3 —
            // по КЛЮЧУ, а не по «%» в подписи: bonus_value — «% или сумма», и 150
            // в нём не доля больше 100 %.
            if (/percent|pct|tax_rate/i.test(f.key)) col.percent = true;
            // CLINIC_API_FIX_V1 (ревью итога) — деньги: проценты и суммы. Ревью 3 —
            // и пороги/лимиты сумм: кешбэк (min_purchase, max_cashback), лимит
            // полиса (max_limit), бонус направившему (bonus_value).
            if (col.percent || /price|cost|amount|salary|fee|sum|purchase|cashback|limit|bonus/i.test(f.key)) col.money = true;
        } else if (f.type === 'bool') {
            col.coerce = 'bool';
            col.defaultBool = f.default !== false;
        } else if (f.type === 'fk' && f.source) {
            // Look up rows in `source` by their label column.
            const keyField = FK_LABEL_COLUMN[f.source] || 'name';
            // Use a friendlier header (drop `_id` suffix); importer maps it
            // back to the real DB column via fk.target.
            const headerKey = f.key.endsWith('_id') ? f.key.slice(0, -3) : f.key;
            col.key = headerKey;
            col.fk = { source: f.source, keyField, target: f.key };
            col.hint = (f.label || headerKey) + ' (matched by ' + keyField + ')';
        }
        // 'text' | 'textarea' | 'email' | 'date' | 'select' | (default) → plain string column
        cols.push(col);
    }

    return {
        table:      def.table,
        sheetName:  def.label || sectionKey,
        sampleFile: sectionKey,
        matchField: 'name',
        columns:    cols,
        // No pre-filled rows for auto-derived configs — the header row +
        // per-column hints are enough to fill the template in Excel.
        sampleRows: [],
    };
}

// ---------------------------------------------------------------------------
// Sample download — generates the template .xlsx on the fly.
// ---------------------------------------------------------------------------
export async function downloadSectionSample(sectionKey) {
    const cfg = getCfg(sectionKey);
    if (!cfg) { toast('No template for this section.', 'fail'); return; }
    let XLSX;
    try { XLSX = await loadXlsx(); }
    catch (e) {
        console.error('[section-import] SheetJS load failed:', e);
        toast('Could not load Excel library. Check your network.', 'fail');
        return;
    }

    // TMPL_SLIM_V1 — a column can opt out of the TEMPLATE (tmpl: false) while
    // staying fully importable: legacy files keep their header mappings.
    const tCols = cfg.columns.filter(c => c.tmpl !== false);
    const tCfg = { ...cfg, columns: tCols,
        validations: (cfg.validations || []).filter(v => tCols.some(c => c.key === v.column)) };
    const aoa = [
        tCols.map(c => c.key),
        ...cfg.sampleRows.map(r => tCols.map(c => r[c.key] ?? '')),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = tCols.map(c => ({ wch: Math.max(14, c.key.length + 4) }));

    // Per-header cell comments with the per-column hint.
    tCols.forEach((col, i) => {
        const addr = XLSX.utils.encode_cell({ r: 0, c: i });
        if (ws[addr] && col.hint) ws[addr].c = [{ a: 'Easy-Med', t: tr(col.hint) }];   // CLINIC_API_FIX_V1 — на языке интерфейса, если подсказка есть в словаре
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName.slice(0, 31));
    // SERVICE_GROUP_ROUTING_V1 — write to a buffer, inject native dropdowns, download.
    let buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    if (cfg.validations && cfg.validations.length) {
        try { buf = await _injectDataValidations(buf, tCfg, XLSX); }   // TMPL_SLIM_V1
        catch (e) { console.warn('[sample] dropdown inject skipped:', e && e.message); }
    }
    _downloadBuffer(buf, `easymed_${cfg.sampleFile || sectionKey}_sample.xlsx`);
}

// ---------------------------------------------------------------------------
// Export arbitrary rows to Excel — used by the bulk "Export to Excel" button
// in section-crud after the user ticks rows. Columns come from the section's
// list-view definition so the export matches what the user sees.
// ---------------------------------------------------------------------------
export async function exportRowsToExcel({ filenameStem, sheetName, rows, columns, fkLabelLookup }) {
    if (!rows || rows.length === 0) { toast('Nothing to export.', 'fail'); return; }
    let XLSX;
    try { XLSX = await loadXlsx(); }
    catch (e) {
        console.error('[section-export] SheetJS load failed:', e);
        toast('Could not load Excel library.', 'fail');
        return;
    }

    const headers = columns.map(c => c.label || c.key);
    const data = rows.map(r => columns.map(c => exportCell(r[c.key], c, fkLabelLookup)));
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws['!cols'] = columns.map(c => ({ wch: Math.max(14, (c.label || c.key).length + 4) }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Export').slice(0, 31));
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `easymed_${filenameStem}_${date}.xlsx`);
}

// ---------------------------------------------------------------------------
// DATA_TRANSFER_V1 — round-trip export.
//
// exportRowsToExcel() above dumps the columns a LIST VIEW happens to show, which
// is fine for reading but not for editing: the file it produces cannot be fed
// back into the importer (FK ids instead of names, no `group` column, missing
// fields the list doesn't display). This one writes exactly the importer's own
// columns, so export -> edit in Excel -> import is a closed loop.
// ---------------------------------------------------------------------------
export async function exportSectionRows({ sectionKey, rows, filenameStem }) {
    const cfg = getCfg(sectionKey);
    if (!cfg) { toast('Для этого раздела нет формата экспорта.', 'fail'); return; }
    if (!rows || rows.length === 0) { toast('Нечего экспортировать.', 'fail'); return; }

    let XLSX;
    try { XLSX = await loadXlsx(); }
    catch (e) {
        console.error('[section-export] SheetJS load failed:', e);
        toast('Не удалось загрузить Excel-библиотеку.', 'fail');
        return;
    }

    // `capture` columns feed afterImport hooks from data that does not live on
    // the row (opening stock, supplier terms) — there is nothing to write back.
    const cols = cfg.columns.filter(c => !c.capture && c.tmpl !== false);
    const fkLabels = await loadFkLabelMaps(cols);

    const aoa = [cols.map(c => c.key), ...rows.map(row => cols.map(c => exportSectionCell(row, c, fkLabels)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map(c => ({ wch: Math.max(14, c.key.length + 4) }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName.slice(0, 31));
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `easymed_${filenameStem || cfg.sampleFile || sectionKey}_${date}.xlsx`);
    toast(trf('Экспортировано строк: {n}.', { n: rows.length }));
}

// id -> label for every FK column, so the export writes «Поликлиника» rather
// than `4` and the importer can match it straight back on the way in.
async function loadFkLabelMaps(cols) {
    const out = {};
    await Promise.all(cols.filter(c => c.fk).map(async (col) => {
        const { source, keyField } = col.fk;
        const m = new Map();
        try {
            const { data } = await supabase.from(source).select(`id, ${keyField}`).limit(5000);
            for (const r of (data || [])) m.set(String(r.id), r[keyField]);
        } catch (e) { console.warn('[section-export] fk labels', source, e.message); }
        out[col.key] = m;
    }));
    return out;
}

function exportSectionCell(row, col, fkLabels) {
    if (col.fk) {
        const id = row[col.fk.target];
        if (id == null || id === '') return '';
        return fkLabels[col.key]?.get(String(id)) || '';
    }
    if (col.map) {
        // Reverse a value->key enum back to a label the importer accepts. Several
        // labels can map to one value (see SERVICE_GROUP_MAP's aliases), so a
        // column may name the one to write back via `reverseMap`.
        const v = row[col.target || col.key];
        if (v == null || v === '') return '';
        if (col.reverseMap && col.reverseMap[v] != null) return col.reverseMap[v];
        for (const [label, mapped] of Object.entries(col.map)) if (mapped === v) return label;
        return String(v);
    }
    const v = row[col.target || col.key];
    if (v == null) return '';
    if (col.coerce === 'bool') return !!v;
    if (col.coerce === 'num' || col.coerce === 'int') { const n = Number(v); return Number.isFinite(n) ? n : ''; }
    if (col.coerce === 'date') return exportDate(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

// EXPORT_DATE_V1 — в Excel даты уходят как ДД.ММ.ГГГГ: клиника читает их так, а
// не как ISO из базы. Нормализуем через parseFlexibleDate (он же принимает этот
// формат обратно — см. day-first ветку), поэтому выгрузка round-trip'ится:
// экспорт -> правка в Excel -> импорт даёт ту же дату. Нераспознанное значение
// отдаём как есть, чтобы экспорт ничего не терял молча.
function exportDate(v) {
    const iso = parseFlexibleDate(v);
    if (!iso) return String(v ?? '');
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}

/**
 * DATA_TRANSFER_V1 — the Шаблон / Импорт / Экспорт trio, for the hand-built
 * views (services, employees, patients) that do not go through section-crud.
 *
 * @param {string}   sectionKey  key into IMPORT_CONFIGS / SECTIONS
 * @param {Function} fetchRows   async () => rows to export (ALL of them, not
 *                               just the page on screen)
 * @param {Function} onImported  called after a successful import, to refresh
 */
export function importExportButtons({ sectionKey, fetchRows, filenameStem, onImported, size = 'btn-sm' } = {}) {
    const cls = 'btn btn-outline' + (size ? ' ' + size : '');
    const exportBtn = h('button', {
        class: cls, type: 'button', title: 'Выгрузить все записи в Excel — файл можно отредактировать и загрузить обратно',
        onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await exportSectionRows({ sectionKey, rows: await fetchRows(), filenameStem }); }
            catch (err) { toast(trf('Экспорт не удался: {msg}', { msg: (err && err.message) || err }), 'fail'); }
            finally { if (btn.isConnected) btn.disabled = false; }
        },
    }, Icon('Download', { size: 14 }), ' Экспорт');

    return [
        h('button', {
            class: cls, type: 'button', title: 'Скачать пустой шаблон Excel с подсказками по колонкам',
            onclick: () => downloadSectionSample(sectionKey),
        }, Icon('Doc', { size: 14 }), ' Шаблон'),
        h('button', {
            class: cls, type: 'button', title: 'Загрузить записи из .xlsx / .csv',
            onclick: () => openSectionImporter({ sectionKey, onImported }),
        }, Icon('Plus', { size: 14 }), ' Импорт'),
        exportBtn,
    ];
}

function exportCell(v, col, fkLabelLookup) {
    if (v == null || v === '') return '';
    if (col.lookup && typeof fkLabelLookup === 'function') return fkLabelLookup(col.lookup, v);
    if (col.type === 'bool')  return !!v;
    if (col.type === 'money') { const n = Number(v); return Number.isFinite(n) ? n : v; }
    if (col.type === 'date')  return exportDate(v);   // EXPORT_DATE_V1 — ДД.ММ.ГГГГ
    if (typeof v === 'number') return v;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

// ---------------------------------------------------------------------------
// Importer modal
// ---------------------------------------------------------------------------

// IMPORTER_UI_V2 — the header used to read «Импорт employees from Excel»: half
// translated, and naming the config key rather than the section the user just
// came from. sheetName is an Excel tab name (ASCII, ≤31 chars), not a title.
const IMPORT_TITLES = {
    services:           'Услуги',
    patients:           'Пациенты',
    users:              'Сотрудники',
    service_categories: 'Категории услуг',
    clinic_items:       'Товары и препараты',
    procurement_items:  'Товары',
};
function importTitle(cfg, sectionKey) {
    return IMPORT_TITLES[sectionKey] || cfg.sheetName || sectionKey;
}

// A short, honest summary of the file format. The old version dumped every
// column in one comma run and then claimed «service types, categories and
// departments are created automatically» on EVERY section — including staff
// imports, which create none of those.
function columnsHint(cfg) {
    const shown = cfg.columns.filter(c => c.tmpl !== false && !c.capture);
    const required = shown.filter(c => c.required).map(c => c.key);
    const optional = shown.filter(c => !c.required).map(c => c.key);
    const autoFk   = shown.filter(c => c.fk && c.fk.autoCreate).map(c => c.key);
    const lookupFk = shown.filter(c => c.fk && !c.fk.autoCreate).map(c => c.key);

    return h('div', { class: 'imx-note' },
        h('div', null,
            h('b', null, 'Обязательные колонки: '),
            required.length ? required.join(', ') : 'нет'),
        optional.length
            ? h('details', { class: 'imx-more' },
                h('summary', null, trf('Необязательные колонки ({n})', { n: optional.length })),
                h('div', { class: 'imx-cols' }, optional.join(', ')))
            : null,
        (lookupFk.length || autoFk.length)
            ? h('div', { class: 'imx-fk' },
                lookupFk.length
                    ? h('div', null, 'Ищутся по названию среди существующих: ',
                        h('b', null, lookupFk.join(', ')), ' — если совпадения нет, строка импортируется с предупреждением.')
                    : null,
                autoFk.length
                    ? h('div', null, 'Создаются автоматически, если их ещё нет: ', h('b', null, autoFk.join(', ')), '.')
                    : null)
            : null,
    );
}
export async function openSectionImporter({ sectionKey, onImported } = {}) {
    const cfg = getCfg(sectionKey);
    if (!cfg) { toast('No importer for this section.', 'fail'); return; }
    const matchFields = cfg.matchFields || (cfg.matchField ? [cfg.matchField] : []);

    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const fileInput = h('input', {
        type: 'file', accept: '.xlsx,.xls,.csv',
        style: { display: 'none' },
        onchange: (ev) => handleFile(ev.target.files?.[0]),
    });
    const pickBtn   = h('button', { class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => fileInput.click() },
        Icon('Plus', { size: 14 }), ' Выбрать файл…');
    const sampleBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => downloadSectionSample(sectionKey) },
        Icon('Download', { size: 14 }), ' Скачать шаблон');

    const status  = h('div', { class: 'imx-status muted' }, '.xlsx или .csv — первая строка файла содержит заголовки колонок.');
    const preview = h('div', { class: 'imx-preview' });

    // "Update existing rows" — only meaningful for sections that have a
    // matchField (e.g. services match on `name`). Default ON so re-importing
    // the same file fills in missing FKs instead of creating duplicates.
    //
    // IMPORTER_UI_V2 — this used to pass `checked: ''`, which ui.js `h()` treats
    // as falsy and skips: the box the label calls "recommended" actually rendered
    // OFF, so every re-import silently duplicated instead of updating.
    const updateExistingInp = h('input', { type: 'checkbox' });
    updateExistingInp.checked = true;
    const updateExistingBox = matchFields.length
        ? h('label', { class: 'imx-check' },
            updateExistingInp,
            h('span', null,
                'Обновлять существующие записи по ',
                h('b', null, matchFields.join(' / ')),
                h('span', { class: 'muted' }, ' — рекомендуется: дополняет карточки вместо создания дублей.')),
        )
        : null;

    const confirmBtn = h('button', {
        class: 'btn btn-primary', disabled: '',
        onclick: async (ev) => {
            // BUTTON_REENABLE_V1 — кнопка берётся ДО ожидания: после await
            // event.currentTarget уже null, и разблокировка кнопки не срабатывала.
            const btn = ev.currentTarget;
            btn.disabled = true;
            try { await runImport(); }
            finally { if (btn?.isConnected) btn.disabled = false; }
        },
    }, Icon('Check', { size: 14 }), ' Импортировать');

    // IMPORTER_UI_V2 — `modal-compact` matters: MODAL_FULLSCREEN_V1 (admin.css)
    // stretches every other .modal-card to the whole viewport, which is why this
    // dialog opened as a near-empty full-screen sheet. The body also opts out of
    // .modal-body's stretching grid so two short blocks stay two short blocks.
    const card = h('div', { class: 'modal-card modal-compact imx-card' },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Download', { size: 16 }), ' Импорт из Excel · ', importTitle(cfg, sectionKey)),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body imx-body' },
            h('div', { class: 'imx-bar' }, pickBtn, sampleBtn, status),
            columnsHint(cfg),
            updateExistingBox,
            fileInput,
            preview,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Отмена'),
            confirmBtn,
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    let parsedRows = [];
    let lookups    = null;
    let rawRows    = [];   // CLINIC_API_FIX_V1 (ревью) — строки листа: пересборка, когда меняют галочку

    async function ensureLookups() {
        if (lookups) return lookups;
        lookups = await loadLookups(cfg);
        return lookups;
    }

    // CLINIC_API_FIX_V1 (ревью) — обновит ли строка существующую запись, решает
    // галочка «Обновлять существующие»; строки собираются уже с ней
    // (lookups.__wantUpdate, см. serviceRowUpdates). Сменили галочку после
    // выбора файла — строки и предпросмотр собираются заново.
    const wantUpdateNow = () => matchFields.length > 0 && !!updateExistingInp.checked;
    function buildParsed() {
        lookups.__wantUpdate = wantUpdateNow();
        parsedRows = rawRows.map((raw, i) => buildRow(raw, i + 2, lookups, cfg));
    }
    function paintParsed() {
        const validCount = parsedRows.filter(r => r.status !== 'error').length;
        // CLINIC_API_FIX_V1 (ревью итога) — строка с замечанием «готова», но
        // её замечание (не число в цене — оставлено сохранённое…) человек
        // должен увидеть: строка статуса называет их число отдельно.
        const warnCount = parsedRows.filter(r => r.status === 'warn').length;
        clear(status);
        // append(null) вставил бы текст «null» — узлы собираются списком.
        status.append(...[
            document.createTextNode(trf('Строк в файле: {n}', { n: rawRows.length }) + ' — '),
            h('b', { style: { color: 'var(--ok-700)' } }, String(validCount)),
            document.createTextNode(' ' + tr('готовы') + (warnCount ? ' (' + tr('из них с замечаниями:') + ' ' : ', ')),
            warnCount ? h('b', { style: { color: 'var(--warn-700)' } }, String(warnCount)) : null,
            warnCount ? document.createTextNode('), ') : null,
            h('b', { style: { color: 'var(--crit-700)' } }, String(rawRows.length - validCount)),
            document.createTextNode(' ' + tr('с ошибками.')),
        ].filter(Boolean));
        paintPreview();
        if (validCount > 0) confirmBtn.removeAttribute('disabled');
        else                confirmBtn.setAttribute('disabled', '');
    }
    updateExistingInp.addEventListener('change', () => {
        if (!lookups || !rawRows.length) return;
        buildParsed();
        paintParsed();
    });

    async function handleFile(file) {
        if (!file) return;
        status.textContent = trf('Читаем {name}…', { name: file.name });
        try {
            const XLSX = await loadXlsx();
            const buf = await file.arrayBuffer();
            const rows = readSheetRows(XLSX, buf, cfg, file.name);   // CLINIC_API_FIX_V1 — путь чтения вынесен (тесты); имя — для .csv
            if (rows.length === 0) throw new Error('Лист пустой — под заголовками нет строк.');

            lookups = null;   // CLINIC_API_FIX_V1 (ревью) — каждый файл — по свежему списку сохранённых
            await ensureLookups();
            rawRows = rows;   // CLINIC_API_FIX_V1 (ревью) — сборка с галочкой «Обновлять существующие»
            buildParsed();
            paintParsed();
        } catch (e) {
            console.error('[section-import] parse failed:', e);
            rawRows = [];   // CLINIC_API_FIX_V1 (ревью) — галочка не вернёт строки прошлого файла
            status.textContent = trf('Не удалось прочитать файл: {msg}', { msg: e.message || e });
            clear(preview);
            confirmBtn.setAttribute('disabled', '');
        }
    }

    function paintPreview() {
        clear(preview);
        if (parsedRows.length === 0) return;
        // CLINIC_API_FIX_V1 (ревью итога) — КАЖДАЯ строка с замечанием или
        // ошибкой видна, где бы она ни стояла в файле; чистых — первые 50.
        // Раньше показывались первые 50 строк, и замечание в 62-й не видел никто.
        const flagged = parsedRows.filter(r => r.status !== 'ok');
        const clean = parsedRows.filter(r => r.status === 'ok').slice(0, 50);
        const showRows = flagged.length
            ? [...flagged, ...clean].sort((a, b) => a.rowNum - b.rowNum)
            : clean;
        preview.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } },
            flagged.length
                ? trf('Предпросмотр: все строки с замечаниями и ошибками ({flagged}) и первые {n} без замечаний — всего строк {total}',
                    { flagged: flagged.length, n: clean.length, total: parsedRows.length })
                : trf('Предпросмотр — первые {n} из {total}', { n: showRows.length, total: parsedRows.length })));

        // Show up to four columns in the preview so the table stays compact;
        // the full data still imports.
        const previewCols = cfg.columns.slice(0, 4);

        preview.appendChild(h('table', { class: 'tbl', style: { fontSize: '12.5px' } },
            h('thead', null, h('tr', null,
                h('th', { style: { width: '40px' } }, '#'),
                h('th', { style: { width: '70px' } }, 'Статус'),
                ...previewCols.map(c => h('th', null, c.key)),
                h('th', null, 'Замечания'),
            )),
            h('tbody', null, ...showRows.map(r => h('tr', {
                style: r.status === 'error'
                    ? { background: 'var(--crit-50)' }
                    : r.status === 'warn' ? { background: 'var(--warn-50)' } : null,
            },
                h('td', { class: 'num muted' }, String(r.rowNum)),
                h('td', null, statusPill(r.status)),
                ...previewCols.map(c =>
                    h('td', null, (r.raw[normHeader(c.key)] != null && r.raw[normHeader(c.key)] !== '') ? cellText(r.raw[normHeader(c.key)]) : h('span', { class: 'muted' }, '—'))),
                h('td', { style: { fontSize: '12.5px' } }, r.notes.length ? r.notes.join('; ') : ''),
            ))),
        ));
    }

    async function runImport() {
        // CLINIC_API_FIX_V1 (ревью) — строки собраны с той галочкой, с которой импортируются.
        if (lookups && rawRows.length && lookups.__wantUpdate !== wantUpdateNow()) { buildParsed(); paintParsed(); }
        const valid = parsedRows.filter(r => r.status !== 'error');
        if (valid.length === 0) { toast('Импортировать нечего — сначала исправьте ошибки в файле.', 'fail'); return; }

        // Decide insert vs update per row. When `Update existing` is on (and
        // the section has a matchField), any row whose match value already
        // exists in the target table is sent as an UPDATE so we patch in the
        // FKs without creating a duplicate. Everything else is INSERTed.
        // DATA_TRANSFER_V1 — a section may dedupe on more than one column, tried
        // in order. Patients need this: MRN identifies every exported row, but a
        // hand-written sheet usually carries only a PINFL, and matching on just
        // one of the two turns the other kind of file into duplicates.
        const wantUpdate = matchFields.length > 0 && updateExistingInp.checked;
        const existingByField = new Map();   // field -> Map<normalisedValue, id>
        // CLINIC_API_FIX_V1 (ревью) — без списка уже сохранённых записей импорт
        // НЕ идёт. Раньше ошибка только писалась в консоль, и каждая строка
        // вставлялась новой: дубли, а строки, собранные как обновление, ложились
        // со значениями базы (НДС 0, «нужен врач» снят). То же, если сохранённый
        // список не прочитался при чтении файла (строки собраны вслепую).
        // Проверка — ДО создания справочных записей: отказ ничего не пишет.
        const refuse = (msg) => {
            toast(trf('Не удалось прочитать уже сохранённые записи: {msg}. Импорт не выполнен — ничего не записано, попробуйте ещё раз.', { msg }), 'fail');
        };
        if (wantUpdate && lookups && lookups.__storedFailed) { refuse(lookups.__storedFailed); return; }
        if (wantUpdate) {
            const { data: existing, error } = await supabase
                .from(cfg.table)
                .select(['id', ...matchFields].join(', '))
                .limit(20000);
            if (error) {
                console.warn('[section-import] existing-row fetch failed:', error.message);
                refuse(error.message || String(error));
                return;
            } else {
                for (const f of matchFields) existingByField.set(f, new Map());
                for (const r of (existing || [])) {
                    for (const f of matchFields) {
                        const k = normKey(r[f]);
                        if (k && !existingByField.get(f).has(k)) existingByField.get(f).set(k, r.id);
                    }
                }
            }
        }

        // CLINIC_API_FIX_V1 (ревью) — справочные записи создаются после
        // проверки списка сохранённых (выше): отказ не оставляет за собой
        // созданных категорий и отделений.
        const created = await autoCreatePendingFks(valid);
        if (created > 0) toast(trf('Создано недостающих справочных записей: {n}.', { n: created }));

        const findExistingId = (payload) => {
            for (const f of matchFields) {
                const v = payload[f];
                if (v == null || v === '') continue;
                const id = existingByField.get(f)?.get(normKey(v));
                if (id) return id;
            }
            return null;
        };

        const toUpdate = [];
        const toInsert = [];
        const rejected = [];   // STAFF_IMPORT_V1 — fail locally, with the reason
        for (const r of valid) {
            const matchVal = matchFields.map(f => r.payload[f]).find(v => v != null && v !== '') || null;
            const existingId = wantUpdate ? findExistingId(r.payload) : null;
            if (wantUpdate && existingId) {
                toUpdate.push({ id: existingId, payload: r.payload });
            } else {
                // Some rules only apply to NEW rows (a new employee needs a
                // password; an existing one keeps theirs). Checking here — after
                // insert-vs-update is known — beats a round-trip that comes back
                // with a server error the user has to map to a spreadsheet row.
                const why = typeof cfg.validateInsert === 'function' ? cfg.validateInsert(r.payload) : null;
                if (why) rejected.push(`${matchVal || trf('строка {n}', { n: r.rowNum })}: ${why}`);
                else toInsert.push(r.payload);
            }
        }

        let updated = 0, inserted = 0, failed = rejected.length;
        let lastError = rejected[0] || null;   // surfaced in the toast so column/constraint errors are visible without the console

        for (const why of rejected) console.warn('[section-import] row rejected:', why);

        // Updates run one-by-one (Supabase has no batch `.update(...).in(...)`
        // path that lets each row carry different values). Volume is fine
        // because we only update rows that actually changed.
        for (const u of toUpdate) {
            const patch = { ...u.payload };
            // Don't overwrite primary-key columns or the match field on update.
            delete patch.id;
            let error = null;   // ITEMS_IMPORT_V1 (update existing)
            // STAFF_IMPORT_V1 — a section may own its write path (employees go
            // through /api/users, which /api/db refuses).
            if (cfg.restCrud) { try { await cfg.restCrud.update(u.id, patch); } catch (e) { error = { message: (e && e.message) || String(e) }; } }
            else if (cfg.gatewayCrud) { try { await gw('/crud/' + cfg.table + '/' + u.id, { method: 'PATCH', body: patch }); } catch (e) { error = { message: (e && e.message) || String(e) }; } }
            else { ({ error } = await supabase.from(cfg.table).update(patch).eq('id', u.id)); }
            if (error) {
                failed++;
                lastError = error.message;
                console.warn('[section-import] update failed:', error.message, u);
            } else {
                updated++;
            }
        }

        // STAFF_IMPORT_V1 — REST sections insert one row at a time: the route
        // validates per employee (password rules, role, duplicate username), so
        // batching would turn one bad row into a whole-batch rejection and hide
        // which person was at fault.
        if (cfg.restCrud) {
            for (const payload of toInsert) {
                try { await cfg.restCrud.insert(payload); inserted++; }
                catch (e) {
                    failed++;
                    const who = matchFields.map(f => payload[f]).find(Boolean) || '';
                    lastError = `${who}: ${(e && e.message) || e}`;
                    console.warn('[section-import] insert failed:', lastError, payload);
                }
            }
        } else {
        const CHUNK = 100;
        for (let i = 0; i < toInsert.length; i += CHUNK) {
            const batch = toInsert.slice(i, i + CHUNK);
            let error = null;   // ITEMS_IMPORT_V1
            if (cfg.gatewayCrud) { try { await gw('/crud/' + cfg.table, { method: 'POST', body: batch }); } catch (e) { error = { message: (e && e.message) || String(e) }; } }
            else { ({ error } = await supabase.from(cfg.table).insert(batch)); }
            if (error) {
                failed += batch.length;
                lastError = error.message;
                console.warn('[section-import] batch failed:', error.message, batch);
            } else {
                inserted += batch.length;
            }
        }
        }

        const ok = updated + inserted;
        if (ok > 0) {
            const parts = [];
            if (inserted) parts.push(trf('новых: {n}', { n: inserted }));
            if (updated)  parts.push(trf('обновлено: {n}', { n: updated }));
            if (failed)   parts.push(trf('с ошибкой: {n}', { n: failed }));
            // CLINIC_API_FIX_V1 (ревью итога) — итог называет строки с замечаниями:
            // окно сейчас закроется, и их список уйдёт вместе с ним.
            const warned = valid.filter(r => r.status === 'warn').length;
            if (warned)   parts.push(trf('с замечаниями: {n}', { n: warned }));
            toast(trf('Импортировано строк: {n} · {parts}.', { n: ok, parts: parts.join(' · ') }), warned ? 'warn' : 'info');
        } else {
            toast(trf('Импорт не удался — отклонено строк: {n}.', { n: failed }) + (lastError ? ' ' + lastError : ''), 'fail');
        }

        // OPENING_STOCK_IMPORT_V1 — config post-hook (e.g. post opening-stock
        // receipts). Runs only when at least one row landed.
        if (ok > 0 && typeof cfg.afterImport === 'function') {
            try {
                const msg = await cfg.afterImport(valid);
                if (msg) toast(msg);
            } catch (e) {
                console.warn('[section-import] afterImport failed:', e);
                toast(trf('Товары импортированы, но пост-обработка не удалась: {msg}', { msg: e.message || e }), 'fail');
            }
        }

        if (ok > 0 && typeof onImported === 'function') onImported();
        if (failed === 0) close();
    }

    // Create lookup rows for any payload slots flagged with `__autoCreate` and
    // stamp the new ids back onto the payloads. Each lookup table is hit once
    // with a deduplicated batch of new names so reusing the same type across
    // 200 services costs one insert, not 200.
    async function autoCreatePendingFks(rows) {
        const buckets = new Map();    // table -> { keyField, valuesByLower: Map<lowerValue, originalValue> }
        for (const r of rows) {
            for (const v of Object.values(r.payload)) {
                if (v && typeof v === 'object' && v.__autoCreate) {
                    const { table, keyField, value } = v.__autoCreate;
                    if (!buckets.has(table)) buckets.set(table, { keyField, valuesByLower: new Map() });
                    const lk = normKey(value);
                    if (!buckets.get(table).valuesByLower.has(lk)) {
                        buckets.get(table).valuesByLower.set(lk, value);
                    }
                }
            }
        }

        let totalCreated = 0;
        // table|lowerValue -> id, lets the second pass resolve each placeholder.
        const newIds = new Map();

        for (const [table, { keyField, valuesByLower }] of buckets) {
            // CUSTOM_CLINIC_V3 — service_types/service_categories are created
            // through the gateway (create-or-get, company-scoped, RLS-safe).
            // LOCAL_BUILD_V1 — no gateway in this build; whatever it fails to
            // create falls through to the direct insert below rather than being
            // dropped (which left the FK null and the row silently unclassified).
            if (table === 'service_types' || table === 'service_categories') {
                let allDone = true;
                for (const [lk2, originalValue] of valuesByLower) {
                    try {
                        const created = await gw('/lookups/catalog', { method: 'POST', body: { table, name: originalValue } });
                        if (created && created.id) { newIds.set(`${table}|${lk2}`, created.id); totalCreated += 1; }
                        else allDone = false;
                    } catch (e) { allDone = false; }
                }
                if (allDone) continue;
            }
            // Re-fetch in case a previous import added rows but our cached
            // `lookups` is stale — we don't want to double-create.
            const { data: existing } = await supabase.from(table).select(`id, ${keyField}`).limit(5000);
            const existingMap = new Map();
            for (const r of (existing || [])) existingMap.set(normKey(r[keyField]), r.id);

            const toCreate = [];
            for (const [lk, originalValue] of valuesByLower) {
                if (existingMap.has(lk)) {
                    newIds.set(`${table}|${lk}`, existingMap.get(lk));
                } else {
                    toCreate.push({ lk, payload: insertPayloadFor(table, keyField, originalValue) });
                }
            }

            if (toCreate.length === 0) continue;

            const { data, error } = await supabase.from(table).insert(toCreate.map(t => t.payload)).select();
            if (error) {
                console.warn('[section-import] auto-create failed for', table, '—', error.message);
                continue;
            }
            for (const r of (data || [])) {
                const lk = normKey(r[keyField]);
                newIds.set(`${table}|${lk}`, r.id);
            }
            totalCreated += (data || []).length;
        }

        // Resolve placeholders + refresh the in-memory lookup Map so the
        // success/warn pills shown in the preview also start matching.
        for (const r of rows) {
            for (const [k, v] of Object.entries(r.payload)) {
                if (v && typeof v === 'object' && v.__autoCreate) {
                    const tag = `${v.__autoCreate.table}|${normKey(v.__autoCreate.value)}`;
                    r.payload[k] = newIds.get(tag) || null;
                }
            }
        }

        return totalCreated;
    }
}

// ---------------------------------------------------------------------------
// Lookups + row building
// ---------------------------------------------------------------------------
async function loadLookups(cfg) {
    const fkCols = cfg.columns.filter(c => c.fk);
    const out = {};
    await Promise.all(fkCols.map(async (col) => {
        const { source, keyField } = col.fk;
        const cols = `id, ${keyField}`;
        // CUSTOM_CLINIC_V3 — upstream these catalog tables were RLS-hidden and
        // had to come from the gateway. LOCAL_BUILD_V1: there is no gateway here,
        // so try it and fall through to the plain read, which is what actually
        // works locally. An empty map would silently unmatch every type/category.
        if (source === 'service_types' || source === 'service_categories') {
            try {
                const lk = await gw('/lookups/catalog');
                const rows = (lk && lk[source]) || null;
                if (rows && rows.length) {
                    const m = new Map();
                    for (const r of rows) {
                        const k = normKey(r[keyField]);
                        if (k && !m.has(k)) m.set(k, r.id);
                    }
                    out[col.key] = m;
                    return;
                }
            } catch (e) { /* no gateway in this build — use the direct read below */ }
        }
        const { data, error } = await supabase.from(source).select(cols).limit(5000);
        if (error) { console.warn('[section-import]', source, error.message); out[col.key] = new Map(); return; }
        const m = new Map();
        for (const r of (data || [])) {
            const k = normKey(r[keyField]);
            if (k && !m.has(k)) m.set(k, r.id);
        }
        out[col.key] = m;
    }));
    // DOCTOR_TIER_V2 — сохранённые строки по названию (normKey), если раздел
    // просит их для сверки (services.storedColumns).
    if (Array.isArray(cfg.storedColumns) && cfg.storedColumns.length) {
        const { data, error } = await supabase.from(cfg.table).select(['name', ...cfg.storedColumns].join(', ')).limit(20000);
        if (error) {
            console.warn('[section-import] stored rows:', error.message);
            // CLINIC_API_FIX_V1 (ревью) — строки собраны без сохранённого списка
            // (обновление не отличить от вставки): runImport откажет.
            out.__storedFailed = error.message || String(error);
        }
        const m = new Map();
        for (const row of (data || [])) { const k = normKey(row.name); if (k && !m.has(k)) m.set(k, row); }
        out.__stored = m;
    }
    return out;
}

// Normalise an FK lookup key so trailing spaces, double-spaces, and casing
// don't break the match. We collapse runs of whitespace to a single space
// so "Cardiology " and "Cardiology  consultation" align with their DB twin.
function normKey(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Build a minimal insert payload for an auto-created lookup row. Every table
// we currently autoCreate into (`service_types`, `service_categories`,
// `departments`) accepts {<keyField>: value, active: true} — the DB triggers
// fill in `code` / `id` for us.
function insertPayloadFor(table, keyField, value) {
    const row = { active: true };
    row[keyField] = value;
    // PROCUREMENT_IMPORT_V1 — ikpu_codes.name is required alongside code; the
    // official label can be filled in later, the code itself is what fiscal
    // needs.
    // i18n-exempt: «ИКПУ …» уходит в ИМЯ создаваемой записи справочника — хранимые данные, а не текст экрана
    if (table === 'ikpu_codes' && keyField === 'code') row.name = 'ИКПУ ' + value;
    return row;
}

/**
 * CLINIC_API_FIX_V1 (ревью итога) — строки первого листа файла импорта так,
 * как их читает окно импорта: объекты по заголовкам листа. `section` — ключ
 * раздела или его настройка. Вынесено из handleFile, чтобы тест читал файл
 * тем же путём, что и окно.
 */
export function readSheetRows(XLSX, buf, section, fileName) {
    const cfg = typeof section === 'string' ? getCfg(section) : section;
    // CLINIC_API_FIX_V1 (ревью итога) — КОДИРОВКА CSV. SheetJS читал байты CSV
    // без метки порядка байтов как latin-1: UTF-8 без метки и CSV русского
    // Excel (cp1251) приходили кашей — «Приём» → «ÐŸÑ€Ð¸Ñ‘Ð¼», «Раздел» не
    // узнавался. Поэтому .csv декодируется здесь, до SheetJS: строго UTF-8
    // (метка снимается), не вышло — cp1251; SheetJS получает строку. .xlsx и
    // .xls читаются как раньше.
    const csvText = csvFileText(buf, fileName);
    // CLINIC_API_FIX_V1 (ревью итога) — raw: true: текст CSV остаётся текстом.
    // Без него SheetJS сам делал из ячеек CSV числа ДО импорта, мимо правила
    // числа (readImportNumber): «150.000» → 150, «1,500» → 1500, «12,5» → 125
    // (и в CSV с «;» из русского Excel), «40%» → 0,4 — со статусом «готово» и
    // без слова. Числовые ячейки .xlsx читаются числами, как и раньше.
    // cellNF — формат ячейки (z): по нему узнаётся процентный формат.
    const wb = csvText != null
        ? XLSX.read(csvText, { type: 'string', raw: true })
        : XLSX.read(buf, { type: 'array', raw: true, cellNF: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('В книге нет ни одного листа.');
    if (csvText == null) percentCellsAsText(ws);   // у текста CSV форматов нет
    else unwrapEqualsQuoted(ws);                   // CLINIC_API_FIX_V1 (ревью 3) — ="007" → 007
    // PROCUREMENT_IMPORT_V1 — warehouse exports carry a title + blank
    // row above the real header, so `headerRow: 'auto'` scans the
    // first rows for the one matching the most known column names.
    let rows = (cfg && cfg.headerRow === 'auto') ? _rowsWithDetectedHeader(ws, XLSX, cfg) : null;
    if (!rows) rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    return rows;
}

// CLINIC_API_FIX_V1 (ревью итога) — текст CSV-файла или null (не CSV).
// Сначала СОДЕРЖИМОЕ (ревью 3): подпись ZIP (.xlsx, .ods) или OLE (.xls) —
// это книга Excel, как бы файл ни назывался; переименованная в .csv книга
// читалась как текст и не открывалась. Дальше CSV — по имени файла (.csv);
// имени нет (вызов из теста) — всё, что не книга. Кодировка: метка UTF-16
// (FF FE / FE FF — «Текст Юникод» из Excel) → utf-16le / utf-16be; иначе
// строгий UTF-8 (fatal); байты не UTF-8 — cp1251, как сохраняет «CSV»
// русский Excel. Метка порядка байтов снимается.
function csvFileText(buf, fileName) {
    const bytes = new Uint8Array(buf);
    const zipOrOle = (bytes[0] === 0x50 && bytes[1] === 0x4B) || (bytes[0] === 0xD0 && bytes[1] === 0xCF);
    if (zipOrOle) return null;
    const isCsv = fileName ? /\.csv$/i.test(String(fileName)) : true;
    if (!isCsv) return null;
    let text;
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) text = new TextDecoder('utf-16le').decode(bytes);
    else if (bytes[0] === 0xFE && bytes[1] === 0xFF) text = new TextDecoder('utf-16be').decode(bytes);
    else {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch (e) { text = new TextDecoder('windows-1251').decode(bytes); }
    }
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// CLINIC_API_FIX_V1 (ревью 3) — ЯЧЕЙКИ ="…" В CSV. Excel и выгрузки пишут код
// с ведущими нулями, MRN, ПИНФЛ и телефон как ="007", чтобы они не стали
// числом. SheetJS без raw разворачивал их сам; с raw: true цена ="150000"
// отказывала, а код, MRN и телефон ложились буквально «="007"» — повторный
// импорт по MRN/ПИНФЛ заводил дубли пациентов. Разворачиваем, как раньше
// SheetJS: вся ячейка ="…" → текст внутри кавычек ("" внутри — одна кавычка).
function unwrapEqualsQuoted(ws) {
    for (const addr of Object.keys(ws)) {
        if (addr[0] === '!') continue;
        const cell = ws[addr];
        if (!cell || typeof cell.v !== 'string') continue;
        const m = /^="(.*)"$/s.exec(cell.v);
        if (!m) continue;
        const text = m[1].replace(/""/g, '"');
        cell.t = 's'; cell.v = text; cell.w = text;
    }
}

// CLINIC_API_FIX_V1 (ревью итога) — ЯЧЕЙКА В ПРОЦЕНТНОМ ФОРМАТЕ EXCEL.
// «40%», набранное в Excel, хранится числом 0,4 и только ПОКАЗЫВАЕТСЯ «40%».
// Импорт брал 0,4: доля исполнителя 0,4 %, НДС 0,12 %, ступень 0,45 % — со
// статусом «готово». Теперь такая ячейка уходит к правилу числа текстом
// «40%» из ЗНАЧЕНИЯ (v × 100), а не из показанного текста: формат «0%»
// показывает 12,5 % как «13%». Колонка процентов читает 40; колонка не
// процентов («цена») отказывает, как любому «…%». Процентный формат — знак %
// в формате ячейки вне кавычек (0"%" — просто подпись, число не умножается);
// формата нет — по показанному тексту. CLINIC_API_FIX_V1 (ревью 3) — «_x»
// (отступ шириной символа x) и «*x» (заполнитель) — тоже не знак: 0.0_% Excel
// показывает «40.0 », это не процентный формат.
function isPercentFormat(cell) {
    if (cell.z != null && cell.z !== '') {
        return /%/.test(String(cell.z).replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, ''));
    }
    return /%\s*$/.test(String(cell.w || ''));
}
function percentCellsAsText(ws) {
    for (const addr of Object.keys(ws)) {
        if (addr[0] === '!') continue;
        const cell = ws[addr];
        if (!cell || cell.t !== 'n' || !Number.isFinite(cell.v) || !isPercentFormat(cell)) continue;
        // CLINIC_API_FIX_V1 (ревью 3) — ровно три знака после точки правило
        // числа считает неоднозначными («12.345» — и 12 345); значение здесь
        // точное, поэтому дописывается ноль: «12.3450%» — однозначно 12,345.
        let num = String(+(cell.v * 100).toFixed(10));
        if (/\.\d{3}$/.test(num)) num += '0';
        const text = num + '%';
        cell.t = 's'; cell.v = text; cell.w = text;
        delete cell.z;
    }
}

// PROCUREMENT_IMPORT_V1 — find the real header row inside the first rows of
// a sheet (warehouse exports put a title above it), then hand back objects
// keyed by that header. Returns null when no convincing header is found so
// the caller falls back to the default first-row parse.
function _rowsWithDetectedHeader(ws, XLSX, cfg) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!aoa.length) return null;
    const known = new Set();
    for (const c of cfg.columns) {
        known.add(String(c.key).trim().toLowerCase().replace(/\s+/g, '_'));
        for (const a of (c.aliases || [])) known.add(String(a).trim().toLowerCase().replace(/\s+/g, '_'));
    }
    let hdrIdx = -1, best = 0;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
        const hits = aoa[i].filter(v => known.has(String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_'))).length;
        if (hits > best) { best = hits; hdrIdx = i; }
    }
    if (best < 2) return null;
    const hdr = aoa[hdrIdx].map(v => String(v ?? '').trim());
    return aoa.slice(hdrIdx + 1)
        .filter(r => r.some(c => c !== '' && c != null))
        .map(r => {
            const o = {};
            hdr.forEach((name, ci) => { if (name) o[name] = r[ci]; });
            return o;
        });
}

// Заголовок листа и ключ колонки — в одном виде: без краёв, нижний регистр,
// пробелы → _ («Цена закупки» → «цена_закупки»).
function normHeader(k) {
    return String(k).trim().toLowerCase().replace(/\s+/g, '_');
}

function buildRow(raw, rowNum, lookups, cfg) {
    // Normalise headers — case-insensitive, trim, snake_case-friendly.
    const r = {};
    for (const [k, v] of Object.entries(raw)) r[normHeader(k)] = v;

    const notes = [];
    let status  = 'ok';
    const payload = {};
    const captures = {};   // PROCUREMENT_IMPORT_V1 — non-column values for afterImport
    // CLINIC_API_FIX_V1 (ревью) — строка обновит существующую запись (раздел
    // знает это сам: cfg.rowUpdates, у услуг — галочка и совпадение по названию).
    const updating = typeof cfg.rowUpdates === 'function' && !!cfg.rowUpdates(r, lookups);

    for (const col of cfg.columns) {
        // PROCUREMENT_IMPORT_V1 — a column may match by its key or any alias
        // (headers arrive normalised: lowercase, spaces -> _).
        // CLINIC_API_FIX_V1 (ревью итога) — ключ колонки приводится к виду
        // заголовков (normHeader), как синонимы ниже: «цена закупки» искалась
        // как есть, а заголовок листа — «цена_закупки», и шесть колонок шаблона
        // «Товары» с пробелом в названии не находились никогда (99cea7b).
        const colKey = normHeader(col.key);
        let cellRaw = r[colKey];
        if (cellRaw == null && col.aliases) {
            for (const a of col.aliases) {
                const ak = normHeader(a);
                if (r[ak] != null) { cellRaw = r[ak]; break; }
            }
        }
        // CLINIC_API_FIX_V1 (ревью) — КОЛОНКИ, КОТОРОЙ В ЛИСТЕ НЕТ, нет и в
        // записи, которую строка обновляет: ни значения по умолчанию, ни
        // предупреждения о нём. Пустая ячейка под своим заголовком — как раньше;
        // новая запись — как раньше.
        if (col.keepIfAbsent && updating && !(colKey in r)
            && !(col.aliases || []).some((a) => normHeader(a) in r)) continue;

        // Required check.
        if (col.required) {
            const v = cellText(cellRaw);
            if (!v) { notes.push(`missing ${col.key}`); status = 'error'; }
        }

        // PROCUREMENT_IMPORT_V1 — captured columns feed afterImport (e.g.
        // opening stock), never the row payload.
        if (col.capture) {
            // CLINIC_API_FIX_V1 (ревью итога) — числовая колонка-захват (остаток,
            // себестоимость…) — по общему правилу числа: «50 шт» не молчит.
            if (col.captureNum) {
                const read = readImportNumber(cellRaw, false);
                if ('n' in read) captures[col.capture] = read.n;
                else if ('bad' in read && col.money && !updating) {
                    notes.push(trf('Строка {n}: в колонке {col} не число («{v}») — строка не импортирована.', { n: rowNum, col: col.key, v: read.bad }));
                    status = 'error';
                } else if ('bad' in read) {
                    notes.push(trf('Строка {n}: в колонке {col} не число («{v}») — не записано.', { n: rowNum, col: col.key, v: read.bad }));
                    if (status !== 'error') status = 'warn';
                }
                continue;
            }
            // Текстовая колонка-захват (поставщик, единица закупки) — текст без
            // краёв. Раньше она шла через разбор числа и становилась null.
            const v = cellText(cellRaw);
            if (v !== '') captures[col.capture] = v;
            continue;
        }

        // FK lookup.
        if (col.fk) {
            const v = cellText(cellRaw);
            if (!v) { payload[col.fk.target] = null; continue; }
            const id = lookups[col.key]?.get(normKey(v));
            if (id) { payload[col.fk.target] = id; continue; }
            if (col.fk.autoCreate) {
                // Defer — runImport() will batch-insert any missing rows into
                // the lookup table and stamp the new id into the payload.
                payload[col.fk.target] = { __autoCreate: { table: col.fk.source, keyField: col.fk.keyField, value: v } };
                notes.push(`will create ${col.key} "${v}"`);
            } else {
                notes.push(`${col.key} "${v}" not found`);
                if (status !== 'error') status = 'warn';
                payload[col.fk.target] = null;
            }
            continue;
        }

        // SERVICE_GROUP_ROUTING_V1 — mapped enum («Раздел» label -> services.type).
        if (col.map) {
            const v = cellText(cellRaw);
            if (!v) { if (col.defaultTo != null) payload[col.target || col.key] = col.defaultTo; continue; }
            const mapped = col.map[normKey(v)];
            if (mapped != null) { payload[col.target || col.key] = mapped; }
            // PROCUREMENT_IMPORT_V1 — lenient maps warn and skip instead of
            // rejecting the row (e.g. «Категория: Корневая группа» from a
            // legacy warehouse export).
            else if (col.lenient) {
                notes.push(trf('{col} "{v}" не из списка — пропущено', { col: col.key, v }));
                if (status !== 'error') status = 'warn';
            }
            else { notes.push(trf('{col} "{v}" — недопустимо (список: {list})', { col: col.key, v, list: col.allowedLabel || '' })); status = 'error'; }
            continue;
        }

        // Numeric / boolean coercion. `target` (optional) renames the payload
        // column so a template can keep human headers (e.g. «цена» -> price).
        //
        // CLINIC_API_FIX_V1 (ревью итога) — ОДНО ПРАВИЛО ЧИСЛА (readImportNumber).
        // Было: всё, что не разобралось, молча становилось значением по
        // умолчанию — у цены это 0: «150 000 сум» в строке, обновляющей услугу,
        // давало цену 0 со статусом «готово». Теперь непустое не число в 0 не
        // превращается никогда:
        //   • строка обновляет запись — поле не пишется (сохранённое остаётся);
        //   • новая строка, колонка денежная (money: цена, НДС, доля, процент…)
        //     или обязательная — строка не ввозится (ошибка);
        //   • новая строка раздела, который знает, что она новая (rowUpdates), —
        //     значение пустой ячейки (30 мин), если оно задано;
        //   • иначе поле не пишется (у новой записи — значение базы).
        // Каждый раз строка называет колонку и ячейку. Пустая ячейка и
        // отсутствующая колонка — как раньше.
        if (col.coerce === 'num' || col.coerce === 'int') {
            if (col.raw) continue;   // читает transform раздела
            const key = col.target || col.key;
            const read = readImportNumber(cellRaw, !!col.percent);
            // CLINIC_API_FIX_V1 (ревью 3, решение) — ПУСТАЯ ДЕНЕЖНАЯ ЯЧЕЙКА НЕ ПИШЕТ 0.
            // Было: пустая цена в строке, обновляющей услугу, писала 0 (с «price
            // пусто»), пустой НДС — 12 поверх сохранённого, пустой оклад
            // сотрудника — 0. Теперь:
            //   • строка обновляет запись — поле не пишется, замечание «пусто —
            //     оставлено как было»;
            //   • новая строка раздела, который это знает (rowUpdates, услуги), —
            //     цена обязательна (requiredOnNew: «укажите цену (0 — если
            //     бесплатно)»), остальное — как раньше (НДС 12, доля 0);
            //   • разделы, где новая ли строка, узнаётся только при импорте, —
            //     поле не пишется никогда (у новой записи — значение базы),
            //     замечание «пусто — не записано».
            // Колонки нет в листе — те же правила, но без замечаний. Свой экспорт
            // (null — пустой ячейкой) поэтому ничего не меняет.
            if (read.empty && col.money) {
                const inSheet = (colKey in r) || (col.aliases || []).some((a) => normHeader(a) in r);
                if (updating) {
                    if (inSheet) notes.push(trf('Строка {n}: {col} пусто — оставлено как было.', { n: rowNum, col: col.key }));
                } else if (typeof cfg.rowUpdates === 'function') {
                    if (col.requiredOnNew) { notes.push(trf('Строка {n}: укажите цену (0 — если бесплатно).', { n: rowNum })); status = 'error'; }
                    else payload[key] = col.defaultNum ?? 0;
                } else if (inSheet) {
                    notes.push(trf('Строка {n}: {col} пусто — не записано.', { n: rowNum, col: col.key }));
                }
                continue;
            }
            if (read.empty) { payload[key] = col.defaultNum ?? 0; continue; }
            // CLINIC_API_FIX_V1 (ревью 3) — в колонке процентов доля вне 0…100 %
            // для правила числа — то же, что не число; причина называется.
            const why = ('n' in read) && col.percent && (read.n > 100 || read.n < 0)
                ? tr(read.n > 100 ? 'доля больше 100%' : 'доля меньше 0%') : null;
            if (('n' in read) && !why) { payload[key] = col.coerce === 'int' ? Math.round(read.n) : read.n; continue; }
            const at = { n: rowNum, col: col.key, v: why ? String(cellRaw).trim() : read.bad, why };
            if (updating) {
                notes.push(why
                    ? trf('Строка {n}: в колонке {col} {why} («{v}») — оставлено сохранённое значение.', at)
                    : trf('Строка {n}: в колонке {col} не число («{v}») — оставлено сохранённое значение.', at));
                if (status !== 'error') status = 'warn';
            } else if (col.money || col.required || why) {
                notes.push(why
                    ? trf('Строка {n}: в колонке {col} {why} («{v}») — строка не импортирована.', at)
                    : trf('Строка {n}: в колонке {col} не число («{v}») — строка не импортирована.', at));
                status = 'error';
            } else if (typeof cfg.rowUpdates === 'function' && col.defaultNum != null) {
                payload[key] = col.defaultNum;
                notes.push(trf('Строка {n}: в колонке {col} не число («{v}») — записано {def}, как для пустой ячейки.', { ...at, def: col.defaultNum }));
                if (status !== 'error') status = 'warn';
            } else {
                notes.push(trf('Строка {n}: в колонке {col} не число («{v}») — не записано.', at));
                if (status !== 'error') status = 'warn';
            }
            continue;
        }
        if (col.coerce === 'bool') {
            payload[col.target || col.key] = bool(cellRaw, col.defaultBool ?? true);
            continue;
        }
        // IMPORT_DATE_V1 — Excel serials and the usual written formats.
        // Unreadable, non-empty input is a warning with the offending value shown,
        // not a silent drop: the registrar sees which cell to fix. The column is
        // left out of the payload so the row still imports without a bogus date.
        if (col.coerce === 'date') {
            const rawStr = cellText(cellRaw);
            if (!rawStr) continue;
            const iso = parseFlexibleDate(cellRaw);
            if (iso) { payload[col.target || col.key] = iso; }
            else {
                notes.push(trf('{col} "{v}" — не распознано как дата, пропущено', { col: col.key, v: rawStr }));
                if (status !== 'error') status = 'warn';
            }
            continue;
        }

        // Plain text. Empty → leave the column out so the DB default fires
        // (especially important for auto-generated `code`).
        // CLINIC_API_FIX_V1 (ревью 3) — ячейка в формате даты (Date) — ДД.ММ.ГГГГ,
        // а не «Tue May 12 2026 00:00:00 GMT+0500 …» (cellText).
        const v = cellText(cellRaw);
        if (v) payload[col.target || col.key] = v;
    }

    // Per-section post-processing (e.g. patients synthesize full_name and
    // normalise gender). Runs after the column loop so it sees the full
    // payload. FK placeholders (__autoCreate) are left untouched.
    //
    // The third argument is the row's own voice: ctx.warn() adds a note and
    // flags the row (the IMPORT_PRICE_OPTIONAL_V1 pattern, same notes list the
    // column loop uses), so a hook that DROPS a value can say so instead of
    // dropping it silently. `r` is the raw row keyed by the sheet's headers —
    // a hook can ask which headers the file actually carried.
    if (typeof cfg.transform === 'function') {
        const ctx = { notes, lookups, rowNum, warn(msg) { notes.push(msg); if (status !== 'error') status = 'warn'; },
            fail(msg) { notes.push(msg); status = 'error'; },   // CLINIC_API_FIX_V1 (ревью итога) — строка не ввозится
            note(msg) { notes.push(msg); } };                   // CLINIC_API_FIX_V1 (ревью 3) — замечание без предупреждения   // CLINIC_API_FIX_V1 — rowNum: предупреждение называет строку файла
        try { cfg.transform(payload, r, ctx); }
        catch (e) { console.warn('[section-import] transform failed:', e); }
    }

    return { rowNum, raw: r, payload, captures, status, notes };
}

// IMPORT_DATE_V1 — read a date the way a registrar actually pastes it.
//
// The case that broke: a date-formatted Excel cell arrives as a SERIAL NUMBER
// (32874, five digits) because XLSX.read is called without `cellDates`, so
// date_of_birth landed in the DB as the literal text "32874". Handling serials
// here rather than switching on `cellDates` globally keeps every other section's
// text columns exactly as they were — a date-formatted cell in a text column
// would otherwise turn into "Mon Apr 12 1990 00:00:00 GMT+0500".
//
// Accepted: Excel serial, JS Date, YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY,
// DD-MM-YYYY, YYYY.MM.DD, YYYY/MM/DD, and 2-digit years.
// Returns 'YYYY-MM-DD', or null when it cannot be read confidently.
//
// DAY-FIRST is assumed for ambiguous D/M vs M/D — this clinic writes
// 12.04.1990 for 12 April. A value whose first part is > 12 is unambiguous and
// parsed as day-first regardless; when the SECOND part is > 12 it can only be
// month-last, so it is read as month-first.
function parseFlexibleDate(v) {
    if (v == null || v === '') return null;

    // Real Date (only when a caller enables cellDates) — use local parts, not
    // toISOString(), which would shift a midnight date back a day east of UTC.
    // CLINIC_API_FIX_V1 (ревью 3) — с cellNF ячейка в формате даты приходит
    // объектом Date, и 0 в таком формате — «31.12.1899»: дата раньше
    // 1900-01-01 — не дата (как в v3.16.0 — предупреждение), а не 1899-12-31.
    if (v instanceof Date) {
        if (isNaN(v.getTime()) || v.getFullYear() < 1900) return null;
        return _ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }

    const s = String(v).trim();
    if (!s) return null;

    // Excel serial. Day 1 = 1900-01-01, and Excel wrongly treats 1900 as a leap
    // year, so the epoch that makes every date after 1900-02-28 correct is
    // 1899-12-30 (dates in Jan/Feb 1900 would be a day out — not a real DOB).
    //
    // Deliberately requires FIVE or six digits, i.e. serials from 1927-05-18 to
    // ~2064. Anything shorter is more likely a human value than a serial, and
    // guessing would silently corrupt data:
    //   "1990"  is a bare YEAR, but serial 1990 is 1905-06-12
    //   "12.04" is a partial date, but as a fractional serial it is 1900-01-11
    // Both now fall through and are reported as unreadable instead. A patient
    // born before 1927 whose cell is serial-formatted is rejected with a warning
    // — visible and fixable, unlike a wrong date.
    if (/^\d{5,6}(\.\d+)?$/.test(s)) {
        const serial = Number(s);
        if (serial >= 1 && serial <= 60000) {
            const ms = Math.round(serial) * 86400000;
            const d  = new Date(Date.UTC(1899, 11, 30) + ms);
            return _ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        }
        return null;   // out of range — not a date
    }

    // Split on . / - or space. Handles a trailing time part ("1990-04-12 00:00").
    const parts = s.split(/[T\s]/)[0].split(/[.\/\-]/).map(x => x.trim()).filter(Boolean);
    if (parts.length !== 3) return null;
    if (!parts.every(p => /^\d{1,4}$/.test(p))) return null;
    let [a, b, c] = parts.map(Number);

    let y, m, d;
    if (String(parts[0]).length === 4) {            // YYYY-MM-DD / YYYY.MM.DD
        y = a; m = b; d = c;
    } else if (b > 12 && a <= 12) {                 // second part can only be a day
        m = a; d = b; y = c;
    } else {                                        // day-first (clinic convention)
        d = a; m = b; y = c;
    }

    if (y < 100) y += (y <= 30) ? 2000 : 1900;      // 05 -> 2005, 95 -> 1995
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    // Reject impossible days (31.02) by round-tripping through Date.
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return _ymd(y, m, d);
}
// CLINIC_API_FIX_V1 (ревью 3) — текст ячейки: Date (ячейка в формате даты) —
// ДД.ММ.ГГГГ по местным частям, как читает parseFlexibleDate; остальное — как
// есть, без краёв.
function cellText(v) {
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return '';
        return String(v.getDate()).padStart(2, '0') + '.' + String(v.getMonth() + 1).padStart(2, '0') + '.' + String(v.getFullYear()).padStart(4, '0');
    }
    return String(v ?? '').trim();
}
function _ymd(y, m, d) {
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// CLINIC_API_FIX_V1 (ревью итога) — ЧИСЛОВАЯ ЯЧЕЙКА ИМПОРТА: ОДНО ПРАВИЛО.
// Число — «150000», «150 000» (пробелы, в том числе неразрывные, — только
// между группами по три цифры: разделитель тысяч), «12,5» / «12.5» (запятая
// или точка — десятичный знак); в колонке процентов (percent) — ещё «40%».
// Число из Excel (ячейка числового формата) — как есть. Всё остальное
// непустое — не число: «150 000 сум», «—», «нет», «1e5».
// Неоднозначное «1,500» / «150.000» (одна запятая или точка, ровно три цифры
// после неё, до неё 1–3 цифры, без пробелов тысяч) — тоже не число: это и
// полтора, и полторы тысячи. Цену в Узбекистане часто пишут «150.000», и
// прежний разбор молча давал 150 (точка) или 1500 вместо 1,5 (запятая).
// Возвращает { empty: true } | { n } | { bad: текст ячейки }.
export function readImportNumber(v, percent) {
    if (v === null || v === undefined) return { empty: true };
    if (typeof v === 'number') return Number.isFinite(v) ? { n: v } : { bad: String(v) };
    if (typeof v !== 'string') return { bad: cellText(v) };   // true/false, дата (ДД.ММ.ГГГГ) — не число
    const text = v.trim();
    if (text === '') return { empty: true };
    const s = percent ? text.replace(/\s*%$/, '') : text;
    const m = /^([+-]?)(\d{1,3}(?:\s+\d{3})+|\d+)(?:([.,])(\d+))?$/.exec(s);
    if (!m) return { bad: text };
    const grouped = /\s/.test(m[2]);
    if (m[3] && !grouped && m[4].length === 3 && m[2].length <= 3 && Number(m[2]) !== 0) return { bad: text };
    const n = Number(m[1] + m[2].replace(/\s+/g, '') + (m[3] ? '.' + m[4] : ''));
    return Number.isFinite(n) ? { n } : { bad: text };
}

function bool(v, fallback) {
    if (v === '' || v == null) return fallback;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    // i18n-exempt-start: токены разбора булевых значений из Excel — контракт файла
    if (['true', '1', 'yes', 'y', 'да', 'истина'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'нет', 'ложь'].includes(s)) return false;
    /* i18n-exempt-end */
    return fallback;
}
function statusPill(s) {
    if (s === 'error') return h('span', { class: 'tag tag-crit' }, 'ошибка');
    if (s === 'warn')  return h('span', { class: 'tag tag-warn' }, 'внимание');
    return h('span', { class: 'tag tag-ok' }, 'готово');
}
