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
      observations.push({
        valueType: (f[2] || '').trim(),
        code: comp(f[3])[0].trim(),
        value: (f[5] || '').trim(),
        unit: comp(f[6])[0].trim(),
        range: (f[7] || '').trim(),
        abnormal: (f[8] || '').trim(),
        status: (f[11] || '').trim(),
      });
    }
  }

  return { type, controlId, sampleId, observations, sep: { fieldSep, compSep, repSep, escChar, subSep } };
}

/**
 * ACK (`AA`) или NAK (`AE`). Номер исходного сообщения обязателен: по нему
 * прибор понимает, на что именно ему ответили, и решает, повторять ли.
 */
export function buildAck(controlId, code) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return [
    `MSH|^~\\&|EASYMED|CLINIC|||${stamp}||ACK|${controlId || '1'}|P|2.3.1`,
    `MSA|${code}|${controlId || ''}`,
  ].join('\r');
}
