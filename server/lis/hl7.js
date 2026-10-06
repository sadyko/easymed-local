// LIS_INGEST_V1 — разбор HL7 v2.3.1. ЧИСТЫЙ: ни базы, ни сети, ни времени.
//
// Своей зависимости здесь нет намеренно (решение спецификации): HL7 v2 — это
// текст с разделителями, а разбор, который мы можем прочитать целиком, в
// медицинской системе лучше дерева транзитивных зависимостей.
//
// Разделители НЕ зашиты: они объявлены в MSH-2 самим отправителем, и прибор,
// выбравший другие, обязан быть понят. Тип сообщения при этом нормализуется в
// наш вид ('ORU^R01') — сравнивать его с константой должно быть можно,
// независимо от того, чем отправитель разделяет компоненты.
//
// Нумерация полей HL7 сдвинута на единицу относительно массива: MSH-1 — это
// сам разделитель, поэтому MSH-9 (тип) лежит в fields[8], а MSH-10 (номер
// сообщения) — в fields[9]. Ошибка на единицу здесь стоила бы того, что ни
// одно сообщение не было бы узнано.

const SEG = /\r\n?|\n/;

/**
 * Разбирает сообщение.
 * @returns {{type:string, controlId:string, sampleId:string, observations:Array}}
 * @throws {Error} с внятной причиной — её увидит лоток и прочитает человек.
 */
export function parseMessage(text) {
  const segments = String(text == null ? '' : text).split(SEG).filter((s) => s.trim() !== '');
  if (!segments.length) throw new Error('пустое сообщение');

  const msh = segments[0];
  if (!msh.startsWith('MSH')) throw new Error('первый сегмент не MSH');

  const fieldSep = msh[3];
  const encEnd = msh.indexOf(fieldSep, 4);
  const enc = encEnd === -1 ? '^~\\&' : msh.slice(4, encEnd);
  const compSep = enc[0] || '^';
  const repSep = enc[1] || '~';
  const escChar = enc[2] || '\\';
  const subSep = enc[3] || '&';

  const fields = (seg) => seg.split(fieldSep);
  const comp = (v) => String(v == null ? '' : v).split(compSep);

  const mshF = fields(msh);
  // Нормализация: чем бы отправитель ни разделял компоненты, наружу выходит
  // 'ORU^R01'.
  const type = comp(mshF[8] || '').slice(0, 2).filter(Boolean).join('^');
  const controlId = mshF[9] || '';
  // MSH-3 — как прибор себя называет («BC-5300»). На этом держится
  // самоопределение: клиника не должна заводить анализатор руками, чтобы он
  // появился в списке.
  const sendingApp = comp(mshF[2] || '')[0].trim();

  if (type === 'QRY^Q02') {
    // Прибор спрашивает рабочий список для отсканированной пробирки. Полезно
    // позже (спецификация, «Вне объёма»); сегодня узнаём и внятно отклоняем,
    // чтобы дверь осталась открытой, а запрос не разобрался как результат.
    throw new Error('QRY^Q02 — запрос рабочего списка; исходящее направление пока не поддержано');
  }
  if (type !== 'ORU^R01') throw new Error('ожидался ORU^R01, получен ' + (type || '<пусто>'));

  let sampleId = '';
  const observations = [];
  for (const seg of segments.slice(1)) {
    const f = fields(seg);
    if (seg.startsWith('OBR')) {
      // Первый OBR задаёт пробу: сообщение об одном образце — обычный случай,
      // а при нескольких заказах в одном сообщении верен именно первый.
      if (!sampleId) sampleId = (f[3] || '').trim();
    } else if (seg.startsWith('OBX')) {
      // LIS_MINDRAY_CODES_V1 — OBX-3 целиком и по частям. Mindray пишет
      // «6690-2^WBC^LN»: код LOINC, имя, система. Раньше выживал только первый
      // компонент, и бланк, привязанный к «WBC», оставался пустым при ACK AA.
      // Сравнивать с кодом бланка — дело match.js; здесь только разбор.
      const id = comp(f[3]);
      observations.push({
        valueType: (f[2] || '').trim(),
        code: (id[0] || '').trim(),
        name: (id[1] || '').trim(),
        system: (id[2] || '').trim(),
        codeRaw: (f[3] || '').trim(),
        value: (f[5] || '').trim(),
        unit: comp(f[6])[0].trim(),
        range: (f[7] || '').trim(),
        // OBX-8 повторяется («H~N»): смысл несёт первое повторение. Целиком
        // строка уходила в «прочее» и становилась «abnormal» вместо «high».
        abnormal: String(f[8] == null ? '' : f[8]).split(repSep)[0].trim(),
        status: (f[11] || '').trim(),
      });
    }
  }

  return { type, controlId, sendingApp, sampleId, observations, sep: { fieldSep, compSep, repSep, escChar, subSep } };
}

