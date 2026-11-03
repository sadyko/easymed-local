// PASTE_SOURCES_V1 (2026-11-02) — «Вставить результаты» в кабинете врача целиком:
// кнопка листа → окно документов пациента (без текущей строки) → «Куда
// вставить?» → полный текст отмеченных разделов в выбранном поле. И страж:
// прежняя «Карта приёмов» (loadPatientEmr / paintEmr / fillServiceConclusion …)
// и мёртвый openStudyHistoryModal не вернулись.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El } from './cabinet-harness.mjs';

installFakeDom();

const NOTES = new Map();
const RPC_LOG = [];
let SOURCES = null;
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        RPC_LOG.push({ name, body });
        if (name === 'patient_doc_sources') return ok(SOURCES);
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });

function cabinet(id, notes = notesOf(null)) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
        __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Терапевт' } } };
    NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.children = [];
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');   // бланк виден, как после setBlankMode в renderServiceWorkspace
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    return ctx;
}
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
const buttonByText = (root, t) => root.querySelectorAll('button').find((b) => String(b.textContent).includes(t));
const iframeBar = (ctx) => { const fr = ctx.container.querySelector('iframe'); const bar = fr && fr.contentDocument.body.querySelector('[data-ws-actions]'); return bar ? bar.querySelectorAll('button') : []; };

const FIXTURE = () => ({
    patient_id: 7, closed: [], truncated: { consult: false, diag: false, labs: false, inpatient: false, files: false },
    groups: {
        consult: [{ id: 'line:61', kind: 'consult', source: 'notes', visit_service_id: 61, title: 'Приём терапевта', doctor: 'Врач Тестов', at: '2026-10-05T07:00:00.000Z',
            sections: [{ key: 'complaint', label: 'Жалобы', html: 'Кашель <b>3 дня</b>' }, { key: 'hpi', label: 'Анамнез', html: 'Болеет неделю' }] }],
        diag: [], labs: [], inpatient: [], files: [],
    },
});

test('лист кабинета: «Вставить результаты» → окно этого пациента без текущей строки → «Куда вставить?» → полный текст отмеченных разделов в поле', async () => {
    SOURCES = FIXTURE(); RPC_LOG.length = 0;
    const ctx = cabinet(7);
    await WS.hydrateLine(ctx);
    const btn = iframeBar(ctx).find((b) => String(b.textContent).includes('Вставить результаты'));
    assert.ok(btn, 'на листе нет «Вставить результаты»');
    btn.dispatch('click');
    await tick(10);
    const call = RPC_LOG.find((c) => c.name === 'patient_doc_sources');
    assert.deepEqual(call && call.body, { patient_id: 7, exclude_visit_service_id: 7 }, 'окно спросило не того пациента или вернёт текущую строку');
    const modal = document.body.children.find((c) => c.hasAttribute && c.hasAttribute('data-paste-sources'));
    assert.ok(modal, 'окно не открылось');
    modal.querySelector('[data-paste-sec="hpi"]').dispatch('change');   // снять «Анамнез»
    modal.querySelector('[data-paste-insert="line:61"]').dispatch('click');
    const pick = document.body.children[document.body.children.length - 1];
    assert.ok(String(pick.textContent).includes('Куда вставить?'), 'нет выбора раздела');
    buttonByText(pick, 'Осмотр').dispatch('click');
    const exam = field(ctx, 'physical_exam').innerHTML;
    assert.ok(exam.includes('<div><b>Жалобы:</b></div>Кашель <b>3 дня</b>'), exam);
    assert.ok(!exam.includes('Болеет неделю'), 'снятый раздел вставлен');
    modal.remove();
});

test('страж: прежней «Карты приёмов» и мёртвого openStudyHistoryModal нет, стилей окна истории исследований тоже', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
    for (const name of ['openStudyHistoryModal', 'renderStudyPreview', 'loadPatientEmr', 'paintEmr', 'emrRow', 'emrTabBtn', 'openEmrResultModal', 'fillServiceConclusion', 'fillLabResults']) {
        assert.ok(!new RegExp('function ' + name + '\\b').test(src), name + ' остался');
    }
    assert.ok(!/data-emr-body|wsState\.emr\b|'emrFilter'|\bemr: null|const emrBtn/.test(src), 'состояние или кнопка прежней истории остались');
    assert.match(src, /openPasteSourcesModal\(\{/);
    const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
    assert.ok(!/\.st-(body|list|item|prev|tbl)\b/.test(css), 'стили удалённого окна истории остались');
});
