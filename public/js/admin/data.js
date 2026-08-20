// Easy-Med — data layer.
// Wraps Supabase fetches and reshapes rows into the field names the views expect
// (patient.firstName, patient.lastName, etc.) — those names came from the design
// sample's mock data. Falls back to demo data when the DB is empty / unreachable,
// so the UI always renders something to look at.

import { supabase } from '../supabase.js';
import { searchTokens, loosePhonePattern } from './patient-search.js?v=ps1';   // PATIENT_SEARCH_TOKENS_V1
import { avColor, initials } from './ui.js';
import { branchScope, branchSelectionNarrows } from './branch-filter.js?v=bf4';   // BRANCH_ISOLATION_V1 + PATIENTS_CLINIC_WIDE_V1
import { getSelectedBranchIds, soleBranchId } from './branch-context.js?v=bc3';   // soleBranchId: SOLE_BRANCH_V1
// PATIENT_DUP_RULE_V2 — one definition of "same person", shared by the register
// scan and the registration-time guard. See the header of that file for the rule.
import { duplicateIdSet, namesMatch, levenshtein as rawLevenshtein } from './patient-duplicates.js';

// ---------------------------------------------------------------------------
// DEMO DATA — used as fallback when Supabase is empty or unreachable.
// Mirrors design-sample/src/data.jsx.
// ---------------------------------------------------------------------------
const DEMO_PATIENTS = [
    { mrn: 'EM-204781', firstName: 'Aziza',   lastName: 'Karimova',   middle: 'R.', dob: '1989-03-12', age: 36, gender: 'F', phone: '+998 90 123 45 67', pinfl: '50312890012345', citizenship: 'Uzbekistan', city: 'Tashkent',   blood: 'A+',  allergies: ['Penicillin'],            conditions: ['Hypertension'],                       status: 'active',     lastVisit: '2026-05-20', balance: 0,         insurance: 'GROSS Insurance',  doctor: 'Dr. Yusupov',     doctorSpec: 'Cardiology'  },
    { mrn: 'EM-204776', firstName: 'Bobur',   lastName: 'Tursunov',   middle: 'S.', dob: '1976-09-04', age: 49, gender: 'M', phone: '+998 91 845 22 18', pinfl: '40409760023456', citizenship: 'Uzbekistan', city: 'Samarkand',  blood: 'O-',  allergies: [],                        conditions: ['Type 2 Diabetes', 'Hyperlipidemia'],  status: 'inpatient',  lastVisit: '2026-05-22', balance: 1240000,   insurance: 'Self-pay',         doctor: 'Dr. Rasulova',    doctorSpec: 'Endocrinology' },
    { mrn: 'EM-204769', firstName: 'Madina',  lastName: 'Akhmedova',  middle: '',   dob: '2014-11-28', age: 11, gender: 'F', phone: '+998 93 410 09 02', pinfl: '51428140034567', citizenship: 'Uzbekistan', city: 'Tashkent',   blood: 'B+',  allergies: ['Sulfa drugs'],           conditions: [],                                     status: 'active',     lastVisit: '2026-05-18', balance: 0,         insurance: 'Pediatric State',  doctor: 'Dr. Imamova',     doctorSpec: 'Pediatrics'   },
    { mrn: 'EM-204755', firstName: 'Jasur',   lastName: 'Norqulov',   middle: 'A.', dob: '1962-01-19', age: 64, gender: 'M', phone: '+998 90 553 71 04', pinfl: '40119620045678', citizenship: 'Uzbekistan', city: 'Bukhara',    blood: 'AB+', allergies: ['Aspirin'],               conditions: ['CAD', 'Atrial Fibrillation'],         status: 'critical',   lastVisit: '2026-05-22', balance: 3650000,   insurance: 'Asia Med Holding', doctor: 'Dr. Yusupov',     doctorSpec: 'Cardiology'  },
    { mrn: 'EM-204720', firstName: 'Dilnoza', lastName: 'Saidova',    middle: '',   dob: '1995-07-23', age: 30, gender: 'F', phone: '+998 99 718 02 11', pinfl: '50723950056789', citizenship: 'Uzbekistan', city: 'Tashkent',   blood: 'O+',  allergies: [],                        conditions: ['Asthma'],                             status: 'active',     lastVisit: '2026-04-29', balance: 0,         insurance: 'Self-pay',         doctor: 'Dr. Ergashev',    doctorSpec: 'Pulmonology'  },
    { mrn: 'EM-204711', firstName: 'Rustam',  lastName: 'Khakimov',   middle: 'B.', dob: '1981-04-30', age: 44, gender: 'M', phone: '+998 90 922 64 18', pinfl: '40430810067890', citizenship: 'Uzbekistan', city: 'Andijan',    blood: 'A-',  allergies: [],                        conditions: [],                                     status: 'discharged', lastVisit: '2026-05-15', balance: 0,         insurance: 'Self-pay',         doctor: 'Dr. Tashkenbaev', doctorSpec: 'Orthopedics' },
    { mrn: 'EM-204692', firstName: 'Nilufar', lastName: 'Yusupova',   middle: '',   dob: '1958-12-08', age: 67, gender: 'F', phone: '+998 91 220 13 55', pinfl: '51208580078901', citizenship: 'Uzbekistan', city: 'Tashkent',   blood: 'B-',  allergies: ['Iodine'],                conditions: ['Osteoarthritis', 'Hypertension'],    status: 'active',     lastVisit: '2026-05-10', balance: 480000,    insurance: 'GROSS Insurance',  doctor: 'Dr. Tashkenbaev', doctorSpec: 'Orthopedics' },
    { mrn: 'EM-204680', firstName: 'Sherzod', lastName: 'Mirzaev',    middle: 'F.', dob: '2002-08-17', age: 23, gender: 'M', phone: '+998 90 100 22 87', pinfl: '40817020089012', citizenship: 'Uzbekistan', city: 'Tashkent',   blood: 'A+',  allergies: [],                        conditions: [],                                     status: 'active',     lastVisit: '2026-05-22', balance: 0,         insurance: 'Self-pay',         doctor: 'Dr. Ergashev',    doctorSpec: 'Pulmonology'  },
];
for (const p of DEMO_PATIENTS) {
    p.initials = (p.firstName[0] + p.lastName[0]).toUpperCase();
    p.avColor = avColor(p.mrn);
}

const DEMO_DOCTORS = [
    { id: 'd1', name: 'Dr. Yusupov',     specialty: 'Cardiology',    room: '204', booked: 6, capacity: 12 },
    { id: 'd2', name: 'Dr. Rasulova',    specialty: 'Endocrinology', room: '208', booked: 4, capacity: 10 },
    { id: 'd3', name: 'Dr. Ergashev',    specialty: 'Pulmonology',   room: '301', booked: 8, capacity: 10 },
    { id: 'd4', name: 'Dr. Imamova',     specialty: 'Pediatrics',    room: '110', booked: 9, capacity: 14 },
    { id: 'd5', name: 'Dr. Tashkenbaev', specialty: 'Orthopedics',   room: '405', booked: 5, capacity: 10 },
    { id: 'd6', name: 'Dr. Karimov',     specialty: 'Neurology',     room: '312', booked: 3, capacity: 8 },
];
for (const d of DEMO_DOCTORS) {
    d.initials = initials(d.name.replace(/^Dr\.\s*/i, ''));
    d.avColor = avColor(d.id);
}

