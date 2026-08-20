// LAB_AUDIT_V1 — «почему у этого показателя нет нормы на бланке».
//
// Запуск:  node scripts/lab-audit.mjs            — сводка в консоль
//          node scripts/lab-audit.mjs --report   — плюс файл на рабочий стол
//
// Зачем отдельный инструмент. Справочник растёт (в планах ~1000 панелей), и
// проверять «а всё ли теперь находится» глазами по одному показателю
// невозможно. Раньше каждая такая проверка писала правила поиска заново в
// одноразовом скрипте — и проверяла НЕ ТО, что выполняет приложение: скрипт мог
// показывать «всё хорошо», пока бланк печатал прочерки.
//
// Поэтому здесь НЕТ своей логики сопоставления. Импортируются ровно те функции,
// которыми пользуется бланк (lab-doc.js): расходиться нечему по построению.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { buildAnalyteIndex, resolveAnalyteWhy, analyteHasRef, labRefText, namedRangeCell, nkName,
        matchResultsToAnalytes } =
    await import(pathToFileURL(path.join(ROOT, 'public/js/admin/views/lab-doc.js')).href);

const db = new Database(path.join(ROOT, 'data/easymed.db'), { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);

const analytes = q('SELECT * FROM lab_panel_analytes');
const idx = buildAnalyteIndex(analytes);

// Показатели панели услуги — они всегда важнее общего справочника.
const localByService = new Map();
for (const p of q('SELECT id, service_id FROM lab_panels WHERE service_id IS NOT NULL')) {
    const m = new Map();
    for (const a of q('SELECT * FROM lab_panel_analytes WHERE panel_id = ?', p.id)) {
        if (a.name) m.set(nkName(a.name), a);
        if (a.code) m.set(nkName(a.code), a);
    }
    localByService.set(p.service_id, m);
}

// ---------------------------------------------------------------------------
// 1. Справочник: панели, услуги, полнота норм
// ---------------------------------------------------------------------------
const panels = q(`SELECT p.id, p.name, p.service_id, s.name AS svc
                    FROM lab_panels p LEFT JOIN services s ON s.id = p.service_id`);
const panelStats = panels.map((p) => {
    const an = q('SELECT * FROM lab_panel_analytes WHERE panel_id = ?', p.id);
    return { ...p, total: an.length, withRef: an.filter(analyteHasRef).length, an };
});

// Услуги, у которых панели нет вовсе.
const labServices = q(`SELECT id, name, ref_low, ref_high, ref_text FROM services
                        WHERE is_lab = 1 OR type = 'lab'`);
const svcNoPanel = labServices.filter((s) => !localByService.has(s.id));

// ---------------------------------------------------------------------------
// 2. Что реально напечатает бланк по каждой строке результатов
// ---------------------------------------------------------------------------
const rows = q(`SELECT lr.visit_service_id AS vsid, lr.parameter, lr.reference_range, lr.unit,
                       vs.service_id, s.name AS svc,
                       s.ref_low AS s_lo, s.ref_high AS s_hi, s.ref_text AS s_tx,
                       p.gender, p.date_of_birth
                  FROM lab_results lr
                  JOIN visit_services vs ON vs.id = lr.visit_service_id
                  LEFT JOIN services s ON s.id = vs.service_id
                  LEFT JOIN visits v ON v.id = vs.visit_id
                  LEFT JOIN patients p ON p.id = v.patient_id`);

// LAB_PANEL_IS_TRUTH_V1 — группируем строки по заказу и сопоставляем их с
// панелью услуги так же, как бланк: по имени, остальные по порядку.
const byOrder = new Map();
for (const r of rows) {
    const k = r.vsid;
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(r);
}
const panelListBySvc = new Map();
for (const p of q('SELECT id, service_id FROM lab_panels WHERE service_id IS NOT NULL')) {
    panelListBySvc.set(p.service_id, q('SELECT * FROM lab_panel_analytes WHERE panel_id = ? ORDER BY sort_order', p.id));
}
const matchedByRow = new Map();
for (const [, list] of byOrder) {
    const panelList = panelListBySvc.get(list[0].service_id) || [];
    const m = matchResultsToAnalytes(panelList, list.map((x) => x.parameter));
    list.forEach((x, i) => matchedByRow.set(x, m[i]));
}

const how = {}; const blanks = new Map();
for (const r of rows) {
    const local = localByService.get(r.service_id) || null;
    let a = matchedByRow.get(r) || null;
    let src = a ? 'панель услуги' : null;
    let why = 'панель услуги';
    if (!a) {
        const res = resolveAnalyteWhy(idx, r.parameter, local);
        a = res.analyte;
        src = res.how;
        why = res.how;
    }
    if (!a && (r.s_lo != null || r.s_hi != null || r.s_tx)) {
        a = { ref_low: r.s_lo, ref_high: r.s_hi, ref_text: r.s_tx };
        src = 'service';
    }
    const g = String(r.gender || '').toLowerCase();
    const named = namedRangeCell(a, g, null);
    const printed = labRefText(a, named.marked ? '' : g, r.reference_range, named.texts);
    const empty = !printed || printed === '—';
    if (empty) src = 'НЕТ НОРМЫ';
    else if (src === 'none' || src === 'conflict') src = 'сохранено в результате';
    how[src] = (how[src] || 0) + 1;
    if (empty) {
        const key = (r.svc || '(без услуги)');
        if (!blanks.has(key)) blanks.set(key, new Map());
        blanks.get(key).set(r.parameter, why);
    }
}

// ---------------------------------------------------------------------------
// Вывод
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log('СПРАВОЧНИК');
console.log('  панелей                    :', panels.length);
console.log('  панелей без услуги         :', panelStats.filter((p) => !p.service_id).length);
console.log('  панелей без единой нормы   :', panelStats.filter((p) => p.total && !p.withRef).length);
console.log('  показателей                :', analytes.length, '| с нормой:', analytes.filter(analyteHasRef).length);
console.log('  спорных имён (норма не ставится):', idx.conflicts.size);
console.log('  лабораторных услуг без панели   :', svcNoPanel.length, 'из', labServices.length);
console.log();
console.log('БЛАНК: откуда берётся норма (строк результатов:', rows.length + ')');
for (const k of Object.keys(how).sort((a, b) => how[b] - how[a])) console.log('  ', pad(k, 26), how[k]);
const ok = rows.length - (how['НЕТ НОРМЫ'] || 0);
console.log('  ИТОГО с нормой            :', ok, '(' + (100 * ok / rows.length).toFixed(1) + '%)');
console.log();
const uniq = [...blanks.values()].reduce((n, m) => n + m.size, 0);
console.log('БЕЗ НОРМЫ:', uniq, 'уникальных показателей в', blanks.size, 'услугах');

if (process.argv.includes('--report')) {
    const L = ['АУДИТ ЛАБОРАТОРНОГО СПРАВОЧНИКА', new Date().toLocaleString('ru-RU'), '',
        'Проверено ТЕМ ЖЕ кодом, которым печатается бланк (lab-doc.js).', '',
        'ЧАСТЬ 1. Показатели без нормы — что заполнить в «Настройки → Лаборатория»', ''];
    const WHY = { none: 'показателя нет ни в одной панели', conflict: 'имя есть в разных панелях с РАЗНЫМИ нормами — норма не подставляется намеренно',
        panel: 'показатель найден, но норма пуста', exact: 'показатель найден, но норма пуста', tokens: 'показатель найден, но норма пуста' };
    for (const svc of [...blanks.keys()].sort()) {
        L.push('── ' + svc);
        for (const [p, w] of blanks.get(svc)) L.push('      • ' + p + '\n            ' + (WHY[w] || w));
        L.push('');
    }
    L.push('', 'ЧАСТЬ 2. Панели и услуги', '');
    for (const p of panelStats.sort((a, b) => (a.svc || '').localeCompare(b.svc || '', 'ru'))) {
        const warn = !p.service_id ? '   ⚠ НЕ ПРИВЯЗАНА К УСЛУГЕ'
            : (p.total && !p.withRef ? '   ⚠ НИ У ОДНОГО ПОКАЗАТЕЛЯ НЕТ НОРМЫ' : '');
        L.push('панель ' + String(p.id).padStart(4) + '  ' + pad(p.name, 40) + ' -> ' + (p.svc || '—')
            + '   показателей: ' + p.total + ' (с нормой ' + p.withRef + ')' + warn);
    }
    L.push('', 'ЧАСТЬ 3. Лабораторные услуги БЕЗ панели', '');
    for (const s of svcNoPanel.sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
        const own = (s.ref_low != null || s.ref_high != null || s.ref_text) ? ' (норма задана на самой услуге)' : '';
        L.push('   ' + String(s.id).padStart(5) + '  ' + s.name + own);
    }
    const out = 'D:/Desktop/lab-blanks/АУДИТ-СПРАВОЧНИКА.txt';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, L.join('\r\n'), 'utf8');
    console.log('\nОтчёт:', out);
}
db.close();
