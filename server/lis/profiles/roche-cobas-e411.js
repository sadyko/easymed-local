// LIS_ASTM_FOUR_V1 — Roche cobas e 411, иммунохимия (ИХЛА).
//
// Связь с ЛИС — RS-232 (разъём слева), ASTM, 9600 8N1 («Host Interface Manual»
// 2.2, табл. B-1, прочитан целиком — wireSource 'documented'). Easy-Med ASTM не
// читает: приносит переадресатор лаборатории (Desktop\new lis, src/astm/read.js,
// диалект roche): номер пробы — O.3 (при ошибке штрихкода прибор пишет
// «@<номер>» — Easy-Med такой номер не находит, проба в лотке), код —
// компонент 4 поля R.3 до «/» («^^^10^^0» → «10»). Качественный тест («1^COI»)
// переадресатор пишет словом с COI — «Положительно (COI 12.5)», флаг A — и
// Easy-Med кладёт его в бланк текстом. В Easy-Med — HL7 с MSH-3 «cobas e411»
// и MSH-4 «LabPC»: провод forwarder, код — OBX-3.1 («10^^ROCHE»).
// Переадресатор звонит Easy-Med на 2575 — connect 'listen'.
//
// Типового списка нет (channelsSource 'device'): номера тестов появятся в
// «Поле анализатора» с первой пробы; какой номер какой тест — по распечатке
// прибора. Номер задаёт Roche, не клиника — codesPerInstrument не ставится.
export default {
  key: 'roche-cobas-e411',
  vendor: 'Roche',
  model: 'cobas e 411',
  aliases: ['cobas e 411', 'cobas e411'],
  kind: 'immunoassay',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',
  wire: 'forwarder',
  wireSource: 'documented',
  channelsSource: 'device',
  channels: [],
};
