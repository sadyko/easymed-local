# Сайт, этап 2 — редактор «Веб-сайт»

Спека: `docs/superpowers/specs/2026-11-23-website-module-design.md` (§2, §3, §4, §5, §10 п.2).
Источник: Chilla — `public/js/admin/views/website-settings.js`, `server/services/rpc/website.js`
(только настройки; заявки — этап 3), `rpc/website-content.js`, `rpc/website-slug.js` и их тесты.
Образец подключения в этом проекте — ИИ-помощник (AI_CHAT_V1): `commerce-ai` / модуль `ai` /
строка прав `commerce_ai`.

Метка в комментариях: `WEBSITE_V1`.

## Что отличается от Chilla

1. **Право** — строка каталога `commerce_website` (блок «Коммерческие инструменты», нет / просмотр /
   изменение, `adminDefault: true`), а не раздел `website` в role_permissions. Сервер:
   `grantAllowsAdminOr(db, user, 'commerce_website', need)`.
2. **Лицензия** — каждый `website_*` RPC без модуля `website` отвечает 402 `module_missing`.
   Чтения (`website_settings_get`, `website_content_list`, `website_pick_lists`) — в `READ_ONLY_RPCS`
   (`server/services/control/gate.js`), чтобы клиника с истёкшей лицензией могла смотреть.
3. **Выключатель** — `settings.enabled` (boolean) на вкладке «Основное», первой карточкой: «Сайт
   включён». Сохранение настроек сразу пересчитывает слушатель (`server/site/controller.js` —
   зарегистрированный контроллер, `requestSiteRefresh()`), без перезапуска. `website_settings_get`
   отдаёт `site: { running, port }`. Под ссылкой «Открыть сайт» — пояснение про один вопрос Windows
   о доступе к порту 8001 в локальной сети.
4. **Врачи и услуги** — из существующих профилей (спека §4). Вкладка «Врачи»: все активные врачи,
   метка «На сайте» / «Скрыт» (по `publicDoctors` — тому же правилу, что у сайта); у показанных —
   «На главной» (`featured`) и порядок (`sort_order`). У скрытых — подсказка включить «Публичный
   профиль» врача. Вкладка «Услуги»: то же по `servicePublicState`, с поиском (услуг сотни); у
   показанных — «На главной», порядок, фото (`image_path`), описание и подготовка по языкам
   (`content`). Своих `published`/`slug`/удаления у врачей и услуг нет: «удалить» = сбросить добавки.
   Отделения, отзывы, FAQ, новости — как в Chilla.
5. **Фото** — корзина `website`: запись и удаление только с правом `commerce_website: edit` и при
   модуле `website`; только jpg/jpeg/png/webp (SVG — нет: сайт его не отдаёт).
6. **Кэш** — любое сохранение (настройки, содержимое) зовёт `invalidateContentCache()`.
7. **Меню** — маршрут `website-settings`: плитка «Веб-сайт» в «Настройки → Коммерческие
   инструменты» (`settings-hub.js`), `LICENSED_MODULES['website-settings'] = { key: 'website' }`,
   крошки / `PARENT_OF: 'settings'` / `case` в `admin.js`, правило в `permissions.js`
   (`commerceToolLevel('commerce_website')`, legacy — администратор). Кнопки «Отчёт сайта» в
   шапке пока нет (этап 4).
8. Строки — через `i18n-strings.js` (uz/ru/en), иконки — `icons.js`, без эмодзи.

## Задачи

1. **Сервер.** `rpc/website.js` (get/save настроек), `rpc/website-content.js` (адаптация п.4),
   `rpc/website-slug.js`, регистрация в `rpc/index.js`, гейт чтений, право в каталоге
   (`public/js/shared/permission-catalog.js` + что требуют сторожа: `gate-fallbacks`, …),
   корзина `website` в `storage.js`, `requestSiteRefresh`. Тесты Chilla переносятся и
   подгоняются; новые: без модуля — 402, без права — 403, просмотр не пишет, сохранение
   `enabled` поднимает/закрывает слушатель, скрытый в профиле врач не становится видимым через
   добавки, загрузка в `website` без права — 403, `.svg` — 415.
2. **Экран.** `views/website-settings.js` (порт Chilla с п.3–4), плитка, маршрут, права, лицензия,
   строки. Тесты экрана — по образцу тестов `commerce-ai`/`telegram-deeplinks`.
3. **Проверка.** Полный `npm test` (известные CRLF-падения — не регрессии), просмотр на копии базы
   с модулем `website` в лицензии, владелец смотрит. Не пушить.
