// SERVICE_ORDER_FORM_V3 (2026-09-10) — НАЗНАЧИТЬ УСЛУГИ ГОСПИТАЛИЗАЦИИ.
//
// Владелец, тремя заходами: «make dialogue window in the services like in the
// prescriptions, select time and date etc» → «dialogue window is tooo big» →
// «increase the width, so user can select time date and performer, also add
// several services at one time».
//
// ЧТО ЭТО ЗА ОКНО. Раньше «+ Анализы и диагностика» открывали прямо справочник:
// выбрал — начислено сию секунду. Для расходника это верно (его списали со
// склада и точка), а для КТ на завтра на 10:30 — нет: назначение это ещё и
// ВРЕМЯ и ИСПОЛНИТЕЛЬ, без них ни кабинет не подготовить, ни список на день не
// собрать.
//
// ДВЕ КОЛОНКИ, А НЕ ОДНА. Слева справочник, справа — что назначаем. Так видно
// то и другое сразу: назначают обычно не одну услугу, а набор («анализы перед
// операцией»), и после каждой закрывать окно значит четырежды заново искать
// пациента, дату и врача. Полноэкранное окно подбора при этом не возвращается —
// «tooo big» было про него.
//
// ОДНО ВРЕМЯ И ОДИН ИСПОЛНИТЕЛЬ НА ВЕСЬ НАБОР. Их спрашивают один раз: набор
// назначают на один заход в кабинет, а разное время у соседних строк — это уже
// два назначения, и делают их двумя открытиями окна.
//
// Раздел услуги определяет ТА ЖЕ общая функция (resolveTypeId), что и большое
// окно подбора: второй способ отнести услугу к разделу разошёлся бы с первым
// молча — ровно тем, что одна и та же услуга попадала бы в разные разделы в
// зависимости от того, откуда её ищут.
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { inpatientModal, patientAnchor } from './admission-modal.js?v=inp5';
import { resolveTypeId } from './service-group.js?v=aug17e';

/** Сумма словами клиники: разряды пробелами, без копеек. */
const money = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Сегодняшний день местными часами — тот же приём, что и в листе назначений. */
function todayLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * Ближайшие полчаса вперёд — разумная умолчальная минута.
 *
 * Не «сейчас»: пока врач заполняет окно, «сейчас» уже прошло, и назначение
 * рождалось бы просроченным.
 */
