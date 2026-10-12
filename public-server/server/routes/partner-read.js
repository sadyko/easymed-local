// PUBLIC_SERVER_V1 — ЧТЕНИЕ ДЛЯ ПАРТНЁРОВ: /clinic, /branches, /doctors,
// /services, /packages, /slots, /reference/* (макет «Документация API»).
//
// Отдаётся ПОСЛЕДНИЙ СНИМОК клиники (дизайн §2), поле as_of — когда клиника в
// последний раз была на связи (её изменения доходят за такт, так что данные
// свежи на этот миг). Ответ — белый список полей: чего нет в этом файле, партнёр
// не получит, даже если новая версия программы клиники пришлёт больше.
//
// ?lang=ru|uz|en — каждое название одной строкой; без параметра — все три;
// пустой перевод — русский. Суммы — целые (так их шлёт клиника). Время —
// Ташкент со смещением. Адрес собирается из кодов справочника той же функцией,
// что в программе (shared/clinic-profile.js composeAddress).
import { composeAddress } from '../../../public/js/shared/clinic-profile.js';
import { API_GROUPS } from '../../../public/js/shared/service-public.js';
import { CONSULT_API_KINDS } from '../../../public/js/shared/consultation-price.js';
import { snapshotOf, slotsOf } from '../store/clinics.js';
import { countryRow, regionRow, districtRow, geoReference, specialtiesReference } from '../lib/reference.js';
import { dayWindows, windowsNeeded, SLOT_MIN } from '../lib/slot-check.js';
import { sendError, langOf } from '../lib/errors.js';
import { localParts, msOf, partnerTime } from '../lib/time.js';
import { scope } from './partner-auth.js';

export const STALE_AFTER_MS = 10 * 60000;
// Проверка исправлений 8b, C: время и снимок, которые сервер не принимает (велики),
// не обновляются, хотя клиника на связи. Неизменное клиника шлёт раз в 15 минут,
// её часы — в пределах ±15 минут от сервера: старше 35 минут — уже не свежее.
export const STALE_DATA_MS = 35 * 60000;
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MEDIA_REF_RE = /^media\/[0-9a-f]{64}\.(png|jpg|jpeg|webp)$/;

const str = (v) => String(v == null ? '' : v);
/** Название на трёх языках → строка языка (пустое — русское) или объект трёх. */
export function tri(v, lang) {
  const o = v && typeof v === 'object' ? v : {};
  const ru = str(o.ru);
  if (lang) return str(o[lang]) || ru;
  return { ru, uz: str(o.uz) || ru, en: str(o.en) || ru };
}
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

function address(p, lang) {
  const parts = { country: countryRow(p.country), region: regionRow(p.city), district: districtRow(p.district), street: p.street || {} };
  if (lang) return composeAddress(parts, lang);
  return { ru: composeAddress(parts, 'ru'), uz: composeAddress(parts, 'uz'), en: composeAddress(parts, 'en') };
}

function hours(h) {
  const out = {};
  for (const d of WEEK) out[d] = Array.isArray(h && h[d]) && h[d].length === 2 ? [str(h[d][0]), str(h[d][1])] : null;
  return out;
}

function namesDeep(v, lang) {
  if (Array.isArray(v)) return v.map((x) => namesDeep(x, lang));
  if (v && typeof v === 'object') {
    if ('ru' in v && Object.keys(v).every((k) => ['ru', 'uz', 'en'].includes(k))) return tri(v, lang);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, namesDeep(x, lang)]));
  }
  return v;
}

