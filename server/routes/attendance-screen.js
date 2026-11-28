// STAFF_ATTENDANCE_V1 — экран у входа: меняющийся QR для отметки прихода/ухода.
//
// Экран — любой компьютер, планшет или телевизор у входа с браузером в сети
// клиники. Открывается ссылкой /attendance-screen/<точка>?k=<ключ экрана> без
// входа в программу (у входа никто не залогинен), поэтому:
//   * ключ экрана (display_key, 24+ случайных байт) — отдельный от секрета
//     подписи: по ключу экрана можно только СМОТРЕТЬ текущий код, но не
//     посчитать коды вперёд или назад. Утекла ссылка — HR жмёт «Новая ссылка
//     экрана», старая перестаёт работать;
//   * ключ сравнивается за постоянное время, неверный — 404 (не подсказываем,
//     что точка существует);
//   * частота ограничена: экран спрашивает раз в окно (≥ 3 с, т. е. до 20 раз
//     в минуту), 60 запросов в минуту с адреса — с запасом для двух экранов
//     за одним NAT.
import express from 'express';
import crypto from 'node:crypto';
import { currentWindow, secondsLeft, deepLink, qrSvg, rotateOf } from '../services/attendance/tokens.js';

const RATE_PER_MIN = 60;   // STAFF_ATTENDANCE_FAST_QR_V1 — экран с окном 3 с спрашивает 20 раз в минуту
const hits = new Map();   // ip → { minute, n }

function limited(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const h = hits.get(ip);
  if (!h || h.minute !== minute) { hits.set(ip, { minute, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  h.n += 1;
  return h.n > RATE_PER_MIN;
}

function findLocation(db, id, key) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const loc = db.prepare('SELECT * FROM attendance_locations WHERE id = ?').get(n);
  if (!loc) return null;
  const a = Buffer.from(String(loc.display_key));
  const b = Buffer.from(String(key || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return loc;
}

/** JSON для экрана: текущий QR (SVG) и когда спросить снова. */
export function attendanceScreenApi(db) {
  const r = express.Router();
  r.get('/:id/qr', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (limited(req.ip || '')) return res.status(429).json({ error: { code: 'rate_limited', message: 'Слишком часто.' } });
    const loc = findLocation(db, req.params.id, req.query.k);
    if (!loc) return res.status(404).json({ error: { code: 'not_found', message: 'Экран не найден. Попросите в отделе кадров новую ссылку экрана.' } });
    const branch = loc.branch_id ? db.prepare('SELECT name FROM branches WHERE id = ?').get(loc.branch_id) : null;
    const bot = db.prepare('SELECT enabled, bot_username FROM staff_bot_settings WHERE id = 1').get() || {};
    const base = { location: loc.name, branch: branch ? branch.name : '', seconds_left: secondsLeft(rotateOf(loc)) };
    if (!loc.active) return res.json({ ...base, state: 'inactive', svg: '' });
    if (!bot.enabled || !bot.bot_username) return res.json({ ...base, state: 'bot_off', svg: '' });
    const window = currentWindow(rotateOf(loc));
    return res.json({ ...base, state: 'ok', svg: qrSvg(deepLink(bot.bot_username, loc, window)) });
  });
  return r;
}

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Отметка прихода и ухода</title>
<style>
  html,body{margin:0;height:100%;background:#f4f6fa;color:#0f172a;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;text-align:center}
  h1{margin:0;font-size:clamp(22px,4vw,40px)} .sub{color:#475569;font-size:clamp(14px,2vw,20px)}
  .qr{width:min(70vh,80vw);height:min(70vh,80vw);background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(15,23,42,.12);display:flex;align-items:center;justify-content:center}
  .qr svg{width:92%;height:92%} .msg{max-width:28em;padding:24px;color:#475569;font-size:18px}
  .bar{width:min(70vh,80vw);height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden} .bar i{display:block;height:100%;background:#1e3a8a;width:100%;transition:width 1s linear}
  .hint{font-size:clamp(13px,1.8vw,18px);color:#334155;line-height:1.5}
</style></head><body><div class="wrap">
<h1 id="loc">…</h1><div class="sub" id="branch"></div>
<div class="qr" id="qr"><div class="msg">Загрузка…</div></div>
<div class="bar"><i id="bar"></i></div>
<div class="hint">Наведите камеру телефона на код — откроется бот EasyMed Staff. Код меняется каждые несколько секунд.<br>
Telefon kamerasini kodga qarating — EasyMed Staff boti ochiladi. Kod har bir necha soniyada almashadi.</div>
</div><script>
(function(){
  var m = location.pathname.match(/\\/attendance-screen\\/(\\d+)/); var k = new URLSearchParams(location.search).get('k') || '';
  var qr = document.getElementById('qr'), bar = document.getElementById('bar');
  function msg(t){ qr.innerHTML = '<div class="msg"></div>'; qr.firstChild.textContent = t; }
  function tick(){
    fetch('/api/attendance-screen/' + (m ? m[1] : '0') + '/qr?k=' + encodeURIComponent(k), { cache: 'no-store' })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(x){
        if (!x.ok) { msg((x.j.error && x.j.error.message) || 'Экран недоступен.'); setTimeout(tick, 15000); return; }
        var j = x.j; document.getElementById('loc').textContent = j.location; document.getElementById('branch').textContent = j.branch || '';
        if (j.state === 'ok') qr.innerHTML = j.svg;
        else msg(j.state === 'inactive' ? 'Эта точка входа отключена.' : 'Бот сотрудников ещё не включён в программе.');
        var left = Math.max(1, j.seconds_left || 10);
        bar.style.transition = 'none'; bar.style.width = '100%'; void bar.offsetWidth;
        bar.style.transition = 'width ' + left + 's linear'; bar.style.width = '0%';
        setTimeout(tick, left * 1000 + 300);
      })
      .catch(function(){ msg('Нет связи с сервером клиники. Повтор через 10 секунд.'); setTimeout(tick, 10000); });
  }
  tick();
})();
</script></body></html>`;

/** Сама страница экрана. Ключ проверяет JSON выше — страница без данных. */
export function attendanceScreenPage() {
  const r = express.Router();
  r.get('/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.type('html').send(PAGE);
  });
  return r;
}
