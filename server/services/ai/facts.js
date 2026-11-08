// AI_CHAT_V1 — что ИИ знает о клинике. Источник — buildSnapshot
// (services/api/snapshot.js): тот же белый список, что клиника отдаёт
// партнёрам, проверенный snapshot.test.js по всем ключам. Пациентов, визитов,
// сотрудников (кроме показанных врачей) и ключей в нём нет.
//
// Снимок здесь СЖИМАЕТСЯ: у сервера управления лимит тела запроса, а 2000
// публичных услуг со всеми переводами, id и минутами — около 490 КБ. Поэтому
// каждое название — одна строка (ru, при её отсутствии uz/en), без id, медиа,
// описаний и служебных полей. Ошибка сборки снимка не должна ронять ответ:
// ИИ тогда просто ничего не знает о клинике и передаст вопрос сотруднику.
import { buildSnapshot } from '../api/snapshot.js';

const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Название в снимке — {ru, uz, en}; берём одну строку.
const one = (v) => {
  if (typeof v === 'string') return v;
  const o = obj(v);
  return str(o.ru) || str(o.uz) || str(o.en);
};

export function clinicFacts(db, now = Date.now()) {
  let s = {};
  try { s = obj(buildSnapshot(db, { storageDir: null, now }).snapshot); } catch { s = {}; }
  const c = obj(s.clinic);
  return {
    clinic: {
      name: one(c.name), phone: str(c.phone), address: one(c.street),
      website: str(c.site), telegram: str(c.telegram_bot), instagram: str(c.instagram),
    },
    branches: arr(s.branches).map((b) => ({
      name: one(b.name), address: [one(b.street), one(b.landmark)].filter(Boolean).join(', '),
      phone: str(b.phone), hours: b.hours || {}, open_24_7: !!b.open_24_7,
    })),
    doctors: arr(s.doctors).map((d) => ({
      name: one(d.name), specialties: arr(d.specialties),
      consultations: arr(d.consultations).map((k) => ({ name: str(k.name), price: Number(k.price) || 0 })),
    })),
    services: arr(s.services).map((x) => ({ name: one(x.name), group: str(x.group), price: Number(x.price) || 0 })),
    packages: arr(s.packages).map((p) => ({ name: one(p.name), price: Number(p.price) || 0 })),
  };
}
