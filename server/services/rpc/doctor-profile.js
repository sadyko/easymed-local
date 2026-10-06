// RPC_PORT_V1 — update_my_doctor_profile: врач правит СВОЮ публичную карточку
// (кабинет врача → «Мой профиль», public/js/admin/views/doctor-profile.js).
//
// В облачной версии это была функция Postgres; в офлайн её не перенесли, и
// «Сохранить профиль» отвечал 501 «RPC not implemented» первым же шагом — до
// специальностей и «болезней, которые я лечу» сохранение не доходило никогда.
//
// Правила, те же, что у облачной функции:
//   • строка — ТОЛЬКО своя (user.id вошедшего); id из аргументов не читается;
//   • звать может только врач (is_doctor = 1 или основная/доп. роль doctor) —
//     админ-врач тоже, у него is_doctor;
//   • ключи — строго из белого списка: роль, оклад, ставки, пароль этим путём
//     не меняются никогда; неизвестный ключ — отказ целиком, без частичной записи.
//
// DOCTOR_PUBLIC_PROFILE_V1 (миграция 159) — колонки публичного профиля
// (ФИО/степень/биография на трёх языках, списки образования и опыта, стаж,
// соцсети, фото) теперь ЕСТЬ в users. Владелец: «we need to add them for
// building a proper API for partners». Запись по-прежнему идёт только в
// существующие колонки, а непустые значения без колонки возвращаются в
// `not_stored` — на базе до миграции ответ не притворяется, что сохранил их.
//
// СПЕЦИАЛЬНОСТИ И БОЛЕЗНИ (доводка RPC_PORT_V1). Экран писал user_specialties и
// doctor_conditions напрямую через /api/db, и это не работало ни у кого:
// user_specialties в реестре пишет только admin, а оба insert несли
// company_id, которого среди колонок реестра нет. Теперь оба набора приходят
// сюда же (args.specialties — слаги, до 4, [0] = основная; args.conditions —
// { kind: 'disease'|'symptom', slug, name_ru, name_uz }) и заменяются одной
// транзакцией вместе с полями профиля — только у самого врача. Ключ не
// передан — набор не трогается.
//
// Слаг специальности проверяется по канону (shared/specialty-list.js — тот же
// список, что у карточки сотрудника и отчётов), имена берутся оттуда же, а не
// от клиента. Исключение — слаг, который у ЭТОГО врача уже стоит: старые данные
// не должны запирать профиль, их имена сохраняются как были.
import { hasAnyRole } from '../roles.js';
import { rpcT } from '../server-message.js';   // V3120_I18N
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const LANGS = ['ru', 'uz', 'en'];
const TEXT_KEYS = [
  ...LANGS.map((l) => 'full_name_' + l),
  ...LANGS.map((l) => 'academic_title_' + l),
  ...LANGS.map((l) => 'bio_' + l),
];
const ENTRY_KEYS = ['education_entries', 'experience_entries', 'certifications_entries', 'prof_dev_entries'];
const URL_KEYS = ['instagram_url', 'telegram_url', 'photo_url'];
export const PROFILE_KEYS = Object.freeze([...TEXT_KEYS, ...ENTRY_KEYS, 'experience_years', ...URL_KEYS]);
export const PROFILE_ENTRY_KEYS = Object.freeze([...ENTRY_KEYS]);

const MAX_TEXT = 5000;
const MAX_ENTRIES = 50;

