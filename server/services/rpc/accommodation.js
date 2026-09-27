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
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';   // INPATIENT_MONEY_FIX_V1
import { notRefundReleasedSql, refundReleasedSql } from '../domain/pay-releases.js';   // V3120_FINAL

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
    throw new RpcError('Вашей роли это действие недоступно.', 403);
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
//
// V3120_FINAL — сутки, отпущенные со счёта С ВОЗВРАТОМ (pay-releases.js), тоже
// «уже выставлены»: пациенту за них вернули деньги, и кнопка не должна
// выставлять их снова как новые. Выставить их заново — явный выбор кассы.
function invoicedUnits(db, admissionId) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) n FROM admission_services s
       WHERE s.admission_id = ? AND s.notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
         AND (s.invoice_item_id IS NOT NULL OR ${refundReleasedSql('s')})`).get(admissionId);
  return Math.max(0, Number(r && r.n) || 0);
}
// Только то, что лежит в счёте (за этим стоят деньги): по нему правка даты и
// выписка задним числом отказывают «лишних N».
function inInvoiceUnits(db, admissionId) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) n FROM admission_services
       WHERE admission_id = ? AND notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
         AND invoice_item_id IS NOT NULL`).get(admissionId);
  return Math.max(0, Number(r && r.n) || 0);
}

// INPATIENT_MONEY_FIX_V1 — время из базы. Всё, что пишет сервер, лежит как
// 'YYYY-MM-DDTHH:MM:SSZ'; строка без зоны (SQLite datetime()) — тоже UTC, и
// читать её местным временем значило бы сдвинуть срок на часовой пояс.
function parseDbTime(v) {
  if (!v) return NaN;
  let s = String(v).trim().replace(' ', 'T');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return Date.parse(s);
}

// Режим и ставка одной койки: ставка койки с откатом на палату.
function rateOf(db, wardId, bedId) {
  const ward = wardId ? db.prepare('SELECT * FROM wards WHERE id = ?').get(wardId) : null;
  const bed = bedId ? db.prepare('SELECT * FROM beds WHERE id = ?').get(bedId) : null;
  const mode = ward && ward.billing_mode === 'hourly' ? 'hourly' : 'daily';
  const resolved = mode === 'daily'
    ? ((bed && bed.price_per_day > 0) ? bed.price_per_day : (ward ? ward.price_per_day : 0))
    : ((bed && bed.price_per_hour > 0) ? bed.price_per_hour : (ward ? ward.price_per_hour : 0));
  // Отрицательная ставка из кривой настройки не должна давать отрицательный счёт.
  const rate = Number.isFinite(resolved) && resolved > 0 ? resolved : 0;
  return { ward, bed, mode, rate };
}

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
// Сколько единиц набежало к моменту `offset` от поступления. Суточный режим —
// целые сутки (floor), почасовой — начатый час (ceil). Правило «сутки = целые
// 24 часа, но не меньше одних за всё пребывание» — вопрос владельцу, оставлен
// как есть: max(1, floor(часы / 24)).
const unitsAt = (mode, offset) => (mode === 'daily' ? Math.floor(offset / DAY_MS) : Math.ceil(offset / HOUR_MS));

// INPATIENT_MONEY_FIX_V1 (D3) — пребывание, разрезанное переводами.
//
// Перевод на другую койку раньше переоценивал ВЕСЬ срок по ставке новой
// койки: двое суток в общей палате и сутки в VIP выставлялись как трое суток
// VIP. Теперь срок режется по журналу движения (admission_transfers, kind
// 'transfer'), и каждый кусок идёт по ставке своей койки. Ставка койки берётся
// сегодняшняя: истории цен у коек нет.
function staySegments(db, adm, startMs, endMs) {
  const moves = db.prepare(`
    SELECT from_bed_id, to_bed_id, from_ward_id, to_ward_id, transferred_at
      FROM admission_transfers
     WHERE admission_id = ? AND kind = 'transfer'
     ORDER BY transferred_at, id`).all(adm.id);
  const segs = [];
  let bed = moves.length ? (moves[0].from_bed_id ?? adm.bed_id) : adm.bed_id;
  let ward = moves.length ? (moves[0].from_ward_id ?? adm.ward_id) : adm.ward_id;
  let from = startMs;
  for (const m of moves) {
    const t = parseDbTime(m.transferred_at);
    if (!Number.isFinite(t)) continue;
    const at = Math.min(Math.max(t, startMs), endMs);
    if (at > from) segs.push({ bed, ward, from, to: at });
    bed = m.to_bed_id ?? bed;
    ward = m.to_ward_id ?? ward;
    from = Math.max(from, at);
  }
  segs.push({ bed, ward, from, to: Math.max(from, endMs) });
  return segs;
}

