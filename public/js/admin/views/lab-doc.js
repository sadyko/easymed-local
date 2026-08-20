// LAB_BLANK_DESIGNED_V1 — общие правила бланка результатов.
//
// Бланк печатается из ДВУХ мест: из лаборатории (laboratory.js — «Отчёт» и
// «Бланк») и из карты пациента (patient-card.js — вкладка «Документы», где
// результаты дня выводятся одним документом). Обе стороны кладут данные в один
// и тот же шаблон «Настройки → Документы» (doc-variants.js → labClassic), и
// значит обе должны одинаково отвечать на вопрос «это отклонение вверх или
// вниз» и «куда поставить метку на полоске диапазона».
//
// Вторая копия этих правил разошлась бы с первой при первой же правке, а
// разойтись им нельзя: один и тот же анализ не может быть «выше нормы» на
// бланке из лаборатории и «в норме» на бланке из карты. Поэтому — сюда, и
// покрыто тестами отдельно от браузера.

// Шаблон знает только три состояния: H (выше), L (ниже), · (норма).
//
// 'abnormal' и 'critical' сами по себе не говорят, в какую сторону отклонение,
// поэтому смотрим на число и границы. Если чисел нет — считаем H: пометка
// «есть отклонение» честнее, чем показать «норму» там, где её никто не
// подтверждал.
export function labFlagFor(x) {
    const f = String((x && x.flag) || '');
    if (f === 'high') return 'H';
    if (f === 'low') return 'L';
    if (f === 'abnormal' || f === 'critical') {
        const v = x.numeric_value;
        if (v != null && x.ref_high != null && v > x.ref_high) return 'H';
        if (v != null && x.ref_low != null && v < x.ref_low) return 'L';
        return 'H';
    }
    return 'N';
}

// Положение метки на полоске диапазона, в процентах.
//
// В шаблоне полоса «нормы» нарисована от 22% до 78%, поэтому референс кладём
// ровно туда: значение на нижней границе встаёт на 22%, на верхней — на 78%,
// отклонение уходит за полосу и это видно глазом. Возвращаем null, когда
// числового диапазона нет: метка по умолчанию села бы в середину полосы и
// намекала на норму, которую никто не измерял.
export function labPosFor(x) {
    const v = x && x.numeric_value, lo = x && x.ref_low, hi = x && x.ref_high;
    if (v == null || lo == null || hi == null || !(hi > lo)) return null;
    return Math.max(2, Math.min(98, 22 + ((v - lo) / (hi - lo)) * 56));
}

// 'YYYY-MM-DD…' -> 'DD.MM.YYYY'. Пустая строка, если даты нет или она не в том
// виде: в шапке бланка лучше прочерк, чем 'Invalid Date'.
export function fmtDMY(iso) {
    const s = String(iso == null ? '' : iso).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('.') : '';
}

export function labSexRu(gender) {
    const g = String(gender || '').toLowerCase();
    return g === 'male' ? 'Мужской' : g === 'female' ? 'Женский' : '';
}

// Ячейка референса: базовый диапазон, ниже — именованные (пол/возраст/фаза).
// Подходящий помечается '•' — шаблон (refCellHtml) выделит эту строку жирным.
// Пометка НИКОГДА не меняет флаг: она лишь подсказывает, на какую строку
// смотреть. То же правило безопасности, что и в форме ввода результатов.
export function labRefLines(baseRef, namedTexts) {
    const named = Array.isArray(namedTexts) ? namedTexts.filter(Boolean) : [];
    return [baseRef || '—']
        .concat(named.map((t, i) => (i === 0 ? '• ' : '') + t))
        .join('\n');
}

// Диапазон «от–до» человеческим текстом. null, когда задавать нечего.
export function rangeText(low, high) {
    if (low != null && high != null) return `${low}–${high}`;
    if (low != null) return `≥ ${low}`;
    if (high != null) return `≤ ${high}`;
    return null;
}

