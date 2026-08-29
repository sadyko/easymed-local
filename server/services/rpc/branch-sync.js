import { hasAnyRole } from '../roles.js';
import { getDataDir } from '../control/config.js';
import { createBackup } from '../backup.js';
import { applyCatalogue } from '../branch-sync/catalogue.js';
import { pullCatalogue } from '../branch-sync/pull.js';
import {
  readPairing, writePairing, makeMainKey, pairWithKey, clearPairing, suggestMainUrl, relayEnabled,
} from '../branch-sync/pairing.js';
// BRANCH_SYNC_RELAY_V1 — Маршрут Б: те же три файла, что и у Маршрута А, только
// транспорт другой. Ключ группы и его выпуск при активации — в sync-group.js.
import { ensureSyncGroup, regenerateSyncGroup, readSyncGroup } from '../branch-sync/sync-group.js';
import { fetchCatalogue, publishCatalogue, readLastPublish, LAST_PUBLISH_KEY } from '../branch-sync/relay.js';
import { relayIdFor } from '../branch-sync/relay-crypto.js';

// BRANCH_SYNC_V1 — вызовы, которыми живёт экран «Настройки → Филиалы».
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

  // BRANCH_SYNC_RELAY_V1 — причины резервного канала. Отдельные фразы, а не
  // «ошибка сети»: владелец обязан понимать, ЧТО чинить и НА КАКОЙ машине.
  relay_not_main: 'Копию на сервер отправляет только главный филиал.',
  relay_not_secondary: 'Забирать копию с сервера может только подключённый филиал.',
  relay_disabled: 'Резервный канал через сервер Easy-Med выключен.',
  relay_no_key: 'У этого филиала нет ключа синхронизации. Перевыпустите ключ подключения в главном филиале и введите его здесь заново.',
  relay_not_enrolled: 'Клиника не активирована через Easy-Med, поэтому резервный канал недоступен.',
  relay_offline: 'Нет связи с сервером Easy-Med.',
  relay_unauthorized: 'Сервер Easy-Med не принял эту установку. Проверьте активацию клиники.',
  relay_empty: 'На сервере пока нет копии справочника. Включите отправку копии в главном филиале.',
  relay_too_large: 'Справочник слишком большой для передачи через сервер. Обратитесь в поддержку Easy-Med.',
  relay_server_error: 'Сервер Easy-Med ответил ошибкой. Попробуйте позже.',
  relay_bad_key: 'Ключи филиалов не совпадают: копию с сервера расшифровать не удалось. Скорее всего, в главном филиале перевыпустили ключ — получите новый ключ подключения и введите его здесь.',
  relay_bad_response: 'Копия с сервера повреждена и не была применена.',
  relay_is_secondary: 'Перевыпустить ключ можно только в главном филиале — этот филиал получает ключ от него.',
};
const reasonText = (reason) => REASONS[reason] || 'Не удалось выполнить действие. Попробуйте ещё раз.';
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// BRANCH_SYNC_RELAY_V1 — когда неудача ПРЯМОГО пути оправдывает попытку через
// сервер поставщика, а когда нет. Список закрытый, и исключения в нём важнее
// включений:
//   * unauthorized / clock_skew НЕ здесь. Это настоящая неисправность — не тот
//     ключ, сбитые часы, — и её надо чинить, а не заклеивать копией с сервера.
//     Молча подсунув владельцу вчерашний справочник, мы спрятали бы ровно ту
//     поломку, ради которой он на экран и смотрит;
//   * not_paired / not_secondary тоже не здесь: связи нет вовсе, забирать
//     нечего и незачем.
// Остальное — «до главного филиала не достучались»: выключенный компьютер,
// другая сеть, устаревший адрес, невнятный ответ. Ровно то, ради чего Маршрут Б
// и построен.
const RELAY_FALLBACK_REASONS = new Set([
  'offline', 'server_error', 'not_main', 'bad_response', 'too_large',
]);

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
  const dataDir = getDataDir();
  const pairing = readPairing(dataDir);
  // BRANCH_SYNC_RELAY_V1 — ключ, выписанный при активации. Читается, а НЕ
  // создаётся: статус читают все, кому открыты настройки, и открытие экрана
  // не должно ничего писать на диск. Создание — в тех вызовах, где ключ
  // действительно нужен (branchSyncMakeKey, branchSyncRelaySet).
  const group = readSyncGroup(dataDir);
  // Ключ, которым РАБОТАЕТ эта пара: у главного филиала он свой, у
  // подключённого — приехавший в ключе подключения. Пары, созданные до
  // Маршрута Б, поля не имеют, и это на экране отдельное честное состояние.
  const pairKey = pairing?.group_key || null;
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

    // --- Маршрут Б -------------------------------------------------------
    // НИ ОДНО из этих полей не содержит самого ключа и не может его выдать:
    // наружу уходит только ФАКТ его существования и дата. Ключ покидает
    // установку ровно одним способом — внутри ключа подключения, который
    // выдаёт отдельный вызов, доступный только администратору.
    sync_key_present: !!(group || pairKey),
    sync_key_created_at: group?.created_at || null,
    // Готов ли резервный канал: у пары есть ключ шифрования нужного размера.
    relay_ready: !!relayIdFor(pairKey),
    relay_enabled: relayEnabled(pairing),
    // Последняя выгрузка копии — только у главного филиала она осмысленна.
    relay_last_publish: pairing?.role === 'main' ? readLastPublish(db) : null,
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

  // BRANCH_SYNC_RELAY_V1 — ключ синхронизации берётся здесь и кладётся В КЛЮЧ
  // ПОДКЛЮЧЕНИЯ. Это единственный путь, которым он попадает во второй филиал:
  // владелец переносит ключ руками, минуя сервер поставщика.
  //
  // ensureSyncGroup, а не readSyncGroup: установка, активированная до появления
  // Маршрута Б (или лицензированная по телефону, без активации вообще), файла
  // не имеет, и без ленивого создания она осталась бы без резервного канала
  // навсегда. Неудачная запись не срывает выдачу ключа — Маршрут А работает и
  // без шифрования, а экран скажет, что резервный канал недоступен.
  const dataDir = getDataDir();
  const group = ensureSyncGroup(dataDir);

  // rotate НЕ прокидывается из args намеренно: перевыпуск — разрушительное
  // действие (отваливаются все филиалы), и у него свой вызов, перед которым
  // экран спрашивает подтверждение. Скрытый флажок в «показать ключ» был бы
  // способом сделать это случайно.
  const r = makeMainKey(dataDir, { url, groupId: group?.group_id, groupKey: group?.key });
  if (!r.ok) throw new RpcError(reasonText(r.reason), 400);
  return {
    ok: true,
    role: 'main',
    group_id: r.record.group_id,
    main_url: r.record.main_url,
    key: r.key,
    relay_ready: !!relayIdFor(r.record.group_key),
  };
}

