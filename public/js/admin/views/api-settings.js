// Settings → General → «API» (CLINIC_API_V1). Clinic-side management of partner
// Bearer tokens (up to 10, revocable, shown once) + integration documentation.
// Talks ONLY to the gateway via gw() (the api_keys table is server-only, RLS-forced);
// never queries supabase directly. Powers the Symptex / partner integration: read the
// clinic's published info and create/cancel visits with «Authorization: Bearer emk_…».
import { h, Icon, PageHead, toast, clear } from '../ui.js';
import { gw } from '../gateway.js';

const MAX_KEYS = 10;
const fmtDate = (s) => { try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s || '—'; } };
const apiBase = () => location.origin + '/api/v1';

export async function renderApiSettings(container, { onNavigate } = {}) {
    clear(container);
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);

    root.appendChild(PageHead({
        title: 'API',
        subtitle: 'Токены для интеграций (Symptex и партнёры): чтение данных клиники и создание/отмена визитов. До 10 активных токенов.',
    }));

    const tokensCard = h('div', { class: 'card', style: { marginBottom: '16px' } });
    const docsCard = h('div', { class: 'card' });
    root.appendChild(tokensCard);
    root.appendChild(docsCard);

    // ---------- tokens ----------
    async function loadAndPaintTokens() {
        clear(tokensCard);
        tokensCard.appendChild(h('div', { class: 'muted', style: { padding: '24px', textAlign: 'center' } }, 'Загрузка…'));
        let keys = [];
        try { const r = await gw('/keys'); keys = (r && r.keys) || r || []; }
        catch (e) { clear(tokensCard); tokensCard.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, 'Не удалось загрузить токены: ' + (e.message || e))); return; }
        // Show only the clinic's own partner tokens — hide source='easymed' (EasyMed-internal plumbing).
        const clinicKeys = keys.filter(k => k.scope === 'clinic' && k.source !== 'easymed');
        clear(tokensCard);

        const createBtn = h('button', { class: 'btn btn-primary btn-sm', disabled: clinicKeys.length >= MAX_KEYS ? '' : null,
            onclick: () => openCreate() }, Icon('Plus', { size: 13 }), ' Создать токен');
        tokensCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, 'Токены доступа'),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12px', marginRight: '10px' } }, `${clinicKeys.length} из ${MAX_KEYS}`),
            createBtn));

        if (!clinicKeys.length) {
            tokensCard.appendChild(h('div', { class: 'empty', style: { padding: '34px 20px' } },
                h('p', null, 'Токенов пока нет.'),
                h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, 'Создайте токен и передайте его партнёру (Symptex). Секрет показывается один раз.')));
            return;
        }
        const tb = h('tbody');
        for (const k of clinicKeys) {
            tb.appendChild(h('tr', null,
                h('td', { style: { fontWeight: 600 } }, k.name || '—'),
                h('td', { class: 'cell-mono', style: { fontSize: '12px' } }, 'emk_' + (k.key_id || '') + '.…'),
                h('td', null, h('span', { class: 'tag tag-info' }, k.source || 'all')),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, fmtDate(k.created_at)),
                h('td', { class: 'muted', style: { fontSize: '12px' } }, k.last_used_at ? fmtDate(k.last_used_at) : 'не использовался'),
                h('td', { style: { textAlign: 'right' } },
                    h('button', { class: 'btn btn-ghost btn-sm', style: { color: 'var(--crit-700)' },
                        onclick: async () => {
                            if (!confirm(`Отозвать токен «${k.name || ''}»? Интеграции, использующие его, перестанут работать.`)) return;
                            try { await gw('/keys/' + k.id + '/revoke', { method: 'POST' }); toast('Токен отозван'); loadAndPaintTokens(); }
                            catch (e) { toast('Не удалось отозвать: ' + (e.message || e), 'fail'); }
                        } }, 'Отозвать')),
            ));
        }
        tokensCard.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
            h('thead', null, h('tr', null,
                h('th', null, 'Название'), h('th', null, 'Идентификатор'), h('th', null, 'Доступ'),
                h('th', null, 'Создан'), h('th', null, 'Использован'), h('th', null, ''))),
            tb));
    }

    function openCreate() {
        const ov = h('div', { class: 'modal', style: { zIndex: '150' } });
        const close = () => ov.remove();
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        const nameInp = h('input', { style: { width: '100%', boxSizing: 'border-box' }, placeholder: 'Например: Symptex / Мобильное приложение', maxlength: '60' });
        async function create(btn) {
            const name = nameInp.value.trim() || 'API token';
            btn.disabled = true;
            try {
                const r = await gw('/keys', { method: 'POST', body: { scope: 'clinic', name } });
                close();
                showSecret(r && r.token, name);
                loadAndPaintTokens();
            } catch (e) {
                toast(e.message || String(e), 'fail');
                btn.disabled = false;
            }
        }
        ov.appendChild(h('div', { class: 'modal-card', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, Icon('Key', { size: 16 }), ' Новый токен'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { class: 'field' }, h('label', null, 'Название (для какой интеграции)'), nameInp),
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '8px' } }, 'Секрет токена будет показан только один раз — скопируйте и сохраните его.')),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', onclick: close }, 'Отмена'), h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-primary', onclick: (e) => create(e.currentTarget) }, Icon('Check', { size: 14 }), ' Создать'))));
        document.body.appendChild(ov);
        setTimeout(() => nameInp.focus(), 30);
    }

    function showSecret(token, name) {
        if (!token) { toast('Токен создан, но секрет не получен — отзовите и создайте заново.', 'fail'); return; }
        const banner = h('div', { style: { border: '1px solid var(--ok-500, #1f9254)', background: '#eafaf0', borderRadius: '10px', padding: '14px', marginBottom: '14px' } },
            h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '✓ Токен «' + name + '» создан'),
            h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' } }, 'Скопируйте секрет сейчас — он показывается только один раз и больше не будет доступен.'),
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                h('input', { readonly: '', value: token, class: 'cell-mono', style: { flex: 1, height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit' },
                    onclick: (e) => e.target.select() }),
                h('button', { class: 'btn btn-outline btn-sm', onclick: (e) => {
                    try { navigator.clipboard.writeText(token); toast('Скопировано'); e.currentTarget.textContent = 'Скопировано'; } catch { toast('Скопируйте вручную', 'info'); } }, type: 'button' }, 'Копировать')));
        // mount the banner at the top of the tokens card area
        root.insertBefore(banner, tokensCard);
        setTimeout(() => { if (banner.isConnected) banner.style.opacity = '1'; }, 0);
    }

    tokensCard.appendChild(h('div', { class: 'muted', style: { padding: '24px', textAlign: 'center' } }, 'Загрузка…'));

    // ---------- documentation ----------
    function endpointRow(method, path, desc) {
        return h('tr', null,
            h('td', null, h('span', { class: 'tag ' + (method === 'GET' ? 'tag-ok' : 'tag-info'), style: { fontFamily: 'inherit' } }, method)),
            h('td', { class: 'cell-mono', style: { fontSize: '12px', whiteSpace: 'nowrap' } }, path),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, desc));
    }
    function codeBlock(text) {
        return h('pre', { style: { background: '#0f1f1d', color: '#dfeee9', borderRadius: '9px', padding: '12px 14px', overflow: 'auto', fontSize: '12px', lineHeight: '1.5', margin: '6px 0 0' } }, text);
    }
    function paintDocs() {
        clear(docsCard);
        docsCard.appendChild(h('div', { class: 'card-header' }, h('h3', null, 'Документация')));
        const body = h('div', { class: 'card-pad', style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
        docsCard.appendChild(body);

        body.appendChild(h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Базовый URL'),
            h('div', { class: 'cell-mono', style: { fontSize: '13px' } }, apiBase()),
            h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '4px' } }, 'Также доступен через easymed.uz/api/v1.')));

        body.appendChild(h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Авторизация'),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Передавайте токен в заголовке каждого запроса:'),
            codeBlock('Authorization: Bearer emk_<идентификатор>.<секрет>')));

        const epTb = h('tbody');
        // CLINIC_SCOPE_V1 — every endpoint returns ONLY this clinic's own data.
        const eps = [
            ['GET', '/clinics', 'Ваша клиника и её филиалы.'],
            ['GET', '/clinics/{id}', 'Профиль вашей клиники/филиала: контакты, часы работы.'],
            ['GET', '/clinics/{id}/services', 'Услуги вашей клиники с ценами.'],
            ['GET', '/doctors', 'Врачи вашей клиники со специальностями и отделениями.'],
            ['GET', '/departments?clinic_id=', 'Клинические отделения вашей клиники/филиала.'],
            ['GET', '/consultations?doctor_id=', 'Типы консультаций врача и цены (RU/UZ/EN).'],
            ['GET', '/availability?doctor_id=&date_from=&date_to=', 'Свободные слоты врача (с учётом расписания и занятых визитов).'],
            ['POST', '/visits', 'Создать заявку на визит (статус «Заявка», подтверждает регистратор).'],
            ['POST', '/visits/{id}/cancel', 'Отменить визит.'],
            ['GET', '/key/whoami', 'Проверка токена + ваш clinic_id (id клиники в каталоге).'],
        ];
        for (const [m, p, d] of eps) epTb.appendChild(endpointRow(m, p, d));
        body.appendChild(h('div', { style: { background: '#eef6f5', border: '1px solid #cfe6e2', borderRadius: '9px', padding: '11px 13px' } },
            h('div', { style: { fontWeight: 600, marginBottom: '3px' } }, 'Область действия токена'),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                'Токен привязан к вашей клинике. Любой запрос возвращает только её данные — вашу клинику, её ' +
                'филиалы, отделения, врачей и услуги. Обращение к другой клинике запрещено (403). Ваш ' +
                'идентификатор клиники (clinic_id) приходит в ответе /key/whoami — подставляйте его в ' +
                '/clinics/{id} и /departments?clinic_id=.')));
        body.appendChild(h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Эндпоинты'),
            h('table', { class: 'tbl', style: { width: '100%' } },
                h('thead', null, h('tr', null, h('th', { style: { width: '54px' } }, 'Метод'), h('th', null, 'Путь'), h('th', null, 'Назначение'))),
                epTb)));

        body.appendChild(h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Поля запроса — создание визита (POST /visits)'),
            codeBlock(JSON.stringify({
                doctor_id: 'uuid врача',
                service_id: 'uuid услуги (необязательно)',
                visit_date: '2026-06-20T10:30:00+05:00',
                duration_minutes: 30,
                patient: { phone: '+998901234567', full_name: 'Иванов Иван', date_of_birth: '1990-05-01', gender: 'male' },
                notes: 'комментарий (необязательно)',
            }, null, 2))));

        body.appendChild(h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Пример (curl)'),
            codeBlock(
                '# свободные слоты\n' +
                `curl -H "Authorization: Bearer $TOKEN" \\\n  "${apiBase()}/availability?doctor_id=DOCTOR_UUID&date_from=2026-06-20&date_to=2026-06-22"\n\n` +
                '# создать заявку на визит\n' +
                `curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\\n  -d '{"doctor_id":"DOCTOR_UUID","visit_date":"2026-06-20T10:30:00+05:00","patient":{"phone":"+998901234567","full_name":"Иванов Иван"}}' \\\n  "${apiBase()}/visits"`)));

        // test connection
        const testIn = h('input', { placeholder: 'Вставьте токен emk_… для проверки', class: 'cell-mono',
            style: { flex: 1, height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit' } });
        const testOut = h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } });
        const testBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
            const tok = testIn.value.trim();
            if (!tok) { toast('Вставьте токен.', 'fail'); return; }
            testBtn.disabled = true; clear(testOut); testOut.textContent = 'Проверка…';
            try {
                const res = await fetch('/api/v1/key/whoami', { headers: { Authorization: 'Bearer ' + tok } });
                const data = await res.json().catch(() => null);
                clear(testOut);
                if (res.ok) testOut.appendChild(h('span', { style: { color: 'var(--ok-700)' } }, '✓ Токен действителен · область: ' + ((data && (data.scope || data.source)) || 'clinic')));
                else testOut.appendChild(h('span', { style: { color: 'var(--crit-700)' } }, '✗ Недействителен (' + res.status + ')'));
            } catch (e) { clear(testOut); testOut.appendChild(h('span', { style: { color: 'var(--crit-700)' } }, '✗ Ошибка: ' + (e.message || e))); }
            finally { testBtn.disabled = false; }
        } }, 'Проверить токен');
        body.appendChild(h('div', null,
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Тестирование'),
            h('div', { class: 'row', style: { gap: '8px' } }, testIn, testBtn), testOut));
    }

    await loadAndPaintTokens();
    paintDocs();
}
