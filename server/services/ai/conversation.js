// AI_CHAT_V1 — переписка для ИИ: последние 20 реплик, только текст.
// Служебные ответы бота (kind 'system') — не разговор. Ответы самого ИИ в
// Telegram лежат как kind 'text' с by_ai = 1 — они часть разговора и идут как
// реплики клиники. Телефон связки Telegram (linkPhone) в переписку НЕ входит и
// наружу не уходит: он нужен только самой клинике, чтобы завести заявку (lead.js).
//
// Комментарий Facebook/Instagram — это НИТКА: chatKey — id строки корневого
// комментария, переписка — вся нитка по времени (корень и ответы, в том числе
// ответы страницы), иначе ИИ, отвечая на второй комментарий, не видел бы
// собственного первого ответа и повторялся.
//
// Сотрудники наружу не опознаются: ответ, написанный оператором (out и sent_by),
// уходит в ИИ как заглушка — без текста, где мог быть «— Иванова Мария». Ответы
// самого ИИ (by_ai = 1) остаются с текстом. Команды бота («/start») от пациента
// — не слова пациента, их выбрасываем. Каждая реплика режется до 2000 знаков.
const LIMIT = 20;
const MAX_TEXT = 2000;
const STAFF = '(ответ сотрудника клиники)';
const cut = (t) => String(t).slice(0, MAX_TEXT);
const isCommand = (r) => r.from === 'patient' && r.text.trimStart().startsWith('/');
const finish = (lines) => lines.filter((r) => !isCommand(r)).map((r) => ({ from: r.from, text: cut(r.text) }));

const dmLine = (r) => (r.direction === 'in'
  ? { from: 'patient', text: r.text }
  : { from: 'clinic', text: r.sent_by != null && !r.by_ai ? STAFF : r.text });

export function conversationFor(db, channel, chatKey) {
  if (channel === 'telegram') {
    const link = db.prepare('SELECT tg_name, phone FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1').get(String(chatKey));
    const rows = db.prepare(`SELECT direction, text, kind, by_ai, sent_by FROM telegram_messages WHERE chat_id = ? AND kind = 'text' AND text <> ''
                             ORDER BY id DESC LIMIT ?`).all(String(chatKey), LIMIT).reverse();
    return {
      patientName: (link && link.tg_name) || '', linkPhone: (link && link.phone) || '', postText: '',
      transcript: finish(rows.map(dmLine)),
    };
  }
  if (channel === 'meta_dm') {
    const conv = db.prepare('SELECT peer_name, peer_username FROM meta_conversations WHERE id = ?').get(Number(chatKey));
    const rows = db.prepare(`SELECT direction, text, by_ai, sent_by FROM meta_messages WHERE conversation_id = ? AND text <> '' AND (status IS NULL OR status <> 'failed')
                             ORDER BY created_at DESC, id DESC LIMIT ?`).all(Number(chatKey), LIMIT).reverse();
    return {
      patientName: (conv && (conv.peer_name || conv.peer_username)) || '', linkPhone: '', postText: '',
      transcript: finish(rows.map(dmLine)),
    };
  }
  if (channel === 'meta_comment') {
    const start = db.prepare('SELECT comment_id, root_id FROM meta_comments WHERE id = ?').get(Number(chatKey));
    if (!start) return { patientName: '', linkPhone: '', postText: '', transcript: [] };
    const rootKey = start.root_id || start.comment_id;
    const root = db.prepare('SELECT post_text FROM meta_comments WHERE comment_id = ?').get(rootKey);
    const rows = db.prepare(`SELECT author_name, text, is_page, by_ai FROM (
                               SELECT id, author_name, text, is_page, by_ai, created_at FROM meta_comments
                               WHERE (comment_id = ? OR root_id = ?) AND text <> ''
                               ORDER BY created_at DESC, id DESC LIMIT ?
                             ) ORDER BY created_at, id`).all(rootKey, rootKey, LIMIT);
    const lastPatient = [...rows].reverse().find((r) => !r.is_page);
    return {
      patientName: (lastPatient && lastPatient.author_name) || '', linkPhone: '',
      postText: (root && root.post_text) || '',
      transcript: finish(rows.map((r) => (r.is_page
        ? { from: 'clinic', text: r.by_ai ? r.text : STAFF }
        : { from: 'patient', text: r.text }))),
    };
  }
  return { patientName: '', linkPhone: '', postText: '', transcript: [] };
}
