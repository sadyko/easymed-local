// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — СЛИЯНИЕ ДУБЛЕЙ ЗАЯВОК CRM.
//
// Владелец: «merge duplicates». Один человек звонит трижды — и на доске три
// карточки: в одной его записали, в другой «Не пришёл», в третьей заметка
// оператора. Решено (сказано владельцу):
//   • список «Дубликаты» — группы карточек с одним номером (phoneKey — тот же
//     ключ из девяти цифр, что у поиска и проверки дубля, crm-phone-match.js);
//   • остаётся карточка, которую выбирает человек; заранее выбрана самая
//     продвинутая (дошедшая первой) или та, у которой есть пациент;
//   • услуги, задачи, заметки (с припиской «— из заявки №N от dd.mm, «Имя»») и
//     метки переезжают в оставшуюся;
//   • проигравшие карточки удаляются в ОДНОЙ транзакции с записью в журнале
//     (crm_merge_log, миграция 151);
//   • карточки РАЗНЫХ пациентов не сливаются никогда: один номер на семью —
//     обычное дело, и слияние стёрло бы одного из них;
//   • сливают администратор и руководитель колл-центра (`crm.all`).
//
// РЕВЬЮ (2026-09-25) — ПРАВИЛА УТОЧНЕНЫ:
//   I1 — сливаются ТОЛЬКО карточки одного номера (phoneKey из 7+ цифр). Иначе
//        «слияние» было бы удалением любой карточки в обход того, что удалять
//        заявки может только администратор.
//   I2 — живая заявка не хоронится в закрытой: есть среди сливаемых карточка в
//        работе — остаться может только карточка в работе (правило в
//        public/js/admin/views/crm-merge-logic.js, общее с экраном), и она
//        сохраняет СВОЮ ступень, дату обращения и автора. Отчёты за прошлые
//        периоды от слияния не меняются (дата не переписывается никогда).
//   I3 — разные имена на одном номере — предупреждение (names_differ), а имя
//        влитой карточки дописывается в приписку заметки.
//   M2 — журнал хранит номера, ступени, пациентов и счётчики, но не имена,
//        телефоны и заметки: он живёт вечно, и копия персональных данных в нём
//        пережила бы удаление самих заявок.
//   M3 — запрет разных пациентов действует на ВЫБРАННЫЕ карточки: остальные
//        карточки группы можно слить, сняв галочку с чужой.
//
// ПОЧЕМУ RPC, А НЕ /api/db. Переезд строк, пересчёт зеркала услуги и даты,
// удаление и журнал — одно действие. Сделай его экран серией запросов —
// обрыв посередине оставил бы строки услуг без заявки (каскад их унёс бы) или
// две карточки с одной задачей.

import { phoneKey } from '../../../public/js/admin/views/crm-phone-match.js';
import { allowedSurvivors, isOpenCard, suggestSurvivor, patientConflict, namesDiffer, personName }
  from '../../../public/js/admin/views/crm-merge-logic.js';
import { canWrite } from '../../db/schema-registry.js';
import { effectiveRoles } from '../roles.js';
import { canSeeAllLeads, leadVisible } from '../crm/visibility.js';
import { listStages } from '../crm/config.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const MAX_MERGE = 20;          // за один раз — больше дублей у одного номера не бывает
const MAX_GROUPS = 300;
export const MIN_KEY_DIGITS = 7;   // короче — это не номер, а обрывок: «группа» из случайных карточек

