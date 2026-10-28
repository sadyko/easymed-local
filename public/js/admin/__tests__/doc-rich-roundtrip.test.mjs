// DOC_RICH_FORMAT_V1 (ревью T1, HIGH 2) — «ОТКРЫТЬ → СОХРАНИТЬ» НЕ МЕНЯЕТ ТЕКСТ.
//
// Ревью: запись {hpi: 'SpO2 <95%', physical_exam: 'AT&T, ЧСС > 90'} после
// первого открытия сохранялась как «SpO2 &lt;95%», после второго врач видел на
// экране, листе и в архиве «SpO2 &lt;95%», и следующее сохранение писало
// «&amp;lt;» — и так с каждым открытием. Причина: значение без тегов applyFields
// клал textContent'ом, а collectFields читает innerHTML.
//
// Стенд кабинета здесь ведёт себя как браузер: innerHTML после textContent —
// экранирован, textContent после innerHTML — расшифрован. Три круга «открыть →
// показать → лист → сохранить» для прежнего сырого текста и для уже
// экранированной записи: запись стабильна, показ верный.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import { installFakeDom, El } from './cabinet-harness.mjs';
import { NOTES_BASE_KEY } from '../../shared/cabinet-notes.js';

installFakeDom();
delete globalThis.DOMParser;

// ─── браузерная семантика innerHTML / textContent ─────────────────────────────
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
Object.defineProperty(El.prototype, 'innerHTML', {
    configurable: true,
    get() { return this._html != null ? this._html : escText(this._text); },
    set(v) { this._html = String(v); this.children = []; },
});
Object.defineProperty(El.prototype, 'textContent', {
    configurable: true,
    get() { return this._html != null ? decode(this._html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')) : this._text + this.children.map((c) => c.textContent || '').join(''); },
    set(v) { this._text = String(v); this._html = null; this.children = []; },
});

const NOTES = new Map();
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) return ok({ id: 1 });
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'update') {
            const values = { ...(body.values || {}) };
            delete values[NOTES_BASE_KEY];
            if (values.notes != null) NOTES.set(id, values.notes);
            return ok(null);
        }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const WS = await import('../views/service-workspace.js');
const { renderDesignedVariant } = await import('../views/doc-variants.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000 });
const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current) => JSON.stringify({ __service_workspace_v1: 1, current, history: [] });
async function opened(id, notes) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга', doctorName: 'Врач', doctorSpec: 'Терапевт' } } };
    if (notes != null) NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    await WS.hydrateLine(ctx);
    await tick(5);
    return ctx;
}
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');

// поле записи → что врач видит, что ложится в notes после первого сохранения
const CASES = [
    // прежний сырой текст (записи до contenteditable, импорт)
    { k: 'hpi', stored: 'SpO2 <95%', shown: 'SpO2 <95%', canon: 'SpO2 &lt;95%' },
    { k: 'physical_exam', stored: 'AT&T, ЧСС > 90', shown: 'AT&T, ЧСС > 90', canon: 'AT&amp;T, ЧСС &gt; 90' },
    { k: 'chief_complaint', stored: 'a<b', shown: 'a<b', canon: 'a&lt;b' },
    // уже экранированная запись (так пишет innerHTML)
    { k: 'therapy_text', stored: 'Т. 5 мг &amp; 10 мг, ЧСС &lt; 60', shown: 'Т. 5 мг & 10 мг, ЧСС < 60', canon: 'Т. 5 мг &amp; 10 мг, ЧСС &lt; 60' },
    { k: 'conclusion_text', stored: 'буквально &amp;amp;', shown: 'буквально &amp;', canon: 'буквально &amp;amp;' },
    { k: 'recommendations_text', stored: 'Режим &gt; 8 ч<br>Сон', shown: 'Режим > 8 ч\nСон', canon: 'Режим &gt; 8 ч<br>Сон' },
];

test('ревью T1 (HIGH 2): три круга «открыть → лист → сохранить» — запись стабильна, показ верный (<, >, &, &amp;)', async () => {
    const id = 31;
    let ctx = await opened(id, notesOf(Object.fromEntries(CASES.map((c) => [c.k, c.stored]))));
    for (let round = 1; round <= 3; round += 1) {
        for (const c of CASES) {
            assert.equal(field(ctx, c.k).textContent, c.shown, `круг ${round}, ${c.k}: на экране`);
        }
        // лист (печать, архив): текст раздела — тот, что видит врач
        const snap = WS.docSnapshot(ctx, 'conclusion');
        assert.equal(snap.hpi, 'SpO2 <95%', `круг ${round}: лист — «Анамнез»`);
        assert.equal(snap.exam, 'AT&T, ЧСС > 90', `круг ${round}: лист — «Осмотр»`);
        assert.equal(snap.conclusionText, 'буквально &amp;', `круг ${round}: лист — «Заключение»`);
        const sheet = renderDesignedVariant('conclusion', 'classic', S, snap);
        assert.ok(sheet.includes('SpO2 &lt;95%') && !sheet.includes('&amp;lt;'), `круг ${round}: лист экранирован дважды`);
        assert.ok(sheet.includes('AT&amp;T, ЧСС &gt; 90'), `круг ${round}: «AT&T» на листе`);
        assert.ok(await WS.saveDraft(ctx, { silent: true }), `круг ${round}: не сохранено`);
        const cur = JSON.parse(NOTES.get(id)).current;
        for (const c of CASES) assert.equal(cur[c.k], c.canon, `круг ${round}, ${c.k}: в notes`);
        ctx = await opened(id, null);
    }
});

test('ревью T1 (HIGH 2): шаблон с «<» и «&» без разметки — тот же показ и та же запись', async () => {
    const ctx = await opened(32, notesOf({ chief_complaint: 'Кашель' }));
    WS.tplApply(ctx, { doc_type: '0', body: { hpi: 'SpO2 <95% & ЧСС > 90' } });
    assert.equal(field(ctx, 'hpi').textContent, 'SpO2 <95% & ЧСС > 90');
    assert.ok(await WS.saveDraft(ctx, { silent: true }));
    assert.equal(JSON.parse(NOTES.get(32)).current.hpi, 'SpO2 &lt;95% &amp; ЧСС &gt; 90');
    const again = await opened(32, null);
    assert.equal(field(again, 'hpi').textContent, 'SpO2 <95% & ЧСС > 90');
});
