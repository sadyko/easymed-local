// ADMISSION_DATE_EDIT_V1 — исправление даты поступления.
//
// Дата поступления — не справочное поле: из неё считаются койко-дни, а из них
// счёт за проживание. Поэтому правка живёт здесь, а не в /api/db: в реестре у
// admissions запись запрещена вовсе («money is server-computed»), и обходить это
// правило ради одного поля значило бы открыть таблицу целиком.
//
// Каждая правка попадает в журнал движения пациента: сумма могла вырасти, и
// должно остаться видно, кто её сдвинул и с какой даты на какую.

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Тот же круг, что кладёт пациента на койку: дату чаще всего поправляет тот же
// человек через минуту после поступления, и гонять его за администратором из-за
// опечатки — верный способ получить неверную дату навсегда. Злоупотребление
// ловится журналом: там видно и автора, и прежнее значение.
const EDIT_ROLES = ['admin', 'registrar', 'nurse', 'doctor'];

function requireRole(user, allowed) {
  const roles = [user && user.role, ...((user && user.extra_roles) || [])].filter(Boolean);
  if (!roles.some((r) => allowed.includes(r))) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

// Принимаем и 'YYYY-MM-DDTHH:MM' из <input type="datetime-local">, и полный ISO.
// Возвращаем канонический 'YYYY-MM-DDTHH:MM:SSZ' — в этом виде лежат все
// остальные времена, и сравнение строк остаётся честным.
function normalizeIso(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('Укажите дату поступления.', 400);
  }
  const raw = value.trim();
  // Без зоны — значит местное время из формы: браузер прислал то, что ввёл
  // человек, и трактовать это как UTC значило бы сдвинуть дату на 5 часов.
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
  const ms = Date.parse(hasZone ? raw : raw + 'Z');
  if (!Number.isFinite(ms)) throw new RpcError('Дата поступления указана неверно.', 400);
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

export function setAdmissionDate(db, args, user) {
  requireRole(user, EDIT_ROLES);
  const id = Number(args && args.admission_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('admission_id must be a positive integer.', 400);
  const next = normalizeIso(args && args.admitted_at);

  return db.transaction(() => {
    const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
    if (!adm) throw new RpcError('admission not found.', 400);

    const nowStr = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
    // Поступить завтра нельзя: срок ушёл бы в минус, а счёт — в ноль или в
    // отрицательные сутки.
    if (Date.parse(next) > Date.parse(nowStr)) {
      throw new RpcError('Дата поступления не может быть в будущем.', 400);
    }
    // Поступил позже, чем выписан, — это отрицательный срок пребывания.
    if (adm.discharged_at && Date.parse(next) > Date.parse(adm.discharged_at)) {
      throw new RpcError('Дата поступления не может быть позже выписки.', 400);
    }

    const prev = adm.admitted_at;
    db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(next, id);

    // Журнал движения: сумма могла измениться, и без записи объяснить это будет
    // нечем. kind='admitted_at' — своя строка, чтобы не путать с переводом.
    db.prepare(`
      INSERT INTO admission_transfers
        (admission_id, from_bed_id, to_bed_id, from_ward_id, to_ward_id, kind, reason, transferred_by)
      VALUES (?, ?, ?, ?, ?, 'admitted_at', ?, ?)
    `).run(id, adm.bed_id || null, adm.bed_id || null, adm.ward_id || null, adm.ward_id || null,
           `Дата поступления: ${prev} → ${next}`, (user && user.id) || null);

    return { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(id), previous: prev };
  })();
}