const DEMO_APPTS = [
    { time: '08:30', patientIdx: 0, doctor: 'Dr. Yusupov',     room: 'Cardio · 204', status: 'completed',   kind: 'Follow-up'    },
    { time: '09:00', patientIdx: 2, doctor: 'Dr. Imamova',     room: 'Peds · 110',   status: 'completed',   kind: 'Vaccination'  },
    { time: '09:30', patientIdx: 4, doctor: 'Dr. Ergashev',    room: 'Pulm · 301',   status: 'in-progress', kind: 'Consultation' },
    { time: '10:00', patientIdx: 1, doctor: 'Dr. Rasulova',    room: 'Endo · 208',   status: 'in-progress', kind: 'Lab review'   },
    { time: '10:30', patientIdx: 7, doctor: 'Dr. Ergashev',    room: 'Pulm · 301',   status: 'waiting',     kind: 'First visit'  },
    { time: '11:00', patientIdx: 6, doctor: 'Dr. Tashkenbaev', room: 'Ortho · 405',  status: 'scheduled',   kind: 'Pre-op'       },
    { time: '11:30', patientIdx: 3, doctor: 'Dr. Yusupov',     room: 'Cardio · 204', status: 'scheduled',   kind: 'Urgent'       },
    { time: '12:00', patientIdx: 5, doctor: 'Dr. Tashkenbaev', room: 'Ortho · 405',  status: 'scheduled',   kind: 'Post-op'      },
].map(a => ({ ...a, patient: DEMO_PATIENTS[a.patientIdx] }));

const DEMO_NOTIFS = [
    { kind: 'lab',   text: 'Lab result ready for Bobur Tursunov',          time: '2 min ago',  urgent: false },
    { kind: 'crit',  text: 'Critical vitals · Jasur Norqulov (Room 308)',  time: '14 min ago', urgent: true  },
    { kind: 'sched', text: 'New appointment requested · 14:30 Dr. Yusupov', time: '32 min ago', urgent: false },
];

const DEMO_BEDS = [
    { dept: 'ICU',         total: 12, used: 11, color: 'crit' },
    { dept: 'Cardiology',  total: 24, used: 18, color: 'ok'   },
    { dept: 'Pulmonology', total: 16, used: 13, color: 'ok'   },
    { dept: 'Pediatrics',  total: 20, used: 9,  color: 'ok'   },
    { dept: 'Orthopedics', total: 18, used: 14, color: 'warn' },
    { dept: 'Maternity',   total: 14, used: 6,  color: 'ok'   },
];

const DEMO_KPI = {
    patients: [42, 48, 51, 47, 55, 62, 58, 64, 71, 68, 74, 78, 82, 79],
    revenue:  [310, 280, 340, 410, 380, 420, 460, 440, 500, 520, 490, 560, 600, 580],
    ops:      [10, 12, 11, 14, 13, 12, 15, 16, 14, 17, 18, 16, 19, 18],
};

// ---------------------------------------------------------------------------
// Row → view-model transforms
// ---------------------------------------------------------------------------
function ageFromDob(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
}

function shapePatient(row) {
    // Split full_name when first_name/last_name aren't filled in.
    let firstName = row.first_name || '';
    let lastName  = row.last_name  || '';
    if (!firstName && !lastName && row.full_name) {
        const parts = row.full_name.trim().split(/\s+/);
        lastName  = parts[0] || '';
        firstName = parts.slice(1).join(' ');
    }
    const middle = row.middle_name || '';
    const fullName = row.full_name || `${lastName} ${firstName}`.trim();
    return {
        id:            row.id,
        mrn:           row.mrn || '—',
        firstName, lastName, middle,
        fullName,
        dob:           row.date_of_birth || '',
        age:           ageFromDob(row.date_of_birth),
        gender:        (row.gender === 'female' ? 'F' : row.gender === 'male' ? 'M' : (row.gender || '')),
        phone:         row.phone || '',
        pinfl:         row.national_id || row.passport_number || '',
        citizenship:   row.nationality || row.country || '',
        city:          row.city || row.region || '',
        blood:         row.blood_type || '',
        allergies:     (row.allergies || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean),
        conditions:    (row.chronic_conditions || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean),
        status:        row.active === false ? 'discharged' : 'active',
        lastVisit:     row.last_visit_date || (row.registration_date || row.created_at || '').slice(0, 10),
        balance:       0,                       // computed later if invoices exist
        visitCount:    0,                       // RegBase: filled by patient_base_aggregates RPC
        registrar:     '',
        payerType:     '',
        insurance:     row.__payer_name || '',
        doctor:        row.__doctor_name || '',
        doctorSpec:    row.__doctor_specialty || '',
        initials:      ((firstName[0] || lastName[0] || '?') + (lastName[0] || '')).toUpperCase().slice(0, 2),
        avColor:       avColor(row.id || row.mrn || fullName),
        telegramOptIn: row.telegram_opt_in === true,   // surfaced for the registrar Телеграм column
        photoUrl:      row.photo_url || '',
        createdBy:     row.created_by || '',
        _raw:          row,
    };
}

