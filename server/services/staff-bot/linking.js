// STAFF_ATTENDANCE_V1 — подключение Telegram сотрудника к его учётной записи.
//
// ТЗ: «сотрудник проверен и связан с записью HR; выбрать себе роль нельзя».
// Совпадения телефона мало: отметка присутствия — это деньги (часы), и
// чужой номер в анкете не должен давать отмечаться за другого. Поэтому:
//   1. HR в «Посещаемость → Сотрудники» нажимает «Код подключения» — сервер
//      выдаёт одноразовый код (живёт 15 минут) и ссылку t.me/<бот>?start=lnk_<код>;
//   2. сотрудник открывает ссылку СВОИМ Telegram — бот привязывает from.id.
// В базе хранится только SHA-256 кода: прочитавший копию базы код не применит.
// Новый код гасит прежние неиспользованные коды этого сотрудника.
import crypto from 'node:crypto';

export const CODE_MINUTES = 15;
const CODE_RE = /^lnk_([A-Za-z0-9]{20})$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const hash = (code) => crypto.createHash('sha256').update(code).digest('hex');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function randomCode(len = 20) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** Выдать код. Возвращает { code, start, expires_at } — сам код показывают один раз. */
export function issueLinkCode(db, userId, byUserId, nowMs = Date.now()) {
  const code = randomCode();
  const expires = iso(nowMs + CODE_MINUTES * 60000);
  db.transaction(() => {
    db.prepare(`UPDATE staff_link_codes SET used_at = ?, used_tg_user_id = '' WHERE user_id = ? AND used_at IS NULL`).run(iso(nowMs), userId);
    db.prepare('INSERT INTO staff_link_codes (user_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, hash(code), byUserId, iso(nowMs), expires);
  })();
  return { code, start: `lnk_${code}`, expires_at: expires };
}

export function parseLinkStart(param) {
  const m = CODE_RE.exec(String(param || ''));
  return m ? m[1] : null;
}

/**
 * Применить код из /start. Возвращает { ok: true, user } или { ok: false, reason }:
 *   'bad_code' — нет такого, использован или истёк;
 *   'inactive' — сотрудник уволен;
 *   'taken'    — этот Telegram уже подключён к ДРУГОМУ сотруднику (сначала HR снимает ту связку).
 * Прежний Telegram этого же сотрудника отключается (телефон сменили).
 */
export function redeemLinkCode(db, { code, tgUserId, chatId, tgUsername = '', nowMs = Date.now() }) {
  const tg = String(tgUserId);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM staff_link_codes WHERE code_hash = ?').get(hash(code));
    if (!row || row.used_at || row.expires_at < iso(nowMs)) return { ok: false, reason: 'bad_code' };
    const user = db.prepare('SELECT id, full_name, is_active FROM users WHERE id = ?').get(row.user_id);
    if (!user || !user.is_active) return { ok: false, reason: 'inactive' };
    const other = db.prepare('SELECT user_id FROM staff_telegram_links WHERE tg_user_id = ? AND revoked_at IS NULL').get(tg);
    if (other && other.user_id !== user.id) return { ok: false, reason: 'taken' };
    db.prepare('UPDATE staff_link_codes SET used_at = ?, used_tg_user_id = ? WHERE id = ?').run(iso(nowMs), tg, row.id);
    if (other && other.user_id === user.id) {
      db.prepare('UPDATE staff_telegram_links SET chat_id = ?, tg_username = ? WHERE tg_user_id = ? AND revoked_at IS NULL')
        .run(String(chatId), String(tgUsername || ''), tg);
    } else {
      db.prepare('UPDATE staff_telegram_links SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(iso(nowMs), user.id);
      db.prepare('INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id, tg_username, linked_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, tg, String(chatId), String(tgUsername || ''), iso(nowMs));
    }
    return { ok: true, user: { id: user.id, full_name: user.full_name } };
  })();
}

/** Отключить Telegram сотрудника (HR). */
export function revokeLink(db, userId, byUserId) {
  const r = db.prepare(`UPDATE staff_telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
                         WHERE user_id = ? AND revoked_at IS NULL`).run(byUserId, userId);
  return { revoked: r.changes > 0 };
}
