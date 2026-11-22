// ICONS_LUCIDE_V1 — какое имя из кода какой файл набора рисует.
//
// Единственное место, где живёт это решение. Слева — имя, которым код зовёт
// иконку (Icon('Clock')), справа — имя файла в public/assets/icons/lucide/ БЕЗ
// расширения. Имена справа — авторские имена Lucide (lucide.dev/icons): так
// файл можно сверить с сайтом набора глазами, не разбирая код.
//
// 2026-11-22, владелец: «use more professional icons everywhere, change all the
// icons, use more medical icons, minimalistic, not like ai generated». Весь
// интерфейс переведён с coolicons (+ своих дорисовок) на ОДИН набор — Lucide:
// одна сетка, одна толщина, одна рука. Где у смысла есть медицинский значок,
// взят он: «Стационар» — койка, «Лаборатория» — колба, «Пульс» — сердце с
// кардиограммой, «Здание» клиники — больница с крестом.
//
// Почему таблица, а не «имя = имя файла»: код зовёт иконки по смыслу
// («Patients», «Wallet»), набор называет их по рисунку («users», «wallet»).
// Таблица разделяет эти два словаря, и смена рисунка — правка одной строки
// здесь плюс `node scripts/build-icon-paths.mjs`.
//
// НЕТ ТОЧНОГО АНАЛОГА — помечено «~» (и перечислено в NO_EXACT_MATCH ниже):
// там решение принято за владельца, и он вправе его отменить.

export const ICON_MAP = Object.freeze({
    // --- навигация и стрелки ---
    ArrowDown:    'arrow-down',
    ArrowRight:   'arrow-right',
    ArrowUp:      'arrow-up',
    ChevronDown:  'chevron-down',
    ChevronLeft:  'chevron-left',
    ChevronRight: 'chevron-right',
    Refresh:      'refresh-cw',
    Repeat:       'repeat',

    // --- время ---
    Calendar:     'calendar',
    Clock:        'clock',

    // --- связь ---
    // Входящий, исходящий и пропущенный звонок — одна трубка со своей стрелкой:
    //   строка журнала звонков читается формой (см. telephony-logic.js).
    Bell:         'bell',
    Mail:         'mail',
    Msg:          'message-square',
    Send:         'send',
    Phone:        'phone',
    PhoneIn:      'phone-incoming',
    PhoneOut:     'phone-outgoing',
    PhoneMissed:  'phone-missed',
    PhoneOff:     'phone-off',     // SOFTPHONE_V1 — «Отклонить» и «Завершить»
    Megaphone:    'megaphone',

    // --- правка ---
    Copy:         'copy',
    Edit:         'pencil',
    Bold:         'bold',          // CASE_DOC_FORMAT_V1 — оформление текста в документе
    Italic:       'italic',
    Underline:    'underline',
    ListBullet:   'list',
    ListNumber:   'list-ordered',
    TextPlain:    'type',
    Format:       'case-sensitive',
    Layers:       'layers',
    Minus:        'minus',
    Move:         'move',
    Paperclip:    'paperclip',
    Plus:         'plus',
    Ruler:        'ruler',

    // --- медицина ---
    Stethoscope:  'stethoscope',
    Pulse:        'heart-pulse',   // кардиограмма; графики активности — Activity
    Heart:        'heart',
    Pill:         'pill',
    Flask:        'flask-conical',
    Bed:          'bed',
    Thermo:       'thermometer',
    Drop:         'droplet',
    Droplet:      'droplet',
    // ~ Лёгких в наборе нет: дыхание — «ветер» (иконка в коде есть, ни один экран её не зовёт).
    Lungs:        'wind',

    Building:     'hospital',      // здание клиники, филиал, подключение клиники

    // --- файлы ---
    Doc:          'file-text',
    Folder:       'folder',
    NotePencil:   'notebook-pen',

    // --- интерфейс ---
    Link:         'link',
    Chart:        'chart-column',
    Check:        'check',
    Download:     'download',
    Filter:       'funnel',
    Lock:         'lock',
    Receipt:      'receipt-text',   // без знака доллара: клиника считает в сумах
    Search:       'search',
    Settings:     'settings',
    Trash:        'trash-2',
    Trend:        'trending-up',
    Wallet:       'wallet',
    ZoomIn:       'zoom-in',
    Coins:        'coins',
    Key:          'key',
    Target:       'target',
    Activity:     'activity',
    // ~ «Искры» — знак ИИ, а владелец просил «not like ai generated»: «Что нового» и автоматизации получают звезду.
    Sparkles:     'star',

    Contrast:     'contrast',

    // --- медиа ---
    Headset:      'headset',
    Mic:          'mic',           // SOFTPHONE_V1 — «Микрофон вкл.» / «выкл.»
    MicOff:       'mic-off',
    Image:        'image',
    Pause:        'pause',
    Stop:         'square',

    // --- меню ---
    Dot3:         'ellipsis',
    Grid:         'layout-grid',
    X:            'x',

    // --- карта и места ---
    Flag:         'flag',
    Globe:        'globe',
    MapPin:       'map-pin',

    // --- система ---
    Shield:       'shield',
    Camera:       'camera',
    Dashboard:    'layout-dashboard',
    Database:     'database',
    Print:        'printer',
    Scan:         'qr-code',
    Bot:          'bot',
    Rocket:       'rocket',        // шапка «Настройка клиники» (setup-checklist.js)

    // --- люди ---
    ID:           'id-card',
    Patients:     'users',
    User:         'user',

    // --- меню слева (ICONS_HEALTH_V1, 2026-11-22) ---
    // Свои имена у пунктов меню, чтобы смена рисунка раздела не меняла ту же
    // иконку внутри экранов (Pulse — и «Процедуры» в меню, и кардиограмма на
    // экране). Медицинские разделы — Healthicons (папка в имени), общие — Lucide.
    NavPatients:    'healthicons/male-and_female',
    NavDoctor:      'healthicons/doctor',
    NavLab:         'healthicons/microscope',
    NavProcedures:  'healthicons/syringe',
    NavInpatient:   'healthicons/hospitalized',
    NavMedicines:   'healthicons/medicines',
    NavPatientDocs: 'healthicons/i-documents_accepted',
    NavQueue:       'ticket',
    NavKitchen:     'utensils',
    NavDischarge:   'door-open',
    NavCashier:     'banknote',
    NavCashHead:    'landmark',
    NavInventory:   'warehouse',
    NavMyStock:     'package-open',
    NavDepartment:  'building-2',
    NavDashboard:   'gauge',
    NavReports:     'chart-pie',

    // --- предупреждения ---
    // Info — запасное имя центра уведомлений: notifications.js рисует
    //   Icon(n.icon || 'Info') для любого уведомления без своей иконки.
    Help:         'circle-help',
    Warning:      'triangle-alert',
    Info:         'info',
});

/**
 * Имена, для которых в наборе нет точного аналога — те самые «~» выше, списком,
 * который можно прочитать в тесте и показать владельцу.
 *
 * Это не «сломано»: каждая из них рисуется и выглядит осмысленно. Это список
 * мест, где решение принято за владельца и он вправе его отменить.
 */
export const NO_EXACT_MATCH = Object.freeze([
    'Lungs', 'Sparkles',
]);
