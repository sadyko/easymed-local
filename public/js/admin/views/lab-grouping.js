// LAB_GROUP_V1 (local port) — pure, DOM-free helpers behind the patient-
// grouped laboratory queue. No supabase, no DOM: safe to unit test directly.
//
// Ported from the production LIS (easymed.uz laboratory.js — pluralRu ~527,
// the paintList grouping block ~658-673). The grouping rule is identical:
// one card per patient-VISIT, keyed by visit_id, falling back to
// '_solo_' + id for an order with no visit.

// Russian plural-form picker: 1 анализ / 2 анализа / 5 анализов.
export function pluralRu(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

// Group visit_services rows into one card per patient-visit.
//
//   rows       — visit_services rows (each has .id, .visit_id, .services{}).
//   patientMap — visit_id -> { visit_date, patient } (laboratory.js state shape).
//   accessionOf — optional (row) -> string, used to stamp a representative
//                 accession number on the group (the group's first row's
//                 accession, same convention the server uses).
//
// Returns an array of groups, in first-seen order:
//   { key, visitId, patientId, patientName, patientMrn, patientSex,
//     patientDob, accession, rows: [visit_services row, ...] }
export function groupLabRows(rows, patientMap, accessionOf) {
    const pm = patientMap || {};
    const groups = [];
    const byKey = new Map();
    for (const r of (rows || [])) {
        const key = r.visit_id != null ? r.visit_id : ('_solo_' + r.id);
        let g = byKey.get(key);
        if (!g) {
            const info = pm[r.visit_id] || {};
            const patient = info.patient || {};
            g = {
                key,
                visitId: r.visit_id != null ? r.visit_id : null,
                patientId: patient.id != null ? patient.id : null,
                patientName: patient.full_name || '—',
                patientMrn: patient.mrn || '',
                patientSex: (patient.gender || '').toLowerCase(),
                patientDob: patient.date_of_birth || null,
                accession: accessionOf ? accessionOf(r) : null,
                rows: [],
            };
            byKey.set(key, g);
            groups.push(g);
        }
        g.rows.push(r);
    }
    return groups;
}

// LAB_SELECT_OPTIONS_V1 — answer list for a «список» analyte.
//
// Storage format is what the panel editor writes into
// lab_panel_analytes.value_options: options separated by comma (also newline or
// semicolon), e.g. «Отрицательно, Следы, +, ++, +++». A JSON array is accepted
// too — the seeded catalogue (migrations 051/052) uses the comma form, but the
// production LIS this was ported from wrote JSON, so both must read.
export function parseOptions(raw) {
    if (!raw) return [];
    try {
        const j = JSON.parse(raw);
        if (Array.isArray(j)) return j.map(String);
    } catch (e) { /* not JSON — fall through to the comma form */ }
    return String(raw).split(/[,\n;]/).map(s => s.trim()).filter(Boolean);
}

// The options a select control should offer, WITH the already-saved answer
// prepended when the clinic has since edited that option out of the panel.
// Without this, reopening an old result shows «—» and re-saving would blank a
// value a lab tech had already signed off. Shared by both entry forms (the
// single-order modal and the combined worksheet) so they cannot drift.
export function selectOptionsFor(analyte, prev) {
    const opts = parseOptions(analyte && analyte.value_options);
    const saved = prev && prev.value != null ? String(prev.value).trim() : '';
    if (saved && !opts.includes(saved)) return [saved, ...opts];
    return opts;
}
