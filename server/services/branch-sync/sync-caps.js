// FINAL_ROLES_SYNC_FIX_V1 (I4, 2026-09-27) — УМЕНИЯ ЗДАНИЙ СЕТИ.
//
// Сборки в сети обновляются не одновременно. Большинство новых записей
// журнала старый сосед переживает (лишнюю колонку не видит), но есть
// записи, потеря которых необратима: событие объединения карт (patient_merges,
// мигр. 168) старый сосед пропускает как неизвестную таблицу, квитанцию
// отдаёт — и о слиянии не узнаёт никогда, а надгробие дубля у него падает на
// внешнем ключе или стирает журнал карты.
//
// Поэтому выгрузка журнала несёт `caps` — список умений этой сборки — и её
// номер; приёмник пишет их в sync_peers (мигр. 185). Действие, которое требует
// умения у соседа, спрашивает здесь, у кого его нет.
import { readAppVersion } from '../control/checkin.js';

/** Умение «понимаю события объединения карт» (patient_merges, мигр. 168). */
export const CAP_MERGE_EVENTS = 'merge_events';
/** Что умеет ЭТА сборка. Кладётся в каждую выгрузку журнала. */
export const SYNC_CAPS = Object.freeze([CAP_MERGE_EVENTS]);

let _version = null;
/** Номер этой сборки (package.json), один раз на процесс. */
export function buildVersion() {
  if (_version == null) _version = readAppVersion();
  return _version;
}

/** caps из выгрузки соседа: массив коротких строк или null («не прислал»). */
export function capsOf(payload) {
  const c = payload && payload.caps;
  if (!Array.isArray(c)) return null;
  return c.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 64);
}

/**
 * Записать, что сосед сказал о себе в последней выгрузке. Выгрузка без caps —
 * сборка до этого правила: умения сбрасываются в NULL («не знаем — значит
 * нет»), даже если раньше сосед их называл (откат сборки у соседа).
 */
export function notePeerCaps(db, peer, payload, now = new Date()) {
  const node = String(peer == null ? '' : peer).trim().toUpperCase();
  if (!node) return;
  const caps = capsOf(payload);
  const version = payload && typeof payload.app_version === 'string' ? payload.app_version.slice(0, 32) : null;
  try {
    db.prepare(`INSERT INTO sync_peers (node, caps, app_version, caps_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(node) DO UPDATE SET caps = excluded.caps, app_version = excluded.app_version, caps_at = excluded.caps_at`)
      .run(node, caps ? JSON.stringify(caps) : null, version, (now instanceof Date ? now : new Date()).toISOString());
  } catch (e) {
    console.warn('[branch-sync] could not record what', node, 'can do:', e && e.message);
  }
}

/** Заявлял ли сосед это умение в последней выгрузке. */
export function peerHasCap(row, cap) {
  if (!row || !row.caps) return false;
  try { const c = JSON.parse(row.caps); return Array.isArray(c) && c.includes(cap); }
  catch { return false; }
}

/** Буквы соседей по сети (все здания группы, кроме этого). */
export function groupPeers(db) {
  let self = null;
  try { const r = db.prepare('SELECT letter FROM branch_identity WHERE id = 1').get(); self = r && r.letter ? String(r.letter).toUpperCase() : null; }
  catch { self = null; }
  let rows = [];
  try { rows = db.prepare("SELECT letter FROM branches WHERE letter IS NOT NULL AND letter <> ''").all(); }
  catch { rows = []; }
  const out = [];
  for (const r of rows) {
    const l = String(r.letter).trim().toUpperCase();
    if (l && l !== self && !out.includes(l)) out.push(l);
  }
  return out;
}

/**
 * Уехала ли карта (строка patients) к соседу `peer` — или могла уехать.
 * Осторожно в сторону «уехала»: ошибиться здесь «не уехала» значит потерять
 * событие у старого соседа.
 *   • карта из другого здания (sync_origin) — есть в сети; считаем, что у всех;
 *   • своя: у соседа нет строки обмена — ему ничего не выкладывали (новая
 *     карта уедет засевом уже объединённой);
 *   • засев идёт — считаем уехавшей;
 *   • журнала по карте не осталось (вычищен после подтверждения) — уехала;
 *   • иначе — уехала, если её первая запись журнала не выше выложенного.
 */
export function cardShippedTo(db, row, peer) {
  if (!row) return false;
  if (row.sync_origin != null) return true;
  if (!row.uid) return false;   // вне сети (база до 083)
  const p = db.prepare('SELECT pub_seq, seed_floor, last_ok FROM sync_peers WHERE node = ?').get(peer);
  if (!p) return false;
  if (p.seed_floor != null) return true;
  const first = db.prepare("SELECT MIN(seq) s FROM sync_journal WHERE tbl = 'patients' AND uid = ?").get(row.uid);
  if (!first || first.s == null) return p.last_ok != null || p.pub_seq > 0;
  return first.s <= p.pub_seq;
}

/**
 * Соседи без умения `cap`, у которых уже есть хоть одна из этих карт.
 * @returns {string[]} буквы зданий, отсортированные
 */
export function peersBlockingCards(db, rows, cap) {
  const out = [];
  for (const peer of groupPeers(db)) {
    const info = db.prepare('SELECT caps FROM sync_peers WHERE node = ?').get(peer);
    if (peerHasCap(info, cap)) continue;
    if (rows.some((r) => cardShippedTo(db, r, peer))) out.push(peer);
  }
  return out.sort();
}
