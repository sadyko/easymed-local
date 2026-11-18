// DOC_HISTORY_V1 (3.25.0, решение владельца) — «ИСТОРИЯ ИЗМЕНЕНИЙ» В КАБИНЕТЕ ВРАЧА.
//
// Настоящая форма кабинета (soapForm) на стенде cabinet-harness.mjs и окно истории
// (views/doc-history.js) с фальшивым сервером:
//   • кнопка «История изменений» — врачу строки, главному врачу и администратору;
//     другому врачу и медсестре — нет (сервер откажет и сам: rpc/doc-history.js);
//   • список версий: когда, кто (и «вместо» при входе «от имени»), вид, разделы;
//   • одна отмеченная версия — показ только для чтения, разметка — после очистки;
//   • две — сравнение по разделам: убранное и добавленное; третья отметка снимает
//     самую раннюю;
//   • слова окна — на языке экрана.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El } from './cabinet-harness.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const REVS = [
    { id: 11, rev_no: 1, kind: 'draft', via: 'cabinet', doc_type: 'conclusion', sections: ['chief_complaint'], images_added: 0, images_removed: 0, signed_n: 0,
        created_at: '2026-11-18T08:00:00.000Z', user: { id: 3, name: 'Иванова А.', role: 'doctor' }, acting_admin: null },
    { id: 12, rev_no: 2, kind: 'lists', via: 'cabinet', doc_type: 'conclusion', sections: ['hpi', 'prescriptions'], images_added: 0, images_removed: 0, signed_n: 0,
        created_at: '2026-11-18T09:00:00.000Z', user: { id: 3, name: 'Иванова А.', role: 'doctor' }, acting_admin: { id: 1, name: 'Петров П.' } },
    { id: 13, rev_no: 3, kind: 'amended', via: 'cabinet', doc_type: 'conclusion', sections: ['chief_complaint', 'images'], images_added: 1, images_removed: 0, signed_n: 1,
        created_at: '2026-11-18T10:00:00.000Z', user: { id: 3, name: 'Иванова А.', role: 'doctor' }, acting_admin: null },
];
const SNAP = {
    11: { v: 1, docType: 'conclusion', fields: { chief_complaint: 'Кашель сухой, ночью' }, prescriptions: [], diagnoses: [], services: [], images: [], nurseNote: '', signed: [] },
    12: { v: 1, docType: 'conclusion', fields: { chief_complaint: 'Кашель влажный, ночью', hpi: '<b>Неделю</b><img src=x onerror="alert(1)"><script>alert(1)</script>' },
        prescriptions: [{ name: 'Амоксициллин', dose: '500 мг' }], diagnoses: [], services: [], images: [], nurseNote: '', signed: [] },
    13: { v: 1, docType: 'conclusion', fields: { chief_complaint: 'Кашель влажный' }, prescriptions: [{ name: 'Амоксициллин', dose: '500 мг' }],
        diagnoses: [], services: [], images: ['h1abc.2k'], nurseNote: '', signed: [{ at: '2026-11-18T10:00:00.000Z', by: 3, byName: 'Иванова А.' }] },
};
const RPCS = [];
let LIST_ERROR = null;
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        RPCS.push({ name, body });
        if (name === 'document_history_list') {
            if (LIST_ERROR) return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: LIST_ERROR } }), headers: { getSetCookie: () => [] } };
            return ok({ visit_service_id: body.visit_service_id, revisions: REVS });
        }
        if (name === 'document_history_get') return ok({ ...REVS.find((r) => r.id === body.id), snapshot: SNAP[body.id] });
        return ok(null);
    }
    if (u === '/api/db' && body.op === 'select') return ok(body.single || /notes/.test(String(body.columns)) ? null : []);
    return ok(null);
};

const WS = await import('../views/service-workspace.js');
const DH = await import('../views/doc-history.js');
const { setLang } = await import('../i18n.js');

const USERS = {
    doc: { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [] },
    doc2: { id: 4, full_name: 'Сидоров С.', role: 'doctor', is_doctor: true, extra_roles: [] },
    head: { id: 5, full_name: 'Главврач Г.', role: 'doctor', is_doctor: true, extra_roles: ['head_doctor'] },
    boss: { id: 1, full_name: 'Петров П.', role: 'admin', is_admin: true, extra_roles: [] },
    nurse: { id: 6, full_name: 'Медсестра Н.', role: 'nurse', extra_roles: [] },
};
const setUser = (u) => { globalThis.window.easymed = { state: { user: u } }; };

