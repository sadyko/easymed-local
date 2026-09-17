// CALL_FROM_CRM_V1 (2026-09-17) — КНОПКА «ПОЗВОНИТЬ», ОДНА НА ВСЮ ПРОГРАММУ.
//
// Владелец: «can we build a telephone into a crm so using pbx or binotel we can
// make calls?»
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ КНОПКА В КАЖДОМ ЭКРАНЕ. Звонить нужно из заявки
// CRM, из карты пациента, из очереди и из обзвона после визита. Четыре копии
// кнопки — это четыре набора правил «кому можно», четыре разных вида и четыре
// способа показать отказ; расходиться они начнут в первый же месяц. Здесь одна
// кнопка и одно правило, а серверный разъём такой же один (telephony/dial.js).
//
// ЧТО ВИДИТ ОПЕРАТОР. Нажал — кнопка занята и подписана «Звоним…», через
// мгновение всплывает подсказка «сейчас зазвонит ваш телефон». Это не
// украшение: звонок начинается НЕ у пациента, а у самого оператора (так
// устроены и Binotel, и onlinePBX), и без этой строки человек ждёт гудков в
// компьютере и кладёт трубку раньше, чем станция успеет соединить.
//
// ОТКАЗЫ ПРИХОДЯТ ГОТОВОЙ ФРАЗОЙ С СЕРВЕРА (telephony/dial.js): «не указан
// внутренний номер», «телефония не подключена», «нет связи». Здесь их не
// переписывают — иначе одна и та же причина звучала бы по-разному на четырёх
// экранах.
import { h, Icon, toast } from './ui.js';
import { tr } from './i18n.js';
import { hasActorRole } from './permissions.js';
import { supabase } from '../supabase.js';

// Зеркало DIAL_ROLES из server/services/rpc/telephony.js. Список повторён, а не
// спрошен у сервера, по той же причине, что и у счёта в мастере записи: кнопка
// решается ДО первого запроса, и показывать её тому, кому сервер откажет, —
// это обещание, которое программа не сдержит. Разойтись они не могут молча:
// сервер всё равно проверяет своё.
const CALL_ROLES = ['admin', 'registrar', 'callcenter'];

/** Может ли этот сотрудник звонить из программы. */
export function canCall() {
    return hasActorRole(CALL_ROLES);
}

/**
 * Позвонить по номеру. Возвращает true, если станция приняла команду.
 * Номер приводить к виду не нужно — это делает сервер, один раз на всех.
 */
export async function placeCall(phone) {
    const { data, error } = await supabase.rpc('telephony_dial', { phone: String(phone || '') });
    if (error) {
        toast(error.message || tr('Телефония ответила ошибкой. Попробуйте ещё раз через минуту.'), 'fail');
        return false;
    }
    toast(tr('Сейчас зазвонит ваш телефон — снимите трубку'), 'ok');
    return !!(data && data.ok);
}

/**
 * Кнопка «Позвонить». Без номера или без права звонить не рисуется вовсе:
 * серая кнопка, которая всегда отказывает, — это не подсказка, а раздражение.
 *
 * @param {string} phone           номер пациента, как он лежит в карточке
 * @param {object} opts            {small, label, onDone}
 */
export function callButton(phone, { small = false, label = 'Позвонить', onDone = null } = {}) {
    const num = String(phone || '').replace(/\D+/g, '');
    if (!num || num.length < 7 || !canCall()) return null;

    // Подпись меняется В СВОЁМ span, а не через textContent всей кнопки: иначе
    // «Звоним…» стёрло бы значок вместе с подписью, и кнопка на секунду стала
    // бы другой кнопкой.
    const cap = h('span', null, label);
    const btn = h('button', {
        class: 'btn' + (small ? ' btn-sm' : ''), type: 'button',
        title: 'Позвонить пациенту из программы',
        onclick: async (ev) => {
            // Кнопка живёт внутри карточки, у которой свой обработчик нажатия:
            // без этого звонок ещё и открывал бы окно заявки.
            if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            cap.textContent = tr('Звоним…');
            try {
                const ok = await placeCall(phone);
                if (ok && typeof onDone === 'function') onDone();
            } finally {
                btn.disabled = false;
                cap.textContent = tr(label);
            }
        },
    }, Icon('Phone', { size: small ? 13 : 14 }), cap);
    return btn;
}
