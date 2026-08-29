import { hasAnyRole } from '../roles.js';
import { getDataDir } from '../control/config.js';
import { createBackup } from '../backup.js';
import { applyCatalogue } from '../branch-sync/catalogue.js';
import { pullCatalogue } from '../branch-sync/pull.js';
import {
  readPairing, makeMainKey, pairWithKey, clearPairing, suggestMainUrl,
} from '../branch-sync/pairing.js';

// BRANCH_SYNC_V1 — пять вызовов, которыми живёт экран «Настройки → Филиалы».
//
// Разделение то же, что у licence.js: транспорт, подписи и запись на диск лежат
// в services/branch-sync/*, а здесь только права доступа, порядок действий и
// перевод закрытого словаря причин в русские фразы, которые экран показывает
// как есть.
//
// НИ ОДИН из этих вызовов не входит в ALWAYS_ALLOWED_RPCS (control/gate.js).
// Приём справочника — это запись в базу, и клиника с просроченной лицензией
// пишет не больше, чем в любом другом разделе. Читающий branch_sync_status
// внесён в READ_ONLY_RPCS: экран обязан честно рассказать о своём состоянии
// даже заблокированной клинике.

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requireAdmin(user) {
  // hasAnyRole, а не user.role — правило ADMIN_DOCTOR_V1: у администратора
  // клиники основной ролью нередко стоит «врач», и проверка по user.role
  // закрыла бы ему единственный экран, где связывают филиалы. Эта ошибка в
  // проекте всплывала дважды.
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Только администратор может настраивать связь между филиалами.', 403);
  }
}

// Словарь причин из pull.js/pairing.js -> то, что видит владелец. Ключевое
// требование владельца к этому экрану: филиал, который не достучался до
// главного, обязан сказать ИМЕННО ЭТО, а не «ошибка синхронизации».
const REASONS = {
  not_paired:   'Филиал ещё не подключён к главному. Введите ключ подключения.',
  not_secondary: 'Это главный филиал — он раздаёт справочник, а не забирает его.',
  offline:      'Нет связи с главным филиалом. Проверьте, включён ли его компьютер и та же ли это сеть.',
  unauthorized: 'Главный филиал не принял ключ. Получите новый ключ подключения и введите его заново.',
  clock_skew:   'Часы этого компьютера сильно расходятся с главным филиалом. Проверьте дату и время.',
  not_main:     'По этому адресу отвечает Easy-Med, но это не главный филиал. Проверьте адрес в ключе подключения.',
  server_error: 'Главный филиал ответил ошибкой. Попробуйте позже.',
  too_large:    'Справочник слишком большой для передачи. Обратитесь в поддержку Easy-Med.',
  bad_response: 'Главный филиал ответил непонятным образом. Попробуйте позже.',
  backup_failed: 'Не удалось создать резервную копию перед обновлением справочника — синхронизация отменена.',
  empty_key:    'Введите ключ подключения.',
  bad_key:      'Ключ подключения неверный. Проверьте, что он скопирован целиком.',
  already_main: 'Эта установка уже назначена главным филиалом. Сначала отвяжите её.',
  already_secondary: 'Эта установка уже подключена к главному филиалу. Сначала отвяжите её.',
  bad_url:      'Адрес указан неверно. Пример: 10.0.0.5:8000',
  write_failed: 'Не удалось сохранить настройку связи на диск. Проверьте свободное место.',
};
const reasonText = (reason) => REASONS[reason] || 'Не удалось выполнить действие. Попробуйте ещё раз.';

function getState(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}
function putState(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}
function readJsonState(db, key) {
  const raw = getState(db, key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    // Испорченная запись о прошлой синхронизации не должна ронять экран —
    // «неизвестно, когда синхронизировались» это честный ответ, 500 нет.
    return null;
  }
}

const LAST_ATTEMPT = 'branch_sync_last_attempt';   // любая попытка, включая неудачную
const LAST_OK = 'branch_sync_last_ok';             // последняя УСПЕШНАЯ

/**
 * Всё, что нужно экрану, одним вызовом. Секрет наружу НЕ отдаётся ни при каких
 * условиях: ключ подключения выдаёт отдельный вызов, доступный только
 * администратору, а этот читают все, кому открыты настройки.
 */
export function branchSyncStatus(db, args, user) {
  const pairing = readPairing(getDataDir());
  return {
    role: pairing ? pairing.role : 'none',
    group_id: pairing ? pairing.group_id : null,
    main_url: pairing ? (pairing.main_url || null) : null,
    paired_at: pairing?.paired_at || pairing?.created_at || null,
    last_attempt: readJsonState(db, LAST_ATTEMPT),
    last_ok: readJsonState(db, LAST_OK),
    // Подсказка для поля «Адрес этого компьютера» — чтобы владельцу не
    // приходилось выяснять IP через ipconfig.
    suggested_url: suggestMainUrl(),
  };
}

/**
 * «Сделать этот филиал главным» / «Показать ключ подключения».
 *
 * Повторный вызов возвращает ТОТ ЖЕ ключ (см. makeMainKey): ключ переносят не
 * мгновенно, и перевыпуск при каждом открытии экрана рвал бы связь уже
 * подключённым филиалам.
 */
