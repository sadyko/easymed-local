// LIS_MINDRAY_CODES_V1 — ИЗ ЧЕГО ВЫБИРАТЬ «Поле анализатора». Чистая функция:
// ни DOM, ни словаря, ни сети — только списки на входе и решение на выходе.
// Тот же приём, что у lab-devices-live.js: проверять надо правило, а не разметку.
//
// Порядок — решение владельца (2026-09-28):
//   1. коды, которые ЭТОТ анализатор действительно присылал («6690-2 · WBC»);
//   2. типовой список модели (профиль) — догадка, а не факт;
//   3. свой код руками — для того, чего нет ни там, ни там.
// Выбор или ввод и есть подтверждение (D4), как было.
//
// Что сохраняется при выборе присланного кода: ИМЯ (компонент 2), если оно
// есть, иначе код. Строка бланка, подтверждённая как «WBC», ловит и
// «6690-2^WBC^LN» (сеть), и «WBC^^99MRC» (переадресатор с лабораторного ПК):
// приём сравнивает с компонентом 1 или 2 (server/lis/match.js).

/** Значение пункта «Вписать код…»: не код прибора, а команда экрана. */
export const TYPE_OWN = '__lis_type_own__';

const K = (s) => String(s == null ? '' : s).trim().toUpperCase();

/**
 * @param {object} o
 * @param {Array<{code:string,name:string,value_type?:string}>} [o.sent]  что прибор присылал (lis_device_codes)
 * @param {Array<{code:string,name:string}>} [o.channels]                каналы профиля модели
 * @param {string} [o.current]                                           сохранённый device_code строки
 * @returns {{sent:Array<{value:string,label:string}>, typical:Array<{value:string,label:string}>,
 *            orphan:{value:string,label:string}|null, selected:string}}
 *   orphan   — сохранённый код, которого нет ни в одном списке: показать отдельно, а не «не выбрано»;
 *   selected — value пункта, который изображает сохранённый код ('' — ничего не сохранено).
 */
export function codeChoices({ sent = [], channels = [], current = '' } = {}) {
    const cur = K(current);
    let selected = '';

    // Числа — вперёд: режимы пробы и референсная группа (IS) тоже присылаются,
    // но в бланк их не кладут. Внутри групп — порядок прибора.
    const ordered = sent.map((c, i) => ({ c, i }))
        .sort((a, b) => ((K(b.c.value_type) === 'NM') - (K(a.c.value_type) === 'NM')) || (a.i - b.i))
        .map((x) => x.c);

    const seen = new Set();
    const sentOpts = [];
    for (const c of ordered) {
        const value = String(c.name || c.code || '').trim();
        if (!value || seen.has(K(value))) continue;
        seen.add(K(value));
        // LIS_REAL_ANALYZERS_V1_WIRE (экран) — подпись строки прибора (label:
        // BS-200 — имя теста из OBX-4, Autobio — OBX-3) — только показ: «12 ·
        // GLU». Сохраняется, как прежде, имя, иначе код: у BS-200 имени нет, и
        // сопоставление идёт по номеру теста, который задала клиника.
        const shown = [];
        for (const part of [c.code, c.name, c.label]) {
            const s = String(part == null ? '' : part).trim();
            if (s && !shown.some((x) => K(x) === K(s))) shown.push(s);
        }
        sentOpts.push({ value, label: shown.length ? shown.join(' · ') : value });
        if (cur && !selected && (cur === K(c.code) || cur === K(c.name))) selected = value;
    }

    const typical = [];
    for (const ch of channels) {
        const value = String(ch.code || '').trim();
        // Уже есть среди присланных — второй раз не показываем.
        if (!value || seen.has(K(value))) continue;
        seen.add(K(value));
        typical.push({ value, label: ch.name ? value + ' · ' + ch.name : value });
        if (cur && !selected && cur === K(value)) selected = value;
    }

    let orphan = null;
    if (cur && !selected) {
        const value = String(current).trim();
        orphan = { value, label: value };
        selected = value;
    }
    return { sent: sentOpts, typical, orphan, selected };
}

// ── LIS_REAL_ANALYZERS_V1 (ревью R5, п. 5) — модель по имени прибора ────────
// Как прибор назвал себя (MSH-3 и MSH-4: lab_devices.sending_app и
// sending_facility) → профиль модели из lis_profiles (с псевдонимами aliases).
// ТО ЖЕ правило, что у сервера (server/lis/discover.js guessProfile; тест
// lab-device-codes.test.mjs сверяет оба на настоящих и спорных именах): по нему
// приём решает, что у прибора номер теста свой у каждого прибора (BS-200), даже
// если строка заведена другой моделью, — и «Панели» должны видеть то же.

/** «BC-5300», «bc 5300», «BC_5300» — одно и то же для сравнения. */
const normModel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
/** Короткая модель (до 5 знаков: «A1000», «BS-200») — только целым словом. */
const SHORT_MODEL = 5;

/** Модель «содержится» в имени: с начала слова, за ней не цифра (короткая — и не буква). */
function containsModel(raw, model) {
  const chars = [];
  const at = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i].toLowerCase();
    if (/[a-z0-9]/.test(c)) { chars.push(c); at.push(i); }
  }
  const name = chars.join('');
  for (let i = name.indexOf(model); i !== -1; i = name.indexOf(model, i + 1)) {
    if (/[0-9]/.test(name.charAt(i + model.length))) continue;
    const before = raw.charAt(at[i] - 1);
    if (before && WORD_CHAR.test(before)) continue;
    const after = raw.charAt(at[i + model.length - 1] + 1);
    if (model.length <= SHORT_MODEL && after && LETTER.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * @param {{app?:string, facility?:string}} who  как прибор назвал себя
 * @param {Array<{key:string, model:string, aliases?:string[]}>} profiles  lis_profiles, в их порядке
 * @returns {object|null} профиль или null — не узнали
 */
export function namedModel({ app = '', facility = '' } = {}, profiles = []) {
  const raws = [String(app == null ? '' : app), String(facility == null ? '' : facility)].filter((r) => normModel(r));
  if (!raws.length) return null;
  const all = (profiles || []).map((p) => ({ p, keys: (Array.isArray(p.aliases) && p.aliases.length ? p.aliases : [p.model]).map(normModel).filter(Boolean) }));
  for (const raw of raws) {
    const want = normModel(raw);
    const exact = all.find(({ keys }) => keys.includes(want));
    if (exact) return exact.p;
  }
  for (const raw of raws) {
    let best = null;
    let bestLen = 0;
    for (const { p, keys } of all) {
      for (const k of keys) {
        if (k.length >= 4 && k.length > bestLen && containsModel(raw, k)) { best = p; bestLen = k.length; }
      }
    }
    if (best) return best;
  }
  return null;
}