// LIS_REAL_ANALYZERS_V1_ACK — терпимый разбор заголовка и ответ прибору по
// руководству BS-200 («Host Interface Manual» v1.2, с. 8–9, 25, 27).
//
// Ответить надо и на то, что не разобралось целиком, поэтому заголовок читается
// отдельно и без исключений: mshOf() никогда не бросает, а у неразобранного
// возвращает пустые поля (ok = false).

/** MSH-3/4 в заголовок ответа: наши разделители и конец сегмента в эхо не попадают. */
const echo = (v) => String(v == null ? '' : v).replace(/[|\r\n]/g, ' ').trim();

// LIS_VENDOR_EXACT_V1 — два вида ответа прибору; какой — решает receive.js
// (replyStyle) по проводу и профилю прибора:
//   LAYOUT_LONG  — вид руководства BS-200 (HIM v5.0, P/N BA20-20-75337,
//                  с. 25–27; тот же у BS-240 — M pdf 34, 38 — и CL-900i — HIM
//                  pdf 35, SM pdf 603–605): MSH до MSH-20 с хвостом
//                  «…|ASCII|||», «|» после последнего поля MSA, ERR и QAK.
//                  BS200.exe режет весь ответ по «|» и читает куски 10, 27 и 32
//                  (MSH-10, MSA-6, QAK-2): у короткого ответа куска 27 нет.
//                  CL-900i отвергает MSH короче 19 полей и блокирует связь.
//                  Декодер A1000 этот вид принимает (autobio-autolumo-a1000.
//                  settle.md, табл. c). Химия и ИХЛА Mindray, A1000,
//                  переадресатор и незнакомый прибор — первым может заговорить
//                  и CL-900i, и BS-200.
//   LAYOUT_SHORT — гематология Mindray (BC-20, BC-5300, BC-780…): сегодняшний
//                  короткий вид — пустые поля в конце не пишутся (17 «|», как в
//                  примере производителя, OM13 pdf 485).
// У обоих — CR после КАЖДОГО сегмента, и последнего тоже: «Each HL7 message is
// composed of segments that end with <CR>» (HIM v5.0, с. 3, 23; OM13 C.2.1).
// Кадр поэтому кончается «…<CR><FS><CR>» (mllp.js frameOf).
export const LAYOUT_LONG = 'long';
export const LAYOUT_SHORT = 'short';

/** LIS_VENDOR_EXACT_V1 — сегменты ответа: CR после каждого, и последнего тоже. */
const segments = (list) => list.map((s) => s + '\r').join('');

/**
 * Заголовок сообщения без исключений.
 * @returns {{ok:boolean, fieldSep:string, compSep:string, app:string, facility:string,
 *   appField:string, facilityField:string, type:string, event:string, controlId:string,
 *   processingId:string, version:string, ackType:string, charset:string}}
 *   app/facility — компонент 1 MSH-3/MSH-4 (как прибор себя назвал);
 *   appField/facilityField — поля целиком, для эха в MSH-5/6 ответа;
 *   type — 'ORU^R01' в нашем виде, event — 'R01';
 *   processingId — MSH-11, компонент 1 (LIS_VENDOR_EXACT_V1: P — проба, у
 *     гематологии Mindray Q/T/D — контроль; эхом в ответе);
 *   ackType — MSH-16 (у Mindray и Autobio: 0 — проба, 1 — калибровка, 2 — контроль);
 *   charset — MSH-18.
 */
