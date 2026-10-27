# «Мои Звонки» в «Коммерческих инструментах»: звонки с телефонов сотрудников — в журнал и в CRM (MOIZVONKI_V2) — дизайн

Метка: `MOIZVONKI_V2`. Продолжает `MOIZVONKI_V1` (2026-09-17: провайдер телефонии «Мои Звонки» —
подключение, проверка связи, звонок по клику).

## Просьба владельца (2026-10-17)

Снимок группы «Коммерческие инструменты» с плиткой Meta и слова: «Build here integration with Moi
Zvonki too, do you know what it Moi Zvonki app». Владелец хочет вторую плитку в той же группе — для
«Моих Звонков» — и, по смыслу первой просьбы про Meta, чтобы обращения оттуда попадали в CRM.

«Мои Звонки» (moizvonki.ru) — облачный учёт звонков для мобильных: приложение на Android-телефонах
сотрудников записывает входящие и исходящие звонки с их сим-карт, отправляет в личный кабинет, а
оттуда через API их забирают CRM. АТС у сервиса нет: «кто звонит» — учётная запись сотрудника
(почта), а не внутренний номер.

## Что сегодня (проверено по коду 2026-10-17, ветка `feat/stock-own-shelf-suppliers-vat`)

- `server/services/telephony/moizvonki.js` (MOIZVONKI_V1): `mzCall` (подпись в теле запроса,
  адрес только `*.moizvonki.ru`, ничего не логирует), `mzDial` («позвонить» — `calls.make_call`),
  `mzHistory` — зовёт действие **`calls.get_calls`**, которого в действующей документации
  провайдера нет.
- Провайдер заводится в «Настройки → Телефония → Провайдеры» (вид `moizvonki`: адрес, почта
  сотрудника, ключ API); проверка связи и звонок из CRM работают.
- **История звонков НЕ забирается**: `pollProviders` в `telephony/poller.js` опрашивает только
  onlinePBX (`if (providerKind(p) !== 'onlinepbx') continue`). Звонки «Моих Звонков» не попадают
  ни в журнал `calls`, ни в CRM. Это и есть пробел, который закрывает эта работа.
- Webhook (`webhook.subscribe`) провайдер умеет, но клинике он недоступен: нет публичного адреса.

## Документация API (developers: https://www.moizvonki.ru/guide/api/, прочитано 2026-10-17)

- История: `action: "calls.list"`, параметры `from_date` (UTC-секунды) **или** `from_id`
  (`db_call_id`, включительно; для последовательного забора документация рекомендует `from_id`),
  `to_date`, `from_offset`, `max_results` (1–100), `supervised` (1 — все звонки, доступные роли).
- Ответ: `results` (массив), `results_count`, `results_next_offset`, `results_remains`. Поля
  звонка: `db_call_id`, `event_pbx_call_id`, `direction` (0 входящий, 1 исходящий),
  `client_number`, `client_name`, `start_time`, `answer_time` (0 — без ответа), `end_time`,
  `upload_time` (UTC-секунды), `duration` (сек), `answered` (0/1), `recording` (ссылка, если
  отвечен), `src_number`/`src_id`/`src_slot` (сим-карта), `user_account` (почта) и `user_id` —
  при `supervised=1`.
- Пропущенный звонок — это `answered: 0`; отдельного значения направления нет.
- `upload_time` может сильно отставать от `start_time` (телефон был без сети): курсор по
  дате пропустил бы такой звонок, курсор по `db_call_id` — нет.

## Решения

