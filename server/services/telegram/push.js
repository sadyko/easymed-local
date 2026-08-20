// TELEGRAM_BOT_V1 — автоматическая отправка документа, как только он готов.
//
// «Готов» — это не новое понятие, придуманное ради бота, а переходы состояния,
// которые в системе уже есть: лаборант ПОДТВЕРДИЛ результат
// (lab_results.verified_at), врач ПОДПИСАЛ заключение (строка в
// visit_documents). Ничего не нужно помечать вручную.
//
// Счета не рассылаются никогда: счёт, прилетевший пациенту на телефон в момент
// выставления, — это в лучшем случае шум. Их пациент забирает сам из меню.

import { deliver } from './flow.js';
import { findPatientsByPhone } from './documents.js';

const PUSH_KINDS = ['lab', 'conclusion', 'diag'];
const MAX_PER_SCAN = 10;      // чтобы одна пачка не заняла цикл опроса надолго
const LOOKBACK_DAYS = 7;      // старое не досылаем: включённый через месяц бот
                              // не должен обрушить на пациента архив за год

function pushEnabled(db) {
  const r = db.prepare('SELECT push_enabled, doc_kinds FROM telegram_settings WHERE id = 1').get();
  if (!r || !r.push_enabled) return null;
  const kinds = String(r.doc_kinds || '').split(',').filter((k) => PUSH_KINDS.includes(k));
  return kinds.length ? kinds : null;
}

// Что созрело для отправки за последние LOOKBACK_DAYS.
export function pendingDocuments(db, kinds) {
  const since = `-${LOOKBACK_DAYS} days`;
  const out = [];

  if (kinds.includes('lab')) {
    const rows = db.prepare(
      `SELECT vs.id AS vsid, v.patient_id, MAX(lr.verified_at) AS ready_at,
              COALESCE(s.name,'Лабораторное исследование') AS title
         FROM lab_results lr
         JOIN visit_services vs ON vs.id = lr.visit_service_id
         JOIN visits v          ON v.id  = vs.visit_id
         LEFT JOIN services s   ON s.id  = vs.service_id
        WHERE lr.verified_at IS NOT NULL
          AND lr.verified_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?)
        GROUP BY vs.id
        ORDER BY ready_at ASC`).all(since);
    for (const r of rows) out.push({ kind: 'lab', ref: `lab:${r.vsid}`, patientId: r.patient_id, title: r.title });
  }

  const docTypes = [];
  if (kinds.includes('conclusion')) docTypes.push('protocol', 'conclusion');
  if (kinds.includes('diag')) docTypes.push('diag');
  if (docTypes.length) {
    const q = docTypes.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, patient_id, doc_type, title, created_at FROM visit_documents
        WHERE body IS NOT NULL AND body <> '' AND doc_type IN (${q})
          AND patient_id IS NOT NULL
          AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?)
        ORDER BY created_at ASC`).all(...docTypes, since);
    for (const r of rows) {
      out.push({ kind: r.doc_type === 'diag' ? 'diag' : 'conclusion',
        ref: `doc:${r.id}`, patientId: r.patient_id, title: r.title || 'Заключение' });
    }
  }
  return out;
}

// Уже отправляли этот документ в этот чат?
//
// Спрашиваем базу, а не память: сервер клиники перезапускают, и повторно
// присланный анализ выглядит для пациента как ошибка клиники. Гарантию даёт
// частичный уникальный индекс idx_telegram_deliveries_push_once — этот запрос
// лишь избавляет от заведомо лишней работы по сборке PDF.
const MAX_ATTEMPTS = 3;
function alreadySent(db, chatId, kind, ref) {
  const row = db.prepare(
    `SELECT status, attempts FROM telegram_deliveries
      WHERE chat_id = ? AND doc_kind = ? AND doc_ref = ? AND trigger = 'push'`).get(String(chatId), kind, ref);
  if (!row) return false;
  // Успешно отправленное не трогаем никогда. Упавшее пробуем ещё дважды —
  // упавший Chrome или моргнувший интернет не должны стоить пациенту
  // документа, — но не бесконечно: вечный цикл на битом документе занял бы
  // рассылку целиком.
  return row.status === 'sent' || row.attempts >= MAX_ATTEMPTS;
}

// PUSH_SCAN_PERF_V1 — связки разбираются ОДИН раз на проход, а не на каждый
// документ.
//
// Было: для каждого готового документа заново спрашивали «каким чатам он
// принадлежит», а тот вопрос перебирал все связки и для каждой звал
// findPatientsByPhone — поиск LIKE по 70 000 пациентов (38 мс). На боевой базе
// это 122 документа × 12 связок = 1464 таких поиска, 45 СЕКУНД.
//
// И всё это выполнялось СИНХРОННО, в одном тике: когда документ уже отправлен,
// цикл делает `continue` и до первого await не доходит. Значит Node на всё это
// время переставал отвечать вообще — на сохранение анализов в том числе, — и
// повторялось каждые 30 секунд. Отсюда и «подвисает, будто сервер не локальный».
//
// Стало: карта «связка → её пациенты» строится один раз (12 поисков вместо
// 1464), а уже отправленное отсекается ДО всякой работы дешёвым запросом по
// индексу. Плюс цикл уступает событийному циклу, чтобы даже долгий проход не
// мог заблокировать сервер.
function linkPatientMap(db) {
  const links = db.prepare('SELECT * FROM telegram_links WHERE revoked_at IS NULL AND blocked_at IS NULL').all();
  return links.map((link) => ({
    link,
    // Set, а не массив: проверка принадлежности идёт на каждый документ.
    patientIds: new Set(findPatientsByPhone(db, link.phone).map((p) => p.id)),
  }));
}

const yieldToLoop = () => new Promise((r) => setImmediate(r));

export async function runPushScan(db, token, deps = {}) {
  const kinds = pushEnabled(db);
  if (!kinds) return { sent: 0, skipped: 0 };

  const docs = pendingDocuments(db, kinds);
  if (!docs.length) return { sent: 0, skipped: 0 };

  const targets = linkPatientMap(db);
  if (!targets.length) return { sent: 0, skipped: 0 };

  let sent = 0, skipped = 0, seen = 0;
  for (const doc of docs) {
    if (sent >= MAX_PER_SCAN) break;
    for (const { link, patientIds } of targets) {
      if (!patientIds.has(Number(doc.patientId))) continue;
      // Проверку «уже отправляли» делаем ПЕРВОЙ: это запрос по уникальному
      // индексу, и он избавляет от всей остальной работы для документа,
      // который пациент уже получил.
      if (alreadySent(db, link.chat_id, doc.kind, doc.ref)) { skipped++; continue; }
      try {
        await deliver(db, token, link.chat_id, link, doc.patientId, doc.ref, deps, 'push');
        sent++;
      } catch (e) {
        // Отметка о неудаче уже легла в журнал внутри deliver(); здесь важно
        // только не дать одному сломанному документу остановить всю рассылку.
        console.warn('[telegram] not delivered', doc.ref, '→', link.chat_id, ':', (e && e.message) || e);
      }
      if (sent >= MAX_PER_SCAN) break;
    }
    // Даже с картой проход по тысячам пар остаётся работой: отдаём управление
    // событийному циклу, чтобы запросы регистратуры обслуживались между шагами.
    if (++seen % 25 === 0) await yieldToLoop();
  }
  return { sent, skipped };
}

export { PUSH_KINDS, LOOKBACK_DAYS };
