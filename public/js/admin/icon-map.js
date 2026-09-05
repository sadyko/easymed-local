// COOLICONS_V1 — какое имя из кода какой файл набора рисует.
//
// Единственное место, где живёт это решение. Слева — имя, которым код зовёт
// иконку (Icon('Clock')), справа — путь внутри public/assets/icons/coolicons/
// БЕЗ расширения. Имена справа авторские и не переименовываются: так файл
// можно сверить с сайтом набора глазами, не разбирая код.
//
// Почему таблица, а не «имя = имя файла»: код зовёт иконки по смыслу («Касса»,
// «Стационар»), набор называет их по рисунку («Credit_Card_01», «Moving_Desk»).
// Переименовать 442 файла под наш словарь — значит потерять возможность найти
// иконку на coolicons.cool; звать их авторскими именами из 88 экранов — значит
// переписать все экраны. Таблица разделяет эти два словаря, и правка иконки
// становится правкой одной строки здесь.
//
// НЕТ ТОЧНОГО АНАЛОГА — помечено «~». coolicons это общий интерфейсный набор:
// в нём ровно одна медицинская иконка (Environment/First_Aid) и ни одной
// специальной — ни стетоскопа, ни колбы, ни койки, ни кардиограммы, ни
// таблетки. Для таких мест здесь стоит ближайшее по смыслу, и каждое такое
// место помечено, чтобы владелец мог посмотреть на экран и сказать «нет, вот
// это другое» — а не искать потом, откуда взялся чемоданчик в аптеке.

