// TEXT_MATCH_V1 — «печатаю как помню» для длинных списков имён.
//
// Отдельным модулем в shared/, а не внутри компонента: тот импортирует ui.js, а
// ui.js трогает document — в Node такой файл не загрузить, и правила поиска
// остались бы без тестов. Здесь ни DOM, ни сети.
//
// Правило одно: КАЖДОЕ слово запроса должно найтись где-то в строке, в любом
// порядке. «ойбек наб» находит «Набиев Ойбек», потому что у стойки помнят имя,
// а в справочнике первой стоит фамилия. Это то же правило, по которому уже
// ищутся пациенты (PATIENT_SEARCH_TOKENS_V1 в admin/data.js) — два списка в
// одной системе не должны искать по-разному.

export function matchesQuery(text, query) {
    const t = String(text == null ? '' : text).toLowerCase();
    const words = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => t.includes(w));
}

// items — [{ label }]. Пустой запрос ничего не отсеивает.
export function filterByLabel(items, query) {
    if (!String(query || '').trim()) return (items || []).slice();
    return (items || []).filter((o) => matchesQuery(o && o.label, query));
}
