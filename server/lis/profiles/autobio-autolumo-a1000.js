// LIS_REAL_ANALYZERS_V1_PROFILES — Autobio AutoLumo A1000, иммунохемилюминесценция.
//
// Основной путь — сеть, HL7, прямо в Easy-Med:2575 (решение владельца
// 2026-10-01, вопрос 2): «Network port type: As client» — прибор звонит сам,
// connect — 'listen' (analyzer-lis-settings-guide.md, hmislk/ccmw-autolumo).
//
// Провод 'autobio-hl7' (wire.js) — ВЕРОЯТНО, а не документ: один полевой
// драйвер (AutoLumoHL7.cs, LiveMachine, строки 129–163; модель A2000 Plus),
// поэтому wireSource — 'driver', и первая настоящая проба сверяется построчно:
//   — номер пробирки — OBR-2;
//   — код — OBX-4.1, код позиции (206 = витамин B12); OBX-3 может быть номером
//     заявки на тест, своим у каждого прогона, — не сравнивается;
//   — значение — компонент 2 OBX-5 («5981666^390.946» → «390.946»): компонент 1
//     — RLU, сигнал прибора.
// Заголовок по «A2000 plus HL7 protocol V0.02»: «A1000|Autolumo» — модель в
// MSH-3, марка в MSH-4.
//
// Режим «по тесту» (LIS result sending mode) шлёт тест в сообщении —
// oneTestPerMessage; режим «по пробе» серия принимает тоже.
//
// Через переадресатор с COM (ASTM) прибор приходит с MSH-4 = LabPC и
// читается проводом forwarder, что бы ни говорил этот профиль (wire.js
// wireFor): номер — OBR-3, код — OBX-3 («206^^AUTOBIO»), подпись — OBX-4.
//
// Типового списка каналов нет: набор тестов задают реагенты клиники.
export default {
  key: 'autobio-autolumo-a1000',
  vendor: 'Autobio',
  model: 'AutoLumo A1000',
  aliases: ['AutoLumo A1000', 'Autolumo A1000', 'A1000'],
  kind: 'immunoassay',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',
  wire: 'autobio-hl7',
  oneTestPerMessage: true,
  wireSource: 'driver',
  channelsSource: 'device',
  channels: [],
};
