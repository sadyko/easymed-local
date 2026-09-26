// PATIENT_MERGE_SERVER_V1 (2026-09-27) — объединение дублей делает СЕРВЕР.
//
// Раньше объединение шло из браузера (data.js mergePatients) таблица за
// таблицей через /api/db. Реестр не даёт клиенту менять patient_id у визитов и
// счетов, поэтому у дубля с историей визиты и счета оставались на нём,
// удаление карты падало на внешнем ключе, а часть строк к этому моменту уже
// переехала — карта оказывалась разорванной на две. Теперь всё — одной
// транзакцией: либо дубль целиком стал оставленной картой, либо не изменилось
// ничего.
//
// ЧТО ПЕРЕНОСИТСЯ — MERGE_TABLES ниже: каждая колонка схемы, указывающая на
// пациента. Тест (patient-merge.test.js) сверяет этот список со схемой: новая
// таблица с patient_id, не добавленная сюда, роняет тест, а не объединение у
// клиента. Строки, которые висят на пациенте через визит или счёт (услуги
// визита, анализы, талоны очереди, позиции счёта, платежи), едут вместе со
// своим визитом/счётом.
//
// ОСОБЫЕ СЛУЧАИ:
//   • patient_deposits (баланс) — строки журнала баланса заморожены (мигр.
//     160); смена владельца пропускается только по паре из merge_money_moves,
//     которую эта функция кладёт и убирает в своей транзакции. Баланс после
//     объединения = сумма обоих;
//   • patient_relationships — пара (a, b) уникальна: связи дубля строятся
//     заново на оставленную карту, связь с самим собой и повторы снимаются;
//   • patient_guardians — опекун «оставленная карта сама себе» снимается.
//
// ПОЛЯ КАРТЫ не сливаются: прежнее объединение их не трогало, и оставленная
// карта остаётся как есть (что оставить — выбирает человек на экране).
//
// ФИЛИАЛЫ. patient_id визитов и счетов ездит (журнальные триггеры 084/087
// пишут его как ссылку по uid), удаление карты — надгробием; поэтому переезд
// и удаление доходят до соседа сами. Но строки, ПРИЕХАВШИЕ от соседа, здесь
// не правятся (BRANCH_MONEY_GUARD_V1), а карта, заведённая в другом здании,
// удалённая здесь, исчезла бы и там. Такое объединение — отказ: его делают в
// здании, где заведены строки.
//
// Права — как у прежнего объединения, которое заканчивалось удалением карты:
// только администратор.

import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Каждая колонка, указывающая на пациента. how: 'move' — простая замена;
// особые — см. шапку.
export const MERGE_TABLES = Object.freeze([
  { table: 'visits', cols: ['patient_id'], how: 'move' },
  { table: 'invoices', cols: ['patient_id'], how: 'move' },
  { table: 'admissions', cols: ['patient_id'], how: 'move' },
  { table: 'admission_prescriptions', cols: ['patient_id'], how: 'move' },
  { table: 'med_administrations', cols: ['patient_id'], how: 'move' },
  { table: 'recommended_services', cols: ['patient_id'], how: 'move' },
  { table: 'visit_documents', cols: ['patient_id'], how: 'move' },
  { table: 'patient_vitals', cols: ['patient_id'], how: 'move' },
  { table: 'patient_conditions', cols: ['patient_id'], how: 'move' },
  { table: 'patient_activity_log', cols: ['patient_id'], how: 'move' },
  { table: 'telegram_deliveries', cols: ['patient_id'], how: 'move' },
  { table: 'calls', cols: ['patient_id'], how: 'move' },
  { table: 'crm_requests', cols: ['patient_id'], how: 'move' },
  { table: 'custdev_cards', cols: ['patient_id'], how: 'move' },
  { table: 'patient_deposits', cols: ['patient_id'], how: 'money' },
  { table: 'patient_guardians', cols: ['patient_id', 'guardian_patient_id'], how: 'guardians' },
  { table: 'patient_relationships', cols: ['patient_id_a', 'patient_id_b'], how: 'relationships' },
]);

// Родство хранится одной строкой на пару, «младший» id — в a (как у экрана,
// data.js: сравнение строками), тип — со стороны a.
const REL_INVERSE = { parent: 'child', child: 'parent', spouse: 'spouse', sibling: 'sibling', guardian: 'guardian', other: 'other' };

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function assertNothingForeign(db, dropId) {
  const refuse = () => {
    throw new RpcError('У карты-дубля есть записи другого здания (филиала). Объединение карт делают в том здании, где заведены эти записи.', 400);
  };
  const p = db.prepare('SELECT sync_origin FROM patients WHERE id = ?').get(dropId);
  if (p && p.sync_origin != null) refuse();
  const checks = [
    'SELECT 1 FROM visits WHERE patient_id = ? AND sync_origin IS NOT NULL',
    `SELECT 1 FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE v.patient_id = ? AND vs.sync_origin IS NOT NULL`,
    `SELECT 1 FROM lab_results lr JOIN visit_services vs ON vs.id = lr.visit_service_id JOIN visits v ON v.id = vs.visit_id
      WHERE v.patient_id = ? AND lr.sync_origin IS NOT NULL`,
    'SELECT 1 FROM invoices WHERE patient_id = ? AND sync_origin IS NOT NULL',
    `SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = ? AND ii.sync_origin IS NOT NULL`,
    `SELECT 1 FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.patient_id = ? AND p.sync_origin IS NOT NULL`,
  ];
  for (const sql of checks) if (db.prepare(sql + ' LIMIT 1').get(dropId)) refuse();
}

