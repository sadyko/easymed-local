// LIS_ASTM_FOUR_V1 — Roche cobas c 311, биохимия.
//
// Связь с ЛИС — RS-232 (D-SUB 9), ASTM, 9600 8N1 («Utility» → «System» →
// «Communication Setting»). Easy-Med ASTM не читает: приносит переадресатор
// лаборатории (Desktop\new lis, src/astm/read.js, диалект roche): номер пробы —
// O.3, код — компонент 4 поля R.3 до «/» («^^^685/» → «685»), значение — R.4,
// компонент 1. В Easy-Med — HL7 с MSH-3 «cobas c311» и MSH-4 «LabPC»: провод
// forwarder, код — OBX-3.1 («685^^ROCHE»). Переадресатор звонит Easy-Med на
// 2575 — connect 'listen'.
//
// Откуда формат: выдержки руководства по связи 1.3 и полевые драйверы
// (wireSource 'driver') — первую пробу сверить.
//
// Типового списка нет (channelsSource 'device', как у BS-200 и A1000): тест
// прибор называет номером, набор тестов — реагенты клиники. Номера появятся в
// «Поле анализатора», когда прибор пришлёт первую пробу; какой номер какой тест
// — по распечатке прибора. Номер задаёт Roche (не клиника на каждом приборе),
// поэтому codesPerInstrument не ставится.
export default {
  key: 'roche-cobas-c311',
  vendor: 'Roche',
  model: 'cobas c 311',
  aliases: ['cobas c 311', 'cobas c311'],
  kind: 'chemistry',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',
  wire: 'forwarder',
  wireSource: 'driver',
  channelsSource: 'device',
  channels: [],
};
