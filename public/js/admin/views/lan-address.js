// LAN_ADDRESS_V1 — экран «Адрес в сети» (Настройки → Настройки Easy-Med).
//
// Владелец: компьютер-сервер после каждого перезапуска получает от роутера новый
// адрес (192.168.1.147 → .156 → .145), и остальные компьютеры и анализаторы
// теряют сервер. Экран отвечает на три вопроса:
//   1. какой адрес у сервера сейчас (и какой физический адрес — MAC — у его
//      сетевой карты, чтобы закрепить адрес в роутере), с кнопками «Копировать»;
//   2. как открыть Easy-Med по имени, которое не меняется (http://<имя>.local:8000,
//      ответчик server/services/lan/mdns.js), и почему оно может не открываться;
//   3. как закрепить адрес в роутере — по шагам, для частых роутеров.
// Если адрес сменился с прошлого запуска — сверху предупреждение; администратор
// скрывает его до следующей смены (тот же сигнал — баннер notifications.js).
//
// Отдельный экран, а не карточка в «Системе»: владелец оставил «Систему» —
// «только версия и что нового» (SETTINGS_SPLIT_V1).
//
// Кнопки «Скрыть» и «Выключить имя» — только администратору; сервер проверяет
// сам (rpc/lan-address.js). Все строки — через tr()/trf() (ru/uz/en).
import { h, Icon, Tag, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';

const FIREWALL_CMD = 'netsh advfirewall firewall add rule name="EasyMed (network name)" dir=in action=allow protocol=UDP localport=5353';

/** Выделить текст, чтобы его скопировали Ctrl+C (по http в сети буфер обмена браузер не даёт). */
function selectContents(el) {
    try {
        const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (!sel || typeof document.createRange !== 'function') return;
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
    } catch { /* выделение — удобство, не обязанность */ }
}

async function copyText(text, codeEl) {
    const cb = (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
    try {
        if (!cb || typeof cb.writeText !== 'function') throw new Error('no clipboard');
        await cb.writeText(text);
        toast(tr('Скопировано'), 'ok');
    } catch {
        selectContents(codeEl);
        toast(tr('Скопируйте вручную'), 'info');
    }
}

/** Значение с кнопкой «Копировать»: код выделяется целиком одним щелчком. */
function copyRow(value, label) {
    const code = h('code', { class: 'lan-code', translate: 'no' }, value);
    const btn = h('button', { class: 'btn btn-outline btn-sm lan-copy', type: 'button',
        'aria-label': trf('Копировать: {what}', { what: label }), onclick: () => copyText(value, code) },
        Icon('Copy', { size: 13 }), ' ', tr('Копировать'));
    return h('div', { class: 'lan-copyrow' }, code, btn);
}

function kv(label, valueEl) {
    return [h('dt', null, label), h('dd', null, valueEl)];
}

/** Состояние имени — словами (и оттенок метки). */
export function nameStateView(name) {
    const st = name && name.state, rs = name && name.reason;
    if (st === 'active') return { text: tr('работает'), kind: 'success' };
    if (st === 'probing' || st === 'starting') return { text: tr('проверяется'), kind: 'info' };
    if (st === 'conflict') return { text: tr('имя занято'), kind: 'warn' };
    if (st === 'failed') return { text: tr('не работает'), kind: 'warn' };
    if (st === 'off' && rs === 'env_off') return { text: tr('выключено на этом компьютере'), kind: '' };
    return { text: tr('выключено'), kind: '' };
}

export async function renderLanAddress(root) {
    const wrap = h('div', { class: 'fade-in lan-wrap' });
    root.appendChild(wrap);
    wrap.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, tr('Адрес в сети')),
            h('p', { class: 'page-subtitle' }, tr('По этому адресу другие компьютеры клиники и анализаторы находят сервер Easy-Med.')))));
    const body = h('div', { class: 'lan-body' });
    wrap.appendChild(body);

    let st = null;
    let busy = false;

    async function load() {
        try {
            const { data, error } = await supabase.rpc('lan_address_status', {});
            if (error) throw error;
            st = data || null;
        } catch (e) {
            st = null;
            clear(body);
            body.appendChild(h('div', { class: 'card lan-card' }, h('p', { class: 'lan-p' },
                tr('Не удалось узнать адрес сервера.') + ' ' + tr(String((e && e.message) || '')))));
            return false;
        }
        return true;
    }

    async function act(name, args, okText) {
        if (busy) return;
        busy = true;
        try {
            const { data, error } = await supabase.rpc(name, args);
            if (error) throw error;
            st = data || st;
            if (okText) toast(okText, 'ok');
            // Баннер и колокол (notifications.js) перерисуются сразу, не через минуту.
            try { window.dispatchEvent(new CustomEvent('em:lan-address')); } catch { /* нет окна — нечего обновлять */ }
        } catch (e) {
            toast(e && e.message ? tr(String(e.message)) : tr('Ошибка'), 'fail');
        } finally {
            busy = false;
            paint();
        }
    }

    function changeCard(c) {
        return h('div', { class: 'card lan-card lan-warn', role: 'alert' },
            h('div', { class: 'lan-warn-head' }, Icon('Warning', { size: 17 }),
                h('h3', null, trf('Адрес сервера изменился: было {from}, стало {to}.', { from: c.from.join(', '), to: c.to.join(', ') }))),
            h('p', { class: 'lan-p' }, tr('Другие компьютеры и анализаторы могут не находить сервер. Закрепите адрес в роутере — как это сделать, написано ниже.')),
            st.can_manage
                ? h('div', { class: 'lan-actions' }, h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                    onclick: () => act('lan_address_dismiss', { at: c.at }, tr('Скрыто до следующей смены адреса')) }, tr('Скрыть до следующей смены адреса')))
                : null);
    }

    function addressCard() {
        const card = h('div', { class: 'card lan-card' },
            h('h3', { class: 'lan-h' }, Icon('Building', { size: 15 }), ' ', tr('Этот компьютер')));
        const list = st.addresses || [];
        if (!list.length) {
            card.appendChild(h('p', { class: 'lan-p' }, tr('Этот компьютер сейчас не подключён к сети: ни одного адреса нет.')));
            return card;
        }
        if (list.length > 1) {
            card.appendChild(h('p', { class: 'lan-p muted' }, tr('У компьютера несколько сетевых карт, у каждой свой адрес. Закрепляйте адрес той карты, через которую подключены остальные компьютеры клиники.')));
        }
        for (const a of list) {
            const url = 'http://' + a.address + ':' + st.port;
            card.appendChild(h('dl', { class: 'lan-kv' },
                ...kv(tr('Адрес'), copyRow(a.address, tr('Адрес'))),
                ...kv(tr('Открыть с другого компьютера'), copyRow(url, tr('Открыть с другого компьютера'))),
                ...kv(tr('Сетевая карта'), h('span', { translate: 'no' }, a.adapter)),
                ...kv(tr('Физический адрес (MAC)'), a.mac ? copyRow(a.mac, tr('Физический адрес (MAC)')) : h('span', { class: 'muted' }, '—'))));
        }
        return card;
    }

    function nameCard() {
        const n = st.name || {};
        const view = nameStateView(n);
        const card = h('div', { class: 'card lan-card' },
            h('div', { class: 'lan-name-head' },
                h('h3', { class: 'lan-h' }, Icon('Globe', { size: 15 }), ' ', tr('Имя в сети')),
                Tag(view.text, { kind: view.kind })));
        card.appendChild(h('p', { class: 'lan-p' }, tr('Другие компьютеры клиники могут открывать Easy-Med по имени: оно не меняется, даже когда роутер выдаёт новый адрес. Работает в Windows 10 и 11; на старых компьютерах открывайте по адресу-числу.')));
        if (n.url) card.appendChild(copyRow(n.url, tr('Имя в сети')));
        if (n.suffixed && n.state !== 'conflict') {
            card.appendChild(h('p', { class: 'lan-p lan-note' }, trf('Имя {base}.local уже занято другим сервером Easy-Med в этой сети — этот компьютер отвечает на имя {name}.', { base: n.base, name: n.current })));
        }
        if (n.state === 'failed') card.appendChild(h('p', { class: 'lan-p lan-note' }, tr('Имя в сети не запустилось на этом компьютере (порт 5353 занят или закрыт). Открывайте Easy-Med по адресу-числу.')));
        if (n.state === 'conflict') card.appendChild(h('p', { class: 'lan-p lan-note' }, tr('Все имена заняты другими компьютерами — имя в сети не работает. Задайте другое «имя в адресе» в разделе «API».')));
        if (n.reason === 'no_multicast') card.appendChild(h('p', { class: 'lan-p lan-note' }, tr('Сетевая карта не пропускает групповые запросы — другие компьютеры могут не находить имя.')));
        if (n.state === 'off' && n.reason === 'env_off') card.appendChild(h('p', { class: 'lan-p muted' }, tr('Имя в сети выключено настройкой запуска этого компьютера (EASYMED_MDNS=0).')));
        card.appendChild(h('p', { class: 'lan-p muted' }, tr('Имя берётся из «имени в адресе» (Настройки → API); если оно не задано — easymed.')));
        card.appendChild(h('p', { class: 'lan-p muted' }, tr('Анализаторы указывают адрес сервера числом — имя им не поможет. Для них адрес нужно закрепить в роутере.')));
        card.appendChild(h('p', { class: 'lan-p' }, tr('Если имя не открывается на других компьютерах — на этом компьютере один раз выполните от имени администратора:')));
        card.appendChild(copyRow(FIREWALL_CMD, tr('команда')));
        if (st.can_manage && n.reason !== 'env_off') {
            const on = st.mdns_enabled !== false;
            card.appendChild(h('div', { class: 'lan-actions' }, h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => act('lan_address_mdns', { enabled: !on }, on ? tr('Имя в сети выключено') : tr('Имя в сети включено')) },
                on ? tr('Выключить имя в сети') : tr('Включить имя в сети'))));
        }
        return card;
    }

    function routerCard() {
        const first = (st.addresses || [])[0] || {};
        const mac = first.mac || tr('физический адрес');
        const ip = first.address || tr('адрес');
        const ol = h('ol', { class: 'lan-steps' },
            h('li', null, trf('На этом компьютере откройте «Командную строку» и выполните {cmd}. У своей сетевой карты найдите строку «Физический адрес» — он же показан выше: {mac}.', { cmd: 'ipconfig /all', mac })),
            h('li', null, trf('Откройте в браузере страницу роутера — обычно {url}. Адрес и пароль роутера написаны на наклейке снизу роутера.', { url: st.router_hint || 'http://192.168.1.1' })),
            h('li', null, tr('Найдите резервирование адресов:'),
                h('ul', { class: 'lan-routers' },
                    h('li', null, tr('TP-Link — «DHCP → Резервирование адресов»;')),
                    h('li', null, tr('MikroTik — «IP → DHCP Server → Leases»: выберите этот компьютер и нажмите «Make Static»;')),
                    h('li', null, tr('Keenetic — «Список устройств»: выберите этот компьютер и включите «Постоянный IP-адрес»;')),
                    h('li', null, tr('другие роутеры — «DHCP Reservation», «Static Lease» или «Привязка IP к MAC».')))),
            h('li', null, trf('Впишите физический адрес {mac} и адрес {ip} и сохраните.', { mac, ip })),
            h('li', null, tr('Перезагрузите роутер или этот компьютер и проверьте здесь, что адрес остался прежним.')));
        return h('div', { class: 'card lan-card' },
            h('h3', { class: 'lan-h' }, Icon('Settings', { size: 15 }), ' ', tr('Как закрепить адрес в роутере')),
            h('p', { class: 'lan-p' }, tr('Это настоящее лечение: роутер будет всегда выдавать этому компьютеру один и тот же адрес — и компьютерам, и анализаторам.')),
            ol);
    }

    function paint() {
        clear(body);
        if (!st) return;
        if (st.change) body.appendChild(changeCard(st.change));
        body.appendChild(addressCard());
        body.appendChild(nameCard());
        body.appendChild(routerCard());
    }

    if (await load()) paint();
}