export function mshOf(text) {
  const out = { ok: false, fieldSep: '|', compSep: '^', app: '', facility: '', appField: '', facilityField: '',
    type: '', event: '', controlId: '', processingId: '', version: '', ackType: '', charset: '' };
  // Первый непустой сегмент — как у parseMessage: прибор, приславший пустую
  // строку перед MSH, разобран приёмом, и ответ обязан это знать.
  const first = String(text == null ? '' : text).split(SEG).find((s) => s.trim() !== '') || '';
  if (!first.startsWith('MSH') || first.length < 4) return out;
  const fieldSep = first[3];
  const f = first.split(fieldSep);
  const compSep = (f[1] || '')[0] || '^';
  const comp = (v) => String(v == null ? '' : v).split(compSep);
  const t = comp(f[8]);
  return {
    ok: true,
    fieldSep,
    compSep,
    app: comp(f[2])[0].trim(),
    facility: comp(f[3])[0].trim(),
    appField: echo(comp(f[2]).join('^')),
    facilityField: echo(comp(f[3]).join('^')),
    // Тип — ровно как у parseMessage, без обрезки пробелов: вид сообщения по
    // заголовку (wire.js readEnvelope) обязан совпадать с тем, что разберёт
    // приём, иначе «проба» по заголовку получила бы отказ приёма и не тот ответ.
    type: t.slice(0, 2).filter(Boolean).join('^'),
    event: echo(t[1]),
    // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 9) — номер, MSH-12, MSH-16 и MSH-18
    // идут в ответ эхом и чистятся так же, как MSH-3/4: у отправителя со своим
    // разделителем полей «|» в поле — просто знак, а в нашем ответе — граница.
    controlId: echo(f[9]),
    processingId: echo(comp(f[10])[0]),   // LIS_VENDOR_EXACT_V1 — MSH-11 эхом в ответе
    version: echo(f[11]),
    ackType: echo(f[15]),
    charset: echo(f[17]),
  };
}

/**
 * Заголовок ответа: «MSH|^~\&|EASYMED|CLINIC|<MSH-3>|<MSH-4>|<время>||<тип>|
 * <MSH-10>|<MSH-11>|<MSH-12 или 2.3.1>||||<MSH-16>||<MSH-18>». MSH-3/4 — наши:
 * «Fields 3 and 4 are determined by LIS manufacturer» (HIM v5.0, с. 8); MSH-5/6
 * — эхо MSH-3/4 входящего («fields 5 and 6 are set to Manufacturer and Model»,
 * там же), MSH-10 — номер входящего («returned unchanged in the response
 * message», с. 24), MSH-16 и MSH-18 — эхом (с. 26: у ответа на контроль стоит 2).
 *
 * LIS_VENDOR_EXACT_V1 — вид (o.layout):
 *   LAYOUT_LONG  (по умолчанию) — до MSH-20 с хвостом «|||», как в руководстве;
 *                MSH-18 — эхом, а если прибор его не прислал — ASCII
 *                («Character set. ASCII is used», с. 8; mindray-bs-240.md M15);
 *   LAYOUT_SHORT — пустые поля в конце не пишутся (гематология, как прежде).
 * MSH-11 — эхом P/Q/T/D: «In the ACK it equals the received message» (BC-5300
 * OM13, Table 1), «the value of MSH-11 … in QC response message is Q» (BC-3600
 * OM, p. D-31); иное и пустое — P. Раньше здесь всегда стояло P, и ответ на
 * контроль гематологии нарушал правило производителя.
 * MSH-16 — только у подтверждения (ACK…): «It is void in non-ORU messages»
 * (HIM v5.0, с. 8); у QCK^Q02 он пуст (с. 27).
 * @param {{layout?: string}} [o]
 */
export function replyMsh(msh, type, { layout = LAYOUT_LONG } = {}) {
  const m = msh || mshOf('');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 9) — MSH-16 эхом только 0/1/2 — вид
  // результата по руководству BS-200 (с. 8: «0- Sample result; 1- Calibration
  // result; 2- QC result»; эхом в ACK^R01 на с. 25 и 27). Стандартные
  // AL/NE/ER/SU — просьба отправителя о виде подтверждения, а не вид
  // результата: в ответ не возвращаются. Поля — чищеные (echo).
  // LIS_VENDOR_EXACT_V1 — и только в подтверждении (ACK…), не в QCK/DSR/ORR.
  const ackType = String(type).startsWith('ACK') && /^[012]$/.test(echo(m.ackType)) ? echo(m.ackType) : '';
  const proc = /^[PQTD]$/.test(echo(m.processingId)) ? echo(m.processingId) : 'P';   // LIS_VENDOR_EXACT_V1 — MSH-11 эхом
  const f = ['MSH', '^~\\&', 'EASYMED', 'CLINIC', m.appField || '', m.facilityField || '', stamp, '', type,
    echo(m.controlId) || '1', proc, echo(m.version) || '2.3.1', '', '', '', ackType, '', echo(m.charset)];
  if (layout === LAYOUT_SHORT) {
    while (f.length > 12 && f[f.length - 1] === '') f.pop();
    return f.join('|');
  }
  // LIS_VENDOR_EXACT_V1 — вид руководства: «…|2.3.1||||<MSH-16>||ASCII|||» —
  // 20 «|» (MSH-19, MSH-20 и «|» после него), ничего не срезается.
  f[17] = f[17] || 'ASCII';
  return [...f, '', '', ''].join('|');
}

