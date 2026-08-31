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

// STAFF_IMPORT_V1 — mirrors server/services/roles.js VALID_ROLES and the
// STAFF_TYPES list in server/routes/users.js. Both are validated server-side;
// these copies only drive the template's Excel dropdowns and the hints.
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
import { SECTIONS, FK_LABEL_COLUMN } from '../sections.js?v=noikpu1';

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
//   hint      - per-column comment baked into the sample file's header row
// sampleRows[] - pre-filled rows in the downloadable template.
// ---------------------------------------------------------------------------
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
            { key: 'price',    coerce: 'num',  defaultNum: 0,  hint: 'Цена, число — напр. 1500' },
            { key: 'unit',     hint: 'Единица: amp, tab, ml, fl…' },
            { key: 'form',     hint: 'Форма: таблетка, ампула, раствор…' },
            { key: 'strength', hint: 'Дозировка: напр. 500 мг' },
            { key: 'tax_rate', coerce: 'num',  defaultNum: 12, hint: 'НДС % (по умолчанию 12)' },
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
            { key: 'цена',          target: 'price', coerce: 'num', defaultNum: 0, aliases: ['price'], tmpl: false,
              hint: 'Цена продажи, число — напр. 3210.' },
            { key: 'икпу',          aliases: ['ikpu', 'икпу_код'], tmpl: false,
              fk: { source: 'ikpu_codes', keyField: 'code', target: 'ikpu_code_id', autoCreate: true },
              hint: 'Код ИКПУ (17 цифр) — необязательно; отсутствующие коды создаются автоматически.' },
            { key: 'остаток',       capture: 'qty', aliases: ['остатки', 'количество', 'qty'], tmpl: false,
              hint: 'Текущий остаток — станет приходом на склад (филиал по умолчанию). Пусто/0 — без прихода.' },
            { key: 'себестоимость', capture: 'cost', aliases: ['cost', 'закупочная'], tmpl: false,
              hint: 'Себестоимость — цена прихода для остатка (необязательно).' },
            // PROD_IMPORT_FULL_V1 — the unit engine, as in the product editor.
            { key: 'базовая ед.',   target: 'base_unit', aliases: ['base_unit', 'базовая единица'],
              hint: 'Базовая единица — в ней считается остаток (самая мелкая). Пусто → «ед.изм».' },
            { key: 'ед. выдачи',    target: 'consumption_unit', aliases: ['consumption_unit', 'единица выдачи'],
              hint: 'Как выдаёте пациенту. Обычно совпадает с базовой — можно оставить пусто.' },
            { key: 'кол-во в ед. выдачи', target: 'consumption_factor', coerce: 'num', aliases: ['consumption_factor'],
              hint: 'Сколько базовых единиц в единице выдачи (обычно 1).' },
            // PROD_IMPORT_FULL_V1 — the supplier block, as in the product editor.
            { key: 'поставщик',     capture: 'supplier', aliases: ['supplier'],
              hint: 'Поставщик товара — связка создаётся автоматически; неизвестный поставщик будет создан.' },
            { key: 'цена закупки',  capture: 'supPrice', aliases: ['закупочная цена'],
              hint: 'Цена закупки у этого поставщика (сум).' },
            { key: 'ед. закупки',   capture: 'supUnit', aliases: ['единица закупки'],
              hint: 'В чём закупаете у поставщика (уп, кор…). Пусто — как базовая.' },
            { key: 'кол-во в ед. закупки', capture: 'supPack', aliases: ['кратность закупки'],
              hint: 'Сколько базовых единиц в единице закупки — напр. 10.' },
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
            let supMsg = null;
            try { supMsg = await linkSuppliers(); }
            catch (e) { supMsg = trf('Поставщики: ошибка — {msg}', { msg: (e && e.message) || e }); }

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
        // LOCAL_BUILD_V1 — the upstream SaaS wrote services through the
        // service-role gateway because RLS blocked custom services. This build
        // has no gateway (`/api/v1` is not mounted — see server/app.js) and no
        // RLS: `services` is admin-writable straight through /api/db, and
        // leaving `gatewayCrud` on made every service import fail with a 404.
        validations: [{ column: 'group', list: SERVICE_GROUP_LABELS }],   // native Excel dropdown
        // SERVICE_GROUP_ROUTING_V1 — «Раздел» both ROUTES (services.type) and GROUPS
        // (mirrored into a service_type / type_id) so a 7-column sheet is enough.
        transform: function (payload, r) {
            if (payload.type && payload.type_id == null) {
                var lbl = { consultation: 'Консультации', lab: 'Лаборатория', procedure: 'Процедуры', imaging: 'Диагностика', other: 'Хирургия' }[payload.type];
                if (lbl) payload.type_id = { __autoCreate: { table: 'service_types', keyField: 'name', value: lbl } };
            }
        },
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
            { key: 'type',             fk: { source: 'service_types',      keyField: 'name', target: 'type_id' }, hint: 'Тип услуги — только из существующих групп клиники; необязательно. Пусто или неизвестное значение → группа берётся из «Раздела».' },
            { key: 'category',         fk: { source: 'service_categories', keyField: 'name', target: 'category_id',   autoCreate: true }, hint: 'Категория/направление (напр. МРТ головного мозга) — необязательно; создаётся автоматически.' },
            { key: 'department',       fk: { source: 'departments',        keyField: 'name', target: 'department_id', autoCreate: true }, hint: 'Отделение — необязательно; создаётся автоматически.' },
            // IMPORT_PRICE_OPTIONAL_V1 — price used to be required, which blocked
            // importing price-lists that get priced after upload. Missing price
            // now imports as 0 with a warning instead of an error.
            { key: 'price',            coerce: 'num',  defaultNum: 0,  warnIfMissing: true, hint: 'Цена, число — напр. 150000 (пусто → 0)' },
            { key: 'tax_rate',         coerce: 'num',  defaultNum: 12, hint: 'НДС % (по умолчанию 12, если пусто)' },
            { key: 'duration_minutes', coerce: 'int',  defaultNum: 30, hint: 'Длительность, мин (по умолчанию 30, если пусто)' },
            { key: 'requires_doctor',  coerce: 'bool', defaultBool: true, hint: 'true / false — нужен врач (по умолчанию true)' },
            { key: 'active',           coerce: 'bool', defaultBool: true, hint: 'true / false — активна (по умолчанию true)' },
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
            if (!payload.password) delete payload.password;   // updates keep the existing one
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
            if (!payload.password || String(payload.password).length < 8) {
                return 'новому сотруднику нужен пароль от 8 символов';
            }
            return null;
        },
        validations: [
            { column: 'role',       list: VALID_ROLE_KEYS },
            { column: 'staff_type', list: STAFF_TYPE_KEYS },
        ],
        columns: [
            { key: 'username',   required: true, hint: 'Логин (обязательно) — 3–30 символов: латиница, цифры, . _ -. По нему находится сотрудник при повторном импорте.' },
            { key: 'password',   hint: 'Пароль для НОВОГО сотрудника — минимум 8 символов. Для существующего оставьте пусто: текущий пароль сохранится.' },
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
            { key: 'salary_fixed',   coerce: 'num', hint: 'Оклад, сум' },
            { key: 'salary_percent', coerce: 'num', hint: 'Процент, 0–100' },
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

export function hasImporter(sectionKey) {
    return !!getCfg(sectionKey);
}

// Returns either the hand-tuned config (services / service_categories) or
// an auto-derived one for any other CRUD section that has a table + fields.
function getCfg(sectionKey) {
    if (IMPORT_CONFIGS[sectionKey]) return IMPORT_CONFIGS[sectionKey];
    return autoConfigFor(sectionKey);
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
        if (ws[addr] && col.hint) ws[addr].c = [{ a: 'Easy-Med', t: col.hint }];
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
            ev.currentTarget.disabled = true;
            try { await runImport(); }
            finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
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

    async function ensureLookups() {
        if (lookups) return lookups;
        lookups = await loadLookups(cfg);
        return lookups;
    }

    async function handleFile(file) {
        if (!file) return;
        status.textContent = trf('Читаем {name}…', { name: file.name });
        try {
            const XLSX = await loadXlsx();
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            if (!ws) throw new Error('В книге нет ни одного листа.');
            // PROCUREMENT_IMPORT_V1 — warehouse exports carry a title + blank
            // row above the real header, so `headerRow: 'auto'` scans the
            // first rows for the one matching the most known column names.
            let rows = (cfg.headerRow === 'auto') ? _rowsWithDetectedHeader(ws, XLSX, cfg) : null;
            if (!rows) rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (rows.length === 0) throw new Error('Лист пустой — под заголовками нет строк.');

            await ensureLookups();
            parsedRows = rows.map((raw, i) => buildRow(raw, i + 2, lookups, cfg));
            const validCount = parsedRows.filter(r => r.status !== 'error').length;
            clear(status);
            status.append(
                document.createTextNode(trf('Строк в файле: {n}', { n: rows.length }) + ' — '),
                h('b', { style: { color: 'var(--ok-700)' } }, String(validCount)),
                document.createTextNode(' ' + tr('готовы') + ', '),
                h('b', { style: { color: 'var(--crit-700)' } }, String(rows.length - validCount)),
                document.createTextNode(' ' + tr('с ошибками.')),
            );
            paintPreview();
            if (validCount > 0) confirmBtn.removeAttribute('disabled');
            else                confirmBtn.setAttribute('disabled', '');
        } catch (e) {
            console.error('[section-import] parse failed:', e);
            status.textContent = trf('Не удалось прочитать файл: {msg}', { msg: e.message || e });
            clear(preview);
            confirmBtn.setAttribute('disabled', '');
        }
    }

    function paintPreview() {
        clear(preview);
        if (parsedRows.length === 0) return;
        const showRows = parsedRows.slice(0, 50);
        preview.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } },
            trf('Предпросмотр — первые {n} из {total}', { n: showRows.length, total: parsedRows.length })));

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
                    h('td', null, (r.raw[c.key] != null && r.raw[c.key] !== '') ? String(r.raw[c.key]) : h('span', { class: 'muted' }, '—'))),
                h('td', { style: { fontSize: '11.5px' } }, r.notes.length ? r.notes.join('; ') : ''),
            ))),
        ));
    }

    async function runImport() {
        const valid = parsedRows.filter(r => r.status !== 'error');
        if (valid.length === 0) { toast('Импортировать нечего — сначала исправьте ошибки в файле.', 'fail'); return; }

        const created = await autoCreatePendingFks(valid);
        if (created > 0) toast(trf('Создано недостающих справочных записей: {n}.', { n: created }));

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
        if (wantUpdate) {
            const { data: existing, error } = await supabase
                .from(cfg.table)
                .select(['id', ...matchFields].join(', '))
                .limit(20000);
            if (error) {
                console.warn('[section-import] existing-row fetch failed:', error.message);
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
                if (why) rejected.push(`${matchVal || 'строка ' + r.rowNum}: ${why}`);
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
            toast(trf('Импортировано строк: {n} · {parts}.', { n: ok, parts: parts.join(' · ') }));
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

function buildRow(raw, rowNum, lookups, cfg) {
    // Normalise headers — case-insensitive, trim, snake_case-friendly.
    const r = {};
    for (const [k, v] of Object.entries(raw)) {
        const key = String(k).trim().toLowerCase().replace(/\s+/g, '_');
        r[key] = v;
    }

    const notes = [];
    let status  = 'ok';
    const payload = {};
    const captures = {};   // PROCUREMENT_IMPORT_V1 — non-column values for afterImport

    for (const col of cfg.columns) {
        // PROCUREMENT_IMPORT_V1 — a column may match by its key or any alias
        // (headers arrive normalised: lowercase, spaces -> _).
        let cellRaw = r[col.key];
        if (cellRaw == null && col.aliases) {
            for (const a of col.aliases) {
                const ak = String(a).trim().toLowerCase().replace(/\s+/g, '_');
                if (r[ak] != null) { cellRaw = r[ak]; break; }
            }
        }

        // Required check.
        if (col.required) {
            const v = String(cellRaw ?? '').trim();
            if (!v) { notes.push(`missing ${col.key}`); status = 'error'; }
        }
        // IMPORT_PRICE_OPTIONAL_V1 — soft requirement: missing value imports
        // with the column default but flags the row so the user notices.
        if (col.warnIfMissing) {
            const v = String(cellRaw ?? '').trim();
            if (!v) { notes.push(trf('{col} пусто — будет {def}', { col: col.key, def: col.defaultNum ?? 0 })); if (status !== 'error') status = 'warn'; }
        }

        // PROCUREMENT_IMPORT_V1 — captured columns feed afterImport (e.g.
        // opening stock), never the row payload.
        if (col.capture) {
            const v = String(cellRaw ?? '').trim();
            if (v !== '') captures[col.capture] = num(cellRaw, null);
            continue;
        }

        // FK lookup.
        if (col.fk) {
            const v = String(cellRaw ?? '').trim();
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
            const v = String(cellRaw ?? '').trim();
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
        if (col.coerce === 'num' || col.coerce === 'int') {
            payload[col.target || col.key] = num(cellRaw, col.defaultNum ?? 0, col.coerce === 'int');
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
            const rawStr = String(cellRaw ?? '').trim();
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
        const v = String(cellRaw ?? '').trim();
        if (v) payload[col.target || col.key] = v;
    }

    // Per-section post-processing (e.g. patients synthesize full_name and
    // normalise gender). Runs after the column loop so it sees the full
    // payload. FK placeholders (__autoCreate) are left untouched.
    if (typeof cfg.transform === 'function') {
        try { cfg.transform(payload, r); }
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
    if (v instanceof Date && !isNaN(v.getTime())) return _ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());

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
function _ymd(y, m, d) {
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function num(v, fallback, asInt) {
    if (v === '' || v == null) return fallback;
    const n = Number(String(v).replace(/[\s,]/g, ''));
    if (!Number.isFinite(n)) return fallback;
    return asInt ? Math.round(n) : n;
}
function bool(v, fallback) {
    if (v === '' || v == null) return fallback;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'да', 'истина'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'нет', 'ложь'].includes(s)) return false;
    return fallback;
}
function statusPill(s) {
    if (s === 'error') return h('span', { class: 'tag tag-crit' }, 'ошибка');
    if (s === 'warn')  return h('span', { class: 'tag tag-warn' }, 'внимание');
    return h('span', { class: 'tag tag-ok' }, 'готово');
}
