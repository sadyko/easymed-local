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

/**
 * Что останавливает «Сохранить сотрудника» и уходят ли части имени.
 *
 * Решение владельца (2026-10-02):
 *   * НОВЫЙ сотрудник — Фамилия, Имя и Телефон обязательны, затем категория,
 *     затем логин и пароль (как прежде).
 *   * СУЩЕСТВУЮЩИЙ — карточка сохраняет то, что в ней правили. Фамилия и Имя
 *     обязательны, только если правили само ФИО (хоть одну из трёх частей) и
 *     оставили пустыми. Не трогали, а пусто (одно слово в full_name) — части
 *     имени просто НЕ отправляются: сервер оставит full_name прежним, а ставки,
 *     стационар, зарплата и прочее сохранятся. Телефон не обязателен.
 *     Категорию останавливает только та, которую стёрли сейчас: у `admin`
 *     первого запуска её не было никогда.
 *
 * @param {{ isEdit: boolean, now: object, was?: object }} a
 *   now — значения карточки сейчас; was — с какими она открылась (для правки)
 * @returns {{ refuse: null | { section: 'personal'|'job'|'access', keys: string[] }, sendNames: boolean }}
 */
export function employeeSaveGaps({ isEdit, now, was = {} }) {
    const changed = (k) => text(now[k]) !== text(was[k]);
    const nameGaps = ['last_name', 'first_name'].filter((k) => blank(now[k]));
    let personal, job, access;
    if (!isEdit) {
        personal = blank(now.phone) ? nameGaps.concat('phone') : nameGaps;
        job = blank(now.staff_type) ? ['staff_type'] : [];
        access = ['username', 'password'].filter((k) => blank(now[k]));
    } else {
        personal = NAME_KEYS.some(changed) ? nameGaps : [];
        job = blank(now.staff_type) && changed('staff_type') ? ['staff_type'] : [];
        access = blank(now.username) ? ['username'] : [];
    }
    const refuse = personal.length ? { section: 'personal', keys: personal }
        : job.length ? { section: 'job', keys: job }
            : access.length ? { section: 'access', keys: access } : null;
    return { refuse, sendNames: nameGaps.length === 0 };
}
