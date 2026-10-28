// DOC_RICH_FORMAT_V1 — ДАННЫЕ ЛИСТА «ЗАКЛЮЧЕНИЕ ПРИЁМА» ИЗ ЗАПИСИ КАБИНЕТА.
//
// Поля записи кабинета (visit_services.notes → fields) — разметка врача. Из них
// лист приёма (doc-variants.js) получает: разделы с оформлением — очищенной
// разметкой, без оформления — текстом, как раньше; «Диагноз» — строкой текста.
// Правила живут здесь, без DOM и без состояния кабинета, потому что их зовут
// двое: кабинет врача (buildBlankData — экран, печать, архив) и карта пациента
// (подписанная запись без копии в архиве, WS_DERIVED_DOCS_V1). Раньше карта
// печатала такую запись через bodyHtml, который рендерер бланка не читает, и на
// бумагу выходил ОБРАЗЕЦ — чужой пациент «Алиев Бобур».
import { sanitizeStoredHtml, htmlToText, hasMarkup, textBreaks, richHasContent } from './rich-text.js';

/**
 * Текст поля — для текстовых мест (диагноз, visits.conclusion, сводки, журнал).
 * Сначала очистка: «<» прежнего простого текста («SpO2 <95%, ЧСС > 90») не
 * принимается за тег и не съедается.
 */
export function fieldText(x) {
    return htmlToText(sanitizeStoredHtml(x));
}

// Оформление — любой тег, кроме голых строк Chrome (<br>, <div>, <p>).
const FORMATTING_RE = /<(?!\/?(?:br|div|p)\s*\/?>)[a-z/]/i;

/**
 * Раздел для листа. Оформление врача — очищенной разметкой («\n» текста —
 * <br>: лист рисует разметку white-space:normal); набранное без оформления —
 * текстом, как раньше (лист рисует его pre-wrap). Пустые теги — пусто, а
 * таблица — содержание, даже пустая (T3: только что вставленная).
 */
export function richForSheet(x) {
    const html = sanitizeStoredHtml(x);
    if (!FORMATTING_RE.test(html)) {
        const text = htmlToText(html);
        // Набранное буквально «<b>» лист прочёл бы тегом: такой текст остаётся разметкой (экранированной).
        return hasMarkup(text) ? '<div>' + textBreaks(html) + '</div>' : text;
    }
    return richHasContent(html) ? textBreaks(html) : '';
}

/** Основной диагноз строкой «код — название». */
export function mainDxText(diagnoses) {
    const m = (diagnoses || []).find((d) => d && d.type === 'main');
    return m ? ((m.code ? m.code + ' — ' : '') + (m.name || '')).trim() : '';
}

/**
 * CABINET_FIX_V1_R2 (ревью 2, п. 2) — «Диагноз» строки целиком: основной
 * диагноз (код — название) своей строкой и текст врача. Запись до ревью 2,
 * где код стоял первой строкой поля врача, не даёт его дважды.
 * → { auto, text, full }.
 */
export function dxParts(primaryDiagnosis, diagnoses) {
    const auto = mainDxText(diagnoses || []);
    let text = fieldText(primaryDiagnosis);
    const lines = text.split('\n');
    if (auto && lines[0].replace(/\s+/g, ' ').trim() === auto.replace(/\s+/g, ' ').trim()) text = lines.slice(1).join('\n').trim();
    return { auto, text, full: [auto, text].filter(Boolean).join('\n') };
}

/**
 * CABINET_FIX_V1_R2 — «Диагноз» записи истории: код записи (icd10) с названием
 * из диагнозов строки и текст врача. CABINET_FIX_V1_R3 (F8) — код всегда тот,
 * что в записи; CABINET_FIX_V1_R4 (п. 6) — диагноз с этим кодом — основной этой
 * записи; кода нет среди диагнозов строки — строка кода как есть, затем текст.
 */
export function entryDxText(f, diagnoses) {
    const ff = f || {};
    const code = String(ff.icd10 || '').trim();
    const list = (diagnoses || []).filter((d) => code && d && d.code === code).map((d) => ({ ...d, type: 'main' }));
    const parts = dxParts(ff.primary_diagnosis, list);
    if (code && !list.length) {
        const t = parts.text;
        const first = t ? t.split('\n')[0].trim() : '';
        // CABINET_FIX_V1_R5 (E) — код — до границы: «J20» не «съедает» строку «J20.9 — …».
        if (first.startsWith(code) && !/[0-9A-Za-zА-Яа-яЁё.]/.test(first.charAt(code.length))) return t;
        return [code, t].filter(Boolean).join('\n');
    }
    return parts.full || (code || '');
}

/** Вид диагноза словом на листе (сопутствующие, осложнения). */
export const DX_TYPE_RU = Object.freeze({ main: 'Основной', concomitant: 'Сопутствующий', complication: 'Осложнение', background: 'Фоновый' });

/**
 * Данные листа «Заключение приёма» из подписанной записи кабинета — та же
 * форма, что снимок кабинета (docSnapshot): шапка (head) — пациент, врач,
 * услуга, дата; разделы — richForSheet; «Диагноз» — текст записи (entryDxText).
 * `rich: 1` — разделы могут быть разметкой (DOC_RICH_FORMAT_V1, LOW 5).
 *
 * @param {object} fields поля записи (notes.history[…].fields)
 * @param {{head?: object, diagnoses?: Array, prescriptions?: Array}} opts
 */
export function notesDocData(fields, { head = {}, diagnoses = [], prescriptions = [] } = {}) {
    const f = fields || {};
    const dx = entryDxText(f, diagnoses);
    return {
        ...head,
        rich: 1,
        __editor: false,
        complaint: richForSheet(f.chief_complaint), hpi: richForSheet(f.hpi),
        labs: richForSheet(f.labs_text), instrumental: richForSheet(f.instrumental_text),
        exam: richForSheet(f.physical_exam), therapy: richForSheet(f.therapy_text),
        recsText: richForSheet(f.recommendations_text), conclusionText: richForSheet(f.conclusion_text),
        dxAuto: '', dxText: dx, dx,
        prescriptions: (prescriptions || []).filter((r) => r && r.name)
            .map((r) => ({ name: r.name, dose: r.dose, freq: r.freq, dur: r.dur, notes: r.notes, nurse: r.nurse })),
        diagnoses: (diagnoses || []).filter((x) => x && (x.code || x.name))
            .map((x) => ({ code: x.code, name: x.name, type: x.type, typeLabel: DX_TYPE_RU[x.type] || '' })),
    };
}
