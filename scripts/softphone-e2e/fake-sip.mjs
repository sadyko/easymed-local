// SOFTPHONE_V1 (задача 9) — ПОДСТАВНОЙ SIP-СЕРВЕР ДЛЯ ПРОВЕРКИ В НАСТОЯЩЕМ БРАУЗЕРЕ.
//
// Только для scripts/softphone-e2e/run.mjs: в поставку клинике не едет (scripts/
// нет в ALLOWLIST сборки, scripts/build-bundle.mjs). Пакета `ws` в проекте нет,
// поэтому WebSocket (RFC 6455) — свой и самый маленький: рукопожатие с
// подпротоколом `sip`, снятие маски с кадров клиента, текстовые кадры, ping/pong/close.
//
// Висит на 'upgrade' ТОГО ЖЕ http-сервера, что и Easy-Med (путь /fake-sip): страница
// ходит на свой же адрес, и политика страницы (connect-src 'self') не ослабляется.
//
// РЕЛЕ, А НЕ АТС. Пароль — как у АТС (если задан): REGISTER сначала получает 401,
// первый INVITE — 407, ответ Digest проверяется; дальше REGISTER — 200 OK, а
// остальное пересылается как есть, без своего Via:
//   • новый запрос — по пользователю Request-URI: сначала номер из REGISTER (AOR),
//     затем пользователь Contact (JsSIP шлёт ACK/BYE на sip:<случайное>@<…>.invalid);
//   • ответ — тому, кто прислал запрос с этой веткой (branch верхнего Via);
//   • CANCEL и ACK на не-2xx несут ветку INVITE — идут туда же, куда INVITE.
// В журнал — одна строка на сообщение: метод или код и хвост Call-ID; тела не пишутся.
import crypto from 'node:crypto';
import fs from 'node:fs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length' };

// ── WebSocket ────────────────────────────────────────────────────────────────
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

/** Разобрать готовые кадры из buf; вернуть остаток. onFrame(fin, opcode, payload). */
function readFrames(buf, onFrame) {
  for (;;) {
    if (buf.length < 2) return buf;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return buf; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return buf; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return buf;
    const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
    if (masked) {
      const key = buf.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    buf = buf.subarray(off + maskLen + len);
    onFrame(fin, opcode, payload);
  }
}

// ── SIP ──────────────────────────────────────────────────────────────────────
function parse(text) {
  const cut = text.indexOf('\r\n\r\n');
  const head = (cut < 0 ? text : text.slice(0, cut)).split('\r\n');
  const first = head.shift() || '';
  const headers = [];
  for (const line of head) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const raw = line.slice(0, i).trim().toLowerCase();
    headers.push({ name: COMPACT[raw] || raw, value: line.slice(i + 1).trim() });
  }
  const res = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(first);
  const req = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(first);
  if (!res && !req) return null;
  const get = (n) => { const h = headers.find((x) => x.name === n); return h ? h.value : ''; };
  return {
    status: res ? Number(res[1]) : 0, reason: res ? res[2] : '',
    method: req ? req[1] : (/\s([A-Z]+)\s*$/.exec(get('cseq')) || [])[1] || '',
    ruri: req ? req[2] : '', headers, get,
  };
}
const userOf = (uri) => (/sips?:([^@;>\s]+)@/i.exec(uri || '') || [])[1] || '';
const branchOf = (m) => (/;branch=([^;,\s]+)/i.exec(m.get('via')) || [])[1] || '';

// Пароль, как у АТС: ответ на вызов Digest (MD5, qop=auth) — по одному из выданных nonce.
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
function digestOk(m, header, nonces, password) {
  const h = m.get(header);
  if (!/^Digest\s/i.test(h)) return false;
  const p = {};
  h.replace(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g, (_, k, a, b) => { p[k.toLowerCase()] = a !== undefined ? a : b; return ''; });
  if (!nonces.has(p.nonce)) return false;
  const ha1 = md5(p.username + ':' + p.realm + ':' + password);
  const ha2 = md5(m.method + ':' + p.uri);
  return p.response === (p.qop ? md5([ha1, p.nonce, p.nc, p.cnonce, p.qop, ha2].join(':')) : md5(ha1 + ':' + p.nonce + ':' + ha2));
}

function reply(m, status, reason, extra = []) {
  let to = m.get('to');
  if (!/;tag=/i.test(to)) to += ';tag=' + crypto.randomBytes(5).toString('hex');
  const lines = ['SIP/2.0 ' + status + ' ' + reason];
  for (const h of m.headers) if (h.name === 'via') lines.push('Via: ' + h.value);
  lines.push('From: ' + m.get('from'), 'To: ' + to, 'Call-ID: ' + m.get('call-id'), 'CSeq: ' + m.get('cseq'), ...extra, 'Content-Length: 0', '', '');
  return lines.join('\r\n');
}

/**
 * Повесить реле на server ('upgrade', путь path). logFile — журнал в одну строку
 * на сообщение. password — как у АТС: REGISTER получает 401, первый INVITE — 407,
 * неверный ответ — 403 ('' — без пароля). Возвращает { close() } — закрыть сокеты реле.
 */