/** MSA-3 и MSA-6 по коду ответа (с. 9). */
const MSA_TEXT = {
  AA: { text: 'Message accepted', error: '0' },
  AE: { text: 'Segment sequence error', error: '100' },      // не разобрано
  AR: { text: 'Unsupported message type', error: '200' },   // известный, но не поддержанный тип
};
/** AE, когда разобрано, но сорвалась запись или сообщение переросло потолок. */
export const ACK_INTERNAL = Object.freeze({ text: 'Application internal error', error: '207' });
/**
 * LIS_VENDOR_EXACT_V1 — сорвалась запись у химии Mindray: AR 206 «Application
 * record locked» — код руководства для «could not be performed at the
 * application storage level, such as locked database» (HIM v5.0, с. 9; пример
 * с. 25: «MSA|AR|1|Application record locked|||206|»). AE по руководству — только
 * 100–103, AR — 200–207 (receive.js).
 */
export const ACK_LOCKED = Object.freeze({ text: 'Application record locked', error: '206' });

/**
 * LIS_VENDOR_EXACT_V1 — код отказа по нашей вине (сорвалась запись, сообщение
 * переросло потолок, приём бросил): у химии Mindray (провод 'mindray-chem',
 * wire.js) — AR: пары AE с 207 руководство не знает (AE — только 100–103, AR —
 * 200–207; HIM v5.0, с. 9). У прочих — AE, как прежде: переадресатор повторяет
 * на любом не-AA, A1000 смотрит только MSA-6, у гематологии документ AE и AR
 * не различает.
 * @param {{wire?:string}} [style]  receive.js replyStyle
 */
export const internalCode = (style) => ((style || {}).wire === 'mindray-chem' ? 'AR' : 'AE');

/**
 * LIS_VENDOR_EXACT_V1 — ответ на отказ по нашей вине в виде прибора (style:
 * receive.js replyStyle). Сорвалась запись (o.write) у химии — AR 206
 * «Application record locked» (ACK_LOCKED), прочее у химии — AR 207, у прочих
 * проводов — AE 207 (ACK_INTERNAL), как прежде.
 * @param {ReturnType<typeof mshOf>} msh
 * @param {{layout?:string, wire?:string}} [style]
 * @param {{write?:boolean}} [o]
 */
export function internalAck(msh, style, { write = false } = {}) {
  const code = internalCode(style);
  return buildAck(msh, code, { ...(code === 'AR' && write ? ACK_LOCKED : ACK_INTERNAL), layout: (style || {}).layout });
}

/**
 * LIS_VENDOR_EXACT_V1 — «MSA|<код>|<номер>|<текст>|<MSA-4>||<MSA-6>»; у вида
 * руководства — с «|» после MSA-6 («MSA|AA|1|Message accepted|||0|», с. 25):
 * у BS200.exe это кусок 27.
 */
function msaLine(layout, code, controlId, text, error, ref = '') {
  const line = ['MSA', code, echo(controlId), text, echo(ref), '', error].join('|');   // echo: ревью R1, п. 9
  return layout === LAYOUT_SHORT ? line : line + '|';
}

/**
 * ACK (`AA`), NAK (`AE`) или отказ без повтора (`AR`). Номер исходного
 * сообщения обязателен: по нему прибор понимает, на что именно ему ответили, и
 * решает, повторять ли.
 *
 * LIS_REAL_ANALYZERS_V1_ACK — `msh` — заголовок входящего (mshOf). Строка
 * вместо него — прежняя форма: номер исходного сообщения.
 * @param {ReturnType<typeof mshOf>|string} msh
 * @param {'AA'|'AE'|'AR'} code
 * @param {{text?:string, error?:string, layout?:string, ref?:string}} [why]
 *   text/error — MSA-3/MSA-6 вместо принятых для кода (ACK_INTERNAL, ACK_LOCKED);
 *   layout — LIS_VENDOR_EXACT_V1: LAYOUT_LONG (по умолчанию) или LAYOUT_SHORT;
 *   ref — LIS_VENDOR_EXACT_V1: MSA-4, только у AA. A1000 ставит результату
 *     «Accepted», только если в MSA-4 — OBX-1 (по тесту) или OBR-3 (по пробе)
 *     его сообщения (settle, табл. c; выбирает receive.js); при AE/AR MSA-4
 *     пуст — результат остаётся «Finished» к повтору (A1000, M18).
 */