// V3120_FIX — КАЖДЫЕ СУТКИ ПО КОЙКЕ, ГДЕ ПАЦИЕНТ ПРОВЁЛ БОЛЬШУЮ ИХ ЧАСТЬ.
//
// Раньше кусок пребывания получал единицы по отметкам «24 часа от
// поступления»: сутки доставались той койке, на которой пациент оказался в
// момент отметки. Двадцать минут в VIP через полночь отметки стоили полных VIP-
// суток, а ночь в VIP между отметками не стоила ничего (осмотр 2026-09-27, S9).
//
// Теперь срок режется на единицы от поступления: сутки k — это отрезок
// [поступление + k·24 ч, поступление + (k+1)·24 ч) (почасовой режим — час). Цена
// единицы — ставка койки, где пациент пробыл БОЛЬШЕ ВСЕГО внутри этого отрезка
// (время на одной койке складывается, даже если он на неё возвращался); при
// равенстве — койка, на которой он был позже. Число единиц не меняется:
// сутки — max(1, floor(часы / 24)) (правило владельца), часы — max(1, ceil).
// Хвост короче суток в счёт не идёт, как и раньше; одни-единственные сутки
// короткого пребывания — это весь его срок.
//
// Палаты с разным режимом (суточная и почасовая) в одном пребывании —
// редкость; у них остаётся прежний счёт по кускам: у суток и часа нет общей
// единицы, по которой можно было бы выбрать «большую часть».
function unitBlocks(db, admission, startMs, endMs) {
  const segs = staySegments(db, admission, startMs, endMs).map((s) => ({ ...s, ...rateOf(db, s.ward, s.bed) }));
  const one = (s) => ({ ward: s.ward, bed: s.bed, mode: s.mode, rate: s.rate,
    bedId: s.bed ? s.bed.id : null, wardId: s.ward ? s.ward.id : null });
  const modes = new Set(segs.map((s) => s.mode));
  const out = [];
  if (modes.size > 1) {
    for (const s of segs) {
      const n = Math.max(0, unitsAt(s.mode, s.to - startMs) - unitsAt(s.mode, s.from - startMs));
      for (let i = 0; i < n; i++) out.push(one(s));
    }
    if (!out.length) out.push(one(segs[0]));
    return out;
  }
  const mode = segs[0].mode;
  const unit = mode === 'daily' ? DAY_MS : HOUR_MS;
  const n = Math.max(1, unitsAt(mode, endMs - startMs));
  for (let k = 0; k < n; k++) {
    const from = startMs + k * unit;
    const to = Math.min(from + unit, endMs);
    const time = new Map();   // койка → { мс внутри единицы, последний кусок }
    segs.forEach((s, idx) => {
      const key = (s.bed ? s.bed.id : '-') + '|' + (s.ward ? s.ward.id : '-');
      const ms = Math.max(0, Math.min(s.to, to) - Math.max(s.from, from));
      const cur = time.get(key) || { ms: 0, idx: -1, seg: s };
      cur.ms += ms;
      if (ms > 0 || cur.idx < 0) { cur.idx = idx; cur.seg = s; }
      time.set(key, cur);
    });
    let best = null;
    for (const v of time.values()) {
      if (!best || v.ms > best.ms || (v.ms === best.ms && v.idx > best.idx)) best = v;
    }
    out.push(one(best.seg));
  }
  return out;
}

