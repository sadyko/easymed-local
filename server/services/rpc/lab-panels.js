// LAB_PANEL_DEDUP_V1 — сохранение и удаление панели лаборатории ОДНИМ запросом
// и одной транзакцией (Лаборатория → «Панели», views/lab-panels.js).
//
// Было: редактор сохранял панель тремя запросами через /api/db — прочитать id
// прежних показателей, вставить новые строки, удалить прочитанные. Два
// сохранения, идущие одновременно, читали один и тот же список прежних id, и
// каждое удаляло только его: строки ОБОИХ сохранений оставались. Так панель
// клиники получала каждый показатель дважды и трижды — без второго здания
// хватало повторного нажатия «Сохранить панель» после любой перерисовки
// редактора, пока сервер ещё отвечал на первое (выбор панели в списке,
// «Пустой», «Нормы по полу», уход с экрана и возврат), или второй вкладки.
// Лист «Внести результаты» показывал каждую копию отдельной строкой, а печать
// — ровно сохранённое, и анализы терялись из бланка.
//
// Теперь вся панель — один вызов, и база пишет его одной транзакцией:
//   1. панель — правка по id или новая строка;
//   2. ВСТАВКА присланных показателей (новые id, sort_order по порядку);
//   3. удаление ВСЕХ ДРУГИХ строк этой панели — не «прочитанных раньше», а
//      всех, кроме только что вставленных.
// Транзакции SQLite идут по одной, поэтому второе из двух одновременных
// сохранений удаляет строки первого: копия остаётся одна при любом числе
// нажатий, вкладок и компьютеров. Порядок «сначала вставка, потом удаление»
// оставлен нарочно: триггер мигр. 233 (trg_lab_panel_analytes_confirm_ins)
// берёт отметку «подтверждено для прибора» у ПРЕЖНЕЙ строки этой панели с тем
// же кодом и именем — прежние строки должны ещё существовать в момент вставки.
// Ошибка на любом шаге откатывает всё: прежние показатели и нормы целы.
//
// Два одинаковых показателя в одной панели (тот же «Раздел бланка» и то же
// имя без пробелов по краям) сервер не принимает: результат анализа хранит
// только имя показателя, и вторая строка с тем же именем не может получить
// своё значение — ни на листе ввода, ни на бланке.
//
// Удаление панели (lab_panel_delete) убирает её показатели в той же
// транзакции: прежде «Удалить» удаляло только строку lab_panels, и внешний
// ключ показателей отказывал всегда. Результаты анализов (lab_results) на
// панель не ссылаются — они держат услугу визита и имя показателя, — поэтому
// удаление их не трогает, и выданные бланки остаются как были.
//
// Права — те же, что у записи этих таблиц через /api/db (реестр
// schema-registry.js, LAB_SECTION_ROLES): RPC не должен стать обходом для
// того, кому таблицы закрыты. Это записи: в READ_ONLY_RPCS (control/gate.js)
// их нет, клиника с просроченной лицензией панели не правит — как и через
// /api/db.
//
// Ревью H2 — ПАНЕЛЬ ГЛАВНОГО ЗДАНИЯ В ФИЛИАЛЕ. Панель, приехавшая справочником
// (сопоставлена в branch_sync_map), в филиале не удаляется и не переносится на
// другую услугу: ближайшая синхронизация завела бы её заново на прежнюю
// услугу, а своя панель филиала на этой услуге роняла бы (UNIQUE, мигр. 048)
// весь приём справочника — цены, сотрудников, права, пароли — при каждом
// запуске. Отказ — 409, как у MAIN_CLINIC_TABLES (routes/db.js): запрос
// правильный, не даёт устройство клиники. Показатели и коды анализатора своего
// здания филиал по-прежнему правит. Панель, которую главное здание удалило
// (приём её выключил и отвязал), — уже своя: её удалить можно.
import { tableWriteAllowed } from '../../db/write-grant.js';
import { rpcT } from '../server-message.js';
import { readIdentity } from '../branch-sync/identity.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Эта установка — филиал (branch_identity.role = 'secondary')? Сомнение — «нет», как в routes/db.js. */
function isSecondary(db) {
  try { return readIdentity(db).role === 'secondary'; } catch { return false; }
}