export function attachFakeSip(server, { path = '/fake-sip', logFile = '', password = '' } = {}) {
  const aor = new Map();       // номер из REGISTER → сокет
  const contacts = new Map();  // пользователь Contact → сокет
  const branches = new Map();  // ветка запроса → { from, to }
  const nonces = new Set();    // выданные вызовы Digest
  const challenged = new Set(); // ветки INVITE, которым реле само ответило 407: их ACK — реле
  const live = new Set();
  let seq = 0;
  const log = (line) => { if (logFile) try { fs.appendFileSync(logFile, new Date().toISOString().slice(11, 23) + ' ' + line + '\n'); } catch { /* журнал не обязателен */ } };

  function send(ws, text) {
    if (!ws.open) return false;
    ws.sock.write(frame(1, Buffer.from(text, 'utf8')));
    return true;
  }
  function forget(ws) {
    live.delete(ws);
    for (const map of [aor, contacts]) for (const [k, v] of map) if (v === ws) map.delete(k);
    for (const [k, v] of branches) if (v.from === ws || v.to === ws) branches.delete(k);
  }

  /** Нет верного ответа на пароль — вызов (401/407) или отказ (403); true — ответили сами. */
  function refuse(ws, m, header, status, tail) {
    if (!password || digestOk(m, header, nonces, password)) return false;
    if (m.get(header)) {
      send(ws, reply(m, 403, 'Forbidden'));
      log(ws.name + ' ' + m.method + ' → 403 (неверный пароль) …' + tail);
    } else {
      const nonce = crypto.randomBytes(8).toString('hex');
      nonces.add(nonce);
      send(ws, reply(m, status, status === 401 ? 'Unauthorized' : 'Proxy Authentication Required',
        [(status === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate') + ': Digest realm="fake-sip", nonce="' + nonce + '", algorithm=MD5, qop="auth"']));
      log(ws.name + ' ' + m.method + ' → ' + status + ' (пароль) …' + tail);
    }
    if (m.method === 'INVITE') challenged.add(branchOf(m));
    return true;
  }

  function onSip(ws, text) {
    const m = parse(text);
    const tail = (m && m.get('call-id').slice(-6)) || '?';
    if (!m) { log(ws.name + ' ?? не SIP, ' + text.length + ' байт'); return; }
    const cu = userOf(m.get('contact'));
    if (cu) contacts.set(cu, ws);
    if (!m.status) {
      if (m.method === 'REGISTER' && refuse(ws, m, 'authorization', 401, tail)) return;
      if (m.method === 'INVITE' && !/;tag=/i.test(m.get('to')) && refuse(ws, m, 'proxy-authorization', 407, tail)) return;
      if (m.method === 'ACK' && challenged.delete(branchOf(m))) { log(ws.name + ' ACK → реле …' + tail); return; }
      if (m.method === 'REGISTER') {
        const who = userOf(m.get('to'));
        const zero = /expires=0\b/i.test(m.get('contact')) || m.get('expires') === '0';
        if (zero) { if (aor.get(who) === ws) aor.delete(who); } else { aor.set(who, ws); ws.name = 'ws' + ws.id + '(' + who + ')'; }
        const contact = m.get('contact');
        const echo = contact && !/;expires=/i.test(contact) ? contact + ';expires=600' : contact;
        send(ws, reply(m, 200, 'OK', [echo ? 'Contact: ' + echo : '', 'Expires: ' + (zero ? '0' : '600')].filter(Boolean)));
        log(ws.name + ' REGISTER' + (zero ? ' (выход)' : '') + ' → 200 …' + tail);
        return;
      }
      const br = branchOf(m);
      let to = (m.method === 'CANCEL' || m.method === 'ACK') && branches.has(br) ? branches.get(br).to : null;
      if (!to) { const u = userOf(m.ruri); to = aor.get(u) || contacts.get(u) || null; }
      if (!to || !to.open) {
        log(ws.name + ' ' + m.method + ' → некому (' + (userOf(m.ruri) || '?') + ') …' + tail);
        if (m.method !== 'ACK') send(ws, reply(m, 480, 'Temporarily Unavailable'));
        return;
      }
      if (m.method !== 'ACK' && br) branches.set(br, { from: ws, to });
      send(to, text);
      log(ws.name + ' ' + m.method + ' → ' + to.name + ' …' + tail);
      return;
    }
    const t = branches.get(branchOf(m));
    if (!t || !send(t.from, text)) { log(ws.name + ' ' + m.status + ' ' + m.method + ' → потерян …' + tail); return; }
    log(ws.name + ' ' + m.status + ' ' + m.method + ' → ' + t.from.name + ' …' + tail);
  }

  function onUpgrade(req, sock) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { url = null; }
    const key = req.headers['sec-websocket-key'];
    if (!url || url.pathname !== path || !key) { sock.destroy(); return; } // других WebSocket на этом сервере нет
    const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept + '\r\n' + (protos.includes('sip') ? 'Sec-WebSocket-Protocol: sip\r\n' : '') + '\r\n');
    sock.setNoDelay(true);
    const ws = { id: ++seq, sock, open: true, name: '' };
    ws.name = 'ws' + ws.id;
    live.add(ws);
    log(ws.name + ' открыт');
    let buf = Buffer.alloc(0);
    let parts = [];
    sock.on('data', (chunk) => {
      buf = readFrames(Buffer.concat([buf, chunk]), (fin, opcode, payload) => {
        if (opcode === 8) { if (ws.open) { ws.open = false; sock.end(frame(8, payload.subarray(0, 2))); } return; }
        if (opcode === 9) { if (ws.open) sock.write(frame(10, payload)); return; }
        if (opcode === 10) return;
        if (opcode === 1 || opcode === 2 || opcode === 0) {
          parts.push(payload);
          if (!fin) return;
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          try { onSip(ws, text); } catch (e) { log(ws.name + ' ошибка реле: ' + (e && e.message)); }
        }
      });
    });
    const done = () => { if (!live.has(ws)) return; ws.open = false; forget(ws); log(ws.name + ' закрыт'); };
    sock.on('close', done);
    sock.on('error', done);
  }
  server.on('upgrade', onUpgrade);
  return {
    close() {
      server.off('upgrade', onUpgrade);
      for (const ws of [...live]) { ws.open = false; try { ws.sock.destroy(); } catch { /* уже закрыт */ } forget(ws); }
    },
  };
}
