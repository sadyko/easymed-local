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

// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — ОДИН КЛЮЧ НОМЕРА на обе стороны
// сравнения: последние девять цифр (местная часть узбекского номера).
//
// В заявках номер записан четырьмя способами сразу — «942846494», «+998…»,
// «998…» и «+998 91 566 22 78» (живая база, 2026-09-23). Сравнение «строка
// содержит строку» не находило «+998 91 566 22 78» по «915662278», а дубли
// считались по-разному в трёх местах. Правило одно: номер из девяти и больше
// цифр — это его последние девять; короче — местная часть без кода и нуля
// (uzLocalDigits), чтобы короткий служебный номер тоже с чем-то сравнивался.
export const PHONE_KEY_DIGITS = 9;
export function phoneKey(raw) {
    const d = digitsOf(raw);
    if (d.length >= PHONE_KEY_DIGITS) return d.slice(-PHONE_KEY_DIGITS);
    return uzLocalDigits(d);
}

// CRM_DEDUP_SEARCH_TASKS_V1 — ИМЯ ДЛЯ ПОИСКА: строчными, «ё» как «е», БЕЗ
// ЕДИНОГО ПРОБЕЛА. Владелец: «make search work without typing the space».
// «Буронова  Феруза» (два пробела в базе) не находилась по «буронова феруза», а
// набранное слитно «буроноваферуза» не находило ничего.
export function nameKey(s) {
    // i18n-exempt: ё→е — правило сравнения имён, а не текст на экране
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '');
}

/**
 * Подходит ли заявка под строку поиска — ОДНО правило для доски (браузер) и для
 * crm_search (сервер ищет по всем заявкам, а не только по загруженным 800).
 *
 *  • в запросе 4+ цифры — это номер: сравниваются только цифры, по ключу
 *    phoneKey с обеих сторон («+998 91 566 22 78» находится и по «915662278»,
 *    и по «+998915662278»); часть номера тоже находит;
 *  • иначе — имя: nameKey с обеих сторон, и имя заявки, и имя привязанного
 *    пациента (row.patients.full_name или row.patient_name).
 */
export function leadMatchesQuery(row, query) {
    const raw = String(query == null ? '' : query).trim();
    if (!raw) return true;
    const r = row || {};
    const d = digitsOf(raw);
    if (d.length >= MIN_PHONE_DIGITS) {
        const qk = d.length >= PHONE_KEY_DIGITS ? d.slice(-PHONE_KEY_DIGITS) : uzLocalDigits(d);
        const stored = digitsOf(r.phone);
        if (!stored) return false;
        return phoneKey(stored).includes(qk) || stored.includes(d);
    }
    const nk = nameKey(raw);
    if (!nk) return true;
    const patientName = (r.patients && r.patients.full_name) || r.patient_name || '';
    return nameKey(r.full_name).includes(nk) || (!!patientName && nameKey(patientName).includes(nk));
}

/**
 * UZ_PHONE_V1 (2026-09-17) — НОМЕР ИЗ ТЕЛЕФОНИИ К ЕДИНОМУ ВИДУ «+998…».
 *
 * Владелец: «can we fetch the phone number as a +998 added?»
 *
 * Станция отдаёт номер так, как его набрали: «901234567», «998771050404»,
 * «0901234567». В заявке он оседал этой же строкой, и дальше начиналось
 * недоразумение: девять цифр, начинающиеся на 90, программа показывала как
 * «+90 009 397 9» — то есть как ТУРЕЦКИЙ номер, потому что 90 это код Турции.
 * Живой пример с доски владельца.
 *
 * Правило простое и местное: девять цифр без кода — это Узбекистан, потому что
 * ни у одной страны из нашего списка нет девятизначного международного номера.
 * Ведущий ноль — местный набор, он тоже про Узбекистан. Всё остальное (уже с
 * кодом, чужая страна) не трогаем: догадываться о чужом номере опаснее, чем
 * оставить его как есть.
 */
export function uzE164(raw) {
    const d = digitsOf(raw);
    if (!d) return '';
    if (d.length === 9) return '+998' + d;
    if (d.length === 10 && d.startsWith('0')) return '+998' + d.slice(1);
    if (d.length === 12 && d.startsWith('998')) return '+' + d;
    return String(raw == null ? '' : raw).trim().startsWith('+') ? '+' + d : d;
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
