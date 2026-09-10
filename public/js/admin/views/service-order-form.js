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
// УСЛУГА ВЫБИРАЕТСЯ ИЗ СПРАВОЧНИКА, а не пишется словами: цену, название,
// раздел и кабинет знает он. Окно справочника — то же самое, что у направлений
// из кабинета врача (openServicePickerModal), просто ограниченное разделами.
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { inpatientModal, patientAnchor } from './admission-modal.js?v=inp5';

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
    const picked = { service: null, doctor: null };

    const svcBox = h('div', { class: 'sof-pick' });
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

    const paintPick = () => {
        clear(svcBox);
        if (!picked.service) {
            svcBox.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px' } },
                tr('Услуга не выбрана')));
        } else {
            svcBox.appendChild(h('div', { class: 'sof-pick-t' }, picked.service.name || ''));
            svcBox.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                [money(picked.service.price) + ' ' + tr('сум'),
                    picked.doctor ? picked.doctor.full_name : null].filter(Boolean).join(' · ')));
        }
        svcBox.appendChild(h('span', { class: 'grow' }));
        svcBox.appendChild(h('button', {
            class: 'btn btn-sm' + (picked.service ? ' btn-outline' : ' btn-primary'), type: 'button',
            onclick: choose,
        }, Icon('Search', { size: 13 }), ' ', tr(picked.service ? 'Изменить' : 'Выбрать услугу')));
    };

    // Справочник открывается ПОВЕРХ этого окна: выбор услуги — шаг назначения,
    // а не отдельное дело, и терять уже введённое время ради него незачем.
    async function choose() {
        const { openServicePickerModal } = await import('./service-picker-modal.js?v=aug17e');
        openServicePickerModal({
            title: tr(title),
            confirmLabel: tr('Выбрать'),
            allowedTypeNames: typeNames,
            onPick: ({ service, doctor }) => {
                if (!service) return;
                picked.service = service;
                picked.doctor = doctor || null;
                paintPick();
            },
        });
    }
    paintPick();
    syncWhen();

    inpatientModal(tr(title), 'Plus', [
        patientAnchor(patientName, patientSub),
        field(tr('Услуга'), svcBox, { required: true }),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 150px' } }, field(tr('Дата'), dateInp)),
            h('div', { style: { flex: '1 1 120px' } }, field(tr('Время'), timeInp)),
            h('div', { style: { flex: '1 1 100px' } }, field(tr('Количество'), qtyInp))),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13.5px' } },
            nowChk, tr('Уже выполнено — начислить сейчас')),
        field(tr('Примечание'), noteInp),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Назначенное отсюда попадает в акт выполненных работ. В рабочий список лаборатории оно пока не встаёт — пробирку берут по направлению.')),
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
        if (picked.doctor && picked.doctor.id) args.doctor_id = picked.doctor.id;
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
