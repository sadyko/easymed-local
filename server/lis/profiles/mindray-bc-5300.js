// LIS_INGEST_V1 — Mindray BC-5300, гематология, 5-diff.
//
// Состав каналов снят со СКРИНШОТА ПО производителя (владелец, 2026-09-10):
// экран «Проб за сегодня», режим WB / CBC+DIFF. Порядок и написание — как на
// экране, слева направо и сверху вниз.
//
// ALY и LIC прибор помечает звёздочкой и подписью «только для исслед. целей,
// не для диагностики». Они здесь есть, потому что прибор их присылает; брать
// их в панель или нет — решение клиники, а не наше.
//
// LIS_VENDOR_EXACT_V1 — код канала — имя OBX-3.2 ровно как на проводе (табл. 10
// руководства BC-5300/5380, OM13 pdf 493–495): у исследовательских звёздочка и в
// HL7 — «26477-0^*ALY#^LN», «13046-8^*ALY%^LN», «10000^*LIC#^99MRC»,
// «10001^*LIC%^99MRC». Раньше здесь стояли ALY#, ALY%, LIC#, LIC%: match.js
// сравнивает код целиком, и строки, подтверждённые из «Типовые для модели»,
// не заполнялись никогда (acceptance mindray-bc-5300, T12d, N3; лист M8).
// Прочие 23 кода — уже имена таблицы 10.
export default {
  key: 'mindray-bc-5300',
  vendor: 'Mindray',
  model: 'BC-5300',
  // LIS_VENDOR_EXACT_V1 (ревью; analyzer-research, mindray-bc-5300.md M5) — как
  // прибор называет себя в MSH-3: «BC-5300 or BC-5380» — одно приложение LIS
  // (руководство BC-5300/5380, приложение C, табл. 1); издание P08 — без дефиса.
  aliases: ['BC-5300', 'BC5300', 'BC-5380', 'BC5380'],
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  channelsSource: 'screenshot',
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
    // LIS_VENDOR_EXACT_V1 — со звёздочкой, как пишет прибор (табл. 10 OM13).
    { code: '*ALY%',  name: 'Атипичные лимфоциты, %',        unit: '%',       type: 'numeric' },
    { code: '*LIC%',  name: 'Крупные незрелые клетки, %',    unit: '%',       type: 'numeric' },
    { code: '*ALY#',  name: 'Атипичные лимфоциты, абс.',     unit: '10^9/л',  type: 'numeric' },
    { code: '*LIC#',  name: 'Крупные незрелые клетки, абс.', unit: '10^9/л',  type: 'numeric' },
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
