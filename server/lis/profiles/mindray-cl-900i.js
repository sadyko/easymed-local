// LIS_INGEST_V1 — Mindray CL-900i, иммунохемилюминесцентный анализатор.
//
// Транспорт документально НЕ подтверждён: заявлен HL7, как у остальной линейки
// Mindray. Если прибор окажется на ASTM — это второй транспорт за тем же
// приёмом, а не переделка профиля.
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
  kind: 'immunoassay',
  transports: ['mllp'],
  defaultPort: 2575,
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
