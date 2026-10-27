// TG_DEEPLINK_V1_VIEW (2026-10-26, владелец: «and here generation of Deeplink,
// sample is provided in the photo — go on now») — Настройки → «Коммерческие
// инструменты» → «Ссылки для рекламы в Telegram».
//
// Экран повторяет образец владельца (бот La Tiva): таблица ссылок
// https://t.me/<бот>?start=<ключ> с названием, типом заявки, двумя счётчиками
// (переходы и заявки), переключателем «Активна» и «Изменить / Удалить»; под ней
// форма «Новая ссылка»: ключ (он попадает в адрес), название, тип заявки, ответ
// бота на RU / UZ / EN, кнопки под ответом и файл к ответу (PDF или фото до
// 10 МБ). Всё, что проверяет сервер (telegram/deeplinks.js), здесь проверяется
// заранее тем же правилом — чтобы ошибка показывалась у поля, а не после
// загрузки файла.
//
// Образцы: meta-settings.js (карточки, run() «одна кнопка за раз», сохранение
// переключателя сразу по щелчку) и telegram-report.js (загрузка файла в
// корзину telegram-media через /api/storage).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';

const MEDIA_BUCKET = 'telegram-media';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp)$/i;
const KEY_RE = /^[a-z0-9_-]{1,32}$/;

// Действия кнопки под ответом — ровно те, что знает сервер.
const ACTIONS = [
    ['lead',   'Начать заявку'],
    ['answer', 'Показать другой ответ'],
    ['url',    'Открыть страницу'],
];

const state = { data: null, form: null, busy: false };
const refs = { root: null, listBox: null, formCard: null, onNavigate: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

export async function renderTelegramDeeplinks(container, { onNavigate } = {}) {
    clear(container);
    refs.onNavigate = onNavigate || null;
    state.form = emptyForm();
    refs.root = h('div', { class: 'fade-in' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'Ссылки для рекламы в Telegram',
        subtitle: 'Своя ссылка на бота для каждого объявления: человек открывает её и сразу получает ответ, файл и кнопку «Оставить заявку». По каждой ссылке видно, сколько пришло и сколько оставили заявку.',
    }));

    const body = h('div');
    refs.root.appendChild(body);
    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.data = await rpc('telegram_deeplinks_list');
    } catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            trf('Не удалось загрузить ссылки: {msg}', { msg: e.message })));
        return;
    }
    clear(body);
    refs.listBox = h('div');
    body.appendChild(refs.listBox);
    refs.formCard = h('div');
    body.appendChild(refs.formCard);
    paintList();
    paintForm();
}

function emptyForm() {
    return { id: 0, key: '', name: '', lead_kind: 'callback', answer_ru: '', answer_uz: '', answer_en: '',
        buttons: [], file_path: '', file_kind: '', file_name: '', active: true, pendingFile: null };
}

function linkUrl(key) {
    const bot = state.data && state.data.bot_username;
    return bot ? 'https://t.me/' + bot + '?start=' + key : '';
}

async function reload() {
    state.data = await rpc('telegram_deeplinks_list');
    paintList();
}