export function buildAck(msh, code, why = {}) {
  const m = typeof msh === 'string' || msh == null ? { ...mshOf(''), controlId: String(msh == null ? '' : msh).trim() } : msh;
  const c = MSA_TEXT[code] ? code : 'AE';
  const w = why || {};
  const layout = w.layout === LAYOUT_SHORT ? LAYOUT_SHORT : LAYOUT_LONG;
  const text = w.text || MSA_TEXT[c].text;
  const error = w.error || MSA_TEXT[c].error;
  return segments([
    replyMsh(m, m.event ? 'ACK^' + m.event : 'ACK', { layout }),
    msaLine(layout, c, m.controlId, text, error, c === 'AA' ? w.ref : ''),
  ]);
}

/**
 * LIS_REAL_ANALYZERS_V1_SERVICE — ответ на запрос рабочего списка: «заказов
 * нет». Easy-Med остаётся «только результаты» и заказов приборам не отдаёт
 * (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел 7).
 *
 *   QRY^Q02 (BS-200, химия Mindray) → QCK^Q02: MSA AA, ERR|0|, QAK|SR|NF| —
 *     руководство BS-200 (HIM v5.0), с. 27, дословно («If the sample of the bar
 *     code does not exist»); с QRD-9 = CAN (отмена группового, с. 33) — тот же
 *     ответ;
 *   QRY^Q01 (Autobio) → DSR^Q01: MSA AA, ERR|0, QAK|SR|NF, эхо QRD и QRF, без
 *     DSP — по образцу AutoLumoHL7.cs (там QAK|SR|OK и DSP с заказом); «нет
 *     данных» — по аналогии, ПРОВЕРИТЬ НА ПРИБОРЕ (декодер A1000 ждёт ERR-1.4 и
 *     строки DSP — autobio-autolumo-a1000.md M20; на приборе запрос выключен);
 *   ORM^O01 (гематология Mindray) → LIS_VENDOR_EXACT_V1: ORR^O02 с MSA|AR|<номер
 *     запроса> — «заказов нет» по OM13 pdf 489–490 (mindray-bc-5300.md §5; у
 *     BC-20 так же — mindray-bc-20.md M14). Было ACK^O01 AA без документа.
 * LIS_VENDOR_EXACT_V1 — вид (o.layout) — как у buildAck: длинный — «|» в конце
 * MSA, ERR и QAK (BS200.exe читает кусок 32 — QAK-2), MSH-16 пуст; короткий —
 * как прежде; у обоих CR после последнего сегмента.
 * @param {object} env  readEnvelope() запроса (wire.js): заголовок, qrd, qrf
 * @param {{layout?: string}} [o]
 */
export function buildQueryReply(env, { layout = LAYOUT_LONG } = {}) {
  const lay = layout === LAYOUT_SHORT ? LAYOUT_SHORT : LAYOUT_LONG;
  const tail = lay === LAYOUT_SHORT ? '' : '|';
  const msa = msaLine(lay, 'AA', env.controlId, MSA_TEXT.AA.text, MSA_TEXT.AA.error);
  if (env.type === 'QRY^Q02') return segments([replyMsh(env, 'QCK^Q02', { layout: lay }), msa, 'ERR|0' + tail, 'QAK|SR|NF' + tail]);
  if (env.type === 'QRY^Q01') return segments([replyMsh(env, 'DSR^Q01', { layout: lay }), msa, 'ERR|0' + tail, 'QAK|SR|NF' + tail, env.qrd, env.qrf].filter(Boolean));
  if (env.type === 'ORM^O01') {
    // Короткий — дословно OM13 pdf 490: «MSA|AR|<id>»; длинный (ORM^O01 от
    // незнакомого прибора) — AR 200 с MSA-6, как всякий отказ этого вида.
    const ar = lay === LAYOUT_SHORT
      ? ['MSA', 'AR', echo(env.controlId)].join('|')
      : msaLine(lay, 'AR', env.controlId, MSA_TEXT.AR.text, MSA_TEXT.AR.error);
    return segments([replyMsh(env, 'ORR^O02', { layout: lay }), ar]);
  }
  return buildAck(env, 'AA', { layout: lay });
}

/**
 * LIS_VENDOR_EXACT_V1 — поле n первого сегмента seg (не MSH) сообщения,
 * компонент 1, чищенное, как эхо; без исключений: нет сегмента — ''. Для MSA-4
 * ответа A1000: OBX-1 (TestRequest_ID) по тесту, OBR-3 (внутренний номер пробы)
 * по пробе (receive.js).
 */
export function firstField(text, seg, n) {
  const m = mshOf(text);
  if (!m.ok) return '';
  const line = String(text).split(SEG).find((s) => s.startsWith(seg + m.fieldSep));
  if (!line) return '';
  const v = line.split(m.fieldSep)[n];
  return echo(String(v == null ? '' : v).split(m.compSep)[0]);
}
