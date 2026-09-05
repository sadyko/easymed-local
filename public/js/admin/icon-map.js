// COOLICONS_V1 — какое имя из кода какой файл набора рисует.
//
// Единственное место, где живёт это решение. Слева — имя, которым код зовёт
// иконку (Icon('Clock')), справа — путь внутри public/assets/icons/ БЕЗ
// расширения. Имена справа авторские и не переименовываются: так файл можно
// сверить с сайтом набора глазами, не разбирая код.
//
// ДВА НАБОРА. Путь ищется сначала в easymed/ (нарисовано здесь, ORIGIN.md),
// потом в coolicons/ (вендоренный набор, CC BY 4.0). Строки ниже с папкой
// Medical/ и имена Phone_In, Phone_Out, Phone_Missed, Megaphone, Coins, Key,
// Target, Bot — свои: в coolicons таких файлов нет вовсе, так что «сначала
// easymed» здесь не перехват, а единственное место, где рисунок есть.
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
// специальной. Клинические места, где приближение было прямой ошибкой формы
// (таблетка-чемоданчик, койка-стол, стетоскоп-крест, колба-цилиндр,
// пульс-график, три одинаковых звонка), теперь нарисованы и живут в easymed/;
// пометка «~» осталась только там, где приближение всё ещё приближение, чтобы
// владелец мог посмотреть на экран и сказать «нет, вот это другое».

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
    // Своя трубка с меткой направления в свободном верхнем углу: стрелка внутрь,
    //   стрелка наружу, крестик. Строка журнала звонков читается формой, а не
    //   подписью рядом (см. telephony-logic.js).
    PhoneIn:      'Communication/Phone_In',
    PhoneOut:     'Communication/Phone_Out',
    PhoneMissed:  'Communication/Phone_Missed',
    Megaphone:    'Communication/Megaphone',

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
    Coins:        'Interface/Coins',
    Key:          'Interface/Key',
    Target:       'Interface/Target',
    // Activity — это графики активности и журналы движений (см. вызовы), линейный
    //   график им точен; кардиограмма живёт отдельно, под именем Pulse.
    Activity:     'Interface/Chart_Line',
    // ~ Искр/«магии» нет. «Что нового» и автоматизации получают звезду.
    Sparkles:     'Interface/Star',
    // ~ Градусника нет (иконка в коде есть, ни один экран её не зовёт).
    Thermo:       'Interface/Slider_02',

    // --- медицина (свой рисунок, public/assets/icons/easymed/) ---
    Bed:          'Medical/Bed',
    Flask:        'Medical/Flask',
    Pill:         'Medical/Pill',
    Pulse:        'Medical/Pulse',
    Stethoscope:  'Medical/Stethoscope',

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
    Bot:          'System/Bot',
    // Ракеты в наборе нет вовсе, а зовут её с ПЕРВОГО экрана новой клиники —
    //   шапка карточки «Настройка клиники» (setup-checklist.js). Пока имени не
    //   было в этой таблице, там рисовался перечёркнутый круг «иконка не
    //   найдена»: первое, что видела клиника, выглядело как ошибка. Нарисована
    //   здесь, см. easymed/System/Rocket.svg.
    Rocket:       'System/Rocket',

    // --- люди ---
    ID:           'User/User_Card_ID',
    Patients:     'User/Users',
    User:         'User/User_01',
    // ~ Микрофона нет (иконка в коде есть, ни один экран её не зовёт).
    Mic:          'User/User_Voice',

    // --- предупреждения ---
    Help:         'Warning/Circle_Help',
    Warning:      'Warning/Triangle_Warning',
    // Info — запасное имя центра уведомлений: notifications.js рисует
    //   Icon(n.icon || 'Info'), то есть любое уведомление без своей иконки.
    //   Имени в таблице не было, поэтому «запасной» вариант был как раз тем
    //   единственным, который не рисовался.
    Info:         'Warning/Info',
});

/**
 * Имена, для которых в наборе нет точного аналога — те самые «~» выше, списком,
 * который можно прочитать в тесте и показать владельцу.
 *
 * Это не «сломано»: каждая из них рисуется и выглядит осмысленно. Это список
 * мест, где решение принято за владельца и он вправе его отменить.
 */
export const NO_EXACT_MATCH = Object.freeze([
    'Contrast', 'Lungs', 'Mic', 'Sparkles', 'Thermo',
]);
