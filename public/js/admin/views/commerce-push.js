// SMS_PUSH_V1 — инструмент «Push-уведомления» (#commerce-push) витрины
// «Коммерческие инструменты» (COMMERCE_TOOLS_V1, commerce-hub.js): пациентам
// по Telegram или по SMS.
//
// Владелец (2026-10-30), глядя на страницу с тремя плитками настроек:
// «remove them from here as they already exist in setting. Rather build such
// push place in there, push should have telegram push, sms push», и следом:
// «In sms photo should not possible». Плитки (Meta, ссылки Telegram, SMS)
// остались только в «Настройки → Коммерческие инструменты»; здесь — место
// для рассылки, по макету владельца в три колонки:
//   1. Сообщение — канал (Telegram / SMS) и текст. У Telegram — картинка 16:9,
//      у SMS картинки нет вовсе: поле не рисуется, а счётчик считает части SMS.
//   2. Как увидит пациент — живой предпросмотр в виде канала.
//   3. Кому отправить — те же фильтры, что у рассылки в Telegram (сервер
//      толкует их одним кодом, telegram/broadcast.js passingPatientIds), число
//      получателей и «Отправить» с подтверждением числом.
//
// Отправка Telegram — прежние telegram_broadcast_* (право «Telegram-бот:
// Изменение»), SMS — sms_broadcast_* (только администратор, rpc/sms.js).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { fileTo16x9Jpeg } from './image-16x9.js';
import { settingsTileAllows, isRouteAllowed } from '../permissions.js';

const MEDIA_BUCKET = 'telegram-media';   // та же корзина, что у рассылки в Telegram
const CAPTION_LIMIT = 1024;

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

/** Каналы, которые роли можно: Telegram — «Telegram-бот: Изменение», SMS — администратор. */
export function pushChannels() {
    const out = [];
    if (settingsTileAllows('settings.telegram', 'edit')) out.push('telegram');
    if (isRouteAllowed('sms-settings')) out.push('sms');
    return out;
}

/** SMS по-кириллице — 70 символов в части (67 в склейке), латиницей — 160 (153). То же правило — sms/broadcast.js. */
export function smsParts(text) {
    const t = String(text || '');
    if (!t) return 0;
    const unicode = /[^\x00-\x7F]/.test(t);
    const one = unicode ? 70 : 160, multi = unicode ? 67 : 153;
    return t.length <= one ? 1 : Math.ceil(t.length / multi);
}

