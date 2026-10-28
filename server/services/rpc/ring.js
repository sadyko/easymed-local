// CALL_RING_V1 (2026-10-17) — «ЗВОНИТ»: три вызова для панели «Телефон» и экрана «Телефония».
//
// Владелец: «is it possible to ring here and number with patient name appear and
// card opens automatically» → «panel show the "Звонит" block with an "Открыть
// карту" button». Карта сама не открывается.
//
//   telephony_live              — что звонит сейчас (telephony/live.js); сам вопрос
//                                 и есть СПРОС: пока панели спрашивают, клиника
//                                 держит длинный опрос публичного сервера.
//   telephony_ring_info         — адрес, который администратор вписывает в кабинет
//                                 onlinePBX (Сервисы → Интеграция → Webhooks):
//                                 через публичный сервер, если Easy-Med включил
//                                 обмен для клиники, иначе прямой адрес клиники.
//   telephony_ring_token_rotate — новый секрет адреса: прежний перестаёт
//                                 подходить, как только такт обмена донесёт новый.
//
// ВОРОТА. Живые звонки — те же, что у рабочего места панели (rpc/phone.js):
// право позвонить ИЛИ право на журнал. Адрес и его смена — раздел «Телефония»
// («Настройки → Роли», ключ settings.telephony), как и остальные его настройки.
//
// FIX_318_V1:
//   • C5 — живые звонки несут имя и номер карты пациента. Звонки ВСЕЙ клиники —
//     только с правом на журнал (crm.calls): иначе «Позвонить» без «Журнала
//     звонков», опрашивая раз в 2 секунды, давало журнал без права на журнал.
//     С одним «Позвонить» — только свои звонки: те, где один из номеров — свой
//     внутренний номер (users.pbx_extension); без своего номера — никаких.
//   • C4 — адрес событий станции содержит секрет (кто знает адрес, тот пишет на
//     панель «Телефон» любого «звонящего»), а секреты раздела «Телефония» видит
//     только администратор (правило rpc/telephony.js). Не-администратор с
//     доступом к разделу видит, что адрес есть и в каком он состоянии, но не сам
//     адрес; секрет рождается и меняется только администратором.
//   • C3 — «готово» значит «публичный сервер принял ключи с нынешним секретом»
//     (api/public-sync.js ringRelayStatus), а не «лицензия включена».
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { grantAllows, grantAllowsAdminOr, isAdminUser } from '../grants.js';
import { getDataDir } from '../control/config.js';
import { RpcError } from './telephony.js';
import { demandLive, liveCalls, liveSource } from '../telephony/live.js';
import { readSettingsRow } from '../telephony/settings.js';
import { publicBaseUrl, wakePublicSync, ringRelayStatus } from '../api/public-sync.js';

const TEL_KEY = 'settings.telephony';
// Те же роли, что PHONE_ROLES в rpc/phone.js, но СВОЕЙ константой: страж
// gate-fallbacks.test.js читает список ролей ворот из того же файла и сверяет
// его с картой gate-fallbacks.js (crm.dial / crm.calls) — импортированную
// константу он разобрать не может, и ворота считались бы неописанными.
const PHONE_ROLES = Object.freeze(['admin', 'registrar', 'callcenter']);
const DENY_WORKPLACE = 'Программа телефонии доступна тем, кому выдано право звонить из программы или смотреть журнал звонков («Настройки → Роли»).';
const DENY_VIEW = 'Адрес событий станции видит тот, кому открыт раздел «Телефония» («Настройки → Роли»).';
const DENY_EDIT = 'Сменить адрес событий станции может тот, кому разрешено менять раздел «Телефония» («Настройки → Роли»).';
// FIX_318_V1 (C4) — новый адрес — это новый секрет: менять его, не видя, значило бы сломать приём станции.
const DENY_ROTATE_ADMIN = 'В адресе событий станции — секрет: увидеть и сменить его может только администратор.';

const mayDial = (db, user) => grantAllows(db, user, 'crm.dial', 'edit', PHONE_ROLES);
const mayLog = (db, user) => grantAllows(db, user, 'crm.calls', 'view', PHONE_ROLES);
const newToken = () => crypto.randomBytes(16).toString('hex');