| Вопрос | Решение |
|---|---|
| Где в настройках | Вторая плитка в «Коммерческих инструментах»: «Мои Звонки: звонки с телефонов» → маршрут `moizvonki-settings`, свой экран. Экран — тонкая обёртка над ТЕМ ЖЕ провайдером телефонии (строка `telephony_providers` вида `moizvonki`) и теми же RPC: второй копии подключения не появляется; то, что сохранено здесь, видно и в «Телефонии», и наоборот |
| Кто видит | Тот же ключ, что у Телефонии (`settings.telephony`): экран зовёт её RPC, и правило «только администратор, пока роли не выдали окно» — то же. Запись в `route-gate.test.mjs` FULL_ACCESS_ONLY |
| Лицензия | Как у телефонии: опрос идёт при модуле `callcenter`; экран без модуля показывает предупреждение, но не закрывается |
| История звонков | `calls.list` вместо несуществующего `calls.get_calls` — и для опроса, и для проверки связи. Курсор — `from_id = последний db_call_id + 1` из нашего журнала (`general_call_id` вида `moizvonki:<db_call_id>` у звонков этого провайдера); первый запуск — `from_date` сутки назад, как у других провайдеров. Страницы — `from_offset` ← `results_next_offset`, пока `results_remains > 0`, не больше 20 страниц за проход |
| Как звонок ложится в журнал | `normalizeMzCall`: `general_call_id` = `moizvonki:<db_call_id>`, `started_at` из `start_time`, направление из `direction`, `external_number` = `client_number` (нормализуется в `recordCall`), `internal_number` = `user_account` (почта; у «Моих Звонков» это и есть «кто»), `waitsec`/`billsec` из `answer_time`/`end_time`/`duration`, `disposition` — `ANSWER` или `NOANSWER`, запись — поле `recording` (его находит общий разбор `recordingUrlOf`) |
| Как звонок становится заявкой | Тем же путём, что у Binotel и onlinePBX: `recordCall` → `leadFromCall` по правилам «Звонки → заявки» (`crm_call_routing`). **Дополнение владельца (2026-10-17, «when call comes from moi zvonki, it should also open new lead card»):** у «Моих Звонков» СВОИ строки правил (мигр. 247: `ANSWER` → первая открытая колонка, `NOANSWER` → «Перезвонить», INSERT OR IGNORE), а `leadFromCall` ищет правило сначала по провайдеру самого звонка (`recordCall` передаёт его вид) и лишь без такой строки — по основному провайдеру клиники, как раньше. Так карточка из звонка «Моих Звонков» не зависит от настроек Binotel; onlinePBX без своих строк живёт по-старому. Правило повторного обращения CRM не отменяется: второй звонок того же человека в окне 72 часов карточку не дублирует |
| Правила на экране | Карточка «Звонки → заявки» на экране «Моих Звонков»: два исхода (отвеченный, пропущенный), действие и колонка; читает `telephony_dispositions({ provider: 'moizvonki' })`, пишет `crm_config_save({ routing })` со своим `provider` — правила основного провайдера не трогаются |
| Записи разговоров («lead card should keep records too») | Уже устроено общим путём и проверено: ссылка `recording` звонка ложится в `calls.recording_url` (`recordingUrlOf`), карточка CRM показывает звонки по телефону (`crm_lead_calls`) с «Прослушать», а `telephony_call_recording` отдаёт прямую ссылку. Отдельного кода для «Моих Звонков» не нужно; запись отдаётся только роли с правом `crm.recording` |
| Журнал на экране | `telephony_recent_calls` получает необязательные `provider_id` и `limit`: экран показывает только звонки «Моих Звонков» |
| Что не меняется | Экран «Телефония», его провайдеры и правила маршрутизации; схема базы (новых таблиц нет) |

## Экран «Мои Звонки: звонки с телефонов» (`public/js/admin/views/moizvonki-settings.js`)

1. **Подключение** — адрес кабинета (`*.moizvonki.ru`), почта сотрудника, ключ API (пароль,
   «сохранён — заменить»), «Проверить связь», «Сохранить». Создаёт строку провайдера, если её
   ещё нет, иначе правит первую строку вида `moizvonki`.
2. **Опрос звонков** — выключатель (сохраняется сразу), интервал в секундах, последняя проверка /
   последний звонок / последняя ошибка; подпись о том, что правила «звонок → заявка» общие и
   лежат в «Телефонии».
3. **Последние звонки** — таблица 20 последних звонков этого провайдера: время, направление, номер,
   пациент (кнопка в карту), длительность, итог.
4. **Как подключить** — установить приложение на телефоны сотрудников, зарегистрировать кабинет,
   где взять ключ API (Настройки → Интеграция), почему нужна почта сотрудника, что публичный адрес
   не нужен.

## Файлы

- `server/services/telephony/moizvonki.js` — `mzListCalls` (`calls.list` с постраничным обходом),
  `mzHistory` → `calls.list`, `normalizeMzCall`; тест `moizvonki.test.js` (новый).
- `server/services/telephony/providers.js` — проверка связи читает `results`.
- `server/services/telephony/poller.js` — `pollMoizvonki` (ветка в `pollProviders`); тесты —
  в `providers.test.js` рядом с опросом onlinePBX. Усечённый обход (больше 20 страниц за
  проход) — слово `too_many_calls` в `last_error`, подпись — в `telephony-logic.js`.
