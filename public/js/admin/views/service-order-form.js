// SERVICE_ORDER_FORM_V1 (2026-09-10) — НАЗНАЧИТЬ УСЛУГУ ГОСПИТАЛИЗАЦИИ.
//
// Владелец: «we need to make dialogue window in the services like in the
// prescriptions, select time and date etc».
//
// Раньше «+ Анализы и диагностика» открывали прямо справочник услуг: выбрал —
// начислено сию секунду. Для расходника это верно (его списали со склада и
// точка), а для КТ на завтра на 10:30 — нет: назначение это ещё и ВРЕМЯ, и без
// него ни кабинет не подготовить, ни список на день не собрать.
//
// Окно устроено как «Новое назначение» (mar-sheet.js, openOrderForm) — тот же
// каркас inpatientModal, тот же якорь пациента, те же поля-подписи. Это не
// подражание ради вида: врач заводит и то и другое подряд, и две разные формы
// для одного действия «назначить» он читает как две разные системы.
//
// УСЛУГА ВЫБИРАЕТСЯ ИЗ СПРАВОЧНИКА, а не пишется словами: цену, название и
// раздел знает он. Но справочник открывается ЗДЕСЬ ЖЕ, строкой поиска, а не
// вторым окном: полноэкранное окно подбора услуг поверх маленькой формы — это,
// дословно, «dialogue window is tooo big».
//
// Раздел услуги определяет ТА ЖЕ общая функция (resolveTypeId), что и большое
// окно подбора: второй способ отнести услугу к разделу разошёлся бы с первым
// молча — ровно тем, что одна и та же услуга попадала бы в разные разделы в
// зависимости от того, откуда её ищут.
import { h, clear, toast, field } from '../ui.js';
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
 * ОКНО «НАЗНАЧИТЬ УСЛУГУ».
 *
 * @param {object} opts
 * @param {number} opts.admissionId    госпитализация
 * @param {string} opts.title          «Анализы и диагностика» / «Операция»
 * @param {string[]} opts.typeNames    разделы справочника, из которых выбирают
 * @param {string} opts.patientName    для якоря пациента
 * @param {string} opts.patientSub     палата, койка, номер карты
 * @param {Function} opts.onDone       перерисовать вкладку после назначения
 */