// ---------------------------------------------------------------------------
// Таблица ссылок
// ---------------------------------------------------------------------------
function paintList() {
    const box = refs.listBox;
    if (!box) return;
    clear(box);
    const d = state.data;
    const card = h('div', { style: { padding: '18px' } });

    if (!d.bot_username) {
        card.appendChild(h('div', { class: 'tgdl-banner', 'data-kind': 'warn', style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px 14px', borderRadius: '10px', background: '#fdf3e1', color: '#b07d1f', marginBottom: '14px' } },
            h('span', { style: { display: 'inline-flex', marginTop: '1px' } }, Icon('Warning', { size: 16 })),
            h('div', null,
                h('div', { style: { fontWeight: 600 } }, 'Бот не подключён — ссылки не откроются'),
                h('div', { style: { fontSize: '12.5px', marginTop: '2px', opacity: .9 } },
                    'Подключите бота в «Настройки → Telegram-бот» и нажмите «Проверить связь»: оттуда берётся имя бота для ссылок.'))));
    } else if (!d.bot_enabled) {
        card.appendChild(h('div', { class: 'tgdl-banner', 'data-kind': 'warn', style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px 14px', borderRadius: '10px', background: '#fdf3e1', color: '#b07d1f', marginBottom: '14px' } },
            h('span', { style: { display: 'inline-flex', marginTop: '1px' } }, Icon('Warning', { size: 16 })),
            h('div', null,
                h('div', { style: { fontWeight: 600 } }, 'Бот выключен — по ссылкам никто не ответит'),
                h('div', { style: { fontSize: '12.5px', marginTop: '2px', opacity: .9 } },
                    'Включите бота в «Настройки → Telegram-бот».'))));
    } else {
        card.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
            trf('Бот: @{bot}. Ссылки открывают его с нужным ответом.', { bot: d.bot_username })));
    }

    if (!d.links.length) {
        card.appendChild(h('div', { class: 'empty', style: { padding: '30px 20px' } },
            h('p', null, 'Ссылок пока нет.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Создайте первую в форме ниже и поставьте её в объявление: переходы и заявки начнут считаться сразу.')));
    } else {
        const tb = h('tbody');
        for (const l of d.links) tb.appendChild(linkRow(l));
        card.appendChild(h('table', { class: 'tbl tgdl-table', style: { width: '100%' } },
            h('thead', null, h('tr', null,
                h('th', null, 'Название'),
                h('th', null, 'Ссылка'),
                h('th', null, 'Тип заявки'),
                h('th', null, 'Файл'),
                h('th', { style: { textAlign: 'right' } }, 'Переходы'),
                h('th', { style: { textAlign: 'right' } }, 'Заявки'),
                h('th', null, 'Активна'),
                h('th', null, ''))),
            tb));
    }

    box.appendChild(h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Link', { size: 16 }), ' ', tr('Ссылки'))),
        card));
}

function linkRow(l) {
    const url = linkUrl(l.key);
    const copyBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Скопировать ссылку', disabled: !url,
        onclick: () => copyText(url) }, Icon('Copy', { size: 13 }));
    const active = h('input', { type: 'checkbox', checked: !!l.active, 'data-deeplink-active': String(l.id),
        onchange: async () => {
            active.disabled = true;
            try {
                await rpc('telegram_deeplink_save', { ...payloadOf(l), active: active.checked });
                toast(active.checked ? 'Ссылка включена.' : 'Ссылка выключена: бот ответит по ней обычным приветствием.', 'success');
                await reload();
            } catch (e) {
                active.checked = !active.checked;   // не сохранилось — не врём галочкой
                toast(e.message || 'Не удалось сохранить.', 'error');
            } finally { active.disabled = false; }
        } });
    const editBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => startEdit(l) }, 'Изменить');
    const delBtn = h('button', { class: 'btn btn-sm btn-danger', type: 'button',
        onclick: async () => {
            if (!confirm(trf('Удалить ссылку «{name}»? Переходы и заявки по ней из статистики исчезнут; карточки в CRM останутся.', { name: l.name }))) return;
            await run(delBtn, async () => {
                await rpc('telegram_deeplink_delete', { id: l.id });
                toast('Ссылка удалена.', 'info');
                if (state.form.id === l.id) { state.form = emptyForm(); paintForm(); }
                await reload();
            });
        } }, 'Удалить');
    return h('tr', { 'data-deeplink-id': String(l.id), style: { opacity: l.active ? '' : '.6' } },
        h('td', null,
            h('div', { style: { fontWeight: 600 } }, l.name),
            h('div', { class: 'cell-mono muted', style: { fontSize: '12.5px' } }, l.key)),
        h('td', null,
            h('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } },
                h('span', { class: 'cell-mono', style: { fontSize: '12.5px', wordBreak: 'break-all' } }, url || '—'),
                copyBtn)),
        h('td', { style: { fontSize: '13.5px' } }, tr(l.lead_kind_label)),
        h('td', { class: 'muted', style: { fontSize: '12.5px' } }, l.file_name || '—'),
        h('td', { class: 'cell-mono', style: { fontSize: '13.5px', textAlign: 'right' }, title: trf('Уникальных людей: {n}', { n: l.unique_hits }) }, String(l.hits)),
        h('td', { class: 'cell-mono', style: { fontSize: '13.5px', textAlign: 'right' } }, String(l.leads)),
        h('td', null, active),
        h('td', { style: { whiteSpace: 'nowrap' } }, h('div', { class: 'row', style: { gap: '6px' } }, editBtn, delBtn)));
}

