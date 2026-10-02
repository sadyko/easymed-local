// EMPLOYEE_CARD_SAVE_V1 (2026-10-02) — ИМЯ СОТРУДНИКА ИЗ full_name И ТО, ЧТО
// ДЕРЖИТ «СОХРАНИТЬ СОТРУДНИКА».
//
// Владелец: «in the doctors, the actual name and surname and other information
// not saving, also the shares to the services, referrals, and also the
// stationary services are not saving when edited».
//
// Причина была одна. Карточка (views/employees.js) читала только last_name /
// first_name, а у сотрудников, заведённых одной строкой full_name (демо-врачи
// scripts/seed-demo-hospital.mjs, `admin` первого запуска), эти поля пусты. И
// save() отказывал ВСЕЙ карточке, пока не заполнены Фамилия, Имя и Телефон, —
// даже когда менялись одни ставки: тост «Заполните личные данные.» гас через
// 2,4 с, и ни один запрос не уходил. На базе разработки так стояла 21
// карточка из 45.
//
// Модуль общий: им разбирают имя обе карточки сотрудника (employees.js и старая
// employee-editor.js), а серверная проверка (routes/users.test.js) — что
// разобранное возвращается тем же full_name.

/** Три части имени, которые карточка отправляет или не отправляет вместе. */
export const NAME_KEYS = ['last_name', 'first_name', 'middle_name'];

const text = (v) => String(v === null || v === undefined ? '' : v).trim();
const blank = (v) => text(v) === '';

/**
 * «Фамилия Имя Отчество» одной строкой → части.
 *
 * Порядок тот же, в котором сервер собирает full_name из частей
 * (routes/users.js deriveFullName): первое слово — фамилия, второе — имя, всё
 * остальное — отчество (узбекское «Akmal o'g'li» — два слова). Одно слово —
 * фамилия: имя не выдумывается. Лишние пробелы словами не считаются.
 *
 * @param {string} full
 * @returns {{ last_name: string, first_name: string, middle_name: string }}
 */
export function splitFullName(full) {
    const parts = text(full).split(/\s+/).filter(Boolean);
    return { last_name: parts[0] || '', first_name: parts[1] || '', middle_name: parts.slice(2).join(' ') };
}

/**
 * Части имени для карточки: свои колонки (миграция 026), а если пусты И
 * фамилия, И имя — разобранный full_name. Есть хотя бы одно из двух — колонки
 * показываются как есть: значит, их уже правили, и угадывать поверх нельзя.
 *
 * @param {{ last_name?: string, first_name?: string, middle_name?: string, full_name?: string }} row
 */
export function employeeNameParts(row) {
    const r = row || {};
    if (blank(r.last_name) && blank(r.first_name) && !blank(r.full_name)) return splitFullName(r.full_name);
    return { last_name: r.last_name || '', first_name: r.first_name || '', middle_name: r.middle_name || '' };
}

// Часть имени так, как её запишет сервер (routes/users.js parseEmployeeFields:
// String(v).slice(0, 120).trim()).
const serverPart = (v) => String(v === null || v === undefined ? '' : v).slice(0, 120).trim();

/**
 * full_name, который сервер соберёт из присланных частей (routes/users.js:
 * parseEmployeeFields режет часть до 120 знаков и обрезает пробелы по краям,
 * deriveFullName склеивает непустые через один пробел).
 */
export function serverFullName(parts) {
    const p = parts || {};
    return NAME_KEYS.map((k) => serverPart(p[k])).filter(Boolean).join(' ');
}

/**
 * Ревью EMPLOYEE_CARD_SAVE_V1 — можно ли отправить НЕТРОНУТЫЕ части имени, ничего
 * не изменив. Сервер пересобирает full_name из присланных частей: двойной,
 * неразрывный, крайний пробел или табуляция схлопнулись бы, часть длиннее 120
 * знаков обрезалась бы, а разобранная строка без отчества стёрла бы отчество из
 * его колонки. Поэтому — только если full_name вернётся ПОБАЙТНО тем же и ни одна
 * заполненная колонка не перепишется другим значением. Иначе части не уходят, и
 * имя остаётся как лежит.
 *
 * @param {{ full_name?: string, last_name?: string, first_name?: string, middle_name?: string }} stored строка сотрудника, как её прислал сервер
 * @param {{ last_name?: string, first_name?: string, middle_name?: string }} parts что карточка отправила бы
 */
export function namesRoundTrip(stored, parts) {
    const s = stored || {};
    if (serverFullName(parts) !== String(s.full_name === null || s.full_name === undefined ? '' : s.full_name)) return false;
    return NAME_KEYS.every((k) => blank(s[k]) || serverPart(s[k]) === serverPart((parts || {})[k]));
}

/**
 * Что останавливает «Сохранить сотрудника» и уходят ли части имени.
 *
 * Решение владельца (2026-10-02):
 *   * НОВЫЙ сотрудник — Фамилия, Имя и Телефон обязательны, затем категория,
 *     затем логин и пароль (как прежде).
 *   * СУЩЕСТВУЮЩИЙ — карточка сохраняет то, что в ней правили. Фамилия и Имя
 *     обязательны, только если правили само ФИО (хоть одну из трёх частей) и
 *     оставили пустыми. ФИО не трогали — части имени уходят, только если сервер
 *     соберёт из них побайтно тот же full_name (namesRoundTrip); иначе — и когда
 *     имени нет (одно слово в full_name) — НЕ отправляются: full_name остаётся
 *     прежним, а ставки, стационар, зарплата и прочее сохраняются.
 *     Телефон и категория держат сохранение, только если их стёрли сейчас
 *     (ревью: стёртый телефон уходил пустым, а стёртая категория — нет). Пустые
 *     с самого начала — не держат: у демо-врачей и `admin` первого запуска их
 *     не было никогда.
 *
 * @param {{ isEdit: boolean, now: object, was?: object, stored?: object }} a
 *   now — значения карточки сейчас; was — с какими она открылась (для правки);
 *   stored — строка сотрудника с сервера (full_name и колонки имени)
 * @returns {{ refuse: null | { section: 'personal'|'job'|'access', keys: string[] }, sendNames: boolean }}
 */
export function employeeSaveGaps({ isEdit, now, was = {}, stored = {} }) {
    const changed = (k) => text(now[k]) !== text(was[k]);
    const cleared = (k) => blank(now[k]) && !blank(was[k]);   // было заполнено — стёрли сейчас
    const nameGaps = ['last_name', 'first_name'].filter((k) => blank(now[k]));
    const namesEdited = NAME_KEYS.some(changed);
    let personal, job, access;
    if (!isEdit) {
        personal = blank(now.phone) ? nameGaps.concat('phone') : nameGaps;
        job = blank(now.staff_type) ? ['staff_type'] : [];
        access = ['username', 'password'].filter((k) => blank(now[k]));
    } else {
        personal = (namesEdited ? nameGaps : []).concat(cleared('phone') ? ['phone'] : []);
        job = cleared('staff_type') ? ['staff_type'] : [];
        access = blank(now.username) ? ['username'] : [];
    }
    const refuse = personal.length ? { section: 'personal', keys: personal }
        : job.length ? { section: 'job', keys: job }
            : access.length ? { section: 'access', keys: access } : null;
    const sendNames = nameGaps.length === 0 && (!isEdit || namesEdited || namesRoundTrip(stored, now));
    return { refuse, sendNames };
}