// LAB_REF_ALL_V1 — В БЛАНК ИДУТ ВСЕ ДИАПАЗОНЫ ПОКАЗАТЕЛЯ, а не один.
//
// У показателя их до трёх: базовый (ref_low/ref_high), мужской (_m) и женский
// (_f). Раньше печатался ровно один — тот, что выбрал refFor() по полу
// пациента, — и с ним было две беды:
//
//   1. 27 показателей в базе клиники заданы ТОЛЬКО через М/Ж, без базового.
//      Пациенту без пола (или с 'other') refFor возвращал пустой базовый
//      диапазон, и графа «Референс» уходила в бланк ПУСТОЙ. Пустая норма рядом
//      с числом — это бланк, по которому нельзя ничего сказать.
//   2. Мужскую и женскую норму нельзя было увидеть вместе, хотя врач их
//      сравнивает.
//
// Теперь печатаются все заданные, а подходящая пациенту помечается '•' —
// шаблон выделит её жирным. Пометка по-прежнему НЕ ВЛИЯЕТ на флаг.
export function labRefText(analyte, gender, fallback, namedTexts) {
    const a = analyte || {};
    const g = String(gender || '').toLowerCase();
    const base = rangeText(a.ref_low, a.ref_high);
    const male = rangeText(a.ref_low_m, a.ref_high_m);
    const female = rangeText(a.ref_low_f, a.ref_high_f);

    const lines = [];
    // Базовый показываем, только когда он есть: строка «—» рядом с реальными
    // М/Ж читается как «норма не задана» и путает.
    if (base) lines.push({ text: base, hit: !((g === 'male' && male) || (g === 'female' && female)) });
    if (male) lines.push({ text: 'М: ' + male, hit: g === 'male' });
    if (female) lines.push({ text: 'Ж: ' + female, hit: g === 'female' });
    if (!lines.length && a.ref_text) lines.push({ text: String(a.ref_text), hit: true });

    // Показателя в панели нет (старые строки) — печатаем то, что сохранилось
    // в самом результате. Прочерк ставим ТОЛЬКО когда печатать больше нечего:
    // «—» строкой выше именованных диапазонов читается как «нормы нет».
    const namedOnly = (Array.isArray(namedTexts) ? namedTexts.filter(Boolean) : []);
    if (!lines.length) {
        if (!fallback && namedOnly.length) return namedOnly.join('\n');
        return labRefLines(fallback, namedOnly);
    }

    const named = Array.isArray(namedTexts) ? namedTexts.filter(Boolean) : [];
    // Помечаем ОДНУ строку: две жирные строки не подсказка, а вопрос.
    let marked = false;
    const out = lines.map((l) => {
        if (l.hit && !marked) { marked = true; return '• ' + l.text; }
        return l.text;
    });
    return out.concat(named).join('\n');
}

// LAB_FLAG_NUMERIC_ONLY_V1 — флаг H/L имеет смысл только у ЧИСЛА.
//
// «Цвет: соломенно-жёлтый», «Белок: отрицательно», «Прозрачность: прозрачная» —
// это результаты-тексты и результаты-варианты. Сравнивать их с верхней и нижней
// границей не с чем, а колонка «Флаг» всё равно ставила им «·», то есть «в
// норме». Пустая клетка честнее: программа про такой результат ничего не знает,
// его оценивает врач.
export function isNumericValue(v) {
    if (v == null || v === '') return false;
    // Запятая как разделитель — обычное дело в лабораторных бланках.
    const n = Number(String(v).trim().replace(',', '.'));
    return Number.isFinite(n);
}

// Флаг для строки бланка: пусто у нечисловых значений, иначе обычное правило.
export function labFlagCell(x) {
    return isNumericValue(x && x.value) ? labFlagFor(x) : '';
}

// ---------------------------------------------------------------------------
// LAB_NAMED_RANGES_SHARED_V1 — именованные диапазоны («подпоказатели»)
// ---------------------------------------------------------------------------
// Это те строки, что заводятся кнопкой «+ Добавить диапазон»: фазы цикла,
// менопауза, триместр, возрастные группы. Раньше они читались ТОЛЬКО из панели
// самой услуги, и как только показатель находился в другой панели (по имени
// или по словам), все его фазы молча пропадали. На бланке это выглядело так:
// у ФСГ женщине печаталась одна мужская норма, а четыре женские фазы —
// фолликулярная, овуляция, лютеиновая, постменопауза — исчезали.
//
// Правила бланка (их же обещает редактор диапазонов):
//   • печатаются ВСЕ заданные диапазоны, а не только подходящие;
//   • подходящий по полу и возрасту помечается '•' — шаблон выделит его жирным;
//   • при двух и более диапазонах автоматический флаг НЕ ставится: фазу цикла
//     программа знать не может, решает врач.
export function normRefRanges(raw) {
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw || '[]'); } catch (e) { return []; }
    }
    if (!Array.isArray(list)) return [];
    return list.filter((x) => x && (x.low != null || x.high != null || String(x.text || '').trim() !== ''));
}

