// PUBLIC_API_V1 — ЧТО КЛИНИКА ОТДАЁТ НАРУЖУ: снимок для публичного сервера.
//
// Три части, каждая — своим ритмом (services/api/public-sync.js):
//   buildSnapshot — клиника, филиалы, врачи, услуги, пакеты (то, что видят
//                   партнёры: /clinic, /branches, /doctors, /services,
//                   /packages); уходит, когда изменился (проверка — каждый
//                   такт), и не реже раза в 15 минут;
//   buildSlots    — свободное время врачей по записи (окна по 15 минут, тот же
//                   движок, что календарь: rpc/calendar.js doctorDayWindows) и
//                   часы и очередь врачей живой очереди; проверка — каждую минуту;
//   buildKeys     — подключения: отпечаток ключа, включено ли, права, лимит,
//                   срок, IP, адреса сайтов — быстрый канал: изменение уходит
//                   в ближайший такт (выключение ключа — «сразу 401»).
//
// БЕЛЫЙ СПИСОК: каждое поле выбрано здесь явно; правила показа — те же функции,
// что у экранов шагов 4–6 (branchShownToPartners, doctorPublicState,
// servicePublicState, packagePublicState). Пациентов, визитов, сотрудников (кроме
// показанных врачей), телефонов и почты сотрудников, ключей и секретов в
// снимке нет — это проверяет snapshot.test.js по всем ключам снимка.
// Справочники (география, специальности) публичный сервер берёт из программы
// (решение владельца 6) — в снимок они не входят.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { routeUrl } from '../../../public/js/shared/clinic-profile.js';
import { branchShownToPartners, overlayOwnBuilding } from '../../../public/js/shared/branch-profile.js';
import { doctorPublicState, readLanguages, shownPracticeSince, experienceYears, BOOKING_DAYS, DEFAULT_BOOKING_DAYS, PUBLIC_SLOT_MIN }
  from '../../../public/js/shared/doctor-public.js';
import { servicePublicState, serviceNames, apiGroupOf } from '../../../public/js/shared/service-public.js';
import { isPackageRow, packageCalc, packageItems, packageTerms, packagePublicState } from '../../../public/js/shared/package-price.js';
import { readSlug } from './connections.js';
import { doctorConsultOffer, doctorConsultServices } from '../rpc/doctor-public.js';
import { doctorDayWindows } from '../rpc/calendar.js';
import { doctorQueueWaiting } from '../rpc/queue.js';
import { isoOf } from '../../../public/js/shared/api-booking.js';

export const SNAPSHOT_VERSION = 1;
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
const MEDIA_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });
const WEEK = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

const text = (v) => String(v == null ? '' : v).trim();
const tri = (ru, uz, en) => ({ ru: text(ru), uz: text(uz), en: text(en) });
const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const dayIsoOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (dayIso, n) => { const [y, m, d] = dayIso.split('-').map(Number); return dayIsoOf(new Date(y, m - 1, d + n).getTime()); };

