// WAIT_REG_V1 (3.25.0, 2026-11-17) — СТРОКУ ЗАПИСИ НЕ УБИРАЮТ МОЛЧА (вынуждающая функция окна визита
// и быстрой регистрации).
//
// Владелец: «create a forcing function» — регистратор не должен «потерять» записанного или
// направленного пациента. Окно визита само ставит в смету строки записи на сегодня («из записи»),
// направления врача («от врача») и анализы заявки на сегодня или «когда придёт» («из заявки»); быстрая
// регистрация — строки записи и направления. Убрать такую строку можно только с причиной (окно ниже,
// текст обязателен), и причину пишет сервер в журнал визита (invoice_audit_log) той же транзакцией,
// что и само действие (ревью L1, L4):
//   • строка записи — снимается с визита той же дверью, что у календаря (booking_line_remove с
//     причиной и registration: true — без причины сервер окну регистрации отказывает, ревью M3);
//   • анализ заявки — сервер отпускает его в заявку без даты ДО ensure_visit (crm_wish_release),
//     визит дня его больше не берёт (ревью H1);
//   • направление врача остаётся в визите (его назначил врач — DOCTOR_REFERRAL_DESK_V1), а причина
//     «не оформлено» пишется с номером строки визита (referral_line_skip) — и «Ждут регистрации»
//     больше не держит пациента ради неё (решение владельца, ревью M2).
// Добавлять услуги можно; повтор записанной или направленной услуги ловит прежний запрет
// DUP_STOP_V1 (visit_dup_check до записи, дверь /api/db — 409), второго правила здесь нет.
//
// WAIT_REG_V1 (ревью L3) — ЖЕЛАНИЕ «КОГДА ПРИДЁТ» (строка заявки без даты, её отдаёт смете crm_day_lines)
// — тоже в остановке: визит дня взял бы его сам (ensure_visit берёт строки без даты), и убранная молча
// строка вернулась бы в визит без счёта. Но это не «записано на сегодня»: окно говорит, что услуга
// ждёт в заявке без даты и сама в визит больше не встанет.
//
// WAIT_REG_V1 (ревью M1, L5) — ОКНО ПРИЧИНЫ — НАСТОЯЩИЙ ДИАЛОГ: role="dialog", aria-modal, заголовок и
// пояснение по aria-labelledby / aria-describedby, «Причина» — <label> поля, фокус заперт в окне и
// возвращается туда, где был. Escape закрывает ТОЛЬКО это окно: он ловится на погружении и дальше не
// идёт (окно визита и быстрая регистрация слушают Escape на document и закрылись бы целиком).
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';

/** Не короче — как у причины экстренной записи и повтора (BOOK_MIN_REASON, REPEAT_REASON_MIN). */
export const DROP_REASON_MIN = 3;
export const DROP_REASON_MAX = 500;