function shapeDoctor(row) {
    return {
        id:           row.id,
        name:         row.full_name,
        specialty:    row.specialty || row.__department_name || 'General',
        // DOCTOR_ROOM_V1: rooms(name, floors(name)) embed from loadDoctors()
        room:         row.rooms?.name || row.__room || '—',
        floor:        row.rooms?.floors?.name || '',
        booked:       0,
        capacity:     10,
        initials:     initials((row.full_name || '').replace(/^Dr\.\s*/i, '')),
        avColor:      avColor(row.id),
        workingHours: row.working_hours || null,   // {mon:{enabled,from,to}, …}
        _raw:         row,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function safeSelect(table, q = (b) => b) {
    try {
        const { data, error } = await q(supabase.from(table).select('*'));
        if (error) { console.warn(`[easymed/data] ${table} failed:`, error.message); return null; }
        return data;
    } catch (e) {
        console.warn(`[easymed/data] ${table} threw:`, e.message);
        return null;
    }
}

export async function loadPatients({ limit = 200, doctorId = null } = {}) {
    // Doctor-scoped login: only patients this doctor "owns" — i.e. has at
    // least one visit_service assigned to them, OR is the patient's primary
    // doctor. Everyone else (admin/reception) sees the full register.
    if (doctorId) return loadPatientsForDoctor(doctorId, limit);
    const rows = await safeSelect('patients', (b) => b.order('created_at', { ascending: false }).limit(limit));
    return (rows || []).map(shapePatient);
}

// Server-side paged + searchable patient lookup. Used by the Patients list so
// we never pull the full register into the browser — only the visible page
// plus an exact total count.
//
// opts:
//   limit    : page size (default 30)
//   offset   : zero-based offset
//   search   : free-text term — ilike-matched across name parts, MRN, phone, PINFL
//   filter   : 'all' | 'inpatient' | 'active'   ('active' = visited in last 6 mo)
//   sort     : 'recent' | 'az' | 'mrn'
//   doctorId : optional doctor scope (re-uses the existing in-memory path)
//
// Returns: { rows, total }
// TENANT_SCOPE_V3 — on a clinic subdomain pin patient reads/inserts to that
// clinic. Migration 094 already isolates clinic admins server-side; this matters
// for super admins / platform staff, whose JWT passes RLS on every subdomain.
function _tenantClinicId() {
    return (typeof window !== 'undefined' && window.CLINIC && window.CLINIC.id) || null;
}

export async function loadPatientsPaged({
    limit = 30, offset = 0, search = '', filter = 'all', sort = 'recent', doctorId = null,
    dob = '',   // PATIENT_SEARCH_DOB_V1
    // Optional restrict-to id set (e.g. precomputed "patients that share a
    // phone/PINFL with someone else" — used by the Duplicates filter card).
    // Empty array short-circuits to zero rows so an empty result is honest.
    idsIn = null,
} = {}) {
    // Doctor-scoped login still uses the legacy code path (it joins via
    // visit_services and is cheap enough to do client-side).
    if (doctorId) {
        const all = await loadPatientsForDoctor(doctorId, 5000);
        // PATIENT_SEARCH_TOKENS_V1 / _DOB_V1 — врачебный список фильтруется в
        // браузере, но правила поиска обязаны совпадать с общим списком, иначе
        // один и тот же запрос находит разное в зависимости от того, кто вошёл.
        const words = searchTokens(search).map(w => w.replace(/\\(.)/g, '$1').toLowerCase());
        const dobT = (dob || '').trim();
        let filtered = all.filter(p => {
            if (filter === 'inpatient' && p.status !== 'inpatient') return false;
            if (dobT && String(p.date_of_birth || '').slice(0, 10) !== dobT) return false;
            if (!words.length) return true;
            const hay = [p.firstName, p.lastName, p.full_name, p.mrn, p.phone, p.pinfl]
                .map(v => (v || '').toLowerCase());
            return words.every(w => hay.some(v => v.includes(w)));
        });
        return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
    }

    let q = supabase.from('patients').select('*', { count: 'exact' });
    const _tcid = _tenantClinicId();   // TENANT_SCOPE_V3
    if (_tcid) q = q.eq('company_id', _tcid);
    // PATIENTS_CLINIC_WIDE_V1 — patients are shared across the whole clinic:
    // branch staff are no longer confined to their branch's register (was
    // BRANCH_ISOLATION_V1). The branch filter still applies when someone
    // voluntarily narrows the branch picker to a subset.
    if (branchSelectionNarrows()) q = branchScope(q, 'patients');

    // Caller-supplied id restriction (Duplicates card uses this). An empty
    // array means "no matches" — return immediately rather than fire a
    // weird `in(...empty list)` against PostgREST.
    if (Array.isArray(idsIn)) {
        if (idsIn.length === 0) return { rows: [], total: 0 };
        q = q.in('id', idsIn);
    }

    // The `last_visit_date` and `status` columns on patients existed in an
    // earlier schema; the current public.patients table doesn't have them.
    // Resolve "Active" / "Inpatient" tabs by deriving from registration_date
    // and recent visits instead. (Inpatient currently falls back to the
    // full list — proper derivation needs a join through admissions.)
    if (filter === 'inpatient') {
        // No column on patients to gate by; let the inpatient view derive
        // its own list. Show nothing here for now to avoid surprising data.
        q = q.eq('id', '00000000-0000-0000-0000-000000000000');
    } else if (filter === 'active') {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 6);
        q = q.gte('registration_date', cutoff.toISOString().slice(0, 10));
    }

    // PATIENT_SEARCH_TOKENS_V1 — поиск по кускам фамилии И имени.
    //
    // Было: один ilike('full_name', '%запрос%'), то есть запрос искался как
    // НЕПРЕРЫВНАЯ подстрока — «Эрг Жах» не находило «Эргашев Жахонгир». Комментарий
    // рядом объяснял это тем, что «у локального клиента нет .or()»; он устарел —
    // db-client.js умеет .or(), а query-compiler.js собирает из этого OR-группу.
    //
    // Теперь каждое СЛОВО — отдельное условие (И между словами), и каждое ищется
    // в имени, номере карты и телефоне (ИЛИ между полями). Поэтому порядок слов
    // не важен, а плейсхолдер «по ФИО, ID или номеру телефона» наконец не врёт:
    // раньше поиск по ID и телефону не работал вовсе.
    //
    // first_name/last_name намеренно не участвуют: их нет в списке filters
    // реестра, а full_name собран как «Фамилия Имя Отчество» и покрывает оба.
    for (const token of searchTokens(search)) {
        const pat = `%${token}%`;
        const terms = [`full_name.ilike.${pat}`, `mrn.ilike.${pat}`, `phone.ilike.${pat}`];
        // PATIENT_SEARCH_PHONE_V1 — телефон лежит и как «998915930555», и как
        // «+998 94 877 67 67»: для длинного цифрового запроса добавляем шаблон,
        // терпимый к пробелам, иначе вторые не находятся никогда.
        const loose = loosePhonePattern(token);
        if (loose) terms.push(`phone.ilike.${loose}`);
        q = q.or(terms.join(','));
    }

    // PATIENT_SEARCH_DOB_V1 — поиск по дате рождения. Тёзок в регистратуре
    // много, и дата рождения — то, чем их различают на стойке.
    const dobTerm = (dob || '').trim();
    if (dobTerm) q = q.eq('date_of_birth', dobTerm);

    // Sort order — only reference columns we know exist on the live schema.
    if (sort === 'az')         q = q.order('last_name',         { ascending: true,  nullsFirst: false });
    else if (sort === 'mrn')   q = q.order('mrn',               { ascending: true,  nullsFirst: false });
    else                       q = q.order('registration_date', { ascending: false, nullsFirst: false })
                                    .order('created_at',        { ascending: false });

    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) {
        console.warn('[loadPatientsPaged]', error.message);
        return { rows: [], total: 0 };
    }
    const rows = (data || []).map(shapePatient);
    // RegBase aggregates (Визитов/ДМС/Баланс/Регистратор/Последний визит) — one batch RPC, not N+1.
    if (rows.length) {
        try {
            const { data: aggs } = await supabase.rpc('patient_base_aggregates', { p_ids: rows.map(r => r.id) });
            const m = {};
            for (const a of (aggs || [])) m[a.patient_id] = a;
            for (const r of rows) {
                const a = m[r.id]; if (!a) continue;
                r.visitCount = Number(a.visit_count || 0);
                r.balance    = Number(a.balance || 0);
                r.insurance  = a.insurer || '';
                r.payerType  = a.payer_type || '';
                r.registrar  = a.registrar || '';
                if (a.last_visit) r.lastVisit = a.last_visit;
            }
        } catch (e) { console.warn('[patient_base_aggregates]', e.message); }
    }
    return { rows, total: count || 0 };
}

async function loadPatientsForDoctor(doctorId, limit) {
    const ids = new Set();
    // (a) Patients whose primary doctor is me.
    try {
        const { data, error } = await supabase
            .from('patients').select('id').eq('primary_doctor_id', doctorId).limit(5000);
        if (error) console.warn('[loadPatients/doctor] primary:', error.message);
        for (const r of (data || [])) ids.add(r.id);
    } catch (e) { console.warn('[loadPatients/doctor] primary threw:', e.message); }
    // (b) Patients I have a service for — visit_services.doctor_id = me,
    // resolved to patient_id through the visit.
    try {
        const { data, error } = await supabase
            .from('visit_services').select('visits(patient_id)').eq('doctor_id', doctorId).limit(5000);
        if (error) console.warn('[loadPatients/doctor] visit_services:', error.message);
        for (const r of (data || [])) { const pid = r.visits?.patient_id; if (pid) ids.add(pid); }
    } catch (e) { console.warn('[loadPatients/doctor] services threw:', e.message); }

    if (ids.size === 0) return [];
    const rows = await safeSelect('patients', (b) =>
        b.in('id', [...ids]).order('created_at', { ascending: false }).limit(limit));
    return (rows || []).map(shapePatient);
}

