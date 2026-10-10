// CLINIC_PROFILE_V1 — «Компания»: два логотипа клиники.
//
// Файлы — в корзине clinic-logos (правила — shared/clinic-logo-rules.js, их же
// проверяет хранилище после загрузки: экран лишь говорит раньше и понятнее).
// Квадратный идёт в шапку программы, в печать и на карточки у партнёров;
// вертикальный — на страницу клиники у партнёров.
//
// У квадратного есть ПЕЧАТНАЯ КОПИЯ — doc_settings.logo_data_url (PNG 220 px,
// прозрачность сохраняется): её печатают бланки, PDF Telegram и филиалы, и ни
// один из этих читателей не меняется. Пока квадратный не загружен, печатается
// прежний логотип (тот же logo_data_url) — плитка показывает его с пометкой.
//
// «Удалить» снимает логотип с бланков (колонки — пустые строки); файл в
// хранилище остаётся: вчерашняя ссылка обязана открыться (план, Р7). Всё, что
// здесь меняется, записывается кнопкой «Сохранить» экрана.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { LOGO_BUCKET, logoRefusal, PRINT_COPY_SIDE, PRINT_COPY_MAX_CHARS } from '../../shared/clinic-logo-rules.js';

// Печатная копия: вписать в квадрат PRINT_COPY_SIDE, PNG (прозрачность остаётся).
export async function makePrintCopy(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, PRINT_COPY_SIDE / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k));
    cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    try { if (bmp.close) bmp.close(); } catch (e) { /* уже закрыт */ }
    return cv.toDataURL('image/png');
}
// Точка подмены для тестов: в поддельном DOM нет canvas и createImageBitmap.
export const logoDeps = { printCopy: makePrintCopy, now: () => Date.now() };

export const logoSrc = (p) => (p ? supabase.storage.from(LOGO_BUCKET).getPublicUrl(p).data.publicUrl : '');

// Ключ файла: время + 6 случайных знаков; имя по содержимому не нужно —
// хранилище не перезаписывает (новая загрузка — новый файл).
function objectKey() {
    const rnd = (Math.random().toString(36).slice(2) + '000000').slice(0, 6);
    return logoDeps.now() + '-' + rnd;
}

/** Проверить, подготовить копию (квадратный), загрузить. true — state обновлён. */
export async function pickLogo(kind, file, state) {
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch (e) { toast(tr('Логотип — только PNG с прозрачным фоном.'), 'fail'); return false; }
    const bad = logoRefusal({ kind, name: file.name, bytes });
    if (bad) { toast(trf(bad.template, bad.params), 'fail'); return false; }
    let copy = null;
    if (kind === 'square') {
        try { copy = await logoDeps.printCopy(file); } catch (e) { copy = null; }
        if (!copy || !/^data:image\/png;base64,/.test(copy) || copy.length > PRINT_COPY_MAX_CHARS) {
            toast(tr('Не удалось подготовить логотип для печати — сохраните PNG попроще или поменьше.'), 'fail');
            return false;
        }
    }
    const objPath = kind + '/' + objectKey() + '.png';
    const { error } = await supabase.storage.from(LOGO_BUCKET).upload(objPath, file, { upsert: false });
    if (error) {
        // Отказ хранилища несёт шаблон и значения (routes/storage.js) — переводим.
        const msg = error.template ? trf(error.template, error.params || {}) : (error.message || '');
        toast(trf('Не удалось загрузить логотип: {msg}', { msg }), 'fail');
        return false;
    }
    state['logo_' + kind + '_path'] = objPath;
    if (copy) state.logo_data_url = copy;
    return true;
}

export function dropLogo(kind, state) {
    state['logo_' + kind + '_path'] = '';
    if (kind === 'square') state.logo_data_url = '';   // снимается с бланков; файл остаётся (Р7)
}

// Подсказки — литералы: h() переводит их при выводе.
const TITLE = { square: 'Квадратный, 1:1', portrait: 'Вертикальный' };
const HINT = {
    square: 'Шапка программы, печатные документы, карточки у партнёров. PNG с прозрачным фоном, рекомендуем от 512×512 px.',
    portrait: 'Знак над названием — для страницы клиники у партнёров. PNG с прозрачным фоном, рекомендуем от 600×800 px.',
};

/** Карточка «Логотипы». onChange — после загрузки / удаления (перерисовать предпросмотры). disabled — филиал. */
export function logosCard(state, { onChange = null, disabled = false } = {}) {
    const grid = h('div', { class: 'cpf-logos' });
    const changed = () => { paint(); if (typeof onChange === 'function') onChange(); };
    function tile(kind) {
        const sq = kind === 'square';
        const path = state['logo_' + kind + '_path'];
        const legacy = sq && !path && state.logo_data_url ? state.logo_data_url : '';
        const src = path ? logoSrc(path) : legacy;
        const input = h('input', { type: 'file', accept: 'image/png', hidden: true, tabindex: '-1' });
        const up = h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled, onclick: () => input.click() },
            Icon('Image', { size: 14 }), ' ', (path || legacy) ? 'Заменить' : 'Загрузить');
        const del = (path || legacy)
            ? h('button', { class: 'btn btn-ghost btn-sm cpf-danger', type: 'button', disabled, onclick: () => { dropLogo(kind, state); changed(); } },
                Icon('Trash', { size: 14 }), ' ', 'Удалить')
            : null;
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.value = '';   // тот же файл можно выбрать снова
            if (!file) return;
            up.disabled = true;
            const done = await pickLogo(kind, file, state);
            up.disabled = false;
            if (done) { toast(tr('Логотип загружен — нажмите «Сохранить».'), 'ok'); changed(); }
        });
        return h('div', { class: 'cpf-logo', dataset: { kind } },
            h('b', null, TITLE[kind]),
            h('div', { class: 'cpf-logo-box' + (sq ? '' : ' is-portrait') },
                src ? h('img', { src, alt: '' }) : h('span', { class: 'muted' }, 'Нет файла')),
            legacy ? h('span', { class: 'cpf-hint cpf-legacy' }, 'Прежний логотип — печатается, пока не загружен квадратный.') : null,
            h('span', { class: 'cpf-hint' }, HINT[kind]),
            h('div', { class: 'cpf-row' }, up, del, input));
    }
    function paint() { clear(grid); grid.appendChild(tile('square')); grid.appendChild(tile('portrait')); }
    paint();
    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Image', { size: 16 }), ' ', 'Логотипы')),
        h('div', { class: 'cpf-body' }, grid,
            h('p', { class: 'cpf-note' }, Icon('Info', { size: 16 }),
                h('span', null, 'Только PNG с прозрачным фоном — клетка под логотипом показывает, где фон прозрачный. Квадратный логотип идёт и в шапку программы, и в печатные документы.'))));
    return { node, paint };
}
