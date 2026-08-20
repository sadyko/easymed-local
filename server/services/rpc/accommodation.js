// ACCOMMODATION_AS_SERVICE_V1 — проживание в палате как обычная услуга стационара.
//
// Раньше выписка сама считала койко-дни и, если сумма выходила больше нуля,
// молча создавала ОТДЕЛЬНЫЙ счёт за проживание. У клиники не было способа не
// брать за койку денег: оставалось ставить скидку 100% или править счёт после
// выписки, а сам платёж жил в стороне от остальной госпитализации.
//
// Теперь проживание вносят кнопкой, и оно становится строкой admission_services
// — такой же, как процедура или расходник, — а значит уходит в ОДИН счёт
// госпитализации через create_invoice_for_admission. Не внесли — не выставили.
//
// Сумма — снимок на момент внесения: проживание дорожает каждый день, и строка
// не пересчитывается сама. Повторное нажатие обновляет её до текущего срока
// (см. billAccommodation), а экран показывает, что снимок устарел.

// Метка строки — общая с браузером: её пишет сервер, а читает список услуг
// стационара. Одна копия на оба конца (см. shared/accommodation-line.js).
import { ACCOMMODATION_NOTE_PREFIX } from '../../../public/js/shared/accommodation-line.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Кто ведёт стационар, тот и вносит проживание — тот же круг, что кладёт
// пациента на койку. Касса тоже: она собирает счёт и должна иметь возможность
// доложить забытую строку, не дёргая отделение.
const BILL_ROLES = ['admin', 'registrar', 'nurse', 'doctor', 'cashier'];