export function openServiceOrderForm({
    admissionId, title = 'Назначить услугу', typeNames = null,
    patientName = '', patientSub = '', onDone = null,
} = {}) {
    if (!admissionId) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }

    // Что выбрано в справочнике. Держится здесь, а не в полях ввода: цена и
    // раздел приходят вместе с услугой и правке с клавиатуры не подлежат.
    const picked = { service: null };

    const svcBox = h('div', { class: 'sof-pick' });
    const searchInp = h('input', { type: 'search', placeholder: 'Поиск по названию услуги' });
    const listBox = h('div', { class: 'sof-list' });
    const pickBox = h('div', { class: 'sof-catalog' }, svcBox, searchInp, listBox);
    const dateInp = h('input', { type: 'date', value: todayLocal() });
    const timeInp = h('input', { type: 'time', value: nextHalfHour() });
    const qtyInp = h('input', { type: 'number', min: '1', step: '1', value: '1' });
    const noteInp = h('input', { type: 'text', placeholder: tr('Например: натощак') });
    const nowChk = h('input', { type: 'checkbox' });

    const syncWhen = () => {
        const now = nowChk.checked;
        dateInp.disabled = now;
        timeInp.disabled = now;
    };
    nowChk.addEventListener('change', syncWhen);

    // Справочник этих разделов — загружается один раз и ищется на месте.
    const cat = { services: [], types: [], loaded: false };

    const paintPick = () => {
        clear(svcBox);
        if (!picked.service) {
            svcBox.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px' } },
                tr('Услуга не выбрана')));
        } else {
            svcBox.appendChild(h('div', { class: 'sof-pick-t' }, picked.service.name || ''));
            svcBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                money(picked.service.price) + ' ' + tr('сум')));
            svcBox.appendChild(h('span', { class: 'grow' }));
            svcBox.appendChild(h('button', {
                class: 'btn btn-sm btn-outline', type: 'button',
                onclick: () => { picked.service = null; paintPick(); paintList(); },
            }, tr('Изменить')));
        }
        // Пока услуга выбрана, поиск не нужен и только занимает место — а окно
        // и упрекнули как раз в величине.
        const hide = !!picked.service;
        searchInp.hidden = hide;
        listBox.hidden = hide;
    };

    const paintList = () => {
        clear(listBox);
        if (!cat.loaded) {
            listBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Загружаем справочник…')));
            return;
        }
        const q = String(searchInp.value || '').trim().toLowerCase();
        const rows = cat.services.filter((x) => !q || String(x.name || '').toLowerCase().includes(q));
        if (!rows.length) {
            listBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Ничего не найдено — измените запрос.')));
            return;
        }
        // Сорок строк — потолок списка, а не справочника: дальше ищут словом.
        for (const svc of rows.slice(0, 40)) {
            listBox.appendChild(h('button', {
                class: 'sof-row', type: 'button',
                onclick: () => { picked.service = svc; paintPick(); },
            },
                h('span', { class: 'sof-row-n' }, svc.name || '—'),
                h('span', { class: 'sof-row-p' }, money(svc.price))));
        }
        if (rows.length > 40) {
            listBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                trf('Показаны первые 40 из {n} — уточните запрос.', { n: rows.length })));
        }
    };
    searchInp.addEventListener('input', paintList);

    (async () => {
        const [{ data: services }, { data: types }] = await Promise.all([
            supabase.from('services').select('id, name, price, type, type_id, is_lab')
                .eq('active', true).order('name'),
            supabase.from('service_types').select('id, name').eq('active', true).order('name'),
        ]);
        cat.types = types || [];
        const needles = (typeNames || []).map((x) => String(x).toLowerCase());
        const keep = needles.length
            ? cat.types.filter((t) => needles.some((n) => String(t.name || '').toLowerCase().includes(n)))
            : [];
        const allowed = keep.length ? new Set(keep.map((t) => String(t.id))) : null;
        const all = services || [];
        const only = allowed ? all.filter((x) => allowed.has(String(resolveTypeId(x, cat.types) || ''))) : all;
        // ПУСТОЙ СПИСОК ХУЖЕ ЛИШНЕЙ УСЛУГИ: если в этих разделах у клиники
        // ничего не заведено (операции сплошь и рядом лежат в «Процедурах»),
        // показывается весь справочник — то же правило, что и в большом окне.
        cat.services = only.length ? only : all;
        cat.loaded = true;
        paintList();
    })();

    paintPick();
    paintList();
    syncWhen();

    inpatientModal(tr(title), 'Plus', [
        patientAnchor(patientName, patientSub),
        // INP_FORM_GRID_V1 — та же сетка полей, что у «Нового назначения»: два
        // окна одного действия, набранные по-разному, читаются как две системы.
        h('div', { class: 'inp-form' },
            h('div', { class: 'span2' }, field(tr('Услуга'), pickBox, { required: true })),
            field(tr('Дата'), dateInp),
            field(tr('Время'), timeInp),
            field(tr('Количество'), qtyInp),
            h('label', { class: 'inp-check' }, nowChk, tr('Уже выполнено — начислить сейчас')),
            h('div', { class: 'span2' }, field(tr('Примечание'), noteInp)),
            h('div', { class: 'inp-hint' },
                tr('Назначенное отсюда попадает в акт выполненных работ. В рабочий список лаборатории оно пока не встаёт — пробирку берут по направлению.'))),
    ], tr('Назначить'), async () => {
        if (!picked.service || !picked.service.id) {
            toast(tr('Выберите услугу из справочника.'), 'fail');
            return false;
        }
        const args = {
            admission_id: admissionId,
            service_id: picked.service.id,
            quantity: Number(qtyInp.value) || 1,
            note: noteInp.value.trim(),
        };
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
        const { error } = await supabase.rpc('admission_service_add', args);
        if (error) { toast(error.message || tr('Не удалось назначить услугу.'), 'fail'); return false; }
        toast(trf('Назначено: {name}', { name: picked.service.name || '' }), 'ok');
        if (onDone) await onDone();
        return true;
    });
}
