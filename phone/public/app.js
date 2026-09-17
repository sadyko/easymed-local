// EASYPHONE_V1 — экран рабочего места телефониста.
//
// Одна страница и никакой оболочки: это не второй EasyMed. Всё, что делает
// оператор за смену, должно быть видно без переходов — своя трубка, наборник и
// журнал звонков рядом.
//
// Никаких сборок и зависимостей: обычный модуль в браузере, как и весь клиент
// EasyMed. Программа живёт в клинике без интернета, и «сначала соберите» здесь
// не работает.

const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || 'Не удалось выполнить запрос.');
  return body;
};

// Номер показывается ровно так, как набран: плюс дописывается только там, где
// он уже есть. Это наборник, а не карточка — придуманный код страны здесь врёт.
const groupTyped = (v) => {
  const plus = String(v).startsWith('+');
  const d = String(v).replace(/\D+/g, '');
  return (plus ? '+' : '') + d.replace(/(\d{3})(?=\d)/g, '$1 ');
};
const digits = (v) => String(v || '').replace(/\D+/g, '');

// Узбекский номер из девяти цифр — для показа в журнале.
const pretty = (v) => {
  const d = digits(v);
  const n = d.length === 9 ? '998' + d : d;
  if (n.length === 12 && n.startsWith('998')) {
    return '+998 ' + n.slice(3, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8, 10) + ' ' + n.slice(10);
  }
  return d ? '+' + n : '—';
};

const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return sameDay ? time : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + time;
};

const talk = (sec) => {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (!n) return '';
  return n >= 60 ? Math.floor(n / 60) + ' мин ' + (n % 60) + ' сек' : n + ' сек';
};

let value = '';
let me = null;
// Пока оператор слушает запись или только что нажал «Прослушать», таблицу
// перерисовывать НЕЛЬЗЯ: обновление раз в семь секунд стирало открытый плеер
// вместе со строкой, и это выглядело как «кнопка не работает».
let holdUntil = 0;
const busyWithAudio = () => Date.now() < holdUntil || !!document.querySelector('#rows audio');

function paintNumber() {
  $('num').textContent = value ? groupTyped(value) : 'Наберите номер';
  $('num').style.color = value ? '' : '#9aa7ae';
  const ok = digits(value).length >= 7;
  $('call').disabled = !ok;
  $('dialHint').textContent = ok
    ? 'Сначала зазвонит ваша трубка — снимите её, и пойдёт вызов пациенту'
    : 'Наберите номер целиком';
}

function buildPad() {
  const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
                ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
  const pad = $('pad');
  for (const [k, sub] of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', 'Цифра ' + k);
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = k;
    b.querySelector('span').textContent = sub;
    b.addEventListener('click', () => { value += k; paintNumber(); });
    // Долгое нажатие на ноль даёт «+» — привычка любого телефона.
    b.addEventListener('contextmenu', (e) => { if (k === '0') { e.preventDefault(); value += '+'; paintNumber(); } });
    pad.appendChild(b);
  }
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'Backspace') { e.preventDefault(); value = value.slice(0, -1); paintNumber(); }
    else if (e.key === 'Enter') { if (!$('call').disabled) $('call').click(); }
    else if (/^[0-9*#+]$/.test(e.key)) { e.preventDefault(); value += e.key; paintNumber(); }
  });
}

function say(box, text, ok) {
  box.innerHTML = '';
  if (!text) return;
  const d = document.createElement('div');
  d.className = 'msg ' + (ok ? 'ok' : 'bad');
  d.textContent = text;
  box.appendChild(d);
}

async function loadMe() {
  me = await api('/api/me');
  $('who').textContent = me.full_name || '';
  $('line').textContent = me.line ? 'Линия: ' + (me.line === 'onlinepbx' ? 'onlinePBX' : me.line) : 'Линия не настроена';

  // Список номеров: сначала то, что знает станция, иначе — те, что видели в
  // журнале. Пустой список не беда: можно оставить «не выбран».
  let list = [];
  try { list = (await api('/api/extensions')).extensions || []; } catch (e) { /* станция молчит — не беда */ }
  if (!list.length) list = me.seen_extensions || [];
  const sel = $('ext');
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'не выбран — программа подберёт сама';
  sel.appendChild(none);
  for (const num of list) {
    const o = document.createElement('option');
    o.value = num; o.textContent = num;
    if (String(me.extension) === String(num)) o.selected = true;
    sel.appendChild(o);
  }
}

