// LIS_REAL_ANALYZERS_V1_PROFILES — Mindray BS-200, биохимия.
//
// Основание — «BS-200 Host Interface Manual» v1.2 (номера страниц ниже — по
// руководству; docs/specs/2026-10-01-lis-real-analyzers-design.md, разделы 1–9).
//
// Как прибор называет себя: MSH-3 — производитель («Mindray»), MSH-4 — модель
// («BS-200E»), с. 7–8. Поэтому модель узнаётся по MSH-4 (discover.js
// guessProfile), а различается прибор, как все, по адресу и MSH-3.
//
// ПО прибора на своём ПК само подключается к LIS (с. 1): connect — 'listen',
// Easy-Med слушает 2575.
//
// Провод 'mindray-chem' (wire.js):
//   — НОМЕР ПРОБИРКИ — в поле «Barcode» (OBR-2), а не «Sample ID» (OBR-3).
//     OBR-3 — номер места в штативе: «Sample ID is for internal use and must
//     not be analyzed by the server» (с. 24). Не читается НИКОГДА: голое «2»
//     легло бы в заказ № 2 чужого пациента. Без сканера штрихкода оператор
//     вписывает LAB-… в поле штрихкода;
//   — код — OBX-3, номер теста (целое, задаёт лаборатория на приборе,
//     ItemID.ini, с. 22); OBX-4 — имя теста, только подпись: «functions as a
//     note and must not be analyzed» (с. 24);
//   — значение «5.000000» → «5»: хвостовые нули срезаются, число не
//     округляется (решение владельца 2026-10-01, вопрос 5).
//
// По одному тесту в сообщении (с. 5: «each ORU^R01 message transmits one
// test»; с. 23 говорит и обратное) — oneTestPerMessage: бланк судится по серии
// сообщений (match.js planSeries), а не по одному.
//
// Типового списка каналов нет и быть не может: номера тестов задаёт клиника
// (ItemID.ini). Коды появятся в «Поле анализатора», когда прибор пришлёт первую
// пробу (lis_device_codes).
//
// LIS_REAL_ANALYZERS_V1 (ревью R2, п. 1) — codesPerInstrument: номер теста свой
// у КАЖДОГО прибора — «2» у второго BS-200 бывает креатинином, а не глюкозой.
// Поэтому подмены «та же модель» нет (ingest.js): панель кормит только тот
// прибор, к которому привязана; коды в «Поле анализатора» — только своего
// прибора; серия — только своего прибора.
export default {
  key: 'mindray-bs-200',
  vendor: 'Mindray',
  model: 'BS-200',
  aliases: ['BS-200', 'BS-200E'],
  kind: 'chemistry',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'listen',
  wire: 'mindray-chem',
  oneTestPerMessage: true,
  codesPerInstrument: true,   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 1
  wireSource: 'documented',
  channelsSource: 'device',
  channels: [],
};