// Backfill MRNs for any patient that has none. The DB trigger (003) only
// assigns an MRN on INSERT, so rows created before that trigger existed — or
// any row whose mrn ended up null/empty — slip through. This patches them on
// the fly: a unique P-<YY>-<NNNNN> code is generated client-side and written
// back. Idempotent — once every row has an MRN it does nothing. Returns the
// number of rows fixed. Mutates the passed shaped objects so the caller can
// repaint without a reload.
export async function ensurePatientMrns(patients) {
    const missing = (patients || []).filter(p => !(p._raw && p._raw.mrn) && p.id);
    if (missing.length === 0) return 0;

    const taken = new Set((patients || []).map(p => p._raw && p._raw.mrn).filter(Boolean));
    let fixed = 0;
    for (const p of missing) {
        const mrn = genMrn(taken);
        const { error } = await supabase.from('patients').update({ mrn }).eq('id', p.id);
        if (error) {
            // Unique-violation against a row outside our window, or RLS — skip
            // and let the next page load retry. Don't block the list.
            console.warn('[mrn backfill] failed for', p.id, '—', error.message);
            taken.delete(mrn);
            continue;
        }
        p.mrn = mrn;
        if (p._raw) p._raw.mrn = mrn;
        fixed++;
    }
    return fixed;
}

// Generate a P-<YY>-<NNNNN> MRN that isn't already in `taken`. Uses a random
// 5-digit suffix (per the request) in a high range so it won't clash with the
// low, sequential numbers the DB sequence hands out to future inserts.
function genMrn(taken) {
    const yy = String(new Date().getFullYear()).slice(-2);
    for (let i = 0; i < 64; i++) {
        const n = Math.floor(10000 + Math.random() * 89999);   // 5 digits
        const mrn = `P-${yy}-${n}`;
        if (!taken.has(mrn)) { taken.add(mrn); return mrn; }
    }
    // Vanishingly unlikely fallback — timestamp tail guarantees uniqueness.
    const mrn = `P-${yy}-${String(Date.now()).slice(-6)}`;
    taken.add(mrn);
    return mrn;
}

export async function loadDoctors() {
    // Pull every active user — we'll narrow to bookable performers below.
    // Filters on `role` can drop staff whose role is set via role_id only,
    // or whose role text is a custom string, so we cast a wider net and
    // decide here. We also include anyone who has services configured under
    // their Services & rates (service_rates JSONB) — that's an unambiguous
    // signal they perform something bookable, even if their role / specialty
    // hasn't been filled in (e.g. lab technicians, procedure nurses).
    // DOCTOR_ROOM_V1: own embedded query (safeSelect hardcodes select('*') and
    // is shared by 7+ callers — do not widen it). Falls back to safeSelect on error.
    let rows;
    {
        const _cid = _tenantClinicId();   // M1 — scope to the subdomain clinic (a super-admin JWT sees every clinic's users otherwise)
        const { data, error } = await supabase
            .from('users')
            .select('*, rooms(name, floors(name))')
            .eq('company_id', _cid)
            .eq('active', true)
            .order('full_name');
        if (error) {
            console.warn('[easymed/data] loadDoctors embed failed, fallback:', error.message);
            rows = await safeSelect('users', (b) => b.eq('company_id', _cid).eq('active', true).order('full_name'));
        } else {
            rows = data;
        }
    }
    if (!rows || rows.length === 0) return [];
    const doctorRows = rows.filter(r =>
        r.is_doctor === true ||   // ADMIN_DOCTOR_LIST_V1 — admin-doctors have no role='doctor'/specialty
        (r.role || '').toLowerCase() === 'doctor' ||
        (r.specialty || '').length > 0 ||
        (r.license_number || '').length > 0 ||
        (Array.isArray(r.service_rates) && r.service_rates.length > 0)
    );
    return (doctorRows.length ? doctorRows : rows).map(shapeDoctor);
}

export async function loadTodayAppointments() {
    const today = new Date();
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const dayEnd   = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();

    // `appointments` was superseded by `visits` — query visits directly (removes the dead-table 404 probe).
    let rows = await safeSelect('visits', (b) =>
        b.gte('visit_date', dayStart).lt('visit_date', dayEnd).order('visit_date'));
    if (!rows || rows.length === 0) return [];

    // Best-effort patient + doctor join (one extra query each, fine for today's volume).
    const patientIds = [...new Set(rows.map(r => r.patient_id).filter(Boolean))];
    const doctorIds  = [...new Set(rows.map(r => r.doctor_id || r.user_id).filter(Boolean))];
    const [pats, docs] = await Promise.all([
        patientIds.length ? safeSelect('patients', b => b.in('id', patientIds)) : [],
        doctorIds.length  ? safeSelect('users',    b => b.in('id', doctorIds))  : [],
    ]);
    const patById = new Map((pats || []).map(p => [p.id, shapePatient(p)]));
    const docById = new Map((docs || []).map(d => [d.id, shapeDoctor(d)]));

    return rows.map(r => {
        const dt = new Date(r.start_time || r.visit_date);
        const hh = String(dt.getHours()).padStart(2, '0');
        const mm = String(dt.getMinutes()).padStart(2, '0');
        const patient = patById.get(r.patient_id) || { firstName: '—', lastName: '', middle: '', initials: '—', avColor: 'var(--ink-300)', age: null, gender: '', mrn: '—' };
        const docId = r.doctor_id || r.user_id || null;
        const doc = docById.get(docId);
        return {
            id:        r.id,
            time:      `${hh}:${mm}`,
            patient,
            doctorId:  docId,
            doctor:    doc?.name || '—',
            doctorSpec: doc?.specialty || '',
            room:      r.room || (doc?.specialty || '—'),
            durationMinutes: r.duration_minutes || 30,
            status:    r.status || 'scheduled',
            kind:    r.kind || r.visit_kind || r.visit_type || 'Visit',
        };
    });
}

export async function loadDashboardKpis() {
    // Counts from live DB. No historical aggregation, so no trend sparklines are emitted.
    const todayStr = new Date().toISOString().slice(0, 10);
    const _cid = _tenantClinicId();   // M1 — scope KPIs to the subdomain clinic (super-admin would blend all clinics)
    const [pCount, opCount, bedRows, rev] = await Promise.all([
        (async () => { try { const { count } = await supabase.from('patients').select('id', { count: 'exact', head: true }).eq('company_id', _cid); return count; } catch { return null; } })(),
        safeSelect('visits', (b) => b.eq('company_id', _cid).eq('status', 'in_progress').gte('visit_date', todayStr)),
        safeSelect('beds', (b) => b.eq('company_id', _cid)),
        safeSelect('invoices', (b) => b.eq('company_id', _cid).gte('created_at', todayStr)),
    ]);
    return {
        patientsToday: pCount ?? 0,
        activeOps:     (opCount?.length ?? null) ?? 0,
        revenueToday:  Math.round(((rev || []).reduce((s, r) => s + Number(r.total_amount || r.total || 0), 0)) / 100000) / 10 || 0,
        bedOccupancy:  bedRows && bedRows.length
            ? Math.round((bedRows.filter(b => b.status === 'occupied').length / bedRows.length) * 100)
            : 0,
    };
}

async function countTable(table) {
    try {
        const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
        if (error) return null;
        return count;
    } catch { return null; }
}


// The signed-in actor (registrar / clinician). Used to stamp created_by and to
// scope the per-registrar "my day" dashboard. Reads the live actor off
// window.easymed so callers don't have to prop-drill it.
export function currentUser() {
    return (typeof window !== 'undefined' && window.easymed?.state?.user) || null;
}