/** «Подключиться к главному филиалу» — владелец вставляет ключ. */
export function branchSyncPair(db, args, user) {
  requireAdmin(user);
  const before = readPairing(getDataDir());
  const r = pairWithKey(getDataDir(), args && args.key);
  if (!r.ok) throw new RpcError(reasonText(r.reason), 400);
  // Повторный ввод ключа — обычное дело: в главном филиале сменился адрес или
  // перевыпустили ключ, и владелец разносит новый по филиалам. Если это ДРУГАЯ
  // группа, карта соответствий обязана уйти вместе со старой парой: «строка 7
  // главного филиала = наша строка 512» осмысленно только внутри той пары, и
  // против нового главного филиала эти номера указывали бы не туда — тот самый
  // класс ошибки, ради которого branch_sync_map вообще существует (миграция 079).
  if (before && before.group_id && before.group_id !== r.record.group_id) {
    db.prepare('DELETE FROM branch_sync_map').run();
  }
  return {
    ok: true,
    role: 'secondary',
    group_id: r.record.group_id,
    main_url: r.record.main_url,
    relay_ready: !!relayIdFor(r.record.group_key),
  };
}

/**
 * «Резервный канал через сервер Easy-Med» — включить или выключить.
 *
 * Один вызов на обе роли, потому что переключатель на экране один, а смысл у
 * него зависит от роли: главный филиал соглашается ВЫГРУЖАТЬ зашифрованную
 * копию, подключённый — ЗАБИРАТЬ её, когда прямой путь не удался. Умолчания
 * тоже разные и объяснены в pairing.js relayEnabled().
 */