function nextHalfHour() {
    const d = new Date(Date.now() + 30 * 60 * 1000);
    const m = d.getMinutes() < 30 ? 30 : 0;
    if (m === 0) d.setHours(d.getHours() + 1);
    return String(d.getHours()).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Кто может быть исполнителем.
 *
 * ADMIN_DOCTOR_LIST_V1 — врач узнаётся по флагу is_doctor, а не по роли:
 * администратор клиники сплошь и рядом ведёт приём, и роли 'doctor' у него нет.
 */
const isPerformer = (u) => !!u && (u.is_doctor === true || u.is_doctor === 1
    || String(u.role || '').toLowerCase() === 'doctor' || String(u.specialty || '').length > 0);

/**
 * ОКНО «НАЗНАЧИТЬ УСЛУГИ».
 *
 * @param {object} opts
 * @param {number} opts.admissionId    госпитализация
 * @param {string} opts.title          «Анализы и диагностика» / «Операция»
 * @param {string[]} opts.typeNames    разделы справочника, с которых открыться
 * @param {number} opts.doctorId       лечащий врач — умолчание исполнителя
 * @param {string} opts.patientName    для якоря пациента
 * @param {string} opts.patientSub     палата, койка, номер карты
 * @param {Function} opts.onDone       перерисовать вкладку после назначения
 */
export function openServiceOrderForm({
    admissionId, title = 'Назначить услугу', typeNames = null, doctorId = null,
    patientName = '', patientSub = '', onDone = null,
} = {}) {
    if (!admissionId) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }

    // Что назначаем. Список, а не одна услуга: набор — обычный случай.
    const cart = [];
    // Весь справочник и то, чем он размечен. `preset` — разделы вкладки,
    // которой окно открыли: умолчание, а не запрет.
    const cat = { all: [], types: [], groups: [], group: 'preset', preset: null, loaded: false };

    const searchInp = h('input', { type: 'search', placeholder: 'Поиск по названию услуги' });
    const groupBox = h('div', { class: 'sof-groups' });
    const listBox = h('div', { class: 'sof-list' });
    const cartBox = h('div', { class: 'sof-cart' });
    const cartSum = h('div', { class: 'sof-sum' });

    const dateInp = h('input', { type: 'date', value: todayLocal() });
    const timeInp = h('input', { type: 'time', value: nextHalfHour() });
    const noteInp = h('input', { type: 'text', placeholder: 'Например: натощак' });
    const nowChk = h('input', { type: 'checkbox' });
    const docSel = h('select', null, h('option', { value: '' }, tr('Исполнитель не назначен')));

    const syncWhen = () => {
        const now = nowChk.checked;
        dateInp.disabled = now;
        timeInp.disabled = now;
    };
    nowChk.addEventListener('change', syncWhen);

    /** Раздел услуги — ТОЙ ЖЕ общей функцией, что и в большом окне подбора. */
    const groupIdOf = (svc) => String(resolveTypeId(svc, cat.types) || '');
    /** Услуги выбранной плашки. Одно место, где решается, что показывать. */
    const inGroup = (svc) => {
        if (cat.group === 'preset') return !cat.preset || cat.preset.has(groupIdOf(svc));
        if (!cat.group) return true;
        return groupIdOf(svc) === cat.group;
    };
    const inCart = (id) => cart.find((x) => x.service.id === id) || null;

    // ── что назначаем ───────────────────────────────────────────────────
    const paintCart = () => {
        clear(cartBox);
        clear(cartSum);
        if (!cart.length) {
            cartBox.appendChild(h('div', { class: 'sof-empty' },
                tr('Ничего не выбрано — отметьте услуги слева.')));
            return;
        }
        for (const row of cart) {
            const qty = h('input', { type: 'number', min: '1', step: '1', class: 'sof-qty',
                'aria-label': tr('Количество') });
            qty.value = String(row.qty);
            qty.addEventListener('input', () => {
                const n = Number(qty.value);
                row.qty = Number.isFinite(n) && n > 0 ? n : 1;
                paintSum();
            });
            cartBox.appendChild(h('div', { class: 'sof-cart-row' },
                h('div', { class: 'sof-cart-main' },
                    h('div', { class: 'sof-cart-n' }, row.service.name || '—'),
                    h('div', { class: 'sof-cart-p' }, money(row.service.price) + ' ' + tr('сум'))),
                qty,
                h('button', {
                    class: 'btn btn-sm btn-ghost', type: 'button',
                    title: tr('Убрать из назначения'),
                    onclick: () => { cart.splice(cart.indexOf(row), 1); paintCart(); paintList(); },
                }, Icon('X', { size: 13 }))));
        }
        paintSum();
    };

    /** Итог набора: сколько услуг и на какую сумму. */
    function paintSum() {
        clear(cartSum);
        if (!cart.length) return;
        const total = cart.reduce((a, r) => a + (Number(r.service.price) || 0) * r.qty, 0);
        cartSum.appendChild(h('span', { class: 'sof-sum-l' }, trf('Услуг: {n}', { n: cart.length })));
        cartSum.appendChild(h('span', { class: 'grow' }));
        cartSum.appendChild(h('span', { class: 'sof-sum-v' }, money(total) + ' ' + tr('сум')));
    }

    // ── справочник ──────────────────────────────────────────────────────
    const paintGroups = () => {
        clear(groupBox);
        // Один раздел — не выбор: строка плашек из одной кнопки только занимает
        // место и делает вид, что где-то есть второй вариант.
        if (!cat.loaded || cat.groups.length < 2) { groupBox.hidden = true; return; }
        groupBox.hidden = false;
        const chip = (id, label, n) => h('button', {
            class: 'cf-fchip' + (cat.group === id ? ' on' : ''), type: 'button',
            onclick: () => { cat.group = id; paintGroups(); paintList(); },
        }, label, h('span', { class: 'cf-fchip-n' }, String(n)));
        if (cat.preset) {
            const n = cat.all.filter((x) => cat.preset.has(groupIdOf(x))).length;
            // Плашка своего набора названа так же, как кнопка, которой окно
            // открыли: врач видит, почему список начинается именно с них.
            groupBox.appendChild(chip('preset', tr(title), n));
        }
        groupBox.appendChild(chip(null, tr('Весь справочник'), cat.all.length));
        for (const g of cat.groups) groupBox.appendChild(chip(g.id, g.name, g.count));
    };

    const paintList = () => {
        clear(listBox);
        if (!cat.loaded) {
            listBox.appendChild(h('div', { class: 'sof-empty' }, tr('Загружаем справочник…')));
            return;
        }
        const q = String(searchInp.value || '').trim().toLowerCase();
        const rows = cat.all.filter((x) => inGroup(x)
            && (!q || String(x.name || '').toLowerCase().includes(q)));
        if (!rows.length) {
            listBox.appendChild(h('div', { class: 'sof-empty' }, tr('Ничего не найдено — измените запрос.')));
            return;
        }
        // Сорок строк — потолок списка, а не справочника: дальше ищут словом.
        for (const svc of rows.slice(0, 40)) {
            const on = !!inCart(svc.id);
            listBox.appendChild(h('button', {
                class: 'sof-row' + (on ? ' on' : ''), type: 'button',
                // Повторное нажатие снимает: отметил лишнее — убрал тем же
                // движением, не отыскивая строку справа.
                onclick: () => {
                    const has = inCart(svc.id);
                    if (has) cart.splice(cart.indexOf(has), 1);
                    else cart.push({ service: svc, qty: 1 });
                    paintCart(); paintList();
                },
            },
                h('span', { class: 'sof-row-c' }, on ? Icon('Check', { size: 13 }) : null),
                h('span', { class: 'sof-row-n' }, svc.name || '—'),
                h('span', { class: 'sof-row-p' }, money(svc.price))));
        }
        if (rows.length > 40) {
            listBox.appendChild(h('div', { class: 'sof-empty' },
                trf('Показаны первые 40 из {n} — уточните запрос.', { n: rows.length })));
        }
    };
    searchInp.addEventListener('input', paintList);

    (async () => {
        const [{ data: services }, { data: types }, { data: staff }] = await Promise.all([
            supabase.from('services').select('id, name, price, type, type_id, is_lab')
                .eq('active', 1).order('name'),
            supabase.from('service_types').select('id, name').eq('active', 1).order('name'),
            supabase.from('users').select('id, full_name, specialty, role, is_doctor')
                .eq('active', 1).order('full_name'),
        ]);
        cat.types = types || [];
        cat.all = (services || []).filter(Boolean);
        const needles = (typeNames || []).map((x) => String(x).toLowerCase());
        const keep = needles.length
            ? cat.types.filter((t) => needles.some((n) => String(t.name || '').toLowerCase().includes(n)))
            : [];
        const preset = keep.length ? new Set(keep.map((t) => String(t.id))) : null;
        // ПУСТОЙ СПИСОК ХУЖЕ ЛИШНЕЙ УСЛУГИ: если в разделах вкладки у клиники
        // ничего не заведено (операции сплошь и рядом лежат в «Процедурах»),
        // умолчания нет вовсе — окно открывается на всём справочнике.
        const fits = preset ? cat.all.filter((x) => preset.has(groupIdOf(x))).length : 0;
        cat.preset = fits ? preset : null;
        cat.group = cat.preset ? 'preset' : null;
        // Разделы — только те, в которых что-то есть: пустой раздел в строке
        // выбора это обещание услуг, которых нет.
        const counts = new Map();
        for (const svc of cat.all) {
            const id = groupIdOf(svc);
            if (!id) continue;
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        cat.groups = cat.types
            .filter((t) => counts.has(String(t.id)))
            .map((t) => ({ id: String(t.id), name: t.name || '', count: counts.get(String(t.id)) }));
        cat.loaded = true;

        for (const u of (staff || []).filter(isPerformer)) {
            docSel.appendChild(h('option', { value: String(u.id) },
                [u.full_name, u.specialty].filter(Boolean).join(' · ')));
        }
        // Лечащий врач — умолчание: чаще всего назначает и выполняет он.
        if (doctorId && (staff || []).some((u) => u.id === doctorId)) docSel.value = String(doctorId);

        paintGroups();
        paintList();
    })();

    paintCart();
    paintGroups();
    paintList();
    syncWhen();

    const body = h('div', { class: 'sof-grid' },
        h('div', { class: 'sof-col' },
            h('div', { class: 'sof-col-h' }, tr('Справочник услуг')),
            groupBox, searchInp, listBox),
        h('div', { class: 'sof-col' },
            h('div', { class: 'sof-col-h' }, tr('Назначаем')),
            cartBox, cartSum,
            h('div', { class: 'inp-form' },
                field(tr('Дата'), dateInp),
                field(tr('Время'), timeInp),
                h('div', { class: 'span2' }, field(tr('Исполнитель'), docSel)),
                h('label', { class: 'inp-check span2' }, nowChk, tr('Уже выполнено — начислить сейчас')),
                h('div', { class: 'span2' }, field(tr('Примечание'), noteInp)),
                h('div', { class: 'inp-hint' },
                    tr('Назначенное отсюда попадает в акт выполненных работ. В рабочий список лаборатории оно пока не встаёт — пробирку берут по направлению.')))));

    inpatientModal(tr(title), 'Plus', [patientAnchor(patientName, patientSub), body],
        tr('Назначить'), async () => {
            if (!cart.length) {
                toast(tr('Выберите услуги из справочника.'), 'fail');
                return false;
            }
            const args = { admission_id: admissionId, note: noteInp.value.trim() };
            if (docSel.value) args.doctor_id = Number(docSel.value);
            if (!nowChk.checked) {
                const date = dateInp.value || todayLocal();
                const time = timeInp.value || '09:00';
                // Местное время врача переводится в общее: сервер хранит время в
                // UTC, и запись «10:30» из Ташкента и из Москвы должна означать
                // разные минуты, а не одну.
                const when = new Date(date + 'T' + time + ':00');
                if (Number.isNaN(when.getTime())) { toast(tr('Проверьте дату и время.'), 'fail'); return false; }
                args.planned_at = when.toISOString();
            }
            // Строки уходят ПООЧЕРЁДНО, и отказ по одной не отменяет остальных:
            // сервер начисляет каждую своей записью, а «всё или ничего» здесь
            // означало бы отменять уже принятое из-за одной непринятой.
            const failed = [];
            let ok = 0;
            for (const row of [...cart]) {
                const { error } = await supabase.rpc('admission_service_add',
                    Object.assign({}, args, { service_id: row.service.id, quantity: row.qty }));
                if (error) failed.push({ row, msg: (row.service.name || '') + ': ' + (error.message || '') });
                else { ok += 1; cart.splice(cart.indexOf(row), 1); }
            }
            if (ok) toast(trf('Назначено услуг: {n}', { n: ok }), 'ok');
            if (failed.length) {
                // Непринятые строки остаются в окне — и на глазах: закрыть его
                // значило бы сказать «сделано» о том, чего не сделали.
                toast(failed[0].msg, 'fail');
                paintCart(); paintList();
                if (ok && onDone) await onDone();
                return false;
            }
            if (onDone) await onDone();
            return true;
        }, { width: 940 });
}