/** Отпечаток содержимого без даты сборки — по нему фон решает, слать ли снова. */
export function contentHash(obj) {
  const { generated_at: _g, ...rest } = obj || {};
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

// ─── ФАЙЛЫ (логотипы, фото врачей) ──────────────────────────────────────────

/** Файл хранилища → ссылка 'media/<sha256>.<ext>' и строка манифеста; нет файла, велик или чужой вид — null. */
function mediaOf(file, media) {
  if (!file) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return null;
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (!buf.length || buf.length > MEDIA_MAX_BYTES) return null;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (!media.some((m) => m.sha256 === sha256)) media.push({ sha256, bytes: buf.length, type, ext, file });
  return 'media/' + sha256 + '.' + ext;
}
const logoFile = (storageDir, rel) => (storageDir && /^(square|portrait)\/[A-Za-z0-9._~-]+\.png$/.test(rel || '') ? path.join(storageDir, 'clinic-logos', rel) : null);
function photoFile(storageDir, url, doctorId) {
  const own = '/api/storage/doctor-photos/doctors/' + doctorId + '/';
  const s = text(url);
  if (!storageDir || !s.startsWith(own)) return null;
  const key = s.slice(own.length);
  return /^[A-Za-z0-9_][A-Za-z0-9._~-]*$/.test(key) ? path.join(storageDir, 'doctor-photos', 'doctors', String(doctorId), key) : null;
}

// ─── КЛИНИКА, ФИЛИАЛЫ, ВРАЧИ, УСЛУГИ, ПАКЕТЫ ────────────────────────────────

function clinicPart(db, storageDir, media) {
  let d = {};
  try { d = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {}; } catch { d = {}; }
  return {
    name: tri(d.clinic_name, d.name_uz, d.name_en),
    about: tri(d.about_ru, d.about_uz, d.about_en),
    country: text(d.country_code), city: text(d.region_code), district: text(d.district_code),
    street: tri(d.street_ru, d.street_uz, d.street_en),
    phone: text(d.phone), site: text(d.website),
    telegram_bot: text(d.telegram_bot), telegram_channel: text(d.telegram_channel), instagram: text(d.instagram),
    logo: { square: mediaOf(logoFile(storageDir, d.logo_square_path), media), portrait: mediaOf(logoFile(storageDir, d.logo_portrait_path), media) },
    map_url: text(d.maps_url), route_url: routeUrl(d.maps_url),
  };
}

function hoursOf(raw) {
  let h = {};
  try { h = raw && typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { h = {}; }
  const out = {};
  for (const k of WEEK) {
    const e = h && h[k];
    const on = e && (('enabled' in e) ? !!e.enabled : ('on' in e) ? !!e.on : !!(e.from && e.to));
    out[k] = on && e.from && e.to ? [String(e.from), String(e.to)] : null;
  }
  return out;
}

function branchesPart(db) {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM branches ORDER BY id').all(); } catch { return []; }
  let company = {};
  try { company = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {}; } catch { company = {}; }
  let own = null;
  try { const i = db.prepare('SELECT role, branch_id FROM branch_identity WHERE id = 1').get(); own = i && i.role !== 'secondary' && i.branch_id != null ? Number(i.branch_id) : null; } catch { own = null; }
  return rows.filter(branchShownToPartners).map((raw) => {
    const r = own != null && Number(raw.id) === own ? overlayOwnBuilding(raw, company) : raw;
    return {
      id: r.id, name: tri(r.name, r.name_uz, r.name_en), city: text(r.region_code), district: text(r.district_code),
      street: tri(r.street_ru, r.street_uz, r.street_en), landmark: tri(r.landmark_ru, r.landmark_uz, r.landmark_en),
      phone: text(r.phone), hours: hoursOf(r.working_hours), open_24_7: Number(r.is_24_7) === 1,
      map_url: text(r.maps_url), route_url: routeUrl(r.maps_url),
    };
  });
}

/** Показанные партнёрам врачи (решение шага 5), как их читает /doctors. */
export function publicDoctors(db) {
  const branches = new Map(db.prepare('SELECT id, active, show_public FROM branches').all().map((b) => [Number(b.id), b]));
  return db.prepare('SELECT * FROM users WHERE is_doctor = 1 ORDER BY id').all().filter((u) => doctorPublicState(u, branches) === 'shown');
}

function doctorsPart(db, storageDir, media, now) {
  const specs = db.prepare('SELECT user_id, specialty_slug FROM user_specialties WHERE specialty_slug IS NOT NULL AND specialty_slug <> \'\' ORDER BY is_primary DESC, id').all();
  return publicDoctors(db).map((u) => {
    const since = shownPracticeSince(u, new Date(now));
    return {
      id: u.id,
      name: tri(u.full_name_ru || u.full_name, u.full_name_uz, u.full_name_en),
      title: tri(u.academic_title_ru, u.academic_title_uz, u.academic_title_en),
      bio: tri(u.bio_ru, u.bio_uz, u.bio_en),
      specialties: [...new Set(specs.filter((s) => s.user_id === u.id).map((s) => s.specialty_slug))].slice(0, 4),
      experience_years: since == null ? null : experienceYears(since, new Date(now)),
      languages: readLanguages(u.languages),
      photo: mediaOf(photoFile(storageDir, u.photo_url, u.id), media),
      branch_ids: u.branch_id ? [Number(u.branch_id)] : [],
      reception: u.scheduling_mode === 'live_queue' ? 'live_queue' : 'booking',
      booking_days: BOOKING_DAYS.includes(Number(u.booking_days)) ? Number(u.booking_days) : DEFAULT_BOOKING_DAYS,
      consultations: doctorConsultOffer(db, u.id).map((c) => ({
        type: c.api_kind || '', name: c.name, price: Math.round(Number(c.price) || 0), minutes: c.minutes,
      })),
      services: doctorConsultServices(db, u.id).filter((s) => s.online).map((s) => ({ service_id: s.service_id, price: Math.round(Number(s.price) || 0) })),
    };
  });
}

function servicesPart(db) {
  return db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY id').all().filter((s) => servicePublicState(s) === 'shown').map((s) => ({
    id: s.id, group: apiGroupOf(s), name: serviceNames(s), price: Math.round(Number(s.price) || 0),
    minutes: Number(s.duration_minutes) > 0 ? Number(s.duration_minutes) : null,
  }));
}