/**
 * Ревью H2 — панель главного здания здесь, в филиале: сопоставлена со строкой
 * главного и ещё живая (включена или привязана к услуге).
 */
export function mainBuildingPanel(db, panelId) {
  if (!isSecondary(db)) return false;
  try {
    const mapped = db.prepare("SELECT 1 FROM branch_sync_map WHERE table_name = 'lab_panels' AND local_id = ? LIMIT 1").get(panelId);
    if (!mapped) return false;
    const row = db.prepare('SELECT active, service_id FROM lab_panels WHERE id = ?').get(panelId);
    return !!row && (!!row.active || row.service_id != null);
  } catch { return false; }
}

const MODALITIES = new Set(['lab', 'diagnostic']);
const VALUE_TYPES = new Set(['numeric', 'text', 'select']);

const NO_RIGHTS = 'Недостаточно прав для этого действия.';

// Значения приходят из браузера: числа — числами или null, текст — строкой
// или null. better-sqlite3 не принимает ни true/false, ни объекты.
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v) => {
  const n = numOrNull(v);
  return n === null || !Number.isInteger(n) ? null : n;
};
const textOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
};
const flag = (v, dflt) => {
  if (v === undefined || v === null) return dflt;
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
};
const trimmed = (v) => String(v == null ? '' : v).trim();

function rangesJson(v) {
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
  return Array.isArray(arr) && arr.length ? JSON.stringify(arr) : null;
}

/** Ссылка из браузера: пусто — null, иначе целое число, иначе отказ. */
function refId(v, message) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new RpcError(message, 400);
  return n;
}

function cleanAnalytes(list) {
  const rows = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object') continue;
    const name = trimmed(r.name);
    if (!name) continue;   // строка без имени не сохраняется — как и прежде в редакторе
    const group = trimmed(r.group_label);
    // LAB_PANEL_DEDUP_V1 — сравнение без пробелов по краям, буква в букву: так
    // же сравнивает лист ввода и миграция 271 (trim, а не lower — lower() SQLite
    // не знает кириллицы).
    const key = group + '\u0000' + name;
    if (seen.has(key)) {
      throw rpcT(RpcError, 'Показатель «{name}» записан в панели дважды — оставьте одну строку и сохраните снова.',
        { name: group ? group + ' / ' + name : name }, 400);
    }
    seen.add(key);
    const confirmed = flag(r.device_code_confirmed, 0);
    rows.push({
      code: textOrNull(r.code),
      name,
      unit: textOrNull(r.unit),
      value_type: VALUE_TYPES.has(r.value_type) ? r.value_type : 'numeric',
      value_options: textOrNull(r.value_options == null ? null : trimmed(r.value_options)),
      decimals: intOrNull(r.decimals) ?? 0,
      ref_low: numOrNull(r.ref_low), ref_high: numOrNull(r.ref_high), ref_text: textOrNull(r.ref_text),
      ref_low_m: numOrNull(r.ref_low_m), ref_high_m: numOrNull(r.ref_high_m),
      ref_low_f: numOrNull(r.ref_low_f), ref_high_f: numOrNull(r.ref_high_f),
      group_label: group || null,
      ref_ranges: rangesJson(r.ref_ranges),
      device_code: trimmed(r.device_code),
      device_code_confirmed: confirmed,
      // LIS_REAL_ANALYZERS_V1 — прибор, для которого человек подтвердил (0 —
      // «ни для какого»), и эпоха его кодов; последнее слово — у триггера мигр. 233.
      device_code_confirmed_device_id: confirmed ? intOrNull(r.device_code_confirmed_device_id) : null,
      device_code_confirmed_epoch: confirmed ? intOrNull(r.device_code_confirmed_epoch) : null,
    });
  }
  return rows;
}