/** @param ctx {{db, now, offsetMin, baseUrl}} */
export function readRoutes(r, ctx) {
  const mediaUrl = (clinic, ref) => (MEDIA_REF_RE.test(str(ref)) ? ctx.baseUrl + '/' + clinic.slug + '/v1/' + ref : null);
  const asOf = (clinic) => partnerTime(clinic.last_seen_at, ctx.offsetMin);
  const stale = (clinic) => ctx.now() - (msOf(clinic.last_seen_at) || 0) > STALE_AFTER_MS
    || ctx.now() - Math.min(msOf(clinic.slots_at) || 0, msOf(clinic.snapshot_at) || 0) > STALE_DATA_MS;
  const bad = (req, res, field, reason) => sendError(req, res, 'invalid_field', { field, reason });
  const langOk = (req, res) => {
    if (req.query.lang !== undefined && !langOf(req)) { bad(req, res, 'lang', 'unknown'); return false; }
    return true;
  };
  const snap = (req, res) => {
    const s = snapshotOf(req.clinic);
    if (!s) { sendError(req, res, 'not_found'); return null; }
    return s;
  };

  r.get('/clinic', scope('clinic'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const c = s.clinic || {};
    res.json({
      name: tri(c.name, lang), about: tri(c.about, lang), country: str(c.country), city: str(c.city), district: str(c.district),
      street: tri(c.street, lang), address: address(c, lang), phone: str(c.phone), site: str(c.site),
      telegram_bot: str(c.telegram_bot), telegram_channel: str(c.telegram_channel), instagram: str(c.instagram),
      logo: { square: mediaUrl(req.clinic, c.logo && c.logo.square), portrait: mediaUrl(req.clinic, c.logo && c.logo.portrait) },
      map_url: str(c.map_url), route_url: str(c.route_url), as_of: asOf(req.clinic),
    });
  });

  r.get('/branches', scope('branches'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const { city, district } = req.query;
    const list = (s.branches || []).filter((b) => (!city || b.city === city) && (!district || b.district === district));
    res.json({
      branches: list.map((b) => ({
        id: b.id, name: tri(b.name, lang), city: str(b.city), district: str(b.district), street: tri(b.street, lang),
        landmark: tri(b.landmark, lang), address: address({ country: 'UZ', ...b }, lang), phone: str(b.phone), hours: hours(b.hours),
        open_24_7: !!b.open_24_7, map_url: str(b.map_url), route_url: str(b.route_url),
      })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/doctors', scope('doctors'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const branchId = req.query.branch_id === undefined ? null : posInt(req.query.branch_id);
    if (req.query.branch_id !== undefined && !branchId) return bad(req, res, 'branch_id', 'format');
    const { specialty, district, city } = req.query;
    const branches = new Map((s.branches || []).map((b) => [b.id, b]));
    const inArea = (d) => (d.branch_ids || []).some((id) => {
      const b = branches.get(id);
      return b && (!district || b.district === district) && (!city || b.city === city);
    });
    const list = (s.doctors || []).filter((d) => (!branchId || (d.branch_ids || []).includes(branchId))
      && (!specialty || (d.specialties || []).includes(specialty)) && (!(district || city) || inArea(d)));
    res.json({
      doctors: list.map((d) => ({
        id: d.id, name: tri(d.name, lang), title: tri(d.title, lang), bio: tri(d.bio, lang), specialties: (d.specialties || []).map(str),
        experience_years: d.experience_years == null ? null : int(d.experience_years), languages: (d.languages || []).map(str),
        photo: mediaUrl(req.clinic, d.photo), branch_ids: (d.branch_ids || []).map(Number), reception: d.reception === 'live_queue' ? 'live_queue' : 'booking',
        booking_days: int(d.booking_days),
        consultations: (d.consultations || []).filter((c) => CONSULT_API_KINDS.includes(c.type))
          .map((c) => ({ type: c.type, name: tri(c.name, lang), price: int(c.price), minutes: int(c.minutes) })),
        services: (d.services || []).map((x) => ({ service_id: int(x.service_id), price: int(x.price) })),
      })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/services', scope('services'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const group = req.query.group;
    if (group !== undefined && !API_GROUPS.includes(group)) return bad(req, res, 'group', 'unknown');
    const lang = langOf(req);
    res.json({
      services: (s.services || []).filter((x) => !group || x.group === group)
        .map((x) => ({ id: x.id, group: str(x.group), name: tri(x.name, lang), price: int(x.price), minutes: x.minutes == null ? null : int(x.minutes) })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/packages', scope('packages'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const today = localParts(ctx.now(), ctx.offsetMin).date;
    res.json({
      packages: (s.packages || []).filter((p) => !p.valid_until || str(p.valid_until) >= today).map((p) => ({
        id: p.id, name: tri(p.name, lang), price_full: int(p.price_full), price: int(p.price), discount_percent: Number(p.discount_percent) || 0,
        valid_until: p.valid_until || null, items: (p.items || []).map((i) => ({ service_id: int(i.service_id), price_full: int(i.price_full), price: int(i.price) })),
      })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/slots', scope('slots'), (req, res) => {
    const s = snap(req, res);
    if (!s) return;
    const doctorId = posInt(req.query.doctor_id);
    if (!doctorId) return bad(req, res, 'doctor_id', req.query.doctor_id === undefined ? 'required' : 'format');
    const doctor = (s.doctors || []).find((d) => d.id === doctorId);
    if (!doctor) return sendError(req, res, 'not_found', { field: 'doctor_id' });
    const date = req.query.date;
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return bad(req, res, 'date', 'format');
    const all = slotsOf(req.clinic);
    const mine = all && all.doctors ? all.doctors[String(doctorId)] : null;
    const meta = { as_of: asOf(req.clinic), stale: stale(req.clinic) };
    if (doctor.reception === 'live_queue') {
      return res.json({ doctor_id: doctorId, reception: 'live_queue', hours: hours(mine && mine.hours),
        queue_now: mine && mine.queue_now != null ? int(mine.queue_now) : null, ...meta });
    }
    let minutes = null;
    if (req.query.consultation !== undefined) {
      const c = (doctor.consultations || []).find((x) => x.type === req.query.consultation);
      if (!c) return bad(req, res, 'consultation', 'not_offered');
      minutes = c.minutes;
    } else if (req.query.service_id !== undefined) {
      const svc = (s.services || []).find((x) => x.id === posInt(req.query.service_id));
      if (!svc) return sendError(req, res, 'not_found', { field: 'service_id' });
      minutes = svc.minutes;
    }
    const n = req.query.consultation !== undefined || req.query.service_id !== undefined ? windowsNeeded(minutes) : null;
    const days = (mine && Array.isArray(mine.days) ? mine.days : []).filter((d) => !date || d.date === date)
      .map((d) => ({ date: d.date, slots: dayWindows(d, n, { now: ctx.now(), offsetMin: ctx.offsetMin }) }));
    if (date) return res.json({ doctor_id: doctorId, date, slot_minutes: SLOT_MIN, slots: days.length ? days[0].slots : [], ...meta });
    return res.json({ doctor_id: doctorId, slot_minutes: SLOT_MIN, days, ...meta });
  });

  r.get('/reference/geo', (req, res) => {
    if (!langOk(req, res)) return;
    res.json(namesDeep(geoReference(), langOf(req)));
  });
  r.get('/reference/specialties', (req, res) => {
    if (!langOk(req, res)) return;
    res.json(namesDeep(specialtiesReference(), langOf(req)));
  });
}
