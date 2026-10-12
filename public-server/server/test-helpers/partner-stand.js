// PUBLIC_SERVER_V1 — стенд адресов партнёров: клиника «Шифо» (shifo) со
// снимком, временем и подключением med24.uz (ключ выпущен во время теста),
// часы стенда двигает тест, лимиты — настоящие.
import { newApiKey, keyHash } from '../../../server/services/api/secret-box.js';
import { admitClinic, saveKeys, saveSnapshot, saveSlots } from '../store/clinics.js';
import { partnerRouter } from '../routes/partner.js';
import { createLimiter } from '../lib/rate-limit.js';
import { testDb, testVendor, testClinic, serve, NOW } from './fixture.js';
import { isoOf } from '../lib/time.js';

export const OFFSET = 300;
const t3 = (ru, uz = '', en = '') => ({ ru, uz, en });
const WEEK = { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '18:00'], sat: ['09:00', '15:00'], sun: null };

export function snapshotFixture(at = NOW) {
  return {
    version: 1, generated_at: isoOf(at), slug: 'shifo',
    clinic: { name: t3('Шифо', 'Shifo'), about: t3('Семейная клиника'), country: 'UZ', city: 'tashkent-city', district: 'yunusobod',
      street: t3('ул. Мира, 1', 'Mira ko‘chasi, 1'), phone: '+998712000000', site: 'https://shifo.uz', telegram_bot: '@shifo_bot',
      telegram_channel: '', instagram: '', logo: { square: null, portrait: null }, map_url: '', route_url: '' },
    branches: [
      { id: 1, name: t3('Главный корпус', 'Bosh bino'), city: 'tashkent-city', district: 'yunusobod', street: t3('ул. Мира, 1'),
        landmark: t3('напротив парка'), phone: '+998712000000', hours: WEEK, open_24_7: false, map_url: '', route_url: '' },
      { id: 2, name: t3('Филиал'), city: 'tashkent-city', district: 'mirobod', street: t3('ул. Нукус, 5'), landmark: t3(''),
        phone: '', hours: WEEK, open_24_7: false, map_url: '', route_url: '' },
    ],
    doctors: [
      { id: 7, name: t3('Петров Пётр Петрович', 'Petrov Pyotr', 'Petrov Pyotr'), title: t3(''), bio: t3('Педиатр'), specialties: ['pediatr'],
        experience_years: 6, languages: ['ru', 'uz'], photo: null, branch_ids: [1], reception: 'booking', booking_days: 14,
        consultations: [{ type: 'initial', name: t3('Первичный приём', 'Birlamchi qabul'), price: 150000, minutes: 30 },
          { type: 'repeat', name: t3('Повторный приём', 'Takroriy qabul'), price: 98000, minutes: 15 }],
        services: [{ service_id: 301, price: 45000 }] },
      { id: 8, name: t3('Каримова Нигора'), title: t3(''), bio: t3(''), specialties: ['terapevt'], experience_years: null, languages: ['ru'],
        photo: null, branch_ids: [2], reception: 'live_queue', booking_days: 14, consultations: [], services: [] },
    ],
    services: [
      { id: 301, group: 'lab', name: t3('Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count'), price: 45000, minutes: 10 },
      { id: 302, group: 'diagnostics', name: t3('УЗИ брюшной полости', 'Qorin bo‘shlig‘i UTT'), price: 180000, minutes: 20 },
    ],
    packages: [
      { id: 4, name: t3('Check-up базовый', 'Check-up asosiy'), price_full: 345000, price: 293000, discount_percent: 15.1, valid_until: '2030-06-01',
        items: [{ service_id: 301, price_full: 45000, price: 38200 }] },
      { id: 5, name: t3('Старый пакет'), price_full: 100, price: 90, discount_percent: 10, valid_until: '2030-03-01', items: [] },
    ],
  };
}

export function slotsFixture(at = NOW) {
  return {
    generated_at: isoOf(at), slot_minutes: 15, doctors: {
      7: { reception: 'booking', days: [{ date: '2030-03-12', from: '09:00', to: '10:30', starts: ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15'], free: '111011' }] },
      8: { reception: 'live_queue', hours: { mon: ['08:00', '14:00'], sat: ['08:00', '12:00'] }, queue_now: 3 },
    },
  };
}

export const SCOPES_ALL = ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments', 'cancel'];

/**
 * Стенд: { base, db, key, clock, setClock, conn(over), close, clinicId }.
 * API_DOCS_V1 — snapshot, slots, baseUrl: мир примеров документации
 * (test-helpers/docs-world.js) вместо мира тестов 8b.
 */
export async function partnerStand({ scopes = SCOPES_ALL, connection = {}, requireHttps = false, trustProxy = false, limiter = createLimiter(),
  snapshot = snapshotFixture(), slots = slotsFixture(), baseUrl = 'https://api.test' } = {}) {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const clinic = testClinic(vendor);
  let clock = NOW;
  admitClinic(db, { clinicId: clinic.clinicId, fingerprint: clinic.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  const key = newApiKey();
  const conn = (over = {}) => ({ id: 3, kind: 'partner', active: true, key_hash: keyHash(key), scopes, rate_limit: 60, key_expires_at: null,
    ip_allow: [], origins: ['https://med24.uz'], ...connection, ...over });
  let keysAt = NOW;
  const setConnection = (over) => {
    keysAt += 1000;
    saveKeys(db, clinic.clinicId, { generated_at: isoOf(keysAt), box_key: clinic.identity.boxPublic, connections: [conn(over)] }, keysAt);
  };
  setConnection({});
  saveSnapshot(db, clinic.clinicId, snapshot, NOW);
  saveSlots(db, clinic.clinicId, slots, NOW);
  const ctx = { db, dataDir: dir, now: () => clock, offsetMin: OFFSET, baseUrl, requireHttps, limiter };
  const srv = await serve('/:slug/v1', partnerRouter(ctx), { trustProxy });
  const get = (p, { headers = {}, auth = true } = {}) =>
    fetch(srv.base + p, { headers: { ...(auth ? { Authorization: 'Bearer ' + key } : {}), ...headers } });
  const send = (method, p, body, { headers = {}, auth = true } = {}) => fetch(srv.base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    ...srv, db, dir, key, clinic, clinicId: clinic.clinicId, vendor, ctx, get, send, setConnection,
    clock: () => clock, setClock: (t) => { clock = t; },
  };
}
