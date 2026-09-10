// CASE_DOC_A4_V1 — правая панель «Вставить в документ».
//
// Владелец (2026-09-08): справа от листа — диагноз, функциональные
// исследования, лучевая диагностика, лабораторные исследования. Так это
// устроено в кабинете врача: результат не переписывают руками, его кладут в
// документ готовым блоком — с названием, датой и, у анализов, таблицей
// показателей.
//
// ПАНЕЛЬ НИЧЕГО НЕ СОЗДАЁТ. Она показывает то, что уже есть у пациента
// (rpc admission_doc_sources), и отдаёт разметку экрану документа. Отклонения
// от нормы отмечены цветом — тем же, которым их печатает лабораторный бланк.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { escapeHtml } from '../sanitize.js';

const BLOCKS = [
    { key: 'diagnosis',  label: 'Диагноз',                    icon: 'Stethoscope', hint: 'из истории болезни' },
    { key: 'functional', label: 'Функциональные исследования', icon: 'Activity',    hint: 'ЭКГ, ЭхоКГ, спирометрия' },
    { key: 'imaging',    label: 'Лучевая диагностика',         icon: 'Scan',        hint: 'рентген, УЗИ, КТ, МРТ' },
    { key: 'lab',        label: 'Лабораторные исследования',   icon: 'Flask',       hint: 'анализы с показателями' },
];

const dt = (iso) => (iso ? fmtDate(String(iso).slice(0, 10)) : '');
const FLAG_COLOR = { high: '#b91c1c', low: '#b91c1c', critical: '#b91c1c', abnormal: '#b45309' };

/** Разметка блока диагноза. */
function diagnosisHtml(label, value) {
    return `<p><b>${escapeHtml(tr(label))}:</b> ${escapeHtml(value)}</p>`;
}

/** Разметка блока исследования: название, дата, заключение. */
function studyHtml(item) {
    const head = `<b>${escapeHtml(item.name || '')}</b>${item.at ? ' (' + escapeHtml(dt(item.at)) + ')' : ''}`;
    return `<p>${head}: ${escapeHtml(item.conclusion || '')}</p>`;
}

/** Разметка блока анализа: заголовок и таблица показателей с отметкой отклонений. */
function labHtml(item) {
    const rows = (item.results || []).map((r) => {
        const color = FLAG_COLOR[String(r.flag || '').toLowerCase()];
        const value = color
            ? `<span style="color: ${color}; font-weight: 700">${escapeHtml(r.value)}</span>`
            : escapeHtml(r.value);
        return `<tr><td>${escapeHtml(r.parameter)}</td><td>${value}${r.unit ? ' ' + escapeHtml(r.unit) : ''}</td><td>${escapeHtml(r.reference_range || '')}</td></tr>`;
    }).join('');
    return `<p><b>${escapeHtml(item.name || '')}</b>${item.at ? ' (' + escapeHtml(dt(item.at)) + ')' : ''}</p>`
        + `<table class="a4-restbl"><thead><tr><th>${escapeHtml(tr('Показатель'))}</th>`
        + `<th>${escapeHtml(tr('Значение'))}</th><th>${escapeHtml(tr('Норма'))}</th></tr></thead>`
        + `<tbody>${rows}</tbody></table>`;
}

/**
 * Панель источников.
 *
 * @param {{admissionId:number, onInsert:(html:string)=>boolean}} opts
 * @returns {Node} карточка панели; данные подгружаются сами
 */
/**
 * @param {{admissionId:number, onInsert:function, diagnosisNow?:() => string}} opts
 *        diagnosisNow() — диагноз, который стоит в карточке слева ПРЯМО СЕЙЧАС.
 *        CASE_DX_EVERYWHERE_V1 — владелец: «paste diagnosis will be fetched
 *        from the left panel». Панель вставки и карточка диагноза показывали
 *        РАЗНОЕ: карточка — диагноз этого документа, панель — диагноз
 *        госпитализации. Врач правил диагноз слева, нажимал «Диагноз» справа и
 *        получал в текст старую формулировку.
 */
