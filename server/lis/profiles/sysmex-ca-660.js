// LIS_ASTM_FOUR_V1 — Sysmex CA-660 (серия CA-600), коагулометр.
//
// Связь с ЛИС — только RS-232 (порт LAN у прибора — для сервиса Sysmex),
// протокол ASTM. Easy-Med его не читает: приносит переадресатор лаборатории
// (Desktop\new lis, src/astm/read.js, диалект sysmex-ca): номер пробы — O.3, а
// если пусто — компонент 3 поля O.4; код — компонент 4 поля R.3 («^^^041^PT»),
// название — компонент 5. В Easy-Med — HL7 с MSH-3 «CA-660» и MSH-4 «LabPC»:
// провод forwarder, код — OBX-3.1 («041^^SYSMEX»), название — OBX-4 («PT»).
// Переадресатор звонит Easy-Med на 2575 — connect 'listen'.
//
// Откуда формат: фрагменты «CA-600 ASTM Host Interface Specification» и
// полевые драйверы (CA600.cs, мост Sysmex CA-1500) — полного документа нет,
// поэтому wireSource 'driver': экран просит сверить первую пробу.
//
// Каналы — коды Sysmex: у каждого вида результата свой код (041 — ПВ в
// секундах, 042 — ПВ в %, 044 — МНО, 051 — АЧТВ в секундах, 061 —
// фибриноген). Это те коды, на которых проверен переадресатор; список
// типовой (channelsSource 'conventional'): прочие коды прибора появятся в
// «Присылал этот анализатор» с первой пробы. Единицы — подсказка: прибор шлёт
// свою в OBX-6, а в бланке — единица панели клиники.
export default {
  key: 'sysmex-ca-660',
  vendor: 'Sysmex',
  model: 'CA-660',
  aliases: ['CA-660'],
  kind: 'coagulation',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',
  wire: 'forwarder',
  wireSource: 'driver',
  channelsSource: 'conventional',
  channels: [
    { code: '041', name: 'Протромбиновое время (ПВ), с', unit: 'с', type: 'numeric' },
    { code: '042', name: 'ПВ по Квику, %',               unit: '%', type: 'numeric' },
    { code: '044', name: 'МНО',                          unit: '',  type: 'numeric' },
    { code: '051', name: 'АЧТВ, с',                      unit: 'с', type: 'numeric' },
    { code: '061', name: 'Фибриноген',                   unit: '',  type: 'numeric' },
  ],
};
