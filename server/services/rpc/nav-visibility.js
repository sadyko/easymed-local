// NAV_VISIBILITY_V1 (2026-10-26) — видимость разделов бокового меню для всей клиники.
//
// Читают все вошедшие (оболочка спрашивает список до первой отрисовки меню),
// меняет администратор — из «Настройки → Основное → Видимость разделов». Список
// проверяется общей логикой (public/js/admin/nav-visibility-logic.js): годные id
// пунктов меню, «Настройки» — никогда. Сохранение заменяет список целиком: что
// на экране, то и в базе.
import { isAdminUser } from '../grants.js';
import { normalizeHidden, isNavIdLike, canHide, NEVER_HIDDEN } from '../../../public/js/admin/nav-visibility-logic.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function navVisibilityGet(db, _args, user) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
  let rows = [];
  try { rows = db.prepare('SELECT nav_id FROM nav_visibility ORDER BY nav_id').all(); }
  catch { rows = []; }   // сборка без миграции 254 — ничего не скрыто
  return { hidden: normalizeHidden(rows.map((r) => r.nav_id)) };
}

export function navVisibilitySave(db, args, user) {
  if (!isAdminUser(user)) throw new RpcError('Видимость разделов меняет администратор клиники.', 403);
  const raw = args && args.hidden;
  if (!Array.isArray(raw)) throw new RpcError('Список скрытых разделов не разобран.', 400);
  if (raw.some((v) => NEVER_HIDDEN.includes(String(v)))) {
    throw new RpcError('«Настройки» скрыть нельзя: иначе негде будет вернуть остальные разделы.', 400);
  }
  const bad = raw.filter((v) => !isNavIdLike(v));
  if (bad.length) throw new RpcError('Непонятный идентификатор раздела: ' + bad.map((v) => JSON.stringify(v)).join(', '), 400);
  // FIX_318_V1 (B3) — только пункты бокового меню. Подэкран «Настроек» («Видимость
  // разделов», «Сотрудники», «Система») или выдуманный id прямым вызовом мимо
  // экрана — отказ, а не молчаливое «сохранено»: иначе можно было спрятать
  // экран, на котором видимость возвращают.
  if (raw.some((v) => !canHide(v))) {
    throw new RpcError('Скрыть можно только раздел бокового меню; «Настройки» и их страницы скрыть нельзя.', 400);
  }
  const hidden = normalizeHidden(raw);
  const uid = user && user.id ? user.id : null;
  db.transaction(() => {
    db.prepare('DELETE FROM nav_visibility').run();
    const ins = db.prepare('INSERT INTO nav_visibility (nav_id, hidden_by) VALUES (?, ?)');
    for (const id of hidden) ins.run(id, uid);
  })();
  return { hidden };
}