export function computeAccommodation(db, admission, opts = {}) {
  const current = rateOf(db, admission.ward_id, admission.bed_id);
  const storedPct = Number(admission.accommodation_discount_percent);
  const discountPct = Number.isFinite(storedPct) ? Math.min(100, Math.max(0, storedPct)) : 0;
  const billedUnits = invoicedUnits(db, admission.id);
  const invoicedOnly = inInvoiceUnits(db, admission.id);   // V3120_FINAL

  // INPATIENT_MONEY_FIX_V1 (D4) — за койку платит тот, кто на ней ЛЕЖАЛ.
  // Заявка без койки ('ordered') и отменённая госпитализация проживания не
  // дают вовсе (раньше им выставлялись сутки); выписанному срок кончается
  // выпиской, а не «сейчас» — иначе каждый день после ухода добавлял сутки.
  const nowMs = Date.parse(db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t);
  const startMs = parseDbTime(admission.admitted_at);
  let endMs = null, blocked = null;
  if (admission.status === 'cancelled') blocked = 'cancelled';
  else if (IN_BED_STATUSES.includes(admission.status)) {
    // V3120_FIX — выписка с указанным временем считает срок ДО него, а не до
    // «сейчас»: медсестра оформляет в 16:00 выписку, случившуюся в 12:00.
    const until = Number(opts && opts.endMs);
    endMs = Number.isFinite(until) ? Math.min(until, nowMs) : nowMs;
  }
  else if (admission.status === 'discharged') {
    const d = parseDbTime(admission.discharged_at);
    endMs = Number.isFinite(d) ? Math.min(d, nowMs) : nowMs;
  } else blocked = 'not_in_bed';
  if (!Number.isFinite(startMs) && !blocked) blocked = 'not_in_bed';

  if (blocked) {
    return { ward: current.ward, bed: current.bed, mode: current.mode, rate: current.rate, units: 0, stayUnits: 0,
      billedUnits, invoicedUnits: invoicedOnly, gross: 0, net: 0, stayGross: 0, discountPct, blocked, segments: [] };
  }

  const blocks = unitBlocks(db, admission, startMs, Math.max(startMs, endMs));
  const stayUnits = blocks.length;
  // Весь срок деньгами (без скидки) — для прямой выписки v0.8.0, которая
  // называет сумму за всё пребывание тем же правилом (V3120_FIX).
  const stayGross = round2(blocks.reduce((n, b) => n + b.rate, 0));

  // Выставленные единицы — самые ранние: счёт идёт за сутками по порядку.
  // Остаток собирается в куски подряд идущих суток одной койки — они и
  // попадают в описание строки (NOTE).
  let dueUnits = 0, gross = 0;
  const dueParts = [];
  for (const b of blocks.slice(Math.min(billedUnits, blocks.length))) {
    dueUnits += 1;
    gross += b.rate;
    const last = dueParts[dueParts.length - 1];
    if (last && last.bedId === b.bedId && last.wardId === b.wardId && last.rate === b.rate && last.mode === b.mode) last.units += 1;
    else dueParts.push({ ward: b.ward, bed: b.bed, mode: b.mode, rate: b.rate, units: 1, bedId: b.bedId, wardId: b.wardId });
  }
  for (const part of dueParts) { delete part.bedId; delete part.wardId; }
  gross = round2(gross);
  if (!Number.isFinite(gross) || gross > MAX_MONEY) {
    throw new RpcError('Сумма проживания получилась слишком большой — проверьте ставки палаты и дату поступления.', 400);
  }
  const net = round2(gross * (1 - discountPct / 100));
  // Ставка строки: на одной койке — её ставка; на нескольких — средняя, а
  // разбивка по койкам идёт в описание строки (NOTE).
  const rate = dueParts.length === 1 ? dueParts[0].rate
    : (dueUnits > 0 ? round2(gross / dueUnits) : current.rate);
  // units/gross/net — это ОСТАТОК: именно его вносят кнопкой и показывают на
  // экране. Полный срок отдаётся отдельно (stayUnits), чтобы карточка могла
  // сказать «лежит 3 сут., выставлено 1, к оплате 2».
  return { ward: current.ward, bed: current.bed, mode: current.mode, rate, units: dueUnits, stayUnits, billedUnits,
    invoicedUnits: invoicedOnly, gross, net, stayGross, discountPct, blocked: null, segments: dueParts };
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
    `SELECT * FROM admission_services s
       WHERE s.admission_id = ? AND s.notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
         AND s.invoice_item_id IS NULL AND ${notRefundReleasedSql('s')}
       ORDER BY s.id DESC LIMIT 1`
  ).get(admissionId);
}

