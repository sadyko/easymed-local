// LIS_INGEST_V1 — Mindray BS-240, биохимия.
//
// Транспорт: TCP/IP, HL7 v2.3.1 ЛИБО ASTM E1394-97 («BS-230/BS-240 LIS
// Interface Manual»; в открытом доступе документа нет). Здесь заявлен только
// HL7 — ASTM станет вторым транспортом за тем же приёмом, когда понадобится.
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
  kind: 'chemistry',
  transports: ['mllp'],
  defaultPort: 2575,
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
