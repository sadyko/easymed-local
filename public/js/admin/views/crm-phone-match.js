// CRM_V8 — телефонный поиск пациента в форме заявки. Телефоны в базе хранятся
// В ФОРМАТЕ («+998 90 961 00 04» — fmtPhone в registration.js), а менеджер
// вводит подряд («+998950768008»), поэтому сравнение — только по цифрам:
//  1) phoneLikePattern даёт SQL-шаблон `%9%6%1%0%` — LIKE пропускает любые
//     разделители МЕЖДУ цифрами, значит найдёт номер в любом формате;
//  2) LIKE-шаблон матчит и ПОДпоследовательности (лишние цифры между),
//     поэтому filterPhoneMatches оставляет только те строки, где введённые
//     цифры идут в номере ПОДРЯД.
// Чистые функции без DOM — тестируются node --test (как lab-grouping.js).

export const MIN_PHONE_DIGITS = 4;   // короче — почти вся база «совпадает»
const MAX_RESULTS = 6;               // как у подсказки в поле ФИО

export function digitsOf(s) {
    return String(s == null ? '' : s).replace(/\D/g, '');
}

export function phoneLikePattern(digits) {
    return '%' + String(digits).split('').join('%') + '%';
}

// CRM_V10 — «короткая форма»: 90 961 00 04 и +998 90 961 00 04 — один номер.
// Для сравнения приводим ввод к местной части: срезаем код страны 998 или
// бытовой ведущий 0 — но только пока остаётся осмысленный кусок номера
// (иначе «9989» превратился бы в «9» и совпал со всей базой).
export function uzLocalDigits(digits) {
    const d = String(digits);
    if (d.startsWith('998') && d.length - 3 >= MIN_PHONE_DIGITS) return d.slice(3);
    if (d.startsWith('0') && d.length - 1 >= MIN_PHONE_DIGITS) return d.slice(1);
    return d;
}

export function filterPhoneMatches(rows, digits) {
    const t = String(digits);
    const tl = uzLocalDigits(t);
    return (rows || [])
        .filter((r) => {
            const sf = digitsOf(r.phone);
            return sf.includes(tl) || sf.includes(t);
        })
        .slice(0, MAX_RESULTS);
}
