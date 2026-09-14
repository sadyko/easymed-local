// LIS_INGEST_V1 — Mindray BC-3000 Plus, гематология, 3-diff, ТОЛЬКО RS-232.
//
// Список каналов — ИЗ ДОКУМЕНТАЦИИ ЦЕЛИКОМ: приложение D руководства оператора,
// таблица D-2. Те же девятнадцать показателей и в том же порядке, что у BC-2800
// (отличается только заголовок записи — его разбирает переадресатор). Коды —
// ровно те, что analyzers/forwarder/protocols/mindray-legacy.js ставит в OBX-3.
//
// В сеть не умеет: результаты приходят через переадресатор с лабораторного ПК,
// заводится сам под именем «BC-3000 Plus» (MSH-3).
export default {
  key: 'mindray-bc-3000-plus',
  vendor: 'Mindray',
  model: 'BC-3000 Plus',
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
