// API_DOCS_V1 — ДОКУМЕНТАЦИЯ API ДЛЯ ПАРТНЁРОВ: текст и устройство страницы
// /docs (решение владельца 21, 2026-10-12: одна публичная страница на все
// клиники, всегда по работающему коду).
//
// Здесь — только то, что пишет человек: пояснения на ru / uz / en, какие адреса
// в каком разделе, какие запросы показать примером. Всё, что знает код, страница
// берёт из кода, а не отсюда:
//   • числа (лимиты, сроки, повторы) — docs/facts.js из постоянных сервера;
//   • права, события, группы услуг — словари программы (shared/api-connections.js,
//     shared/service-public.js), переводы их подписей — docs/generated.js;
//   • статусы — store/requests.js PARTNER_STATUSES, причины — DECLINE_REASONS;
//   • коды ошибок, HTTP-коды и тексты — lib/errors.js ERRORS;
//   • ответы примеров — то, что сервер ответил на эти запросы (docs/generated.js,
//     `node public-server/scripts/docs-build.mjs`);
//   • тело уведомления — shared/api-booking.js webhookBody, подпись — та же
//     функция, что у клиники (services/api/outbox.js signBody).
// Страж docs/drift.test.js не даёт этому файлу разойтись с кодом: адреса
// сервера, права, статусы, причины, события, коды ошибок и причины полей — все
// здесь. Каждая строка таблицы полей проверена настоящим сервером
// (docs/examples.http.test.js), каждая команда страницы — тоже, вместе с ответом
// под ней (docs/page-curl.http.test.js).
//
// Разметка текста: `код`, [ссылка](#якорь | mailto:…), {{число}} из docs/facts.js —
// {{имя:единица}} с падежом (sec, min, hour, day, time, attempt — render.js
// UNITS), {{имя|or}} — список через «или».
export const L = (ru, uz, en) => Object.freeze({ ru, uz, en });

/** Контакт Easy-Med для разработчиков партнёров (вопрос владельцу плана шага 9). */
export const DOCS_CONTACT = 'hello@easymed.uz';
/** Клиника примеров и номера её заявок на странице (настоящие номера сервер выдаёт случайно). */
export const SAMPLE = Object.freeze({
  base: 'https://api.easymed.uz', slug: 'shifo', keyVar: '$EASYMED_KEY',
  ids: Object.freeze({ callback: 'rq_Shf7Qk2Lm9Xc4Vb8Nz3Wd5Ta', appointment: 'rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce' }),
});

export const PAGE = Object.freeze({
  title: L('API Easy-Med — документация для партнёров', 'Easy-Med API — hamkorlar uchun hujjatlar', 'Easy-Med API — documentation for partners'),
  description: L('Как получать врачей, свободное время, услуги и цены клиник Easy-Med и присылать заявки и онлайн-записи.',
    'Easy-Med klinikalarining shifokorlari, bo‘sh vaqti, xizmatlari va narxlarini olish hamda ariza va onlayn yozilish yuborish.',
    'How to get the doctors, free time, services and prices of Easy-Med clinics and send requests and online bookings.'),
  lead: L('Сайт клиники, Symptex и партнёры получают отсюда данные клиник Easy-Med — врачей, свободное время, услуги и цены — и присылают заявки и онлайн-записи пациентов. Страница одна для всех клиник и всегда описывает работающий сервер.',
    'Klinika sayti, Symptex va hamkorlar bu yerdan Easy-Med klinikalarining ma’lumotlarini — shifokorlar, bo‘sh vaqt, xizmatlar va narxlarni — oladi hamda bemorlarning arizalari va onlayn yozilishlarini yuboradi. Sahifa barcha klinikalar uchun bitta va har doim ishlayotgan serverni tavsiflaydi.',
    'A clinic website, Symptex and partners get the data of Easy-Med clinics here — doctors, free time, services and prices — and send patients’ requests and online bookings. One page for all clinics, always describing the live server.'),
  skip: L('Перейти к тексту', 'Matnga o‘tish', 'Skip to content'),
  toc: L('Содержание', 'Mundarija', 'Contents'),
  langs: L('Язык страницы', 'Sahifa tili', 'Page language'),
  request: L('Запрос', 'So‘rov', 'Request'),
  response: L('Ответ', 'Javob', 'Response'),
  trimmed: L('Ответ сокращён: в настоящем — все строки.', 'Javob qisqartirilgan: haqiqiysida barcha qatorlar bor.', 'Response shortened: the real one has every row.'),
  scope: L('Право', 'Huquq', 'Scope'),
  anyKey: L('любой ключ', 'istalgan kalit', 'any key'),
  noKey: L('без ключа', 'kalitsiz', 'no key'),
  orWord: L('или', 'yoki', 'or'),
  params: L('Параметры', 'Parametrlar', 'Parameters'),
  paramHead: [L('Параметр', 'Parametr', 'Parameter'), L('Где', 'Qayerda', 'In'), L('Обязателен', 'Majburiy', 'Required'), L('Значение', 'Qiymat', 'Value')],
  where: { query: L('адрес', 'manzil', 'query'), body: L('тело', 'tana', 'body'), path: L('путь', 'yo‘l', 'path') },
  yes: L('да', 'ha', 'yes'),
  no: L('нет', 'yo‘q', 'no'),
  footer: L('Ключ, права и адрес клиники выдаёт сама клиника. Вопросы по API — [{{contact}}](mailto:{{contact}}).',
    'Kalit, huquqlar va klinika manzilini klinikaning o‘zi beradi. API bo‘yicha savollar — [{{contact}}](mailto:{{contact}}).',
    'The clinic itself issues the key, scopes and clinic address. Questions about the API — [{{contact}}](mailto:{{contact}}).'),
  hookRequest: L('Запрос на ваш адрес', 'Sizning manzilingizga so‘rov', 'The request to your address'),
  langName: Object.freeze({ ru: 'Русский', uz: 'O‘zbekcha', en: 'English' }),
  vector: L('Подпись примера посчитана секретом `{{secret}}` — проверьте на нём свой код.', 'Misol imzosi `{{secret}}` siri bilan hisoblangan — kodingizni shunda tekshiring.', 'The sample signature uses the secret `{{secret}}` — test your code on it.'),
});

/** Лимиты: подписи строк; числа — docs/facts.js. */
export const LIMIT_ROWS = Object.freeze([
  [L('Запросов одним ключом', 'Bitta kalit bilan so‘rovlar', 'Requests per key'), L('{{rateLimits|or}} в минуту — столько, сколько клиника выбрала подключению', 'daqiqasiga {{rateLimits|or}} — klinika ulanishga qancha tanlagan bo‘lsa', '{{rateLimits|or}} a minute — whatever the clinic chose for the connection')],
  [L('Заявок и записей (`POST`, `DELETE`) одним ключом', 'Bitta kalit bilan arizalar va yozuvlar (`POST`, `DELETE`)', 'Requests and bookings (`POST`, `DELETE`) per key'), L('{{writePerMin}} в минуту', 'daqiqasiga {{writePerMin}}', '{{writePerMin}} a minute')],
  [L('Неверных ключей с одного IP', 'Bitta IP dan noto‘g‘ri kalitlar', 'Wrong keys from one IP'), L('{{authFailPerMin}} в минуту', 'daqiqasiga {{authFailPerMin}}', '{{authFailPerMin}} a minute')],
  [L('Всех запросов с одного IP', 'Bitta IP dan barcha so‘rovlar', 'All requests from one IP'), L('{{ipPerMin}} в минуту', 'daqiqasiga {{ipPerMin}}', '{{ipPerMin}} a minute')],
  [L('Тело запроса', 'So‘rov tanasi', 'Request body'), L('{{bodyKb}} КБ', '{{bodyKb}} KB', '{{bodyKb}} KB')],
]);

/** Таблицы, которые страница собирает из словарей кода. */
export const TABLE_HEAD = Object.freeze({
  scopes: [L('Право', 'Huquq', 'Scope'), L('Раздел', 'Bo‘lim', 'Section'), L('Что открывает', 'Nimani ochadi', 'What it opens'), L('Адреса', 'Manzillar', 'Endpoints')],
  groups: [L('Код', 'Kod', 'Code'), L('Группа', 'Guruh', 'Group')],
  statuses: [L('Статус', 'Holat', 'Status'), L('У чего', 'Nimada', 'Applies to'), L('Что значит', 'Ma’nosi', 'Meaning')],
  reasons: [L('Причина', 'Sabab', 'Reason'), L('Статус', 'Holat', 'Status'), L('Что значит', 'Ma’nosi', 'Meaning')],
  events: [L('Событие', 'Hodisa', 'Event'), L('Когда', 'Qachon', 'When'), L('Статус', 'Holat', 'Status'), L('Поля сверх общих', 'Umumiydan tashqari maydonlar', 'Fields beyond the common ones')],
  errors: [L('HTTP', 'HTTP', 'HTTP'), L('Код', 'Kod', 'Code'), L('Текст ответа', 'Javob matni', 'Message'), L('Что делать', 'Nima qilish kerak', 'What to do')],
  fields: [L('Поле', 'Maydon', 'Field'), L('Причина', 'Sabab', 'Reason'), L('Где', 'Qayerda', 'Where'), L('Что не так', 'Nima noto‘g‘ri', 'What is wrong')],
  limits: [L('Что', 'Nima', 'What'), L('Сколько', 'Qancha', 'How much')],
});
export const KIND_TEXT = Object.freeze({
  request: L('заявка «перезвоните»', '«qayta qo‘ng‘iroq» arizasi', 'callback request'),
  appointment: L('онлайн-запись', 'onlayn yozilish', 'online booking'),
  both: L('обе', 'ikkalasi', 'both'),
});

