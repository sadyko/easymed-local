// RX_TEMPLATES_V1 (2026-10-02) — rx_my_drugs: «СВОИ» ПРЕПАРАТЫ ВРАЧА.
//
// Владелец: «we need to add in to a doctors cabinet the reciept saving option
// for the drugs», решение «Both»: шаблоны целого рецепта (consultation_templates,
// doc_type '3') и подсказки своих препаратов при вводе названия — у каждого
// врача свои. Источник подсказок номер один — этот RPC: препараты из рецептов,
// которые ВРАЧ уже сохранял в кабинете.
//
// Рецепт приёма лежит в visit_services.notes (JSON кабинета, ключ
// prescriptions: [{ name, dose, freq, dur, notes, nurse }]) — отдельной таблицы
// назначений нет, и заводить её ради подсказок незачем: список складывается сам
// из работы врача, «избранное» руками никто не ведёт.
//
// Правила:
//   • только СВОИ строки: visit_services.doctor_id = я (номер — из сессии,
//     аргументы его не задают);
//   • звать может врач (роль или «Врач» в карточке, is_doctor) или администратор;
//   • один препарат — одна строка, без учёта регистра и пробелов по краям;
//     самые частые первыми, при равенстве — по алфавиту;
//   • доза, частота и длительность — из ПОСЛЕДНЕГО рецепта с этим препаратом:
//     врач меняет схему, и подсказка должна предлагать нынешнюю;
//   • не больше 200 строк (меньше — если экран попросил limit);
//   • сломанная запись (не JSON, не массив, пустое название) пропускается молча:
//     подсказка — удобство, и одна кривая строка не должна гасить весь список.
//
// Только чтение: стоит в READ_ONLY_RPCS (control/gate.js).
import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const MAX_ROWS = 200;
// Сколько последних строк врача с рецептом разбирать. Подсказке хватает
// недавней работы; без предела врач с десятью годами приёмов разбирал бы всё.
const SCAN_LIMIT = 5000;

const clip = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);

export function rxMyDrugs(db, args, user) {
  const me = user && Number.isInteger(Number(user.id)) ? Number(user.id) : 0;
  if (!me) throw new RpcError('Подсказки препаратов — только врачу или администратору.', 403);
  let allowed = hasAnyRole(user, ['doctor', 'admin']);
  if (!allowed) {
    const row = db.prepare('SELECT is_doctor FROM users WHERE id = ?').get(me);
    allowed = !!(row && Number(row.is_doctor) === 1);
  }
  if (!allowed) throw new RpcError('Подсказки препаратов — только врачу или администратору.', 403);

  const want = Number(args && args.limit);
  const limit = Number.isInteger(want) && want > 0 ? Math.min(want, MAX_ROWS) : MAX_ROWS;

  // Новые строки первыми: первая встреча препарата — его последний рецепт.
  const rows = db.prepare(`
    SELECT notes FROM visit_services
     WHERE doctor_id = ? AND notes LIKE '%"prescriptions":[{%'
     ORDER BY id DESC
     LIMIT ${SCAN_LIMIT}
  `).all(me);

  const byKey = new Map();
  for (const r of rows) {
    let parsed = null;
    try { parsed = JSON.parse(r.notes); } catch { continue; }
    const list = parsed && Array.isArray(parsed.prescriptions) ? parsed.prescriptions : null;
    if (!list) continue;
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const name = clip(p.name);
      if (!name) continue;
      const key = name.toLowerCase();
      const seen = byKey.get(key);
      if (seen) { seen.count += 1; continue; }
      byKey.set(key, { name, dose: clip(p.dose), freq: clip(p.freq), dur: clip(p.dur), count: 1 });
    }
  }
  const out = [...byKey.values()].sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'ru'));
  return { rows: out.slice(0, limit) };
}