export function branchSyncRelaySet(db, args, user) {
  requireAdmin(user);
  const dataDir = getDataDir();
  const pairing = readPairing(dataDir);
  if (!pairing) throw new RpcError(reasonText('not_paired'), 400);
  const enabled = !!(args && args.enabled);
  // Включение — единственное место, кроме выдачи ключа, где ключ может
  // понадобиться завести задним числом (клиника активирована до Маршрута Б).
  if (enabled) ensureSyncGroup(dataDir);
  try {
    writePairing(dataDir, { ...pairing, relay: enabled });
  } catch (e) {
    console.warn('[branch-sync] could not store the relay setting:', e && e.message);
    throw new RpcError(reasonText('write_failed'), 400);
  }
  return { ok: true, relay_enabled: enabled };
}

/**
 * «Отправить копию на сервер сейчас» — сторона главного филиала.
 *
 * Отправляет ВСЕГДА, не сверяясь с хэшем: владелец нажал кнопку и обязан
 * увидеть результат, а «мы решили, что ничего не изменилось» выглядит как
 * сломанная кнопка. Экономию делает фоновый прогон (relay.js maybePublish).
 *
 * Недоступный сервер — это ok:false с причиной, а не исключение: клиника
 * офлайновая по построению, и отсутствие интернета не поломка.
 */
export async function branchSyncRelayPublish(db, args, user, { publishImpl = publishCatalogue } = {}) {
  requireAdmin(user);
  const r = await publishImpl(db, getDataDir());
  if (r.ok) return { ok: true, at: r.at, bytes: r.bytes };
  return { ok: false, reason: r.reason, message: reasonText(r.reason) };
}

/**
 * «Перевыпустить ключ синхронизации».
 *
 * ЭТО ОТКЛЮЧАЕТ ВСЕ ФИЛИАЛЫ, и по-другому быть не может: у них на руках старый
 * ключ и старый секрет. Экран предупреждает об этом прямым текстом до вызова
 * (views/branch-sync.js) — здесь только само действие.
 *
 * Перевыпускается ВСЁ разом: и ключ шифрования (Маршрут Б), и секрет подписи
 * (Маршрут А). Иначе обещание «отключит все филиалы» было бы враньём наполовину
 * — старые филиалы продолжали бы забирать справочник напрямую.
 *
 * Восстановить старый ключ не может НИКТО, включая поставщика: он его никогда
 * не видел. Это же сказано на экране.
 */