export function renderCommercePush(container) {
    clear(container);
    const channels = pushChannels();
    const st = { channel: channels[0] || 'telegram', imagePath: null, imageUrl: null, smsSender: '', preview: null, busy: false };

    const root = h('div', { class: 'fade-in', 'data-commerce-push': '' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Push-уведомления',
        subtitle: 'Push-уведомление пациентам по Telegram или по SMS. Подключения настраиваются в «Настройки → Коммерческие инструменты».',
    }));
    if (!channels.length) {
        root.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, 'Отправка уведомлений вашей роли недоступна.'));
        return;
    }

    // SMS: имя отправителя — для предпросмотра; нет подключения — без него.
    if (channels.includes('sms')) rpc('sms_settings_get').then((s) => { st.smsSender = s.originator || ''; paintPhone(); }).catch(() => {});

    // ── 1. Сообщение ────────────────────────────────────────────────────────
    const tabs = h('div', { class: 'cp-tabs', role: 'tablist' });
    const ru = h('textarea', { rows: '6', 'data-push-text': '', placeholder: 'Например: Уважаемые пациенты! С понедельника клиника работает до 20:00.', style: { width: '100%' } });
    const uz = h('textarea', { rows: '3', 'data-push-text-uz': '', placeholder: 'Matn o‘zbek tilida (ixtiyoriy)', style: { width: '100%' } });
    const counter = h('div', { class: 'cp-counter', 'data-push-counter': '' });
    const imageBox = h('div', { 'data-push-image': '' });
    const uzField = h('div', { class: 'field' }, h('label', null, 'Тот же текст по-узбекски'), uz,
        h('div', { class: 'cp-hint' }, 'Уходит тем же сообщением, следом за русским.'));
    const smsNote = h('div', { class: 'cp-hint', 'data-push-sms-note': '' },
        'SMS — только текст: фото и файлы по SMS не отправляются. Один номер получает одно SMS, даже если на нём несколько карт.');

    const msgCol = h('div', { class: 'card cp-col' },
        colHead('Edit', 'Сообщение', 'Канал, текст и картинка', 1),
        h('div', { class: 'cp-col-body' },
            tabs,
            h('div', { class: 'field' }, h('label', null, 'Текст уведомления'), ru, counter),
            uzField, imageBox, smsNote));

    // ── 2. Как увидит пациент ───────────────────────────────────────────────
    const phone = h('div', { class: 'cp-phone', 'data-push-preview': '' });
    const prevCol = h('div', { class: 'card cp-col' },
        colHead('Phone', 'Как увидит пациент', 'Живой предпросмотр', 2),
        h('div', { class: 'cp-col-body' }, phone,
            h('div', { class: 'cp-hint' }, 'Обновляется, пока вы печатаете; отправлено ещё не будет.')));

    // ── 3. Кому отправить ───────────────────────────────────────────────────
    const anySel = (name, anyLabel) => h('select', { 'data-push-filter': name }, h('option', { value: '' }, anyLabel));
    const genderSel = h('select', { 'data-push-filter': 'gender' },
        h('option', { value: '' }, 'Любой'), h('option', { value: 'female' }, 'Женщины'), h('option', { value: 'male' }, 'Мужчины'));
    const ageFrom = h('input', { type: 'number', min: '0', max: '130', placeholder: 'от', 'data-push-filter': 'age_from' });
    const ageTo = h('input', { type: 'number', min: '0', max: '130', placeholder: 'до', 'data-push-filter': 'age_to' });
    const from = h('input', { type: 'date', 'data-push-filter': 'visited_from' });
    const to = h('input', { type: 'date', 'data-push-filter': 'visited_to' });
    const notSince = h('input', { type: 'date', 'data-push-filter': 'not_visited_since' });
    const doctorSel = anySel('doctor_id', 'Любой');
    const serviceTypeSel = anySel('service_type_id', 'Любая');
    const serviceSel = anySel('service_id', 'Любая');
    const categorySel = anySel('category_id', 'Любая');
    const branchSel = anySel('branch_id', 'Любой');
    const unpaid = h('input', { type: 'checkbox', 'data-push-filter': 'unpaid' });
    const inputs = [genderSel, ageFrom, ageTo, from, to, notSince, doctorSel, serviceTypeSel, serviceSel, categorySel, branchSel, unpaid];
    const filters = () => {
        const f = {};
        const num = (el) => (el.value === '' || el.value == null ? null : Number(el.value));
        if (genderSel.value) f.gender = genderSel.value;
        if (num(ageFrom) != null) f.age_from = num(ageFrom);
        if (num(ageTo) != null) f.age_to = num(ageTo);
        if (from.value) f.visited_from = from.value;
        if (to.value) f.visited_to = to.value;
        if (notSince.value) f.not_visited_since = notSince.value;
        for (const [k, el] of [['doctor_id', doctorSel], ['service_type_id', serviceTypeSel], ['service_id', serviceSel], ['category_id', categorySel], ['branch_id', branchSel]]) {
            if (el.value) f[k] = Number(el.value);
        }
        if (unpaid.checked) f.unpaid = true;
        return f;
    };
    const branchField = fieldOf('Филиал', branchSel);
    const fillSelect = (sel, rows, label) => { for (const r of (Array.isArray(rows) ? rows : [])) sel.appendChild(h('option', { value: String(r.id) }, label(r))); };
    // Справочники — тот же вызов, что у окна рассылки Telegram; без них
    // работают пол, возраст, даты и долг.
    rpc('telegram_broadcast_options').then((o) => {
        fillSelect(doctorSel, o.doctors, (d) => d.full_name + (d.specialty ? ' · ' + d.specialty : ''));
        fillSelect(serviceTypeSel, o.service_types, (t) => t.name);
        fillSelect(serviceSel, o.services, (s) => s.name);
        fillSelect(categorySel, o.categories, (c) => c.name);
        fillSelect(branchSel, o.branches, (b) => b.name);
        if (!(o.branches && o.branches.length > 1)) branchField.style.display = 'none';
    }).catch(() => { branchField.style.display = 'none'; });

    const countBox = h('div', { class: 'cp-count', 'data-push-count': '' });
    const sendBtn = h('button', { class: 'btn btn-primary cp-send', type: 'button', 'data-push-send': '', onclick: () => send() },
        Icon('Send', { size: 13 }), ' ', tr('Отправить'));
    const pair = (a, b) => h('div', { class: 'cp-pair' }, a, h('span', { class: 'cp-dash' }, '—'), b);

    const whoCol = h('div', { class: 'card cp-col' },
        colHead('Send', 'Кому отправить', 'Фильтры и отправка', 3),
        h('div', { class: 'cp-col-body' },
            fieldOf('Пол', genderSel),
            fieldOf('Возраст', pair(ageFrom, ageTo)),
            fieldOf('Приходил в период', pair(from, to)),
            fieldOf('Не приходил с', notSince),
            fieldOf('Был у врача', doctorSel),
            fieldOf('Получал услуги группы', serviceTypeSel),
            fieldOf('Получал услугу', serviceSel),
            fieldOf('Категория пациента', categorySel),
            branchField,
            h('label', { class: 'cp-check' }, unpaid, ' ', tr('Только с неоплаченным счётом')),
            h('div', { class: 'cp-hint' }, 'Врач считается и как врач визита, и как исполнитель услуги. Все условия действуют вместе.'),
            countBox, sendBtn,
            h('div', { class: 'cp-hint' }, 'Отменить рассылку нельзя: сообщение уходит людям сразу.')));

    root.appendChild(h('div', { class: 'cp-grid' }, msgCol, prevCol, whoCol));

    // ── поведение ───────────────────────────────────────────────────────────
    function paintTabs() {
        clear(tabs);
        for (const ch of channels) {
            const on = ch === st.channel;
            tabs.appendChild(h('button', {
                type: 'button', role: 'tab', class: 'cp-tab' + (on ? ' is-on' : ''), 'data-push-channel': ch, 'aria-selected': on ? 'true' : 'false',
                onclick: () => { if (st.channel !== ch) { st.channel = ch; onChannel(); } },
            }, Icon(ch === 'sms' ? 'Msg' : 'Send', { size: 14 }), ' ', ch === 'sms' ? 'SMS' : 'Telegram'));
        }
    }
    function onChannel() {
        paintTabs();
        const sms = st.channel === 'sms';
        uzField.style.display = sms ? 'none' : '';
        smsNote.style.display = sms ? '' : 'none';
        // «In sms photo should not possible» — у SMS поля картинки нет вовсе,
        // а выбранная для Telegram картинка в SMS не уходит.
        imageBox.style.display = sms ? 'none' : '';
        st.preview = null;
        paintCount();
        syncCounter();
        paintPhone();
        schedulePreview();
    }

    function smsText() { return ru.value.trim(); }
    function tgText() { const r = ru.value.trim(), u = uz.value.trim(); return u ? r + '\n\n' + u : r; }

    function syncCounter() {
        if (st.channel === 'sms') {
            const t = smsText();
            const parts = smsParts(t);
            counter.textContent = trf('{n} символов · {parts} SMS на получателя', { n: t.length, parts });
            counter.classList.toggle('is-warn', parts > 1);
        } else {
            const n = tgText().length;
            const split = !!st.imagePath && n > CAPTION_LIMIT;
            counter.textContent = split
                ? trf('{n} символов · с картинкой уйдёт двумя сообщениями (в подпись помещается {limit})', { n, limit: CAPTION_LIMIT })
                : trf('{n} символов', { n });
            counter.classList.toggle('is-warn', split);
        }
    }

    function paintPhone() {
        clear(phone);
        const sms = st.channel === 'sms';
        const text = sms ? smsText() : tgText();
        if (!text && (sms || !st.imageUrl)) {
            // Фраза целиком: словарь переводит только целые строки.
            phone.appendChild(h('div', { class: 'cp-phone-empty' }, sms
                ? 'Пока пусто. Напишите текст — здесь появится сообщение.'
                : 'Пока пусто. Напишите текст или выберите картинку — здесь появится сообщение.'));
            return;
        }
        if (sms) {
            phone.appendChild(h('div', { class: 'cp-sms-from' }, st.smsSender || tr('Отправитель')));
            phone.appendChild(h('div', { class: 'cp-bubble cp-bubble-sms' }, text));
        } else {
            phone.appendChild(h('div', { class: 'cp-bubble cp-bubble-tg' },
                st.imageUrl ? h('img', { src: st.imageUrl, alt: '', class: 'cp-bubble-img' }) : null,
                text ? h('div', { class: 'cp-bubble-text' }, text) : null));
        }
    }

    // Число получателей — по требованию: после изменения фильтра или канала
    // (полсекунды тишины), ответ на устаревший набор отбрасывается по номеру.
    let seq = 0, timer = null;
    function schedulePreview() { clearTimeout(timer); timer = setTimeout(refreshPreview, 500); }
    async function refreshPreview() {
        const my = ++seq;
        const name = st.channel === 'sms' ? 'sms_broadcast_preview' : 'telegram_broadcast_preview';
        try {
            const p = await rpc(name, { filters: filters() });
            if (my !== seq) return;
            st.preview = p;
        } catch (e) {
            if (my !== seq) return;
            st.preview = { error: e.message };
        }
        paintCount();
    }
    function paintCount() {
        clear(countBox);
        const p = st.preview;
        countBox.appendChild(h('span', { class: 'cp-count-label' }, tr('Получателей')));
        if (!p) { countBox.appendChild(h('b', null, '…')); return; }
        if (p.error) { countBox.appendChild(h('span', { class: 'muted' }, p.error)); return; }
        countBox.appendChild(h('b', { 'data-push-count-n': String(p.count) }, String(p.count)));
        if (st.channel === 'sms' && p.count) {
            const parts = smsParts(smsText()) || 1;
            countBox.appendChild(h('span', { class: 'muted' }, ' · ' + trf('SMS к оплате: {n}', { n: p.count * parts })));
        }
    }
    for (const el of inputs) el.addEventListener('change', schedulePreview);
    ru.addEventListener('input', () => { syncCounter(); paintPhone(); if (st.channel === 'sms') paintCount(); });
    uz.addEventListener('input', () => { syncCounter(); paintPhone(); });

    // ── картинка (только Telegram) ──────────────────────────────────────────
    const fileInp = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' },
        onchange: () => { const f = fileInp.files && fileInp.files[0]; fileInp.value = ''; if (f) acceptImage(f); } });
    function paintImageBox() {
        clear(imageBox);
        imageBox.appendChild(fileInp);
        const row = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => fileInp.click() }, Icon('Image', { size: 13 }), ' ', tr(st.imagePath ? 'Заменить картинку' : 'Прикрепить картинку')),
            st.imagePath ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { st.imagePath = null; st.imageUrl = null; paintImageBox(); syncCounter(); paintPhone(); } }, 'Убрать') : null,
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, st.imagePath ? tr('картинка прикреплена') : tr('картинка не выбрана')));
        imageBox.appendChild(row);
        imageBox.appendChild(h('div', { class: 'cp-hint' }, 'Картинка обрезается по центру до 16:9 и уходит с текстом в подписи. Если текст длиннее 1024 символов, он уйдёт отдельным сообщением следом.'));
    }
    async function acceptImage(file) {
        let blob;
        try { blob = await fileTo16x9Jpeg(file); }
        catch (e) { return toast(e.message || 'Не удалось обработать картинку.', 'error'); }
        const objectPath = `broadcast/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(objectPath, blob);
        if (error) return toast(trf('Не удалось загрузить картинку: {msg}', { msg: error.message || error }), 'error');
        st.imagePath = objectPath;
        st.imageUrl = URL.createObjectURL(blob);
        paintImageBox(); syncCounter(); paintPhone();
    }

    // ── отправка ────────────────────────────────────────────────────────────
    async function send() {
        if (st.busy) return;
        const sms = st.channel === 'sms';
        if (!ru.value.trim()) return toast('Введите текст сообщения.', 'warn');
        let p;
        try { p = await rpc(sms ? 'sms_broadcast_preview' : 'telegram_broadcast_preview', { filters: filters(), fresh: true }); }
        catch (e) { return toast(e.message, 'error'); }
        if (!p.count) return toast(sms ? 'Под эти условия не подходит ни один пациент с номером Узбекистана.' : 'Под эти условия не подходит ни один подключённый пациент.', 'warn');
        // Подтверждение числом, а не «ОК»: отозвать ушедшее сообщение нельзя.
        const typed = prompt(
            (sms ? trf('SMS получат {count} номеров (SMS к оплате: {parts}).\n\n', { count: p.count, parts: p.count * (smsParts(smsText()) || 1) })
                 : trf('Сообщение получат {count} чел. в Telegram.\n\n', { count: p.count })) +
            tr('Отменить отправку будет нельзя.\n') +
            trf('Чтобы подтвердить, введите число получателей: {count}', { count: p.count }));
        if (typed === null) return;
        if (String(typed).trim() !== String(p.count)) return toast('Число не совпало — отправка отменена.', 'info');

        st.busy = true;
        sendBtn.disabled = true;
        try {
            const started = sms
                ? await rpc('sms_broadcast_send', { text: ru.value, filters: filters(), confirm_count: p.count })
                : await rpc('telegram_broadcast_send', { text_ru: ru.value, text_uz: uz.value, filters: filters(), confirm_count: p.count, image_path: st.imagePath });
            toast(trf('Рассылка запущена: {n} получателей.', { n: started.audience_count }), 'success');
            ru.value = ''; uz.value = '';
            syncCounter(); paintPhone();
            await watch(sms ? 'sms_broadcast_status' : 'telegram_broadcast_status', started.id);
        } catch (e) {
            toast(e.message || 'Не удалось запустить рассылку.', 'error');
        } finally {
            st.busy = false;
            sendBtn.disabled = false;
        }
    }

    // Рассылка идёт на сервере; здесь — ход, раз в секунду.
    async function watch(statusRpc, id) {
        clear(countBox);
        const line = h('div', { 'data-push-progress': '' }, tr('Отправка…'));
        countBox.appendChild(line);
        for (let i = 0; i < 600; i++) {
            let s;
            try { s = await rpc(statusRpc, { id }); } catch { break; }
            line.textContent = trf('Отправлено {sent} из {total}', { sent: s.sent_count, total: s.audience_count })
                + (s.failed_count ? ' · ' + trf('не доставлено {n}', { n: s.failed_count }) : '');
            if (s.status !== 'running') {
                if (!s.failed_count) line.appendChild(h('div', { class: 'muted', style: { marginTop: '4px' } }, trf('Готово · {when}', { when: fmtDateTime(s.finished_at) })));
                break;
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    paintTabs();
    paintImageBox();
    onChannel();
}

function colHead(icon, title, sub, n) {
    return h('div', { class: 'cp-col-head' },
        h('span', { class: 'cp-col-ico' }, Icon(icon, { size: 16 })),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { class: 'cp-col-title' }, title),
            h('div', { class: 'cp-col-sub' }, sub)),
        h('span', { class: 'cp-col-n' }, String(n)));
}

function fieldOf(label, control) {
    return h('div', { class: 'field' }, h('label', null, label), control);
}
