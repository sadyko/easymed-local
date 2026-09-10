// LIS_INGEST_V1 — Mindray BC-20, гематология, 3-diff.
//
// Основание: приложение C руководства оператора (analyzer-manuals/Mindray/) —
// «LAN Port supports HL7 protocol», двунаправленный LIS, плюс старый «15ID».
//
// САМИ КОДЫ КАНАЛОВ НЕ ПОДТВЕРЖДЕНЫ. Подробный протокол Mindray не публикует:
// приложение C состоит из одного абзаца и отсылки «contact Mindray Customer
// Service Department or your local distributor». Здесь стоят общепринятые
// мнемоники BC-серии. Расхождение НЕ ломает приём: незнакомый код попадает в
// лоток, и лаборант сопоставляет его один раз — ошибка в догадке стоит клика,
// а не переделки.
export default {
  key: 'mindray-bc-20',
  vendor: 'Mindray',
  model: 'BC-20',
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  channels: [
    { code: 'WBC',    name: 'Лейкоциты',                   unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM#',   name: 'Лимфоциты, абс.',             unit: '10^9/л',  type: 'numeric' },
    { code: 'MID#',   name: 'Средние клетки, абс.',        unit: '10^9/л',  type: 'numeric' },
    { code: 'GRA#',   name: 'Гранулоциты, абс.',           unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM%',   name: 'Лимфоциты, %',                unit: '%',       type: 'numeric' },
    { code: 'MID%',   name: 'Средние клетки, %',           unit: '%',       type: 'numeric' },
    { code: 'GRA%',   name: 'Гранулоциты, %',              unit: '%',       type: 'numeric' },
    { code: 'RBC',    name: 'Эритроциты',                  unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    name: 'Гемоглобин',                  unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',    name: 'Гематокрит',                  unit: '%',       type: 'numeric' },
    { code: 'MCV',    name: 'Средний объём эритроцита',    unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    name: 'Среднее содержание Hb',       unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',   name: 'Средняя концентрация Hb',     unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                      unit: '%',       type: 'numeric' },
    { code: 'PLT',    name: 'Тромбоциты',                  unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    name: 'Средний объём тромбоцита',    unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    name: 'PDW',                         unit: '',        type: 'numeric' },
    { code: 'PCT',    name: 'Тромбокрит',                  unit: '%',       type: 'numeric' },
  ],
};
