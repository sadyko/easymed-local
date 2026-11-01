// META_LEADS_V1 — слова причин отказа Graph API (server/services/meta/graph.js
// REASONS плюс свои: no_token, kek, truncated) → человеческие фразы для экрана
// «Meta: заявки из рекламы». Одно место для сервера и браузера: сервер пишет
// слово в meta_settings.last_error, экран показывает фразу отсюда.

export const META_REASON_TEXT = Object.freeze({
    offline:       'Нет связи с Meta. Проверьте интернет на сервере клиники — заявки заберутся при следующей удачной проверке.',
    bad_token:     'Meta не принимает токен: он истёк или отозван. Создайте новый токен и сохраните его здесь — опрос выключен до этого.',
    no_permission: 'У токена нет нужных прав. Нужны leads_retrieval, pages_show_list, pages_read_engagement и pages_manage_ads — и доступ к странице клиники.',
    rate_limited:  'Meta временно ограничила запросы. Опрос продолжится сам; при повторении увеличьте период опроса.',
    bad_request:   'Meta отклонила запрос. Проверьте, что выбрана страница клиники, и нажмите «Проверить связь».',
    not_found:     'Страница или форма не найдена: возможно, форму удалили. Нажмите «Проверить связь», чтобы обновить список форм.',
    server_error:  'Meta ответила ошибкой на своей стороне. Опрос повторится сам.',
    bad_response:  'Ответ Meta не удалось разобрать. Опрос повторится сам.',
    no_token:      'Токен не задан.',
    kek:           'Ключ шифрования клиники недоступен: сохранённый токен нельзя прочитать. Обратитесь к поставщику программы.',
    truncated:     'Заявок было очень много — за один проход забраны только самые свежие. Старые можно забрать кнопкой «Забрать за N дней».',
});

/** Фраза по слову; неизвестное слово — как есть, чтобы диагностика не терялась. */
export function metaReasonText(word) {
    const w = String(word || '').trim();
    if (!w) return '';
    return META_REASON_TEXT[w] || w;
}

/** Причины, при которых опрос сам не починится и нужен человек. */
export const META_REASONS_NEED_ACTION = Object.freeze(['bad_token', 'no_permission', 'kek', 'no_token']);

// META_INBOX_V1 — «Чат Facebook и Instagram»: те же слова graph.js плюс свои
// (окно 24 часа, нет страницы, ответ в личку уже был). Право здесь другое, чем
// у заявок, — поэтому своя фраза no_permission, а остальное — общий словарь.
export const META_INBOX_REASON_TEXT = Object.freeze({
    no_permission:    'У токена нет права на сообщения или комментарии. Нужны pages_messaging, pages_read_engagement, pages_read_user_content, pages_manage_engagement, pages_manage_metadata, а для Instagram — instagram_basic, instagram_manage_messages, instagram_manage_comments.',
    ads_no_permission: 'Комментарии под рекламой недоступны: у токена нет права на рекламу страницы (pages_manage_ads). Комментарии под обычными постами приходят.',
    no_page:          'Meta не подключена: сначала сохраните токен и выберите страницу в «Настройки → Коммерческие инструменты → Meta: заявки из рекламы».',
    window_closed:    'Прошло больше 24 часов после последнего сообщения человека — Meta не разрешает отвечать. Ответьте, когда он напишет снова, или позвоните.',
    user_unavailable: 'Человек недоступен: удалил переписку, заблокировал страницу или удалил аккаунт.',
    already_replied:  'На этот комментарий уже ответили в личку — Meta разрешает только один такой ответ.',
    own_comment:      'Это комментарий самой клиники.',
    empty:            'Напишите текст ответа.',
    too_long:         'Слишком длинный ответ: не больше 2000 символов.',
    bad_phone:        'Номер телефона не распознан. Пример: +998 90 123 45 67.',
});

/** Фраза для чата: своя, иначе общая, иначе слово как есть. Приставка ads_ — часть «реклама». */
export function metaInboxReasonText(word) {
    const w = String(word || '').trim();
    if (!w) return '';
    if (META_INBOX_REASON_TEXT[w]) return META_INBOX_REASON_TEXT[w];
    if (w.startsWith('ads_')) return metaReasonText(w.slice(4));
    return metaReasonText(w);
}