// Тело запроса сохранения — из строки списка (переключатель «Активна») или из формы.
function payloadOf(l) {
    return { id: l.id || 0, key: l.key, name: l.name, lead_kind: l.lead_kind,
        answer_ru: l.answer_ru, answer_uz: l.answer_uz, answer_en: l.answer_en,
        buttons: (l.buttons || []).map((b) => ({ label: b.label, action: b.action, target: b.target || '' })),
        file_path: l.file_path || '', file_name: l.file_name || '', active: !!l.active };
}

async function copyText(text) {
    if (!text) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
        else {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        toast('Ссылка скопирована.', 'success');
    } catch (_) {
        toast('Не удалось скопировать — выделите ссылку и скопируйте вручную.', 'warn');
    }
}

function startEdit(l) {
    state.form = { ...emptyForm(), ...payloadOf(l), file_kind: l.file_kind || '', buttons: payloadOf(l).buttons };
    paintForm();
    try { refs.formCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { /* поддельный DOM */ }
}

// ---------------------------------------------------------------------------
// Форма «Новая ссылка» / «Изменить ссылку»
// ---------------------------------------------------------------------------
function paintForm() {
    const box = refs.formCard;
    if (!box) return;
    clear(box);
    const f = state.form;
    const isEdit = !!f.id;
    const card = h('div', { style: { padding: '18px' } });

    // Ключ: только то, что пройдёт в адрес; предпросмотр ссылки обновляется на лету.
    const keyInput = h('input', { type: 'text', value: f.key, maxlength: '32', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'price', 'data-deeplink-key': '1', style: { width: '100%' },
        oninput: () => { f.key = keyInput.value.trim().toLowerCase(); preview.textContent = previewText(); } });
    const preview = h('div', { class: 'cell-mono muted', style: { fontSize: '12.5px', marginTop: '4px', wordBreak: 'break-all' } });
    const previewText = () => {
        const k = f.key || '…';
        return state.data.bot_username ? 'https://t.me/' + state.data.bot_username + '?start=' + k : tr('Бот не подключён — имя бота для ссылки появится после «Проверить связь».');
    };
    preview.textContent = previewText();
    card.appendChild(field('Ключ — латиница, цифры, «-» и «_» (попадёт в ссылку)', h('div', null, keyInput, preview), { required: true }));

    const nameInput = h('input', { type: 'text', value: f.name, maxlength: '120', placeholder: 'Прайс на роды', 'data-deeplink-name': '1', style: { width: '100%' },
        oninput: () => { f.name = nameInput.value; } });
    card.appendChild(field('Название (видно только сотрудникам)', nameInput, { required: true }));

    const kindSel = h('select', { style: { minWidth: '240px' }, 'data-deeplink-kind': '1',
        onchange: () => { f.lead_kind = kindSel.value; } },
        ...Object.entries(state.data.lead_kinds || {}).map(([k, label]) => h('option', { value: k, selected: k === f.lead_kind }, tr(label))));
    kindSel.value = f.lead_kind;
    card.appendChild(field('Тип заявки', kindSel));

    const answerArea = (key, label, placeholder, required) => {
        const ta = h('textarea', { rows: '4', maxlength: '4096', placeholder, style: { width: '100%' }, ['data-deeplink-' + key]: '1',
            oninput: () => { f[key] = ta.value; } });
        ta.value = f[key] || '';
        return field(label, ta, { required });
    };
    card.appendChild(h('div', { class: 'tgdl-answers', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0 16px' } },
        answerArea('answer_ru', 'Ответ бота — RU', 'Роды в клинике — от 19 999 000 сум. Нажмите кнопку, и мы перезвоним.', true),
        answerArea('answer_uz', 'Ответ бота — UZ', 'Bo‘sh qolsa — ruscha javob yuboriladi', false),
        answerArea('answer_en', 'Ответ бота — EN', 'If empty, the Russian answer is sent', false)));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px' } },
        'Язык выбирается по языку Telegram человека: узбекский и английский — свои ответы, остальным — русский. Пустое поле — русский ответ.'));

    card.appendChild(buttonsBlock(f));
    card.appendChild(fileBlock(f));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-deeplink-save': '1',
        onclick: async () => { await run(saveBtn, () => submitForm()); } },
        Icon('Check', { size: 13 }), ' ', isEdit ? tr('Сохранить') : tr('Добавить ссылку'));
    const cancelBtn = h('button', { class: 'btn', type: 'button', style: { display: isEdit ? '' : 'none' },
        onclick: () => { state.form = emptyForm(); paintForm(); } }, 'Отмена');
    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '14px' } }, saveBtn, cancelBtn));

    box.appendChild(h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon(isEdit ? 'Edit' : 'Plus', { size: 16 }), ' ',
            isEdit ? trf('Изменить ссылку: {name}', { name: f.name }) : tr('Новая ссылка'))),
        card));
}

