// CLINIC_PROFILE_V1 — поля «Компании»: группа на трёх языках (вид — как в
// «Моём профиле»: .docprof-trigroup складывается в столбец на узком экране),
// поле с подписью, подсказкой и строкой ошибки под ним.
//
// Метки и подсказки — литералы вызывающего: h() переводит их при выводе
// (i18n-coverage находит их как ключи словаря). Метка связана с полем через
// for/id — читалка экрана называет поле его подписью.
import { h } from '../ui.js';
import { tr, trf } from '../i18n.js';

const LANG_TAG = { ru: 'RU', uz: 'UZ', en: 'EN' };
export const LANGS = Object.freeze(['ru', 'uz', 'en']);

let seq = 0;
const nextId = (p) => 'cpf-' + p + '-' + (++seq);

/** Строка ошибки под полем. set('') прячет; ключ словаря переводится; поле помечается aria-invalid. */
export function fieldErr(ctrl = null) {
    const node = h('div', { class: 'cpf-err', role: 'alert' });
    node.hidden = true;
    return {
        node,
        ctrl,
        set(msg, params) {
            node.textContent = msg ? (params ? trf(msg, params) : tr(msg)) : '';
            node.hidden = !msg;
            const c = this.ctrl;
            if (c) { if (msg) c.setAttribute('aria-invalid', 'true'); else if (typeof c.removeAttribute === 'function') c.removeAttribute('aria-invalid'); }
        },
    };
}

/** Подпись → поле → подсказка → ошибка, одной ячейкой .field. */
export function labeled(label, ctrl, { hint = '', key = 'f', prefix = null } = {}) {
    const id = nextId(key);
    ctrl.setAttribute('id', id);
    const err = fieldErr(ctrl);
    const body = prefix ? h('div', { class: 'cpf-prefix' }, h('span', { 'aria-hidden': 'true' }, prefix), ctrl) : ctrl;
    const node = h('div', { class: 'field' },
        h('label', { for: id }, label),
        body,
        hint ? h('p', { class: 'cpf-hint' }, hint) : null,
        err.node);
    return { node, ctrl, err };
}

/**
 * Три поля RU / UZ / EN одной группой: <fieldset> с заголовком legend (как в
 * макете: «Название клиники», под ним «RU Название», «UZ Название», …).
 * values — { ru, uz, en }; onInput(lang, value); cellLabel — подпись ячейки
 * (по умолчанию — legend); hint — строка под группой.
 *
 * CLINIC_PROFILE_V1 (полировка по макету) — markMissing: пустое UZ или EN
 * помечено «нет перевода» в подписи ячейки; пометка исчезает с первым знаком
 * и возвращается, если поле снова пустое (одни пробелы — пусто). RU —
 * исходный язык: его пустоту объясняет проверка поля, а не пометка. Включают
 * названия, описание и улицу; у ориентира («Филиалы») пометки нет.
 */
export function triGroup(legend, values, { cellLabel = '', hint = '', textarea = false, max = 0, onInput = null, disabled = false, key = 'tri', markMissing = false } = {}) {
    const inputs = {};
    const marks = {};
    const paintMark = (lng) => { const m = marks[lng]; if (m) m.hidden = !!String(inputs[lng].ctrl.value || '').trim(); };
    const cells = LANGS.map((lng) => {
        const id = nextId(key + '-' + lng);
        const ctrl = textarea
            ? h('textarea', { id, rows: '3', class: 'docprof-ta', maxlength: max ? String(max) : null, disabled })
            : h('input', { id, type: 'text', class: 'docprof-in', maxlength: max ? String(max) : null, autocomplete: 'off', disabled });
        ctrl.value = (values && values[lng]) || '';
        const err = fieldErr(ctrl);
        inputs[lng] = { ctrl, err };
        if (markMissing && lng !== 'ru') marks[lng] = h('span', { class: 'cpf-miss' }, 'нет перевода');
        paintMark(lng);
        ctrl.addEventListener('input', () => {
            paintMark(lng);
            if (onInput) { err.set(''); onInput(lng, ctrl.value); }
        });
        return h('div', { class: 'docprof-tricell' },
            // Пробел перед пометкой — и для читалки экрана: «Название нет перевода», а не «Названиенет».
            h('label', { class: 'docprof-trilabel', for: id }, h('span', { class: 'cpf-lang' }, LANG_TAG[lng]), ' ', cellLabel || legend,
                marks[lng] ? [' ', marks[lng]] : null),
            ctrl, err.node);
    });
    return {
        node: h('fieldset', { class: 'cpf-set' },
            h('legend', null, legend),
            h('div', { class: 'docprof-trigroup' }, ...cells),
            hint ? h('p', { class: 'cpf-hint' }, hint) : null),
        inputs,
        set(vals) { for (const lng of LANGS) { inputs[lng].ctrl.value = (vals && vals[lng]) || ''; paintMark(lng); } },
    };
}
