// SERVICES_PACKAGES_V1 — «УСЛУГИ ДЛЯ САЙТА И ПАРТНЁРОВ» (шаг 6 API клиники;
// макет screen-services.js): какие услуги и цены видят пациенты на сайте
// клиники, в Symptex и у партнёров — по пяти группам прайса.
//
//   • services_public_overview — только чтение (READ_ONLY_RPCS): услуги с
//     названиями, ценой, показом; врачи с консультациями и ценами (то же
//     правило, что у кассы и API — shared/consultation-price.js), их
//     услуги-консультации из прайса (решение владельца 12) и показ врача
//     (shared/doctor-public.js); цифры над вкладками. Ворота — любой
//     сотрудник, вошедший в систему: прайс, виды консультаций и их цены и так
//     читает весь персонал (реестр), а ставок и долей врачей здесь нет. Плитку
//     в «Настройках» открывает «Список услуг» (settings-hub.js); своих серверных
//     ворот у этой плитки нет (roles-effective.test.js).
//   • services_set_online — включить / выключить показ услуг (одна или
//     «Показать всю группу»). Пишет только администратор — как окно услуги
//     (service_save); в филиале — 409: показ приходит из главного здания с
//     прайсом (branch-sync/catalogue.js). Услуга без названия на русском и
//     узбекском не включается — она в ответе списком «пропущено».
//
// Показ — прежний флаг services.online_booking (мигр. 131).
import { hasAnyRole } from '../roles.js';
import { readIdentity } from '../branch-sync/identity.js';
import { doctorConsultOffer, doctorConsultServices } from './doctor-public.js';
import { doctorPublicState } from '../../../public/js/shared/doctor-public.js';
import {
  PUBLIC_GROUPS, SERVICE_PUBLIC_MESSAGES, serviceGroupOf, apiGroupOf, serviceNames, servicePublicState,
  servicePublicFacts, consultServiceWarning,
} from '../../../public/js/shared/service-public.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isSecondary = (db) => { try { return readIdentity(db).role === 'secondary'; } catch { return false; } };
function jsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

export function servicesPublicOverview(db, args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  const secondary = isSecondary(db);
  const branches = new Map(db.prepare('SELECT id, show_public FROM branches').all().map((b) => [Number(b.id), b]));
  const doctorsRaw = db.prepare(`SELECT id, full_name, full_name_ru, specialty, is_doctor, is_active, is_public, branch_id,
                                        scheduling_mode, service_rates
                                   FROM users WHERE is_doctor = 1 AND is_active = 1 ORDER BY full_name, id`).all();
  const firstSpecialty = db.prepare('SELECT specialty_slug AS slug, name_ru AS name FROM user_specialties WHERE user_id = ? ORDER BY is_primary DESC, id LIMIT 1');
  const doctors = doctorsRaw.map((d) => {
    const spec = firstSpecialty.get(d.id) || null;   // основная — первой, как routes/users.js readSpecialties
    return {
      id: d.id,
      name: String(d.full_name_ru || '').trim() || d.full_name || '',
      specialty: spec ? spec.name : (d.specialty || ''),
      specialty_slug: spec ? spec.slug : null,
      mode: d.scheduling_mode === 'live_queue' ? 'live_queue' : 'schedulable',
      state: doctorPublicState(d, branches),
      consultations: doctorConsultOffer(db, d.id),
      services: doctorConsultServices(db, d.id),
    };
  });
  // Решение 12 — кто оказывает услугу: users.service_rates (та же связь, что у кассы и оплаты врача).
  const performers = new Map();
  for (const d of doctorsRaw) {
    const shown = doctors.find((x) => x.id === d.id).state === 'shown';
    for (const r of jsonArray(d.service_rates)) {
      const sid = Number(r && r.service_id);
      if (!Number.isInteger(sid) || sid <= 0) continue;
      if (!performers.has(sid)) performers.set(sid, []);
      if (!performers.get(sid).some((p) => p.id === d.id)) performers.get(sid).push({ id: d.id, name: doctors.find((x) => x.id === d.id).name, shown });
    }
  }
  const rows = db.prepare(`SELECT id, name, name_uz, name_en, price, type, is_lab, online_booking, active
                             FROM services WHERE active = 1 ORDER BY name, id`).all();
  const services = rows.map((s) => {
    const group = serviceGroupOf(s);
    const out = { id: s.id, name: serviceNames(s), group, api_group: apiGroupOf(s), price: Math.max(0, Number(s.price) || 0),
      online: servicePublicState(s) === 'shown', state: servicePublicState(s) };
    if (group === 'consultation') {
      out.performers = performers.get(s.id) || [];
      out.warning = consultServiceWarning(out.performers);
    }
    return out;
  });
  return {
    can_edit: hasAnyRole(user, ['admin']) && !secondary,
    secondary,
    facts: servicePublicFacts(rows, doctors),
    groups: PUBLIC_GROUPS.map((g) => ({ key: g.key, api: g.api, label: g.label,
      count: g.key === 'consultation' ? doctors.length : services.filter((s) => s.group === g.key).length })),
    services,
    doctors,
  };
}

export function servicesSetOnline(db, args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  if (!hasAnyRole(user, ['admin'])) throw new RpcError(SERVICE_PUBLIC_MESSAGES.adminOnly, 403);
  if (isSecondary(db)) throw new RpcError(SERVICE_PUBLIC_MESSAGES.mainOnly, 409);
  const raw = args && args.ids;
  const ids = Array.isArray(raw) ? [...new Set(raw.map(Number))] : [];
  if (!ids.length || ids.length > 2000 || !ids.every((n) => Number.isInteger(n) && n > 0)) throw new RpcError(SERVICE_PUBLIC_MESSAGES.ids, 400);
  if (typeof (args && args.on) !== 'boolean') throw new RpcError(SERVICE_PUBLIC_MESSAGES.flag, 400);
  const on = args.on;
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, name, name_uz, online_booking, active FROM services WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const set = db.prepare("UPDATE services SET online_booking = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?");
    const changed = [];
    const skipped = [];
    for (const s of rows) {
      const st = servicePublicState(s);
      if (on) {
        if (st === 'no_uz') { skipped.push({ id: s.id, name: s.name }); continue; }
        if (st !== 'off') continue;   // уже показана или отключена в прайсе
        set.run(1, s.id); changed.push(s.id);
      } else if (Number(s.online_booking) === 1) {
        set.run(0, s.id); changed.push(s.id);
      }
    }
    return { changed, skipped };
  })();
}
