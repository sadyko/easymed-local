// ═══════════════════════════════════════════════════════════════════════════
// CRM_UNIFY_V1 (2026-10-09) — РАЗОВОЕ ИСПРАВЛЕНИЕ (решение владельца 5, Р19)
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «застрявшие карточки исправить один раз при установке обновления;
// двигаются только однозначные случаи; счета не меняются». До CRM_UNIFY_V1
// оплативший пациент оставался в «Записан» или уезжал в «Не пришёл» (обход доски
// не видел денег), а задача оставалась у оператора, которому карточку уже не
// видно. Исправляем ОДИН раз — при первом запуске после миграции 238, до первого
// прохода «Не пришёл» (server/index.js).
//
// КАРТОЧКИ → КОНВЕРСИЯ (wonStageKey — колонка, выбранная в настройках):
//   • карточка в живой колонке или в сидовой «Не пришёл», с пациентом;
//   • её ДНИ ЗАПИСИ: дата карточки; дни живых визитов, которые держат её строки
//     (кроме снятых); дни живых визитов её привязки записи (crm_booking_links,
//     Р9). Только дни не позже сегодня и не раньше дня, когда карточку завели
//     (день до карточки — не её запись);
//   • в один из этих дней у пациента есть живой визит с НЕСОМНЕННЫМ приходом
//     (cameSurely, crm/no-show.js — строгая пара cameBy): отметка «Пришёл»,
//     работа над услугой, платёж в день визита или позже, счёт по акту или долг,
//     выставленные в день визита или позже. Предоплата, товар, талон, старые
//     закрытые строки, неоплаченный счёт — не несомненны: не двигают.
// Никогда: проигрышные («Отказ», «Нецелевой»), конверсия, карточки без пациента
// (дня записи у лида с одним номером нет), всё, что не прошло правило выше.
//
// ЗАДАЧИ: у каждой карточки с хозяином — moveTasksWithLead(db, id, { to: хозяин })
// (crm/tasks-follow.js, правило «может вести карточку»): открытые задачи без
// исполнителя и тех, кто эту карточку вести не может, — хозяину. Хозяин сам вести
// её не может (уволен, кассир) — ничего. Задачи тех, кто её ведёт, остаются.
//
// ЧТО МЕНЯЕТСЯ — ТОЛЬКО crm_requests.status И crm_tasks.assignee_id.
//   • updated_at карточек НЕ трогается (как у переноса конверсии): окно
//     повторного обращения (contact-window.js) не должно счесть историю свежим
//     контактом;
//   • визиты, счета, платежи, строки визита и строки заявки — нет. В частности
//     строки заявки не закрываются ('done' — только со строкой визита, инвариант
//     правила прихода, crm/visit-status.js) и старые 'done' не «чинятся».
// Каждое изменение — строка crm_unify_repair_log; итог — в crm_unify_repair и
// одной строкой в журнал сервера.
//
// ОДИН РАЗ И ЦЕЛИКОМ: правки, журнал и отметка — одна транзакция. Упал — нет ни
// правок, ни отметки, и следующий запуск повторит всё один раз. Повтор по уже
// исправленному ничего не находит и без отметки (карточка уже в конверсии,
// задача уже у хозяина).
//
// ЗДАНИЯ: карточки и задачи соседям не ездят — каждое здание исправляет свои.
// Приход в соседнем здании (визит с sync_origin, приехавший порцией обмена)
// считается тем же правилом cameSurely — по его статусу, строкам, счёту и
// платежам.
import { openStageKeys, wonStageKey, SEED_NO_SHOW_STAGE } from './config.js';
import { cameSurely } from './no-show.js';
import { moveTasksWithLead } from './tasks-follow.js';
import { localDate, today } from '../domain/day.js';

const holes = (a) => a.map(() => '?').join(',');
const LIVE = "v.status NOT IN ('cancelled', 'no_show')";
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const RACED = Symbol('crm-unify-repair-raced');