export function branchSyncMakeKey(db, args, user) {
  requireAdmin(user);
  const existing = readPairing(getDataDir());
  // Проверяется ДО адреса: подключённый филиал, нажавший «сделать главным»,
  // должен услышать «сначала отвяжите», а не «адрес указан неверно» — иначе он
  // будет чинить поле, которое не при чём.
  if (existing && existing.role === 'secondary') throw new RpcError(reasonText('already_secondary'), 400);
  // Кнопка «Показать ключ» на уже настроенном главном филиале: адрес заново не
  // спрашиваем, берём записанный.
  const url = (args && typeof args.url === 'string' && args.url.trim())
    ? args.url
    : (existing?.role === 'main' ? existing.main_url : null);
  if (!url) throw new RpcError(reasonText('bad_url'), 400);

  const r = makeMainKey(getDataDir(), { url });
  if (!r.ok) throw new RpcError(reasonText(r.reason), 400);
  return { ok: true, role: 'main', group_id: r.record.group_id, main_url: r.record.main_url, key: r.key };
}

/** «Подключиться к главному филиалу» — владелец вставляет ключ. */
export function branchSyncPair(db, args, user) {
  requireAdmin(user);
  const r = pairWithKey(getDataDir(), args && args.key);
  if (!r.ok) throw new RpcError(reasonText(r.reason), 400);
  return { ok: true, role: 'secondary', group_id: r.record.group_id, main_url: r.record.main_url };
}

/**
 * «Отвязать».
 *
 * Стирается СВЯЗЬ, а не данные: услуги и панели, которые уже приехали, остаются
 * — филиал ими работает, на них ссылаются его счета. Карта соответствий
 * (branch_sync_map) очищается: она осмысленна только в паре с конкретным
 * главным филиалом, и если завтра филиал подключат к другому, чужие id из
 * прошлой пары начали бы указывать не туда.
 */
export function branchSyncUnpair(db, args, user) {
  requireAdmin(user);
  clearPairing(getDataDir());
  db.prepare('DELETE FROM branch_sync_map').run();
  db.prepare('DELETE FROM control_state WHERE key IN (?, ?)').run(LAST_ATTEMPT, LAST_OK);
  return { ok: true, role: 'none' };
}

/**
 * «Синхронизировать сейчас» — забрать справочник и применить его.
 *
 * Порядок шагов и есть вся безопасность этой функции:
 *   1. забрать по сети (ничего не пишем, пока не получили целый ответ);
 *   2. ХОЛОСТОЙ ПРОГОН — тем же кодом посчитать, изменится ли хоть что-нибудь.
 *      Если нет, на этом всё: ни копии, ни транзакции, ни строки в журнале
 *      изменений. Повторный запуск обязан быть пустышкой, иначе экран каждый
 *      день показывал бы «обновлено» там, где ничего не происходило;
 *   3. резервная копия ВСЕЙ базы (services/backup.js, вид 'safety' — тот же
 *      механизм, что перед восстановлением из копии);
 *   4. приём в ОДНОЙ транзакции: либо весь справочник, либо ничего.
 *
 * Недоступный главный филиал — это ok:false с причиной, а НЕ исключение:
 * работа в офлайне здесь норма, и она не должна выглядеть как поломка.
 */
export async function branchSyncNow(db, args, user, { pullImpl = pullCatalogue, backupImpl = createBackup } = {}) {
  requireAdmin(user);
  const dataDir = getDataDir();

  const pulled = await pullImpl(dataDir);
  if (!pulled.ok) return finish(db, { ok: false, reason: pulled.reason });

  // Холостой прогон — вне транзакции: он ничего не пишет по построению
  // (см. applyCatalogue, dryRun).
  let preview;
  try {
    preview = applyCatalogue(db, pulled.catalogue, { dryRun: true });
  } catch (e) {
    console.warn('[branch-sync] could not read the incoming catalogue:', e && e.message);
    return finish(db, { ok: false, reason: 'bad_response' });
  }
  if (!preview.changed) {
    return finish(db, { ok: true, changed: 0, created: {}, updated: {}, adopted: {}, settings: false });
  }

  try {
    await backupImpl(db, dataDir, 'safety');
  } catch (e) {
    // Без копии не применяем. Справочник — не та ценность, ради которой стоит
    // рисковать базой без пути назад.
    console.warn('[branch-sync] refusing to apply without a backup:', e && e.message);
    return finish(db, { ok: false, reason: 'backup_failed' });
  }

  let summary;
  try {
    summary = db.transaction(() => applyCatalogue(db, pulled.catalogue))();
  } catch (e) {
    // Транзакция откатилась целиком — база ровно такая, какой была. Копия из
    // шага 3 остаётся лежать: она не понадобилась, но её наличие и есть
    // доказательство, что откат был не единственным путём назад.
    console.warn('[branch-sync] apply failed, rolled back:', e && e.message);
    return finish(db, { ok: false, reason: 'server_error' });
  }

  return finish(db, { ok: true, ...summary });
}

// Итог попытки записывается всегда — и удачной, и нет. Экран должен уметь
// сказать «последний раз получилось вчера в 19:40, сегодня в 9:05 не было
// связи»: одна дата на оба случая скрыла бы ровно ту неисправность, ради
// которой на экран смотрят.
function finish(db, result) {
  const at = new Date().toISOString();
  const record = { at, ...result };
  if (!result.ok) record.message = reasonText(result.reason);
  try {
    putState(db, LAST_ATTEMPT, JSON.stringify(record));
    if (result.ok) putState(db, LAST_OK, JSON.stringify(record));
  } catch (e) {
    // Журнал попыток — не то, ради чего стоит терять уже применённый
    // справочник. Сообщаем результат вызывающему в любом случае.
    console.warn('[branch-sync] could not record the sync result:', e && e.message);
  }
  return record;
}
