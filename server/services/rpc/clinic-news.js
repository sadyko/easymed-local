// CLINIC_NEWS_V1 (2026-10-31) — «Информационная доска»: объявления клиники для
// сотрудников (мигр. 266). Владелец: «daily news of clinic, about foreign
// doctors coming, some equipment is not working place and so on».
//
// Читают ВСЕ вошедшие: объявление «аппарат УЗИ не работает» нужно регистратору
// и врачу не меньше, чем администратору, — поэтому своего ключа прав у чтения
// нет. Пишет и снимает администратор клиники.
import { isAdminUser } from '../grants.js';
import { today } from '../domain/day.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const NEWS_KINDS = ['news', 'doctor_visit', 'equipment', 'other'];
const TITLE_MAX = 200;
const BODY_MAX = 4000;

function requireUser(user) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
}
function requireAdmin(user) {
  requireUser(user);
  if (!isAdminUser(user)) throw new RpcError('Объявления на доске публикует администратор клиники.', 403);
}

// CLINIC_NEWS_IMPORTANT_V1 — n.important (мигр. 267): «Важно», жёлтым на экране.
const SELECT = `SELECT n.id, n.kind, n.title, n.body, n.pinned, n.important, n.show_until, n.created_at, n.updated_at, n.archived_at,
                       u.full_name AS author
                  FROM clinic_news n LEFT JOIN users u ON u.id = n.created_by`;

/**
 * Доска: живые объявления — не снятые и не истёкшие (show_until ≥ сегодня по
 * дате клиники), закреплённые сверху, за ними важные, дальше свежие.
 * archive: true — наоборот, снятые и истёкшие, последние 100.
 *
 * CLINIC_NEWS_IMPORTANT_V1 — важные идут сразу после закреплённых: полоса у
 * стойки (clinic-news-strip.js) показывает ПЕРВОЕ объявление, и важное не
 * должно теряться под обычной новостью, которая просто свежее.
 */
export function clinicNewsList(db, args, user) {
  requireUser(user);
  const t = today(db);
  if (args && args.archive) {
    return { today: t, items: db.prepare(`${SELECT}
       WHERE n.archived_at IS NOT NULL OR (n.show_until IS NOT NULL AND n.show_until < ?)
       ORDER BY COALESCE(n.archived_at, n.show_until) DESC, n.id DESC LIMIT 100`).all(t) };
  }
  return { today: t, items: db.prepare(`${SELECT}
     WHERE n.archived_at IS NULL AND (n.show_until IS NULL OR n.show_until >= ?)
     ORDER BY n.pinned DESC, n.important DESC, n.created_at DESC, n.id DESC`).all(t) };
}

function cleanArgs(args) {
  const a = args || {};
  const kind = String(a.kind || 'news');
  if (!NEWS_KINDS.includes(kind)) throw new RpcError('Неизвестный вид объявления.', 400);
  const title = String(a.title == null ? '' : a.title).trim();
  if (!title) throw new RpcError('Напишите заголовок объявления.', 400);
  if (title.length > TITLE_MAX) throw new RpcError('Заголовок слишком длинный — до 200 символов.', 400);
  const body = String(a.body == null ? '' : a.body).trim();
  if (body.length > BODY_MAX) throw new RpcError('Текст слишком длинный — до 4000 символов.', 400);
  let showUntil = a.show_until == null || a.show_until === '' ? null : String(a.show_until);
  if (showUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(showUntil)) throw new RpcError('Дата «Показывать до» не разобрана.', 400);
  return { kind, title, body, pinned: a.pinned ? 1 : 0, important: a.important ? 1 : 0, show_until: showUntil };
}

/** Опубликовать (без id) или исправить (с id) объявление. */
export function clinicNewsSave(db, args, user) {
  requireAdmin(user);
  const v = cleanArgs(args);
  const id = args && args.id != null ? Number(args.id) : null;
  if (id !== null) {
    if (!Number.isInteger(id) || id <= 0) throw new RpcError('Объявление не выбрано.', 400);
    const r = db.prepare(`UPDATE clinic_news SET kind = @kind, title = @title, body = @body, pinned = @pinned,
                            important = @important, show_until = @show_until, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                           WHERE id = @id AND archived_at IS NULL`).run({ ...v, id });
    if (!r.changes) throw new RpcError('Объявление уже снято с доски — исправить нельзя.', 409);
    return { id };
  }
  const r = db.prepare(`INSERT INTO clinic_news (kind, title, body, pinned, important, show_until, created_by)
                        VALUES (@kind, @title, @body, @pinned, @important, @show_until, @created_by)`).run({ ...v, created_by: user.id });
  return { id: Number(r.lastInsertRowid) };
}

/** «Снять с доски»: строка остаётся в архиве. */
export function clinicNewsArchive(db, args, user) {
  requireAdmin(user);
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Объявление не выбрано.', 400);
  const r = db.prepare(`UPDATE clinic_news SET archived_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), archived_by = ?
                         WHERE id = ? AND archived_at IS NULL`).run(user.id, id);
  return { id, archived: r.changes > 0 };
}
