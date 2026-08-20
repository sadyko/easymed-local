// LAB_SAVE_BATCH_V1 — сохранение всей панели ОДНИМ запросом и одной транзакцией.
//
// Было: клиент слал по HTTP-запросу на КАЖДЫЙ показатель. На loopback это
// незаметно, но лаборатория работает по сети клиники, и общий анализ крови из
// 28 показателей превращался в 29 последовательных обращений: при RTT 40 мс —
// больше секунды ожидания на пустом месте (сама вставка в SQLite занимает
// 0.06 мс).
//
// Хуже задержки была НЕАТОМАРНОСТЬ: обрыв связи на четырнадцатом показателе
// оставлял панель наполовину записанной, а статус услуги — непереведённым.
// Для результатов анализов это опаснее медленного сохранения: половина бланка
// выглядит как полный бланк.
//
// Теперь весь бланк уходит одним вызовом и пишется в одной транзакции: либо
// сохраняются все показатели и статус, либо не меняется ничего.

import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Те же роли, что у прямой записи в lab_results (schema-registry): RPC не
// должен становиться обходным путём для тех, кому таблица закрыта.
const WRITE_ROLES = ['admin', 'lab'];

const FLAGS = new Set(['normal', 'high', 'low', 'abnormal', 'critical']);

export function saveLabResults(db, args, user) {
  if (!hasAnyRole(user, WRITE_ROLES)) {
    throw new RpcError('Сохранять результаты анализов может лаборатория или администратор.', 403);
  }
  const a = args || {};
  const vsId = Number(a.visit_service_id);
  if (!Number.isInteger(vsId) || vsId <= 0) throw new RpcError('Не указана услуга.', 400);

  const order = db.prepare('SELECT id FROM visit_services WHERE id = ?').get(vsId);
  if (!order) throw new RpcError('Услуга не найдена.', 400);

  const rows = Array.isArray(a.rows) ? a.rows : [];
  if (!rows.length) throw new RpcError('Нет ни одного показателя для сохранения.', 400);

  // notes и flag NOT NULL (миграция 006): передать null — значит перебить
  // умолчание колонки и получить отказ на вставке. Нормализуем здесь, чтобы
  // правило жило в одном месте.
  const notes = String(a.notes == null ? '' : a.notes);
  const enteredBy = user && user.id ? user.id : null;

  const clean = rows.map((r, i) => {
    const parameter = String((r && r.parameter) || '').trim();
    if (!parameter) throw new RpcError('Показатель №' + (i + 1) + ': пустое название.', 400);
    const flag = FLAGS.has(r && r.flag) ? r.flag : 'normal';
    const num = r && r.numeric_value;
    return {
      id: r && r.id != null ? Number(r.id) : null,
      parameter,
      value: r && r.value != null ? String(r.value) : null,
      numeric_value: Number.isFinite(num) ? num : null,
      unit: r && r.unit ? String(r.unit) : null,
      reference_range: r && r.reference_range ? String(r.reference_range) : null,
      ref_low: Number.isFinite(r && r.ref_low) ? r.ref_low : null,
      ref_high: Number.isFinite(r && r.ref_high) ? r.ref_high : null,
      flag,
    };
  });

  const upd = db.prepare(`UPDATE lab_results SET
      parameter=@parameter, value=@value, numeric_value=@numeric_value, unit=@unit,
      reference_range=@reference_range, ref_low=@ref_low, ref_high=@ref_high,
      flag=@flag, notes=@notes
    WHERE id=@id AND visit_service_id=@vs`);
  const ins = db.prepare(`INSERT INTO lab_results
      (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, notes, entered_by)
    VALUES (@vs, @parameter, @value, @numeric_value, @unit, @reference_range, @ref_low, @ref_high, @flag, @notes, @entered_by)`);
  const setStatus = db.prepare("UPDATE visit_services SET status='resulted' WHERE id=?");

  let inserted = 0, updated = 0;
  db.transaction(() => {
    for (const row of clean) {
      const p = { ...row, vs: vsId, notes, entered_by: enteredBy };
      if (row.id) {
        // Правку строки ограничиваем ЭТОЙ услугой: id приходит от клиента, и
        // без привязки к vsId им можно было бы переписать чужой результат.
        const res = upd.run(p);
        if (res.changes) { updated++; continue; }
        // Строки с таким id в этой услуге нет — заводим новую, а не молча
        // теряем введённое лаборантом значение.
      }
      ins.run(p);
      inserted++;
    }
    setStatus.run(vsId);
  })();

  return { visit_service_id: vsId, inserted, updated, saved: inserted + updated };
}
