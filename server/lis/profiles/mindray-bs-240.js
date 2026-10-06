// LIS_INGEST_V1 — Mindray BS-240, биохимия.
//
// Транспорт: TCP/IP, HL7 v2.3.1 ЛИБО ASTM E1394-97. Здесь заявлен только
// HL7 — ASTM станет вторым транспортом за тем же приёмом, когда понадобится.
//
// LIS_VENDOR_EXACT_V1 — провод 'mindray-chem' по документу семейства:
// «LIS Interface Manual, Chemistry Analyzer» для BS-360E/BS-240Pro/BS-240E,
// V1.0 (2014), и две настоящие записи с тем же расположением полей — BS-240
// (2017) и BS-240E (2026):
//   — НОМЕР ПРОБИРКИ — OBR-2 («Placer Order Number, used as sample bar code»,
//     с. 16). OBR-3 — внутренний номер прибора 1, 2, 3…: «Sample ID is for
//     internal use and must not be analyzed by the server» (с. 32). Прежний
//     провод default читал OBR-3 — голое «1» ложилось в открытый свежий заказ
//     № 1 чужого пациента;
//   — код — OBX-3, Channel No., который лаборатория вводит на приборе («Glu-G»);
//     OBX-4 — имя теста, только подпись: «functions as a note and must not be
//     analyzed» (с. 33);
//   — MSH-16: 0 — проба, 1 — калибровка, 2 — контроль (с. 12): контроль и
//     калибровка идут мимо бланков и лотка (wire.js readEnvelope);
//   — по одному сообщению на пробу со всеми тестами (с. 9, 31) — не
//     oneTestPerMessage;
//   — MSH-3/4 у настоящих приборов пусты (запись 2017 и 2026): модель
//     выбирает человек в «Добавить»; псевдонимы — на случай, если прибор
//     всё же назовёт себя.
// codesPerInstrument НЕ ставится: на каждом BS-240 клиники вводятся одни и те
// же Channel No., и код у всех приборов модели один (при сверке с
// документами «BS-240 нужен codesPerInstrument» опровергнуто).
//
// КАНАЛЫ — ТИПОВОЙ НАБОР, НЕ ИЗ ДОКУМЕНТАЦИИ. Mindray протокол не публикует,
// а у биохимического анализатора набор тестов задаёт сама клиника закупкой
// реагентов. Поначалу список был пуст именно поэтому; владелец попросил его
// заполнить (2026-09-11): каждую строку панели лаборант всё равно подтверждает
// руками (D3/D4), так что длинный список ничего не сопоставляет сам — он лишь
// избавляет от набора кодов.
//
// Коды — те, что обычно стоят в меню тестов BS-серии. Если прибор клиники
// шлёт другой код (LDLC вместо LDL-C, CHO вместо CHOL), он попадёт в лоток
// под своим именем, и лаборант сопоставит его один раз. Расхождение — клик, а
// не переделка.
export default {
  key: 'mindray-bs-240',
  vendor: 'Mindray',
  model: 'BS-240',
  aliases: ['BS-240', 'BS-240E', 'BS-240Pro', 'BS-230'],   // LIS_VENDOR_EXACT_V1 — семейство одного руководства
  kind: 'chemistry',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',            // LIS_VENDOR_EXACT_V1 — ПК прибора звонит в Easy-Med:2575
  wire: 'mindray-chem',         // LIS_VENDOR_EXACT_V1 — номер пробирки OBR-2, OBR-3 не читается никогда
  wireSource: 'documented',     // LIS_VENDOR_EXACT_V1 — руководство BS-360E/BS-240Pro/BS-240E V1.0
  channelsSource: 'conventional',
  channels: [
    // Метаболиты
    { code: 'GLU',   name: 'Глюкоза',                    unit: 'ммоль/л',  type: 'numeric' },
    { code: 'UREA',  name: 'Мочевина',                   unit: 'ммоль/л',  type: 'numeric' },
    { code: 'CREA',  name: 'Креатинин',                  unit: 'мкмоль/л', type: 'numeric' },
    { code: 'UA',    name: 'Мочевая кислота',            unit: 'мкмоль/л', type: 'numeric' },
    { code: 'TBIL',  name: 'Билирубин общий',            unit: 'мкмоль/л', type: 'numeric' },
    { code: 'DBIL',  name: 'Билирубин прямой',           unit: 'мкмоль/л', type: 'numeric' },
    { code: 'TP',    name: 'Белок общий',                unit: 'г/л',      type: 'numeric' },
    { code: 'ALB',   name: 'Альбумин',                   unit: 'г/л',      type: 'numeric' },
    // Липиды
    { code: 'CHOL',  name: 'Холестерин общий',           unit: 'ммоль/л',  type: 'numeric' },
    { code: 'TG',    name: 'Триглицериды',               unit: 'ммоль/л',  type: 'numeric' },
    { code: 'HDL-C', name: 'Холестерин ЛПВП',            unit: 'ммоль/л',  type: 'numeric' },
    { code: 'LDL-C', name: 'Холестерин ЛПНП',            unit: 'ммоль/л',  type: 'numeric' },
    // Ферменты
    { code: 'ALT',   name: 'АЛТ',                        unit: 'Ед/л',     type: 'numeric' },
    { code: 'AST',   name: 'АСТ',                        unit: 'Ед/л',     type: 'numeric' },
    { code: 'ALP',   name: 'Щелочная фосфатаза',         unit: 'Ед/л',     type: 'numeric' },
    { code: 'GGT',   name: 'Гамма-ГТ',                   unit: 'Ед/л',     type: 'numeric' },
    { code: 'LDH',   name: 'ЛДГ',                        unit: 'Ед/л',     type: 'numeric' },
    { code: 'CK',    name: 'Креатинкиназа',              unit: 'Ед/л',     type: 'numeric' },
    { code: 'CK-MB', name: 'Креатинкиназа-МВ',           unit: 'Ед/л',     type: 'numeric' },
    { code: 'AMY',   name: 'Амилаза',                    unit: 'Ед/л',     type: 'numeric' },
    { code: 'LPS',   name: 'Липаза',                     unit: 'Ед/л',     type: 'numeric' },
    // Электролиты и минералы
    { code: 'CA',    name: 'Кальций общий',              unit: 'ммоль/л',  type: 'numeric' },
    { code: 'MG',    name: 'Магний',                     unit: 'ммоль/л',  type: 'numeric' },
    { code: 'PHOS',  name: 'Фосфор',                     unit: 'ммоль/л',  type: 'numeric' },
    { code: 'FE',    name: 'Железо',                     unit: 'мкмоль/л', type: 'numeric' },
    // Белки воспаления и прочее
    { code: 'CRP',   name: 'С-реактивный белок',         unit: 'мг/л',     type: 'numeric' },
    { code: 'RF',    name: 'Ревматоидный фактор',        unit: 'МЕ/мл',    type: 'numeric' },
    { code: 'ASO',   name: 'Антистрептолизин-О',         unit: 'МЕ/мл',    type: 'numeric' },
    { code: 'HbA1c', name: 'Гликированный гемоглобин',   unit: '%',        type: 'numeric' },
  ],
};
