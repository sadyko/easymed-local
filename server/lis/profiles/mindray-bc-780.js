// LIS_REAL_ANALYZERS_V1_PROFILES — Mindray BC-780(R), гематология, 5-diff.
//
// Публичного документа на модель нет; по проспекту — LAN×1, USB×4, RS-232
// нет. Всё здесь — ПО ДОКУМЕНТАМ СОСЕДНИХ МОДЕЛЕЙ (wireSource и channelsSource
// — 'siblings'): BC-5380 и BC-20S/30S (публичные протоколы, LIS_MINDRAY_CODES_V1),
// полевая запись BC-3600 (2026-09-03, geulis docs/BC-3600.md), драйверы
// BC5800.cs и BC6000_Raghwa.cs. HL7 v2.3.1 в кадрах MLLP, OBX-3 —
// «LOINC^ИМЯ^LN».
//
// Провод 'mindray-hematology' (wire.js): номер пробы — OBR-3, запасное — OBR-2
// (только если OBR-3 пуст); код — OBX-3.1, затем OBX-3.2; значение — OBX-5.
//
// Кто звонит, неизвестно (connect — 'unknown'): у BC-6800 и BC-5390 роль TCP
// переключается, старые BC-3600 и BC-5800 — только сервер (LIS подключается к
// прибору). Если в настройках LIS прибора нет адреса сервера, а есть только
// «порт прибора», — строка прибора с «Easy-Med подключается сам»
// (lab_devices.dial). defaultPort — 2575, если звонит прибор; если звонит
// Easy-Med — порт прибора, свой у каждого.
//
// Каналы — тот же набор CBC + 5-diff, что у BC-5300 (снят с экрана Mindray).
// code канала — ИМЯ (компонент 2): «6690-2^WBC^LN» ловится по имени
// (LIS_MINDRAY_CODES_V1). loinc — только подпись, по публичным протоколам
// BC-5380 / BC-20S и записи BC-3600; неточный LOINC ничего не сопоставляет.
// PCT у Mindray — частный код 99MRC, у ALY и LIC LOINC нет. Параметры, которых
// здесь нет (ретикулоциты, NRBC и прочие модули BC-780R), появятся в группе
// «Присылал этот анализатор» с первой пробы.
export default {
  key: 'mindray-bc-780',
  vendor: 'Mindray',
  model: 'BC-780',
  aliases: ['BC-780', 'BC-780R'],
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  connect: 'unknown',
  wire: 'mindray-hematology',
  wireSource: 'siblings',
  channelsSource: 'siblings',
  channels: [
    { code: 'WBC',    loinc: '6690-2',  name: 'Лейкоциты',                     unit: '10^9/л',  type: 'numeric' },
    { code: 'NEU%',   loinc: '770-8',   name: 'Нейтрофилы, %',                 unit: '%',       type: 'numeric' },
    { code: 'LYM%',   loinc: '736-9',   name: 'Лимфоциты, %',                  unit: '%',       type: 'numeric' },
    { code: 'MON%',   loinc: '5905-5',  name: 'Моноциты, %',                   unit: '%',       type: 'numeric' },
    { code: 'EOS%',   loinc: '713-8',   name: 'Эозинофилы, %',                 unit: '%',       type: 'numeric' },
    { code: 'BAS%',   loinc: '706-2',   name: 'Базофилы, %',                   unit: '%',       type: 'numeric' },
    { code: 'NEU#',   loinc: '751-8',   name: 'Нейтрофилы, абс.',              unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM#',   loinc: '731-0',   name: 'Лимфоциты, абс.',               unit: '10^9/л',  type: 'numeric' },
    { code: 'MON#',   loinc: '742-7',   name: 'Моноциты, абс.',                unit: '10^9/л',  type: 'numeric' },
    { code: 'EOS#',   loinc: '711-2',   name: 'Эозинофилы, абс.',              unit: '10^9/л',  type: 'numeric' },
    { code: 'BAS#',   loinc: '704-7',   name: 'Базофилы, абс.',                unit: '10^9/л',  type: 'numeric' },
    { code: 'ALY%',   loinc: '',        name: 'Атипичные лимфоциты, %',        unit: '%',       type: 'numeric' },
    { code: 'LIC%',   loinc: '',        name: 'Крупные незрелые клетки, %',    unit: '%',       type: 'numeric' },
    { code: 'ALY#',   loinc: '',        name: 'Атипичные лимфоциты, абс.',     unit: '10^9/л',  type: 'numeric' },
    { code: 'LIC#',   loinc: '',        name: 'Крупные незрелые клетки, абс.', unit: '10^9/л',  type: 'numeric' },
    { code: 'RBC',    loinc: '789-8',   name: 'Эритроциты',                    unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    loinc: '718-7',   name: 'Гемоглобин',                    unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',    loinc: '4544-3',  name: 'Гематокрит',                    unit: '%',       type: 'numeric' },
    { code: 'MCV',    loinc: '787-2',   name: 'Средний объём эритроцита',      unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    loinc: '785-6',   name: 'Среднее содержание Hb',         unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',   loinc: '786-4',   name: 'Средняя концентрация Hb',       unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-CV', loinc: '788-0',   name: 'RDW-CV',                        unit: '%',       type: 'numeric' },
    { code: 'RDW-SD', loinc: '21000-5', name: 'RDW-SD',                        unit: 'фл',      type: 'numeric' },
    { code: 'PLT',    loinc: '777-3',   name: 'Тромбоциты',                    unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    loinc: '32623-1', name: 'Средний объём тромбоцита',      unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    loinc: '32207-3', name: 'PDW',                           unit: '',        type: 'numeric' },
    { code: 'PCT',    loinc: '',        name: 'Тромбокрит',                    unit: '%',       type: 'numeric' },
  ],
};
