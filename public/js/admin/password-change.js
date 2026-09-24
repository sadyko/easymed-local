// PASSWORD_CHANGE_V2 (2026-09-23) — смена пароля: одно окно на два входа.
//
// Владелец: «check for admin password changing — we cannot change» и «give
// permission to 1 or 2 character passwords». Сервер пароль из одного символа
// принимал давно (PASSWORD_CLINIC_RULE_V1, server/services/auth.js
// validPassword), а экраны не догнали его:
//   * «Сменить пароль» в меню аватара звал supabase.auth.updateUser, который
//     офлайн-прослойка (db-auth.js) отвергает ВСЕГДА, — пароль не менялся ни у
//     кого, и окно к тому же требовало 8 символов;
//   * в карточке сотрудника пароль уходил только вместе со всей карточкой, а её
//     сохранение требует ФИО, телефон и категорию — у учётной записи первого
//     запуска `admin` нет ничего из этого.
//
// Отсюда два входа в одно окно:
//   * openChangeOwnPasswordModal() — свой пароль: текущий + новый + повтор,
//     POST /api/auth/change-password. Текущий спрашивается потому, что его
//     требует сервер (changeOwnPassword): оставленный открытым компьютер
//     клиники не должен давать прохожему переписать чужой пароль.
//   * openEmployeePasswordModal(user) — пароль сотрудника из его карточки:
//     новый + повтор, PATCH /api/users/:id c ОДНИМ полем { password } — и
//     поэтому не зависит от того, что ещё в карточке не заполнено.
//
// PASSWORD_RULE_ONE_PLACE_V1 — правило длины на клиенте одно и живёт здесь:
// пароль не пустой, и всё. Верхнюю границу (72 байта bcrypt) держит сервер и
// отвечает weak_password — это окно переводит ответ в слова.

import { h, Icon, toast } from './ui.js';
import { tr, trf } from './i18n.js';

/** Самый короткий допустимый пароль — решение владельца. */
export const MIN_PASSWORD_LENGTH = 1;

/**
 * Что не так с введённым, ещё до запроса. null — можно отправлять.
 * Пробел — тоже символ: сервер принимает и его, и экран не строже сервера.
 */
export function passwordProblem(next, repeat, { askCurrent = false, current = '' } = {}) {
    if (askCurrent && !String(current ?? '').length) return 'Введите текущий пароль.';
    if (String(next ?? '').length < MIN_PASSWORD_LENGTH) return 'Введите новый пароль.';
    if (next !== repeat) return 'Пароль не совпадает.';
    return null;
}

/** Ответ сервера → слова для человека. Коды — server/routes/auth.js и users.js. */
export function describePasswordError(status, code, message) {
    if (code === 'invalid_credentials') return 'Текущий пароль неверный.';
    if (code === 'weak_password' || status === 400) return 'Пароль не может быть пустым — и не длиннее 72 латинских букв.';
    if (status === 409) return 'Эту учётную запись ведёт главная клиника — пароль меняют там: вход один во всех зданиях.';
    if (status === 429) return 'Слишком много попыток. Попробуйте через несколько минут.';
    if (status === 401) return 'Сессия закончилась — войдите заново.';
    if (status === 403) return 'Недостаточно прав, чтобы сменить этот пароль.';
    return trf('Не удалось сменить пароль: {msg}', { msg: message || ('HTTP ' + status) });
}

// Не через api.js: тот на любой 401 уводит на страницу входа, а 401 здесь —
// это «текущий пароль неверный», который надо ПОКАЗАТЬ, а не выкинуть человека.
async function send(url, method, body) {
    let res;
    try {
        res = await fetch(url, {
            method, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        return { error: 'Нет связи с сервером.' };
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true };
    const err = (json && json.error) || {};
    return { error: describePasswordError(res.status, err.code, err.message) };
}

/** Свой пароль. Сервер сам сверяет текущий. */
export function changeOwnPassword(current, next) {
    return send('/api/auth/change-password', 'POST', { current_password: current, new_password: next });
}

/** Пароль сотрудника — ТОЛЬКО пароль: остальная карточка не трогается. */
export function setEmployeePassword(userId, next) {
    return send('/api/users/' + encodeURIComponent(userId), 'PATCH', { password: next });
}

const INPUT_STYLE = {
    width: '100%', height: '38px', padding: '0 12px', boxSizing: 'border-box',
    border: '1px solid var(--ink-200)', borderRadius: '9px',
    fontSize: '13.5px', fontFamily: 'inherit', outline: 'none',
};

function labelled(text, input) {
    return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px', color: 'var(--ink-600)' } },
        text, input);
}

/**
 * Окно смены пароля. `askCurrent` — спросить текущий; `submit(current, next)`
 * возвращает { ok } или { error: слова }.
 */
function openPasswordModal({ note, askCurrent, submit, done }) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '9000' } });
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const errEl = h('div', { role: 'alert', style: { color: 'var(--crit-700)', fontSize: '12.5px', minHeight: '16px' } });
    const curInp  = askCurrent ? h('input', { type: 'password', autocomplete: 'current-password', style: INPUT_STYLE }) : null;
    const passInp  = h('input', { type: 'password', autocomplete: 'new-password', style: INPUT_STYLE });
    const pass2Inp = h('input', { type: 'password', autocomplete: 'new-password', style: INPUT_STYLE });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', style: { minWidth: '120px', justifyContent: 'center' } }, 'Сохранить');
    const run = async () => {
        errEl.textContent = '';
        const current = curInp ? curInp.value : '';
        const problem = passwordProblem(passInp.value, pass2Inp.value, { askCurrent, current });
        if (problem) {
            errEl.textContent = tr(problem);
            (problem === 'Введите текущий пароль.' ? curInp : problem === 'Пароль не совпадает.' ? pass2Inp : passInp).focus();
            return;
        }
        saveBtn.disabled = true;
        try {
            const res = await submit(current, passInp.value);
            if (res.error) { errEl.textContent = tr(res.error); return; }
            close();
            toast(done, 'ok');
        } finally {
            saveBtn.disabled = false;
        }
    };
    saveBtn.addEventListener('click', run);
    for (const inp of [curInp, passInp, pass2Inp]) {
        if (inp) inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); run(); } });
    }

    const card = h('div', { class: 'modal-card', style: { width: '380px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Lock', { size: 16 }), ' Сменить пароль'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, note),
            curInp ? labelled('Текущий пароль', curInp) : null,
            labelled('Новый пароль', passInp),
            labelled('Повторите новый пароль', pass2Inp),
            errEl,
        ),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            saveBtn,
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => (curInp || passInp).focus(), 0);
    return overlay;
}

/** Меню аватара → «Сменить пароль». Для любой роли. */
export function openChangeOwnPasswordModal() {
    return openPasswordModal({
        askCurrent: true,
        note: 'Пароль — любой, хоть из одного символа. На других компьютерах с этой учётной записью придётся войти заново.',
        submit: (current, next) => changeOwnPassword(current, next),
        done: 'Пароль изменён.',
    });
}

/** Карточка сотрудника → «Сменить пароль». Не требует ни ФИО, ни телефона. */
export function openEmployeePasswordModal(user) {
    return openPasswordModal({
        askCurrent: false,
        note: 'Пароль — любой, хоть из одного символа. Остальная карточка не меняется; открытые входы сотрудника на других компьютерах закроются.',
        submit: (_current, next) => setEmployeePassword(user.id, next),
        done: 'Пароль сотрудника изменён.',
    });
}