// ---------------------------------------------------------------------------
// Save patient (registration view)
// ---------------------------------------------------------------------------
export async function savePatient(payload, opts = {}) {
    // Map view-field names to DB columns where they differ.
    const insert = { ...payload };
    if (insert.firstName !== undefined) { insert.first_name  = insert.firstName;  delete insert.firstName; }
    if (insert.lastName  !== undefined) { insert.last_name   = insert.lastName;   delete insert.lastName; }
    if (insert.middle    !== undefined) { insert.middle_name = insert.middle;     delete insert.middle; }
    if (insert.dob       !== undefined) { insert.date_of_birth = insert.dob;      delete insert.dob; }
    if (insert.blood     !== undefined) { insert.blood_type = insert.blood;       delete insert.blood; }
    if (insert.pinfl     !== undefined) { insert.national_id = insert.pinfl;      delete insert.pinfl; }
    if (insert.gender) {
        const g = String(insert.gender).toLowerCase();
        insert.gender = g === 'm' ? 'male' : g === 'f' ? 'female' : g;
    }
    // gender is CHECK-constrained (male|female|other); drop anything else
    // (incl. an unselected empty value) so the DB default 'other' applies
    // instead of the insert failing.
    if (!['male', 'female', 'other'].includes(insert.gender)) delete insert.gender;
    // Stamp the registrar who created the record (powers "who registered" +
    // the per-registrar dashboard). Skipped for the bootstrap admin (no id).
    const uid = currentUser()?.id || null;
    if (uid && insert.created_by === undefined) insert.created_by = uid;
    // TENANT_SCOPE_V3 — file the patient under the subdomain clinic (a platform-staff
    // registrar would otherwise default to their own users.company_id).
    const _tcidIns = _tenantClinicId();
    if (_tcidIns && insert.company_id === undefined) insert.company_id = _tcidIns;
    // BRANCH_ISOLATION_V1 — file a new patient under the active branch (only when exactly one is
    // selected, so it's unambiguous); multiple/all selected leaves it company-wide (null).
    if (insert.branch_id === undefined) {
        const _selB = getSelectedBranchIds();
        // SOLE_BRANCH_V1 — единственный филиал подставляем и тогда, когда он снят
        // в переключателе филиалов: выбирать всё равно не из чего, а пациент без
        // филиала выпадал бы из отчётов по филиалу.
        if (_selB.length === 1) insert.branch_id = _selB[0];
        else if (soleBranchId() != null) insert.branch_id = soleBranchId();
    }
    // Synthesize full_name if absent (required by schema).
    if (!insert.full_name) insert.full_name = [insert.last_name, insert.first_name, insert.middle_name].filter(Boolean).join(' ').trim();

    // ---- Duplicate guard ---------------------------------------------------
    // Strong identifiers in this app: PINFL (national_id, 14-digit national ID
    // — unique per person) and phone. If either matches an existing patient we
    // refuse the insert and point the registrar at the existing record. Skips
    // empty values so blank fields don't collide. Pass { force: true } to skip
    // this check (the registrar has confirmed they really want a new record).
    if (!opts.force) {
        const candidates = await findDuplicateCandidates(insert);
        if (candidates.length) {
            const err = new Error('Possible duplicate patient(s).');
            err.code = 'DUPLICATE_PATIENT';
            err.existing = candidates;     // array — sorted by match quality
            err.matchedField = candidates[0]._reasons[0] || 'patient';
            throw err;
        }
    }
    // ------------------------------------------------------------------------

    const { data, error } = await insertRow('patients', insert, { stampCreatedBy: false });
    if (error) throw error;
    await linkCrmRequestsToPatient(data);   // CRM_LINK_ON_REGISTER_V1
    return shapePatient(data);
}

// CRM_LINK_ON_REGISTER_V1 — attach the call centre's waiting requests to a card
// the moment it exists.
//
// The call centre books people who are not patients yet — a cold call has a name
// and a phone, no card. Those requests carry patient_id = NULL, and the
// registrar's prefill matches on patient_id, so without this the booking would
// simply never reach them: the patient walks in, gets registered, and the
// services booked for that day stay invisible in CRM.
//
// The join is the PHONE, compared by digits only, because the call centre types
// «+998 90 123 45 67» and the registrar «901234567» for the same person — the
// same normalisation crm-phone-match.js already uses for its search. Only
// still-open requests are linked; a closed lead is history and must not be
// reopened by a namesake registering later.
export async function linkCrmRequestsToPatient(patient) {
    if (!patient || !patient.id) return 0;
    const digits = (s) => String(s || '').replace(/\D/g, '');
    const mine = digits(patient.phone);
    // A handful of digits is not an identity — refuse to match on a fragment
    // rather than link a stranger's booking to this card.
    if (mine.length < 7) return 0;
    try {
        const { data, error } = await supabase.from('crm_requests')
            .select('id, phone, patient_id, status')
            .is('patient_id', null)
            .in('status', ['scheduled', 'approved', 'in_process', 'recall']);
        if (error || !data || !data.length) return 0;

        // Compare on the local part so a number stored with the country code and
        // one without still match (998901234567 vs 901234567).
        const tail = (d) => (d.length > 9 ? d.slice(-9) : d);
        const hits = data.filter(r => {
            const theirs = digits(r.phone);
            return theirs.length >= 7 && tail(theirs) === tail(mine);
        });
        if (!hits.length) return 0;

        await supabase.from('crm_requests')
            .update({ patient_id: patient.id })
            .in('id', hits.map(r => r.id));
        return hits.length;
    } catch (e) {
        // Registration must never fail because of a CRM lookup.
        console.warn('[crm] link on register skipped:', e && e.message);
        return 0;
    }
}

// Levenshtein edit distance — used to spot typos in names. Lives in
// patient-duplicates.js (pure + unit-tested); this wrapper keeps the
// lowercase/trim normalisation the fuzzy full-name search below relies on.
const levenshtein = (a, b) => rawLevenshtein((a || '').toLowerCase().trim(), (b || '').toLowerCase().trim());

// Distance in days between two YYYY-MM-DD strings; large number if either is missing.
function dobDayDiff(a, b) {
    if (!a || !b) return 9999;
    const da = new Date(a.slice(0, 10)), db = new Date(b.slice(0, 10));
    if (isNaN(da) || isNaN(db)) return 9999;
    return Math.abs((da - db) / 86400000);
}