export function branchSyncRegenerateKey(db, args, user) {
  requireAdmin(user);
  const dataDir = getDataDir();
  const pairing = readPairing(dataDir);
  // Подключённый филиал ключ не выпускает: его группу определяет главный, и
  // «перевыпустил у себя» означало бы просто отвалиться от группы, ничего не
  // починив. Владелец должен сделать это в главном филиале.
  if (pairing && pairing.role === 'secondary') throw new RpcError(reasonText('relay_is_secondary'), 400);

  const group = regenerateSyncGroup(dataDir);
  if (!group) throw new RpcError(reasonText('write_failed'), 400);

  // Установка ещё не назначена главной — перевыпускать в паре нечего, ключ
  // просто заменён и уедет в первый же выданный ключ подключения.
  if (!pairing) return { ok: true, role: 'none', sync_key_created_at: group.created_at };

  const r = makeMainKey(dataDir, {
    url: pairing.main_url,
    groupId: group.group_id,
    groupKey: group.key,
    rotate: true,
  });
  if (!r.ok) throw new RpcError(reasonText(r.reason), 400);
  // Карта соответствий главного филиала пуста по построению (она нужна только
  // приёмнику), поэтому стирать здесь нечего — а вот журнал прошлых выгрузок
  // стереть надо: он говорит про блоб, до которого больше нет адреса.
  db.prepare('DELETE FROM control_state WHERE key = ?').run(LAST_PUBLISH_KEY);
  return {
    ok: true,
    role: 'main',
    group_id: r.record.group_id,
    key: r.key,
    sync_key_created_at: group.created_at,
  };
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
 *
 * BRANCH_SYNC_RELAY_V1 — СНАЧАЛА А, ПОТОМ Б, и порядок здесь не вкусовой.
 * Прямой путь всегда пробуется первым, потому что он лучше по всем осям сразу:
 * данные не покидают машин клиники, справочник приезжает сегодняшний (а не
 * копия на момент последней выгрузки), и он работает без интернета вообще.
 * Резервный включается только когда до главного филиала не достучались, и
 * экран ОБЯЗАН сказать, каким путём пришёл справочник: владелец платит за VPN
 * между зданиями и должен видеть, работает ли тот на самом деле, а не узнавать
 * об обратном через полгода.
 */
export async function branchSyncNow(db, args, user, {
  pullImpl = pullCatalogue, backupImpl = createBackup, relayImpl = fetchCatalogue,
} = {}) {
  requireAdmin(user);
  const dataDir = getDataDir();

  let route = 'direct';
  let relayedAt = null;
  let pulled = await pullImpl(dataDir);

  if (!pulled.ok && RELAY_FALLBACK_REASONS.has(pulled.reason)) {
    const viaRelay = await relayImpl(dataDir);
    if (viaRelay.ok) {
      route = 'relay';
      relayedAt = viaRelay.generated_at;
      pulled = viaRelay;
    } else {
      // Не удалось ни так, ни этак. Наружу идут ОБЕ причины, и в сообщении
      // первой стоит прямая: чинить надо связь между филиалами, а резервный
      // канал — это запасной выход, а не диагноз. Исключение — несовпадение
      // ключей: тут запасной путь рассказывает то, чего прямой не знает, и
      // владельцу нужно услышать именно это.
      const message = viaRelay.reason === 'relay_bad_key'
        ? `${reasonText(pulled.reason)} ${reasonText(viaRelay.reason)}`
        // Строчной делается ТОЛЬКО первая буква: причина — это законченный
        // текст из нескольких предложений, и toLowerCase() на всей строке
        // ронял начало второго предложения в середину фразы.
        : `${reasonText(pulled.reason)} Резервный канал тоже не сработал: ${lowerFirst(reasonText(viaRelay.reason))}`;
      return finish(db, { ok: false, reason: pulled.reason, relay_reason: viaRelay.reason }, message);
    }
  }

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
    return finish(db, {
      ok: true, changed: 0, created: {}, updated: {}, adopted: {}, settings: false, route, relayed_at: relayedAt,
    });
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

  return finish(db, { ok: true, ...summary, route, relayed_at: relayedAt });
}

// Итог попытки записывается всегда — и удачной, и нет. Экран должен уметь
// сказать «последний раз получилось вчера в 19:40, сегодня в 9:05 не было
// связи»: одна дата на оба случая скрыла бы ровно ту неисправность, ради
// которой на экран смотрят.
//
// BRANCH_SYNC_RELAY_V1 — в записи лежит и `route` ('direct' | 'relay'), потому
// что «синхронизировано» без указания пути скрывает самое интересное: владелец,
// оплативший VPN между зданиями, должен видеть, что справочник полгода ездит
// через сервер поставщика, а не догадываться об этом.
function finish(db, result, message) {
  const at = new Date().toISOString();
  const record = { at, ...result };
  if (!result.ok) record.message = message || reasonText(result.reason);
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