/**
 * lab_panel_save — панель и все её показатели одной транзакцией.
 * args: { panel: { id?, name, modality, has_narrative, service_id, active, device_id, code?, core_panel_id? },
 *         analytes: [ { name, code, unit, value_type, …, group_label, device_code, … } ] }
 *   ->  { id, analytes }  (id панели и число её показателей после сохранения)
 */
export function labPanelSave(db, args, user) {
  const a = args || {};
  const p = a.panel && typeof a.panel === 'object' ? a.panel : {};
  const id = refId(p.id, 'Панель не найдена — обновите страницу.');
  const ok = id
    ? tableWriteAllowed('lab_panels', 'update', user, db)
    : tableWriteAllowed('lab_panels', 'insert', user, db);
  if (!ok || !tableWriteAllowed('lab_panel_analytes', 'insert', user, db)
      || !tableWriteAllowed('lab_panel_analytes', 'delete', user, db)) {
    throw new RpcError(NO_RIGHTS, 403);
  }
  const name = trimmed(p.name);
  if (!name) throw new RpcError('Укажите название панели', 400);
  const panel = {
    name,
    modality: MODALITIES.has(p.modality) ? p.modality : 'lab',
    has_narrative: flag(p.has_narrative, 0),
    service_id: refId(p.service_id, 'Услуга указана неверно.'),
    active: flag(p.active, 1),
    device_id: refId(p.device_id, 'Анализатор указан неверно.'),
  };
  const analytes = cleanAnalytes(a.analytes);

  const insAnalyte = db.prepare(`INSERT INTO lab_panel_analytes
      (panel_id, code, name, unit, value_type, value_options, decimals,
       ref_low, ref_high, ref_text, ref_low_m, ref_high_m, ref_low_f, ref_high_f,
       group_label, sort_order, ref_ranges,
       device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
    VALUES (@panel_id, @code, @name, @unit, @value_type, @value_options, @decimals,
       @ref_low, @ref_high, @ref_text, @ref_low_m, @ref_high_m, @ref_low_f, @ref_high_f,
       @group_label, @sort_order, @ref_ranges,
       @device_code, @device_code_confirmed, @device_code_confirmed_device_id, @device_code_confirmed_epoch)`);

  return db.transaction(() => {
    let panelId = id;
    if (panelId) {
      // Ревью H2 — панель главного здания в филиале на другую услугу не переносится.
      if (mainBuildingPanel(db, panelId)) {
        const cur = db.prepare('SELECT service_id FROM lab_panels WHERE id = ?').get(panelId);
        if (cur && (cur.service_id ?? null) !== panel.service_id) {
          throw new RpcError('Эта панель приходит из главного здания: удалить её или сменить у неё услугу можно только там.', 409);
        }
      }
      // Ревью M1 — списанная панель (retired_at, мигр. 272) для экрана удалена:
      // вкладка, открытая до «Удалить», её не оживляет (иначе невидимая панель
      // снова заняла бы услугу).
      const res = db.prepare(`UPDATE lab_panels SET name = @name, modality = @modality, has_narrative = @has_narrative,
          service_id = @service_id, active = @active, device_id = @device_id WHERE id = @id AND retired_at IS NULL`).run({ ...panel, id: panelId });
      if (!res.changes) throw new RpcError('Панель не найдена — обновите страницу.', 404);
    } else {
      const info = db.prepare(`INSERT INTO lab_panels (name, code, modality, has_narrative, service_id, core_panel_id, active, device_id)
          VALUES (@name, @code, @modality, @has_narrative, @service_id, @core_panel_id, @active, @device_id)`)
        .run({ ...panel, code: textOrNull(p.code), core_panel_id: intOrNull(p.core_panel_id) });
      panelId = Number(info.lastInsertRowid);
    }
    // Сначала вставка (триггер мигр. 233 читает прежние строки), потом —
    // удаление всего остального этой панели, включая строки чужого
    // сохранения, успевшего раньше.
    const fresh = analytes.map((r, i) => Number(insAnalyte.run({ ...r, panel_id: panelId, sort_order: i }).lastInsertRowid));
    if (fresh.length) {
      db.prepare(`DELETE FROM lab_panel_analytes WHERE panel_id = ? AND id NOT IN (${fresh.map(() => '?').join(', ')})`)
        .run(panelId, ...fresh);
    } else {
      db.prepare('DELETE FROM lab_panel_analytes WHERE panel_id = ?').run(panelId);
    }
    return { id: panelId, analytes: fresh.length };
  })();
}