// INPATIENT_MONEY_FIX_V1 (D2) — ВСЕ открытые строки проживания. Их бывает
// больше одной: отмена счёта в кассе отпускает выставленную строку обратно в
// невыставленные (cashier.js, ADM_LINE_RELEASE_V1), а рядом уже лежит новая.
// Прежде обновлялась только последняя — на ВЕСЬ остаток срока, — и отпущенные
// сутки оказывались в счёте дважды (1 + 3 = 400 000 за трое суток).
function openAccommodationLines(db, admissionId) {
  return db.prepare(
    `SELECT * FROM admission_services s
       WHERE s.admission_id = ? AND s.notes LIKE '${ACCOMMODATION_NOTE_PREFIX}%'
         AND s.invoice_item_id IS NULL AND ${notRefundReleasedSql('s')}
       ORDER BY s.id`
  ).all(admissionId);
}

const unitWord = (mode) => (mode === 'daily' ? 'сут.' : 'ч.');
const NOTE = (c) => {
  const parts = c.segments && c.segments.length ? c.segments : [{ ward: c.ward, bed: c.bed, mode: c.mode, rate: c.rate, units: c.units }];
  return `${ACCOMMODATION_NOTE_PREFIX} · `
    + parts.map((p) => `${p.ward ? p.ward.name : ''}${p.bed ? ' · койка ' + p.bed.code : ''} · ${p.units} ${unitWord(p.mode)} × ${p.rate}`).join(' + ')
    + `${c.discountPct ? ' · скидка ' + c.discountPct + '%' : ''}`;
};

// Почему проживание не начисляется — словами для экрана.
function blockedMessage(c) {
  if (c.blocked === 'cancelled') return 'Госпитализация отменена — проживание не начисляется.';
  if (c.blocked === 'not_in_bed') return 'Пациент ещё не размещён на койке — проживание не начисляется.';
  return null;
}

