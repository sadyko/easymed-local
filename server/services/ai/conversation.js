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
const LIMIT = 20;

export function conversationFor(db, channel, chatKey) {
  if (channel === 'telegram') {
    const link = db.prepare('SELECT tg_name, phone FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1').get(String(chatKey));
    const rows = db.prepare(`SELECT direction, text, kind FROM telegram_messages WHERE chat_id = ? AND kind = 'text' AND text <> ''
                             ORDER BY id DESC LIMIT ?`).all(String(chatKey), LIMIT).reverse();
    return {
      patientName: (link && link.tg_name) || '', linkPhone: (link && link.phone) || '', postText: '',
      transcript: rows.map((r) => ({ from: r.direction === 'in' ? 'patient' : 'clinic', text: r.text })),
    };
  }
  if (channel === 'meta_dm') {
    const conv = db.prepare('SELECT peer_name, peer_username FROM meta_conversations WHERE id = ?').get(Number(chatKey));
    const rows = db.prepare(`SELECT direction, text FROM meta_messages WHERE conversation_id = ? AND text <> '' AND (status IS NULL OR status <> 'failed')
                             ORDER BY created_at DESC, id DESC LIMIT ?`).all(Number(chatKey), LIMIT).reverse();
    return {
      patientName: (conv && (conv.peer_name || conv.peer_username)) || '', linkPhone: '', postText: '',
      transcript: rows.map((r) => ({ from: r.direction === 'in' ? 'patient' : 'clinic', text: r.text })),
    };
  }
  if (channel === 'meta_comment') {
    const start = db.prepare('SELECT comment_id, root_id FROM meta_comments WHERE id = ?').get(Number(chatKey));
    if (!start) return { patientName: '', linkPhone: '', postText: '', transcript: [] };
    const rootKey = start.root_id || start.comment_id;
    const root = db.prepare('SELECT post_text FROM meta_comments WHERE comment_id = ?').get(rootKey);
    const rows = db.prepare(`SELECT author_name, text, is_page FROM (
                               SELECT id, author_name, text, is_page, created_at FROM meta_comments
                               WHERE (comment_id = ? OR root_id = ?) AND text <> ''
                               ORDER BY created_at DESC, id DESC LIMIT ?
                             ) ORDER BY created_at, id`).all(rootKey, rootKey, LIMIT);
    const lastPatient = [...rows].reverse().find((r) => !r.is_page);
    return {
      patientName: (lastPatient && lastPatient.author_name) || '', linkPhone: '',
      postText: (root && root.post_text) || '',
      transcript: rows.map((r) => ({ from: r.is_page ? 'clinic' : 'patient', text: r.text })),
    };
  }
  return { patientName: '', linkPhone: '', postText: '', transcript: [] };
}