// Collect possible duplicates of an incoming patient record. Combines:
//   • exact phone match AND matching first name   (PATIENT_DUP_RULE_V2 — the
//     phone alone is a family signal, see patient-duplicates.js)
//   • exact PINFL (national_id)    (strongest signal, stands alone)
//   • fuzzy name match (≤2 chars Levenshtein on "<last> <first>"); boosted
//     when the date_of_birth also matches (exact / within a few days)
// Returns an array sorted by match score, top N. Each row carries a
// `_reasons` chip list and the source columns.
async function findDuplicateCandidates(insert) {
    const COLS = 'id, mrn, full_name, last_name, first_name, middle_name, phone, date_of_birth, national_id';
    const phone = (insert.phone || '').trim();
    const pinfl = (insert.national_id || '').trim();
    const ln    = (insert.last_name || '').trim();
    const fn    = (insert.first_name || '').trim();
    const dob   = (insert.date_of_birth || '').slice(0, 10);
    const cand  = new Map();   // id → { ...row, _reasons[], _score, _dist }

    const add = (row, reason, scoreBoost = 0) => {
        if (!row || !row.id) return;
        const c = cand.get(row.id) || { ...row, _reasons: [], _score: 0, _dist: null };
        if (!c._reasons.includes(reason)) {
            c._reasons.push(reason);
            c._score += scoreBoost;
        }
        cand.set(row.id, c);
    };

    const safeQuery = async (q) => { try { const { data } = await q; return data || []; } catch { return []; } };
    const _dupCid = _tenantClinicId();   // TENANT_SCOPE_V3 — duplicates are per-clinic
    const base = () => { const b = supabase.from('patients').select(COLS); return _dupCid ? b.eq('company_id', _dupCid) : b; };

    // PATIENT_DUP_RULE_V2 — a shared phone is a FAMILY signal, not an identity
    // one: parents register their children and grandparents on their own number.
    // It only means "same person" when the FIRST NAME matches too, otherwise the
    // registrar was blocked with a duplicate warning on every family member.
    // The surname is not consulted — a family shares that as well.
    if (phone) {
        for (const r of await safeQuery(base().eq('phone', phone).limit(10))) {
            if (namesMatch(fn, r.first_name)) add(r, 'same phone + name', 60);
        }
    }
    // A PINFL identifies one human, so it stands alone.
    if (pinfl) for (const r of await safeQuery(base().eq('national_id', pinfl).limit(5))) add(r, 'same PINFL', 80);

    // Fuzzy name. Pull a name pool (case-insensitive prefix on either part),
    // then filter client-side with Levenshtein. Prefix length 2 catches typos
    // away from the start while keeping the pool small.
    const pool = new Map();
    const fetchPrefix = async (col, val) => {
        if (val.length < 2) return [];
        return await safeQuery(base().ilike(col, val.slice(0, 2) + '%').limit(60));
    };
    for (const r of await fetchPrefix('last_name',  ln)) pool.set(r.id, r);
    for (const r of await fetchPrefix('first_name', fn)) pool.set(r.id, r);

    const target = `${ln} ${fn}`.toLowerCase().trim();
    for (const r of pool.values()) {
        const cmp = `${r.last_name || ''} ${r.first_name || ''}`.toLowerCase().trim();
        if (!target || !cmp) continue;
        const dist = levenshtein(target, cmp);
        if (dist <= 2) {
            const boost = dist === 0 ? 50 : dist === 1 ? 40 : 25;
            add(r, dist === 0 ? 'name matches' : `name ~ ${dist} char diff`, boost);
            const c = cand.get(r.id);
            c._dist = c._dist == null ? dist : Math.min(c._dist, dist);
            // DOB boost — exact match is strongest; within a week catches digit-typos.
            const diff = dobDayDiff(dob, r.date_of_birth);
            if (diff === 0)      { c._reasons.push('DOB matches'); c._score += 30; }
            else if (diff <= 7)  { c._reasons.push('DOB ≈ matches'); c._score += 15; }
        }
    }

    return [...cand.values()].sort((a, b) => b._score - a._score).slice(0, 8);
}

// Patients-list "Duplicates" chip. Scans the register and returns every id that
// is in a group of 2+ under the PATIENT_DUP_RULE_V2 rule: same PINFL, or same
// phone AND same first name. A shared family phone alone is NOT a duplicate —
// that is the normal case, not an error. Cheap enough for clinics with
// thousands of patients: one query plus an in-memory grouping. Returns Set<id>.
export async function findAllDuplicatePatientIds() {
    try {
        let _q = supabase.from('patients')
            .select('id, phone, national_id, first_name, full_name').limit(1000);
        const _tcid2 = _tenantClinicId();   // TENANT_SCOPE_V3
        if (_tcid2) _q = _q.eq('company_id', _tcid2);
        const { data, error } = await _q;
        if (error) { console.warn('[findAllDuplicatePatientIds]', error.message); return new Set(); }
        return duplicateIdSet(data || []);
    } catch (e) {
        console.warn('[findAllDuplicatePatientIds] threw:', e.message);
        return new Set();
    }
}

// Find duplicate candidates for an EXISTING patient (used by the patient
// card's merge tool). Runs the same fuzzy search as the registration guard
// but excludes the patient themselves.
export async function findDuplicatesForPatient(patient) {
    const raw = patient?._raw || patient || {};
    const id  = raw.id || patient?.id;
    if (!id) return [];
    const candidates = await findDuplicateCandidates({
        phone:         raw.phone         || patient?.phone,
        national_id:   raw.national_id   || patient?.pinfl,
        last_name:     raw.last_name     || patient?.lastName,
        first_name:    raw.first_name    || patient?.firstName,
        date_of_birth: raw.date_of_birth || patient?.dob,
    });
    return candidates.filter(c => String(c.id) !== String(id));
}

// ---------------------------------------------------------------------------
// PATIENT_FAMILY_V1 — shared patient text search (the 7-field ilike used by the
// list loader, lifted so the family-link picker reuses it) + the patient<->patient
// relationship graph (patient_relationships) and a read-only guardian load.
// ---------------------------------------------------------------------------
export async function searchPatientsByText(term, { excludeIds = [], limit = 8 } = {}) {
    const t = (term || '').trim();
    if (t.length < 2) return [];
    let q = supabase.from('patients')
        .select('id, mrn, full_name, last_name, first_name, middle_name, phone, national_id, date_of_birth')
        .limit(limit + (excludeIds.length || 0));
    const cid = _tenantClinicId();
    if (cid) q = q.eq('company_id', cid);
    const pat = `%${t}%`;
    q = q.or([
        `full_name.ilike.${pat}`, `last_name.ilike.${pat}`, `first_name.ilike.${pat}`,
        `middle_name.ilike.${pat}`, `mrn.ilike.${pat}`, `phone.ilike.${pat}`, `national_id.ilike.${pat}`,
    ].join(','));
    const { data, error } = await q;
    if (error) { console.warn('[searchPatientsByText]', error.message); return []; }
    const ex = new Set((excludeIds || []).map(String));
    return (data || []).filter(r => !ex.has(String(r.id))).slice(0, limit);
}

// relation_type is stored a->b ("a is the {relation_type} of b"). The label shown
// on a patient's card depends on which side they are. REL_INVERSE flips parent/child
// (guardian/ward handled by the read-only patient_guardians table, not offered here).
const REL_INVERSE   = { parent: 'child', child: 'parent', spouse: 'spouse', sibling: 'sibling', guardian: 'guardian', other: 'other' };
const REL_LABEL_A   = { parent: 'Ребёнок', child: 'Родитель', spouse: 'Супруг(а)', sibling: 'Брат/сестра', guardian: 'Подопечный', other: 'Родственник' };
const REL_LABEL_B   = { parent: 'Родитель', child: 'Ребёнок', spouse: 'Супруг(а)', sibling: 'Брат/сестра', guardian: 'Опекун', other: 'Родственник' };