function cabinet(id, doctorId) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
        __service: { id, name: 'Консультация терапевта', doctorId, doctorName: 'Иванова А.', doctorSpec: 'Терапевт' } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    return ctx;
}
const historyBtn = (ctx) => ctx.container.querySelector('[data-doc-history-btn]');
const modal = () => globalThis.document.body.querySelectorAll('[data-doc-history]').pop() || null;
const closeAll = () => { for (const m of globalThis.document.body.querySelectorAll('[data-doc-history]')) m.remove(); };

test('кнопка «История изменений» — врачу строки, главному врачу и администратору; другому врачу и медсестре — нет', () => {
    setLang('ru');
    for (const [who, want] of [['doc', true], ['head', true], ['boss', true], ['doc2', false], ['nurse', false]]) {
        setUser(USERS[who]);
        const ctx = cabinet(70, 3);
        const btn = historyBtn(ctx);
        assert.equal(!!btn, want, who + ': кнопка ' + (want ? 'не видна' : 'видна'));
        if (btn) {
            assert.match(btn.textContent, /История изменений/);
            // рядом с «Сохранить» и «Завершить приём» — в той же панели документа
            assert.ok(btn.closest('.ws-docbar-right'), who + ': кнопка не у кнопок сохранения и подписи');
        }
    }
    setUser(USERS.doc);
    assert.equal(historyBtn(cabinet(71, null)), null, 'строка без исполнителя — не «своя» врачу');
});

test('кнопка открывает окно истории строки: список версий сверху новой, кто, «вместо» при входе от имени, вид и разделы', async () => {
    setLang('ru');
    setUser(USERS.doc);
    RPCS.length = 0;
    const ctx = cabinet(72, 3);
    historyBtn(ctx).dispatch('click');
    const m = modal();
    assert.ok(m, 'окно не открылось');
    assert.equal(m.getAttribute('data-doc-history'), '72');
    closeAll();
    const ctl = DH.openDocHistoryModal({ visitServiceId: 72, title: 'Консультация терапевта' });
    assert.equal(await ctl.ready, true);
    assert.deepEqual(RPCS.filter((r) => r.name === 'document_history_list').map((r) => r.body), [{ visit_service_id: 72 }, { visit_service_id: 72 }]);
    const rows = ctl.overlay.querySelectorAll('[data-dh-rev]');
    assert.deepEqual(rows.map((r) => r.getAttribute('data-dh-rev')), ['13', '12', '11'], 'новая версия — сверху');
    const text = (el) => el.textContent;
    assert.match(text(rows[0]), /Версия 3/);
    assert.match(text(rows[0]), /Исправлен после подписи/);
    assert.match(text(rows[0]), /Жалобы, Снимки: \+1 \/ −0/);
    assert.match(text(rows[0]), /Иванова А\. \(Врач\)/);
    assert.match(text(rows[1]), /Петров П\. \(администратор\) вместо Иванова А\. \(Врач\)/, 'вход «от имени» назван');
    assert.match(text(rows[1]), /Изменение назначений и диагнозов/);
    assert.match(text(rows[1]), /Анамнез, Назначения/);
    assert.ok(ctl.overlay.querySelector('[data-dh-hint]'), 'подсказка, пока ничего не отмечено');
    ctl.close();
});

