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
// ОФЛАЙН-ОСОБЕННОСТЬ. Колонок публичного профиля (биографии на трёх языках,
// образование, соцсети, фото) в офлайн-схеме users сейчас НЕТ — см.
// CLOUD_LEFTOVER_COLUMNS_V1 в schema-registry.js. Поэтому запись идёт только в
// те колонки белого списка, что в таблице действительно есть, а непустые
// значения без колонки возвращаются в `not_stored` — ответ не притворяется,
// что сохранил их. Появятся колонки миграцией — RPC начнёт писать их сам.
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

const MAX_TEXT = 5000;
const MAX_ENTRIES = 50;

function cleanValue(key, v) {
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
    if (!Number.isInteger(n) || n < 0 || n > 80) throw new RpcError('experience_years must be a whole number 0..80.', 400);
    return n;
  }
  // URL_KEYS
  if (v == null) return '';
  if (typeof v !== 'string') throw new RpcError(key + ' must be a link.', 400);
  const s = v.trim();
  if (s === '') return '';
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
  if (!Array.isArray(list)) throw new RpcError('specialties must be a list of slugs.', 400);
  if (list.length > MAX_SPECIALTIES) throw new RpcError('At most 4 specialties.', 400);
  const own = new Map(db.prepare('SELECT specialty_slug, name_ru, name_uz FROM user_specialties WHERE user_id = ?')
    .all(uid).map((r) => [r.specialty_slug, r]));
  const seen = new Set();
  const rows = [];
  for (const raw of list) {
    const slug = typeof raw === 'string' ? raw.trim() : '';
    if (!slug) throw new RpcError('Empty specialty.', 400);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const c = CANON.get(slug);
    if (c) rows.push({ slug, name_ru: c.ru, name_uz: c.uz });
    else if (own.has(slug)) rows.push({ slug, name_ru: own.get(slug).name_ru, name_uz: own.get(slug).name_uz });
    else throw new RpcError('Unknown specialty: ' + slug, 400);
  }
  return rows;
}

function cleanConditions(list) {
  if (!Array.isArray(list) || list.length > MAX_CONDITIONS) throw new RpcError('conditions must be a list.', 400);
  const seen = new Set();
  const rows = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') throw new RpcError('Bad condition.', 400);
    const kind = String(c.kind || '');
    const slug = typeof c.slug === 'string' ? c.slug.trim() : '';
    if (!CONDITION_KINDS.includes(kind) || !slug || slug.length > 200) throw new RpcError('Bad condition.', 400);
    const txt = (v) => (v == null ? null : String(v).trim().slice(0, 500) || null);
    const key = kind + ':' + slug;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind, slug, name_ru: txt(c.name_ru), name_uz: txt(c.name_uz) });
  }
  return rows;
}

function isEmpty(v) {
  return v == null || v === '' || v === '[]';
}

export function updateMyDoctorProfile(db, args, user) {
  const uid = Number(user && user.id);
  if (!Number.isInteger(uid) || uid <= 0) throw new RpcError('Not signed in.', 401);
  const me = db.prepare('SELECT id, is_doctor FROM users WHERE id = ?').get(uid);
  if (!me || !(me.is_doctor === 1 || hasAnyRole(user, ['doctor']))) {
    throw new RpcError('Only a doctor can edit a doctor profile.', 403);
  }
  const p = (args && args.p) || {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new RpcError('p must be an object.', 400);

  const values = {};
  for (const [k, v] of Object.entries(p)) {
    if (!PROFILE_KEYS.includes(k)) throw new RpcError('Field not allowed: ' + k, 400);
    values[k] = cleanValue(k, v);
  }

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
    }
    if (condRows) {
      db.prepare('DELETE FROM doctor_conditions WHERE doctor_id = ?').run(uid);
      const ins = db.prepare('INSERT INTO doctor_conditions (doctor_id, kind, slug, name_ru, name_uz) VALUES (?,?,?,?,?)');
      for (const r of condRows) ins.run(uid, r.kind, r.slug, r.name_ru, r.name_uz);
    }
  })();
  return {
    ok: true, saved, not_stored: notStored,
    ...(specRows ? { specialties: specRows.map((r) => r.slug) } : {}),
    ...(condRows ? { conditions: condRows.length } : {}),
  };
}
