// WEBSITE_PREVIEW_V1 (2026-11-25) — «Живой просмотр» справа от редактора сайта.
//
// Страницу рисует сервер теми же рендерами, что и сайт (rpc website_preview), с правками,
// которых ещё нет в базе. Рамка — sandbox="allow-scripts" без allow-same-origin: HTML карты из
// настроек не получает доступа к программе (подробнее — server/site/preview.js).
//
// Новая страница грузится в скрытую рамку и подменяет старую уже готовой, на той же высоте
// прокрутки: иначе на каждую букву экран мигал бы белым и прыгал в начало.
import { h, Icon, clear } from '../ui.js';

const DEVICES = {
    desktop: { width: 1280, label: 'Компьютер' },
    phone:   { width: 390,  label: 'Телефон' },
};
const DELAY = 350;
// Время рендера в скрытом поле формы меняется каждый раз — странице это не правка.
const sameKey = (html) => html.replace(/name="ts" value="\d+"/g, '');

let current = null;   // одна панель на программу: слушатель сообщений — один на окно
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('message', (e) => { if (current) current.onMessage(e); });
}

/**
 * load(path)  → Promise<html>   path — с языком: '/ru/doctors'
 * getLang()   → 'uz' | 'ru' | 'en'
 * onLang(l)   — посетитель переключил язык внутри просмотра
 */
export function createPreview({ load, getLang, onLang }) {
    let path = '/';          // без языка
    let device = 'desktop';
    let y = 0;
    let target = null;
    let frame = null;
    let shownKey = null;
    let seq = 0;
    let timer = null;

    const stage = h('div', { class: 'ws-pv-stage' });
    const status = h('span', { class: 'ws-pv-status', role: 'status', 'aria-live': 'polite', 'data-ws-preview-status': '' });
    const address = h('span', { class: 'ws-pv-address', 'data-ws-preview-path': '' });
    const deviceBtns = Object.entries(DEVICES).map(([id, d]) => {
        const b = h('button', { type: 'button', class: 'ws-seg', 'data-ws-device': id, onclick: () => { device = id; paintDevice(); } }, d.label);
        return [id, b];
    });
    const refreshBtn = h('button', { type: 'button', class: 'ws-icon-btn', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => refresh({ force: true }) },
        Icon('Refresh', { size: 15 }));

    const el = h('aside', { class: 'ws-pv', 'aria-label': 'Живой просмотр', 'data-ws-preview': '' },
        h('div', { class: 'ws-pv-bar' },
            h('strong', null, 'Живой просмотр'), status, h('span', { class: 'grow' }),
            h('div', { class: 'ws-segs' }, ...deviceBtns.map(([, b]) => b)), refreshBtn),
        h('div', { class: 'ws-pv-window' },
            h('div', { class: 'ws-pv-url' }, Icon('Globe', { size: 13 }), address),
            stage));

    function fit() {
        const w = stage.clientWidth || 0;
        const hgt = stage.clientHeight || 0;
        if (!w || !hgt || !frame) return;
        const width = DEVICES[device].width;
        const k = Math.min(1, w / width);
        Object.assign(frame.style, {
            width: width + 'px', height: Math.ceil(hgt / k) + 'px', transform: `scale(${k})`,
            left: Math.max(0, Math.round((w - width * k) / 2)) + 'px',
        });
    }
    function paintDevice() {
        for (const [id, b] of deviceBtns) {
            b.classList.toggle('on', id === device);
            b.setAttribute('aria-pressed', id === device ? 'true' : 'false');
        }
        stage.classList.toggle('is-phone', device === 'phone');
        fit();
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(stage);

    // Панель — ровно до низа окна: полосы над экраном (обновление, разделы) бывают разной
    // высоты, и число в CSS либо обрезало бы сайт снизу, либо оставляло пустоту.
    let raf = 0;
    const place = () => {
        if (raf || !el.isConnected) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            const top = el.getBoundingClientRect().top;
            el.style.height = Math.max(420, window.innerHeight - Math.max(top, 0) - 18) + 'px';
        });
    };
    if (typeof ResizeObserver !== 'undefined') {
        window.addEventListener('resize', place);
        document.addEventListener('scroll', place, { capture: true, passive: true });
        setTimeout(place, 0);
    }

    const fullPath = () => '/' + getLang() + (path === '/' ? '/' : path);
    function post(msg) {
        try { frame.contentWindow.postMessage({ ws: 'editor', ...msg }, '*'); } catch { /* рамки ещё нет */ }
    }

    function swap(html) {
        const next = document.createElement('iframe');
        next.setAttribute('sandbox', 'allow-scripts');
        next.setAttribute('title', 'Сайт');
        next.setAttribute('tabindex', '-1');
        next.className = 'ws-pv-frame is-loading';
        next.addEventListener('load', () => {
            if (next !== frame) { next.remove(); return; }
            post(target ? { target, y } : { y });
            target = null;
            for (const old of [...stage.children]) if (old !== next) old.remove();
            next.classList.remove('is-loading');
        });
        frame = next;
        next.srcdoc = html;
        stage.appendChild(next);
        fit();
    }

    async function refresh({ force = false } = {}) {
        if (timer) { clearTimeout(timer); timer = null; }
        const mine = ++seq;
        address.textContent = fullPath();
        status.textContent = '';
        try {
            const html = await load(fullPath());
            if (mine !== seq) return;   // пришёл ответ на уже устаревший черновик
            const key = fullPath() + '\n' + sameKey(html);
            if (key === shownKey && !force) { if (target) { post({ target }); target = null; } return; }
            shownKey = key;
            swap(html);
        } catch (e) {
            if (mine !== seq) return;
            if (!frame) {
                clear(stage);
                stage.appendChild(h('div', { class: 'ws-pv-empty' }, String((e && e.message) || '')));
            } else status.textContent = String((e && e.message) || '');
        }
    }

    const api = {
        el,
        refresh,
        schedule() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; refresh(); }, DELAY);
        },
        /** Открыть страницу сайта и, если задано, прокрутить к её части. */
        show(nextPath, sel = null) {
            target = sel;
            if (nextPath === path && frame) {
                if (sel) { post({ target: sel }); target = null; }
                return;
            }
            path = nextPath;
            y = 0;
            refresh();
        },
        onMessage(e) {
            if (!frame || e.source !== frame.contentWindow) return;
            const d = e.data || {};
            if (d.ws !== 'preview') return;
            if (d.type === 'scroll') { y = Number(d.y) || 0; return; }
            const m = d.type === 'nav' ? /^\/(uz|ru|en)(\/.*)?$/.exec(String(d.path || '').split('?')[0]) : null;
            if (!m) return;
            path = (m[2] || '/').replace(/(.)\/+$/, '$1');
            y = 0; target = null;
            if (m[1] !== getLang()) onLang(m[1]); else refresh();
        },
        destroy() { window.removeEventListener?.('resize', place); document.removeEventListener?.('scroll', place, { capture: true }); if (timer) clearTimeout(timer); seq++; if (current === api) current = null; },
    };
    if (current) current.destroy();
    current = api;
    paintDevice();
    return api;
}
