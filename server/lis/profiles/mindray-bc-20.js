// LIS_INGEST_V1 — Mindray BC-20, гематология, 3-diff.
//
// Основание: приложение C руководства оператора (analyzer-manuals/Mindray/) —
// «LAN Port supports HL7 protocol», двунаправленный LIS, плюс старый «15ID».
//
// LIS_VENDOR_EXACT_V1 — КТО ЗВОНИТ. BC-20 — TCP-СЕРВЕР: адреса LIS в его
// настройках нет (OM20, с. 9-5), он ждёт звонка программы LIS на своём порту
// 5100 (рабочий драйвер BC-20 — bc20.js, Малави — звонит на :5100; REPORT B1,
// analyzers\mindray-bc-20.md §1). Поэтому connect — 'dial', а defaultPort —
// порт ПРИБОРА, по которому звонит Easy-Med («Добавить по адресу» → IP прибора,
// 5100, «Easy-Med подключается к прибору сам»). Раньше здесь были 'listen' и
// 2575, и экран не подсказывал ни флажок, ни порт (acceptance mindray-bc-20,
// T3). На самом приборе порт не проверен: если отказ — 3600 или 5000 (REPORT
// B1.5).
//
// LIS_VENDOR_EXACT_V1 — КОДЫ. Подробный протокол BC-20 Mindray не публикует
// (приложение C — один абзац и «contact Mindray Customer Service»). Коды каналов
// — имена OBX-3.2 из таблицы кодов того же семейства (BC-3600 OM, с. D-32/D-33;
// так же у BC-5000/5150 и BC-30s; analyzers\mindray-bc-20.md, «Codes the BC-20
// should send» и M6), двадцать параметров BC-20 (OM20, с. B-1/B-2). Раньше здесь
// стояли «общепринятые мнемоники» GRA#/GRA%, которых BC-20 не шлёт никогда:
// подтверждённая из «Типовые для модели» GRA# оставляла строку бланка пустой
// на каждой пробе. Незнакомый код по-прежнему ничего не ломает: он появится в
// «Присылал этот анализатор», и лаборант выберет его оттуда.
export default {
  key: 'mindray-bc-20',
  vendor: 'Mindray',
  model: 'BC-20',
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 5100,   // LIS_VENDOR_EXACT_V1 — порт прибора: Easy-Med звонит BC-20 сам
  connect: 'dial',     // LIS_VENDOR_EXACT_V1 — BC-20 — TCP-сервер, ждёт звонка LIS
  channelsSource: 'conventional',
  channels: [
    { code: 'WBC',    name: 'Лейкоциты',                   unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM#',   name: 'Лимфоциты, абс.',             unit: '10^9/л',  type: 'numeric' },
    { code: 'MID#',   name: 'Средние клетки, абс.',        unit: '10^9/л',  type: 'numeric' },
    // LIS_VENDOR_EXACT_V1 — на проводе «10028^GRAN#^99MRC», не GRA#.
    { code: 'GRAN#',  name: 'Гранулоциты, абс.',           unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM%',   name: 'Лимфоциты, %',                unit: '%',       type: 'numeric' },
    { code: 'MID%',   name: 'Средние клетки, %',           unit: '%',       type: 'numeric' },
    // LIS_VENDOR_EXACT_V1 — на проводе «10030^GRAN%^99MRC», не GRA%.
    { code: 'GRAN%',  name: 'Гранулоциты, %',              unit: '%',       type: 'numeric' },
    { code: 'RBC',    name: 'Эритроциты',                  unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    name: 'Гемоглобин',                  unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',    name: 'Гематокрит',                  unit: '%',       type: 'numeric' },
    { code: 'MCV',    name: 'Средний объём эритроцита',    unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    name: 'Среднее содержание Hb',       unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',   name: 'Средняя концентрация Hb',     unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                      unit: '%',       type: 'numeric' },
    // LIS_VENDOR_EXACT_V1 — параметр BC-20 (OM20, с. B-1), «21000-5^RDW-SD^LN».
    { code: 'RDW-SD', name: 'RDW-SD',                      unit: 'фл',      type: 'numeric' },
    { code: 'PLT',    name: 'Тромбоциты',                  unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    name: 'Средний объём тромбоцита',    unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    name: 'PDW',                         unit: '',        type: 'numeric' },
    { code: 'PCT',    name: 'Тромбокрит',                  unit: '%',       type: 'numeric' },
    // LIS_VENDOR_EXACT_V1 — параметр BC-20 (OM20, с. B-1), «10014^PLCR^99MRC»
    // (таблица семейства; на приборе клиники не проверено — REPORT, вопрос 4).
    { code: 'PLCR',   name: 'P-LCR (доля крупных тромбоцитов)', unit: '%', type: 'numeric' },
  ],
};
