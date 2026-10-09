// LIS_INGEST_V1 — Mindray CL-900i, иммунохемилюминесцентный анализатор.
//
// LIS_VENDOR_EXACT_V1 — HL7 v2.3.1 по сети, провод 'mindray-chem': ПК прибора
// (BS800.exe — та же линейка программ, что у химии Mindray) говорит диалектом
// «Chemiluminescence Immunoassay Analyzer Host Interface Manual» (2013-08) —
// его же показывают журналы главы 12 сервисного руководства CL-900i/920i/
// 960i/980i (ПО 08.00):
//   — НОМЕР ПРОБИРКИ — OBR-2 (штрихкод, до 27 знаков, с. 1-14). OBR-3 — номер
//     пробы самого прибора (1, 2, 10…): прежний провод default читал его, и
//     голое «10» ложилось в открытый свежий заказ № 10 чужого пациента;
//   — код — OBX-3, «Routine Channel No.», который вводят на приборе: «This field
//     is used to match tests»; OBX-4 — полное имя теста (подпись);
//   — OBX-8 у CL всегда «N» («Fixed as N»), качественный ответ — в OBX-9
//     («Negative-, Positive+, weak positive+-»; wire.js, ingest.js);
//   — MSH-16: 0 — проба, 1 — калибровка, 2 — контроль (с. 1-26): контроль и
//     калибровка идут мимо бланков и лотка (wire.js readEnvelope);
//   — по одному сообщению на пробу со всеми тестами (с. 1-25) — не
//     oneTestPerMessage;
//   — MSH-3/4 пусты во всех примерах и журналах: модель выбирает человек в
//     «Добавить»; псевдонимы — на случай, если прибор назовёт себя (семейство
//     одного сервисного руководства, «CL-900» — так его ждёт jawda-medical,
//     CL-1000i — тот же экран LIS и тот же диалект в полевой записи).
// ASTM у прибора тоже есть, но приёма ASTM по сети в Easy-Med нет: на приборе
// выбирается HL7.
//
// КАНАЛЫ — ТИПОВОЙ НАБОР, НЕ ИЗ ДОКУМЕНТАЦИИ. Набор тестов иммуноанализатора
// определяется закупленными наборами реагентов, поэтому поначалу список был
// пуст; владелец попросил его заполнить (2026-09-11). Каждую строку панели
// лаборант подтверждает руками (D3/D4), так что список ничего не сопоставляет
// сам — он лишь избавляет от набора кодов.
//
// Коды — общепринятые короткие имена тестов. Прибор клиники может писать иначе
// (β-HCG как «HCG» или «bHCG», Anti-TPO как «TPOAb»): тогда код придёт в лоток
// под своим именем, и лаборант сопоставит его один раз.
export default {
  key: 'mindray-cl-900i',
  vendor: 'Mindray',
  model: 'CL-900i',
  // LIS_VENDOR_EXACT_V1 — как прибор может назвать себя (обычно не называет).
  aliases: ['CL-900i', 'CL900i', 'CL-900', 'CL900', 'CL-920i', 'CL-960i', 'CL-980i', 'CL-1000i'],
  kind: 'immunoassay',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',            // LIS_VENDOR_EXACT_V1 — ПК прибора — клиент, звонит в Easy-Med:2575
  wire: 'mindray-chem',         // LIS_VENDOR_EXACT_V1 — номер пробирки OBR-2, OBR-3 не читается никогда
  wireSource: 'documented',     // LIS_VENDOR_EXACT_V1 — Host Interface Manual CL + сервисное руководство, гл. 12
  channelsSource: 'conventional',
  channels: [
    // Щитовидная железа
    { code: 'TSH',      name: 'ТТГ',                          unit: 'мкМЕ/мл', type: 'numeric' },
    { code: 'FT3',      name: 'Т3 свободный',                 unit: 'пмоль/л', type: 'numeric' },
    { code: 'FT4',      name: 'Т4 свободный',                 unit: 'пмоль/л', type: 'numeric' },
    { code: 'T3',       name: 'Т3 общий',                     unit: 'нмоль/л', type: 'numeric' },
    { code: 'T4',       name: 'Т4 общий',                     unit: 'нмоль/л', type: 'numeric' },
    { code: 'Anti-TPO', name: 'Антитела к тиреопероксидазе',  unit: 'МЕ/мл',   type: 'numeric' },
    { code: 'Anti-TG',  name: 'Антитела к тиреоглобулину',    unit: 'МЕ/мл',   type: 'numeric' },
    // Репродуктивные гормоны
    { code: 'FSH',      name: 'ФСГ',                          unit: 'мМЕ/мл',  type: 'numeric' },
    { code: 'LH',       name: 'ЛГ',                           unit: 'мМЕ/мл',  type: 'numeric' },
    { code: 'PRL',      name: 'Пролактин',                    unit: 'мМЕ/л',   type: 'numeric' },
    { code: 'E2',       name: 'Эстрадиол',                    unit: 'пмоль/л', type: 'numeric' },
    { code: 'PROG',     name: 'Прогестерон',                  unit: 'нмоль/л', type: 'numeric' },
    { code: 'TESTO',    name: 'Тестостерон',                  unit: 'нмоль/л', type: 'numeric' },
    { code: 'HCG',      name: 'ХГЧ (β-субъединица)',          unit: 'мМЕ/мл',  type: 'numeric' },
    { code: 'AMH',      name: 'Антимюллеров гормон',          unit: 'нг/мл',   type: 'numeric' },
    // Онкомаркеры
    { code: 'AFP',      name: 'Альфа-фетопротеин',            unit: 'нг/мл',   type: 'numeric' },
    { code: 'CEA',      name: 'РЭА',                          unit: 'нг/мл',   type: 'numeric' },
    { code: 'CA125',    name: 'СА-125',                       unit: 'Ед/мл',   type: 'numeric' },
    { code: 'CA19-9',   name: 'СА 19-9',                      unit: 'Ед/мл',   type: 'numeric' },
    { code: 'CA15-3',   name: 'СА 15-3',                      unit: 'Ед/мл',   type: 'numeric' },
    { code: 'PSA',      name: 'ПСА общий',                    unit: 'нг/мл',   type: 'numeric' },
    { code: 'fPSA',     name: 'ПСА свободный',                unit: 'нг/мл',   type: 'numeric' },
    // Метаболизм, витамины, кардио, инфекции
    { code: 'FER',      name: 'Ферритин',                     unit: 'нг/мл',   type: 'numeric' },
    { code: 'B12',      name: 'Витамин B12',                  unit: 'пг/мл',   type: 'numeric' },
    { code: 'FOL',      name: 'Фолиевая кислота',             unit: 'нг/мл',   type: 'numeric' },
    { code: 'VD',       name: 'Витамин D (25-OH)',            unit: 'нг/мл',   type: 'numeric' },
    { code: 'INS',      name: 'Инсулин',                      unit: 'мкМЕ/мл', type: 'numeric' },
    { code: 'COR',      name: 'Кортизол',                     unit: 'нмоль/л', type: 'numeric' },
    { code: 'TnI',      name: 'Тропонин I',                   unit: 'нг/мл',   type: 'numeric' },
    { code: 'PCT',      name: 'Прокальцитонин',               unit: 'нг/мл',   type: 'numeric' },
    { code: 'HBsAg',    name: 'HBsAg (гепатит B)',            unit: 'S/CO',    type: 'numeric' },
    { code: 'HCV',      name: 'Anti-HCV (гепатит C)',         unit: 'S/CO',    type: 'numeric' },
    { code: 'HIV',      name: 'HIV Ag/Ab',                    unit: 'S/CO',    type: 'numeric' },
  ],
};
