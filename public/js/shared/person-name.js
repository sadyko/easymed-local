// PERSON_NAME_SHORT_V1 (2026-09-09) — ФАМИЛИЯ С ИНИЦИАЛАМИ ДЛЯ ШАПКИ ДОКУМЕНТА.
//
// Владелец: «what if surname and name is too long? can we use itinials and
// surname even if surname is too big? because i don't want any fields to go
// into a next paragraph».
//
// Полное имя в шапке — главная причина, по которой полоса реквизитов
// разъезжалась на две строки: «Абдурахмонова Гулнора Шухратовна» шире четверти
// листа A4, и соседняя ячейка уезжала вниз. Фамилия с инициалами короче втрое и
// при этом называет человека однозначно: в бумаге, где рядом стоят ID, дата
// рождения и номер истории, отчество ничего не различает.
//
// Полное имя никуда не девается: оно печатается В ТЕЛЕ документа, где на него
// есть строка во всю ширину, и остаётся в подсказке ячейки.
//
// Модуль общий (shared): так называют человека и экран, и печать, и если бы
// правило жило в одном из них, второй однажды сократил бы иначе.

/**
 * «Фамилия И. О.» из полного имени.
 *
 * Что здесь считается фамилией: ПЕРВОЕ слово. В базе имя лежит одной строкой в
 * порядке «фамилия имя отчество» — так его вводит регистратура и так печатают
 * все бланки. Двойная фамилия через дефис остаётся целой: дефис не пробел.
 *
 * Одно слово возвращается как есть — это не ошибка ввода, а имя без отчества
 * (иностранец, ребёнок без документов), и превращать его в «И.» значило бы
 * стереть единственное, что известно.
 *
 * @param {string} full имя целиком
 * @returns {string} «Иванов И. И.» либо исходная строка, если сокращать нечего
 */
export function shortName(full) {
    const parts = String(full === null || full === undefined ? '' : full)
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    const initials = parts.slice(1, 3)
        .map((p) => {
            const ch = Array.from(p)[0] || '';
            return ch ? ch.toUpperCase() + '.' : '';
        })
        .filter(Boolean)
        .join(' ');
    return initials ? parts[0] + ' ' + initials : parts[0];
}

/**
 * «Палата · койка» БЕЗ точки между числами.
 *
 * Владелец: «can we not use • between numbers». «201 · 1» читается как одно
 * число, разорванное точкой, и на бумаге это первое, обо что спотыкается глаз.
 * Числа разделяет косая черта, а слова — точка: «Хирургия, 201/1».
 *
 * @param {string} department отделение
 * @param {string} ward палата
 * @param {string} bed койка
 */
export function placeLine(department, ward, bed) {
    const room = [ward, bed].map((v) => String(v === null || v === undefined ? '' : v).trim()).filter(Boolean).join('/');
    const dep = String(department === null || department === undefined ? '' : department).trim();
    return [dep, room].filter(Boolean).join(', ');
}