// CLINIC_API_FIX_V1 — ownerId: чей это профиль (у «Моего профиля» — сам врач).
// Задан — фото принимается только из папки этого врача (см. photo_url ниже).
function cleanValue(key, v, ownerId) {
  if (TEXT_KEYS.includes(key)) {
    if (v == null) return '';
    if (typeof v !== 'string') throw new RpcError(key + ' must be text.', 400);
    const s = v.trim();
    if (s.length > MAX_TEXT) throw new RpcError(key + ' is too long.', 400);
    return s;
  }
  if (ENTRY_KEYS.includes(key)) {
    if (v == null) return '[]';
    if (!Array.isArray(v) || v.length > MAX_ENTRIES || !v.every((e) => e && typeof e === 'object' && !Array.isArray(e))) {
      throw new RpcError(key + ' must be a list of entries.', 400);
    }
    const json = JSON.stringify(v);
    if (json.length > MAX_TEXT * 10) throw new RpcError(key + ' is too long.', 400);
    return json;
  }
  if (key === 'experience_years') {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 80) throw new RpcError('Стаж — целое число лет от 0 до 80.', 400);
    return n;
  }
  // URL_KEYS
  if (v == null) return '';
  if (typeof v !== 'string') throw new RpcError(key + ' must be a link.', 400);
  const s = v.trim();
  if (s === '') return '';
  // DOCTOR_PUBLIC_PROFILE_V1, ревью M4 — фото только из СВОЕГО хранилища
  // (корзина doctor-photos, routes/storage.js): внешняя картинка ушла бы
  // партнёрам как фото врача, которое клиника не хранит и не контролирует.
  if (key === 'photo_url') {
    // Ре-ревью п.10 — без «%»: закодированный «..» (%2e%2e) или «/» (%2F)
    // прошёл бы проверку и раскодировался уже в хранилище.
    if (!/^\/api\/storage\/doctor-photos\/[A-Za-z0-9._~\/-]+$/.test(s) || s.includes('..') || s.length > 500) {
      throw new RpcError('Фото должно быть загружено в хранилище клиники.', 400);
    }
    // CLINIC_API_FIX_V1 — ТОЛЬКО ИЗ СВОЕЙ ПАПКИ. Путь фото врача —
    // doctors/<id врача>/<ключ> (routes/storage.js photoTarget), и экран кладёт
    // файл туда же (views/doctor-profile.js photoPrefix → getPublicUrl:
    // /api/storage/doctor-photos/doctors/<id>/<ключ>). Проверка выше принимала
    // любую папку корзины — врач мог поставить себе фото другого врача, и оно
    // ушло бы партнёрам под его именем. Теперь: ровно папка владельца (с «/»
    // на конце — doctors/2 не префикс doctors/22) и один сегмент ключа без
    // «..» — и в раскодированном виде тоже.
    if (ownerId !== undefined) {
      const own = '/api/storage/doctor-photos/doctors/' + ownerId + '/';
      const rest = s.startsWith(own) ? s.slice(own.length) : null;
      let decoded = null;
      try { decoded = decodeURIComponent(s); } catch { decoded = null; }
      if (rest === null || !/^[A-Za-z0-9_][A-Za-z0-9._~-]*$/.test(rest) || decoded === null || decoded.includes('..')) {
        throw new RpcError('Поставить можно только своё фото — загруженное в «Моём профиле».', 400);
      }
    }
    return s;
  }
  if (s.length > 2000 || !(/^https?:\/\//i.test(s) || /^\/[^/]/.test(s))) {
    throw new RpcError(key + ' must be an http(s) link.', 400);
  }
  return s;
}

const MAX_SPECIALTIES = 4;
const MAX_CONDITIONS = 300;
const CONDITION_KINDS = ['disease', 'symptom'];
const CANON = new Map(SPECIALTY_ROWS.map((r) => [r.slug, r]));

