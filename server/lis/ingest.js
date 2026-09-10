// LIS_INGEST_V1 — приём: найти заказ, применить ПОДТВЕРЖДЁННОЕ сопоставление,
// записать, продвинуть статус до «Проверить и выдать».
//
// Здесь держатся решения владельца и инварианты безопасности пациента. Менять
// поведение этого файла, не поправив
// docs/specs/2026-09-10-lis-analyzer-ingest-design.md, нельзя:
//
//   Инвариант 1  машина печатает, подписывает человек — verified_* не трогаем
//   Инвариант 2  ничего не теряется — сырое сообщение сохраняется всегда
//   Инвариант 3  референсы клиники бьют референсы прибора
//   Инвариант 4  имя и единица берутся из панели, а не из провода
//   D4           применяются ТОЛЬКО подтверждённые человеком сопоставления
//   D6           значение прибора замещает набранное руками в ЧЕРНОВИКЕ
//   D7           выданный результат молча не переписывается
import { parseMessage } from './hl7.js';
import { recordMessage, touchDevice } from './inbox.js';

/**
 * 'LAB-000123' → 123. Голые цифры принимаются: сканер может передавать
 * префикс, а может нет, и номер часто набирают руками (решение D2).
 */
export function parseSampleId(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^lab[-_ ]?/i, '');
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Флаг прибора → наш словарь. LL/HH/AA намеренно ведут в 'critical': они
 * кормят существующий счётчик критических результатов на панели отчётов.
 */
function flagFromDevice(abnormal) {
  switch (String(abnormal || '').toUpperCase()) {
    case '': case 'N': return 'normal';
    case 'L': return 'low';
    case 'H': return 'high';
    case 'LL': case 'HH': case 'AA': return 'critical';
    default: return 'abnormal';
  }
}

/** Инвариант 3: диапазон клиники бьёт диапазон прибора. null — клиника молчит. */
function flagFromClinic(num, low, high) {
  if (num == null) return null;
  if (low == null && high == null) return null;
  if (low != null && num < low) return 'low';
  if (high != null && num > high) return 'high';
  return 'normal';
}

/**
 * Принимает ОДНО сообщение и возвращает 'AA' либо 'AE' — то, что уйдёт прибору.
 *
 * 'AA' означает «принято и сохранено», а не «применено»: сообщение, не нашедшее
 * заказ, лежит в лотке и ждёт человека, и повторять его прибору незачем. 'AE'
 * отдаётся только там, где повтор ИМЕЕТ смысл: мусор на входе и сорванная
 * запись.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} raw     сырой текст сообщения
 * @param {string} peer    адрес отправителя (для лотка)
 * @param {number|null} deviceId  устройство, если удалось определить
 */
