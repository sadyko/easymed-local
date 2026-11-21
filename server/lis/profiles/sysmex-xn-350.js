// LIS_ASTM_FOUR_V1 — Sysmex XN-350 (семья XN-L), гематология, 5-diff.
//
// Прибор говорит ASTM (E1381/E1394), Easy-Med читает HL7 — его приносит
// переадресатор лаборатории (Desktop\new lis, src/astm/read.js, диалект
// sysmex-xn): номер пробы — компонент 3 поля O.4 («штатив^место^НОМЕР^режим»),
// код — компонент 5 поля R.3 («^^^^WBC^1»). В Easy-Med приходит HL7 с MSH-3
// «XN-350» и MSH-4 «LabPC»: провод forwarder (wire.js wireDecision — по MSH-4,
// что бы ни говорил профиль), номер — OBR-3, код — OBX-3.1 («WBC^^SYSMEX»).
// Переадресатор звонит Easy-Med на 2575 сам — connect 'listen'.
//
// Откуда формат ASTM: спецификация «XN-L series ASTM», инструкция XN-L,
// полевой драйвер Xn350BI_TCP.cs (wireSource 'documented'). Настоящей пробы с
// прибора ещё не видели.
//
// Каналы — имена параметров Sysmex XN, как прибор пишет их в R.3 и на экране
// (паспорт XN-350: NEUT#/%, LYMPH#/%, MONO#/%, EO#/%, BASO#/%, IG#/%, NRBC#/%):
// не имена Mindray («NEU#», «LYM%», «EOS#»). Список типовой (channelsSource
// 'conventional'): каждую строку лаборант подтверждает руками, а то, чего
// здесь нет (ретикулоциты и др.), появится в «Присылал этот анализатор» с
// первой пробы.
export default {
  key: 'sysmex-xn-350',
  vendor: 'Sysmex',
  model: 'XN-350',
  aliases: ['XN-350'],
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',
  wire: 'forwarder',
  wireSource: 'documented',
  channelsSource: 'conventional',
  channels: [
    { code: 'WBC',    name: 'Лейкоциты',                       unit: '10^9/л',  type: 'numeric' },
    { code: 'NEUT%',  name: 'Нейтрофилы, %',                   unit: '%',       type: 'numeric' },
    { code: 'LYMPH%', name: 'Лимфоциты, %',                    unit: '%',       type: 'numeric' },
    { code: 'MONO%',  name: 'Моноциты, %',                     unit: '%',       type: 'numeric' },
    { code: 'EO%',    name: 'Эозинофилы, %',                   unit: '%',       type: 'numeric' },
    { code: 'BASO%',  name: 'Базофилы, %',                     unit: '%',       type: 'numeric' },
    { code: 'IG%',    name: 'Незрелые гранулоциты, %',         unit: '%',       type: 'numeric' },
    { code: 'NEUT#',  name: 'Нейтрофилы, абс.',                unit: '10^9/л',  type: 'numeric' },
    { code: 'LYMPH#', name: 'Лимфоциты, абс.',                 unit: '10^9/л',  type: 'numeric' },
    { code: 'MONO#',  name: 'Моноциты, абс.',                  unit: '10^9/л',  type: 'numeric' },
    { code: 'EO#',    name: 'Эозинофилы, абс.',                unit: '10^9/л',  type: 'numeric' },
    { code: 'BASO#',  name: 'Базофилы, абс.',                  unit: '10^9/л',  type: 'numeric' },
    { code: 'IG#',    name: 'Незрелые гранулоциты, абс.',      unit: '10^9/л',  type: 'numeric' },
    { code: 'NRBC%',  name: 'Нормобласты, на 100 лейкоцитов',  unit: '/100 WBC', type: 'numeric' },
    { code: 'NRBC#',  name: 'Нормобласты, абс.',               unit: '10^9/л',  type: 'numeric' },
    { code: 'RBC',    name: 'Эритроциты',                      unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    name: 'Гемоглобин',                      unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',    name: 'Гематокрит',                      unit: '%',       type: 'numeric' },
    { code: 'MCV',    name: 'Средний объём эритроцита',        unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    name: 'Среднее содержание Hb',           unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',   name: 'Средняя концентрация Hb',         unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-SD', name: 'RDW-SD',                          unit: 'фл',      type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                          unit: '%',       type: 'numeric' },
    { code: 'PLT',    name: 'Тромбоциты',                      unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    name: 'Средний объём тромбоцита',        unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    name: 'PDW',                             unit: 'фл',      type: 'numeric' },
    { code: 'P-LCR',  name: 'Крупные тромбоциты (P-LCR)',      unit: '%',       type: 'numeric' },
    { code: 'PCT',    name: 'Тромбокрит',                      unit: '%',       type: 'numeric' },
  ],
};