function cleanSpecialties(db, uid, list) {
  if (!Array.isArray(list)) throw new RpcError('Специальности переданы неверно: нужен список.', 400);
  if (list.length > MAX_SPECIALTIES) throw new RpcError('Не больше 4 специальностей.', 400);
  const own = new Map(db.prepare('SELECT specialty_slug, name_ru, name_uz FROM user_specialties WHERE user_id = ?')
    .all(uid).map((r) => [r.specialty_slug, r]));
  const seen = new Set();
  const rows = [];
  for (const raw of list) {
    // Ревью M7b — пустое место (null) в списке экрана не отказ: экран не
    // видит специальностей без слага и не должен ими ронять сохранение.
    if (raw == null || raw === '') continue;
    const slug = typeof raw === 'string' ? raw.trim() : '';
    if (!slug) throw new RpcError('Специальность указана неверно.', 400);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const c = CANON.get(slug);
    if (c) rows.push({ slug, name_ru: c.ru, name_uz: c.uz });
    else if (own.has(slug)) rows.push({ slug, name_ru: own.get(slug).name_ru, name_uz: own.get(slug).name_uz });
    else throw rpcT(RpcError, 'Неизвестная специальность: {slug}.', { slug }, 400);
  }
  // Ревью M7b — СПЕЦИАЛЬНОСТЬ БЕЗ СЛАГА НЕ ТЕРЯЕТСЯ. Карточка сотрудника
  // (routes/users.js parseSpecialties) пишет специальность одним названием,
  // без слага. Экран профиля её не показывает (его список — слаги), значит и
  // убрать её врач отсюда не мог: такая строка остаётся за присланными, не
  // основной, а если прислано пусто — основной. Имя, совпавшее с присланной
  // специальностью, не дублируется.
  const sentNames = new Set(rows.map((r) => String(r.name_ru || '').trim().toLowerCase()));
  const legacy = db.prepare('SELECT specialty_slug, name_ru, name_uz FROM user_specialties WHERE user_id = ? AND specialty_slug IS NULL ORDER BY is_primary DESC, id').all(uid);
  for (const r of legacy) {
    const key = String(r.name_ru || '').trim().toLowerCase();
    if (!key || sentNames.has(key)) continue;
    sentNames.add(key);
    rows.push({ slug: null, name_ru: r.name_ru, name_uz: r.name_uz });
  }
  return rows;
}

function cleanConditions(list) {
  if (!Array.isArray(list) || list.length > MAX_CONDITIONS) throw new RpcError('Список заболеваний передан неверно.', 400);
  const seen = new Set();
  const rows = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') throw new RpcError('Заболевание указано неверно.', 400);
    const kind = String(c.kind || '');
    const slug = typeof c.slug === 'string' ? c.slug.trim() : '';
    if (!CONDITION_KINDS.includes(kind) || !slug || slug.length > 200) throw new RpcError('Заболевание указано неверно.', 400);
    const txt = (v) => (v == null ? null : String(v).trim().slice(0, 500) || null);
    const key = kind + ':' + slug;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind, slug, name_ru: txt(c.name_ru), name_uz: txt(c.name_uz) });
  }
  return rows;
}

// DOCTOR_PUBLIC_PROFILE_V1 — те же правила для карточки сотрудника
// (routes/users.js): админ правит профиль врача теми же проверками, что и сам
// врач. Возвращает { ключ: значение для колонки }; неизвестный ключ — отказ.
// CLINIC_API_FIX_V1 — ownerId (необязательный): id врача, чей это профиль;
// задан — фото только из его папки. Карточка сотрудника (routes/users.js) зовёт
// без него, как прежде.
export function cleanProfileFields(p, ownerId) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RpcError('Публичный профиль передан неверно.', 400);
  const values = {};
  for (const [k, v] of Object.entries(p)) {
    if (!PROFILE_KEYS.includes(k)) throw rpcT(RpcError, 'Поле {field} в профиле менять нельзя.', { field: k }, 400);
    values[k] = cleanValue(k, v, ownerId);
  }
  return values;
}

// DOCTOR_PUBLIC_PROFILE_V1 — профиль из строки users в том виде, в каком его
// отдают экраны (и отдаст API партнёрам): списки — массивами, пустое — пустым.
export function publicProfileOf(u) {
  const out = {};
  for (const k of PROFILE_KEYS) {
    const v = u ? u[k] : undefined;
    if (ENTRY_KEYS.includes(k)) {
      let arr = [];
      try { arr = JSON.parse(v || '[]'); } catch { arr = []; }
      out[k] = Array.isArray(arr) ? arr : [];
    } else if (k === 'experience_years') {
      out[k] = v == null ? null : Number(v);
    } else {
      out[k] = v == null ? '' : String(v);
    }
  }
  return out;
}

