// LIS_INGEST_V1 — Mindray BC-5300, гематология, 5-diff.
//
// Состав каналов снят со СКРИНШОТА ПО производителя (владелец, 2026-09-10):
// экран «Проб за сегодня», режим WB / CBC+DIFF. Порядок и написание — как на
// экране, слева направо и сверху вниз.
//
// ALY и LIC прибор помечает звёздочкой и подписью «только для исслед. целей,
// не для диагностики». Они здесь есть, потому что прибор их присылает; брать
// их в панель или нет — решение клиники, а не наше.
export default {
  key: 'mindray-bc-5300',
  vendor: 'Mindray',
  model: 'BC-5300',
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  channels: [
    { code: 'WBC',    name: 'Лейкоциты',                     unit: '10^9/л',  type: 'numeric' },
    { code: 'NEU%',   name: 'Нейтрофилы, %',                 unit: '%',       type: 'numeric' },
    { code: 'LYM%',   name: 'Лимфоциты, %',                  unit: '%',       type: 'numeric' },
    { code: 'MON%',   name: 'Моноциты, %',                   unit: '%',       type: 'numeric' },
    { code: 'EOS%',   name: 'Эозинофилы, %',                 unit: '%',       type: 'numeric' },
    { code: 'BAS%',   name: 'Базофилы, %',                   unit: '%',       type: 'numeric' },
    { code: 'NEU#',   name: 'Нейтрофилы, абс.',              unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM#',   name: 'Лимфоциты, абс.',               unit: '10^9/л',  type: 'numeric' },
    { code: 'MON#',   name: 'Моноциты, абс.',                unit: '10^9/л',  type: 'numeric' },
    { code: 'EOS#',   name: 'Эозинофилы, абс.',              unit: '10^9/л',  type: 'numeric' },
    { code: 'BAS#',   name: 'Базофилы, абс.',                unit: '10^9/л',  type: 'numeric' },
    { code: 'ALY%',   name: 'Атипичные лимфоциты, %',        unit: '%',       type: 'numeric' },
    { code: 'LIC%',   name: 'Крупные незрелые клетки, %',    unit: '%',       type: 'numeric' },
    { code: 'ALY#',   name: 'Атипичные лимфоциты, абс.',     unit: '10^9/л',  type: 'numeric' },
    { code: 'LIC#',   name: 'Крупные незрелые клетки, абс.', unit: '10^9/л',  type: 'numeric' },
    { code: 'RBC',    name: 'Эритроциты',                    unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    name: 'Гемоглобин',                    unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',    name: 'Гематокрит',                    unit: '%',       type: 'numeric' },
    { code: 'MCV',    name: 'Средний объём эритроцита',      unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    name: 'Среднее содержание Hb',         unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',   name: 'Средняя концентрация Hb',       unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                        unit: '%',       type: 'numeric' },
    { code: 'RDW-SD', name: 'RDW-SD',                        unit: 'фл',      type: 'numeric' },
    { code: 'PLT',    name: 'Тромбоциты',                    unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    name: 'Средний объём тромбоцита',      unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    name: 'PDW',                           unit: '',        type: 'numeric' },
    { code: 'PCT',    name: 'Тромбокрит',                    unit: '%',       type: 'numeric' },
  ],
};