// Один дубль: всё внутри транзакции вызывающего.
function mergeOne(db, keep, drop, user) {
  {
    const getP = db.prepare('SELECT * FROM patients WHERE id = ?');
    const keepRow = getP.get(keep);
    const dropRow = getP.get(drop);
    if (!keepRow || !dropRow) throw new RpcError('Пациент не найден.', 400);
    assertNothingForeign(db, drop);

    const moved = {};
    for (const t of MERGE_TABLES) {
      if (t.how === 'move') {
        moved[t.table] = db.prepare(`UPDATE "${t.table}" SET patient_id = ? WHERE patient_id = ?`).run(keep, drop).changes;
      } else if (t.how === 'money') {
        db.prepare('INSERT OR IGNORE INTO merge_money_moves (drop_id, keep_id) VALUES (?, ?)').run(drop, keep);
        try {
          moved[t.table] = db.prepare('UPDATE patient_deposits SET patient_id = ? WHERE patient_id = ?').run(keep, drop).changes;
        } finally {
          db.prepare('DELETE FROM merge_money_moves WHERE drop_id = ? AND keep_id = ?').run(drop, keep);
        }
      } else if (t.how === 'guardians') {
        let n = db.prepare('UPDATE patient_guardians SET patient_id = ? WHERE patient_id = ?').run(keep, drop).changes;
        n += db.prepare('UPDATE patient_guardians SET guardian_patient_id = ? WHERE guardian_patient_id = ?').run(keep, drop).changes;
        db.prepare('DELETE FROM patient_guardians WHERE patient_id = ? AND guardian_patient_id = ?').run(keep, keep);
        moved[t.table] = n;
      } else if (t.how === 'relationships') {
        const rows = db.prepare('SELECT * FROM patient_relationships WHERE patient_id_a = ? OR patient_id_b = ?').all(drop, drop);
        db.prepare('DELETE FROM patient_relationships WHERE patient_id_a = ? OR patient_id_b = ?').run(drop, drop);
        const ins = db.prepare('INSERT OR IGNORE INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?, ?, ?)');
        let n = 0;
        for (const r of rows) {
          let x = r.patient_id_a === drop ? keep : r.patient_id_a;
          let y = r.patient_id_b === drop ? keep : r.patient_id_b;
          let rt = r.relation_type;
          if (x === y) continue;   // связь с самим собой
          if (String(x) > String(y)) { [x, y] = [y, x]; rt = REL_INVERSE[rt] || rt; }
          n += ins.run(x, y, rt).changes;
        }
        moved[t.table] = n;
      }
    }

    const label = [dropRow.full_name || '—', dropRow.mrn ? '(' + dropRow.mrn + ')' : ''].filter(Boolean).join(' ');
    db.prepare(`INSERT INTO patient_activity_log (patient_id, entity_type, entity_id, entity_label, action, summary, detail,
                                                   actor_user_id, actor_name, actor_role)
                VALUES (?, 'patient', ?, ?, 'merged', ?, ?, ?, ?, ?)`)
      .run(keep, drop, label, 'Объединено с дублем ' + label, JSON.stringify({ drop_id: drop, drop_uid: dropRow.uid || null, moved }),
        user.id, String(user.full_name || user.username || ''), String(user.role || ''));

    // Карта дубля пуста — удаляем её так же, как прежнее объединение
    // (удаление уезжает к соседям надгробием, мигр. 084).
    db.prepare('DELETE FROM patients WHERE id = ?').run(drop);
    return moved;
  }
}

// merge_patients { keep_id, drop_id } или { keep_id, drop_ids: [...] }. Все
// дубли — ОДНОЙ транзакцией: если хоть один нельзя (чужое здание, нет
// карты), не объединяется ни один.
export function mergePatientsRpc(db, args, user) {
  if (!hasAnyRole(user, ['admin'])) throw new RpcError('Your role is not allowed to perform this action.', 403);
  const a = args || {};
  const keep = a.keep_id;
  const drops = Array.isArray(a.drop_ids) ? a.drop_ids : [a.drop_id];
  if (!isPositiveInt(keep) || !drops.length || drops.length > 50 || !drops.every(isPositiveInt)) {
    throw new RpcError('keep_id and drop_id(s) must be positive integers.', 400);
  }
  if (drops.includes(keep)) throw new RpcError('Нельзя объединить карту саму с собой.', 400);
  const uniq = [...new Set(drops)];

  return db.transaction(() => {
    const moved = {};
    for (const drop of uniq) {
      for (const [t, n] of Object.entries(mergeOne(db, keep, drop, user))) moved[t] = (moved[t] || 0) + n;
    }
    return { merged: true, keep_id: keep, drop_id: uniq[0], drop_ids: uniq, moved };
  })();
}