function isEmpty(v) {
  return v == null || v === '' || v === '[]';
}

export function updateMyDoctorProfile(db, args, user) {
  const uid = Number(user && user.id);
  if (!Number.isInteger(uid) || uid <= 0) throw new RpcError('Нужно войти в систему.', 401);
  const me = db.prepare('SELECT id, is_doctor, is_local FROM users WHERE id = ?').get(uid);
  if (!me || !(me.is_doctor === 1 || hasAnyRole(user, ['doctor']))) {
    throw new RpcError('Профиль врача редактирует только врач.', 403);
  }
  // CLINIC_API_FIX_V1 — ВРАЧ ИЗ ГЛАВНОГО ЗДАНИЯ. Строка приехала синхронизацией
  // (users.is_local = 0, STAFF_SYNC_V1), и колонки публичного профиля едут с ней
  // (branch-sync/catalogue.js): правка здесь молча откатилась бы через час.
  // Та же проверка, что у карточки сотрудника (routes/users.js mainClinicRow),
  // тот же ответ — 409 conflict — и раньше любой проверки значений: ничего не
  // пишется, а пустой вызов отвечает тем же отказом (экран спрашивает его до
  // загрузки фото).
  if (me.is_local === 0) {
    const err = new RpcError('Профиль врача меняется в главном здании.', 409);
    err.code = 'conflict';
    throw err;
  }
  const p = (args && args.p) || {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new RpcError('Данные профиля переданы неверно.', 400);

  const values = cleanProfileFields(p, uid);   // CLINIC_API_FIX_V1 — фото только из своей папки

  const a = args || {};
  const specRows = a.specialties === undefined ? null : cleanSpecialties(db, uid, a.specialties);
  const condRows = a.conditions === undefined ? null : cleanConditions(a.conditions);

  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const saved = [];
  const notStored = [];
  for (const k of Object.keys(values)) {
    if (cols.has(k)) saved.push(k);
    else if (!isEmpty(values[k])) notStored.push(k);
  }
  db.transaction(() => {
    if (saved.length) {
      // Имена колонок — только из белого списка PROFILE_KEYS и проверены по
      // PRAGMA выше: в SQL не попадает ни одного имени от клиента.
      const sql = 'UPDATE users SET ' + saved.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?';
      db.prepare(sql).run(...saved.map((k) => values[k]), uid);
    }
    if (specRows) {
      db.prepare('DELETE FROM user_specialties WHERE user_id = ?').run(uid);
      const ins = db.prepare('INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?,?,?,?,?)');
      specRows.forEach((r, i) => ins.run(uid, r.slug, r.name_ru, r.name_uz, i === 0 ? 1 : 0));
      // Ревью M7a — одна строка специальности у сотрудника (списки врачей,
      // отчёты, бланки) — имя основной, как держит её routes/users.js.
      db.prepare('UPDATE users SET specialty = ? WHERE id = ?').run(specRows.length ? String(specRows[0].name_ru || '') : '', uid);
    }
    if (condRows) {
      db.prepare('DELETE FROM doctor_conditions WHERE doctor_id = ?').run(uid);
      const ins = db.prepare('INSERT INTO doctor_conditions (doctor_id, kind, slug, name_ru, name_uz) VALUES (?,?,?,?,?)');
      for (const r of condRows) ins.run(uid, r.kind, r.slug, r.name_ru, r.name_uz);
    }
    // CLINIC_API_FIX_V1 — экран шлёт только изменённое, и updated_at строки
    // врача говорит, когда профиль менялся (как PATCH /api/users в карточке
    // сотрудника). Ничего не прислано — строка не тронута.
    if (saved.length || specRows || condRows) {
      db.prepare("UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(uid);
    }
  })();
  return {
    ok: true, saved, not_stored: notStored,
    ...(specRows ? { specialties: specRows.map((r) => r.slug).filter(Boolean) } : {}),
    ...(condRows ? { conditions: condRows.length } : {}),
  };
}
