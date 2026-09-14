// LIS_INGEST_V1 — Mindray BC-2800, гематология, 3-diff, ТОЛЬКО RS-232.
//
// ЕДИНСТВЕННЫЙ случай, где список каналов взят ИЗ ДОКУМЕНТАЦИИ ЦЕЛИКОМ:
// приложение A руководства оператора, таблица A-2 — порядок полей, ширина и
// единицы. Коды здесь — ровно те, что переадресатор с лабораторного ПК
// (analyzers/forwarder/protocols/mindray-legacy.js) ставит в OBX-3 при
// преобразовании записи «A» в HL7; расхождение между двумя списками означало
// бы, что документированный прибор не сопоставляется — поэтому они обязаны
// совпадать буква в букву.
//
// В сеть этот прибор не умеет: результаты приходят через переадресатор, и в
// Easy-Med он заводится сам под именем «BC-2800» (MSH-3).
export default {
  key: 'mindray-bc-2800',
  vendor: 'Mindray',
  model: 'BC-2800',
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  channelsSource: 'documented',
  channels: [
    { code: 'WBC',    name: 'Лейкоциты',                  unit: '10^9/л',  type: 'numeric' },
    { code: 'Lymph#', name: 'Лимфоциты, абс.',            unit: '10^9/л',  type: 'numeric' },
    { code: 'Mid#',   name: 'Средние клетки, абс.',       unit: '10^9/л',  type: 'numeric' },
    { code: 'Gran#',  name: 'Гранулоциты, абс.',          unit: '10^9/л',  type: 'numeric' },
    { code: 'Lymph%', name: 'Лимфоциты, %',               unit: '%',       type: 'numeric' },
    { code: 'Mid%',   name: 'Средние клетки, %',          unit: '%',       type: 'numeric' },
    { code: 'Gran%',  name: 'Гранулоциты, %',             unit: '%',       type: 'numeric' },
    { code: 'RBC',    name: 'Эритроциты',                 unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    name: 'Гемоглобин',                 unit: 'г/л',     type: 'numeric' },
    { code: 'MCHC',   name: 'Средняя концентрация Hb',    unit: 'г/л',     type: 'numeric' },
    { code: 'MCV',    name: 'Средний объём эритроцита',   unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    name: 'Среднее содержание Hb',      unit: 'пг',      type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                     unit: '%',       type: 'numeric' },
    { code: 'HCT',    name: 'Гематокрит',                 unit: '%',       type: 'numeric' },
    { code: 'PLT',    name: 'Тромбоциты',                 unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    name: 'Средний объём тромбоцита',   unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    name: 'PDW',                        unit: '',        type: 'numeric' },
    { code: 'PCT',    name: 'Тромбокрит',                 unit: '%',       type: 'numeric' },
    { code: 'RDW-SD', name: 'RDW-SD',                     unit: 'фл',      type: 'numeric' },
  ],
};
