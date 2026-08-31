// Verification banner — MODEL_A_VERIFY_V1.
// A clinic can sign up WITHOUT documents (low friction) and use its private workspace
// immediately. This non-blocking top banner handles the license/certificate upload:
//   • pending_documents → "upload your license" CTA opens a compact uploader (license +
//     certificate → clinic-docs storage + clinic_documents rows → companies.verification_status
//     = 'pending_review').
//   • pending_review → an info banner ("under review").
// Going public on Symptex / accepting patient bookings stays gated on verification elsewhere
// (medcore verified+active + platform-approved publication), so an un-verified clinic is
// confined to its own private sandbox.
import { supabase } from '../supabase.js';
import { h, Icon, toast } from './ui.js';
import { tr, trf } from './i18n.js';   // I18N_COVERAGE_V1

const MAX_DOC_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,application/pdf,image/*';
let _styled = false;

function injectStyles() {
    if (_styled) return; _styled = true;
    const s = document.createElement('style');
    s.textContent = `
#verify-banner{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 18px;font-size:13px;
  background:#fff7ed;border-bottom:1px solid #fed7aa;color:#7c2d12;}
#verify-banner.vb-info{background:#eef6ff;border-bottom-color:#cfe2ff;color:#1e3a5f;}
#verify-banner .vb-msg{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;line-height:1.4;}
#verify-banner .vb-cta{flex:0 0 auto;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;
  font-family:inherit;cursor:pointer;background:linear-gradient(180deg,#ea7a18,#c45f08);color:#fff;}
#verify-banner .vb-cta:hover{filter:brightness(1.05);}
.vbm-overlay{position:fixed;inset:0;background:rgba(13,30,44,.5);backdrop-filter:blur(3px);z-index:9998;
  display:flex;align-items:center;justify-content:center;padding:20px;}
.vbm-card{background:#fff;border-radius:16px;max-width:520px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.22);
  padding:28px 28px 22px;display:flex;flex-direction:column;gap:14px;}
.vbm-card h2{margin:0;font-size:20px;font-weight:800;color:#0c1a17;}
.vbm-card .vbm-sub{margin:0;color:#5d7d75;font-size:13px;line-height:1.5;}
.vbm-drop{border:2px dashed #d8e0e6;border-radius:10px;padding:16px;text-align:center;cursor:pointer;
  transition:border-color .12s,background .12s;}
.vbm-drop:hover{border-color:#0d8a72;background:#f3f7f6;}
.vbm-drop.has{border-color:#0a7c5a;background:#eef7f0;}
.vbm-drop .vbm-name{font-size:13px;color:#5d7d75;margin-top:4px;word-break:break-word;}
.vbm-drop.has .vbm-name{color:#0a7c5a;font-weight:600;}
.vbm-lbl{font-size:12.5px;font-weight:600;color:#0c1a17;margin-bottom:5px;}
.vbm-foot{display:flex;gap:10px;margin-top:6px;}
.vbm-btn{flex:1;border:none;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;}
.vbm-btn.primary{background:linear-gradient(180deg,#0d8a72,#0a6e61);color:#fff;}
.vbm-btn.primary:disabled{opacity:.55;cursor:not-allowed;}
.vbm-btn.ghost{background:transparent;color:#5d7d75;}
.vbm-err{color:#c83434;font-size:12.5px;min-height:16px;}`;
    document.head.appendChild(s);
}

function safeName(s) { return String(s || 'file').toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(0, 60); }

export function renderVerificationBanner(clinic) {
    document.getElementById('verify-banner')?.remove();
    if (!clinic || !clinic.id) return;
    const st = clinic.verification_status;
    if (st !== 'pending_documents' && st !== 'pending_review') return;
    injectStyles();

    const banner = h('div', { id: 'verify-banner', class: st === 'pending_review' ? 'vb-info' : '' });
    if (st === 'pending_review') {
        banner.appendChild(h('span', { class: 'vb-msg' }, Icon('Clock', { size: 15 }),
            ' Документы на проверке — обычно в течение 24 часов. Клиника работает в обычном режиме; публикация на Symptex откроется после подтверждения.'));
    } else {
        banner.appendChild(h('span', { class: 'vb-msg' }, Icon('Doc', { size: 15 }),
            ' Подтвердите клинику: загрузите медицинскую лицензию и сертификат, чтобы опубликоваться на Symptex и принимать записи пациентов.'));
        banner.appendChild(h('button', { class: 'vb-cta', type: 'button', onclick: () => openUploadModal(clinic) },
            'Загрузить документы'));
    }
    const root = document.querySelector('.app') || document.body.firstChild;
    document.body.insertBefore(banner, root);
}

function dropzone(label, onPick) {
    const input = h('input', { type: 'file', accept: ACCEPT, style: { display: 'none' } });
    const nameEl = h('div', { class: 'vbm-name' }, 'Нажмите или перетащите файл · PDF / изображение, ≤ 10 МБ');
    const zone = h('div', { class: 'vbm-drop' }, Icon('Doc', { size: 22 }), nameEl, input);
    const set = (file) => {
        if (!file) return;
        if (file.size > MAX_DOC_BYTES) { onPick(null, 'Файл больше 10 МБ — сожмите или выберите меньший.'); return; }
        zone.classList.add('has'); nameEl.textContent = file.name; onPick(file, null);
    };
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => set(input.files && input.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.background = '#eef7f0'; });
    zone.addEventListener('dragleave', () => { zone.style.background = ''; });
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.style.background = ''; if (e.dataTransfer.files && e.dataTransfer.files[0]) set(e.dataTransfer.files[0]); });
    return { el: h('div', null, h('div', { class: 'vbm-lbl' }, label), zone) };
}

export function openUploadModal(clinic) {   // ONBOARDING_CHECKLIST_V1 — reused by setup-checklist.js
    injectStyles();
    const picked = { license: null, certificate: null };
    const errEl = h('div', { class: 'vbm-err' });
    const lic = dropzone('Медицинская лицензия (PDF или изображение, ≤ 10 МБ)', (f, e) => { picked.license = f; errEl.textContent = e || ''; sync(); });
    const cert = dropzone('Сертификат (PDF или изображение, ≤ 10 МБ)', (f, e) => { picked.certificate = f; errEl.textContent = e || ''; sync(); });
    const submit = h('button', { class: 'vbm-btn primary', type: 'button', disabled: true }, 'Отправить на проверку');
    const sync = () => { submit.disabled = !(picked.license && picked.certificate); };

    const overlay = h('div', { class: 'vbm-overlay' });
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.appendChild(h('div', { class: 'vbm-card' },
        h('h2', null, 'Подтверждение клиники'),
        h('p', { class: 'vbm-sub' }, 'Мы проверим вашу лицензию и сертификат перед публикацией на Symptex. Файлы видны только вашей клинике и нашей команде проверки.'),
        lic.el, cert.el, errEl,
        h('div', { class: 'vbm-foot' },
            h('button', { class: 'vbm-btn ghost', type: 'button', onclick: close }, 'Отмена'),
            submit)));
    document.body.appendChild(overlay);

    submit.addEventListener('click', async () => {
        if (!(picked.license && picked.certificate)) return;
        submit.disabled = true; submit.textContent = 'Загрузка…'; errEl.textContent = '';
        try {
            const me = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
            const docs = [{ kind: 'license', file: picked.license }, { kind: 'certificate', file: picked.certificate }];
            for (const { kind, file } of docs) {
                const path = `${clinic.id}/${kind}-${(file.lastModified || 0)}-${safeName(file.name)}`;
                const { error: upErr } = await supabase.storage.from('clinic-docs').upload(path, file, { contentType: file.type || 'application/octet-stream', cacheControl: '3600', upsert: true });
                if (upErr) throw upErr;
                const { error: insErr } = await supabase.from('clinic_documents').insert({
                    company_id: clinic.id, doc_type: kind, file_path: path, file_name: file.name,
                    file_size: file.size, content_type: file.type, uploaded_by_email: me.email || null,
                });
                if (insErr) throw insErr;
            }
            const { error: stErr } = await supabase.from('companies').update({ verification_status: 'pending_review' }).eq('id', clinic.id);
            if (stErr) throw stErr;
            clinic.verification_status = 'pending_review';
            close();
            renderVerificationBanner(clinic);
            toast('Документы отправлены на проверку — обычно в течение 24 часов.', 'ok');
        } catch (e) {
            console.error('[verify-banner] upload', e);
            errEl.textContent = trf('Не удалось загрузить: {msg}', { msg: e.message || tr('ошибка') });
            submit.disabled = false; submit.textContent = 'Отправить на проверку';
        }
    });
}