export function fmtNamedRange(r) {
    let v = '';
    if (r.low != null && r.high != null) v = `${r.low}–${r.high}`;
    else if (r.low != null) v = `≥ ${r.low}`;
    else if (r.high != null) v = `≤ ${r.high}`;
    else v = String(r.text || '').trim();
    return (r.label ? r.label + ': ' : '') + v;
}

export function matchedNamedRanges(analyte, gender, age) {
    return normRefRanges(analyte && analyte.ref_ranges).filter((r) =>
        (!r.sex || r.sex === gender) &&
        (r.age_min == null || (age != null && age >= r.age_min)) &&
        (r.age_max == null || (age != null && age <= r.age_max)));
}

export function ageYears(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
}

// Готовые строки для ячейки «Референс» + признаки для флага.
// { texts: ['• фолликулярная: 3.5–12.5', 'овуляция: …'], count, marked }
export function namedRangeCell(analyte, gender, age) {
    const all = normRefRanges(analyte && analyte.ref_ranges);
    if (!all.length) return { texts: [], count: 0, marked: false };
    const hit = new Set(matchedNamedRanges(analyte, gender, age).map(fmtNamedRange));
    let marked = false;
    const texts = all.map((r) => {
        const t = fmtNamedRange(r);
        if (hit.has(t) && !marked) { marked = true; return '• ' + t; }
        return t;
    });
    return { texts, count: all.length, marked };
}

// ---------------------------------------------------------------------------
// LAB_ANALYTE_RESOLVE_PURE_V1 — поиск показателя как ЧИСТАЯ функция
// ---------------------------------------------------------------------------
// Раньше этот код жил внутри модуля, который тянет supabase, и проверить его
// можно было только глазами в браузере. Каждая проверка «а всё ли теперь
// находится» переписывала правила заново в отдельном скрипте — и проверяла не
// то, что выполняет приложение. Теперь правила здесь, их импортируют и бланк,
// и тесты, и аудит справочника: сверять больше нечего с чем.
export const nkName = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const TOK_SPLIT = /[()[\],.;:/\-]+/g;
export const nameTokens = (v) => nkName(v).replace(TOK_SPLIT, ' ').split(/\s+/).filter(Boolean);

const refSig = (a) => [a.unit, a.ref_low, a.ref_high, a.ref_low_m, a.ref_high_m,
                       a.ref_low_f, a.ref_high_f, a.ref_text, a.ref_ranges].join('|');
export const analyteHasRef = (a) => !!a && (a.ref_low != null || a.ref_high != null
    || a.ref_low_m != null || a.ref_high_m != null || a.ref_low_f != null
    || a.ref_high_f != null || !!a.ref_text || !!a.ref_ranges);

// Индекс из списка показателей справочника.
//
// Имя, у которого в разных панелях РАЗНЫЕ нормы («Лейкоциты» в крови и в моче,
// «Глюкоза» в крови и в моче), в точный индекс не попадает: подставить туда
// чужую норму хуже, чем оставить пусто.
export function buildAnalyteIndex(rows) {
    const exact = new Map();
    const fuzzy = [];
    const conflicts = new Set();
    const seen = new Map();
    for (const a of (rows || [])) {
        if (!a || !a.name) continue;
        const k = nkName(a.name);
        const prev = seen.get(k);
        if (!prev) seen.set(k, { sig: refSig(a), a });
        else if (prev.sig !== refSig(a)) prev.conflict = true;
        if (analyteHasRef(a)) fuzzy.push({ set: new Set(nameTokens(a.name)), a, sig: refSig(a) });
    }
    for (const [k, v] of seen) { if (v.conflict) conflicts.add(k); else exact.set(k, v.a); }
    return { exact, fuzzy, conflicts };
}