export const ICON_MAP = Object.freeze({
    // --- навигация и стрелки ---
    ArrowDown:    'Arrow/Arrow_Down_MD',
    ArrowRight:   'Arrow/Arrow_Right_MD',
    ArrowUp:      'Arrow/Arrow_Up_MD',
    ChevronDown:  'Arrow/Chevron_Down',
    ChevronLeft:  'Arrow/Chevron_Left',
    ChevronRight: 'Arrow/Chevron_Right',
    Refresh:      'Arrow/Arrows_Reload_01',
    Repeat:       'Arrow/Arrow_Reload_02',

    // --- время ---
    Calendar:     'Calendar/Calendar',
    Clock:        'Calendar/Clock',

    // --- связь ---
    Bell:         'Communication/Bell',
    Mail:         'Communication/Mail',
    Msg:          'Communication/Chat',
    Send:         'Communication/Paper_Plane',
    Phone:        'Communication/Phone',
    // ~ В наборе одна телефонная трубка и ни одной со стрелкой направления.
    //   Входящий / исходящий / пропущенный теперь рисуются одинаково; в таблице
    //   звонков направление по-прежнему подписано словом рядом (см.
    //   telephony-logic.js), но глазом три строки больше не различить.
    PhoneIn:      'Communication/Phone',
    PhoneOut:     'Communication/Phone',
    PhoneMissed:  'Communication/Phone',
    // ~ Мегафона нет. Рассылки и «Запросить публикацию» получают звонок-с-волнами.
    Megaphone:    'Communication/Bell_Ring',

    // --- правка ---
    Copy:         'Edit/Copy',
    Edit:         'Edit/Edit_Pencil_01',
    Layers:       'Edit/Layers',
    Minus:        'Edit/Remove_Minus',
    Move:         'Edit/Move',
    Paperclip:    'Edit/Paperclip_Attechment_Tilt',
    Plus:         'Edit/Add_Plus',
    Ruler:        'Edit/Ruler',

    // --- окружение ---
    Drop:         'Environment/Water_Drop',
    Droplet:      'Environment/Water_Drop',
    // ~ Стетоскопа нет. Приём врача получает единственную медицинскую иконку
    //   набора — медицинский крест.
    Stethoscope:  'Environment/First_Aid',
    // ~ Лёгких нет (иконка в коде есть, ни один экран её не зовёт).
    Lungs:        'Environment/Leaf',
    // ~ Полукруга «контраст» нет (иконка в коде есть, ни один экран её не зовёт).
    Contrast:     'Environment/Moon',

    // --- файлы ---
    Doc:          'File/File_Document',
    Folder:       'File/Folder',

    // --- интерфейс ---
    Chart:        'Interface/Chart_Bar_Vertical_01',
    Check:        'Interface/Check',
    Download:     'Interface/Download',
    Filter:       'Interface/Filter',
    Heart:        'Interface/Heart_01',
    Lock:         'Interface/Lock',
    Receipt:      'Interface/Ticket_Voucher',
    Search:       'Interface/Search_Magnifying_Glass',
    Settings:     'Interface/Settings',
    Trash:        'Interface/Trash_Empty',
    Trend:        'Interface/Trending_Up',
    Wallet:       'Interface/Credit_Card_01',
    ZoomIn:       'Interface/Magnifying_Glass_Plus',
    // ~ Кардиограммы нет. «Витальные» и графики активности получают линейный график.
    Activity:     'Interface/Chart_Line',
    Pulse:        'Interface/Chart_Line',
    // ~ Монет и наличных нет — деньги во всём наборе это карта.
    Coins:        'Interface/Credit_Card_02',
    // ~ Ключа нет. Экран токенов API получает открытый замок.
    Key:          'Interface/Lock_Open',
    // ~ Искр/«магии» нет. «Что нового» и автоматизации получают звезду.
    Sparkles:     'Interface/Star',
    // ~ Мишени нет. «Причины звонков» получают точку в кольце.
    Target:       'Interface/Radio_Fill',
    // ~ Таблетки нет. Лекарства получают чемоданчик-аптечку.
    Pill:         'Interface/Suitcase',
    // ~ Градусника нет (иконка в коде есть, ни один экран её не зовёт).
    Thermo:       'Interface/Slider_02',

    // --- медиа ---
    Headset:      'Media/Headphones',
    Image:        'Media/Image_01',
    Pause:        'Media/Pause',
    Stop:         'Media/Stop',

    // --- меню ---
    Dot3:         'Menu/More_Horizontal',
    Grid:         'Menu/More_Grid_Big',
    X:            'Menu/Close_MD',

    // --- карта и здания ---
    Building:     'Navigation/Building_01',
    Flag:         'Navigation/Flag',
    Globe:        'Navigation/Globe',
    MapPin:       'Navigation/Map_Pin',

    // --- формы ---
    Shield:       'Shape/Shield',   // LICENCE_CORE_V1 / SYSTEM_SETTINGS_V1 — карточка активации

    // --- система ---
    Camera:       'System/Camera',
    Dashboard:    'System/Window_Sidebar',
    Database:     'System/Data',     // SYSTEM_SETTINGS_V1 — карточка резервных копий
    Print:        'System/Printer',
    Scan:         'System/Qr_Code',  // кнопка «Штрих-код» в лаборатории
    // ~ Колбы и пробирки нет. Лаборатория получает сосуд-цилиндр.
    Flask:        'System/Cylinder',
    // ~ Койки нет. Стационар получает стол-каталку — плоскость на ножках.
    Bed:          'System/Moving_Desk',
    // ~ Робота нет. Телеграм-бот получает угловые скобки кода.
    Bot:          'System/Code',

    // --- люди ---
    ID:           'User/User_Card_ID',
    Patients:     'User/Users',
    User:         'User/User_01',
    // ~ Микрофона нет (иконка в коде есть, ни один экран её не зовёт).
    Mic:          'User/User_Voice',

    // --- предупреждения ---
    Help:         'Warning/Circle_Help',
    Warning:      'Warning/Triangle_Warning',
});

/**
 * Имена, для которых в наборе нет точного аналога — те самые «~» выше, списком,
 * который можно прочитать в тесте и показать владельцу.
 *
 * Это не «сломано»: каждая из них рисуется и выглядит осмысленно. Это список
 * мест, где решение принято за владельца и он вправе его отменить.
 */
export const NO_EXACT_MATCH = Object.freeze([
    'Activity', 'Bed', 'Bot', 'Coins', 'Contrast', 'Flask', 'Key', 'Lungs',
    'Megaphone', 'Mic', 'PhoneIn', 'PhoneMissed', 'PhoneOut', 'Pill', 'Pulse',
    'Sparkles', 'Stethoscope', 'Target', 'Thermo',
]);