// ---- адреса ----------------------------------------------------------------------------
const qLang = { name: 'lang', in: 'query', req: false, value: L('`ru`, `uz` или `en`', '`ru`, `uz` yoki `en`', '`ru`, `uz` or `en`') };
const patient = [
  { name: 'patient.name', in: 'body', req: true, value: L('имя пациента, до {{nameMax}} знаков', 'bemor ismi, {{nameMax}} belgigacha', 'patient’s name, up to {{nameMax}} characters') },
  { name: 'patient.phone', in: 'body', req: true, value: L('телефон, до {{phoneMax}} знаков и хотя бы {{phoneDigitsMin}} цифр, лучше `+998…`', 'telefon, {{phoneMax}} belgigacha va kamida {{phoneDigitsMin}} ta raqam, yaxshisi `+998…`', 'phone, up to {{phoneMax}} characters with at least {{phoneDigitsMin}} digits, preferably `+998…`') },
  { name: 'patient.comment', in: 'body', req: false, value: L('комментарий, до {{commentMax}} знаков', 'izoh, {{commentMax}} belgigacha', 'comment, up to {{commentMax}} characters') },
];
const common = [
  { name: 'external_id', in: 'body', req: false, value: L('ваш номер заявки: до {{externalMax}} видимых латинских знаков, без пробелов', 'arizaning sizdagi raqami: {{externalMax}} tagacha ko‘rinadigan lotin belgisi, bo‘sh joysiz', 'your own request number: up to {{externalMax}} visible Latin characters, no spaces') },
  { name: 'lang', in: 'body', req: false, value: L('язык пациента: `ru`, `uz` или `en`', 'bemor tili: `ru`, `uz` yoki `en`', 'the patient’s language: `ru`, `uz` or `en`') },
];
const pathId = { name: 'id', in: 'path', req: true, value: L('`request_id` из ответа на заявку', 'ariza javobidagi `request_id`', 'the `request_id` from the request response') };