export function caseInsertPanel({ admissionId, onInsert, diagnosisNow = null } = {}) {
    const body = h('div', { class: 'ci-body' });
    const card = h('aside', { class: 'card ci-card', 'aria-label': tr('Вставить в документ') },
        h('div', { class: 'ci-head' }, Icon('Doc', { size: 14 }), ' ', tr('Вставить в документ')),
        body);
    body.appendChild(h('div', { class: 'ci-note' }, tr('Загружаем результаты…')));

    const put = (html) => {
        const ok = onInsert && onInsert(html);
        toast(ok ? tr('Вставлено в документ.') : tr('Поставьте курсор в раздел документа — блок вставляется туда.'), ok ? 'ok' : 'fail');
    };

    const itemRow = (title, meta, html, disabledWhy) => h('button', {
        class: 'ci-item', type: 'button', disabled: html ? null : true,
        title: html ? tr('Вставить в документ') : tr(disabledWhy || ''),
        onclick: () => { if (html) put(html); },
    },
        h('span', { class: 'ci-item-main' },
            h('span', { class: 'ci-item-t' }, title),
            meta ? h('span', { class: 'ci-item-m' }, meta) : null),
        html ? Icon('Plus', { size: 13 }) : null);

    (async () => {
        const { data, error } = await supabase.rpc('admission_doc_sources', { admission_id: admissionId });
        clear(body);
        if (error || !data) {
            body.appendChild(h('div', { class: 'ci-note ci-fail' },
                trf('Источники не загрузились: {msg}', { msg: (error && error.message) || tr('нет ответа') })));
            return;
        }
        for (const b of BLOCKS) {
            const box = h('details', { class: 'ci-block', open: b.key === 'lab' ? '' : null },
                h('summary', { class: 'ci-sum' },
                    h('span', { class: 'ci-sum-ic' }, Icon(b.icon, { size: 14 })),
                    h('span', { class: 'ci-sum-main' },
                        h('span', { class: 'ci-sum-t' }, tr(b.label)),
                        h('span', { class: 'ci-sum-m' }, tr(b.hint)))));
            if (b.key === 'diagnosis') {
                const d = data.diagnosis || {};
                const rows = [];
                // Первым — диагноз ЭТОГО документа: он самый свежий, его только
                // что писали слева. Диагнозы госпитализации остаются ниже.
                const own = diagnosisNow ? String(diagnosisNow() || '').trim() : '';
                if (own) rows.push(itemRow(own, tr('этого документа'), diagnosisHtml('Диагноз', own)));
                if (d.clinical && d.clinical !== own) rows.push(itemRow(d.clinical, tr('клинический'), diagnosisHtml('Клинический диагноз', d.clinical)));
                if (d.referral && d.referral !== own) rows.push(itemRow(d.referral, tr('при направлении'), diagnosisHtml('Диагноз при направлении', d.referral)));
                box.appendChild(rows.length ? h('div', { class: 'ci-list' }, ...rows)
                    : h('div', { class: 'ci-note' }, tr('Диагноз ещё не установлен — его пишут в первичном осмотре.')));
            } else {
                const list = Array.isArray(data[b.key]) ? data[b.key] : [];
                box.appendChild(list.length
                    ? h('div', { class: 'ci-list' }, ...list.map((it) => (b.key === 'lab'
                        ? itemRow(it.name || tr('Анализ'), trf('{n} показателей · {when}', { n: (it.results || []).length, when: dt(it.at) }), labHtml(it))
                        : itemRow(it.name || tr('Исследование'), dt(it.at), it.conclusion ? studyHtml(it) : '', 'Заключение ещё не внесено — вставлять нечего'))))
                    : h('div', { class: 'ci-note' }, tr('Результатов пока нет.')));
            }
            body.appendChild(box);
        }
    })();

    return card;
}