const MAX_MONEY = 1e12;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function requireRole(user, allowed) {
  const roles = [user && user.role, ...((user && user.extra_roles) || [])].filter(Boolean);
  if (!roles.some((r) => allowed.includes(r))) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

// Та же арифметика, что и в inpatient.js: режим палаты, ставка койки с откатом
// на палату, и «первые сутки считаются целиком».
//
// ВАЖНО: правило одно на всю систему, поэтому оно живёт здесь и вызывается из
// выписки тоже — две копии разошлись бы, и экран показывал бы одно, а счёт нёс
// другое. Ровно так уже случалось с датой рождения и очередью.
// ACCOMMODATION_DAILY_V1 — сутки, за которые УЖЕ выставили счёт.
//
// Клиника берёт за койку по дням: пациент оплатил первые сутки, назавтра ему
// выставляют вторые. Значит вносить надо ОСТАТОК, а не весь срок заново —
// иначе второй счёт повторил бы первый.
function invoicedUnits(db, admissionId) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) n FROM admission_services
       WHERE admission_id = ? AND notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
         AND invoice_item_id IS NOT NULL`).get(admissionId);
  return Math.max(0, Number(r && r.n) || 0);
}

export function computeAccommodation(db, admission) {
  const ward = admission.ward_id ? db.prepare('SELECT * FROM wards WHERE id = ?').get(admission.ward_id) : null;
  const bed = admission.bed_id ? db.prepare('SELECT * FROM beds WHERE id = ?').get(admission.bed_id) : null;

  const mode = ward && ward.billing_mode === 'hourly' ? 'hourly' : 'daily';
  const resolved = mode === 'daily'
    ? ((bed && bed.price_per_day > 0) ? bed.price_per_day : (ward ? ward.price_per_day : 0))
    : ((bed && bed.price_per_hour > 0) ? bed.price_per_hour : (ward ? ward.price_per_hour : 0));
  // Отрицательная ставка из кривой настройки не должна давать отрицательный счёт.
  const rate = Number.isFinite(resolved) && resolved > 0 ? resolved : 0;

  const nowStr = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
  let ms = Date.parse(nowStr) - Date.parse(admission.admitted_at);
  if (!(ms >= 0)) ms = 0;

  let units;
  if (mode === 'daily') {
    let days = Math.floor(ms / 86400000) + 1;
    if (days > 1) days -= 1;
    units = Math.max(1, days);
  } else {
    units = Math.max(1, Math.ceil(ms / 3600000));
  }

  const storedPct = Number(admission.accommodation_discount_percent);
  const discountPct = Number.isFinite(storedPct) ? Math.min(100, Math.max(0, storedPct)) : 0;

  // Всего пациент пролежал stayUnits, из них billedUnits уже в счетах.
  // Считаем и выставляем только разницу.
  const stayUnits = units;
  const billedUnits = invoicedUnits(db, admission.id);
  const dueUnits = Math.max(0, stayUnits - billedUnits);

  const gross = round2(dueUnits * rate);
  if (!Number.isFinite(gross) || gross > MAX_MONEY) {
    throw new RpcError('computed accommodation charge is too large.', 400);
  }
  const net = round2(gross * (1 - discountPct / 100));
  // units/gross/net — это ОСТАТОК: именно его вносят кнопкой и показывают на
  // экране. Полный срок отдаётся отдельно (stayUnits), чтобы карточка могла
  // сказать «лежит 3 сут., выставлено 1, к оплате 2».
  return { ward, bed, mode, rate, units: dueUnits, stayUnits, billedUnits, gross, net, discountPct };
}

// Проживание узнаётся по notes-метке: своего типа у admission_services нет, а
// заводить ради одной строки колонку в живой таблице — дороже, чем метка.
//
// ACCOMMODATION_DAILY_V1 — ОТКРЫТАЯ строка, то есть ещё не попавшая в счёт.
// Раньше запрос брал первую попавшуюся (LIMIT 1 без условия), и после первого
// же выставленного счёта находил именно её: второй день упирался в «уже в
// счёте» и не выставлялся никогда. Выставленные строки трогать нельзя — за
// ними деньги, — но и мешать новым они не должны.
function accommodationLine(db, admissionId) {
  return db.prepare(
    `SELECT * FROM admission_services
       WHERE admission_id = ? AND notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
         AND invoice_item_id IS NULL
       ORDER BY id DESC LIMIT 1`
  ).get(admissionId);
}

const NOTE = (c) => `${ACCOMMODATION_NOTE_PREFIX} · ${c.ward ? c.ward.name : ''}`
  + `${c.bed ? ' · койка ' + c.bed.code : ''} · ${c.units} ${c.mode === 'daily' ? 'сут.' : 'ч.'} × ${c.rate}`
  + `${c.discountPct ? ' · скидка ' + c.discountPct + '%' : ''}`;

// Внести проживание в счёт госпитализации (или обновить уже внесённое).
//
// Повторный вызов НЕ плодит строки: проживание одно на госпитализацию, а
// пересчёт — это то же самое проживание за больший срок.
export function billAccommodation(db, args, user) {
  requireRole(user, BILL_ROLES);
  const id = Number(args && args.admission_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('admission_id must be a positive integer.', 400);

  return db.transaction(() => {
    const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
    if (!adm) throw new RpcError('admission not found.', 400);

    const c = computeAccommodation(db, adm);
    // ACCOMMODATION_DAILY_V1 — весь срок уже оплачен вперёд: вносить нечего.
    // Это не ошибка настройки, а нормальный конец дня, поэтому и текст другой.
    if (c.units <= 0) {
      throw new RpcError('За этот срок проживание уже выставлено — новых суток пока нет.', 400);
    }
    // Бесплатная койка не создаёт строку на ноль: пустая позиция в счёте только
    // путает кассира, а «не берём денег» и так выражается тем, что строки нет.
    if (!(c.net > 0)) {
      throw new RpcError('Ставка проживания нулевая — вносить в счёт нечего.', 400);
    }

    // Только открытая строка: выставленную accommodationLine уже не вернёт.
    const existing = accommodationLine(db, id);

    if (existing) {
      db.prepare(`UPDATE admission_services
                     SET ward_id = ?, bed_id = ?, quantity = ?, unit_price = ?, total = ?, notes = ?
                   WHERE id = ?`)
        .run(c.ward ? c.ward.id : null, c.bed ? c.bed.id : null, c.units, c.rate, c.net, NOTE(c), existing.id);
      return { line: db.prepare('SELECT * FROM admission_services WHERE id = ?').get(existing.id), updated: true };
    }

    const info = db.prepare(`
      INSERT INTO admission_services
        (admission_id, service_id, ward_id, bed_id, quantity, unit_price, total, status, notes, billable)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'added', ?, 1)
    `).run(id, c.ward ? c.ward.id : null, c.bed ? c.bed.id : null, c.units, c.rate, c.net, NOTE(c));

    return { line: db.prepare('SELECT * FROM admission_services WHERE id = ?').get(info.lastInsertRowid), updated: false };
  })();
}

// Убрать внесённое проживание — пока оно не попало в счёт. За выставленной
// строкой уже стоят деньги, и снимать её должна касса своим путём, иначе счёт и
// стационар разойдутся.
export function unbillAccommodation(db, args, user) {
  requireRole(user, BILL_ROLES);
  const id = Number(args && args.admission_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('admission_id must be a positive integer.', 400);

  return db.transaction(() => {
    // ACCOMMODATION_DAILY_V1 — accommodationLine отдаёт только ОТКРЫТУЮ строку,
    // поэтому «убрать» физически не может задеть выставленную. Но молчать в
    // ответ нельзя: если открытой строки нет, а выставленная есть — человек
    // просит убрать именно её, и он должен услышать почему нет, а не увидеть,
    // что кнопка ничего не сделала.
    const line = accommodationLine(db, id);
    if (!line) {
      const invoiced = db.prepare(
        `SELECT id FROM admission_services
           WHERE admission_id = ? AND notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
             AND invoice_item_id IS NOT NULL LIMIT 1`).get(id);
      if (invoiced) {
        throw new RpcError('Проживание уже в счёте — уберите его через кассу.', 400);
      }
      return { removed: false };
    }
    db.prepare('DELETE FROM admission_services WHERE id = ?').run(line.id);
    return { removed: true };
  })();
}

// Что показывать на карточке: расчёт на сейчас + что уже внесено.
export function accommodationState(db, args, user) {
  requireRole(user, [...BILL_ROLES, 'lab']);   // смотреть можно всем, кто видит палату
  const id = Number(args && args.admission_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('admission_id must be a positive integer.', 400);
  const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
  if (!adm) throw new RpcError('admission not found.', 400);

  const c = computeAccommodation(db, adm);
  const line = accommodationLine(db, id);
  // Сколько денег уже ушло в счета за проживание — карточке нужно показать это
  // рядом с остатком, иначе «к оплате 250 000» на третьи сутки выглядит как
  // потеря двух дней.
  const inv = db.prepare(
    `SELECT COALESCE(SUM(quantity),0) units, COALESCE(SUM(total),0) total
       FROM admission_services
      WHERE admission_id = ? AND notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
        AND invoice_item_id IS NOT NULL`).get(id);
  return {
    stay_units: c.stayUnits,
    invoiced: { units: Number(inv.units) || 0, total: round2(inv.total) },
    current: { units: c.units, rate: c.rate, gross: c.gross, net: c.net, mode: c.mode, discount_pct: c.discountPct },
    billed: line ? { id: line.id, units: line.quantity, rate: line.unit_price, total: line.total, invoiced: !!line.invoice_item_id } : null,
    // Снимок устарел — сумма выросла с момента внесения. Экран показывает это
    // и предлагает обновить: иначе клиника молча недосчитается денег.
    stale: !!(line && !line.invoice_item_id && round2(line.total) !== round2(c.net)),
  };
}
