// LAB_ANALYTE_INDEX_V1 — ОДИН способ найти показатель справочника по имени,
// которым лаборатория записала результат.
//
// Раньше такой поиск был у лаборатории свой, у карты пациента свой, а каждая
// проверка «всё ли теперь находится» писала третий вариант правил в отдельном
// скрипте — и проверяла не то, что выполняет приложение. Поэтому ПРАВИЛА живут
// в lab-doc.js (чистые функции, покрыты тестами), а этот модуль отвечает
// только за то, чего чистая функция не умеет: сходить в базу и не ходить туда
// на каждую строку бланка.
//
// Кто пользуется: лаборатория, карта пациента, раздел «Документы», аудит
// справочника (scripts/lab-audit.mjs). Один и тот же анализ обязан выглядеть
// одинаково во всех четырёх.

import { supabase } from '../../supabase.js';
import { buildAnalyteIndex, resolveAnalyteWhy, nkName } from './lab-doc.js?v=labshared1';

const TTL_MS = 30000;
let _idx = null;
let _at = 0;

export const nk = nkName;

// Справочник изменили — сбрасываем, не дожидаясь TTL.
export function invalidateAnalyteIndex() { _idx = null; _at = 0; }

export async function analyteIndex() {
    if (_idx && (Date.now() - _at) < TTL_MS) return _idx;
    let rows = [];
    let panels = [];
    try {
        // ref_ranges обязателен: в нём живут фазы цикла и прочие
        // «подпоказатели». panel_id и sort_order — тоже: по ним карта пациента
        // и бот восстанавливают связь «услуга -> панель -> показатели», когда
        // имя в результате разошлось со справочником (LAB_PANEL_IS_TRUTH_V1).
        const [a, b] = await Promise.all([
            supabase.from('lab_panel_analytes')
                .select('panel_id,sort_order,name,code,unit,ref_low,ref_high,ref_low_m,ref_high_m,ref_low_f,ref_high_f,ref_text,ref_ranges')
                .order('sort_order')
                .limit(20000),
            supabase.from('lab_panels').select('id, service_id').limit(5000),
        ]);
        rows = a.data || [];
        panels = b.data || [];
    } catch (e) { /* без индекса бланк печатается по тому, что сохранено в результате */ }
    _idx = buildAnalyteIndex(rows);
    // услуга -> показатели её панели, в порядке sort_order.
    const byPanel = new Map();
    for (const r of rows) {
        if (r.panel_id == null) continue;
        if (!byPanel.has(r.panel_id)) byPanel.set(r.panel_id, []);
        byPanel.get(r.panel_id).push(r);
    }
    _idx.byService = new Map();
    for (const p of panels) {
        if (p.service_id != null) _idx.byService.set(p.service_id, byPanel.get(p.id) || []);
    }
    _at = Date.now();
    return _idx;
}

// Показатели панели, привязанной к услуге, в порядке sort_order. Пустой
// список — у услуги нет панели.
export function analytesForService(idx, serviceId) {
    return (idx && idx.byService && idx.byService.get(serviceId)) || [];
}

export function resolveAnalyte(idx, name, local) {
    return resolveAnalyteWhy(idx, name, local).analyte;
}
export { resolveAnalyteWhy };