/**
 * Какая это строка сметы для вынуждающей функции: 'booked' — строка записи сегодня, 'doctor' —
 * направление врача на сегодня, 'wish' — строка заявки CRM на сегодня или без даты; null —
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

/** Строка заявки без даты («когда придёт») — ревью L3. */
export function wishUndated(c) {
    return !!(c && c.fromCrm && c.crmLineId != null && !String(c.crmDay || '').trim());
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

/** Текст пояснения окна (переводится здесь же). */
export function dropReasonText({ kind, name = '', referrer = '', undated = false } = {}) {
    const n = name || '—';
    if (kind === 'doctor') return trf('Услугу «{name}» направил врач {doctor}. Укажите, почему её не оформляете: причина останется в журнале визита, направление останется у врача.', { name: n, doctor: referrer || '—' });
    if (kind === 'wish' && undated) return trf('Услуга «{name}» ждёт в заявке колл-центра без даты — визит взял бы её сам. Укажите, почему её убираете: причина останется в журнале, а услуга останется в заявке и сама в визит больше не встанет.', { name: n });
    if (kind === 'wish') return trf('Услуга «{name}» записана колл-центром на сегодня. Укажите, почему её убираете: причина останется в журнале визита, а услуга вернётся в заявку без даты.', { name: n });
    return trf('Пациента записали на услугу «{name}». Укажите, почему её убираете: причина останется в журнале визита, а услуга будет снята с записи.', { name: n });
}

let _seq = 0;
const FOCUSABLE = (n) => n && ['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'A'].includes(String(n.tagName || '').toUpperCase()) && !n.disabled;

/**
 * Окно причины. Promise<string|null>: причина (обрезанная) или null — передумали.
 * @param {{kind:'booked'|'doctor'|'wish', name:string, referrer?:string, undated?:boolean}} what
 */
export function askDropReason({ kind, name, referrer = '', undated = false } = {}) {
    return new Promise((resolve) => {
        const id = 'bdrop-' + (++_seq);
        const back = typeof document !== 'undefined' ? document.activeElement : null;   // ревью L5 — куда вернуть фокус
        const overlay = h('div', { class: 'modal', style: { zIndex: '190' }, 'data-dialog': 'booked-drop' });
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            try { if (back && typeof back.focus === 'function' && back.isConnected !== false) back.focus(); } catch (_) { /* фокус вернуть некуда */ }
            resolve(v);
        };
        const reason = h('textarea', { class: 'rcal-reason', id: id + '-reason', rows: '3', maxlength: String(DROP_REASON_MAX), 'data-drop-reason': '',
            'aria-required': 'true', placeholder: tr('Например: пациент отказался от услуги') });
        const cancelBtn = h('button', { class: 'btn btn-outline', type: 'button', 'data-drop-cancel': '', onclick: () => finish(null) }, tr('Оставить услугу'));
        const confirmBtn = h('button', {
            class: 'btn btn-primary', type: 'button', 'data-drop-confirm': '', onclick: () => {
                const text = String(reason.value || '').trim();
                if (!dropReasonOk(text)) { toast(tr('Укажите причину — без неё услугу из записи не убрать.'), 'fail'); try { reason.focus(); } catch (_) { /* без фокуса */ } return; }
                finish(text.slice(0, DROP_REASON_MAX));
            },
        }, tr('Убрать с причиной'));
        const closeBtn = h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Закрыть', onclick: () => finish(null) }, '×');
        const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title', 'aria-describedby': id + '-why',
            style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', { id: id + '-title' }, Icon('Warning', { size: 16 }), ' ', tr(TITLES[kind] || TITLES.booked)),
                closeBtn),
            h('div', { class: 'modal-body' },
                h('div', { class: 'rcal-conflict', id: id + '-why', style: { whiteSpace: 'pre-line' } }, dropReasonText({ kind, name, referrer, undated })),
                h('label', { for: id + '-reason', class: 'muted', style: { display: 'block', fontSize: '12.5px', margin: '12px 0 6px' } }, tr('Причина')),
                reason),
            h('footer', { class: 'modal-foot' }, h('span', { class: 'grow' }), cancelBtn, confirmBtn));
        // Ревью M1 — Escape только этому окну; ревью L5 — Tab не уходит из окна.
        const onKey = (e) => {
            if (!e) return;
            if (e.key === 'Escape') {
                if (typeof e.preventDefault === 'function') e.preventDefault();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                if (typeof e.stopPropagation === 'function') e.stopPropagation();
                finish(null);
                return;
            }
            if (e.key === 'Tab') {
                const ring = [closeBtn, reason, cancelBtn, confirmBtn].filter(FOCUSABLE);
                if (!ring.length) return;
                const at = ring.indexOf(document.activeElement);
                const next = e.shiftKey ? (at <= 0 ? ring[ring.length - 1] : ring[at - 1]) : (at === -1 || at === ring.length - 1 ? ring[0] : ring[at + 1]);
                if (typeof e.preventDefault === 'function') e.preventDefault();
                try { next.focus(); } catch (_) { /* без фокуса */ }
            }
        };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => finish(null) }));
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey, true);
        try { reason.focus(); } catch (_) { /* без фокуса — не беда */ }
    });
}