export const ENDPOINTS = Object.freeze([
  { id: 'geo', section: 'refs', method: 'GET', path: '/reference/geo', scopes: [], examples: ['geo'],
    summary: L('Страны и города / области Узбекистана с районами: код и название на трёх языках. Эти коды приходят в полях `country`, `city`, `district`.',
      'Mamlakatlar va O‘zbekistonning shahar / viloyatlari tumanlari bilan: kod va uch tildagi nom. Bu kodlar `country`, `city`, `district` maydonlarida keladi.',
      'Countries and the cities / regions of Uzbekistan with their districts: code and name in three languages. These codes come in the `country`, `city`, `district` fields.'),
    params: [qLang] },
  { id: 'specialties', section: 'refs', method: 'GET', path: '/reference/specialties', scopes: [], examples: ['specialties'],
    summary: L('Специальности врачей: код и название на трёх языках.', 'Shifokor mutaxassisliklari: kod va uch tildagi nom.', 'Doctor specialties: code and name in three languages.'),
    params: [qLang] },
  { id: 'clinic', section: 'clinic', method: 'GET', path: '/clinic', scopes: ['clinic'], examples: ['clinic'],
    summary: L('Карточка клиники: название, описание, адрес главного здания (страна, город и район — кодами справочника, полный адрес — строкой), телефон, сайт, Telegram, Instagram, логотипы, карта и маршрут.',
      'Klinika kartochkasi: nomi, tavsifi, bosh bino manzili (mamlakat, shahar va tuman — ma’lumotnoma kodlari, to‘liq manzil — satr), telefon, sayt, Telegram, Instagram, logotiplar, xarita va yo‘nalish.',
      'The clinic card: name, description, main building address (country, city and district as reference codes, the full address as a string), phone, website, Telegram, Instagram, logos, map and directions.'),
    params: [qLang],
    notes: [L('`logo.square` и `logo.portrait` — ссылки на файлы или `null`, если логотипа нет.', '`logo.square` va `logo.portrait` — fayllarga havolalar yoki logotip bo‘lmasa `null`.', '`logo.square` and `logo.portrait` are file links, or `null` when there is no logo.')] },
  { id: 'branches', section: 'clinic', method: 'GET', path: '/branches', scopes: ['branches'], examples: ['branches'],
    summary: L('Филиалы: название, город и район кодами, улица и ориентир, полный адрес, телефон, часы работы, карта и маршрут.',
      'Filiallar: nomi, shahar va tuman kodlari, ko‘cha va mo‘ljal, to‘liq manzil, telefon, ish soatlari, xarita va yo‘nalish.',
      'Branches: name, city and district codes, street and landmark, full address, phone, working hours, map and directions.'),
    params: [
      { name: 'city', in: 'query', req: false, value: L('код города из `/reference/geo`', '`/reference/geo` dagi shahar kodi', 'a city code from `/reference/geo`') },
      { name: 'district', in: 'query', req: false, value: L('код района из `/reference/geo`', '`/reference/geo` dagi tuman kodi', 'a district code from `/reference/geo`') },
      qLang],
    notes: [L('`hours` — по дням недели (`mon` … `sun`): `["08:00", "18:00"]` или `null` — выходной. `open_24_7: true` — круглосуточно.',
      '`hours` — hafta kunlari bo‘yicha (`mon` … `sun`): `["08:00", "18:00"]` yoki `null` — dam olish kuni. `open_24_7: true` — kecha-kunduz.',
      '`hours` — per weekday (`mon` … `sun`): `["08:00", "18:00"]`, or `null` for a day off. `open_24_7: true` means round the clock.')] },
  { id: 'media', section: 'clinic', method: 'GET', path: '/media/{file}', scopes: null, examples: [],
    summary: L('Файл снимка — логотип или фото врача. Ссылки приходят готовыми в `/clinic` и `/doctors`.', 'Surat fayli — logotip yoki shifokor fotosi. Havolalar `/clinic` va `/doctors` da tayyor keladi.', 'A snapshot file — a logo or a doctor photo. The links come ready-made in `/clinic` and `/doctors`.'),
    params: [{ name: 'file', in: 'path', req: true, value: L('`<sha256>.<png|jpg|webp>` из ссылки', 'havoladagi `<sha256>.<png|jpg|webp>`', '`<sha256>.<png|jpg|webp>` from the link') }],
    notes: [L('Ключ не нужен: картинку на вашем сайте браузер загрузит сам. Кэш — сутки; новый файл — новая ссылка.',
      'Kalit kerak emas: rasmni saytingizda brauzer o‘zi yuklaydi. Kesh — bir sutka; yangi fayl — yangi havola.',
      'No key needed: the browser loads the picture on your site by itself. Cached for a day; a new file gets a new link.')] },
  { id: 'doctors', section: 'doctors', method: 'GET', path: '/doctors', scopes: ['doctors'], examples: ['doctors'],
    summary: L('Врачи, которых клиника показывает: ФИО, должность, о враче, специальности, стаж, языки приёма, фото, филиалы, как принимает и цены.',
      'Klinika ko‘rsatadigan shifokorlar: F.I.Sh., lavozimi, shifokor haqida, mutaxassisliklari, tajribasi, qabul tillari, fotosi, filiallari, qanday qabul qilishi va narxlar.',
      'The doctors the clinic shows: full name, title, about, specialties, experience, languages, photo, branches, how they see patients and prices.'),
    params: [
      { name: 'branch_id', in: 'query', req: false, value: L('номер филиала из `/branches`', '`/branches` dagi filial raqami', 'a branch number from `/branches`') },
      { name: 'specialty', in: 'query', req: false, value: L('код специальности из `/reference/specialties`', '`/reference/specialties` dagi mutaxassislik kodi', 'a specialty code from `/reference/specialties`') },
      { name: 'district', in: 'query', req: false, value: L('код района: врачи филиалов этого района', 'tuman kodi: shu tumandagi filiallar shifokorlari', 'a district code: doctors of the branches in that district') },
      { name: 'city', in: 'query', req: false, value: L('код города', 'shahar kodi', 'a city code') },
      qLang],
    notes: [
      L('`specialties` — коды справочника, первая — основная (не больше четырёх).', '`specialties` — ma’lumotnoma kodlari, birinchisi — asosiysi (to‘rttagacha).', '`specialties` — reference codes, the first one is the main one (up to four).'),
      L('`reception`: `booking` — по записи на время, `live_queue` — живая очередь (записи на время нет).', '`reception`: `booking` — vaqtga yozilish bo‘yicha, `live_queue` — jonli navbat (vaqtga yozilish yo‘q).', '`reception`: `booking` — by appointment, `live_queue` — walk-in queue (no timed booking).'),
      L('`booking_days` — на сколько дней вперёд открыта запись: {{bookingDays|or}}.', '`booking_days` — yozilish necha kun oldinga ochiq: {{bookingDays|or}}.', '`booking_days` — how many days ahead booking is open: {{bookingDays|or}}.'),
      L('`consultations` — виды приёма `initial` (первичный) и `repeat` (повторный) с ценой и длительностью в минутах; `services` — услуги группы «Консультации», которые ведёт врач, с его ценой.',
        '`consultations` — `initial` (birlamchi) va `repeat` (takroriy) qabul turlari narxi va daqiqalardagi davomiyligi bilan; `services` — shifokor olib boradigan «Konsultatsiyalar» guruhi xizmatlari uning narxi bilan.',
        '`consultations` — the visit types `initial` and `repeat` with price and length in minutes; `services` — services of the “Consultations” group the doctor provides, at the doctor’s price.')] },
  { id: 'slots', section: 'doctors', method: 'GET', path: '/slots', scopes: ['slots'], examples: ['slots-day', 'slots-fit', 'slots-live'],
    summary: L('Свободное время врача: окна по {{slotMin:min}}.', 'Shifokorning bo‘sh vaqti: {{slotMin:min}}lik oynalar.', 'A doctor’s free time in {{slotMin}}-minute windows.'),
    params: [
      { name: 'doctor_id', in: 'query', req: true, value: L('номер врача из `/doctors`', '`/doctors` dagi shifokor raqami', 'a doctor number from `/doctors`') },
      { name: 'date', in: 'query', req: false, value: L('`ГГГГ-ММ-ДД`; без даты — все дни, на которые открыта запись', '`YYYY-OO-KK`; sanasiz — yozilish ochiq bo‘lgan barcha kunlar', '`YYYY-MM-DD`; without it — every day open for booking') },
      { name: 'consultation', in: 'query', req: false, value: L('`initial` или `repeat`: только начала, где поместится этот приём', '`initial` yoki `repeat`: faqat shu qabul sig‘adigan boshlanishlar', '`initial` or `repeat`: only the starts where this visit fits') },
      { name: 'service_id', in: 'query', req: false, value: L('номер услуги: только начала, где она поместится', 'xizmat raqami: faqat u sig‘adigan boshlanishlar', 'a service number: only the starts where it fits') }],
    notes: [
      L('С `consultation` или `service_id` остаются только начала, после которых свободно столько окон подряд, сколько длится приём; без них — каждое окно с `free`.',
        '`consultation` yoki `service_id` bilan faqat qabul davomiyligicha ketma-ket bo‘sh oynalar bor boshlanishlar qoladi; ularsiz — har bir oyna `free` bilan.',
        'With `consultation` or `service_id` only the starts followed by enough free windows for the whole visit remain; without them every window comes with `free`.'),
      L('Сегодняшнее прошедшее время — не свободно. Свободное время — подсказка: окончательно его проверяет клиника, принимая запись.',
        'Bugungi o‘tgan vaqt — bo‘sh emas. Bo‘sh vaqt — maslahat: uni yozuvni qabul qilayotgan klinika yakuniy tekshiradi.',
        'Earlier today is never free. Free time is a hint: the clinic checks it for good when it takes the booking.'),
      L('`stale: true` — клиника молчит дольше {{staleMin:min}} или её данные старше {{staleDataMin:min}}: показывайте время с оговоркой; запись всё равно принимается.',
        '`stale: true` — klinika {{staleMin:min}}dan ko‘proq jim yoki ma’lumotlari {{staleDataMin:min}}dan eski: vaqtni izoh bilan ko‘rsating; yozilish baribir qabul qilinadi.',
        '`stale: true` — the clinic has been silent for over {{staleMin:min}} or its data is older than {{staleDataMin:min}}: show the time with a caveat; bookings are still accepted.'),
      L('Живая очередь: времени нет — `hours` (часы приёма) и `queue_now` (сколько ждут сейчас; `null`, если клиника очередь не показывает).',
        'Jonli navbat: vaqt yo‘q — `hours` (qabul soatlari) va `queue_now` (hozir nechta kishi kutmoqda; klinika navbatni ko‘rsatmasa `null`).',
        'Walk-in queue: no times — `hours` (reception hours) and `queue_now` (how many are waiting now; `null` if the clinic does not show the queue).')] },
  { id: 'services', section: 'services', method: 'GET', path: '/services', scopes: ['services'], examples: ['services'],
    summary: L('Услуги с ценами по пяти группам.', 'Beshta guruh bo‘yicha xizmatlar narxlari bilan.', 'Services with prices in five groups.'),
    params: [{ name: 'group', in: 'query', req: false, value: L('код группы — таблица ниже', 'guruh kodi — quyidagi jadval', 'a group code — see the table below') }, qLang],
    notes: [L('`minutes` — длительность, если клиника её указала, иначе `null`.', '`minutes` — klinika ko‘rsatgan bo‘lsa davomiylik, aks holda `null`.', '`minutes` — the length if the clinic set it, otherwise `null`.')],
    table: 'groups' },
  { id: 'packages', section: 'services', method: 'GET', path: '/packages', scopes: ['packages'], examples: ['packages'],
    summary: L('Пакеты услуг: состав, цена без скидки, цена пакета, скидка, срок действия.', 'Xizmat paketlari: tarkibi, chegirmasiz narx, paket narxi, chegirma, amal qilish muddati.', 'Service packages: contents, full price, package price, discount, validity.'),
    params: [qLang],
    notes: [L('Истёкшие пакеты не приходят; пакет с услугой, скрытой клиникой, не приходит вовсе. В `items` — цена каждой услуги в пакете.',
      'Muddati o‘tgan paketlar kelmaydi; klinika yashirgan xizmati bor paket umuman kelmaydi. `items` da — har bir xizmatning paketdagi narxi.',
      'Expired packages are not returned; a package with a service the clinic hid is not returned at all. `items` holds each service’s price inside the package.')] },
  { id: 'requests-create', section: 'booking', method: 'POST', path: '/requests', scopes: ['requests'], examples: ['request-new'],
    summary: L('Заявка без времени — «перезвоните мне». В CRM клиники появляется карточка заявки; ответ — `201` и статус `new`.',
      'Vaqtsiz ariza — «menga qayta qo‘ng‘iroq qiling». Klinika CRM ida ariza kartochkasi paydo bo‘ladi; javob — `201` va `new` holati.',
      'A request without a time — “call me back”. A request card appears in the clinic CRM; the response is `201` with status `new`.'),
    params: [...patient,
      { name: 'doctor_id', in: 'body', req: false, value: L('врач, к которому хочет пациент', 'bemor xohlagan shifokor', 'the doctor the patient wants') },
      { name: 'service_id', in: 'body', req: false, value: L('услуга', 'xizmat', 'a service') },
      { name: 'package_id', in: 'body', req: false, value: L('пакет', 'paket', 'a package') },
      { name: 'branch_id', in: 'body', req: false, value: L('филиал', 'filial', 'a branch') },
      ...common],
    notes: [L('Поля пациента можно прислать и на верхнем уровне: `name`, `phone`, `comment`.', 'Bemor maydonlarini yuqori darajada ham yuborish mumkin: `name`, `phone`, `comment`.', 'The patient fields may also come at the top level: `name`, `phone`, `comment`.')] },
  { id: 'appointments-create', section: 'booking', method: 'POST', path: '/appointments', scopes: ['appointments'], examples: ['appointment-new', 'error-slot-taken'],
    summary: L('Онлайн-запись на свободное время. Ответ — `201` и `pending`: заявка ждёт клинику.', 'Bo‘sh vaqtga onlayn yozilish. Javob — `201` va `pending`: ariza klinikani kutmoqda.', 'An online booking for a free time. The response is `201` with `pending`: the booking waits for the clinic.'),
    params: [
      { name: 'doctor_id', in: 'body', req: true, value: L('врач с `reception: booking`', '`reception: booking` bo‘lgan shifokor', 'a doctor with `reception: booking`') },
      { name: 'consultation', in: 'body', req: false, value: L('`initial` или `repeat` — вид приёма; нужен он или `service_id`', '`initial` yoki `repeat` — qabul turi; u yoki `service_id` kerak', '`initial` or `repeat` — the visit type; this or `service_id` is required') },
      { name: 'service_id', in: 'body', req: false, value: L('услуга вместо вида приёма', 'qabul turi o‘rniga xizmat', 'a service instead of a visit type') },
      { name: 'start', in: 'body', req: true, value: L('начало из `/slots`: `2030-03-12T09:45:00+05:00`', '`/slots` dagi boshlanish: `2030-03-12T09:45:00+05:00`', 'a start from `/slots`: `2030-03-12T09:45:00+05:00`') },
      ...patient,
      { name: 'branch_id', in: 'body', req: false, value: L('для справки: визит заводится в здании, где работает врач', 'ma’lumot uchun: tashrif shifokor ishlaydigan binoda ochiladi', 'for reference only: the visit is created in the doctor’s building') },
      { name: 'package_id', in: 'body', req: false, value: L('пакет; его цену клиника поставит сама', 'paket; uning narxini klinika o‘zi qo‘yadi', 'a package; the clinic applies its price itself') },
      ...common],
    notes: [
      L('`start` — на сетке {{slotMin:min}}, в будущем и не дальше `booking_days` врача.', '`start` — {{slotMin:min}}lik to‘rda, kelajakda va shifokorning `booking_days` dan uzoq emas.', '`start` must sit on the {{slotMin}}-minute grid, in the future and within the doctor’s `booking_days`.'),
      L('Клиника, приняв заявку, держит время {{holdMin:min}} по своим часам работы и сообщает срок — он появится в `hold_until` ([статус заявки](#ep-request-status)). Запись принимается и тогда, когда клиника не на связи: срок держания идёт от приёма заявки клиникой.',
        'Klinika arizani qabul qilgach, vaqtni o‘z ish soatlari bo‘yicha {{holdMin:min}} band qilib turadi va muddatni xabar qiladi — u `hold_until` da paydo bo‘ladi ([ariza holati](#ep-request-status)). Klinika aloqada bo‘lmaganda ham yozilish qabul qilinadi: band qilish muddati arizani klinika qabul qilgan paytdan boshlanadi.',
        'Once the clinic takes the booking it holds the time for {{holdMin:min}} of its working hours and reports the deadline — it appears in `hold_until` ([request status](#ep-request-status)). Bookings are accepted even while the clinic is offline: the hold starts when the clinic takes the booking.'),
      L('`409 slot_taken` — время занято по последнему, что прислала клиника, или другой ждущей записью: запросите `/slots` заново.',
        '`409 slot_taken` — klinika oxirgi yuborgan ma’lumot bo‘yicha yoki boshqa kutayotgan yozuv bilan vaqt band: `/slots` ni qayta so‘rang.',
        '`409 slot_taken` — the time is taken according to what the clinic sent last, or by another waiting booking: request `/slots` again.')] },
  { id: 'request-status', section: 'booking', method: 'GET', path: '/requests/{id}', scopes: ['requests', 'appointments'], examples: ['request-held', 'request-offered'],
    summary: L('Статус заявки или записи. Только присланные этим же подключением; чужие и неизвестные — `404`.', 'Ariza yoki yozuv holati. Faqat shu ulanish yuborganlari; boshqalarniki va noma’lumlari — `404`.', 'The status of a request or booking. Only those sent by the same connection; others and unknown ones get `404`.'),
    params: [pathId],
    notes: [L('Статус хранится {{keepDays:day}} после последнего изменения. Данных пациента в ответе нет.', 'Holat oxirgi o‘zgarishdan keyin {{keepDays:day}} saqlanadi. Javobda bemor ma’lumotlari yo‘q.', 'The status is kept for {{keepDays:day}} after the last change. The response has no patient data.')] },
  { id: 'offer-accept', section: 'booking', method: 'POST', path: '/appointments/{id}/accept', scopes: ['appointments'], examples: ['offer-accept'],
    summary: L('Пациент согласен на время, которое предложила клиника.', 'Bemor klinika taklif qilgan vaqtga rozi.', 'The patient agrees to the time the clinic offered.'),
    params: [pathId, { name: 'offered_start', in: 'body', req: false, value: L('время предложения, на которое вы отвечаете, — как в `offered_start` статуса', 'siz javob berayotgan taklif vaqti — holatdagi `offered_start` kabi', 'the offered time you are answering — as in the status `offered_start`') }],
    notes: [L('Согласие — снова `pending` на новом времени: клиника снова держит его и сообщит `hold_until`.', 'Rozilik — yangi vaqtda yana `pending`: klinika uni yana band qiladi va `hold_until` ni xabar qiladi.', 'Accepting makes it `pending` again at the new time: the clinic holds it again and reports `hold_until`.')] },
  { id: 'offer-decline', section: 'booking', method: 'POST', path: '/appointments/{id}/decline', scopes: ['appointments'], examples: [],
    summary: L('Пациент отказался от предложенного времени — запись `cancelled`.', 'Bemor taklif qilingan vaqtdan voz kechdi — yozuv `cancelled`.', 'The patient declines the offered time — the booking becomes `cancelled`.'),
    params: [pathId, { name: 'offered_start', in: 'body', req: false, value: L('как у согласия', 'rozilikdagi kabi', 'as for accepting') }] },
  { id: 'appointments-cancel', section: 'booking', method: 'DELETE', path: '/appointments/{id}', scopes: ['cancel'], examples: ['appointment-cancel'],
    summary: L('Пациент отменил запись у вас.', 'Bemor yozuvni sizda bekor qildi.', 'The patient cancelled the booking with you.'),
    params: [pathId],
    notes: [
      L('Ждущая и с предложением — сразу `cancelled`, время свободно.', 'Kutayotgan va taklifli yozuv — darhol `cancelled`, vaqt bo‘shaydi.', 'A waiting or offered booking becomes `cancelled` at once and the time is free.'),
      L('Записанная (`booked`) остаётся `booked` с `cancel_requested: true`, пока клиника не отменит визит: тогда `cancelled` и уведомление `appointment.cancelled`. Если пациент уже в клинике, решает клиника.',
        'Yozilgan (`booked`) yozuv klinika tashrifni bekor qilmaguncha `cancel_requested: true` bilan `booked` bo‘lib qoladi: shunda `cancelled` va `appointment.cancelled` bildirishnomasi. Bemor allaqachon klinikada bo‘lsa, klinika hal qiladi.',
        'A booked one stays `booked` with `cancel_requested: true` until the clinic cancels the visit: then `cancelled` and the `appointment.cancelled` notification. If the patient is already at the clinic, the clinic decides.'),
      L('Повтор отмены — тот же ответ; из других статусов — `409 not_cancellable`.', 'Bekor qilishni takrorlash — o‘sha javob; boshqa holatlardan — `409 not_cancellable`.', 'Repeating a cancellation gives the same answer; from other statuses — `409 not_cancellable`.')] },
]);

