// API_DOCS_V1 — МИР ПРИМЕРОВ ДОКУМЕНТАЦИИ: клиника «Шифо» (shifo), её снимок и
// свободное время. На них публичный сервер отвечает примерам страницы /docs:
// ответы примеров не пишутся руками — их записывает
// `node public-server/scripts/docs-build.mjs` (server/docs/generated.js), а
// страж docs/examples.http.test.js спрашивает сервер заново и сверяет.
//
// Часы — NOW стенда: понедельник 11.03.2030, 09:00 в Ташкенте. Имена, телефоны
// и адреса — выдуманные; сайты и соцсети — в зоне .example (RFC 2606).
import { NOW } from './fixture.js';
import { isoOf } from '../lib/time.js';

export const DOCS_ORIGIN = 'https://partner.example';
const t3 = (ru, uz, en) => ({ ru, uz, en });
const LOGO = 'media/cea9dd816d60f34c6a18f35350e00ab868d8fe002be2c51886fdae50bf9df0f7.png';
const PHOTO = 'media/ce1ef52a4851e3b88f63ee8ad2b89acb885be028fb05f09dd99e35483f1dee1f.webp';
const WORKDAY = ['08:00', '18:00'];
const WEEK = { mon: WORKDAY, tue: WORKDAY, wed: WORKDAY, thu: WORKDAY, fri: WORKDAY, sat: ['09:00', '15:00'], sun: null };
const MAP = 'https://yandex.uz/maps/?pt=69.2797,41.3111&z=17';
const ROUTE = 'https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto';

export function docsSnapshot(at = NOW) {
  return {
    version: 1, generated_at: isoOf(at), slug: 'shifo',
    clinic: {
      name: t3('Клиника «Шифо»', '«Shifo» klinikasi', 'Shifo Clinic'),
      about: t3('Семейная клиника: взрослые и дети, анализы, УЗИ.', 'Oilaviy klinika: kattalar va bolalar, tahlillar, UTT.',
        'Family clinic: adults and children, lab tests, ultrasound.'),
      country: 'UZ', city: 'tashkent-city', district: 'yunusobod',
      street: t3('ул. Амира Темура, 1', 'Amir Temur ko‘chasi, 1', '1 Amir Temur Street'),
      phone: '+998712000000', site: 'https://shifo.example', telegram_bot: '@shifo_example_bot', telegram_channel: '@shifo_example',
      instagram: '@shifo.example', logo: { square: LOGO, portrait: null }, map_url: MAP, route_url: ROUTE,
    },
    branches: [
      { id: 1, name: t3('Главный корпус', 'Bosh bino', 'Main building'), city: 'tashkent-city', district: 'yunusobod',
        street: t3('ул. Амира Темура, 1', 'Amir Temur ko‘chasi, 1', '1 Amir Temur Street'),
        landmark: t3('напротив парка', 'bog‘ qarshisida', 'opposite the park'), phone: '+998712000000', hours: WEEK, open_24_7: false,
        map_url: MAP, route_url: ROUTE },
      { id: 2, name: t3('Филиал «Мирабад»', '«Mirobod» filiali', 'Mirobod branch'), city: 'tashkent-city', district: 'mirobod',
        street: t3('ул. Нукус, 5', 'Nukus ko‘chasi, 5', '5 Nukus Street'), landmark: t3('', '', ''), phone: '+998712000001',
        hours: { ...WEEK, sat: null }, open_24_7: false, map_url: '', route_url: '' },
    ],
    doctors: [
      { id: 7, name: t3('Каримов Азиз Рустамович', 'Karimov Aziz Rustamovich', 'Aziz Karimov'),
        title: t3('Врач высшей категории', 'Oliy toifali shifokor', 'Senior physician'),
        bio: t3('Детский врач, 12 лет практики.', 'Bolalar shifokori, 12 yillik tajriba.', 'Paediatrician, 12 years of practice.'),
        specialties: ['pediatr'], experience_years: 12, languages: ['ru', 'uz'], photo: PHOTO, branch_ids: [1], reception: 'booking', booking_days: 14,
        // Только первичный приём: на нём страж показывает 400 consultation / not_offered для repeat.
        consultations: [{ type: 'initial', name: t3('Первичный приём', 'Birlamchi qabul', 'First visit'), price: 150000, minutes: 30 }],
        services: [{ service_id: 303, price: 80000 }] },
      { id: 8, name: t3('Юсупова Нигора Алишеровна', 'Yusupova Nigora Alisherovna', 'Nigora Yusupova'), title: t3('', '', ''),
        bio: t3('Терапевт.', 'Terapevt.', 'General practitioner.'), specialties: ['terapevt'], experience_years: 8, languages: ['ru', 'uz', 'en'],
        photo: null, branch_ids: [2], reception: 'live_queue', booking_days: 14, consultations: [], services: [] },
    ],
    services: [
      { id: 301, group: 'lab', name: t3('Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count'), price: 45000, minutes: 10 },
      { id: 302, group: 'diagnostics', name: t3('УЗИ брюшной полости', 'Qorin bo‘shlig‘i UTT', 'Abdominal ultrasound'), price: 180000, minutes: 20 },
      { id: 303, group: 'consultations', name: t3('Консультация по анализам', 'Tahlillar bo‘yicha maslahat', 'Test results consultation'),
        price: 80000, minutes: 15 },
    ],
    packages: [
      { id: 4, name: t3('Check-up базовый', 'Check-up asosiy', 'Basic check-up'), price_full: 225000, price: 191250, discount_percent: 15,
        valid_until: '2030-06-30', items: [{ service_id: 301, price_full: 45000, price: 38250 }, { service_id: 302, price_full: 180000, price: 153000 }] },
    ],
  };
}

export function docsSlots(at = NOW) {
  return {
    generated_at: isoOf(at), slot_minutes: 15, doctors: {
      7: { reception: 'booking', days: [
        { date: '2030-03-12', from: '09:00', to: '10:30', starts: ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15'], free: '110111' },
        { date: '2030-03-13', from: '14:00', to: '15:00', starts: ['14:00', '14:15', '14:30', '14:45'], free: '1111' },
      ] },
      8: { reception: 'live_queue', hours: { mon: ['08:00', '14:00'], tue: ['08:00', '14:00'], wed: ['08:00', '14:00'], thu: ['08:00', '14:00'],
        fri: ['08:00', '14:00'], sat: null, sun: null }, queue_now: 3 },
    },
  };
}