// Кнопки под ответом. Без кнопок бот покажет одну — «Оставить заявку».
function buttonsBlock(f) {
    const box = h('div', { style: { marginTop: '6px' } });
    const list = h('div', { 'data-deeplink-buttons': '1' });
    const repaint = () => {
        clear(list);
        f.buttons.forEach((b, i) => list.appendChild(buttonRow(f, b, i, repaint)));
        if (!f.buttons.length) {
            list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } },
                'Без кнопок бот покажет одну — «Оставить заявку».'));
        }
    };
    repaint();
    const addBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-deeplink-add-button': '1',
        onclick: () => {
            if (f.buttons.length >= 10) return toast('Кнопок под ответом может быть не больше десяти.', 'warn');
            f.buttons.push({ label: '', action: 'lead', target: '' });
            repaint();
        } }, Icon('Plus', { size: 13 }), ' ', tr('Добавить кнопку'));
    box.appendChild(h('div', { class: 'field' }, h('label', null, 'Кнопки под ответом'), list, addBtn));
    return box;
}

function buttonRow(f, b, i, repaint) {
    const label = h('input', { type: 'text', value: b.label, maxlength: '64', placeholder: 'Подпись кнопки', style: { flex: '1', minWidth: '140px' },
        oninput: () => { b.label = label.value; } });
    const target = h('input', { type: 'text', value: b.target || '', style: { flex: '1.4', minWidth: '180px' },
        oninput: () => { b.target = target.value.trim(); } });
    const syncTarget = () => {
        target.style.display = b.action === 'lead' ? 'none' : '';
        target.placeholder = b.action === 'url' ? 'https://…' : tr('ключ другой ссылки');
    };
    const action = h('select', { style: { minWidth: '200px' }, onchange: () => { b.action = action.value; if (b.action === 'lead') { b.target = ''; target.value = ''; } syncTarget(); } },
        ...ACTIONS.map(([k, name]) => h('option', { value: k, selected: k === b.action }, tr(name))));
    action.value = b.action;
    syncTarget();
    const del = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать кнопку',
        onclick: () => { f.buttons.splice(i, 1); repaint(); } }, Icon('X', { size: 13 }));
    return h('div', { class: 'row tgdl-button-row', style: { gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' } }, label, action, target, del);
}

// Файл к ответу: PDF или картинка до 10 МБ. Грузится при сохранении формы —
// иначе отменённая форма оставляла бы в хранилище файлы-сироты.
function fileBlock(f) {
    const box = h('div', { 'data-deeplink-file': '1' });
    const paint = () => {
        clear(box);
        const current = f.pendingFile ? f.pendingFile.name : f.file_name;
        const input = h('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.gif,.webp', style: { display: 'none' },
            onchange: () => {
                const file = input.files && input.files[0];
                if (!file) return;
                const bad = fileRefusal(file);
                if (bad) { toast(bad, 'warn'); return; }
                f.pendingFile = file;
                paint();
            } });
        const pick = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => input.click() },
            Icon('Paperclip', { size: 13 }), ' ', current ? tr('Заменить файл') : tr('Выбрать файл'));
        const remove = current ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button',
            onclick: () => { f.pendingFile = null; f.file_path = ''; f.file_kind = ''; f.file_name = ''; paint(); } }, 'Убрать файл') : null;
        box.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            input, pick,
            current ? h('span', { class: 'cell-mono', style: { fontSize: '12.5px' } }, current) : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'PDF или фото до 10 МБ — бот пришлёт его вместе с ответом'),
            remove));
    };
    paint();
    return h('div', { class: 'field' }, h('label', null, 'Файл к ответу'), box);
}