// ---- примеры: запросы (ответы — docs/generated.js) ---------------------------------------
// {lang} в пути и теле — язык страницы; {callback} / {appointment} — номер заявки из
// ответа примера с saveAs; значение L(…) в теле — на языке страницы.
const PATIENT_EXAMPLE = { name: 'Aziza Karimova', phone: '+998901234567', comment: L('Удобно после 18:00', '18:00 dan keyin qulay', 'Best after 18:00') };
export const EXAMPLES = Object.freeze([
  { id: 'geo', method: 'GET', path: '/reference/geo?lang={lang}', trim: { countries: 2, cities: 1, 'cities.districts': 2 } },
  { id: 'specialties', method: 'GET', path: '/reference/specialties?lang={lang}', trim: { specialties: 3 } },
  { id: 'clinic', method: 'GET', path: '/clinic?lang={lang}' },
  { id: 'branches', method: 'GET', path: '/branches?lang={lang}' },
  { id: 'doctors', method: 'GET', path: '/doctors?lang={lang}' },
  { id: 'slots-day', method: 'GET', path: '/slots?doctor_id=7&date=2030-03-12',
    title: L('Окна дня', 'Kun oynalari', 'Windows of a day') },
  { id: 'slots-fit', method: 'GET', path: '/slots?doctor_id=7&date=2030-03-12&consultation=initial',
    title: L('Только начала, где поместится первичный приём (30 минут)', 'Faqat birlamchi qabul (30 daqiqa) sig‘adigan boshlanishlar', 'Only the starts where a first visit (30 minutes) fits') },
  { id: 'slots-live', method: 'GET', path: '/slots?doctor_id=8', title: L('Врач с живой очередью', 'Jonli navbatli shifokor', 'A walk-in queue doctor') },
  { id: 'services', method: 'GET', path: '/services?lang={lang}' },
  { id: 'packages', method: 'GET', path: '/packages?lang={lang}' },
  { id: 'request-new', method: 'POST', path: '/requests', saveAs: 'callback',
    body: { patient: PATIENT_EXAMPLE, service_id: 301, external_id: 'cb-1001', lang: '{lang}' } },
  { id: 'appointment-new', method: 'POST', path: '/appointments', saveAs: 'appointment',
    body: { doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:45:00+05:00', branch_id: 1,
      patient: { name: 'Aziza Karimova', phone: '+998901234567' }, external_id: 'bk-2002', lang: '{lang}' } },
  { id: 'error-slot-taken', method: 'POST', path: '/appointments?lang={lang}',
    title: L('Время занято', 'Vaqt band', 'The time is taken'),
    body: { doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:30:00+05:00', patient: { name: 'Aziza Karimova', phone: '+998901234567' },
      external_id: 'bk-2003' } },
  { id: 'request-held', method: 'GET', path: '/requests/{appointment}',
    title: L('Клиника приняла запись и держит время', 'Klinika yozuvni qabul qildi va vaqtni band qilib turibdi', 'The clinic took the booking and holds the time') },
  { id: 'request-offered', method: 'GET', path: '/requests/{appointment}',
    title: L('Клиника предложила другое время', 'Klinika boshqa vaqt taklif qildi', 'The clinic offered another time') },
  { id: 'offer-accept', method: 'POST', path: '/appointments/{appointment}/accept', body: { offered_start: '2030-03-12T10:00:00+05:00' } },
  { id: 'appointment-cancel', method: 'DELETE', path: '/appointments/{appointment}' },
  { id: 'error-field', method: 'POST', path: '/requests?lang={lang}', title: L('Поле заполнено неверно', 'Maydon noto‘g‘ri to‘ldirilgan', 'A field is invalid'),
    body: { patient: { name: 'Aziza Karimova', phone: '12' } } },
  { id: 'error-key', method: 'GET', path: '/clinic?lang={lang}', key: 'wrong', curl: false,
    title: L('Ключ неверный', 'Kalit noto‘g‘ri', 'The key is wrong') },
]);

// ---- статусы, причины, события, ошибки -------------------------------------------------
export const STATUS_TEXT = Object.freeze({
  new: { kind: 'request', text: L('Заявка «перезвоните» пришла, клиника её ещё не взяла.', '«Qayta qo‘ng‘iroq» arizasi keldi, klinika uni hali olmagan.', 'The callback request has arrived; the clinic has not taken it yet.') },
  accepted: { kind: 'request', text: L('Администратор взял заявку в работу и свяжется с пациентом.', 'Administrator arizani ishga oldi va bemor bilan bog‘lanadi.', 'An administrator took the request on and will contact the patient.') },
  pending: { kind: 'appointment', text: L('Онлайн-запись ждёт подтверждения. Когда клиника примет заявку, время держится до `hold_until`.', 'Onlayn yozilish tasdiqlashni kutmoqda. Klinika arizani qabul qilgach, vaqt `hold_until` gacha band turadi.', 'The online booking awaits confirmation. Once the clinic takes it, the time is held until `hold_until`.') },
  offered: { kind: 'appointment', text: L('Клиника предложила другое время — `offered_start`; ответ ждёт до `offer_until`.', 'Klinika boshqa vaqt taklif qildi — `offered_start`; javob `offer_until` gacha kutiladi.', 'The clinic offered another time — `offered_start`; it waits for an answer until `offer_until`.') },
  booked: { kind: 'both', text: L('Пациент записан, визит создан; `start` — время визита.', 'Bemor yozildi, tashrif yaratildi; `start` — tashrif vaqti.', 'The patient is booked and the visit created; `start` is the visit time.') },
  declined: { kind: 'appointment', text: L('Клиника отказала, причина — в `reason`. Время свободно.', 'Klinika rad etdi, sababi — `reason` da. Vaqt bo‘sh.', 'The clinic declined; the reason is in `reason`. The time is free.') },
  expired: { kind: 'appointment', text: L('Не подтверждено вовремя (`reason: expired`).', 'O‘z vaqtida tasdiqlanmadi (`reason: expired`).', 'Not confirmed in time (`reason: expired`).') },
  cancelled: { kind: 'both', text: L('Отменено — пациентом через вас или клиникой.', 'Bekor qilindi — siz orqali bemor yoki klinika tomonidan.', 'Cancelled — by the patient through you, or by the clinic.') },
  arrived: { kind: 'both', text: L('Пациент пришёл. Только если клиника включила подключению событие `appointment.arrived`: это врачебная тайна.', 'Bemor keldi. Faqat klinika ulanishga `appointment.arrived` hodisasini yoqqan bo‘lsa: bu shifokorlik siri.', 'The patient arrived. Only if the clinic enabled the `appointment.arrived` event for the connection: it is medical confidentiality.') },
  no_show: { kind: 'both', text: L('Пациент не пришёл. Сейчас партнёрам не сообщается: после дня визита статус остаётся `booked`.', 'Bemor kelmadi. Hozircha hamkorlarga xabar qilinmaydi: tashrif kunidan keyin holat `booked` bo‘lib qoladi.', 'The patient did not come. Not reported to partners for now: after the visit day the status stays `booked`.') },
  closed: { kind: 'both', text: L('Закрыто сервером: клиника не ответила, причина — в `reason`. Уведомления нет; пусть пациент позвонит в клинику.', 'Server yopdi: klinika javob bermadi, sababi — `reason` da. Bildirishnoma yo‘q; bemor klinikaga qo‘ng‘iroq qilsin.', 'Closed by the server: the clinic did not answer; the reason is in `reason`. There is no notification; the patient should call the clinic.') },
});