// Внести проживание в счёт госпитализации (или обновить уже внесённое).
//
// Повторный вызов НЕ плодит строки: проживание одно на госпитализацию, а
// пересчёт — это то же самое проживание за больший срок.
export function billAccommodation(db, args, user) {
  requireRole(user, BILL_ROLES);
  const id = Number(args && args.admission_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана госпитализация.', 400);
  return db.transaction(() => billAccommodationCore(db, id))();
}

// V3120_FIX — то же внесение без проверки роли и с концом срока на выбор:
// оформление выписки с долгом доначисляет проживание ДО ФАКТИЧЕСКОГО ВРЕМЕНИ
// выписки (opts.endMs), и право там уже проверено маршрутом выписки. С
// opts.quiet «вносить нечего» — не ошибка, а null: выписке нечего доначислять.
export function billAccommodationCore(db, id, opts = {}) {
  const quiet = !!(opts && opts.quiet);
  const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
  if (!adm) throw new RpcError('Госпитализация не найдена.', 400);

  const c = computeAccommodation(db, adm, opts);
  if (c.blocked) { if (quiet) return null; throw new RpcError(blockedMessage(c), 400); }
  // Только открытые строки: выставленные сюда не попадают. Остаток срока
  // пишется в ОДНУ из них (последнюю), остальные удаляются — они и так
  // входят в этот остаток, потому что не выставлены (D2).
  const open = openAccommodationLines(db, id);
  // V3120_FINAL — opts.refreshOnly: только привести УЖЕ внесённое к сроку
  // (правка даты поступления, выписка задним числом), но не вносить нового —
  // «не внесли — не выставили» (ACCOMMODATION_AS_SERVICE_V1).
  if (opts && opts.refreshOnly && !open.length) return null;
  // V3120_FINAL (I4) — ВНОСИТЬ НЕЧЕГО, А ОТКРЫТАЯ СТРОКА ЛЕЖИТ. Срок стал
  // короче (дату поступления сдвинули позже, выписка задним числом), и сутки,
  // внесённые раньше, по новому сроку не наступали. Прежде строка оставалась
  // как была — и следующий счёт (выписка со счётом, касса, долг) выставлял
  // её: 400 000 за одни сутки. Невыставленная строка — ещё не деньги, её
  // снимают здесь же; бесплатная теперь койка — так же.
  if (c.units <= 0 || !(c.net > 0)) {
    for (const l of open) db.prepare('DELETE FROM admission_services WHERE id = ?').run(l.id);
    if (open.length) return { line: null, removed: open.length, updated: true };
  }
  // ACCOMMODATION_DAILY_V1 — весь срок уже оплачен вперёд: вносить нечего.
  // Это не ошибка настройки, а нормальный конец дня, поэтому и текст другой.
  if (c.units <= 0) {
    if (quiet) return null;
    throw new RpcError('За этот срок проживание уже выставлено — новых суток пока нет.', 400);
  }
  // Бесплатная койка не создаёт строку на ноль: пустая позиция в счёте только
  // путает кассира, а «не берём денег» и так выражается тем, что строки нет.
  if (!(c.net > 0)) {
    if (quiet) return null;
    throw new RpcError('Ставка проживания нулевая — вносить в счёт нечего.', 400);
  }

  const existing = open.length ? open[open.length - 1] : null;
  for (const extra of open.slice(0, -1)) {
    db.prepare('DELETE FROM admission_services WHERE id = ?').run(extra.id);
  }

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
}

// V3120_FIX — СКОЛЬКО ПРОЖИВАНИЯ ЕЩЁ НЕ ВОШЛО В ОСТАТОК. admissionBalance видит
// только строки; сутки без строки (или открытая строка, устаревшая с момента
// внесения) — это разница между расчётом на конец срока и тем, что уже лежит
// открытыми строками. Её показывает окно выписки и добавляет выписка с долгом.
export function accommodationGapOf(db, adm, opts = {}) {
  const c = computeAccommodation(db, adm, opts);
  if (c.blocked || c.units <= 0 || !(c.net > 0)) return { units: 0, amount: 0, mode: c.mode };
  const open = openAccommodationLines(db, adm.id);
  const openUnits = open.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const openSum = open.reduce((n, l) => n + (Number(l.total) || 0), 0);
  return { units: Math.max(0, c.units - openUnits), amount: round2(c.net - openSum), mode: c.mode };
}

// Убрать внесённое проживание — пока оно не попало в счёт. За выставленной
// строкой уже стоят деньги, и снимать её должна касса своим путём, иначе счёт и
// стационар разойдутся.
export function unbillAccommodation(db, args, user) {
  requireRole(user, BILL_ROLES);
  const id = Number(args && args.admission_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана госпитализация.', 400);

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
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана госпитализация.', 400);
  const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
  if (!adm) throw new RpcError('Госпитализация не найдена.', 400);

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
    // INPATIENT_MONEY_FIX_V1 — почему начислять нечего (заявка без койки,
    // отменённая госпитализация); null — начисляется как обычно.
    blocked: c.blocked ? blockedMessage(c) : null,
    billed: line ? { id: line.id, units: line.quantity, rate: line.unit_price, total: line.total, invoiced: !!line.invoice_item_id } : null,
    // Снимок устарел — сумма выросла с момента внесения. Экран показывает это
    // и предлагает обновить: иначе клиника молча недосчитается денег.
    stale: !!(line && !line.invoice_item_id && round2(line.total) !== round2(c.net)),
  };
}
