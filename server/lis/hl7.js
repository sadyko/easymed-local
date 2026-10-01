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

/**
 * Заголовок сообщения без исключений.
 * @returns {{ok:boolean, fieldSep:string, compSep:string, app:string, facility:string,
 *   appField:string, facilityField:string, type:string, event:string, controlId:string,
 *   version:string, ackType:string, charset:string}}
 *   app/facility — компонент 1 MSH-3/MSH-4 (как прибор себя назвал);
 *   appField/facilityField — поля целиком, для эха в MSH-5/6 ответа;
 *   type — 'ORU^R01' в нашем виде, event — 'R01';
 *   ackType — MSH-16 (у Mindray и Autobio: 0 — проба, 1 — калибровка, 2 — контроль);
 *   charset — MSH-18.
 */
export function mshOf(text) {
  const out = { ok: false, fieldSep: '|', compSep: '^', app: '', facility: '', appField: '', facilityField: '',
    type: '', event: '', controlId: '', version: '', ackType: '', charset: '' };
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
    controlId: (f[9] || '').trim(),
    version: (f[11] || '').trim(),
    ackType: (f[15] || '').trim(),
    charset: (f[17] || '').trim(),
  };
}

/**
 * Заголовок ответа: «MSH|^~\&|EASYMED|CLINIC|<MSH-3>|<MSH-4>|<время>||<тип>|
 * <MSH-10>|P|<MSH-12 или 2.3.1>||||<MSH-16>||<MSH-18>». MSH-5/6 — эхо MSH-3/4
 * входящего (с. 8: «fields 5 and 6 are set to Manufacturer and Model»), MSH-10
 * — номер входящего (с. 25: «returned unchanged in the response message»),
 * MSH-16 и MSH-18 — эхом (с. 27: у ответа на контроль стоит 2). Пустые поля в
 * конце не пишутся: у прибора без MSH-16/18 заголовок кончается на MSH-12, как
 * и до этой правки.
 */
export function replyMsh(msh, type) {
  const m = msh || mshOf('');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const f = ['MSH', '^~\\&', 'EASYMED', 'CLINIC', m.appField || '', m.facilityField || '', stamp, '', type,
    m.controlId || '1', 'P', m.version || '2.3.1', '', '', '', m.ackType || '', '', m.charset || ''];
  while (f.length > 12 && f[f.length - 1] === '') f.pop();
  return f.join('|');
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
 * ACK (`AA`), NAK (`AE`) или отказ без повтора (`AR`). Номер исходного
 * сообщения обязателен: по нему прибор понимает, на что именно ему ответили, и
 * решает, повторять ли.
 *
 * LIS_REAL_ANALYZERS_V1_ACK — `msh` — заголовок входящего (mshOf). Строка
 * вместо него — прежняя форма: номер исходного сообщения.
 * @param {ReturnType<typeof mshOf>|string} msh
 * @param {'AA'|'AE'|'AR'} code
 * @param {{text?:string, error?:string}} [why]  MSA-3/MSA-6 вместо принятых для кода (ACK_INTERNAL)
 */
export function buildAck(msh, code, why = {}) {
  const m = typeof msh === 'string' || msh == null ? { ...mshOf(''), controlId: String(msh == null ? '' : msh).trim() } : msh;
  const c = MSA_TEXT[code] ? code : 'AE';
  const text = why.text || MSA_TEXT[c].text;
  const error = why.error || MSA_TEXT[c].error;
  return [
    replyMsh(m, m.event ? 'ACK^' + m.event : 'ACK'),
    ['MSA', c, m.controlId || '', text, '', '', error].join('|'),
  ].join('\r');
}

/**
 * LIS_REAL_ANALYZERS_V1_SERVICE — ответ на запрос рабочего списка: «заказов
 * нет». Easy-Med остаётся «только результаты» и заказов приборам не отдаёт
 * (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел 7).
 *
 *   QRY^Q02 (BS-200, химия Mindray) → QCK^Q02: MSA AA, ERR|0, QAK|SR|NF —
 *     руководство BS-200, с. 28, дословно («If the sample of the bar code does
 *     not exist»); с QRD-9 = CAN (отмена группового, с. 34) — тот же ответ;
 *   QRY^Q01 (Autobio) → DSR^Q01: MSA AA, ERR|0, QAK|SR|NF, эхо QRD и QRF, без
 *     DSP — по образцу AutoLumoHL7.cs (там QAK|SR|OK и DSP с заказом); «нет
 *     данных» — по аналогии, ПРОВЕРИТЬ НА ПРИБОРЕ;
 *   ORM^O01 (гематология Mindray) → ACK^O01 «принято» — документа нет,
 *     ПРОВЕРИТЬ НА ПРИБОРЕ.
 * @param {object} env  readEnvelope() запроса (wire.js): заголовок, qrd, qrf
 */
export function buildQueryReply(env) {
  const msa = ['MSA', 'AA', env.controlId || '', MSA_TEXT.AA.text, '', '', MSA_TEXT.AA.error].join('|');
  if (env.type === 'QRY^Q02') return [replyMsh(env, 'QCK^Q02'), msa, 'ERR|0', 'QAK|SR|NF'].join('\r');
  if (env.type === 'QRY^Q01') return [replyMsh(env, 'DSR^Q01'), msa, 'ERR|0', 'QAK|SR|NF', env.qrd, env.qrf].filter(Boolean).join('\r');
  return buildAck(env, 'AA');
}
