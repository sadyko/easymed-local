// Easy-Med — Admin section definitions
// Each section maps to one Supabase table. `columns` controls the list view,
// `fields` controls the add/edit form, `fkLookups` lists FK tables to preload
// so we can render labels (e.g. branch name) instead of UUIDs.
//
// `group` (optional) places the section under a collapsible sidebar group.
// Sections without a group appear at the top level of the sidebar.
// Insertion order in this object = sidebar order.
//
// Two sections can point at the same table by giving each a different
// section key. They share the underlying table but render different
// columns/fields.

export const SECTIONS = {
    // ============== DASHBOARD (standalone top item) ==============
    dashboard: {
        type: 'workflow',
        label: 'Dashboard',
        description: 'At-a-glance view of today\'s activity, alerts, and quick links.',
    },

    // ============== SERVICE SETTINGS GROUP ==============
    services: {
        group: 'Service settings',
        label: 'Service list',
        table: 'services',
        gatewayCrud: true,   // SERVICES_GATEWAY_V1 — custom services (core_service_id null) blocked by RLS; write via gateway
        branchScoped: true,   // BRANCH_ISOLATION_V2 — services.branch_id
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        fkLookups: ['departments', 'service_categories', 'service_types', 'ikpu_codes', 'product_nnm', 'rooms'],   // QUEUE_TICKET_V1 — rooms
        columns: [
            { key: 'name',           label: 'Name' },
            { key: 'code',           label: 'Code' },
            { key: 'type_id',        label: 'Type', lookup: 'service_types' },
            { key: 'category_id',    label: 'Category', lookup: 'service_categories' },
            { key: 'price',          label: 'Price', type: 'money' },   // SVC_COLS_V1 — Department column removed from view
            { key: 'tax_rate',       label: 'VAT %' },
            // SVC_COLS_V2 — IKPU column removed from the LIST view (still editable in the form's «Дополнительно» section)
            { key: 'duration_minutes', label: 'Duration', suffix: ' min' },
            { key: 'requires_doctor', label: 'Doctor', type: 'enum_label', options: [[true, 'Нужен врач', 'ok'], [false, 'Без врача', 'crit'], [null, '—', '']] },   // SVC_COLS_V1 + SVC_DOCTOR_TAG_COLOR_V1
            { key: 'active',         label: 'Status', type: 'bool' },
        ],
        // SERVICE_FORM_GROUPS_V1 — sectioned, 2-column dialog (mg-section/mg-grid).
        // Auto/fiscal fields sit in a lower "Дополнительно" section so the
        // primary inputs lead. Every field is listed so none is dropped.
        groups: [
            { title: 'Основное', fields: ['name', 'type', 'type_id', 'category_id', 'department_id', 'room_id'] },   // SERVICE_GROUP_ROUTING_V1 + QUEUE_TICKET_V1
            { title: 'Цена, налог и длительность', fields: ['price', 'tax_rate', 'duration_minutes', 'requires_doctor', 'default_doctor_percent', 'tube_color'] },
            { title: 'Врачи, выполняющие услугу', span: 'full', fields: ['service_doctors'] },
            { title: 'Дополнительно — код и фискализация', span: 'full', fields: ['code', 'ikpu_code_id', 'nnm_id', 'active'] },
        ],
        fields: [
            { key: 'name',             label: 'Service name (из каталога)', type: 'text', required: true, readOnly: true },
            { key: 'type',             label: 'Раздел — куда попадает услуга (маршрутизация)', type: 'select', default: 'consultation',
              options: [['consultation','Консультация (кабинет врача)'], ['lab','Лаборатория (лаб. модуль)'], ['procedure','Процедуры (процедурный лист)'], ['imaging','Диагностика'], ['other','Хирургия']] },
            { key: 'code',             label: 'Internal code (auto)', type: 'text', readOnly: true },
            { key: 'type_id',          label: 'Type (каталог)', type: 'fk', source: 'service_types', readOnly: true },
            { key: 'category_id',      label: 'Category (каталог)', type: 'fk', source: 'service_categories', readOnly: true },
            { key: 'department_id',    label: 'Department', type: 'fk', source: 'departments' },
            // QUEUE_TICKET_V1 — room the service is performed in. Drives the
            // per-room diagnostics queue number printed on the registration slip.
            { key: 'room_id',          label: 'Кабинет (очередь диагностики)', type: 'fk', source: 'rooms' },
            { key: 'price',            label: 'Price', type: 'number', step: '0.01', default: 0 },
            { key: 'tax_rate',         label: 'VAT rate (%)', type: 'number', step: '0.01', default: 12 },
            { key: 'duration_minutes', label: 'Duration (minutes)', type: 'number', default: 30 },
            { key: 'requires_doctor',  label: 'Requires a doctor', type: 'bool', default: true },
            { key: 'default_doctor_percent', label: 'Доля врача по умолчанию, % (для всех врачей; в карточке врача можно переопределить)', type: 'number', step: '0.01', default: 0 },   // DOCTOR_PAY_DEFAULT_V1
            { key: 'service_doctors',  label: 'Врачи, выполняющие услугу', type: 'service_doctors' },
            // Phlebotomy tube colour for lab tests (CLSI order of draw).
            // Only shown when the chosen service type is flagged as a lab test
            // (service_types.requires_tube). Hidden fields are left untouched on
            // save, so switching a service to a non-lab type keeps any prior value.
            { key: 'tube_color',       label: 'Tube colour (lab tests)', type: 'select',
              visibleWhen: (v, fk) => {
                  const t = (fk?.service_types || []).find(x => x.id === v.type_id);
                  return !!(t && t.requires_tube);
              },
              options: [
                ['',           '— (not a lab test)'],
                ['light_blue', 'Light blue · Coagulation (PT/INR/PTT)'],
                ['red',        'Red · Serum chemistry, drug levels'],
                ['gold',       'Gold (SST) · Chemistry, serology, immuno'],
                ['green',      'Green · Plasma chemistry, ammonia'],
                ['lavender',   'Lavender · CBC, hematology, HbA1c'],
                ['pink',       'Pink · Blood bank, crossmatch'],
                ['grey',       'Grey · Glucose, lactate'],
                ['royal_blue', 'Royal blue · Heavy metals, trace'],
                ['yellow_acd', 'Yellow ACD · HLA, paternity, flow cyto'],
                ['black',      'Black · ESR'],
                ['none',       'No tube · Urine, stool, swab, saliva'],
              ] },
            { key: 'ikpu_code_id',     label: 'IKPU code (каталог)', type: 'fk', source: 'ikpu_codes', readOnly: true },
            { key: 'nnm_id',           label: 'Product NNM (каталог)', type: 'fk', source: 'product_nnm', readOnly: true },
            { key: 'active',           label: 'Active', type: 'bool', default: true },
        ],
    },

    // ITEMS_SECTION_V1 — clinic products & drugs catalog. clinic_items is a
    // company-local table with no tracked RLS policy, so writes go through the
    // service-role gateway (gatewayCrud). Stock is kept in Снабжение (Receive).
    clinic_items: {
        group: 'Service settings',
        label: 'Товары и препараты',
        table: 'clinic_items',
        gatewayCrud: true,
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        importable: true,
        columns: [
            { key: 'name',     label: 'Наименование' },
            { key: 'is_drug',  label: 'Препарат', type: 'bool' },
            { key: 'unit',     label: 'Ед.' },
            { key: 'form',     label: 'Форма' },
            { key: 'strength', label: 'Дозировка' },
            { key: 'price',    label: 'Цена', type: 'money' },
            { key: 'active',   label: 'Статус', type: 'bool' },
        ],
        groups: [
            { title: 'Основное', fields: ['name', 'is_drug', 'price', 'unit'] },
            { title: 'Детали', fields: ['form', 'strength', 'tax_rate', 'code'] },
            { title: 'Статус', span: 'full', fields: ['active'] },
        ],
        fields: [
            { key: 'name',     label: 'Наименование', type: 'text', required: true },
            { key: 'is_drug',  label: 'Препарат (лекарство) — доступен для назначений и списания', type: 'bool', default: true },
            { key: 'price',    label: 'Цена (сум)', type: 'number', step: '0.01', default: 0 },
            { key: 'unit',     label: 'Единица (amp, tab, ml, fl…)', type: 'text' },
            { key: 'form',     label: 'Форма (таблетка, ампула, раствор…)', type: 'text' },
            { key: 'strength', label: 'Дозировка (напр. 500 мг)', type: 'text' },
            { key: 'tax_rate', label: 'НДС (%)', type: 'number', step: '0.01', default: 12 },
            { key: 'code',     label: 'Внутренний код (необязательно)', type: 'text' },
            { key: 'active',   label: 'Активен', type: 'bool', default: true },
        ],
    },

    service_categories: {
        comingSoon: true,   // ROLE_EDITOR_AVAIL_V1 — parked / medcore-managed catalog
        group: 'Service settings',
        label: 'Product categories',
        table: 'service_categories',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        fkLookups: ['service_categories'],
        columns: [
            { key: 'code',        label: 'Code' },
            { key: 'name',        label: 'Name' },
            { key: 'parent_id',   label: 'Parent', lookup: 'service_categories' },
            { key: 'description', label: 'Description' },
            { key: 'active',      label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',        label: 'Category name', type: 'text', required: true },
            { key: 'code',        label: 'Code (leave blank — auto: <name-letter><seq>)', type: 'text' },
            { key: 'parent_id',   label: 'Parent category (optional)', type: 'fk', source: 'service_categories' },
            { key: 'description', label: 'Description', type: 'textarea' },
            { key: 'active',      label: 'Active', type: 'bool', default: true },
        ],
    },

    service_types: {
        comingSoon: true,   // ROLE_EDITOR_AVAIL_V1 — parked / medcore-managed catalog
        group: 'Service settings',
        label: 'Service types',
        table: 'service_types',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        columns: [
            { key: 'name',          label: 'Name' },
            { key: 'code',          label: 'Code' },
            { key: 'requires_tube', label: 'Lab tube', type: 'enum_label',
              options: [[true, 'Yes'], [false, 'No']] },
            { key: 'billing_mode',  label: 'Billing', type: 'enum_label',
              options: [['one_time', 'One-time'], ['continuable', 'Continuable']] },
            { key: 'active',        label: 'Status', type: 'bool' },
        ],
        // What a service of this type needs is declared here, so the "new
        // service" form (under Service list) only shows the relevant inputs.
        fields: [
            { key: 'name',          label: 'Type name (e.g. Consultation, Lab test)', type: 'text', required: true },
            { key: 'code',          label: 'Code (unique, optional — e.g. CONS, LAB)', type: 'text' },
            { key: 'description',   label: 'Description', type: 'textarea' },
            // Drives the tube-colour picker on services of this type.
            { key: 'requires_tube', label: 'Lab test — its services need a phlebotomy tube colour', type: 'bool', default: false },
            // one_time = charged once · continuable = ongoing stay billed
            // monthly (ward & beds), auto-closed on the last day of the month
            // and reopened for the next month by the billing job.
            { key: 'billing_mode',  label: 'Billing type', type: 'select', default: 'one_time',
              options: [
                ['one_time',    'One-time — charged once (consultations, procedures, lab tests)'],
                ['continuable', 'Continuable — ongoing, billed monthly (ward & beds, day-care)'],
              ] },
            { key: 'active',        label: 'Active', type: 'bool', default: true },
        ],
    },

    ikpu_codes: {
        comingSoon: true,   // ROLE_EDITOR_AVAIL_V1 — parked / medcore-managed catalog
        group: 'Service settings',
        label: 'IKPU codes',
        table: 'ikpu_codes',
        orderBy: { column: 'code', ascending: true },
        searchColumns: ['code', 'name', 'group_code'],
        columns: [
            { key: 'code',             label: 'Code' },
            { key: 'name',             label: 'Name' },
            { key: 'group_code',       label: 'Group' },
            { key: 'unit',             label: 'Unit' },
            { key: 'default_tax_rate', label: 'VAT %' },
            { key: 'active',           label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'code',             label: 'IKPU code (17 digits)', type: 'text', required: true },
            { key: 'name',             label: 'Name', type: 'text', required: true },
            { key: 'group_code',       label: 'Group code', type: 'text' },
            { key: 'unit',             label: 'Unit (шт / услуга / kg …)', type: 'text' },
            { key: 'default_tax_rate', label: 'Default VAT rate (%)', type: 'number', step: '0.01', default: 12 },
            { key: 'active',           label: 'Active', type: 'bool', default: true },
        ],
    },

    product_nnm: {
        comingSoon: true,   // ROLE_EDITOR_AVAIL_V1 — parked / medcore-managed catalog
        group: 'Service settings',
        label: 'Product NNM',
        table: 'product_nnm',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['nnm_code', 'name', 'manufacturer'],
        fkLookups: ['ikpu_codes'],
        columns: [
            { key: 'nnm_code',     label: 'NNM code' },
            { key: 'name',         label: 'Name' },
            { key: 'ikpu_code_id', label: 'IKPU', lookup: 'ikpu_codes' },
            { key: 'manufacturer', label: 'Manufacturer' },
            { key: 'packaging',    label: 'Packaging' },
            { key: 'active',       label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'nnm_code',     label: 'NNM code', type: 'text', required: true },
            { key: 'name',         label: 'Product name', type: 'text', required: true },
            { key: 'ikpu_code_id', label: 'Linked IKPU code', type: 'fk', source: 'ikpu_codes' },
            { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
            { key: 'packaging',    label: 'Packaging', type: 'text' },
            { key: 'active',       label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== USER & STAFF MANAGEMENT GROUP ==============
    users: {
        group: 'User & staff management',
        label: 'Employees',
        table: 'users',
        branchScoped: true,   // BRANCH_ISOLATION_V2 — users.branch_id (primary branch)
        orderBy: { column: 'full_name', ascending: true },
        searchColumns: ['full_name', 'email', 'phone', 'license_number'],
        fkLookups: ['branches', 'departments', 'positions', 'roles', 'rooms'],
        // KPI strip rendered above the list (added in migration 018 + crud).
        headerStats: [
            { label: 'Total employees',   icon: 'Patients', color: 'var(--primary-700)',
              compute: (rows) => rows.length },
            { label: 'License expired',   icon: 'Warning',  color: 'var(--crit-700)',
              compute: (rows) => rows.filter(r => {
                  if (!r.license_expiry_date) return false;
                  return new Date(r.license_expiry_date) < new Date(new Date().toDateString());
              }).length },
            { label: 'Fixed salary',      icon: 'Wallet',   color: 'var(--ok-700)',
              compute: (rows) => rows.filter(r => r.salary_type === 'fixed').length },
            { label: 'Variable salary',   icon: 'Activity', color: 'var(--warn-700)',
              compute: (rows) => rows.filter(r => r.salary_type === 'percentage' || r.salary_type === 'fix_plus_kpi').length },
        ],
        columns: [
            { key: 'full_name',           label: 'Name' },
            { key: 'role_id',             label: 'Role', lookup: 'roles' },
            // EMP_LIST_V2 — dropped salary / employment / license# / license-expires / category;
            // added Speciality + Appointment (schedulable vs live queue). Editor fields unchanged.
            { key: 'specialty',           label: 'Speciality' },
            { key: 'scheduling_mode',     label: 'Appointment', type: 'enum_label',
              options: [['schedulable','По записи','info'],['live_queue','Живая очередь','warn']],
              showIf: (r) => !!(r.is_doctor === true || String(r.role || '').toLowerCase() === 'doctor' || String(r.staff_type || '') === 'doctor') },   // EMP_APPT_DOCTOR_ONLY_V1 — only doctors have an appointment mode
            // Shows the primary branch (mirrored from the multi-select on save).
            { key: 'branch_id',           label: 'Primary branch', lookup: 'branches' },
            { key: 'active',              label: 'Status', type: 'bool' },
        ],
        // Grouped 2-column modal layout. `span:'full'` makes a section stretch
        // across both columns; sections without it sit side-by-side in the
        // order declared.
        groups: [
            { title: 'Identity',  fields: ['full_name', 'phone', 'email'] },
            { title: 'Job',       fields: ['position_id', 'department_id', 'room_id', 'doctor_category', 'hire_date'] },
            { title: 'License',   span: 'full', fields: ['license_number', 'license_expiry_date'] },
            { title: 'Branches (a doctor can work at several at once)', span: 'full', fields: ['branches'] },
            { title: 'Employment & salary', span: 'full', fields: ['employment_type', 'salary_type', 'salary_fixed', 'salary_percent', 'kpi_links'] },
            { title: 'Status',    span: 'full', fields: ['active'] },
            { title: 'Working days & hours', span: 'full', fields: ['working_hours'] },
            { title: 'Services performed (% of price or fixed amount per service)', span: 'full', fields: ['service_rates'] },
            { title: 'Login (used at sign-in)', span: 'full', fields: ['username', 'password', 'role_id'] },
        ],
        fields: [
            { key: 'full_name',     label: 'Full name', type: 'text', required: true },
            { key: 'position_id',   label: 'Position', type: 'fk', source: 'positions' },
            { key: 'department_id', label: 'Department', type: 'fk', source: 'departments' },
            { key: 'doctor_category', label: 'Doctor category', type: 'select',
              options: [
                ['', '—'],
                ['highest', 'Highest category'],
                ['first',   'First category'],
                ['second',  'Second category'],
                ['none',    'No category'],
              ] },
            { key: 'phone',         label: 'Phone', type: 'phone' },
            { key: 'email',         label: 'Email', type: 'email' },
            { key: 'license_number',label: 'License number', type: 'text' },
            { key: 'license_expiry_date', label: 'License expires on', type: 'date' },
            { key: 'hire_date',     label: 'Hire date', type: 'date' },
            // Multi-branch: writes to user_branches junction. `mirrorTo` keeps
            // users.branch_id in sync with the first selected branch so legacy
            // code that joins through that single FK still works.
            { key: 'branches',      label: 'Tick every branch this person works at',
                                    type: 'multi_fk', source: 'branches',
                                    junction: { table: 'user_branches', leftCol: 'user_id', rightCol: 'branch_id' },
                                    mirrorTo: 'branch_id' },
            // Employment contract type.
            { key: 'employment_type', label: 'Employment contract', type: 'select',
              options: [
                ['', '—'],
                ['official',   'Official (labour contract)'],
                ['civil_law',  'Civil-law contract (ГПХ / contractor)'],
                ['unofficial', 'Unofficial (no formal contract)'],
              ] },
            // Salary model.
            { key: 'salary_type',   label: 'Salary type', type: 'select',
              options: [
                ['', '—'],
                ['fixed',         'Fixed (monthly)'],
                ['percentage',    'Variable (% of revenue)'],
                ['fix_plus_kpi',  'Fix + KPI bonus'],
              ] },
            { key: 'salary_fixed',  label: 'Fixed amount (UZS) — for Fixed / Fix+KPI', type: 'number', step: '0.01' },
            { key: 'salary_percent',label: 'Percentage (%) — for Variable / Fix+KPI',   type: 'number', step: '0.01' },
            // KPI link — measurable activities the bonus depends on.
            { key: 'kpi_links',     label: 'KPIs tied to bonus (tick all that apply)',
              type: 'multi_select',
              options: [
                ['consultations',  'Consultations done'],
                ['services',       'Services delivered'],
                ['revenue',        'Revenue generated'],
                ['referrals',      'Patient referrals brought in'],
                ['lab_tests',      'Lab tests processed'],
                ['surgeries',      'Surgeries performed'],
              ] },
            { key: 'working_hours', label: 'Working days & hours', type: 'weekly_hours' },
            // Tick the services this doctor performs and set the doctor's % of
            // salary per service (or one % for a whole category). Stored as the
            // users.service_rates JSONB column by the save flow.
            { key: 'service_rates', label: 'Services performed', type: 'doctor_services' },
            { key: 'active',        label: 'Active', type: 'bool', default: true },
            { key: 'username',      label: 'Login (username, unique)',  type: 'text' },
            // Synthetic field: not a column on `users`. The save flow hashes
            // the value and stores it in users.password_hash.
            { key: 'password',      label: 'Password (leave blank to keep existing)', type: 'password' },
            { key: 'role_id',       label: 'Role', type: 'fk', source: 'roles' },
        ],
    },

    positions: {
        hidden: true,   // POSITIONS_DROP_V1 — consolidated into Roles; table kept but unmanaged.
        group: 'User & staff management',
        label: 'Positions',
        table: 'positions',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        fkLookups: ['departments'],
        columns: [
            { key: 'name',          label: 'Position name' },
            { key: 'department_id', label: 'Department', lookup: 'departments' },
            { key: 'active',        label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',          label: 'Position name (e.g. Senior Cardiologist)', type: 'text', required: true },
            { key: 'department_id', label: 'Department this position belongs to', type: 'fk', source: 'departments' },
            { key: 'active',        label: 'Active', type: 'bool', default: true },
        ],
    },

    roles: {
        group: 'User & staff management',
        label: 'Roles',
        table: 'roles',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        columns: [
            { key: 'name',        label: 'Role name' },
            { key: 'description', label: 'Description' },
            { key: 'active',      label: 'Status', type: 'bool' },
        ],
        groups: [
            // ROLE_EDITOR_COMPACT_V1 — Identity spans full width as one tight row
            // (Role name + Active only; description dropped) so the access matrix
            // below takes the whole modal instead of leaving an empty right column.
            { title: 'Identity', span: 'full', fields: ['name', 'active'] },
            { title: 'Function access — set a level per module (Viewer / Editor / Admin)', span: 'full', fields: ['permissions'] },
        ],
        fields: [
            { key: 'name',        label: 'Role name (e.g. Receptionist)', type: 'text', required: true },
            { key: 'active',      label: 'Active', type: 'bool', default: true },
            // Maps users.role_id → roles. The `permissions` JSONB is filled by
            // the section_picker field below:
            //   { sections: ['registration', …], levels: { registration: 'editor', … } }
            { key: 'permissions', label: 'Function access', type: 'section_picker' },
        ],
    },

    cashiers: {
        hidden: true,   // CASHIER_SECTION_HIDE_V1 — empty desk-assignment list; cashier hierarchy is role-based (Cashier / Head cashier)
        group: 'User & staff management',
        label: 'Cashiers',
        table: 'cashiers',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: ['cash_desk_id'],
        fkLookups: ['users', 'branches'],
        columns: [
            { key: 'user_id',      label: 'User', lookup: 'users' },
            { key: 'branch_id',    label: 'Branch', lookup: 'branches' },
            { key: 'cash_desk_id', label: 'Cash desk #' },
            { key: 'active',       label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'user_id',      label: 'User', type: 'fk', source: 'users', required: true },
            { key: 'branch_id',    label: 'Branch', type: 'fk', source: 'branches' },
            { key: 'cash_desk_id', label: 'Cash desk identifier', type: 'text' },
            { key: 'notes',        label: 'Notes', type: 'textarea' },
            { key: 'active',       label: 'Active', type: 'bool', default: true },
        ],
    },

    virtual_doctors: {
        comingSoon: true,   // ROLE_EDITOR_AVAIL_V1 — parked / medcore-managed catalog
        group: 'User & staff management',
        label: 'Virtual doctors',
        table: 'virtual_doctors',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: ['specialty', 'platforms'],
        fkLookups: ['users'],
        columns: [
            { key: 'user_id',          label: 'User', lookup: 'users' },
            { key: 'specialty',        label: 'Specialty' },
            { key: 'consultation_fee', label: 'Fee', type: 'money' },
            { key: 'platforms',        label: 'Platforms' },
            { key: 'active',           label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'user_id',           label: 'User', type: 'fk', source: 'users', required: true },
            { key: 'specialty',         label: 'Specialty', type: 'text' },
            { key: 'consultation_fee',  label: 'Consultation fee', type: 'number', step: '0.01', default: 0 },
            { key: 'platforms',         label: 'Platforms (e.g. Telegram, Zoom)', type: 'text' },
            { key: 'availability_note', label: 'Availability / hours', type: 'textarea' },
            { key: 'active',            label: 'Active', type: 'bool', default: true },
        ],
    },

    departments: {
        group: 'User & staff management',
        label: 'Departments',
        table: 'departments',
        branchScoped: true,   // BRANCH_ISOLATION_V2 — departments.branch_id
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        // Branch is intentionally NOT shown here — departments are org-wide.
        // A staff member's branches are assigned on the Employees form.
        fkLookups: ['users', 'floors'],
        columns: [
            { key: 'name',         label: 'Name' },
            { key: 'code',         label: 'Code' },
            { key: 'floor_id',     label: 'Этаж', lookup: 'floors' },
            { key: 'head_user_id', label: 'Department head', lookup: 'users' },
            { key: 'active',       label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',         label: 'Название отдела (RU)', type: 'text', required: true, mirrorTo: 'name_ru' },
            { key: 'name_uz',      label: 'Название отдела (UZ)', type: 'text' },
            { key: 'name_en',      label: 'Название отдела (EN)', type: 'text' },
            { key: 'code',         label: 'Code (optional, unique — e.g. CARD)', type: 'text' },
            { key: 'floor_id',     label: 'Этаж (на каком этаже находится отдел)', type: 'fk', source: 'floors' },   // ROOMS_DEPT_FLOOR_V1
            { key: 'kind', label: 'Тип отдела (на Symptex публикуются все, кроме «Административный»)', type: 'select', default: 'clinical', options: [
                ['clinical',      'Клинический — приём врачей'],
                ['laboratory',    'Лаборатория'],
                ['diagnostics',   'Диагностика'],
                ['procedure',     'Процедурный'],
                ['inpatient',     'Стационар — НЕ публикуется'],
                ['administrative','Административный — НЕ публикуется'],
            ] },
            { key: 'description_ru', label: 'Описание (RU)', type: 'textarea' },
            { key: 'description_uz', label: 'Описание (UZ)', type: 'textarea' },
            { key: 'description_en', label: 'Описание (EN)', type: 'textarea' },
            { key: 'head_user_id', label: 'Department head', type: 'fk', source: 'users' },
            // DEPT_MEMBERS_V1 — assign employees to this department here (writes users.department_id); the editor's Department field was removed.
            { key: 'members', label: 'Сотрудники в этом отделе', type: 'multi_fk', source: 'users', reverseFk: { table: 'users', fkCol: 'department_id' }, hint: 'Отметьте сотрудников этого отдела (можно несколько). Сотрудник может состоять только в одном отделе.' },
            { key: 'active',       label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== TOP-LEVEL SECTIONS ==============
    patients: {
        label: 'Patients',
        table: 'patients',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: ['full_name', 'phone', 'email', 'mrn', 'national_id'],
        fkLookups: ['payers', 'payer_policies', 'branches', 'referral_sources', 'users'],
        columns: [
            { key: 'mrn',         label: 'MRN' },
            { key: 'full_name',   label: 'Name' },
            { key: 'phone',       label: 'Phone' },
            { key: 'date_of_birth', label: 'DOB', type: 'date' },
            { key: 'gender',      label: 'Gender' },
            { key: 'branch_id',   label: 'Branch', lookup: 'branches' },
            { key: 'primary_doctor_id', label: 'Primary doctor', lookup: 'users' },
            { key: 'payer_id',    label: 'Payer', lookup: 'payers' },
            { key: 'payer_policy_id', label: 'Policy', lookup: 'payer_policies' },
            { key: 'active',      label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'mrn',                label: 'Medical record # (MRN)', type: 'text' },
            { key: 'full_name',          label: 'Full name', type: 'text', required: true },
            { key: 'date_of_birth',      label: 'Date of birth', type: 'date' },
            { key: 'gender',             label: 'Gender', type: 'select',
              options: [['', '—'], ['male','Male'], ['female','Female'], ['other','Other']] },
            { key: 'blood_type',         label: 'Blood type', type: 'select',
              options: [['','—'],['A+','A+'],['A-','A-'],['B+','B+'],['B-','B-'],
                        ['AB+','AB+'],['AB-','AB-'],['O+','O+'],['O-','O-'],['unknown','Unknown']] },
            { key: 'marital_status',     label: 'Marital status', type: 'select',
              options: [['','—'],['single','Single'],['married','Married'],
                        ['divorced','Divorced'],['widowed','Widowed'],['other','Other']] },
            { key: 'nationality',        label: 'Nationality', type: 'text' },
            { key: 'national_id',        label: 'National ID / passport #', type: 'text' },
            { key: 'occupation',         label: 'Occupation', type: 'text' },
            { key: 'phone',              label: 'Phone', type: 'phone' },
            { key: 'email',              label: 'Email', type: 'email' },
            { key: 'address',            label: 'Address', type: 'textarea' },
            { key: 'emergency_contact_name',     label: 'Emergency contact — name', type: 'text' },
            { key: 'emergency_contact_phone',    label: 'Emergency contact — phone', type: 'text' },
            { key: 'emergency_contact_relation', label: 'Emergency contact — relationship', type: 'text' },
            { key: 'allergies',           label: 'Known allergies', type: 'textarea' },
            { key: 'chronic_conditions',  label: 'Chronic conditions', type: 'textarea' },
            { key: 'branch_id',           label: 'Branch', type: 'fk', source: 'branches' },
            { key: 'primary_doctor_id',   label: 'Primary doctor', type: 'fk', source: 'users' },
            { key: 'payer_id',            label: 'Payer company', type: 'fk', source: 'payers' },
            { key: 'payer_policy_id',     label: 'Payer policy', type: 'fk', source: 'payer_policies' },
            { key: 'insurance_policy_number', label: 'Patient policy # (on card)', type: 'text' },
            { key: 'insurance_expiry_date',   label: 'Patient policy expiry', type: 'date' },
            { key: 'referral_source_id',  label: 'Referral source', type: 'fk', source: 'referral_sources' },
            { key: 'registration_date',   label: 'Registration date', type: 'date' },
            { key: 'notes',               label: 'Notes', type: 'textarea' },
            { key: 'active',              label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== PAYER MANAGEMENT GROUP ==============
    payer_policies: {
        group: 'Payer management',
        label: 'Payer policies',
        table: 'payer_policies',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'policy_code'],
        fkLookups: ['payers'],
        columns: [
            { key: 'name',                label: 'Policy name' },
            { key: 'policy_code',         label: 'Code' },
            { key: 'payer_id',            label: 'Company', lookup: 'payers' },
            { key: 'coverage_percentage', label: 'Coverage %' },
            { key: 'copay_percentage',    label: 'Copay %' },
            { key: 'max_limit',           label: 'Limit', type: 'money' },
            { key: 'valid_to',            label: 'Valid until', type: 'date' },
            { key: 'active',              label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',                label: 'Policy name (e.g. Gold Plan 2024)', type: 'text', required: true },
            { key: 'payer_id',            label: 'Payer company', type: 'fk', source: 'payers', required: true },
            { key: 'policy_code',         label: 'Policy code', type: 'text' },
            { key: 'coverage_percentage', label: 'Coverage % (insurer pays)', type: 'number', step: '0.01' },
            { key: 'copay_percentage',    label: 'Copay % (patient pays)', type: 'number', step: '0.01' },
            { key: 'copay_amount',        label: 'Fixed copay amount per visit', type: 'number', step: '0.01' },
            { key: 'max_limit',           label: 'Max limit (per claim / period)', type: 'number', step: '0.01' },
            { key: 'valid_from',          label: 'Valid from', type: 'date' },
            { key: 'valid_to',            label: 'Valid until', type: 'date' },
            { key: 'description',         label: 'Description', type: 'textarea' },
            { key: 'active',              label: 'Active', type: 'bool', default: true },
        ],
    },

    payers: {
        group: 'Payer management',
        label: 'Payer companies',
        table: 'payers',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'contact_person', 'phone', 'tax_id'],
        columns: [
            { key: 'name',                label: 'Name' },
            { key: 'type',                label: 'Type' },
            { key: 'coverage_percentage', label: 'Default %' },
            { key: 'contact_person',      label: 'Contact' },
            { key: 'phone',               label: 'Phone' },
            { key: 'active',              label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',           label: 'Payer name', type: 'text', required: true },
            { key: 'type',           label: 'Type', type: 'select', required: true,
              options: [['cash','Cash / Self-pay'], ['insurance','Insurance'],
                        ['corporate','Corporate'], ['government','Government'], ['other','Other']] },
            { key: 'coverage_percentage', label: 'Default coverage %', type: 'number', step: '0.01', default: 0 },
            { key: 'contact_person', label: 'Contact person', type: 'text' },
            { key: 'phone',          label: 'Phone', type: 'phone' },
            { key: 'email',          label: 'Email', type: 'email' },
            { key: 'tax_id',         label: 'Tax ID', type: 'text' },
            { key: 'address',        label: 'Address', type: 'textarea' },
            { key: 'payment_terms',  label: 'Payment terms', type: 'textarea' },
            { key: 'active',         label: 'Active', type: 'bool', default: true },
        ],
    },

    payment_providers: {
        group: 'Payer management',
        label: 'Online payment providers',
        table: 'payment_providers',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        columns: [
            { key: 'name',        label: 'Provider' },
            { key: 'code',        label: 'Code' },
            { key: 'fee_percent', label: 'Fee %', suffix: ' %' },
            { key: 'active',      label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',        label: 'Provider name (e.g. Payme, Click, Uzum)', type: 'text', required: true },
            { key: 'code',        label: 'Short code (optional)', type: 'text' },
            { key: 'fee_percent', label: 'Processing fee charged to the clinic (%)', type: 'number', step: '0.01', default: 0 },
            { key: 'notes',       label: 'Notes', type: 'textarea' },
            { key: 'active',      label: 'Active', type: 'bool', default: true },
        ],
    },

    cashback: {
        group: 'Payer management',
        label: 'Cashback',
        table: 'cashback_rules',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        fkLookups: ['payers'],
        columns: [
            { key: 'name',             label: 'Rule' },
            { key: 'payer_id',         label: 'Payer', lookup: 'payers' },
            { key: 'cashback_percent', label: 'Cashback %', suffix: ' %' },
            { key: 'min_purchase',     label: 'Min spend', type: 'money' },
            { key: 'max_cashback',     label: 'Cap', type: 'money' },
            { key: 'valid_to',         label: 'Valid until', type: 'date' },
            { key: 'active',           label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',             label: 'Rule name (e.g. Self-pay 3% promo)', type: 'text', required: true },
            { key: 'payer_id',         label: 'Payer (leave blank — applies to all / self-pay)', type: 'fk', source: 'payers' },
            { key: 'cashback_percent', label: 'Cashback % (returned to patient)', type: 'number', step: '0.01', default: 0 },
            { key: 'min_purchase',     label: 'Minimum invoice amount to qualify', type: 'number', step: '0.01', default: 0 },
            { key: 'max_cashback',     label: 'Max cashback per transaction (blank = no cap)', type: 'number', step: '0.01' },
            { key: 'valid_from',       label: 'Valid from', type: 'date' },
            { key: 'valid_to',         label: 'Valid until', type: 'date' },
            { key: 'notes',            label: 'Notes', type: 'textarea' },
            { key: 'active',           label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== BRANCH MANAGEMENT GROUP ==============
    companies: {
        group: 'Branch management',
        label: 'Companies',
        table: 'companies',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'legal_name', 'tax_id', 'license_number'],
        columns: [
            { key: 'name',           label: 'Name' },
            { key: 'legal_name',     label: 'Legal name' },
            { key: 'tax_id',         label: 'Tax ID' },
            { key: 'director',       label: 'Director' },
            { key: 'phone',          label: 'Phone' },
            { key: 'active',         label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',           label: 'Display name (e.g. Easy-Med Clinic Group)', type: 'text', required: true },
            { key: 'legal_name',     label: 'Legal name (full registered name)', type: 'text' },
            { key: 'tax_id',         label: 'Tax ID (ИНН)', type: 'text' },
            { key: 'license_number', label: 'Medical license #', type: 'text' },
            { key: 'director',       label: 'Director', type: 'text' },
            { key: 'phone',          label: 'Phone', type: 'phone' },
            { key: 'email',          label: 'Email', type: 'email' },
            { key: 'website',        label: 'Website', type: 'text' },
            { key: 'logo_url',       label: 'Logo', type: 'image', bucket: 'company-logos', public: true, prefix: 'logos/' },
            { key: 'address',        label: 'Address', type: 'textarea' },
            { key: 'active',         label: 'Active', type: 'bool', default: true },
        ],
    },

    branches: {
        group: 'Branch management',
        label: 'Branch list',
        table: 'branches',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'address', 'phone', 'license_number'],
        fkLookups: ['companies'],
        columns: [
            { key: 'name',           label: 'Name' },
            { key: 'company_id',     label: 'Company', lookup: 'companies' },
            { key: 'address',        label: 'Address' },
            { key: 'phone',          label: 'Phone' },
            { key: 'license_number', label: 'License #' },
            { key: 'active',         label: 'Status', type: 'bool' },
        ],
        fields: [
            // BRANCH_FIELDS_V1 — trilingual identity + brand + social/map, all published to medcore -> Symptex.
            { key: 'name_ru',            label: 'Название филиала (RU)', type: 'text', required: true, mirrorTo: 'name' },
            { key: 'name_uz',            label: 'Filial nomi (UZ)', type: 'text' },
            { key: 'name_en',            label: 'Branch name (EN)', type: 'text' },
            { key: 'company_id',         label: 'Company', type: 'fk', source: 'companies' },
            { key: 'phone',              label: 'Phone', type: 'phone' },
            { key: 'license_number',     label: 'License / registration #', type: 'text' },
            { key: 'address_ru',         label: 'Адрес (RU)', type: 'textarea', mirrorTo: 'address' },
            { key: 'address_uz',         label: 'Manzil (UZ)', type: 'textarea' },
            { key: 'address_en',         label: 'Address (EN)', type: 'textarea' },
            { key: 'description_ru',     label: 'Описание клиники (RU)', type: 'textarea' },
            { key: 'description_uz',     label: 'Klinika tavsifi (UZ)', type: 'textarea' },
            { key: 'description_en',     label: 'Clinic description (EN)', type: 'textarea' },
            { key: 'is_24_7',            label: 'Круглосуточно (24/7)', type: 'bool' },
            { key: 'website',            label: 'Веб-сайт (URL)', type: 'text' },
            { key: 'instagram_url',      label: 'Instagram (URL)', type: 'text' },
            { key: 'telegram_url',       label: 'Telegram-канал (URL)', type: 'text' },
            { key: 'yandex_map_url',     label: 'Yandex Maps (ссылка)', type: 'text' },
            { key: 'logo_url',           label: 'Logo', type: 'image', bucket: 'company-logos', public: true, prefix: 'branch-logos/' },
            { key: 'cover_url',          label: 'Cover image (optional)', type: 'image', bucket: 'company-logos', public: true, prefix: 'branch-covers/' },
            { key: 'working_hours',      label: 'Working hours (per weekday)', type: 'weekly_hours' },
            { key: 'district', label: 'District (район — каталог Symptex)', type: 'select', options: [
                ['', '—'],
                ['Olmazor', 'Olmazor · Алмазарский'],
                ['Bektemir', 'Bektemir · Бектемирский'],
                ['Mirobod', 'Mirobod · Мирабадский'],
                ['Mirzo-Ulugbek', 'Mirzo-Ulugbek · Мирзо-Улугбекский'],
                ['Sergeli', 'Sergeli · Сергелийский'],
                ['Uchtepa', 'Uchtepa · Учтепинский'],
                ['Chilonzor', 'Chilonzor · Чиланзарский'],
                ['Shayxontoxur', 'Shayxontoxur · Шайхантахурский'],
                ['Yunusobod', 'Yunusobod · Юнусабадский'],
                ['Yakkasaroy', 'Yakkasaroy · Яккасарайский'],
                ['Yangi-hayot', 'Yangi-hayot · Янгихаётский'],
                ['Yashnobod', 'Yashnobod · Яшнабадский'],
            ] },
            { key: 'active',             label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== ROOMS & FLOORS GROUP ==============
    floors: {
        group: 'Rooms & floors',
        label: 'Floors',
        table: 'floors',
        branchScoped: true,   // BRANCH_ISOLATION_V2 — floors.branch_id
        orderBy: { column: 'sort_order', ascending: true },
        searchColumns: ['name'],
        fkLookups: ['branches'],
        columns: [
            { key: 'name',      label: 'Name' },
            { key: 'branch_id', label: 'Branch', lookup: 'branches' },
            { key: 'level',     label: 'Level' },
            { key: 'active',    label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',       label: 'Floor name (e.g. Ground floor, 2nd floor)', type: 'text', required: true },
            { key: 'branch_id',  label: 'Branch', type: 'fk', source: 'branches' },
            { key: 'level',      label: 'Level number (for ordering, e.g. 0, 1, 2)', type: 'number' },
            { key: 'sort_order', label: 'Sort order', type: 'number', default: 0 },
            { key: 'notes',      label: 'Notes', type: 'textarea' },
            { key: 'active',     label: 'Active', type: 'bool', default: true },
        ],
    },

    rooms: {
        group: 'Rooms & floors',
        label: 'Rooms',
        table: 'rooms',
        branchScoped: true,   // BRANCH_ISOLATION_V2 — rooms.floor_id -> floors.branch_id (embed)
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        fkLookups: ['floors', 'departments'],
        columns: [
            { key: 'name',     label: 'Name' },
            { key: 'code',     label: 'Door #' },
            { key: 'department_id', label: 'Department', lookup: 'departments' },
            { key: 'floor_id', label: 'Floor (от отдела)', lookup: 'floors' },
            { key: 'room_type',label: 'Type' },
            { key: 'active',   label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',      label: 'Room name (e.g. Room 201, Cardiology cabinet)', type: 'text', required: true },
            { key: 'code',      label: 'Door number / short code', type: 'text' },
            { key: 'department_id', label: 'Отдел (этаж определяется отделом)', type: 'fk', source: 'departments' },   // ROOMS_DEPT_FLOOR_V1 — room.floor_id derived from the department via trigger
            { key: 'room_type', label: 'Type', type: 'select',
              options: [['consultation','Consultation'], ['procedure','Procedure'],
                        ['diagnostics','Diagnostics'], ['lab','Laboratory'],
                        ['surgery','Surgery'], ['office','Office'], ['other','Other']] },
            { key: 'capacity',  label: 'Capacity (people)', type: 'number' },
            { key: 'notes',     label: 'Notes', type: 'textarea' },
            { key: 'active',    label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== INPATIENT GROUP ==============
    wards: {
        group: 'Inpatient',
        label: 'Wards',
        table: 'wards',
        branchScoped: true,   // BRANCH_ISOLATION_V2 — wards.branch_id
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code', 'floor'],
        fkLookups: ['branches', 'floors'],
        columns: [
            { key: 'name',      label: 'Name' },
            { key: 'code',      label: 'Code' },
            { key: 'type',      label: 'Type' },
            { key: 'branch_id', label: 'Branch', lookup: 'branches' },
            { key: 'floor_id',  label: 'Этаж', lookup: 'floors' },
            { key: 'active',    label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',           label: 'Ward name', type: 'text', required: true },
            { key: 'code',           label: 'Code (unique, e.g. CARD, ICU)', type: 'text' },
            { key: 'type',           label: 'Type', type: 'select', required: true,
              options: [['general','General'], ['icu','ICU'], ['maternity','Maternity'],
                        ['pediatrics','Pediatrics'], ['surgery','Surgery'],
                        ['oncology','Oncology'], ['isolation','Isolation'], ['other','Other']] },
            { key: 'branch_id',      label: 'Branch', type: 'fk', source: 'branches' },
            { key: 'floor_id',       label: 'Этаж (выберите этаж клиники)', type: 'fk', source: 'floors' },
            { key: 'price_per_hour', label: 'Price per hour (UZS)', type: 'number', default: 0,
              hint: 'Default accommodation rate for beds in this ward. Beds with their own rate override this. Leave 0 to disable accommodation billing.' },
            // DAILY_BILLING_V1 — per-24h stationary billing (calendar days)
            { key: 'billing_mode',  label: 'Billing mode', type: 'select', default: 'hourly',
              options: [['hourly', 'Hourly (per hour)'], ['daily', 'Daily (per 24h / calendar day)']],
              hint: 'Daily: the admission day always counts; the discharge day is free by default. Price per hour is ignored in daily mode.' },
            { key: 'price_per_day', label: 'Price per day (UZS, daily mode)', type: 'number', default: 0,
              hint: 'Used when billing mode is Daily. Beds with their own per-day rate override this.' },
            { key: 'color',          label: 'Color tint (hex, e.g. #4eb0aa)', type: 'text' },
            { key: 'notes',          label: 'Notes', type: 'textarea' },
            { key: 'active',         label: 'Active', type: 'bool', default: true },
        ],
    },

    beds_settings: {
        group: 'Inpatient',
        label: 'Beds',
        table: 'beds',
        branchScoped: true,   // BRANCH_ISOLATION_V2 — beds.ward_id -> wards.branch_id (embed)
        orderBy: { column: 'code', ascending: true },
        searchColumns: ['code'],
        fkLookups: ['wards'],
        columns: [
            { key: 'code',    label: 'Bed #' },
            { key: 'ward_id', label: 'Ward', lookup: 'wards' },
            { key: 'type',    label: 'Type' },
            { key: 'status',  label: 'Status' },
            { key: 'active',  label: 'Active', type: 'bool' },
        ],
        fields: [
            { key: 'code',           label: 'Bed number / label', type: 'text', required: true },
            { key: 'ward_id',        label: 'Ward', type: 'fk', source: 'wards', required: true },
            { key: 'type',           label: 'Type', type: 'select',
              options: [['standard','Standard'], ['icu','ICU'], ['isolation','Isolation'],
                        ['vip','VIP'], ['recovery','Recovery'], ['observation','Observation']] },
            { key: 'status',         label: 'Status', type: 'select',
              options: [['free','Free'], ['occupied','Occupied'], ['cleaning','Cleaning'],
                        ['maintenance','Maintenance'], ['reserved','Reserved']] },
            { key: 'price_per_hour', label: 'Price per hour (UZS) — override', type: 'number',
              hint: 'Leave 0 to inherit the ward’s default rate. Use only when this bed is priced differently (e.g. a single VIP room inside a general ward).' },
            { key: 'price_per_day', label: 'Price per day (UZS, daily mode)', type: 'number', default: 0,
              hint: 'DAILY_BILLING_V1 — overrides the ward day rate for this bed. Leave 0 to use the ward rate.' },
            { key: 'notes',          label: 'Notes', type: 'textarea' },
            { key: 'active',         label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== REFERRALS GROUP ==============
    referral_sources: {
        group: 'Referrals',
        label: 'Source list',
        table: 'referral_sources',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'contact_person', 'phone'],
        fkLookups: ['referral_source_categories'],
        columns: [
            { key: 'name',                  label: 'Name' },
            { key: 'category_id',           label: 'Category', lookup: 'referral_source_categories' },
            { key: 'type',                  label: 'Type' },
            { key: 'contact_person',        label: 'Contact' },
            { key: 'phone',                 label: 'Phone' },
            { key: 'commission_mode',       label: 'Reward' },   // REFERRAL_REWARDS_V1
            { key: 'active',                label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',                  label: 'Name', type: 'text', required: true },
            { key: 'category_id',           label: 'Category', type: 'fk', source: 'referral_source_categories' },
            { key: 'type',                  label: 'Type', type: 'select',
              options: [['doctor','Doctor'], ['clinic','Clinic'], ['online','Online'],
                        ['walk_in','Walk-in'], ['advertisement','Advertisement'], ['other','Other']] },
            { key: 'contact_person',        label: 'Contact person', type: 'text' },
            { key: 'phone',                 label: 'Phone', type: 'phone' },
            // REFERRAL_REWARDS_V1 — reward is per product group: «Общий» uses the
            // clinic-wide table (Settings → Реферальное вознаграждение), «Вручную»
            // carries its own per-group map (commission_rates jsonb). The legacy
            // flat commission_percentage column stays in the DB, unused.
            { key: 'commission_mode',       label: 'Вознаграждение', type: 'select', default: 'general',
              options: [['general', 'Общий (ставки из настроек)'], ['manual', 'Вручную (свои ставки)']] },
            { key: 'commission_rates',      label: 'Ставки по группам, %', type: 'referral_rates',
              visibleWhen: (v) => v.commission_mode === 'manual' },
            { key: 'notes',                 label: 'Notes', type: 'textarea' },
            { key: 'active',                label: 'Active', type: 'bool', default: true },
        ],
    },

    referral_source_categories: {
        group: 'Referrals',
        label: 'Source categories',
        table: 'referral_source_categories',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        columns: [
            { key: 'name',        label: 'Name' },
            { key: 'description', label: 'Description' },
            { key: 'active',      label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',        label: 'Category name (e.g. Internal staff, Online channels)', type: 'text', required: true },
            { key: 'description', label: 'Description', type: 'textarea' },
            { key: 'active',      label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== DOCTOR SALARY GROUP ==============
    doctor_prices: {
        hidden: true,   // DOCTOR_PAY_CONSOLIDATE_V1 — superseded by the users.service_rates JSONB editor
        group: 'Doctor salary',
        label: 'Doctor prices',
        table: 'doctor_prices',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: [],
        fkLookups: ['users', 'services'],
        columns: [
            { key: 'doctor_id',      label: 'Doctor',  lookup: 'users' },
            { key: 'service_id',     label: 'Service', lookup: 'services' },
            { key: 'price',          label: 'Price', type: 'money' },
            { key: 'effective_date', label: 'Effective', type: 'date' },
            { key: 'active',         label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'doctor_id',      label: 'Doctor',  type: 'fk', source: 'users',    required: true },
            { key: 'service_id',     label: 'Service', type: 'fk', source: 'services', required: true },
            { key: 'price',          label: 'Doctor’s price for this service', type: 'number', step: '0.01', default: 0 },
            { key: 'effective_date', label: 'Effective from', type: 'date' },
            { key: 'notes',          label: 'Notes', type: 'textarea' },
            { key: 'active',         label: 'Active', type: 'bool', default: true },
        ],
    },

    doctor_referral_bonuses: {
        hidden: true,   // DOCTOR_PAY_CONSOLIDATE_V1 — superseded by the users.referral_rates JSONB editor
        group: 'Doctor salary',
        label: 'Referral bonuses',
        table: 'doctor_referral_bonuses',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: [],
        fkLookups: ['users', 'services'],
        columns: [
            { key: 'doctor_id',      label: 'Doctor',          lookup: 'users' },
            { key: 'service_id',     label: 'Referred service', lookup: 'services' },
            { key: 'bonus_type',     label: 'Type' },
            { key: 'bonus_value',    label: 'Value' },
            { key: 'effective_date', label: 'Effective', type: 'date' },
            { key: 'active',         label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'doctor_id',      label: 'Doctor (who refers)', type: 'fk', source: 'users',    required: true },
            { key: 'service_id',     label: 'Referred service', type: 'fk', source: 'services', required: true },
            { key: 'bonus_type',     label: 'Bonus type', type: 'select', required: true,
              options: [['percentage','% of service price'], ['fixed','Fixed amount per referral']] },
            { key: 'bonus_value',    label: 'Bonus value (% or amount)', type: 'number', step: '0.01', default: 0 },
            { key: 'effective_date', label: 'Effective from', type: 'date' },
            { key: 'notes',          label: 'Notes', type: 'textarea' },
            { key: 'active',         label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== PATIENT SETTINGS ==============
    // No group → renders under the top-level "General" settings card.
    patient_categories: {
        label: 'Patient categories',
        table: 'patient_categories',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        columns: [
            { key: 'name',        label: 'Name' },
            { key: 'description', label: 'Description' },
            { key: 'active',      label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',        label: 'Category name (e.g. VIP, Pediatric, Regular)', type: 'text', required: true },
            { key: 'description', label: 'Description', type: 'textarea' },
            { key: 'active',      label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== GEOGRAPHY ==============
    // Reference data behind the cascading Country → Region → District dropdowns
    // on the patient registration form. Admin maintains the catalog here; the
    // patient form reads from it (see js/admin/views/registration.js).
    countries: {
        platformOnly: true,   // ROLE_EDITOR_AVAIL_V1 — super-admin console only (not grantable to clinic roles)
        group: 'Geography',
        label: 'Countries',
        table: 'countries',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name', 'code'],
        columns: [
            { key: 'name',   label: 'Country' },
            { key: 'code',   label: 'ISO code' },
            { key: 'active', label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'name',   label: 'Country name', type: 'text', required: true },
            { key: 'code',   label: 'ISO 3166-1 alpha-2 (e.g. UZ, RU, KZ)', type: 'text' },
            { key: 'active', label: 'Active', type: 'bool', default: true },
        ],
    },
    regions: {
        platformOnly: true,   // ROLE_EDITOR_AVAIL_V1 — super-admin console only (not grantable to clinic roles)
        group: 'Geography',
        label: 'Regions',
        table: 'regions',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        fkLookups: ['countries'],
        columns: [
            { key: 'country_id', label: 'Country', lookup: 'countries' },
            { key: 'name',       label: 'Region' },
            { key: 'active',     label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'country_id', label: 'Country', type: 'fk', source: 'countries', required: true },
            { key: 'name',       label: 'Region name', type: 'text', required: true },
            { key: 'active',     label: 'Active', type: 'bool', default: true },
        ],
    },
    districts: {
        platformOnly: true,   // ROLE_EDITOR_AVAIL_V1 — super-admin console only (not grantable to clinic roles)
        group: 'Geography',
        label: 'Districts',
        table: 'districts',
        orderBy: { column: 'name', ascending: true },
        searchColumns: ['name'],
        fkLookups: ['regions'],
        columns: [
            { key: 'region_id', label: 'Region', lookup: 'regions' },
            { key: 'name',      label: 'District' },
            { key: 'active',    label: 'Status', type: 'bool' },
        ],
        fields: [
            { key: 'region_id', label: 'Region', type: 'fk', source: 'regions', required: true },
            { key: 'name',      label: 'District name', type: 'text', required: true },
            { key: 'active',    label: 'Active', type: 'bool', default: true },
        ],
    },

    // ============== ACCESS REQUESTS ==============
    // Incoming "Request access" submissions from the login screen
    // (migration 046). Anyone with the anon key can INSERT a row; only
    // admins can read / update / delete (RLS enforces that). The admin
    // changes status → approved/rejected here and provisions the actual
    // account through the Employees flow.
    signup_requests: {
        platformOnly: true,   // ROLE_EDITOR_AVAIL_V1 — super-admin console only (not grantable to clinic roles)
        group: 'Access requests',
        label: 'Sign-up requests',
        table: 'signup_requests',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: ['full_name', 'phone', 'email', 'username'],
        columns: [
            { key: 'created_at', label: 'Submitted', type: 'date' },
            { key: 'full_name',  label: 'Name' },
            { key: 'phone',      label: 'Phone' },
            { key: 'email',      label: 'Email' },
            { key: 'username',   label: 'Desired username' },
            { key: 'status',     label: 'Status' },
        ],
        fields: [
            { key: 'full_name',    label: 'Full name',   type: 'text', required: true },
            { key: 'phone',        label: 'Phone',       type: 'phone', required: true },
            { key: 'email',        label: 'Email',       type: 'email' },
            { key: 'username',     label: 'Desired username', type: 'text' },
            { key: 'message',      label: 'Reason for access', type: 'textarea' },
            { key: 'status',       label: 'Status',      type: 'select',
              options: [['pending','Pending'], ['approved','Approved'], ['rejected','Rejected']] },
            { key: 'review_notes', label: 'Review notes', type: 'textarea' },
        ],
    },

    // ============== CLINIC SIGNUPS ==============
    // Public landing-page submissions from prospective clinics (migration
    // 048). Anyone can INSERT via the submit_clinic_signup_request RPC;
    // only admins can read / update / delete (RLS enforces that). Admin
    // moves status → approved/rejected here. Actual provisioning of the
    // companies row + first admin user is wired separately.
    clinic_signup_requests: {
        platformOnly: true,   // ROLE_EDITOR_AVAIL_V1 — super-admin console only (not grantable to clinic roles)
        group: 'Access requests',
        label: 'Clinic signups',
        table: 'clinic_signup_requests',
        orderBy: { column: 'created_at', ascending: false },
        searchColumns: ['clinic_name', 'desired_slug', 'admin_full_name', 'admin_email', 'admin_phone'],
        columns: [
            { key: 'created_at',      label: 'Submitted', type: 'date' },
            { key: 'clinic_name',     label: 'Clinic' },
            { key: 'desired_slug',    label: 'Subdomain' },
            { key: 'admin_full_name', label: 'Admin' },
            { key: 'admin_email',     label: 'Email' },
            { key: 'admin_phone',     label: 'Phone' },
            { key: 'status',          label: 'Status' },
        ],
        fields: [
            { key: 'clinic_name',      label: 'Clinic name',   type: 'text', required: true },
            { key: 'desired_slug',     label: 'Desired subdomain', type: 'text', required: true,
              help: 'Becomes <slug>.easymed.uz once approved.' },
            { key: 'admin_full_name',  label: 'Admin name',    type: 'text', required: true },
            { key: 'admin_email',      label: 'Admin email',   type: 'email', required: true },
            { key: 'admin_phone',      label: 'Admin phone',   type: 'phone', required: true },
            { key: 'message',          label: 'Message',       type: 'textarea' },
            { key: 'referral_source',  label: 'How they heard about us', type: 'text' },
            { key: 'status',           label: 'Status',        type: 'select',
              options: [['pending','Pending'], ['approved','Approved'], ['rejected','Rejected']] },
            { key: 'review_notes',     label: 'Review notes',  type: 'textarea' },
        ],
    },

    // ============== PATIENT WORK (operational workflows, stubs for now) ==============
    patient_registration: {
        type: 'workflow',
        group: 'Registration & booking management',
        label: 'Patient registration',
        description: 'Front-desk intake — search by phone / MRN / national ID to find an existing patient, or create a new patient record. Used by registrars when a patient walks in or calls. Will reuse the patient form fields you already configured under Settings → Patients, but with a search-first, single-patient layout.',
    },
    appointment_calendar: {
        type: 'workflow',
        group: 'Registration & booking management',
        label: 'Appointment via calendar',
        description: 'Day / week calendar — see all booked slots across doctors and branches, click an empty slot to book, drag to reschedule. Slot length comes from each service\'s duration_minutes. Will need an appointments table.',
    },
    // Detail view reached from the Patient registration screen via the
    // "Patient card" button. Hidden from the sidebar — opened programmatically.
    patient_card: {
        type: 'workflow',
        hidden: true,
        label: 'Patient card',
        description: 'Full patient profile — demographics, visits, orders, history, files, diagnoses, labs, vaccinations.',
    },
    patient_visit_list: {
        type: 'workflow',
        group: 'Registration & booking management',
        label: 'Patient visit list',
        description: 'List of all visits with filters by date range, branch, doctor, payer, status (scheduled / arrived / in-progress / completed / no-show / cancelled). Used to find a past visit or follow up on outstanding ones. Needs appointments + encounters.',
    },
    appointment_info: {
        type: 'workflow',
        group: 'Registration & booking management',
        label: 'Appointment information',
        description: 'Detailed view of a single appointment — patient demographics, scheduled services, doctor and room assignment, status timeline, encounter notes once started, linked invoice. Drill-down target from calendar or visit list.',
    },

    cashier_main: {
        type: 'workflow',
        group: 'Cashier',
        label: 'Cash register',
        description: 'Front-desk cash desk — list of patients with outstanding balances, accept payment (cash / card / insurance claim), apply discounts, print receipts (with IKPU), end-of-day cash close. Needs invoices + payments.',
    },

    doctors_workspace: {
        type: 'workflow',
        label: 'Doctors',
        description: 'Doctor\'s workspace — today\'s scheduled patients, in-progress consultations, write encounter notes, record diagnoses (ICD-10), place service orders (labs / imaging / prescriptions), refer to another doctor or service. Needs encounters + diagnoses + orders.',
    },
    gift_cards: {
        type: 'workflow',
        label: 'Gift cards',
        description: 'Issue, redeem, and track gift cards — sold to a patient or corporate buyer, with a balance that can be applied against any invoice until it expires.',
    },
    surgery_queue: {
        type: 'workflow',
        label: 'Surgery queue',
        description: 'Operations waiting list — patients pending a surgical slot, with target date, surgeon, anesthesiologist, operating room, pre-op checklist, and priority. Used by surgical coordinators.',
    },

    // ============== REPORTS (stub destinations, no table) ==============
    workload_by_categories_report: {
        type: 'report',
        group: 'Workload',
        label: 'Workload by categories',
        description: 'Service-category utilisation over a date range — total encounters, hours, revenue per service category (Cardiology, Lab, Imaging, …). Needs the encounters table.',
    },
    workload_by_doctors_report: {
        type: 'report',
        group: 'Workload',
        label: 'Workload by doctors',
        description: 'Per-doctor utilisation — encounters per day, average duration, total hours, idle gaps. Needs the encounters table linked to a performing doctor.',
    },
    referred_categories_report: {
        type: 'report',
        group: 'Referrals',
        label: 'Referred service categories',
        description: 'Which service categories are most often referred to — totals by service category over a date range, with conversion to paid visits. Needs encounters with a referring doctor + service category link.',
    },
    external_referrers_report: {
        type: 'report',
        group: 'Referrals',
        label: 'External partner referrers',
        description: 'Performance of external referral sources (other clinics, partner doctors, online channels, advertisements) — patients sent, conversion to paid visits, revenue produced, commission owed. Needs encounters + invoices.',
    },
    internal_referrers_report: {
        type: 'report',
        group: 'Referrals',
        label: 'Internal partner referrers',
        description: 'Internal staff (your own doctors) sending patients to other services — referral bonuses owed under the doctor_referral_bonuses rules. Needs encounters with the referring-doctor link populated.',
    },
    orders_salary_report: {
        type: 'report',
        group: 'Orders',
        label: 'Salary report',
        description: 'Per-doctor earnings over a date range — performance fees (from doctor_prices) + referral bonuses (from doctor_referral_bonuses) + any base salary. Aggregates by doctor with totals per branch / department. Needs encounters + invoices.',
    },
    orders_services_report: {
        type: 'report',
        group: 'Orders',
        label: 'Services report',
        description: 'Services rendered over a date range — counts, revenue, breakdown by service type / category / department. Identifies most- and least-used services. Needs encounters / orders.',
    },
    orders_pending_report: {
        type: 'report',
        group: 'Orders',
        label: 'Unperformed services report',
        description: 'Services that were ordered for a patient but not yet completed — outstanding tests, follow-ups, prescribed procedures. Useful for backlog and patient follow-up. Needs an orders table with status (pending / completed / cancelled).',
    },
    orders_revenue_report: {
        type: 'report',
        group: 'Orders',
        label: 'Full revenue report',
        description: 'Total revenue over a date range, broken down by payer, service category, branch, doctor. Includes gross, discount, VAT, and net. Needs invoices.',
    },
    payer_companies_report: {
        type: 'report',
        group: 'Payers',
        label: 'Payer company report',
        description: 'Revenue per payer company (insurer / corporate / government / cash bucket) over a date range — total billed, total reimbursed, outstanding claims, average reimbursement %, claim turnaround time. Needs invoices + payments.',
    },
};

// Sections that should resolve `<table>.name` (or `full_name`) as the label
// when used as an FK source. Keys map a table to its label column.
export const FK_LABEL_COLUMN = {
    companies:          'name',
    branches:           'name',
    payers:             'name',
    payer_policies:     'name',
    payment_providers:  'name',
    services:           'name',
    referral_sources:   'name',
    referral_source_categories: 'name',
    departments:        'name',
    service_categories: 'name',
    service_types:      'name',
    product_nnm:        'name',
    users:              'full_name',
    ikpu_codes:         'code',
    positions:          'name',
    roles:              'name',
    patient_categories: 'name',
    wards:              'name',
    beds:               'code',
    floors:             'name',
    rooms:              'name',
};

// Extra (non-label) columns to pull into the FK cache so a form's
// `visibleWhen` predicate can read them. e.g. a service's tube-colour field is
// shown only when the chosen service type has `requires_tube = true`.
export const FK_EXTRA_COLUMNS = {
    service_types: ['requires_tube', 'billing_mode'],
};