export async function loadRelationshipsForPatient(patientId) {
    if (!patientId) return [];
    const cid = _tenantClinicId();
    let q = supabase.from('patient_relationships')
        .select('id, patient_id_a, patient_id_b, relation_type')
        .or(`patient_id_a.eq.${patientId},patient_id_b.eq.${patientId}`);
    if (cid) q = q.eq('company_id', cid);
    const { data, error } = await q;
    if (error) { console.warn('[loadRelationshipsForPatient]', error.message); return []; }
    const rows = data || [];
    const otherIds = rows.map(r => String(r.patient_id_a) === String(patientId) ? r.patient_id_b : r.patient_id_a);
    if (!otherIds.length) return [];
    const { data: pts } = await supabase.from('patients')
        .select('id, mrn, full_name, last_name, first_name, middle_name, phone').in('id', otherIds);
    const byId = {}; for (const p of (pts || [])) byId[String(p.id)] = p;
    return rows.map(r => {
        const isA = String(r.patient_id_a) === String(patientId);
        const otherId = isA ? r.patient_id_b : r.patient_id_a;
        const op = byId[String(otherId)] || {};
        return {
            relId: r.id, id: otherId, mrn: op.mrn || '',
            name: [op.last_name, op.first_name, op.middle_name].filter(Boolean).join(' ') || op.full_name || '—',
            phone: op.phone || '',
            relationLabel: (isA ? REL_LABEL_A : REL_LABEL_B)[r.relation_type] || 'Родственник',
        };
    });
}

// `relation` = how `other` relates to `current` (other is the {relation} of current),
// one of parent/child/spouse/sibling/other. Stored canonically (smaller uuid in _a).
export async function addPatientRelationship({ currentId, otherId, relation = 'other' }) {
    if (!currentId || !otherId || String(currentId) === String(otherId)) throw new Error('Bad relationship pair.');
    const aFirst = String(currentId).toLowerCase() < String(otherId).toLowerCase();
    const aId = aFirst ? currentId : otherId;
    const bId = aFirst ? otherId : currentId;
    const rt  = aFirst ? (REL_INVERSE[relation] || 'other') : relation;
    const row = { patient_id_a: aId, patient_id_b: bId, relation_type: rt };
    const cid = _tenantClinicId();
    if (cid) row.company_id = cid;
    const { error } = await supabase.from('patient_relationships')
        .upsert(row, { onConflict: 'company_id,patient_id_a,patient_id_b' });
    if (error) throw error;
}

export async function removePatientRelationship(relId) {
    if (!relId) return;
    const { error } = await supabase.from('patient_relationships').delete().eq('id', relId);
    if (error) throw error;
}

// Read-only: guardian links written at registration (patient_guardians). Surfaced
// in the Family card so the two mechanisms don't conflict; not editable here.
export async function loadGuardiansForPatient(patientId) {
    if (!patientId) return [];
    const cid = _tenantClinicId();
    let q = supabase.from('patient_guardians')
        .select('id, patient_id, guardian_patient_id, name, phone, relationship')
        .or(`patient_id.eq.${patientId},guardian_patient_id.eq.${patientId}`);
    if (cid) q = q.eq('company_id', cid);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
}

// Merge a set of duplicate patients into a chosen "primary" patient. Reassigns
// every known patient-scoped foreign key (visits, invoices, deposits, …) to
// the primary, then deletes the duplicate patient rows. Tables that don't
// exist on this DB (older migration set) are skipped gracefully.
//
// Returns { tablesUpdated:[…], duplicatesDeleted:N }.
export async function mergePatients({ primaryId, duplicateIds }) {
    if (!primaryId) throw new Error('No primary patient selected.');
    const dupes = (duplicateIds || []).filter(id => id && id !== primaryId);
    if (!dupes.length) throw new Error('No duplicate patients to merge.');

    // Every table holding a patient_id we know about. Adding a new one here is
    // all that's needed when a future migration introduces another link.
    const TABLES = [
        'visits',
        'invoices',
        'patient_deposits',
        'admissions',
        'recommended_services',
        'patient_activity_log',
        'patient_vitals',     // PATIENT_FAMILY_V1 — had patient_id; was orphaned on merge
        'visit_documents',    // PATIENT_FAMILY_V1 — ditto (lab_results/visit_services follow via visits)
    ];

    const tablesUpdated = [];
    for (const tbl of TABLES) {
        try {
            const { error } = await supabase.from(tbl)
                .update({ patient_id: primaryId })
                .in('patient_id', dupes);
            if (error) {
                if (!/relation .* does not exist|schema cache|could not find the table/i.test(error.message || '')) {
                    console.warn(`[mergePatients] ${tbl}:`, error.message);
                }
                continue;
            }
            tablesUpdated.push(tbl);
        } catch (e) {
            console.warn(`[mergePatients] ${tbl} threw:`, e.message);
        }
    }

    // PATIENT_FAMILY_V1 — patient_guardians has TWO patient endpoints; reassign both
    // (its patient_id FK is ON DELETE CASCADE, so links would be lost on delete otherwise).
    try {
        await supabase.from('patient_guardians').update({ patient_id: primaryId }).in('patient_id', dupes);
        await supabase.from('patient_guardians').update({ guardian_patient_id: primaryId }).in('guardian_patient_id', dupes);
        tablesUpdated.push('patient_guardians');
    } catch (e) { console.warn('[mergePatients] patient_guardians:', e.message); }

    // PATIENT_FAMILY_V1 — patient_relationships has a canonical (a<b) + unique-pair
    // constraint, so a blind reassign would violate them. Fetch dup-touching rows,
    // delete them, and recreate canonical, self-link-free, de-duped links to primary.
    try {
        const cid = _tenantClinicId();
        let rq = supabase.from('patient_relationships').select('id, patient_id_a, patient_id_b, relation_type')
            .or(`patient_id_a.in.(${dupes.join(',')}),patient_id_b.in.(${dupes.join(',')})`);
        if (cid) rq = rq.eq('company_id', cid);
        const { data: relRows } = await rq;
        const dupSet = new Set(dupes.map(String));
        const rebuilt = new Map();
        for (const r of (relRows || [])) {
            let a = dupSet.has(String(r.patient_id_a)) ? primaryId : r.patient_id_a;
            let b = dupSet.has(String(r.patient_id_b)) ? primaryId : r.patient_id_b;
            if (String(a) === String(b)) continue;            // self-link -> drop
            let rt = r.relation_type;
            if (String(a).toLowerCase() > String(b).toLowerCase()) { const t = a; a = b; b = t; rt = REL_INVERSE[rt] || rt; }
            rebuilt.set(`${a}|${b}`, { patient_id_a: a, patient_id_b: b, relation_type: rt, ...(cid ? { company_id: cid } : {}) });
        }
        const oldIds = (relRows || []).map(r => r.id);
        if (oldIds.length) await supabase.from('patient_relationships').delete().in('id', oldIds);
        if (rebuilt.size) await supabase.from('patient_relationships')
            .upsert([...rebuilt.values()], { onConflict: 'company_id,patient_id_a,patient_id_b', ignoreDuplicates: true });
        tablesUpdated.push('patient_relationships');
    } catch (e) { console.warn('[mergePatients] patient_relationships:', e.message); }

    // FKs are reassigned; the duplicate patient rows are now orphaned and
    // safe to drop.
    const { error: delErr } = await supabase.from('patients').delete().in('id', dupes);
    if (delErr) throw delErr;

    return { tablesUpdated, duplicatesDeleted: dupes.length };
}

// Fetch + shape a single patient by id (used to navigate from the duplicate
// dialog into the existing patient's card). Returns null if not found.
export async function loadPatientById(id) {
    if (!id) return null;
    const { data, error } = await supabase.from('patients').select('*').eq('id', id).maybeSingle();
    if (error) { console.warn('[loadPatientById]', error.message); return null; }
    if (!data) return null;
    // SLICE4_DOCTOR: resolve the attending doctor's name for the «Лечащий врач» header fact.
    if (data.primary_doctor_id) {
        try {
            const { data: doc } = await supabase.from('users')
                .select('full_name, specialty').eq('id', data.primary_doctor_id).maybeSingle();
            if (doc) { data.__doctor_name = doc.full_name || ''; data.__doctor_specialty = doc.specialty || ''; }
        } catch (e) { /* non-fatal */ }
    }
    return shapePatient(data);
}