/** Причины для closed ставит сервер (store/requests.js closeOverdue); остальные — клиника (DECLINE_REASONS). */
export const CLOSED_REASONS = Object.freeze(['not_processed', 'not_collected']);
export const REASON_TEXT = Object.freeze({
  slot_taken: { status: 'declined', text: L('Время уже занято — предложите пациенту другое из `/slots`.', 'Vaqt band — bemorga `/slots` dan boshqasini taklif qiling.', 'The time is already taken — offer the patient another one from `/slots`.') },
  doctor_unavailable: { status: 'declined', text: L('Врач в это время не принимает.', 'Shifokor bu vaqtda qabul qilmaydi.', 'The doctor does not see patients at that time.') },
  not_bookable: { status: 'declined', text: L('Запись к этому врачу или на эту услугу через API не открыта либо время дальше срока записи врача.', 'Bu shifokorga yoki bu xizmatga API orqali yozilish ochilmagan yoki vaqt shifokorning yozilish muddatidan uzoq.', 'Booking this doctor or service via the API is not open, or the time is beyond the doctor’s booking window.') },
  duplicate: { status: 'declined', text: L('Повтор уже принятой заявки.', 'Allaqachon qabul qilingan arizaning takrori.', 'A repeat of a request already taken.') },
  expired: { status: 'expired', text: L('Клиника не подтвердила вовремя или приём уже прошёл, пока клиника была не на связи.', 'Klinika o‘z vaqtida tasdiqlamadi yoki klinika aloqada bo‘lmaganida qabul vaqti o‘tib ketdi.', 'The clinic did not confirm in time, or the visit time passed while the clinic was offline.') },
  other: { status: 'declined', text: L('Другая причина — пусть пациент позвонит в клинику.', 'Boshqa sabab — bemor klinikaga qo‘ng‘iroq qilsin.', 'Another reason — the patient should call the clinic.') },
  not_processed: { status: 'closed', text: L('Клиника получила онлайн-запись, но за {{answerMin:min}} не ответила.', 'Klinika onlayn yozilishni oldi, lekin {{answerMin:min}} ichida javob bermadi.', 'The clinic received the booking but did not answer within {{answerMin:min}}.') },
  not_collected: { status: 'closed', text: L('Клиника не забрала заявку за {{uncollectedHours:hour}} (компьютер выключен или нет интернета); данные пациента стёрты с сервера.', 'Klinika arizani {{uncollectedHours:hour}} ichida olmadi (kompyuter o‘chiq yoki internet yo‘q); bemor ma’lumotlari serverdan o‘chirildi.', 'The clinic did not collect the request within {{uncollectedHours:hour}} (computer off or no internet); the patient data was erased from the server.') },
});

/** Статусы и поля уведомлений по событиям — как их шлёт клиника (services/api/bookings.js, visit-events.js). */
export const EVENT_TEXT = Object.freeze({
  'request.accepted': { statuses: ['accepted'], fields: [] },
  'appointment.created': { statuses: ['booked'], fields: ['doctor_id', 'start', 'rescheduled'] },
  'booking.confirmed': { statuses: ['booked'], fields: ['doctor_id', 'branch_id', 'start'] },
  'booking.offered_other_time': { statuses: ['offered'], fields: ['doctor_id', 'offered_start', 'offer_until'] },
  'booking.declined': { statuses: ['declined', 'expired'], fields: ['reason', 'doctor_id', 'start'] },
  'appointment.cancelled': { statuses: ['cancelled'], fields: ['doctor_id'] },
  'appointment.arrived': { statuses: ['arrived'], fields: ['doctor_id'] },
});
/** Пример уведомления: тело собирает webhookBody программы клиники, подпись — её signBody. */
export const WEBHOOK_EXAMPLE = Object.freeze({
  url: 'https://partner.example/hooks/easymed', secret: 'example-secret',
  eventId: 'ev_5f1c2a9be03d7a64c81e0f22', event: 'booking.confirmed', publicId: SAMPLE.ids.appointment, externalId: 'bk-2002',
  status: 'booked', occurredAt: '2030-03-11T04:12:00Z', details: { doctor_id: 7, branch_id: 1, start: '2030-03-12T10:00:00+05:00' },
});
export const VERIFY_NODE = [
  "const crypto = require('node:crypto');",
  '',
  'function signatureOk(rawBody, header, secret) {',
  "  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');",
  "  const a = Buffer.from(expected);",
  "  const b = Buffer.from(String(header || ''));",
  '  return a.length === b.length && crypto.timingSafeEqual(a, b);',
  '}',
].join('\n');
export const VERIFY_PHP = [
  '$raw = file_get_contents(\'php://input\');',
  '$expected = \'sha256=\' . hash_hmac(\'sha256\', $raw, $secret);',
  '$ok = hash_equals($expected, $_SERVER[\'HTTP_X_EASYMED_SIGNATURE\'] ?? \'\');',
].join('\n');

/** Коды lib/errors.js, которые видит только канал клиники (/_sync/v1), — партнёру не приходят. */
export const CLINIC_ONLY_ERRORS = Object.freeze(['invalid_signature', 'licence_invalid', 'licence_outdated', 'clock_skew', 'bad_slug', 'slug_taken', 'media_quota']);
export const ERROR_TEXT = Object.freeze({
  bad_request: L('Тело — не объект JSON. Пришлите объект `{…}`.', 'Tana JSON obyekti emas. `{…}` obyektini yuboring.', 'The body is not a JSON object. Send an object `{…}`.'),
  bad_json: L('Тело не разбирается как JSON — проверьте кавычки и запятые.', 'Tana JSON sifatida o‘qilmaydi — qo‘shtirnoq va vergullarni tekshiring.', 'The body does not parse as JSON — check quotes and commas.'),
  invalid_field: L('Поле `field` неверно по причине `reason` — таблица полей ниже.', '`field` maydoni `reason` sababi bilan noto‘g‘ri — maydonlar jadvali quyida.', 'The `field` is invalid for the `reason` — see the field table below.'),
  https_required: L('Запрос пришёл по http — только https.', 'So‘rov http orqali keldi — faqat https.', 'The request came over http — https only.'),
  invalid_key: L('Нет заголовка `Authorization: Bearer …` или ключ неверный — сверьте ключ с клиникой.', '`Authorization: Bearer …` sarlavhasi yo‘q yoki kalit noto‘g‘ri — kalitni klinika bilan solishtiring.', 'No `Authorization: Bearer …` header, or the key is wrong — check the key with the clinic.'),
  key_disabled: L('Клиника выключила подключение — обратитесь в клинику.', 'Klinika ulanishni o‘chirdi — klinikaga murojaat qiling.', 'The clinic switched the connection off — contact the clinic.'),
  key_expired: L('Срок ключа вышел — попросите у клиники новый.', 'Kalit muddati tugadi — klinikadan yangisini so‘rang.', 'The key has expired — ask the clinic for a new one.'),
  forbidden_scope: L('Ключу не открыт раздел из поля `scope` — попросите клинику включить это право.', 'Kalitga `scope` maydonidagi bo‘lim ochilmagan — klinikadan bu huquqni yoqishni so‘rang.', 'The key has no access to the section in `scope` — ask the clinic to enable that scope.'),
  ip_not_allowed: L('Запрос не с разрешённого IP — сообщите клинике адрес своего сервера.', 'So‘rov ruxsat etilgan IP dan emas — klinikaga serveringiz manzilini ayting.', 'The request is not from an allowed IP — give the clinic your server’s address.'),
  origin_not_allowed: L('Запрос из браузера с сайта, которого нет в подключении, — сообщите клинике адрес сайта.', 'Ulanishda yo‘q saytdan brauzer so‘rovi — klinikaga sayt manzilini ayting.', 'A browser request from a site that is not in the connection — give the clinic the site address.'),
  not_found: L('Нет такого адреса, врача, услуги или заявки либо клиника их скрыла; поле `field` подскажет, что именно. Обновите списки.', 'Bunday manzil, shifokor, xizmat yoki ariza yo‘q yoki klinika ularni yashirgan; `field` maydoni nimaligini aytadi. Ro‘yxatlarni yangilang.', 'No such endpoint, doctor, service or request, or the clinic hid it; `field` tells which. Refresh your lists.'),
  clinic_not_found: L('Нет клиники с таким именем в адресе — сверьте адрес с клиникой.', 'Manzilda bunday nomli klinika yo‘q — manzilni klinika bilan solishtiring.', 'No clinic with that name in the address — check the address with the clinic.'),
  slot_taken: L('Время занято — запросите `/slots` заново и предложите другое.', 'Vaqt band — `/slots` ni qayta so‘rang va boshqasini taklif qiling.', 'The time is taken — request `/slots` again and offer another.'),
  not_cancellable: L('Запись уже не отменить: она отклонена, истекла, закрыта или пациент пришёл.', 'Yozuvni endi bekor qilib bo‘lmaydi: u rad etilgan, muddati o‘tgan, yopilgan yoki bemor kelgan.', 'The booking can no longer be cancelled: it was declined, expired, closed or the patient came.'),
  not_offered: L('Клиника не предлагала другое время или ответ уже дан.', 'Klinika boshqa vaqt taklif qilmagan yoki javob allaqachon berilgan.', 'The clinic has not offered another time, or the answer was already given.'),
  offer_changed: L('Клиника уже предложила другое время — запросите заявку и ответьте на новое.', 'Klinika allaqachon boshqa vaqt taklif qildi — arizani so‘rang va yangisiga javob bering.', 'The clinic has already offered a different time — fetch the request and answer the new offer.'),
  offer_expired: L('Срок ответа вышел — запишите пациента заново.', 'Javob muddati tugadi — bemorni qaytadan yozing.', 'The time to answer has passed — book the patient again.'),
  too_large: L('Тело больше {{bodyKb}} КБ.', 'Tana {{bodyKb}} KB dan katta.', 'The body is larger than {{bodyKb}} KB.'),
  unsupported_encoding: L('Тело сжато неизвестным способом — пришлите без `Content-Encoding`.', 'Tana noma’lum usulda siqilgan — `Content-Encoding` siz yuboring.', 'The body is compressed in an unknown way — send it without `Content-Encoding`.'),
  rate_limited: L('Лимит запросов — повторите через столько секунд, сколько в `Retry-After`.', 'So‘rovlar chegarasi — `Retry-After` dagi soniyadan keyin takrorlang.', 'Rate limit — retry after as many seconds as `Retry-After` says.'),
  internal: L('Ошибка сервера — повторите позже; если повторяется, напишите в Easy-Med.', 'Server xatosi — keyinroq takrorlang; takrorlansa, Easy-Med ga yozing.', 'Server error — retry later; if it keeps happening, write to Easy-Med.'),
  licence_lapsed: L('Клиника временно недоступна для подключений — покажите пациенту телефон клиники из поля `phone`.', 'Klinika ulanishlar uchun vaqtincha mavjud emas — bemorga `phone` maydonidagi klinika telefonini ko‘rsating.', 'The clinic is temporarily unavailable to connections — show the patient the clinic phone from `phone`.'),
  clinic_offline: L('Клиника давно не выходила на связь или ещё не подключилась — покажите пациенту телефон из поля `phone`.', 'Klinika uzoq vaqt aloqaga chiqmagan yoki hali ulanmagan — bemorga `phone` maydonidagi telefonni ko‘rsating.', 'The clinic has not been online for a long time or is not connected yet — show the patient the phone from `phone`.'),
});

/**
 * Причины полей: { field, reason, code?, text, probes:{ endpoint: {path} | {body} } }.
 * Пробы — запросы, которыми страж показывает эту ошибку на настоящем сервере
 * (body — поверх тела примера адреса).
 */