function fileRefusal(file) {
    if (!FILE_EXT.test(file.name || '')) return tr('Файл к ответу — PDF или картинка (JPG, PNG, GIF, WEBP).');
    if (file.size > MAX_FILE_BYTES) return tr('Файл к ответу — не больше 10 МБ: больше Telegram не примет.');
    return '';
}

async function submitForm() {
    const f = state.form;
    if (!KEY_RE.test(f.key)) return toast('Ключ ссылки — от 1 до 32 знаков: латиница, цифры, «-» и «_». Он попадает в адрес ссылки.', 'warn');
    if (!f.name.trim()) return toast('Дайте ссылке название — оно видно только сотрудникам.', 'warn');
    if (!String(f.answer_ru || '').trim()) return toast('Ответ бота на русском обязателен: на него откатываются остальные языки.', 'warn');
    for (const b of f.buttons) {
        if (!b.label.trim()) return toast('У каждой кнопки должна быть подпись.', 'warn');
        if (b.action === 'url' && !/^https?:\/\/\S+$/i.test(b.target || '')) return toast('Адрес кнопки должен начинаться с http:// или https://.', 'warn');
        if (b.action === 'answer' && !KEY_RE.test(String(b.target || '').toLowerCase())) return toast('Кнопка «показать другой ответ» ссылается на ключ другой ссылки — латиница, цифры, «-» и «_».', 'warn');
    }
    let filePath = f.file_path;
    let fileName = f.file_name;
    if (f.pendingFile) {
        const ext = (f.pendingFile.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        const objectPath = 'deeplinks/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '/' + Date.now() + ext;
        const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(objectPath, f.pendingFile);
        if (error) throw new Error(trf('Не удалось загрузить файл: {msg}', { msg: error.message || error }));
        filePath = objectPath;
        fileName = f.pendingFile.name;
    }
    const saved = await rpc('telegram_deeplink_save', { ...payloadOf(f), file_path: filePath, file_name: fileName });
    toast(f.id ? 'Ссылка сохранена.' : trf('Ссылка добавлена: {url}', { url: linkUrl(saved.key) || saved.key }), 'success');
    state.form = emptyForm();
    paintForm();
    await reload();
}

// Одна кнопка за раз: два параллельных сохранения — гонка, в которой побеждает случайное.
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { await fn(); }
    catch (e) { toast(e.message || 'Не удалось выполнить операцию.', 'error'); }
    finally {
        state.busy = false;
        try { btn.disabled = false; btn.textContent = label; } catch (_) { /* перерисовано */ }
    }
}