test('одна версия — только для чтения, разметка очищена; две — сравнение по разделам; третья отметка снимает самую раннюю', async () => {
    setLang('ru');
    setUser(USERS.doc);
    const ctl = DH.openDocHistoryModal({ visitServiceId: 73 });
    await ctl.ready;
    await ctl.select(12);
    let pane = ctl.overlay.querySelector('[data-dh-pane]');
    const view = pane.querySelector('[data-dh-view]');
    assert.ok(view, 'нет показа версии');
    assert.equal(view.getAttribute('data-dh-view'), '12');
    const hpi = view.querySelector('[data-dh-section="hpi"]');
    assert.ok(hpi, 'раздел «Анамнез» не показан');
    const rich = hpi.querySelector('.dh-rich');
    assert.match(rich.innerHTML, /<b>Неделю<\/b>/, 'оформление врача потеряно');
    assert.ok(!/<script|onerror/i.test(rich.innerHTML), 'разметка вставлена без очистки: ' + rich.innerHTML);
    assert.match(view.querySelector('[data-dh-section="prescriptions"]').textContent, /Амоксициллин · 500 мг/);
    assert.equal(ctl.overlay.querySelector('[data-dh-check="12"]').checked, true);

    await ctl.select(11);
    pane = ctl.overlay.querySelector('[data-dh-pane]');
    const cmp = pane.querySelector('[data-dh-compare]');
    assert.ok(cmp, 'нет сравнения двух версий');
    assert.equal(cmp.getAttribute('data-dh-compare'), '11:12', 'старшая версия — слева');
    const cc = cmp.querySelector('[data-dh-section="chief_complaint"]');
    assert.deepEqual(cc.querySelectorAll('[data-dh-del]').map((e) => e.textContent.trim()), ['сухой,']);
    assert.deepEqual(cc.querySelectorAll('[data-dh-ins]').map((e) => e.textContent.trim()), ['влажный,']);
    const rx = cmp.querySelector('[data-dh-section="prescriptions"]');
    assert.match(rx.querySelectorAll('[data-dh-ins]').map((e) => e.textContent).join(), /Амоксициллин/, 'добавленное назначение не отмечено');
    assert.ok(cmp.querySelector('[data-dh-section="hpi"]'), 'новый раздел «Анамнез» — в сравнении');
    assert.ok(!/<script/i.test(cmp.querySelector('[data-dh-section="hpi"]').textContent), 'сравнение — простым текстом');

    await ctl.select(13);   // третья отметка — снимает самую раннюю (12)
    assert.equal(ctl.overlay.querySelector('[data-dh-check="12"]').checked, false);
    const cmp2 = ctl.overlay.querySelector('[data-dh-pane]').querySelector('[data-dh-compare]');
    assert.equal(cmp2.getAttribute('data-dh-compare'), '11:13');
    assert.match(cmp2.querySelector('[data-dh-section="images"]').textContent, /добавлено 1, убрано 0/);
    await ctl.select(13);
    await ctl.select(11);
    assert.ok(ctl.overlay.querySelector('[data-dh-pane]').querySelector('[data-dh-hint]'), 'сняты обе отметки — снова подсказка');
    ctl.close();
});

test('отказ сервера — его словами в окне; пустая история — словами', async () => {
    setLang('ru');
    setUser(USERS.doc);
    LIST_ERROR = 'Историю изменений документа видят врач этой услуги, главный врач и администратор.';
    const ctl = DH.openDocHistoryModal({ visitServiceId: 74 });
    assert.equal(await ctl.ready, false);
    assert.match(ctl.overlay.querySelector('[data-dh-error]').textContent, /видят врач этой услуги/);
    ctl.close();
    LIST_ERROR = null;
});

test('слова окна — на языке экрана (узбекский, английский): вид, роль, «вместо», подсказки', async () => {
    setUser(USERS.doc);
    for (const [lang, re, kind] of [['uz', /o‘rniga|o'rniga|oʻrniga/, /Imzodan keyin tuzatilgan/], ['en', /on behalf of|instead of/, /Corrected after signing/]]) {
        setLang(lang);
        const ctl = DH.openDocHistoryModal({ visitServiceId: 75 });
        await ctl.ready;
        const rows = ctl.overlay.querySelectorAll('[data-dh-rev]');
        assert.match(rows[1].textContent, re, lang + ': «вместо» не переведено: ' + rows[1].textContent);
        assert.match(rows[0].textContent, kind, lang + ': вид версии не переведён: ' + rows[0].textContent);
        assert.ok(!/[А-Яа-яЁё]/.test(ctl.overlay.querySelector('[data-dh-hint]').textContent), lang + ': подсказка по-русски');
        await ctl.select(12);
        await ctl.select(11);
        const cmp = ctl.overlay.querySelector('[data-dh-compare]');
        const own = cmp.textContent.replace(/Кашель|сухой|влажный|ночью|Неделю|Амоксициллин|мг|alert\(1\)/g, '');
        assert.ok(!/[А-Яа-яЁё]/.test(own), lang + ': в сравнении остались русские слова экрана: ' + own);
        ctl.close();
    }
    setLang('ru');
});