function repairCards(db, d0, out, log) {
  const won = wonStageKey(db);
  const from = [...new Set([...openStageKeys(db), SEED_NO_SHOW_STAGE])].filter((k) => k !== won);
  if (!from.length) return;
  const cards = db.prepare(`SELECT id, status, patient_id, scheduled_date, ${localDate('created_at')} AS born
                              FROM crm_requests WHERE patient_id IS NOT NULL AND status IN (${holes(from)}) ORDER BY id`).all(...from);
  if (!cards.length) return;

  // Дни записи по строкам и по привязке — два прохода по таблицам, а не по запросу на карточку.
  const daysOf = new Map();
  const add = (rid, d) => { if (!daysOf.has(rid)) daysOf.set(rid, new Set()); daysOf.get(rid).add(d); };
  for (const r of db.prepare(`SELECT l.request_id AS rid, ${localDate('v.visit_date')} AS d
                                FROM crm_request_services l JOIN visits v ON v.id = l.visit_id
                               WHERE l.status <> 'cancelled' AND ${LIVE}`).all()) add(r.rid, r.d);
  try {
    for (const r of db.prepare(`SELECT b.request_id AS rid, ${localDate('v.visit_date')} AS d
                                  FROM crm_booking_links b JOIN visits v ON v.id = b.visit_id WHERE ${LIVE}`).all()) add(r.rid, r.d);
  } catch { /* сборка без 187 */ }

  const visitsOn = db.prepare(`SELECT v.id, v.status, ${localDate('v.visit_date')} AS day FROM visits v
                                WHERE v.patient_id = ? AND ${localDate('v.visit_date')} = date(?) AND ${LIVE}`);
  const proven = new Map();   // «пациент|день» → был ли несомненный приход
  const cameOn = (pid, d) => {
    const k = pid + '|' + d;
    if (!proven.has(k)) proven.set(k, visitsOn.all(pid, d).some((v) => cameSurely(db, v)));
    return proven.get(k);
  };
  const setWon = db.prepare('UPDATE crm_requests SET status = ? WHERE id = ? AND status = ?');   // updated_at — нет
  for (const c of cards) {
    const days = new Set(daysOf.get(c.id) || []);
    const own = String(c.scheduled_date || '').slice(0, 10);
    if (own) days.add(own);
    const hit = [...days].some((d) => isDay(d) && d <= d0 && (!c.born || d >= c.born) && cameOn(c.patient_id, d));
    if (!hit || !setWon.run(won, c.id, c.status).changes) continue;
    log.run('card', c.id, null, c.status, won);
    if (c.status === SEED_NO_SHOW_STAGE) out.noShows++; else out.cards++;
  }
}

function repairTasks(db, out, log) {
  const owned = db.prepare(`SELECT DISTINCT r.id, r.assigned_to FROM crm_requests r
                              JOIN crm_tasks t ON t.request_id = r.id AND t.done_at IS NULL
                             WHERE r.assigned_to IS NOT NULL ORDER BY r.id`).all();
  const openTasks = db.prepare('SELECT id, assignee_id FROM crm_tasks WHERE request_id = ? AND done_at IS NULL ORDER BY id');
  for (const r of owned) {
    const before = new Map(openTasks.all(r.id).map((x) => [x.id, x.assignee_id]));
    if (!moveTasksWithLead(db, r.id, { to: r.assigned_to })) continue;
    for (const x of openTasks.all(r.id)) {
      const was = before.get(x.id);
      if (was === x.assignee_id) continue;
      log.run('task', r.id, x.id, was == null ? null : String(was), String(x.assignee_id));
      out.tasks++;
    }
  }
}

/** Одна строка для журнала сервера. */
function summaryOf(out) {
  return `CRM: разовое исправление — карточек в конверсию: ${out.cards}, из «Не пришёл» в конверсию: ${out.noShows}, `
    + `задач передано оператору карточки: ${out.tasks} (${out.ms} мс).`;
}

/**
 * Разовое исправление. Не бросает.
 * @returns {{skipped:boolean, failed:boolean, cards:number, noShows:number, tasks:number, ms:number, summary:string|null}}
 *   skipped — уже сделано (или база без 238): ничего не тронуто;
 *   failed  — упало и откатилось: ничего не тронуто, повторится при следующем запуске.
 */
export function crmUnifyRepair(db, { day = null } = {}) {
  const t0 = Date.now();
  const zero = { skipped: false, failed: false, cards: 0, noShows: 0, tasks: 0, ms: 0, summary: null };
  let mark = null;
  try { mark = db.prepare('SELECT done_at FROM crm_unify_repair WHERE id = 1').get(); } catch { mark = null; }
  if (!mark || mark.done_at) return { ...zero, skipped: true };
  const out = { ...zero };
  try {
    db.transaction(() => {
      const log = db.prepare('INSERT INTO crm_unify_repair_log (kind, request_id, task_id, from_value, to_value) VALUES (?, ?, ?, ?, ?)');
      repairCards(db, day || today(db), out, log);
      repairTasks(db, out, log);
      const done = db.prepare(`UPDATE crm_unify_repair SET done_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                                       cards = ?, no_shows = ?, tasks = ? WHERE id = 1 AND done_at IS NULL`)
        .run(out.cards, out.noShows, out.tasks);
      if (!done.changes) throw RACED;   // отметку поставил другой запуск — откатить своё
    })();
  } catch (e) {
    if (e === RACED) return { ...zero, skipped: true, ms: Date.now() - t0 };
    console.error('[crm-unify-repair] не выполнено, повторится при следующем запуске:', e && e.message);
    return { ...zero, failed: true, ms: Date.now() - t0 };
  }
  out.ms = Date.now() - t0;
  out.summary = summaryOf(out);
  return out;
}
