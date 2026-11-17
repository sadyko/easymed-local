// WAIT_REG_V1 (3.25.0, 2026-11-17) — СТРОКУ ЗАПИСИ НЕ УБИРАЮТ МОЛЧА (вынуждающая функция окна визита).
//
// Владелец: «create a forcing function» — регистратор не должен «потерять» записанного или
// направленного пациента. Окно визита само ставит в смету строки записи на сегодня («из записи»),
// направления врача («от врача») и анализы заявки «на дату» («из заявки»). Убрать такую строку можно
// только с причиной (окно ниже, текст обязателен), и причина уходит в журнал визита
// (invoice_audit_log — тот же журнал, куда DUP_STOP_V1 пишет обход повтора):
//   • строка записи — снимается с визита той же дверью, что у календаря (booking_line_remove с
//     причиной: сервер пишет журнал в той же транзакции);
//   • анализ заявки «на дату» — визит дня берёт его сам (шаг связи CRM), поэтому окно снимает его
//     ПОСЛЕ ensure_visit той же дверью, с причиной; строка заявки возвращается в CRM без даты;
//   • направление врача остаётся в визите (его назначил врач — DOCTOR_REFERRAL_DESK_V1), а
//     причина «не оформлено» пишется в журнал визита.
// Добавлять услуги можно; повтор записанной или направленной услуги ловит прежний запрет
// DUP_STOP_V1 (visit_dup_check до записи, дверь /api/db — 409), второго правила здесь нет.
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';

/** Не короче — как у причины экстренной записи и повтора (BOOK_MIN_REASON, REPEAT_REASON_MIN). */
export const DROP_REASON_MIN = 3;
export const DROP_REASON_MAX = 500;

/**
 * Какая это строка сметы для вынуждающей функции: 'booked' — строка записи сегодня, 'doctor' —
 * направление врача на сегодня, 'wish' — строка заявки CRM на сегодня (анализ «на дату»); null —
 * обычная строка (её убирают без вопросов).
 * @param {object} c       строка сметы мастера ({ booked?, fromCrm?, crmLineId? })
 * @param {string} todayIso местный день 'YYYY-MM-DD'
 */
export function guardedKind(c, todayIso) {
    if (!c) return null;
    if (c.booked && c.booked.doctorOrder) return !c.booked.day || c.booked.day === todayIso ? 'doctor' : null;
    if (c.booked) return 'booked';
    if (c.fromCrm && c.crmLineId != null) return 'wish';
    return null;
}

/** Причина пригодна: строка не короче DROP_REASON_MIN знаков без пробелов по краям. */
export function dropReasonOk(v) {
    return typeof v === 'string' && v.trim().length >= DROP_REASON_MIN;
}

const TITLES = {
    booked: 'Убрать услугу из записи',
    doctor: 'Не оформлять направление врача',
    wish: 'Убрать услугу из заявки',
};

/**
 * Окно причины. Promise<string|null>: причина (обрезанная) или null — передумали.
 * @param {{kind:'booked'|'doctor'|'wish', name:string, referrer?:string}} what
 */
export function askDropReason({ kind, name, referrer = '' } = {}) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'modal', style: { zIndex: '190' }, 'data-dialog': 'booked-drop' });
        let done = false;
        const finish = (v) => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', onEsc); resolve(v); };
        const onEsc = (e) => { if (e.key === 'Escape') finish(null); };
        const why = kind === 'doctor'
            ? trf('Услугу «{name}» направил врач {doctor}. Укажите, почему её не оформляете: причина останется в журнале визита, направление останется у врача.', { name: name || '—', doctor: referrer || '—' })
            : kind === 'wish'
                ? trf('Услуга «{name}» записана колл-центром на сегодня. Укажите, почему её убираете: причина останется в журнале визита, а услуга вернётся в заявку без даты.', { name: name || '—' })
                : trf('Пациента записали на услугу «{name}». Укажите, почему её убираете: причина останется в журнале визита, а услуга будет снята с записи.', { name: name || '—' });
        const reason = h('textarea', { class: 'rcal-reason', rows: '3', maxlength: String(DROP_REASON_MAX), 'data-drop-reason': '',
            placeholder: tr('Например: пациент отказался от услуги') });
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => finish(null) }));
        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Warning', { size: 16 }), ' ', tr(TITLES[kind] || TITLES.booked)),
                h('button', { class: 'modal-close', type: 'button', onclick: () => finish(null) }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { class: 'rcal-conflict', style: { whiteSpace: 'pre-line' } }, why),
                h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '12px 0 6px' } }, tr('Причина')),
                reason),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-outline', type: 'button', 'data-drop-cancel': '', onclick: () => finish(null) }, tr('Оставить услугу')),
                h('button', {
                    class: 'btn btn-primary', type: 'button', 'data-drop-confirm': '', onclick: () => {
                        const text = String(reason.value || '').trim();
                        if (!dropReasonOk(text)) { toast(tr('Укажите причину — без неё услугу из записи не убрать.'), 'fail'); return; }
                        finish(text.slice(0, DROP_REASON_MAX));
                    },
                }, tr('Убрать с причиной')))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
        try { reason.focus(); } catch (_) { /* без фокуса — не беда */ }
    });
}
