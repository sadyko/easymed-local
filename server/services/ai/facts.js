// AI_CHAT_V1 — что ИИ знает о клинике. Источник — buildSnapshot
// (services/api/snapshot.js): тот же белый список, что клиника отдаёт
// партнёрам, проверенный snapshot.test.js по всем ключам. Пациентов, визитов,
// сотрудников (кроме показанных врачей) и ключей в нём нет. Здесь снимок только
// сжимается до того, что нужно для ответа, — медиа и служебные поля отброшены.
import { buildSnapshot } from '../api/snapshot.js';

const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function clinicFacts(db, now = Date.now()) {
  const { snapshot } = buildSnapshot(db, { storageDir: null, now });
  const s = pick(snapshot);
  return {
    clinic: pick(s.clinic),
    branches: Array.isArray(s.branches) ? s.branches : [],
    doctors: (Array.isArray(s.doctors) ? s.doctors : []).map((d) => ({
      name: d.name, specialties: d.specialties || [], branch_ids: d.branch_ids || [], languages: d.languages || [],
    })),
    services: (Array.isArray(s.services) ? s.services : []).map((x) => ({ id: x.id, group: x.group, name: x.name, price: x.price })),
    packages: (Array.isArray(s.packages) ? s.packages : []).map((p) => ({ name: p.name, price: p.price, price_full: p.price_full })),
  };
}