// Показатель по имени + ПОЧЕМУ он найден (нужно аудиту и понятно в отладке).
//   local  — показатели панели этой услуги; они всегда важнее справочника.
//   'panel' | 'exact' | 'tokens' | 'conflict' | 'none'
export function resolveAnalyteWhy(idx, name, local) {
    const k = nkName(name);
    if (local && local.get(k)) return { analyte: local.get(k), how: 'panel' };
    if (idx && idx.exact.get(k)) return { analyte: idx.exact.get(k), how: 'exact' };
    if (idx && idx.conflicts.has(k)) return { analyte: null, how: 'conflict' };
    if (!idx) return { analyte: null, how: 'none' };
    // Слова результата должны целиком входить в имя показателя — и только в эту
    // сторону: обратная даёт «Dбил прямой билирубин» -> «Билирубин», а это
    // другой анализ с другой нормой. Одно слово не подбираем: «Цвет», «Кровь».
    const t = nameTokens(name);
    if (t.length < 2) return { analyte: null, how: 'none' };
    const hits = idx.fuzzy.filter((f) => t.every((w) => f.set.has(w)));
    if (!hits.length) return { analyte: null, how: 'none' };
    if (new Set(hits.map((h) => h.sig)).size !== 1) return { analyte: null, how: 'conflict' };
    return { analyte: hits[0].a, how: 'tokens' };
}

// ---------------------------------------------------------------------------
// LAB_PANEL_IS_TRUTH_V1 — панель услуги задаёт показатели заказа. Не имена.
// ---------------------------------------------------------------------------
// Результат хранит имя показателя таким, каким оно было В МОМЕНТ ввода. Панель
// живёт дальше: её переименовывают, чинят опечатки, заводят заново. Пока бланк
// сопоставлял результат со справочником ПО ИМЕНИ, любая правка имени рвала
// связь, и заказ печатался без норм — хотя панель со всеми нормами привязана к
// его же услуге. Проверка орфографии — не работа лаборанта.
//
// Правило: результаты заказа сопоставляются с показателями панели ЕГО услуги.
//   1) сначала по имени (без регистра и лишних пробелов) — точные пары;
//   2) остальные — ПО ПОРЯДКУ, но только когда счёт совпадает (в панели
//      столько же показателей, сколько строк в результате): форма ввода пишет
//      строки ровно в порядке панели, поэтому пары однозначны. Панель из
//      одного показателя с одним результатом — гарантированный случай.
// При несовпадении счёта позиционных догадок не делаем: неполный ввод или
// добавленный вручную показатель спарился бы с чужой нормой.
export function matchResultsToAnalytes(analytes, resultNames) {
    const list = Array.isArray(analytes) ? analytes : [];
    const names = Array.isArray(resultNames) ? resultNames : [];
    const out = new Array(names.length).fill(null);
    const used = new Set();

    const byName = new Map();
    list.forEach((a, i) => {
        if (!a || !a.name) return;
        const k = nkName(a.name);
        if (!byName.has(k)) byName.set(k, i);
    });
    names.forEach((n, ri) => {
        const ai = byName.get(nkName(n));
        if (ai != null && !used.has(ai)) { out[ri] = list[ai]; used.add(ai); }
    });

    if (list.length === names.length) {
        const left = list.map((a, i) => i).filter((i) => !used.has(i));
        let j = 0;
        for (let ri = 0; ri < names.length; ri++) {
            if (out[ri] == null && j < left.length) out[ri] = list[left[j++]];
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// LAB_SHEET_HEAD_V1 — шапка бланка одинакова, откуда бы его ни печатали.
// ---------------------------------------------------------------------------
// Один и тот же анализ печатался с ТРЕМЯ разными шапками: лаборатория писала
// «Заявка LAB-000501» и подставляла в «Выдан» СЕГОДНЯШНЮЮ дату, карта пациента
// теряла номер заявки и называла «Выдан» день визита, бот печатал номер без
// префикса LAB-. Пациент, получивший бланк в регистратуре и в Telegram, держал
// два разных документа об одном анализе.
//
// Правила, одинаковые для всех:
//   Заявка №  — LAB-xxxxxx (номер заказа, он же штрих-код образца);
//   Приём     — дата забора, а если забор не отмечен — день визита;
//   Выдан     — дата проверки, а без неё — дата последнего ввода результата.
//               НИКОГДА не «сегодня»: дата документа не должна меняться от
//               того, что его перепечатали на следующий день.
export const labAccession = (id) => 'LAB-' + String(id).padStart(6, '0');

export function labIssueDates({ visitDate, collectedAt, verifiedAt, lastEnteredAt } = {}) {
    return {
        dateIn: fmtDMY(collectedAt || visitDate),
        dateOut: fmtDMY(verifiedAt || lastEnteredAt),
    };
}

// Самая поздняя дата колонки среди строк результата (ISO-строки сравниваются
// лексикографически корректно).
export function labMaxDate(rows, col) {
    let best = '';
    for (const r of (rows || [])) {
        const v = r && r[col];
        if (v && String(v) > best) best = String(v);
    }
    return best || null;
}