function packagesPart(db, now) {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM service_templates ORDER BY id').all(); } catch { return []; }
  const services = db.prepare('SELECT id, name, name_uz, name_en, price, active, online_booking FROM services').all();
  const day = dayIsoOf(now);
  return rows.filter((r) => isPackageRow(r) && packagePublicState(r, services, day) === 'shown').map((r) => {
    const calc = packageCalc(packageTerms(r), packageItems(r, services).items);
    return {
      id: r.id, name: tri(r.name, r.name_uz, r.name_en),
      price_full: Math.round(calc.full), price: Math.round(calc.price), discount_percent: calc.pct,
      valid_until: r.valid_until || null,
      items: calc.lines.map((l) => ({ service_id: l.service_id, price_full: Math.round(l.full), price: Math.round(l.price) })),
    };
  });
}

/**
 * Снимок «что видят партнёры» и манифест файлов к нему (файлы уходят отдельно,
 * по отпечатку; в снимке — только ссылки media/<sha256>.<ext>).
 * @returns {{snapshot: object, media: Array<{sha256, bytes, type, ext, file}>}}
 */
export function buildSnapshot(db, { storageDir = null, now = Date.now() } = {}) {
  const media = [];
  const snapshot = {
    version: SNAPSHOT_VERSION, generated_at: isoOf(now), slug: readSlug(db),
    clinic: clinicPart(db, storageDir, media),
    branches: branchesPart(db),
    doctors: doctorsPart(db, storageDir, media, now),
    services: servicesPart(db),
    packages: packagesPart(db, now),
  };
  return { snapshot, media };
}

// ─── СВОБОДНОЕ ВРЕМЯ ────────────────────────────────────────────────────────

/**
 * Свободное время: врач по записи — дни с сегодняшнего на срок его записи (7 /
 * 14 / 30), каждый — окно и начала по 15 минут со свободой ('1' — свободно);
 * врач живой очереди — часы по дням недели и, если клиника разрешила, сколько
 * ждут сейчас. Без имён и визитов: только «свободно / занято».
 */
export function buildSlots(db, { now = Date.now() } = {}) {
  const today = dayIsoOf(now);
  const doctors = {};
  for (const u of publicDoctors(db)) {
    if (u.scheduling_mode === 'live_queue') {
      const hours = {};
      for (let i = 0; i < 7; i += 1) {
        const d = doctorDayWindows(db, { doctorId: u.id, dayIso: addDays(today, i), now });
        hours[d.weekday] = d.window ? [d.window.from, d.window.to] : null;
      }
      doctors[u.id] = { reception: 'live_queue', hours, queue_now: Number(u.show_queue_count) === 1 ? doctorQueueWaiting(db, u.id, today) : null };
      continue;
    }
    const horizon = BOOKING_DAYS.includes(Number(u.booking_days)) ? Number(u.booking_days) : DEFAULT_BOOKING_DAYS;
    const days = [];
    for (let i = 0; i < horizon; i += 1) {
      const d = doctorDayWindows(db, { doctorId: u.id, dayIso: addDays(today, i), now });
      if (!d.window) continue;
      days.push({ date: d.date, from: d.window.from, to: d.window.to, starts: d.windows.map((w) => w.start), free: d.windows.map((w) => (w.free ? '1' : '0')).join('') });
    }
    doctors[u.id] = { reception: 'booking', days };
  }
  return { generated_at: isoOf(now), slot_minutes: PUBLIC_SLOT_MIN, doctors };
}

// ─── КЛЮЧИ И ПРАВА (быстрый канал) ──────────────────────────────────────────

const originOf = (url) => { try { return new URL(String(url)).origin; } catch { return ''; } };

/**
 * Подключения для проверки ключа на публичном сервере: отпечаток SHA-256
 * (шаг 7 хранит его рядом с шифротекстом), без самого ключа и без секрета.
 * Удалённые не уходят — публичный сервер заменяет список целиком.
 */
export function buildKeys(db, { now = Date.now() } = {}) {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM api_connections WHERE deleted_at IS NULL ORDER BY id').all(); } catch { rows = []; }
  let website = '';
  try { website = text((db.prepare('SELECT website FROM doc_settings WHERE id = 1').get() || {}).website); } catch { website = ''; }
  return {
    generated_at: isoOf(now),
    connections: rows.map((c) => ({
      id: c.id, kind: c.kind, active: Number(c.active) === 1, key_hash: c.key_hash, scopes: arr(c.scopes),
      rate_limit: Number(c.rate_limit) || 60, key_expires_at: c.key_expires_at || null,
      ip_allow: String(c.ip_allow || '').split('\n').map((s) => s.trim()).filter(Boolean),
      origins: [originOf(c.kind === 'site' ? website : c.site_url)].filter(Boolean),
    })),
  };
}