// SLICE5_MEDCARD — structured medcard loaders + free-text cache mirror.
// shapePatient stays unchanged (reads the text columns); these power the card detail + writes.
export async function loadPatientConditions(pid) {
    if (!pid) return [];
    const { data, error } = await supabase.from('patient_conditions')
        .select('id,code,label,since_date,resolved_date,status,severity,note,created_at')
        .eq('patient_id', pid)
        .order('since_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
    if (error) { console.warn('[loadPatientConditions]', error.message); return []; }
    const rank = { active: 0, resolved: 1 };               // active before resolved (explicit, not lexical)
    return (data || []).sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
}
export async function loadPatientAllergies(pid) {
    if (!pid) return [];
    const { data, error } = await supabase.from('patient_allergies')
        .select('id,allergen,reaction,severity,note,created_at')
        .eq('patient_id', pid).order('created_at', { ascending: false });
    if (error) { console.warn('[loadPatientAllergies]', error.message); return []; }
    const rank = { severe: 0, moderate: 1, mild: 2 };       // severe-first
    return (data || []).sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}
// Re-derive the free-text cache so shapePatient arrays + header/Сводка counts stay correct.
// Conditions: mirror ACTIVE only (Сводка «Состояний» counts active). Allergies: mirror all.
// NOTE: chronic_conditions is therefore active-only and NOT a full-history backup — the
// patient_conditions table is the sole source of truth for resolved rows.
export async function syncConditionCache(pid) {
    const rows = await loadPatientConditions(pid);
    const text = rows.filter(r => r.status === 'active').map(r => r.label).join(', ');
    await supabase.from('patients').update({ chronic_conditions: text }).eq('id', pid);
    return rows;
}
export async function syncAllergyCache(pid) {
    const rows = await loadPatientAllergies(pid);
    const text = rows.map(r => r.allergen).join(', ');
    await supabase.from('patients').update({ allergies: text }).eq('id', pid);
    return rows;
}


// Update an existing patient. `patch` uses DB column names. Recomputes
// full_name from the name parts when any of them change. Tolerates columns the
// DB doesn't have yet (e.g. behavior_note before migration 025) by stripping
// them and retrying. Returns the reshaped patient.
export async function updatePatient(id, patch) {
    let payload = { ...patch };
    // Keep full_name coherent with the parts if any part is being edited.
    if (payload.last_name !== undefined || payload.first_name !== undefined || payload.middle_name !== undefined) {
        payload.full_name = [payload.last_name, payload.first_name, payload.middle_name]
            .filter(v => v != null && String(v).trim() !== '').join(' ').trim();
    }
    // Columns the DB rejected (missing/not in PostgREST's schema cache). We strip
    // them so the rest of the edit still saves, but report them back so the
    // caller can warn the user instead of falsely claiming everything saved.
    const dropped = [];
    for (let i = 0; i < 6; i++) {
        const res = await supabase.from('patients').update(payload).eq('id', id).select().single();
        if (!res.error) {
            const shaped = shapePatient(res.data);
            if (dropped.length) shaped.__droppedColumns = dropped;
            return shaped;
        }
        const m = /column "?([a-z_]+)"? .* does not exist/i.exec(res.error.message || '')
               || /could not find the '?([a-z_]+)'? column/i.exec(res.error.message || '');
        if (m && m[1] && m[1] in payload) {
            console.warn(`[data] dropping unknown column "${m[1]}" on patients update — apply the matching migration / reload the Supabase schema cache.`);
            dropped.push(m[1]);
            delete payload[m[1]];
            continue;
        }
        throw res.error;
    }
    const res = await supabase.from('patients').update(payload).eq('id', id).select().single();
    if (res.error) throw res.error;
    const shaped = shapePatient(res.data);
    if (dropped.length) shaped.__droppedColumns = dropped;
    return shaped;
}

// Insert a row and return { data, error } (single, with .select()). Stamps the
// signed-in actor into created_by (unless told not to / already set). If
// PostgREST rejects the row because a column isn't in its schema cache (a
// migration hasn't been applied yet — e.g. created_by / behavior_note from
// 025), strip the offending column and retry so the app keeps working.
export async function insertRow(table, row, { stampCreatedBy = true } = {}) {
    let payload = { ...row };
    const uid = currentUser()?.id || null;
    if (stampCreatedBy && uid && payload.created_by === undefined) payload.created_by = uid;
    for (let i = 0; i < 6; i++) {
        const res = await supabase.from(table).insert(payload).select().single();
        if (!res.error) return res;
        const m = /column "?([a-z_]+)"? .* does not exist/i.exec(res.error.message || '')
               || /could not find the '?([a-z_]+)'? column/i.exec(res.error.message || '');
        if (m && m[1] && m[1] in payload) {
            console.warn(`[data] dropping unknown column "${m[1]}" on ${table} — apply the matching migration.`);
            delete payload[m[1]];
            continue;
        }
        return res;
    }
    return await supabase.from(table).insert(payload).select().single();
}

// ---------------------------------------------------------------------------
// Per-registrar "My statistics of the day" (dashboard)
// ---------------------------------------------------------------------------
// All scoped to a single user (the signed-in registrar) for *today*:
//   • patientsToday — patients they registered (patients.created_by)
//   • servicesToday — service lines they added  (visit_services.created_by)
//   • revenueToday  — invoices they raised       (invoices.created_by)
//   • kpi           — % of their added services that have been completed/billed
// Returns zeros (not demo data) so a registrar with a quiet day sees an honest 0.
export async function loadMyDayStats(userId) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayIso = startOfToday.toISOString();

    const countMine = async (table) => {
        try {
            const { count, error } = await supabase.from(table)
                .select('id', { count: 'exact', head: true })
                .eq('created_by', userId).gte('created_at', todayIso);
            if (error) { console.warn(`[myday] ${table}:`, error.message); return 0; }
            return count || 0;
        } catch (e) { console.warn(`[myday] ${table} threw:`, e.message); return 0; }
    };

    const [patientsToday, servicesToday] = await Promise.all([
        countMine('patients'),
        countMine('visit_services'),
    ]);

    // Revenue + KPI need row data, not just counts.
    let revenueToday = 0;
    try {
        const { data, error } = await supabase.from('invoices')
            .select('total_amount, total')
            .eq('created_by', userId).gte('created_at', todayIso);
        if (error) console.warn('[myday] invoices:', error.message);
        revenueToday = (data || []).reduce((s, r) => s + Number(r.total_amount || r.total || 0), 0);
    } catch (e) { console.warn('[myday] invoices threw:', e.message); }

    // KPI: of the services I added today, how many are completed/billed?
    let kpi = 0;
    try {
        const { data, error } = await supabase.from('visit_services')
            .select('status, invoice_item_id')
            .eq('created_by', userId).gte('created_at', todayIso);
        if (error) console.warn('[myday] kpi:', error.message);
        const rows = data || [];
        const done = rows.filter(r => r.status === 'completed' || r.invoice_item_id).length;
        kpi = rows.length ? Math.round((done / rows.length) * 100) : 0;
    } catch (e) { console.warn('[myday] kpi threw:', e.message); }

    return {
        patientsToday,
        servicesToday,
        revenueToday: Math.round((revenueToday / 100000)) / 10 || 0,   // → M UZS, 1dp
        kpi,
    };
}

// (DEMO_* fixtures are inert internal fallbacks; no longer re-exported.)