function requireMerger(db, user) {
  // Сливать может тот, кто видит всю доску И ведёт её (пишет в заявки):
  // администратор или руководитель колл-центра. Своя роль с `crm.all` на
  // основе, которой реестр не даёт править заявки, доску всё равно не ведёт.
  if (!canSeeAllLeads(db, user) || !canWrite('crm_requests', 'update', effectiveRoles(user))) {
    throw new RpcError('Объединять дубли могут администратор и руководитель колл-центра.', 403);
  }
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// --------------------------------------------------------------------------
// Какая ступень «продвинутее» (для слияния одних закрытых карточек)
// --------------------------------------------------------------------------
// Дошедшая (won) — дальше всех; живые — по порядку колонок; проигранные — ниже
// живых. Ступень, которой в справочнике нет, — в самом низу.
export function stageRanker(stages) {
  const by = new Map((stages || []).map((s) => [s.key, s]));
  return (key) => {
    const s = by.get(key);
    if (!s) return -1;
    const pos = Number(s.position) || 0;
    if (s.kind === 'won') return 3000 + pos;
    if (s.kind === 'open') return 2000 + pos;
    return 1000 + pos;
  };
}

/** Карточка → то, что знают правила слияния: вид ступени и её место в воронке. */
function withStage(stageBy) {
  return (c) => {
    const st = stageBy.get(c.status);
    return { ...c, stage_kind: st ? st.kind : 'open', stage_pos: st ? Number(st.position) || 0 : 0 };
  };
}

const firstNonEmpty = (list, pick) => {
  for (const x of list) {
    const v = pick(x);
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
};

// --------------------------------------------------------------------------
// crm_duplicate_groups {} → { groups: [...] }
// --------------------------------------------------------------------------
/**
 * Группы карточек с одним номером (ключ phoneKey), от самой свежей группы.
 * У каждой карточки — то, по чему человек выбирает оставшуюся: ступень (и её
 * вид), пациент, оператор, дата, сколько услуг и задач. `conflict: true` — в
 * группе разные пациенты (сливать можно только часть, сняв галочки);
 * `names_differ: true` — разные имена, возможно, разные люди.
 */
export function crmDuplicateGroups(db, _args, user) {
  requireMerger(db, user);
  const stages = listStages(db);
  const stageBy = new Map(stages.map((s) => [s.key, s]));
  const staged = withStage(stageBy);
  const rows = db.prepare(`
    SELECT r.id, r.full_name, r.phone, r.status, r.source, r.patient_id, r.assigned_to, r.created_at,
           p.full_name AS patient_name, p.mrn AS patient_mrn, u.full_name AS assigned_name,
           (SELECT COUNT(*) FROM crm_request_services cs WHERE cs.request_id = r.id AND cs.status <> 'cancelled') AS lines,
           (SELECT COUNT(*) FROM crm_tasks t WHERE t.request_id = r.id) AS tasks
      FROM crm_requests r
      LEFT JOIN patients p ON p.id = r.patient_id
      LEFT JOIN users u ON u.id = r.assigned_to
     ORDER BY r.id`).all();
  // requireMerger уже проверил, что доска видна целиком: поштучной проверки
  // видимости здесь не нужно.
  const groups = new Map();
  for (const r of rows) {
    const key = phoneKey(r.phone || '');
    if (!key || key.length < MIN_KEY_DIGITS) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, raw] of groups) {
    if (raw.length < 2) continue;
    const cards = raw.map(staged);
    out.push({
      key,
      phone: cards[cards.length - 1].phone || '',
      conflict: patientConflict(cards),
      names_differ: namesDiffer(cards),
      suggested_id: suggestSurvivor(cards),
      latest: cards.reduce((m, c) => (String(c.created_at || '') > m ? String(c.created_at || '') : m), ''),
      cards: cards.map((c) => {
        const st = stageBy.get(c.status);
        return {
          id: c.id, full_name: c.full_name || '', phone: c.phone || '', status: c.status,
          stage_label: st ? st.label : c.status, stage_kind: c.stage_kind, stage_pos: c.stage_pos, stage_color: st ? st.color : '',
          source: c.source, patient_id: c.patient_id ?? null,
          patient_name: c.patient_name || '', patient_mrn: c.patient_mrn || '',
          assigned_to: c.assigned_to ?? null, assigned_name: c.assigned_name || '',
          created_at: c.created_at, lines: c.lines || 0, tasks: c.tasks || 0,
        };
      }),
    });
  }
  out.sort((a, b) => b.latest.localeCompare(a.latest));
  return { groups: out.slice(0, MAX_GROUPS), total: out.length };
}

// --------------------------------------------------------------------------
// crm_merge_leads { keep_id, merge_ids[] } → { kept_id, merged_ids, lead }
// --------------------------------------------------------------------------
export function crmMergeLeads(db, args, user) {
  requireMerger(db, user);
  const keepId = Number(args && args.keep_id);
  if (!Number.isInteger(keepId) || keepId <= 0) throw new RpcError('Не выбрана карточка, которая останется.', 400);
  const raw = Array.isArray(args && args.merge_ids) ? args.merge_ids : [];
  const mergeIds = [...new Set(raw.map(Number))].filter((x) => Number.isInteger(x) && x > 0 && x !== keepId);
  if (!mergeIds.length) throw new RpcError('Выберите хотя бы одну карточку, которую нужно влить.', 400);
  if (mergeIds.length > MAX_MERGE) throw new RpcError('За один раз можно объединить не больше 20 карточек.', 400);

  const all = [keepId, ...mergeIds];
  const holes = all.map(() => '?').join(',');
  const stages = listStages(db);
  const stageBy = new Map(stages.map((s) => [s.key, s]));
  const cards = db.prepare(`SELECT * FROM crm_requests WHERE id IN (${holes})`).all(...all).map(withStage(stageBy));
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const id of all) {
    // Чужая невидимая карточка отвечает тем же «не найдена», что и
    // несуществующая: сам факт её существования — тоже сведения о чужой заявке.
    const c = byId.get(id);
    if (!c || !leadVisible(db, user, c.assigned_to, { lifted: true })) throw new RpcError(`Заявка №${id} не найдена.`, 404);
  }
  const keep = byId.get(keepId);
  const losers = mergeIds.map((id) => byId.get(id));

  // I1 — один номер. Иначе это не слияние дублей, а удаление чужой карточки.
  const keys = new Set(cards.map((c) => phoneKey(c.phone || '')));
  const key = [...keys][0] || '';
  if (keys.size !== 1 || key.length < MIN_KEY_DIGITS) {
    throw new RpcError('Объединять можно только карточки с одним и тем же номером телефона.', 409);
  }
  if (patientConflict(cards)) {
    throw new RpcError('Карточки привязаны к разным пациентам — объединить их нельзя. Один номер бывает у нескольких членов семьи.', 409);
  }
  // I2 — живую заявку нельзя влить в закрытую.
  if (!allowedSurvivors(cards).some((c) => c.id === keepId)) {
    throw new RpcError('Среди карточек есть заявка в работе — остаться должна она (или другая карточка в работе), а не закрытая.', 409);
  }

  const rank = stageRanker(stages);
  // Порядок «первой непустой»: сначала оставшаяся, потом остальные по дате.
  const byAge = cards.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || (a.id - b.id));
  const order = [keep, ...byAge.filter((c) => c.id !== keepId)];
  // Ступень: оставшаяся в работе сохраняет СВОЮ (I2); сливаются одни закрытые
  // — самая продвинутая из них.
  const status = isOpenCard(keep) ? keep.status
    : cards.reduce((best, c) => (rank(c.status) > rank(best) ? c.status : best), keep.status);

  const dd = db.prepare("SELECT strftime('%d.%m', ?, 'localtime') AS d");
  const notes = [];
  if (keep.note && String(keep.note).trim()) notes.push(String(keep.note).trim());
  for (const c of losers.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))) {
    const n = String(c.note || '').trim();
    const who = personName(c);
    // Заметки нет, но имя другое — его всё равно стоит сохранить (I3): иначе
    // от второго человека на этом номере не остаётся и следа.
    const whoDiffers = who && personName(keep) !== who;
    if (!n && !whoDiffers) continue;
    const d = c.created_at ? (dd.get(c.created_at).d || '') : '';
    const tail = `из заявки №${c.id}${d ? ' от ' + d : ''}${who ? ', «' + who + '»' : ''}`;
    notes.push(n ? `${n} — ${tail}` : `— ${tail}`);
  }

  const hasTags = tableExists(db, 'crm_request_tags');
  const idsOf = (sql, id) => db.prepare(sql).all(id).map((x) => Object.values(x)[0]);
  // M2 — только номера, ступени, пациенты и счётчики: ни имён, ни телефонов,
  // ни заметок.
  const brief = (c) => ({ id: c.id, status: c.status, patient_id: c.patient_id ?? null, assigned_to: c.assigned_to ?? null });
  const snapshot = {
    kept: brief(keep),
    merged: losers.map((c) => {
      const lineIds = idsOf('SELECT id FROM crm_request_services WHERE request_id = ? ORDER BY id', c.id);
      const taskIds = idsOf('SELECT id FROM crm_tasks WHERE request_id = ? ORDER BY id', c.id);
      const tags = hasTags ? idsOf('SELECT tag_key FROM crm_request_tags WHERE request_id = ? ORDER BY tag_key', c.id) : [];
      return { ...brief(c), line_ids: lineIds, task_ids: taskIds, tags, lines: lineIds.length, tasks: taskIds.length };
    }),
  };
  const actorName = user && user.id != null
    ? ((db.prepare('SELECT full_name FROM users WHERE id = ?').get(user.id) || {}).full_name || null) : null;

  const lh = mergeIds.map(() => '?').join(',');
  db.transaction(() => {
    // 1. Строки услуг и задачи — ПЕРЕЕЗЖАЮТ. Удаление заявки ниже уносит
    //    свои строки каскадом (ON DELETE CASCADE), поэтому переезд обязан
    //    случиться раньше — иначе услуги и задачи пропали бы вместе с карточкой.
    //    Исполнитель задачи не меняется: даже на чужой карточке он свою задачу
    //    видит (crm_tasks.scope.orOwn).
    db.prepare(`UPDATE crm_request_services SET request_id = ? WHERE request_id IN (${lh})`).run(keepId, ...mergeIds);
    db.prepare(`UPDATE crm_tasks SET request_id = ? WHERE request_id IN (${lh})`).run(keepId, ...mergeIds);
    // 2. Метки — объединение: у карточки метка либо есть, либо нет.
    if (hasTags) {
      db.prepare(`INSERT OR IGNORE INTO crm_request_tags (request_id, tag_key)
                  SELECT ?, tag_key FROM crm_request_tags WHERE request_id IN (${lh})`).run(keepId, ...mergeIds);
    }
    // 3. Сама карточка. Дата обращения, автор и источник — СВОИ (I2/M5):
    //    слияние не переписывает историю, по которой считаются отчёты.
    const lineFirst = db.prepare(`
      SELECT service_id, scheduled_date FROM crm_request_services
       WHERE request_id = ? AND status NOT IN ('cancelled', 'done')
       ORDER BY (scheduled_date IS NULL OR scheduled_date = ''), scheduled_date, id LIMIT 1`).get(keepId);
    const patch = {
      full_name: firstNonEmpty(order, (c) => c.full_name) || keep.full_name,
      phone: firstNonEmpty(order, (c) => c.phone) || keep.phone,
      patient_id: firstNonEmpty(order, (c) => c.patient_id),
      assigned_to: firstNonEmpty(order, (c) => c.assigned_to),
      status,
      note: notes.join('\n'),
      // Доказательство звонка у оставшейся — своё; нет своего — самое раннее.
      call_id: keep.call_id ?? firstNonEmpty(byAge, (c) => c.call_id),
      // Зеркало первой строки (CRM_MULTI_SERVICE_V1): карточка доски и выгрузка
      // читают услугу и дату из родителя. Первая ЖИВАЯ строка после переезда —
      // то же правило, что у окна заявки (ближайшая назначенная дата).
      service_id: lineFirst ? lineFirst.service_id : firstNonEmpty(order, (c) => c.service_id),
      scheduled_date: lineFirst ? (lineFirst.scheduled_date || null) : firstNonEmpty(order, (c) => c.scheduled_date),
    };
    db.prepare(`UPDATE crm_requests
                   SET full_name = @full_name, phone = @phone, patient_id = @patient_id, assigned_to = @assigned_to,
                       status = @status, note = @note, call_id = @call_id, service_id = @service_id,
                       scheduled_date = @scheduled_date,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                 WHERE id = @id`).run({ ...patch, id: keepId });
    // 4. Проигравшие — удаляются. Строк у них уже нет: каскаду нечего уносить.
    db.prepare(`DELETE FROM crm_requests WHERE id IN (${lh})`).run(...mergeIds);
    // 5. Журнал.
    db.prepare(`INSERT INTO crm_merge_log (kept_id, merged_ids, snapshot, actor_id, actor_name)
                VALUES (?, ?, ?, ?, ?)`)
      .run(keepId, JSON.stringify(mergeIds), JSON.stringify(snapshot), user && user.id != null ? Number(user.id) : null, actorName);
  })();

  return {
    kept_id: keepId,
    merged_ids: mergeIds,
    lead: db.prepare('SELECT * FROM crm_requests WHERE id = ?').get(keepId),
  };
}