async function loadCalls() {
  const { calls } = await api('/api/calls?limit=60');
  const rows = $('rows');
  rows.innerHTML = '';
  if (!calls.length) {
    rows.innerHTML = '<tr><td colspan="6">Звонков пока нет.</td></tr>';
    return;
  }
  // «Сейчас звонят»: входящий за последние две минуты, на который ещё не
  // ответили. Это то, ради чего оператор смотрит на экран.
  const now = Date.now();
  const live = calls.find((c) => Number(c.call_type) === 0 && !Number(c.billsec)
    && now - Date.parse(c.started_at) < 2 * 60000);
  $('live').hidden = !live;
  if (live) $('live').textContent = 'Сейчас звонят: ' + (live.patient_name || pretty(live.external_number));

  for (const c of calls) {
    const tr = document.createElement('tr');
    const out = Number(c.call_type) === 1;
    const answered = Number(c.billsec) > 0;
    const cell = (html) => { const td = document.createElement('td'); td.append(html); return td; };

    const dir = document.createElement('span');
    dir.className = out ? 'out' : (answered ? 'in' : 'miss');
    dir.textContent = out ? 'Исходящий' : (answered ? 'Входящий' : 'Пропущен');

    tr.appendChild(cell(when(c.started_at)));
    tr.appendChild(cell(c.patient_name ? c.patient_name + (c.patient_mrn ? ' · ' + c.patient_mrn : '') : '—'));
    tr.appendChild(cell(pretty(c.external_number)));
    const res = document.createElement('td');
    res.appendChild(dir);
    if (answered) { const s = document.createElement('div'); s.textContent = talk(c.billsec); s.style.color = '#55636d'; s.style.fontSize = '12.5px'; res.appendChild(s); }
    tr.appendChild(res);
    tr.appendChild(cell(c.operator_name || c.internal_number || '—'));

    const rec = document.createElement('td');
    if (answered) {
      const b = document.createElement('button');
      b.textContent = 'Прослушать';
      b.addEventListener('click', async () => {
        holdUntil = Date.now() + 60000;
        b.disabled = true; b.textContent = 'Ищем…';
        try {
          const r = await api('/api/recording?call_id=' + encodeURIComponent(c.id));
          if (!r.url) { b.textContent = 'Записи нет'; return; }
          const a = document.createElement('audio');
          a.controls = true; a.autoplay = true; a.src = r.url;
          b.replaceWith(a);
        } catch (e) { b.textContent = 'Не вышло'; b.title = e.message; }
        finally { b.disabled = false; }
      });
      rec.appendChild(b);
    } else {
      rec.textContent = '—';
    }
    tr.appendChild(rec);
    rows.appendChild(tr);
  }
}

async function start() {
  buildPad();
  paintNumber();
  try { await loadMe(); } catch (e) { say($('dialMsg'), e.message, false); }

  $('saveExt').addEventListener('click', async () => {
    try {
      await api('/api/my-extension', { method: 'POST', body: JSON.stringify({ extension: $('ext').value }) });
      $('extHint').textContent = $('ext').value
        ? 'Готово: звонки будут поднимать трубку ' + $('ext').value + '.'
        : 'Готово: номер не задан — программа подберёт живую трубку сама.';
    } catch (e) { $('extHint').textContent = e.message; }
  });

  $('call').addEventListener('click', async () => {
    const btn = $('call');
    btn.disabled = true; btn.textContent = 'Звоним…';
    try {
      const r = await api('/api/dial', { method: 'POST', body: JSON.stringify({ phone: value }) });
      say($('dialMsg'), r.from ? ('Сейчас зазвонит трубка ' + r.from + ' — снимите её') : 'Сейчас зазвонит ваша трубка', true);
      setTimeout(loadCalls, 4000);
    } catch (e) {
      say($('dialMsg'), e.message, false);
    } finally { btn.disabled = false; btn.textContent = 'Позвонить'; paintNumber(); }
  });

  await loadCalls().catch((e) => say($('dialMsg'), e.message, false));
  // Экран телефониста должен обновляться сам: он смотрит на него, а не жмёт F5.
  setInterval(() => { if (!busyWithAudio()) loadCalls().catch(() => {}); }, 7000);
}

start();