export function ingestMessage(db, raw, peer = '', deviceId = null) {
  let msg;
  try {
    msg = parseMessage(raw);
  } catch (e) {
    recordMessage(db, { deviceId, peer, raw, status: 'rejected', detail: e.message });
    return 'AE';
  }

  const base = { deviceId, peer, raw, sampleId: msg.sampleId };
  const vsId = parseSampleId(msg.sampleId);

  const order = vsId
    ? db.prepare(`SELECT vs.*, s.is_lab, s.name AS service_name FROM visit_services vs
                    JOIN services s ON s.id = vs.service_id
                   WHERE vs.id = ?`).get(vsId)
    : null;

  if (!order) {
    recordMessage(db, { ...base, status: 'unmatched', detail: 'заказ по номеру пробы не найден' });
    return 'AA';
  }
  if (!order.is_lab) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmatched',
      detail: 'услуга «' + (order.service_name || order.service_id) + '» не помечена как лабораторная' });
    return 'AA';
  }

  const panel = db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
  if (!panel) {
    // Название услуги здесь обязательно. У клиники бывает несколько похоже
    // названных услуг («Общий анализ крови (CBC)», «(ОАК)», «(стационар)»), и
    // безымянное «у услуги нет панели» не отвечает на единственный вопрос,
    // который человек задаёт в этот момент: у КАКОЙ именно.
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmapped',
      detail: 'услуга «' + (order.service_name || order.service_id) + '» не привязана ни к одной панели' });
    return 'AA';
  }
  if (!panel.device_id) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmapped',
      detail: 'панель «' + panel.name + '» не привязана к анализатору' });
    return 'AA';
  }
  if (deviceId && panel.device_id !== deviceId) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmatched',
      detail: 'панель «' + panel.name + '» кормится другим анализатором' });
    return 'AA';
  }

  // D7 — выданный бланк молча не переписывается. Проверка ДО записи: замещать
  // черновик помощь, замещать выданный отчёт пациента — другое дело.
  const released = db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL').get(order.id).c;
  if (released > 0) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'superseded',
      detail: 'результат уже выдан; новый результат требует подтверждения человеком' });
    touchDevice(db, deviceId);
    return 'AA';
  }

  const analytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1').all(panel.id);
  // D4 — применяются ТОЛЬКО подтверждённые сопоставления. Совпадение кода само
  // по себе разрешением не является: подтвердить обязан человек.
  const byCode = new Map(analytes
    .filter((a) => a.device_code && a.device_code_confirmed)
    .map((a) => [String(a.device_code).toUpperCase(), a]));

  const unapplied = [];
  let applied = 0;

  const run = db.transaction(() => {
    for (const obs of msg.observations) {
      const status = (obs.status || 'F').toUpperCase();
      if (status !== 'F') {
        // Предварительный (P) и неполученный (X) в бланк не идут: лаборант
        // подтвердил бы число, которое прибор ещё сам не считает окончательным.
        unapplied.push(obs.code + ' (статус ' + status + ')');
        continue;
      }

      const a = byCode.get(String(obs.code || '').toUpperCase());
      if (!a) { unapplied.push(obs.code); continue; }

      const num = obs.valueType === 'NM' && /^-?\d+(\.\d+)?$/.test(obs.value) ? parseFloat(obs.value) : null;
      const flag = flagFromClinic(num, a.ref_low, a.ref_high) || flagFromDevice(obs.abnormal);
      // Инвариант 3 и 4: диапазон, имя и единица — из панели. Диапазон прибора
      // берётся только там, где клиника свой не задала.
      const range = a.ref_text
        || (a.ref_low != null || a.ref_high != null ? `${a.ref_low == null ? '' : a.ref_low}-${a.ref_high == null ? '' : a.ref_high}` : (obs.range || ''));

      const existing = db.prepare('SELECT id FROM lab_results WHERE visit_service_id = ? AND parameter = ?').get(order.id, a.name);
      if (existing) {
        // D6 — машина побеждает в ЧЕРНОВИКЕ (выданное отсеяно выше).
        db.prepare(`UPDATE lab_results SET value = ?, numeric_value = ?, unit = ?, reference_range = ?,
                      ref_low = ?, ref_high = ?, flag = ?, source = 'analyzer',
                      entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE id = ?`)
          .run(obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag, existing.id);
      } else {
        db.prepare(`INSERT INTO lab_results
                      (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, entered_by, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'analyzer')`)
          .run(order.id, a.name, obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag);
      }
      applied++;
    }

    if (applied > 0 && order.status !== 'completed') {
      // Инвариант 1: до «resulted», и ни шагом дальше. verified_* не трогаем.
      // sample_collected_at не подставляем: времени забора мы не наблюдали, и
      // выдумать его значило бы записать в карту факт, которого не было.
      db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = ?").run(order.id);
    }

    recordMessage(db, {
      ...base,
      visitServiceId: order.id,
      status: unapplied.length ? 'unmapped' : 'applied',
      detail: unapplied.length ? 'не применены: ' + unapplied.join(', ') : '',
    });
  });

  try {
    run();
  } catch (e) {
    // Транзакция откатилась целиком. NAK — прибор пришлёт снова, и это здесь
    // помощник, а не помеха.
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'rejected', detail: 'ошибка записи: ' + e.message });
    return 'AE';
  }

  touchDevice(db, deviceId);
  return 'AA';
}