- `server/services/rpc/telephony.js` — `telephony_recent_calls({ provider_id?, limit? })`,
  `telephony_dispositions({ provider? })`.
- `server/services/telephony/moizvonki-routing.js` + тест — строки правил вендора заводятся
  КОДОМ (`ensureMoizvonkiRouting`: при сохранении провайдера «Мои Звонки» и каждым проходом
  опроса), а не миграцией: файл `247_*.sql` ломал `migrations/077.test.js`, который собирает
  базу из всех файлов, кроме 077, и применяет 077 последней — вставка в `crm_call_routing`
  до её создания падала. На dev-базе строки уже есть (их успела внести ранняя 247-я до
  удаления файла; запись о ней в `schema_migrations` безвредна).
- `server/services/crm/lead-from-call.js` — правило сначала по провайдеру звонка (`call.provider`
  из `recordCall`), затем по основному; тесты — `lead-from-call.test.js` (блок MOIZVONKI_V2).
- `public/js/admin/views/settings-hub.js` — вторая плитка группы; `settings-hub-commercial.test.mjs`.
- `public/js/admin/views/moizvonki-settings.js` — экран; `__tests__/moizvonki-settings-view.test.mjs`.
- `public/js/admin.js`, `public/js/admin/permissions.js`, `__tests__/route-gate.test.mjs` — маршрут.
- `public/js/admin/i18n-strings.js`, `RELEASE_NOTES.md` + её тест.

## Что не делаем

- Webhook от «Моих Звонков» (нет публичного адреса).
- SMS (`sms.message`) — в журнале звонков им не место; отдельная задача, если понадобится.
- Отдельный провайдер на каждого сотрудника: `supervised=1` отдаёт звонки всех сотрудников,
  доступных учётке; достаточно одной строки подключения с учёткой руководителя.

## Поворот (2026-10-17, после просмотра на dev) — MOIZVONKI_IN_TELEPHONY_V1

Владелец, увидев экран «Телефония» с плитками Binotel и onlinePBX: «I didn't notice that we have
set up of telephony, can you remove the moi zvonki from commercial setting and bring here, as all
telephony stuff should be done in here».

Что изменилось:

- Плитки «Мои Звонки» в «Коммерческих инструментах» и маршрута `moizvonki-settings` больше нет;
  `views/moizvonki-settings.js` и его тест удалены. Группа «Коммерческие инструменты» снова с одной
  плиткой — Meta.
- Всё, что умел отдельный экран, живёт в «Телефонии» при выбранной плитке «Мои Звонки»: подключение
  и опрос — карточки любого провайдера (`pbxConnectionCard` / `pbxPollingCard`); карточка
  «Звонки → заявки» при этой плитке читает `telephony_dispositions({ provider: 'moizvonki' })`,
  показывает только два исхода («Отвеченный входящий», «Пропущенный входящий») и сохраняет строки с
  `provider: 'moizvonki'`; при других плитках — общие правила, как раньше, с оговоркой, что у
  «Моих Звонков» свои. Карточка «Как подключить» — под карточкой опроса.
- Попутно: плитка провайдера считала «настроен» по `auth_key_set`, и «Мои Звонки» (секрет
  `api_key`) с сохранённым ключом показывались как «Не настроен» — теперь по `secret_set_any`.
  Сообщение «введите домен АТС» у «Моих Звонков» заменено на «адрес кабинета», и без почты сотрудника
  подключение не сохраняется.
- Серверная часть (опрос `calls.list`, правила по провайдеру звонка, `telephony_recent_calls` с
  `provider_id`) не менялась. Отдельного списка «только звонки Моих Звонков» на экране нет: в общем
  журнале «Телефонии» колонка «АТС» называет провайдера.
- Тесты: `telephony-settings.test.mjs` (блок MOIZVONKI_IN_TELEPHONY_V1), `telephony-logic.test.js`
  (`routingRowsFor`, `mzOutcomeLabel`), `settings-hub-commercial.test.mjs` снова ждёт одну плитку,
  `route-gate.test.mjs` без записи `moizvonki-settings`. Строки словаря, которые читал только
  удалённый экран, сняты; те, что читает «Телефония», остались.