/** FIX_318_V1 (C5) — свои живые звонки: один из номеров звонка — свой внутренний номер. Без своего номера — никаких. */
function ownCalls(db, user, calls) {
  const row = db.prepare('SELECT pbx_extension FROM users WHERE id = ?').get(user && user.id ? user.id : 0) || {};
  const ext = String(row.pbx_extension || '').trim();
  if (!ext) return [];
  return calls.filter((c) => String(c.callee || '') === ext || String(c.caller || '') === ext);
}

function clinicIdOf(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
    return c && typeof c.clinic_id === 'string' ? c.clinic_id : '';
  } catch { return ''; }
}

/** Что звонит сейчас. Вопрос продлевает спрос — опрос публичного сервера идёт, пока спрашивают. */
export function telephonyLive(db, _args, user, { now = Date.now, dataDir = getDataDir() } = {}) {
  const log = mayLog(db, user);
  if (!log && !mayDial(db, user)) throw new RpcError(DENY_WORKPLACE, 403);
  demandLive(now());
  const src = liveSource(db, dataDir);
  const all = liveCalls(now());
  return { calls: log ? all : ownCalls(db, user, all), source: src.source, reason: src.reason };   // FIX_318_V1 (C5)
}

/**
 * Адреса и их состояние. FIX_318_V1: relay_ready/relay_reason/relay_error —
 * дошёл ли секрет до публичного сервера и что мешает (ringRelayStatus: not_main,
 * not_enrolled, key_broken, no_sync_key, not_enabled, no_token, pending);
 * key_code — код ключа обмена, который клиника называет Easy-Med. Не
 * администратору (C4) — без секрета: ни адресов, ни секрета, ни кода ключа;
 * ring_token_set говорит, что адрес есть.
 */
function ringInfo(db, dataDir, env, row, user) {
  const st = ringRelayStatus(db, dataDir);
  const clinicId = clinicIdOf(dataDir);
  const token = String(row.ring_token || '');
  const relayUrl = clinicId && token ? publicBaseUrl(env) + '/_pbx/v1/' + encodeURIComponent(clinicId) + '/' + token : '';
  const pub = String(row.public_base_url || '').trim().replace(/\/+$/, '');
  const directUrl = pub && token ? pub + '/api/telephony/pbx/' + token : '';
  const out = {
    ring_token: token,
    relay_url: relayUrl,
    direct_url: directUrl,
    relay_ready: st.ready,
    relay_reason: st.reason,
    relay_error: st.error,
    key_code: st.key_code,
    clinic_id: clinicId,
    ring_token_set: !!token,
    secrets_hidden: false,
  };
  if (isAdminUser(user)) return out;
  return { ...out, ring_token: '', relay_url: '', direct_url: '', key_code: '', secrets_hidden: true };
}

/** Адрес для кабинета станции. Секрет рождается здесь, при первом взгляде администратора, — а не миграцией на всех установках сразу. */
export function telephonyRingInfo(db, _args, user, { dataDir = getDataDir(), env = process.env } = {}) {
  if (!grantAllowsAdminOr(db, user, TEL_KEY, 'view')) throw new RpcError(DENY_VIEW, 403);   // как rpc/telephony.js: строка adminDefault
  let row = readSettingsRow(db) || {};
  if (!row.ring_token && isAdminUser(user)) {   // FIX_318_V1 (C4): не-администратор секрета не видит — и не заводит
    db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(newToken());
    wakePublicSync();   // публичный сервер узнаёт хеш секрета ближайшим тактом, а не через 15 секунд
    row = readSettingsRow(db) || {};
  }
  return ringInfo(db, dataDir, env, row, user);
}

/** Новый секрет: прежний адрес перестаёт подходить. Клиника вписывает новый в кабинет станции. */
export function telephonyRingTokenRotate(db, _args, user, { dataDir = getDataDir(), env = process.env } = {}) {
  if (!grantAllowsAdminOr(db, user, TEL_KEY, 'edit')) throw new RpcError(DENY_EDIT, 403);
  if (!isAdminUser(user)) throw new RpcError(DENY_ROTATE_ADMIN, 403);   // FIX_318_V1 (C4)
  db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(newToken());
  wakePublicSync();
  return ringInfo(db, dataDir, env, readSettingsRow(db) || {}, user);
}