/**
 * Ревью M1 — главное здание с филиалами: этой установке выдавались буквы других
 * зданий (branch_letters_spent, 'issue'; своя буква — не в счёт). Сомнение — «нет»:
 * клиника без филиалов удаляет панель, как и прежде.
 */
export function mainWithBranches(db) {
  try {
    const me = readIdentity(db);
    if (me.role === 'secondary') return false;
    const own = String(me.letter || '').trim().toUpperCase();
    return !!db.prepare("SELECT 1 FROM branch_letters_spent WHERE kind = 'issue' AND UPPER(TRIM(letter)) <> ? LIMIT 1").get(own);
  } catch { return false; }
}

/**
 * lab_panel_delete — панель вместе с её показателями.
 * args: { id }  ->  { deleted: true, analytes }   (списана — { deleted: true, retired: true, analytes: 0 })
 * Результаты анализов не трогаются: на панель они не ссылаются.
 *
 * Ревью M1 — ГЛАВНОЕ ЗДАНИЕ С ФИЛИАЛАМИ панель не стирает, а СПИСЫВАЕТ: выключает,
 * отвязывает от услуги и анализатора, ставит retired_at (мигр. 272); показатели
 * остаются. Стёртая панель исчезала из выгрузки, а филиал 3.20 исчезнувшее не
 * отвязывает: новая панель на ту же услугу роняла у него UNIQUE (мигр. 048) и
 * весь приём справочника, пока филиал не обновится. Списанная едет обычной
 * правкой строки раньше новой панели (выгрузка — по id), и её принимает филиал
 * любой версии. Экран списанную не показывает (views/lab-panels.js).
 */
export function labPanelDelete(db, args, user) {
  if (!tableWriteAllowed('lab_panels', 'delete', user, db)
      || !tableWriteAllowed('lab_panel_analytes', 'delete', user, db)) {
    throw new RpcError(NO_RIGHTS, 403);
  }
  const id = refId(args && args.id, 'Панель не найдена — обновите страницу.');
  if (!id) throw new RpcError('Панель не найдена — обновите страницу.', 404);
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM lab_panels WHERE id = ? AND retired_at IS NULL').get(id)) {
      throw new RpcError('Панель не найдена — обновите страницу.', 404);
    }
    // Ревью H2 — панель главного здания в филиале не удаляется: её завела бы заново ближайшая синхронизация.
    if (mainBuildingPanel(db, id)) {
      throw new RpcError('Эта панель приходит из главного здания: удалить её или сменить у неё услугу можно только там.', 409);
    }
    if (mainWithBranches(db)) {
      db.prepare(`UPDATE lab_panels SET active = 0, service_id = NULL, device_id = NULL,
                    retired_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(id);
      return { deleted: true, retired: true, analytes: 0 };
    }
    const gone = db.prepare('DELETE FROM lab_panel_analytes WHERE panel_id = ?').run(id).changes;
    db.prepare('DELETE FROM lab_panels WHERE id = ?').run(id);
    return { deleted: true, analytes: gone };
  })();
}