const READS = ['geo', 'specialties', 'clinic', 'branches', 'doctors', 'services', 'packages'];
const readLang = Object.fromEntries(READS.map((ep) => [ep, { path: ENDPOINTS.find((e) => e.id === ep).path + '?lang=de' }]));
const both = (body) => ({ 'requests-create': { body }, 'appointments-create': { body } });
const P_OK = '+998901234567';
export const FIELD_ERRORS = Object.freeze([
  { field: 'lang', reason: 'unknown', text: L('не `ru`, `uz` и не `en`', '`ru`, `uz` ham, `en` ham emas', 'not `ru`, `uz` or `en`'), probes: { ...readLang, ...both({ lang: 'de' }) } },
  { field: 'doctor_id', reason: 'required', text: L('не указан', 'ko‘rsatilmagan', 'missing'), probes: { slots: { path: '/slots' }, 'appointments-create': { body: { doctor_id: undefined } } } },
  { field: 'doctor_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: { slots: { path: '/slots?doctor_id=seven' }, ...both({ doctor_id: 'seven' }) } },
  { field: 'doctor_id', code: 'not_found', text: L('такого врача клиника не показывает', 'klinika bunday shifokorni ko‘rsatmaydi', 'the clinic shows no such doctor'), probes: { slots: { path: '/slots?doctor_id=99' }, ...both({ doctor_id: 99 }) } },
  { field: 'doctor_id', reason: 'live_queue', text: L('у врача живая очередь — записи на время нет', 'shifokorda jonli navbat — vaqtga yozilish yo‘q', 'the doctor has a walk-in queue — no timed booking'), probes: { 'appointments-create': { body: { doctor_id: 8 } } } },
  { field: 'branch_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: { doctors: { path: '/doctors?branch_id=main' }, ...both({ branch_id: -1 }) } },
  { field: 'service_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: both({ service_id: 'x' }) },
  { field: 'service_id', code: 'not_found', text: L('такой услуги клиника не показывает', 'klinika bunday xizmatni ko‘rsatmaydi', 'the clinic shows no such service'), probes: { slots: { path: '/slots?doctor_id=7&service_id=999' }, 'requests-create': { body: { service_id: 999 } }, 'appointments-create': { body: { consultation: undefined, service_id: 999 } } } },
  { field: 'package_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: both({ package_id: 'x' }) },
  { field: 'package_id', code: 'not_found', text: L('такого пакета клиника не показывает', 'klinika bunday paketni ko‘rsatmaydi', 'the clinic shows no such package'), probes: both({ package_id: 99 }) },
  { field: 'group', reason: 'unknown', text: L('нет такой группы услуг', 'bunday xizmat guruhi yo‘q', 'no such service group'), probes: { services: { path: '/services?group=xray' } } },
  { field: 'date', reason: 'format', text: L('не `ГГГГ-ММ-ДД`', '`YYYY-OO-KK` emas', 'not `YYYY-MM-DD`'), probes: { slots: { path: '/slots?doctor_id=7&date=12.03.2030' } } },
  { field: 'consultation', reason: 'required', text: L('нет ни `consultation`, ни `service_id`', '`consultation` ham, `service_id` ham yo‘q', 'neither `consultation` nor `service_id`'), probes: { 'appointments-create': { body: { consultation: undefined } } } },
  { field: 'consultation', reason: 'unknown', text: L('не `initial` и не `repeat`', '`initial` ham, `repeat` ham emas', 'not `initial` or `repeat`'), probes: { 'appointments-create': { body: { consultation: 'vip' } } } },
  { field: 'consultation', reason: 'not_offered', text: L('врач такой вид приёма не ведёт', 'shifokor bunday qabul turini o‘tkazmaydi', 'the doctor does not offer this visit type'), probes: { slots: { path: '/slots?doctor_id=7&consultation=repeat' }, 'appointments-create': { body: { consultation: 'repeat' } } } },
  { field: 'start', reason: 'required', text: L('не указано', 'ko‘rsatilmagan', 'missing'), probes: { 'appointments-create': { body: { start: undefined } } } },
  { field: 'start', reason: 'format', text: L('не время вида `2030-03-12T09:45:00+05:00`', '`2030-03-12T09:45:00+05:00` ko‘rinishidagi vaqt emas', 'not a time like `2030-03-12T09:45:00+05:00`'), probes: { 'appointments-create': { body: { start: 'tomorrow' } } } },
  { field: 'start', reason: 'past', text: L('время уже прошло', 'vaqt o‘tib ketgan', 'the time has passed'), probes: { 'appointments-create': { body: { start: '2030-03-11T08:00:00+05:00' } } } },
  { field: 'start', reason: 'grid', text: L('не на сетке {{slotMin:min}}', '{{slotMin:min}}lik to‘rda emas', 'not on the {{slotMin}}-minute grid'), probes: { 'appointments-create': { body: { start: '2030-03-12T09:50:00+05:00' } } } },
  { field: 'start', reason: 'horizon', text: L('дальше срока записи врача (`booking_days`)', 'shifokorning yozilish muddatidan (`booking_days`) uzoq', 'beyond the doctor’s `booking_days`'), probes: { 'appointments-create': { body: { start: '2030-03-26T09:00:00+05:00' } } } },
  { field: 'patient.name', reason: 'required', text: L('имени нет', 'ism yo‘q', 'no name'), probes: both({ patient: { phone: P_OK } }) },
  { field: 'patient.name', reason: 'too_long', text: L('длиннее {{nameMax}} знаков', '{{nameMax}} belgidan uzun', 'longer than {{nameMax}} characters'), probes: both({ patient: { name: 'x'.repeat(121), phone: P_OK } }) },
  { field: 'patient.phone', reason: 'required', text: L('телефона нет', 'telefon yo‘q', 'no phone'), probes: both({ patient: { name: 'Aziza' } }) },
  { field: 'patient.phone', reason: 'format', text: L('меньше {{phoneDigitsMin}} цифр или длиннее {{phoneMax}} знаков', '{{phoneDigitsMin}} raqamdan kam yoki {{phoneMax}} belgidan uzun', 'fewer than {{phoneDigitsMin}} digits or longer than {{phoneMax}} characters'), probes: both({ patient: { name: 'Aziza', phone: '12' } }) },
  { field: 'patient.comment', reason: 'too_long', text: L('длиннее {{commentMax}} знаков', '{{commentMax}} belgidan uzun', 'longer than {{commentMax}} characters'), probes: both({ patient: { name: 'Aziza', phone: P_OK, comment: 'x'.repeat(1001) } }) },
  { field: 'external_id', reason: 'format', text: L('пробел, кириллица или длиннее {{externalMax}} знаков', 'bo‘sh joy, kirill harflari yoki {{externalMax}} belgidan uzun', 'a space, Cyrillic or longer than {{externalMax}} characters'), probes: both({ external_id: 'has space' }) },
  { field: 'offered_start', reason: 'format', text: L('не время', 'vaqt emas', 'not a time'), probes: { 'offer-accept': { body: { offered_start: 'tomorrow' } }, 'offer-decline': { body: { offered_start: 'tomorrow' } } } },
]);

// ---- разделы страницы ------------------------------------------------------------------
export const SECTIONS = Object.freeze([
  { id: 'start', title: L('Начало работы', 'Boshlash', 'Getting started'), blocks: [
    { p: L('Каждая клиника — свой адрес: `{{base}}/<клиника>/v1/`. Короткое имя клиники в адресе, ключ и права выдаёт сама клиника: в программе Easy-Med это «Настройки → API и подключения», кнопка «Скопировать всё». В примерах клиника — `{{slug}}`, ключ лежит в переменной `EASYMED_KEY`.',
      'Har bir klinikaning o‘z manzili bor: `{{base}}/<klinika>/v1/`. Manzildagi qisqa nom, kalit va huquqlarni klinikaning o‘zi beradi: Easy-Med dasturida bu «Sozlamalar → API va ulanishlar», «Hammasini nusxalash» tugmasi. Misollarda klinika — `{{slug}}`, kalit `EASYMED_KEY` o‘zgaruvchisida.',
      'Every clinic has its own address: `{{base}}/<clinic>/v1/`. The clinic itself issues the short name in the address, the key and the scopes: in the Easy-Med program it is “Settings → API and connections”, the “Copy all” button. In the examples the clinic is `{{slug}}` and the key is in the `EASYMED_KEY` variable.') },
    { code: L('export EASYMED_KEY="{{keyPrefix}}…"', 'export EASYMED_KEY="{{keyPrefix}}…"', 'export EASYMED_KEY="{{keyPrefix}}…"') },
    { example: 'clinic', response: false },
    { kv: [
      [L('Адрес', 'Manzil', 'Address'), L('`{{base}}/<клиника>/v1/`. После смены имени клиники прежний адрес работает ещё {{slugAliasDays:day}}.', '`{{base}}/<klinika>/v1/`. Klinika nomi o‘zgargach, eski manzil yana {{slugAliasDays:day}} ishlaydi.', '`{{base}}/<clinic>/v1/`. After the clinic renames itself the old address keeps working for {{slugAliasDays:day}}.')],
      [L('Ключ', 'Kalit', 'Key'), L('В каждом запросе: `Authorization: Bearer {{keyPrefix}}…`. У каждого подключения свой ключ; выключенный или заменённый клиникой ключ перестаёт подходить за {{clinicPollSec:sec}}, если клиника на связи.', 'Har bir so‘rovda: `Authorization: Bearer {{keyPrefix}}…`. Har bir ulanishning o‘z kaliti bor; klinika o‘chirgan yoki almashtirgan kalit, klinika aloqada bo‘lsa, {{clinicPollSec:sec}} ichida yaroqsiz bo‘ladi.', 'In every request: `Authorization: Bearer {{keyPrefix}}…`. Each connection has its own key; a key the clinic switched off or replaced stops working within {{clinicPollSec:sec}} if the clinic is online.')],
      [L('Только HTTPS', 'Faqat HTTPS', 'HTTPS only'), L('Запросы по http не принимаются.', 'http orqali so‘rovlar qabul qilinmaydi.', 'Requests over http are refused.')],
      [L('Формат', 'Format', 'Format'), L('JSON в UTF-8. Тело запроса — `Content-Type: application/json`, не больше {{bodyKb}} КБ.', 'UTF-8 dagi JSON. So‘rov tanasi — `Content-Type: application/json`, {{bodyKb}} KB dan oshmasin.', 'JSON in UTF-8. Request bodies use `Content-Type: application/json`, at most {{bodyKb}} KB.')],
      [L('Язык', 'Til', 'Language'), L('`?lang=ru`, `uz` или `en` — каждое название одной строкой; без параметра — объектом `{"ru", "uz", "en"}`. Пустой перевод заменяется русским. Тот же параметр выбирает язык текста ошибок (без него — русский).', '`?lang=ru`, `uz` yoki `en` — har bir nom bitta satr; parametrsiz — `{"ru", "uz", "en"}` obyekti. Bo‘sh tarjima ruscha bilan almashtiriladi. Shu parametr xato matni tilini ham tanlaydi (usiz — ruscha).', '`?lang=ru`, `uz` or `en` — every name as one string; without it — an object `{"ru", "uz", "en"}`. An empty translation falls back to Russian. The same parameter picks the language of error messages (Russian without it).')],
      [L('Время', 'Vaqt', 'Time'), L('Ташкент, UTC+5: `2030-03-12T09:45:00+05:00`. Время без смещения (`2030-03-12T09:45`) читается как ташкентское. Даты — `ГГГГ-ММ-ДД`, часы — `ЧЧ:ММ`. Только `occurred_at` уведомлений — в UTC.', 'Toshkent, UTC+5: `2030-03-12T09:45:00+05:00`. Siljishsiz vaqt (`2030-03-12T09:45`) Toshkent vaqti deb o‘qiladi. Sanalar — `YYYY-OO-KK`, soatlar — `SS:DD`. Faqat bildirishnomalardagi `occurred_at` — UTC da.', 'Tashkent, UTC+5: `2030-03-12T09:45:00+05:00`. A time without an offset (`2030-03-12T09:45`) is read as Tashkent time. Dates are `YYYY-MM-DD`, clock times `HH:MM`. Only the `occurred_at` of notifications is in UTC.')],
      [L('Суммы', 'Summalar', 'Amounts'), L('В сумах, целыми числами: `150000`.', 'So‘mda, butun sonlar bilan: `150000`.', 'In Uzbek som, as integers: `150000`.')],
      [L('Свежесть', 'Yangilik', 'Freshness'), L('Сервер отдаёт то, что клиника прислала последним: изменения доходят за {{clinicPollSec:sec}}, свободное время обновляется раз в минуту. `as_of` — когда клиника последний раз была на связи. Клиника молчит {{silentDays:day}} — ответ `503 clinic_offline`.', 'Server klinika oxirgi yuborganini beradi: o‘zgarishlar {{clinicPollSec:sec}} ichida yetib keladi, bo‘sh vaqt har daqiqada yangilanadi. `as_of` — klinika oxirgi marta qachon aloqada bo‘lgani. Klinika {{silentDays:day}} jim bo‘lsa — `503 clinic_offline` javobi.', 'The server serves what the clinic sent last: changes arrive within {{clinicPollSec:sec}}, free time is refreshed every minute. `as_of` is when the clinic was last online. If the clinic is silent for {{silentDays:day}} — `503 clinic_offline`.')],
      [L('Новые поля', 'Yangi maydonlar', 'New fields'), L('В ответах могут появляться новые поля — пропускайте незнакомые.', 'Javoblarda yangi maydonlar paydo bo‘lishi mumkin — notanishlarini o‘tkazib yuboring.', 'New fields may appear in responses — skip the ones you do not know.')],
      [L('Примеры', 'Misollar', 'Examples'), L('Команды — для bash (Linux, macOS, Git Bash). Ответы — настоящие ответы сервера для клиники-примера «Шифо».', 'Buyruqlar — bash uchun (Linux, macOS, Git Bash). Javoblar — «Shifo» namunaviy klinikasi uchun serverning haqiqiy javoblari.', 'Commands are for bash (Linux, macOS, Git Bash). Responses are the server’s real answers for the sample clinic “Shifo”.')],
    ] },
  ] },
  { id: 'access', title: L('Ключ, права и лимиты', 'Kalit, huquqlar va chegaralar', 'Key, scopes and limits'), blocks: [
    { p: L('Клиника выбирает, какие разделы открыть каждому подключению. Запрос к закрытому разделу — `403 forbidden_scope`, в поле `scope` — нужное право. Справочники открыты любому ключу, файлы снимка — без ключа.', 'Klinika har bir ulanishga qaysi bo‘limlarni ochishni tanlaydi. Yopiq bo‘limga so‘rov — `403 forbidden_scope`, `scope` maydonida — kerakli huquq. Ma’lumotnomalar istalgan kalitga ochiq, surat fayllari — kalitsiz.', 'The clinic chooses which sections each connection may use. A request to a closed section gets `403 forbidden_scope` with the needed scope in `scope`. Reference lists are open to any key, snapshot files need no key.') },
    { table: 'scopes' },
    { p: L('Ключ проверяется в каждом запросе:', 'Kalit har bir so‘rovda tekshiriladi:', 'The key is checked on every request:') },
    { list: [
      L('нет ключа или он неверный — `401 invalid_key`; с одного IP — не больше {{authFailPerMin}} неверных ключей в минуту;', 'kalit yo‘q yoki noto‘g‘ri — `401 invalid_key`; bitta IP dan daqiqasiga {{authFailPerMin}} tadan ortiq noto‘g‘ri kalit bo‘lmaydi;', 'no key or a wrong key — `401 invalid_key`; at most {{authFailPerMin}} wrong keys a minute from one IP;'),
      L('клиника выключила подключение — `401 key_disabled`; срок ключа вышел — `401 key_expired` (срок ставит клиника: без срока или {{keyTtlMonths|or}} месяцев);', 'klinika ulanishni o‘chirdi — `401 key_disabled`; kalit muddati tugadi — `401 key_expired` (muddatni klinika qo‘yadi: muddatsiz yoki {{keyTtlMonths|or}} oy);', 'the clinic switched the connection off — `401 key_disabled`; the key expired — `401 key_expired` (the clinic sets the term: none or {{keyTtlMonths|or}} months);'),
      L('у подключения заданы «Разрешённые IP» — запрос с другого адреса получает `403 ip_not_allowed`;', 'ulanishda «Ruxsat etilgan IP-manzillar» berilgan — boshqa manzildan so‘rov `403 ip_not_allowed` oladi;', 'the connection has “Allowed IP addresses” — a request from another address gets `403 ip_not_allowed`;'),
      L('запрос из браузера с сайта, которого нет в подключении (заголовок `Origin`), — `403 origin_not_allowed`.', 'ulanishda yo‘q saytdan brauzer so‘rovi (`Origin` sarlavhasi) — `403 origin_not_allowed`.', 'a browser request from a site not in the connection (the `Origin` header) — `403 origin_not_allowed`.'),
    ] },
    { p: L('Ключ в коде страницы видят все посетители сайта. Держите ключ на своём сервере; если запросы идут из браузера, попросите клинику дать такому подключению только чтение.', 'Sahifa kodidagi kalitni saytning barcha tashrif buyuruvchilari ko‘radi. Kalitni o‘z serveringizda saqlang; so‘rovlar brauzerdan ketsa, klinikadan bunday ulanishga faqat o‘qish huquqini berishni so‘rang.', 'Every visitor of a site can see a key in the page code. Keep the key on your server; if requests come from a browser, ask the clinic to give that connection read-only scopes.') },
    { p: L('Из браузера: предварительный запрос `OPTIONS` разрешает методы `GET, POST, DELETE` и заголовки `Authorization, Content-Type` и запоминается на {{corsMaxAgeMin:min}}; заголовок `Retry-After` скрипту виден.', 'Brauzerdan: `OPTIONS` dastlabki so‘rovi `GET, POST, DELETE` usullari va `Authorization, Content-Type` sarlavhalariga ruxsat beradi va {{corsMaxAgeMin:min}} eslab qolinadi; `Retry-After` sarlavhasi skriptga ko‘rinadi.', 'From a browser: the `OPTIONS` preflight allows the `GET, POST, DELETE` methods and the `Authorization, Content-Type` headers and is cached for {{corsMaxAgeMin:min}}; the script can read `Retry-After`.') },
    { table: 'limits' },
    { p: L('Сверх лимита — `429 rate_limited` и заголовок `Retry-After`: через сколько секунд повторить. Окно скользящее — последние 60 секунд.', 'Chegaradan oshsa — `429 rate_limited` va `Retry-After` sarlavhasi: necha soniyadan keyin takrorlash. Oyna siljuvchi — oxirgi 60 soniya.', 'Over the limit — `429 rate_limited` with a `Retry-After` header: how many seconds to wait. The window slides over the last 60 seconds.') },
  ] },
  { id: 'refs', title: L('Справочники', 'Ma’lumotnomalar', 'Reference lists'), blocks: [
    { p: L('Город, район и специальность приходят кодами. Коды и названия на трёх языках общие для всех клиник Easy-Med, код не меняется никогда. Загружайте справочники раз в сутки и храните у себя.', 'Shahar, tuman va mutaxassislik kodlar bilan keladi. Kodlar va uch tildagi nomlar barcha Easy-Med klinikalari uchun umumiy, kod hech qachon o‘zgarmaydi. Ma’lumotnomalarni sutkada bir marta yuklab, o‘zingizda saqlang.', 'City, district and specialty come as codes. The codes and their names in three languages are shared by all Easy-Med clinics; a code never changes. Load the lists once a day and keep them on your side.') },
    { endpoint: 'geo' }, { endpoint: 'specialties' },
  ] },
  { id: 'clinic', title: L('Клиника и филиалы', 'Klinika va filiallar', 'Clinic and branches'), blocks: [
    { endpoint: 'clinic' }, { endpoint: 'branches' }, { endpoint: 'media' },
  ] },
  { id: 'doctors', title: L('Врачи и свободное время', 'Shifokorlar va bo‘sh vaqt', 'Doctors and free time'), blocks: [
    { endpoint: 'doctors' }, { endpoint: 'slots' },
  ] },
  { id: 'services', title: L('Услуги и пакеты', 'Xizmatlar va paketlar', 'Services and packages'), blocks: [
    { endpoint: 'services' }, { endpoint: 'packages' },
  ] },
  { id: 'booking', title: L('Заявки и онлайн-запись', 'Arizalar va onlayn yozilish', 'Requests and online booking'), blocks: [
    { p: L('Всё, что присылает подключение, попадает в CRM клиники с источником этого подключения. Имя, телефон и комментарий пациента уходят только в клинику — зашифрованными её ключом; обратно приходят номер заявки `request_id` и её статус.', 'Ulanish yuborgan hamma narsa klinika CRM iga shu ulanish manbai bilan tushadi. Bemor ismi, telefoni va izohi faqat klinikaga — uning kaliti bilan shifrlangan holda boradi; orqaga ariza raqami `request_id` va uning holati qaytadi.', 'Everything a connection sends lands in the clinic CRM with that connection as the source. The patient’s name, phone and comment go only to the clinic — encrypted with its key; what comes back is the request number `request_id` and its status.') },
    { list: [
      L('`external_id` — ваш номер. Повтор с тем же `external_id` с того же ключа возвращает ту же заявку (`200`): при обрыве связи повторять безопасно.', '`external_id` — sizdagi raqam. Shu kalitdan shu `external_id` bilan takrorlash o‘sha arizani qaytaradi (`200`): aloqa uzilsa, takrorlash xavfsiz.', '`external_id` is your number. Repeating with the same `external_id` from the same key returns the same request (`200`): retrying after a dropped connection is safe.'),
      L('Заявки принимаются и тогда, когда клиника не на связи: заявка ждёт её {{uncollectedHours:hour}}.', 'Klinika aloqada bo‘lmaganda ham arizalar qabul qilinadi: ariza uni {{uncollectedHours:hour}} kutadi.', 'Requests are accepted even while the clinic is offline: a request waits for it for up to {{uncollectedHours:hour}}.'),
      L('Клиника не ответит — сервер закроет заявку сам (`closed`) без уведомления: подписать его может только клиника. Пока статус не итоговый, спрашивайте [статус](#ep-request-status) раз в несколько минут.', 'Klinika javob bermasa — server arizani o‘zi yopadi (`closed`), bildirishnomasiz: uni faqat klinika imzolay oladi. Holat yakuniy bo‘lmaguncha [holatni](#ep-request-status) bir necha daqiqada bir so‘rang.', 'If the clinic does not answer, the server closes the request itself (`closed`) without a notification: only the clinic can sign one. Until the status is final, ask for the [status](#ep-request-status) every few minutes.'),
    ] },
    { endpoint: 'requests-create' }, { endpoint: 'appointments-create' }, { endpoint: 'request-status' },
    { p: L('Клиника может предложить другое время: статус `offered`, ответ ждёт {{offerMin:min}} — до `offer_until`. Пришлите в теле `offered_start` — время, на которое отвечаете: если клиника успела предложить другое, ответ `409 offer_changed`. Согласие после `offer_until` — `409 offer_expired`.', 'Klinika boshqa vaqt taklif qilishi mumkin: holat `offered`, javob {{offerMin:min}} — `offer_until` gacha kutiladi. Tanada `offered_start` ni — javob berayotgan vaqtni yuboring: klinika boshqasini taklif qilib ulgurgan bo‘lsa, javob `409 offer_changed`. `offer_until` dan keyingi rozilik — `409 offer_expired`.', 'The clinic may offer another time: status `offered`, waiting {{offerMin:min}} for an answer — until `offer_until`. Send `offered_start` in the body — the time you are answering: if the clinic has offered another one meanwhile, the response is `409 offer_changed`. Accepting after `offer_until` gives `409 offer_expired`.') },
    { endpoint: 'offer-accept' }, { endpoint: 'offer-decline' }, { endpoint: 'appointments-cancel' },
  ] },
  { id: 'statuses', title: L('Статусы заявки', 'Ariza holatlari', 'Request statuses'), blocks: [
    { list: [
      L('«Перезвоните»: `new` → `accepted` → `booked` (записали на визит) → `cancelled` или `arrived`.', '«Qayta qo‘ng‘iroq»: `new` → `accepted` → `booked` (tashrifga yozildi) → `cancelled` yoki `arrived`.', 'Callback: `new` → `accepted` → `booked` (a visit was booked) → `cancelled` or `arrived`.'),
      L('Онлайн-запись: `pending` → `booked`, `offered`, `declined` или `expired`; `offered` → `pending` (согласие) или `cancelled`; `booked` → `cancelled` или `arrived`.', 'Onlayn yozilish: `pending` → `booked`, `offered`, `declined` yoki `expired`; `offered` → `pending` (rozilik) yoki `cancelled`; `booked` → `cancelled` yoki `arrived`.', 'Online booking: `pending` → `booked`, `offered`, `declined` or `expired`; `offered` → `pending` (accepted) or `cancelled`; `booked` → `cancelled` or `arrived`.'),
      L('Без ответа клиники: `new` или `pending` → `closed`.', 'Klinika javobisiz: `new` yoki `pending` → `closed`.', 'Without an answer from the clinic: `new` or `pending` → `closed`.'),
    ] },
    { table: 'statuses' },
    { table: 'reasons' },
  ] },
  { id: 'hooks', title: L('Уведомления', 'Bildirishnomalar', 'Notifications'), blocks: [
    { p: L('Если у подключения есть адрес для уведомлений, Easy-Med присылает на него `POST` при каждом событии, которое выбрала клиника. Адрес — только https и доменное имя в интернете.', 'Ulanishda bildirishnomalar manzili bo‘lsa, Easy-Med unga klinika tanlagan har bir hodisada `POST` yuboradi. Manzil — faqat https va internetdagi domen nomi.', 'If the connection has a notification address, Easy-Med sends it a `POST` on every event the clinic selected. The address must be https with a public domain name.') },
    { webhook: true },
    { p: L('Тело — JSON в одну строку; общие поля: `event_id`, `event`, `request_id`, `external_id`, `status`, `occurred_at` (UTC). Данных пациента в уведомлениях нет.', 'Tana — bir qatorli JSON; umumiy maydonlar: `event_id`, `event`, `request_id`, `external_id`, `status`, `occurred_at` (UTC). Bildirishnomalarda bemor ma’lumotlari yo‘q.', 'The body is single-line JSON; the common fields are `event_id`, `event`, `request_id`, `external_id`, `status`, `occurred_at` (UTC). Notifications carry no patient data.') },
    { table: 'events' },
    { p: L('Подпись: `X-EasyMed-Signature: sha256=<hex>` — HMAC-SHA256 тела секретом подключения (`{{secretPrefix}}…`, его даёт клиника). Подписывает клиника — сервер Easy-Med подделать уведомление не может. Проверяйте подпись по телу байт в байт, до разбора JSON:', 'Imzo: `X-EasyMed-Signature: sha256=<hex>` — tananing ulanish siri (`{{secretPrefix}}…`, uni klinika beradi) bilan HMAC-SHA256. Klinika imzolaydi — Easy-Med serveri bildirishnomani soxtalashtira olmaydi. Imzoni JSON ni o‘qishdan oldin, tanaga baytma-bayt tekshiring:', 'Signature: `X-EasyMed-Signature: sha256=<hex>` — HMAC-SHA256 of the body with the connection secret (`{{secretPrefix}}…`, from the clinic). The clinic signs — the Easy-Med server cannot forge a notification. Check the signature against the raw body byte for byte, before parsing JSON:') },
    { verify: 'node' }, { verify: 'php' },
    { list: [
      L('Ответьте любым `2xx` за {{webhookTimeoutSec:sec}}. Тело ответа не читается, перенаправления не выполняются.', '{{webhookTimeoutSec:sec}} ichida istalgan `2xx` bilan javob bering. Javob tanasi o‘qilmaydi, yo‘naltirishlar bajarilmaydi.', 'Answer with any `2xx` within {{webhookTimeoutSec:sec}}. The response body is ignored; redirects are not followed.'),
      L('Нет ответа или не `2xx` — повторы через {{retryMinutes}} минут: всего {{attempts:attempt}}, не дольше {{windowMin:min}} от события. Адрес, который {{hostTripAfter:time}} подряд не принимает соединение, отдыхает от {{hostRestFirstSec}} до {{hostRestMaxSec:sec}}: уведомления к нему ждут, попытки не тратятся.', 'Javob bo‘lmasa yoki `2xx` bo‘lmasa — {{retryMinutes}} daqiqadan keyin takrorlanadi: jami {{attempts:attempt}}, hodisadan {{windowMin:min}}dan oshmaydi. Ketma-ket {{hostTripAfter:time}} ulanishni qabul qilmagan manzil {{hostRestFirstSec}} dan {{hostRestMaxSec:sec}}gacha dam oladi: unga bildirishnomalar kutadi, urinishlar sarflanmaydi.', 'No answer or not `2xx` — retries after {{retryMinutes}} minutes: {{attempts:attempt}} in all, no later than {{windowMin:min}} after the event. An address that refuses the connection {{hostTripAfter:time}} in a row rests for {{hostRestFirstSec}} to {{hostRestMaxSec:sec}}: its notifications wait and no attempts are spent.'),
      L('Уведомления могут прийти не по порядку и дважды: узнавайте событие по `event_id`, а точный статус — в [статусе заявки](#ep-request-status).', 'Bildirishnomalar tartibsiz va ikki marta kelishi mumkin: hodisani `event_id` bo‘yicha taniy oling, aniq holatni esa [ariza holatida](#ep-request-status) ko‘ring.', 'Notifications may arrive out of order or twice: recognise an event by `event_id` and read the exact status from the [request status](#ep-request-status).'),
      L('Уведомления нет, когда заявку закрывает сервер (`closed`), и о «другом времени», на которое вы уже не можете ответить (вы отменили или отказались).', 'Server arizani yopganda (`closed`) va siz endi javob bera olmaydigan «boshqa vaqt» haqida (siz bekor qildingiz yoki rad etdingiz) bildirishnoma bo‘lmaydi.', 'There is no notification when the server closes a request (`closed`), nor about “another time” you can no longer answer (you cancelled or declined).'),
    ] },
  ] },
  { id: 'errors', title: L('Ошибки', 'Xatolar', 'Errors'), blocks: [
    { p: L('Ошибка — HTTP-код и тело `{"error": {"code", "message", …}}`; текст `message` — на языке `?lang`. Поля сверх кода: `field` и `reason` — какое поле и что с ним, `scope` — нужное право, `phone` — телефон клиники.', 'Xato — HTTP kodi va `{"error": {"code", "message", …}}` tanasi; `message` matni — `?lang` tilida. Koddan tashqari maydonlar: `field` va `reason` — qaysi maydon va unda nima bor, `scope` — kerakli huquq, `phone` — klinika telefoni.', 'An error is an HTTP code and a body `{"error": {"code", "message", …}}`; the `message` text follows `?lang`. Fields beyond the code: `field` and `reason` — which field and what is wrong, `scope` — the scope needed, `phone` — the clinic phone.') },
    { example: 'error-field' }, { example: 'error-key' },
    { table: 'errors' },
    { table: 'fields' },
  ] },
]);
