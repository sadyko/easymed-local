// Onboarding soft checklist — ONBOARDING_CHECKLIST_V1.
// A dismissible "getting started" card shown to a clinic admin until the clinic is set up.
// Three steps: (1) company details, (2) first branch profile complete (matches the gateway's
// Symptex-publication completeness), (3) upload medical license (reuses the verify-banner modal).
// Hides forever once companies.setup_completed_at is set: auto-set when steps 1+2 are done, or on
// explicit dismiss. Never blocks the UI; mirrors verify-banner.js (non-blocking, idempotent).
import { supabase } from "../supabase.js";
import { h, Icon, toast } from "./ui.js";
import { gw } from "./gateway.js";
import { openUploadModal } from "./verify-banner.js?v=vb2";

let _styled = false;
function injectStyles() {
    if (_styled) return; _styled = true;
    const s = document.createElement("style");
    s.textContent = `
#setup-checklist{margin:0;padding:16px 18px 14px;background:#f4faf8;border-bottom:1px solid #cfe7e0;
  font-size:13.5px;color:#0c2a26;display:flex;flex-direction:column;gap:12px;}
#setup-checklist .scl-head{display:flex;align-items:center;gap:10px;}
#setup-checklist .scl-title{font-weight:700;font-size:13.5px;color:#0b3a33;flex:1;}
#setup-checklist .scl-prog{font-size:12.5px;font-weight:600;color:#0d8a72;}
#setup-checklist .scl-dismiss{border:none;background:transparent;color:#5d7d75;font-size:12.5px;
  font-family:inherit;cursor:pointer;padding:4px 6px;border-radius:6px;}
#setup-checklist .scl-dismiss:hover{background:#e3f1ec;}
#setup-checklist .scl-steps{display:flex;flex-direction:column;gap:8px;}
#setup-checklist .scl-step{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:10px;
  background:#fff;border:1px solid #dceee8;}
#setup-checklist .scl-step.done{background:#eef7f0;border-color:#bfe3cd;}
#setup-checklist .scl-mark{width:22px;height:22px;border-radius:999px;flex:0 0 22px;display:grid;
  place-items:center;font-size:12.5px;font-weight:700;background:#e3f1ec;color:#0d8a72;}
#setup-checklist .scl-step.done .scl-mark{background:#0d8a72;color:#fff;}
#setup-checklist .scl-body{flex:1;min-width:0;}
#setup-checklist .scl-name{font-weight:600;color:#0c2a26;}
#setup-checklist .scl-sub{font-size:12.5px;color:#5d7d75;margin-top:1px;}
#setup-checklist .scl-cta{flex:0 0 auto;border:1px solid #0d8a72;background:#fff;color:#0a6e61;
  border-radius:8px;padding:6px 13px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;}
#setup-checklist .scl-cta:hover{background:#0d8a72;color:#fff;}
#setup-checklist .scl-step.done .scl-cta{visibility:hidden;}`;
    document.head.appendChild(s);
}

function companyComplete(co) {
    if (!co) return false;
    const name = co.name || co.name_ru || co.name_uz || co.name_en;
    return !!(name && co.phone && co.address);
}

const BRANCH_CORE_MISSING_LABELS = ["Адрес", "Часы работы"];
function branchProfileComplete(dash, branchRow) {
    if (!dash || !branchRow) return false;
    const name = branchRow.name_ru || branchRow.name_uz || branchRow.name_en || branchRow.name;
    const missing = dash.clinic_missing || [];
    const coreMissing = BRANCH_CORE_MISSING_LABELS.some((l) => missing.includes(l));
    return !!(name && branchRow.district && !coreMissing);
}

async function loadState(clinic) {
    let co = null;
    try {
        const { data } = await supabase.from("companies")
            .select("id, name, name_ru, phone, address, setup_completed_at, verification_status")
            .eq("id", clinic.id).limit(1);
        co = (data && data[0]) || null;
    } catch (e) { co = null; }

    let branchRow = null, dash = null;
    try {
        const { data: bs } = await supabase.from("branches")
            .select("id, name, name_ru, name_uz, name_en, district, active, created_at")
            .eq("company_id", clinic.id).eq("active", true).order("created_at", { ascending: true });
        branchRow = (bs && bs[0]) || null;
    } catch (e) { branchRow = null; }
    if (branchRow) {
        try { dash = await gw("/public-site/dashboard?branch_id=" + encodeURIComponent(branchRow.id)); }
        catch (e) { dash = null; }
    }
    return { co, branchRow, dash };
}

async function markDone(clinicId) {
    try {
        const { error } = await supabase.from("companies")
            .update({ setup_completed_at: new Date().toISOString() }).eq("id", clinicId);
        if (error) throw error;
        return true;
    } catch (e) { console.warn("[setup-checklist] markDone", e); return false; }
}

function stepRow(done, name, sub, ctaLabel, onCta) {
    return h("div", { class: "scl-step" + (done ? " done" : "") },
        h("div", { class: "scl-mark" }, done ? Icon("Check", { size: 13 }) : ""),
        h("div", { class: "scl-body" },
            h("div", { class: "scl-name" }, name),
            h("div", { class: "scl-sub" }, done ? "Готово" : sub)),
        h("button", { class: "scl-cta", type: "button", onclick: onCta }, ctaLabel));
}

export async function renderSetupChecklist(clinic) {
    document.getElementById("setup-checklist")?.remove();
    if (!clinic || !clinic.id) return;
    if (clinic.setup_completed_at) return;

    const { co, branchRow, dash } = await loadState(clinic);
    if (co && co.setup_completed_at) return;

    const s1 = companyComplete(co);
    const s2 = branchProfileComplete(dash, branchRow);
    const s3 = true;   // NOTIF_POLICY_V2 — license step removed (approach changed)

    if (s1 && s2) { await markDone(clinic.id); return; }

    injectStyles();
    const nav = (view) => { try { window.easymed?.navigate?.(view); } catch (e) {} };
    const done = [s1, s2, s3].filter(Boolean).length;

    const card = h("div", { id: "setup-checklist" });
    card.appendChild(h("div", { class: "scl-head" },
        Icon("Rocket", { size: 16 }),
        h("span", { class: "scl-title" }, "Настройка клиники"),
        h("span", { class: "scl-prog" }, [s1, s2].filter(Boolean).length + " / 2"),   // NOTIF_POLICY_V2
        h("button", { class: "scl-dismiss", type: "button", onclick: async () => {
            if (await markDone(clinic.id)) { card.remove(); toast("Чек-лист скрыт.", "info"); }
        } }, "Скрыть")));

    const steps = h("div", { class: "scl-steps" });
    steps.appendChild(stepRow(s1, "Данные клиники",
        "Заполните название, телефон и адрес клиники.", "Открыть",
        () => nav("settings:companies")));
    steps.appendChild(stepRow(s2, "Профиль филиала",
        "Укажите название, адрес, район и часы работы первого филиала.", "Открыть",
        () => nav("settings:branches")));
    // NOTIF_POLICY_V2 — «Загрузить лицензию» step removed
    card.appendChild(steps);

    const root = document.querySelector(".app") || document.body.firstChild;
    const vb = document.getElementById("verify-banner");
    if (vb && vb.parentNode) vb.parentNode.insertBefore(card, vb.nextSibling);
    else document.body.insertBefore(card, root);
}
