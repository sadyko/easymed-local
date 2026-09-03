// CALLCENTER_ROLE_V1 — 'callcenter' joins the staff READ set like every other
// role: the CRM board needs patients, users and services, and the app shell
// loads reference tables for whoever is logged in. What makes the role narrow
// is its WRITE grants (the CRM pair plus the patient card it registers), not a
// bespoke read surface.
const ALL_STAFF = ['admin','registrar','doctor','cashier','lab','nurse','inventory','callcenter'];

// LAB_PANELS_BY_SECTION_V1 (2026-08-31, owner: «who ever will have permission
// of the lab section will be able to edit the panels») — the roles whose
// seeded role_permissions row (migration 013/016) carries the 'labs' section,
// i.e. everyone the client shows Лаборатория to. Panel-catalog writes key on
// THIS set so the door the sidebar shows and the door the server opens are the
// same door. If a clinic re-grants 'labs' to another role in Настройки → Роли,
// this static list must follow — the ACL layer reads roles, not sections.
// Exported (LAB_STATS_V1): rpc/lab-stats.js gates the read-only usage
// statistics on the SAME constant, so the panel writes and the stats read can
// never disagree about who holds the lab section.
export const LAB_SECTION_ROLES = ['admin','doctor','lab','nurse'];

export const REGISTRY = {
  // CRM_V1 (mig 044) — журнал обращений; конверсия в пациента выставляет
  // patient_id + status 'converted' (обычный /api/db, денег нет).
  crm_requests: {
    read:  { roles: ALL_STAFF, columns: ['id','full_name','phone','source','note','status','patient_id','assigned_to','created_by','created_at','updated_at','service_id','scheduled_date','call_id'] },   // service_id: CRM_V3 (045); scheduled_date: CRM_V7 (047); call_id: CRM_CONFIG_V1 (077)
    // call_id is READ-ONLY on purpose: only lead-from-call.js writes it, and it
    // is the card's proof that a lead came from a real phone call. A screen
    // able to set it could claim a call that never happened.
    // CALLCENTER_ROLE_V1 — running this board IS the call centre's job. Deleting
    // a request stays admin-only: the operator closes a lead by status, and the
    // journal is what the clinic audits calls with.
    write: { insert: { roles: ['admin','registrar','callcenter'], columns: ['full_name','phone','source','note','status','assigned_to','created_by','service_id','patient_id','scheduled_date'] },   // patient_id: CRM_V5; scheduled_date: CRM_V7
             update: { roles: ['admin','registrar','callcenter'], columns: ['full_name','phone','source','note','status','patient_id','assigned_to','service_id','scheduled_date'] },
             delete: { roles: ['admin'] } },
    filters: ['id','status','source','phone','full_name','created_at','patient_id','scheduled_date'],
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','full_name','mrn'] },
               users:    { table:'users',    fk:'assigned_to', columns:['id','full_name'] },
               services: { table:'services', fk:'service_id',  columns:['id','name','price'] } },
  },

  // CRM_MULTI_SERVICE_V1 (mig 057) — the services a call-centre request covers,
  // one row per service with its OWN date. The registrar's prefill reads this
  // table; crm_requests.service_id/scheduled_date remain only as a mirror of the
  // first line for the kanban card and the Excel export.
  crm_request_services: {
    // doctor_id: CRM_LINE_DOCTOR_V1 (mig 058) — a service that requires a doctor
    // is booked WITH one; the registrar's prefill carries it into the смета.
    read:  { roles: ALL_STAFF, columns: ['id','request_id','service_id','scheduled_date','status','note','doctor_id','created_at'] },
    // CALLCENTER_ROLE_V1 — «Сохранить и записать» writes the dated lines here,
    // and re-booking cancels the superseded ones by UPDATE, so the call centre
    // needs insert+update. It never deletes: saveLines() cancels, so that a line
    // the registrar already closed survives an edit of the request.
    write: { insert: { roles: ['admin','registrar','callcenter'], columns: ['request_id','service_id','scheduled_date','status','note','doctor_id'] },
             update: { roles: ['admin','registrar','callcenter'], columns: ['service_id','scheduled_date','status','note','doctor_id'] },
             delete: { roles: ['admin','registrar'] } },
    filters: ['id','request_id','service_id','scheduled_date','status','doctor_id'],
    embed:   { services: { table:'services', fk:'service_id', columns:['id','name','price','requires_doctor'] },
               users:    { table:'users',    fk:'doctor_id',  columns:['id','full_name','specialty'] },
               crm_requests: { table:'crm_requests', fk:'request_id', columns:['id','patient_id','full_name','phone','status'] } },
  },

  patients: {
    // PATIENTS_SECTION_V1 (mig 034) — marital/emergency-relation/insurance
    // columns + writable mrn/active/registration_date so easymed's Settings →
    // Пациенты section (full form + Excel import) round-trips every field.
    read:   { roles: ALL_STAFF, columns: ['id','mrn','full_name','first_name','last_name','middle_name',
              'date_of_birth','gender','blood_type','phone','email','national_id','address','nationality',
              'occupation','emergency_contact_name','emergency_contact_phone','allergies','chronic_conditions',
              'branch_id','primary_doctor_id','payer_id','referral_source_id','notes','photo_url','active',
              'registration_date','created_by','created_at','updated_at',
              'marital_status','emergency_contact_relation','payer_policy_id','insurance_policy_number','insurance_expiry_date',
              'sync_origin'] },   // sync_origin: BRANCH_ORIGIN_V1 — см. комментарий у filters
    write:  {
      // CALLCENTER_ROLE_V1 — «Зарегистрировать» on a CRM card creates the patient
      // card from the call. INSERT only: the call centre opens a card for the
      // person it is talking to, it does not edit the existing register.
      insert: { roles: ['admin','registrar','callcenter'], columns: ['mrn','full_name','first_name','last_name','middle_name',
                'date_of_birth','gender','blood_type','phone','email','national_id','address','nationality',
                'occupation','emergency_contact_name','emergency_contact_phone','allergies','chronic_conditions',
                'branch_id','primary_doctor_id','payer_id','referral_source_id','notes','photo_url','created_by',
                'active','registration_date',
                'marital_status','emergency_contact_relation','payer_policy_id','insurance_policy_number','insurance_expiry_date'] },
      update: { roles: ['admin','registrar'], columns: ['mrn','full_name','first_name','last_name','middle_name',
                'date_of_birth','gender','blood_type','phone','email','national_id','address','nationality',
                'occupation','emergency_contact_name','emergency_contact_phone','allergies','chronic_conditions',
                'branch_id','primary_doctor_id','payer_id','referral_source_id','notes','photo_url','created_by',
                'active','registration_date',
                'marital_status','emergency_contact_relation','payer_policy_id','insurance_policy_number','insurance_expiry_date'] },
      // Settings → Пациенты exposes per-row + bulk delete (admin only). A
      // patient with clinical history is still protected by FK constraints —
      // the delete errors cleanly and the row survives.
      delete: { roles: ['admin'] },
    },
    // date_of_birth: CRM_V9 — поиск пациента по дате рождения в форме заявки.
    // PAGED_LIST_V1 — email/gender/payer_id/payer_policy_id: раздел «Пациенты»
    // ищет и фильтрует по ним, а на 70k строк это считает SQL, а не браузер;
    // без них серверная фильтрация отвергала бы запрос как unknown column.
    // BRANCH_ORIGIN_V1 (mig 083) — откуда строка: NULL = заведена здесь, буква =
    // приехала от того филиала. Читается, чтобы списки могли ПОКАЗАТЬ метку, и
    // фильтруется, чтобы рабочие списки (лабораторная очередь, кабинет врача)
    // спрашивали `.is('sync_origin', null)` одним запросом, а не отсеивали
    // чужое в браузере после limit. НЕ writable ни в одной операции: метку
    // ставит только приём порции (branch-sync/records.js) — экран, способный её
    // выставить, мог бы выдать чужую работу за свою.
    filters: ['id','mrn','phone','national_id','full_name','email','gender','date_of_birth','branch_id','primary_doctor_id','payer_id','payer_policy_id','active','created_at','registration_date','sync_origin'],
    embed:   { branches: { table:'branches', fk:'branch_id', columns:['id','name'] },
               payers:   { table:'payers',   fk:'payer_id',  columns:['id','name'] } },
  },
  visits: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id','doctor_id','branch_id','visit_date',
             'duration_minutes','visit_kind','visit_type','status','referral_source_id','notes',
             'conclusion','conclusion_type','created_by','created_at','updated_at',
             'sync_origin'] },   // sync_origin: BRANCH_ORIGIN_V1 (mig 083) — откуда строка; ставится только приёмом порции, поэтому не writable
    write: {
      insert: { roles: ['admin','registrar','doctor'], columns: ['patient_id','doctor_id','branch_id','visit_date',
                'duration_minutes','visit_kind','visit_type','status','referral_source_id','notes','created_by'] },
      update: { roles: ['admin','registrar','doctor'], columns: ['status','visit_date','duration_minutes','doctor_id','notes','conclusion','conclusion_type'] },
      delete: { roles: ['admin'] },
    },
    filters: ['id','patient_id','doctor_id','branch_id','status','visit_date','sync_origin'],   // sync_origin: BRANCH_ORIGIN_V1
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','mrn','full_name','first_name','last_name','middle_name','phone','date_of_birth','gender'] },
               doctor:   { table:'users',    fk:'doctor_id',  columns:['id','full_name'] } },
  },
  services: {
    read:  { roles: ALL_STAFF, columns: ['id','name','code','price','tax_rate','duration_minutes','requires_doctor','active','created_at','updated_at',
             'is_lab','specimen','result_unit','ref_low','ref_high','ref_text','type','type_id','category_id','department_id','tube_color',
             'default_doctor_percent','room_id'] },   // tube_color: LAB_HANDLING_V1 (mig 041); default_doctor_percent/room_id: SERVICE_EDITOR_V1 (mig 081) — read-only here, written ONLY by the service_save RPC (rates merge must be transactional)
    write: { insert: { roles: ['admin'], columns: ['name','code','price','tax_rate','duration_minutes','requires_doctor','active',
             'is_lab','specimen','result_unit','ref_low','ref_high','ref_text','type','type_id','category_id','department_id','tube_color'] },
             update: { roles: ['admin'], columns: ['name','code','price','tax_rate','duration_minutes','requires_doctor','active',
             'is_lab','specimen','result_unit','ref_low','ref_high','ref_text','type','type_id','category_id','department_id','tube_color'] },
             delete: { roles: [] } },
    // `type` is the routing column ('lab','consultation','procedure','imaging',
    // 'other') and was readable but not filterable, so "give me the lab services"
    // had to fetch everything and sift client-side. It is already exposed on read;
    // allowing it as a filter grants nothing new. LAB_SERVICE_ROUTING_V1.
    filters: ['id','active','code','name','type','type_id','category_id','department_id'],
    // DOCTOR_WORKSPACE_V1 — nested-embed hops used by My services / the workspace:
    // services(service_types(name), departments(kind), service_categories(name)).
    embed: { service_types:      { table:'service_types',      fk:'type_id',       columns:['id','name','code'] },
             departments:        { table:'departments',        fk:'department_id', columns:['id','name','kind'] },
             service_categories: { table:'service_categories', fk:'category_id',   columns:['id','name','code'] } },
  },
  visit_services: {
    read:  { roles: ALL_STAFF, columns: ['id','visit_id','service_id','clinic_item_id','doctor_id','quantity','unit_price','total','status','invoice_item_id','created_by','created_at','consultation_type_id','scheduled_at','queue_key','queue_no','notes',
             'sample_collected_at','verified_by','verified_at','sync_origin'] },   // queue_* set ONLY by issue_queue_numbers; notes = WS consult document JSON (mig 039); sample/verify: LAB_HANDLING_V1 (mig 041); sync_origin: BRANCH_ORIGIN_V1 (mig 083)
    write: { insert: { roles: ['admin','registrar','doctor'], columns: ['visit_id','service_id','doctor_id','quantity','unit_price','total','status','created_by','consultation_type_id','scheduled_at'] },
             update: { roles: ['admin','registrar','doctor','lab','nurse'], columns: ['status','doctor_id','consultation_type_id','notes',
             'sample_collected_at','verified_by','verified_at'] },   // LAB_HANDLING_V1 (lab) + PROCEDURES_V1 (nurse отмечает выполнение)
             delete: { roles: ['admin','registrar'] } },
    // BRANCH_ORIGIN_V1 — правило то же, что у patients выше, и здесь оно и
    // работает: кабинет врача и процедуры спрашивают `.is('sync_origin', null)`
    // — «работа этого здания» (решение владельца 2026-09-02). Фильтр серверный:
    // их .limit() иначе тратился бы на чужие строки.
    // LAB_ONE_CLINIC_V1 (миграция 085) — лаборатория с тех пор спрашивает этот фильтр
    // УСЛОВНО: doc_settings.lab_scope решает, обслуживает она всю клинику (по
    // умолчанию) или только своё здание. Фильтр остаётся здесь ради второго
    // случая — см. views/lab-scope.js.
    filters: ['id','visit_id','service_id','status','invoice_item_id','doctor_id','created_at','notes','sync_origin'],   // notes filter: WS_DERIVED_DOCS_V1 (.not('notes','is',null))
    // DOCTOR_WORKSPACE_V1 — the My-services queue joins the whole clinical
    // context off one row: services (+nested type/department), the booked
    // consultation type, the provider (doctor_id -> users, easymed aliases it
    // `users:doctor_id(...)`), the visit (+nested patient), and the dispensed
    // product (easymed calls that relation clinic_items; the table is products).
    embed:   { services: { table:'services', fk:'service_id', columns:['id','name','price','is_lab','result_unit','ref_low','ref_high','ref_text','specimen','type','duration_minutes','tax_rate','type_id','category_id','tube_color','department_id'] },   // department_id: PROCEDURES_V1
               products: { table:'products', fk:'clinic_item_id', columns:['id','name','unit'] },
               clinic_items: { table:'products', fk:'clinic_item_id', columns:['id','name','unit'] },
               consultation_types: { table:'consultation_types', fk:'consultation_type_id', columns:['id','name','name_ru','name_uz','price'] },
               // RECEIPT_DOB_PERFORMER_V1 — `role` нужен чеку: он печатает, КТО оказал
               // услугу — врач, лаборант или медсестра. Специальности хватает только
               // врачам, у медсестры и лаборанта она пустая.
               doctor_id: { table:'users', fk:'doctor_id', columns:['id','full_name','specialty','role'] },
               verified_by: { table:'users', fk:'verified_by', columns:['id','full_name'] },   // performer:verified_by(...) в процедурах
               visits: { table:'visits', fk:'visit_id', columns:['id','visit_date','patient_id','status','doctor_id'] } },
  },
  lab_results: {
    read:  { roles: ALL_STAFF, columns: ['id','visit_service_id','parameter','value','numeric_value','unit','reference_range','flag','notes','entered_by','entered_at','verified_by','verified_at','created_at','ref_low','ref_high','sync_origin'] },   // ref_low/high: LAB_HANDLING_V1 (mig 041); sync_origin: BRANCH_ORIGIN_V1 (mig 083)
    write: { insert: { roles: ['admin','lab'], columns: ['visit_service_id','parameter','value','numeric_value','unit','reference_range','flag','notes','entered_by','ref_low','ref_high'] },
             update: { roles: ['admin','lab'], columns: ['parameter','value','numeric_value','unit','reference_range','flag','notes','verified_by','verified_at','ref_low','ref_high'] },
             delete: { roles: ['admin'] } },
    filters: ['id','visit_service_id','sync_origin'],   // sync_origin: BRANCH_ORIGIN_V1 — «своё здание» одним запросом
    embed:   {},
  },
  invoices: {
    // payer_id: COVERAGE_SPLIT_V1 (mig 054) — кому выставлен счёт (null = пациенту)
    read:  { roles: ALL_STAFF, columns: ['id','invoice_number','visit_id','patient_id','branch_id','subtotal','discount_amount','total_amount','paid_amount','status','created_by','created_at','paid_at','admission_id','payer_id'] },   // admission_id: BED_CONSOLE_V1 (mig 040)
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },  // invoices are created/updated ONLY via billing RPCs (server-computed money)
    filters: ['id','visit_id','patient_id','branch_id','status','admission_id','payer_id'],
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','mrn','full_name'] },
               payers:   { table:'payers',   fk:'payer_id',   columns:['id','name','kind'] } },
  },
  invoice_items: {
    read:  { roles: ALL_STAFF, columns: ['id','invoice_id','service_id','description','quantity','unit_price','total','created_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },  // written only by billing RPCs
    filters: ['id','invoice_id','service_id'],
    embed:   { services: { table:'services', fk:'service_id', columns:['id','name'] } },
  },
  payments: {
    read:  { roles: ALL_STAFF, columns: ['id','invoice_id','amount','method','cashier_id','notes','paid_at','created_at','shift_id'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },  // written only by the record_payment RPC
    filters: ['id','invoice_id','method','shift_id'],
    embed:   {},
  },
  cash_shifts: {
    // Drawer figures (counted / over-short) are sensitive → cashier + admin only,
    // not ALL_STAFF. The cashier workspace reads its own shift via the
    // cash_shift_summary RPC; this raw read backs the Head-cashier overview.
    read:  { roles: ['admin','cashier'], columns: ['id','cashier_id','branch_id','opening_float','opened_at','closed_at','counted_amount','expected_amount','over_short','status','notes','created_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },  // written only by the cash-shift RPCs (money)
    filters: ['id','cashier_id','status','branch_id'],
    embed:   { users: { table:'users', fk:'cashier_id', columns:['id','full_name'] } },
  },
  cash_movements: {
    // «Внести»/«Изъять» drawer movements — read backs the cashier «История»
    // feed (CASHIER_HISTORY_ALL_V1); written only by the cash_move RPC (money).
    read:  { roles: ['admin','cashier'], columns: ['id','shift_id','kind','amount','article','note','created_by','created_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','shift_id','kind'],
    embed:   {},
  },
  branches: { read:{roles:ALL_STAFF, columns:['id','name','phone','address','is_24_7','working_hours','active']},
              write:{ insert:{roles:['admin'],columns:['name','phone','address','license_number','is_24_7','working_hours']},
                      update:{roles:['admin'],columns:['name','phone','address','license_number','is_24_7','working_hours','active']},
                      delete:{roles:[]} },
              filters:['id','active'], embed:{} },
  payers:    { read:{roles:ALL_STAFF,columns:['id','name','kind','active']},
               write:{insert:{roles:['admin'],columns:['name','kind']},update:{roles:['admin'],columns:['name','kind','active']},delete:{roles:[]}},
               filters:['id','active','kind'], embed:{} },
  // REFERRAL_SOURCE_PERSON_V1 (mig 058) — a source is usually a person the clinic
  // pays a commission to: ФИО in parts, contact, workplace, district, and the
  // payout details. `name` stays the display label every consumer reads and is
  // composed from the name parts by the editor.
  referral_sources: { read:{roles:ALL_STAFF,columns:['id','name','category','last_name','first_name','middle_name',
                 'phone','workplace','district','payment_type','card_number','active']},
               write:{insert:{roles:['admin','registrar'],columns:['name','category','last_name','first_name','middle_name',
                 'phone','workplace','district','payment_type','card_number']},
                 update:{roles:['admin'],columns:['name','category','last_name','first_name','middle_name',
                 'phone','workplace','district','payment_type','card_number','active']},delete:{roles:[]}},
               filters:['id','active'], embed:{} },
  // DOCTOR_WORKSPACE_V1 — columns the My-services doctor dashboard and the
  // workspace read. `active` is a generated mirror of is_active (mig 032) so
  // easymed's `.eq('active', true)` filters work unchanged; the rates/KPI
  // columns are JSON blobs. rooms embed = the doctor's cabinet
  // (users:doctor_id(rooms(name, floors(name))) in the queue).
  users:     { read:{roles:ALL_STAFF, columns:['id','username','full_name','role','is_active','active','extra_roles',
                'phone','email','specialty','is_doctor','doctor_category','salary_type','salary_fixed','salary_percent',
                'service_rates','referral_rates','kpi_links','license_expiry_date','room_id',
                'working_hours','scheduling_mode']},   // SCHED_V1 — the wizard's slot engine
               write:{insert:{roles:[]},update:{roles:[]},delete:{roles:[]}},
               filters:['id','role','is_active','active','is_doctor'],
               json:['service_rates','referral_rates','kpi_links'],
               embed:{ rooms: { table:'rooms', fk:'room_id', columns:['id','name'] } } },
  products: {
    read:  { roles: ALL_STAFF, columns: ['id','name','code','unit','category','sale_price','on_hand','reorder_level','active','created_at','updated_at',
             'base_unit','purchase_unit','pack_factor','consumption_unit','consumption_factor','is_drug','avg_cost','track_batches','procurement_category','supplier_id'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['name','code','unit','category','sale_price','reorder_level','active',
                'base_unit','purchase_unit','pack_factor','consumption_unit','consumption_factor','is_drug','track_batches','procurement_category','supplier_id'] },
             update: { roles: ['admin','inventory'], columns: ['name','code','unit','category','sale_price','reorder_level','active',
                'base_unit','purchase_unit','pack_factor','consumption_unit','consumption_factor','is_drug','track_batches','procurement_category','supplier_id'] },
             delete: { roles: [] } },
    filters: ['id','active','category','code','name','procurement_category','is_drug'],
    embed:   { suppliers: { table:'suppliers', fk:'supplier_id', columns:['id','name'] } },
  },
  stock_movements: {
    read:  { roles: ALL_STAFF, columns: ['id','product_id','kind','qty','unit_cost','reference_type','reference_id','note','created_by','created_at','supplier_id','batch_no','expiry_date'] },   // RECEIVE_EASYMED_V1 (mig 037)
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','product_id','kind'],
    embed:   { products: { table:'products', fk:'product_id', columns:['id','name','unit','base_unit'] } },
  },
  // lab_scope: LAB_ONE_CLINIC_V1 (mig 085) — «лаборатория обслуживает всю
  // клинику / только своё здание». ЧИТАЮТ ВСЕ (лаборант должен знать, почему в
  // его очереди пробирки соседнего корпуса — раздел решает это на каждой
  // загрузке), МЕНЯЕТ ТОЛЬКО АДМИНИСТРАТОР: это устройство клиники, и оно
  // уезжает филиалам со справочником (branch-sync/catalogue.js).
  doc_settings: {
    read:  { roles: ALL_STAFF, columns: ['id','clinic_name','address','phone','email','license','logo_data_url','accent_color','paper_size','show_watermark','footer_note','legal_note','lab_scope','updated_at'] },
    write: { insert: { roles: [] },
             update: { roles: ['admin'], columns: ['clinic_name','address','phone','email','license','logo_data_url','accent_color','paper_size','show_watermark','footer_note','legal_note','lab_scope'] },
             delete: { roles: [] } },
    filters: ['id'],
    embed:   {},
  },
  // Clinic-wide print/branding for the rich 6-type document designer (documents.js /
  // doc-settings.js). `settings` is a JSON blob (declared in `json` below), keyed by
  // company_id — allow-listed here so it survives the tenancy no-op and can serve as
  // the upsert conflict target (ON CONFLICT (company_id)).
  doc_branding: {
    read:  { roles: ALL_STAFF, columns: ['id','company_id','settings','updated_at'] },
    write: { insert: { roles: ['admin'], columns: ['company_id','settings','updated_at'] },
             update: { roles: ['admin'], columns: ['company_id','settings','updated_at'] },
             delete: { roles: [] } },
    filters: ['id','company_id'],
    json:    ['settings'],
    embed:   {},
  },
  departments: { read:{roles:ALL_STAFF,columns:['id','name','code','kind','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','code','kind','active']},update:{roles:['admin'],columns:['name','code','kind','active']},delete:{roles:[]}},
    filters:['id','active','kind'], embed:{} },
  service_types: { read:{roles:ALL_STAFF,columns:['id','name','code','billing_mode','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','code','billing_mode','active']},update:{roles:['admin'],columns:['name','code','billing_mode','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  consultation_types: { read:{roles:ALL_STAFF,columns:['id','name','name_ru','name_uz','sort_order','price','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','name_ru','name_uz','sort_order','price','active']},update:{roles:['admin'],columns:['name','name_ru','name_uz','sort_order','price','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  patient_categories: { read:{roles:ALL_STAFF,columns:['id','name','tier','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','tier','active']},update:{roles:['admin'],columns:['name','tier','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  floors: { read:{roles:ALL_STAFF,columns:['id','name','level','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','level','active']},update:{roles:['admin'],columns:['name','level','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  // ROOMS_SETUP_V1 — code/room_type/capacity/queue_mode добавлены миграцией 082;
  // без них объединённый раздел «Помещения» мог создать строку, но не описать её.
  rooms: { read:{roles:ALL_STAFF,columns:['id','name','code','room_type','capacity','queue_mode','floor_id','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','code','room_type','capacity','queue_mode','floor_id','active']},update:{roles:['admin'],columns:['name','code','room_type','capacity','queue_mode','floor_id','active']},delete:{roles:[]}},
    filters:['id','active','floor_id','room_type','queue_mode'], embed:{ floors:{table:'floors',fk:'floor_id',columns:['id','name']} } },
  wards: { read:{roles:ALL_STAFF,columns:['id','name','code','floor_id','active','created_at','type','billing_mode','price_per_day','price_per_hour','color']},
    write:{insert:{roles:['admin'],columns:['name','code','floor_id','active','type','billing_mode','price_per_day','price_per_hour','color']},update:{roles:['admin'],columns:['name','code','floor_id','active','type','billing_mode','price_per_day','price_per_hour','color']},delete:{roles:[]}},
    filters:['id','active','floor_id'], embed:{ floors:{table:'floors',fk:'floor_id',columns:['id','name']} } },
  // `status` is intentionally NOT writable via /api/db — bed occupancy/housekeeping
  // is changed only by the inpatient RPCs (admit → occupied, discharge → cleaning,
  // set_bed_status → free/cleaning/maintenance), so a config edit can never desync a
  // bed from an active admission. Insert defaults status to 'free' at the DB level.
  beds: { read:{roles:ALL_STAFF,columns:['id','code','ward_id','status','active','created_at','type','price_per_day','price_per_hour','notes']},
    write:{insert:{roles:['admin'],columns:['code','ward_id','active','type','price_per_day','price_per_hour','notes']},update:{roles:['admin'],columns:['code','ward_id','active','type','price_per_day','price_per_hour','notes']},delete:{roles:[]}},
    filters:['id','active','ward_id'], embed:{ wards:{table:'wards',fk:'ward_id',columns:['id','name']} } },
  admissions: {
    read:  { roles: ALL_STAFF, columns: ['id','admission_no','patient_id','bed_id','ward_id','doctor_id','pathway',
             'chief_complaint','admission_diagnosis','admitted_at','discharged_at','status',
             'accommodation_discount_percent','charge_amount','invoice_id','created_by','created_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },  // admissions are created/updated ONLY via inpatient RPCs (server-computed money)
    filters: ['id','patient_id','bed_id','ward_id','status','doctor_id'],
    embed: {
      patients: { table:'patients', fk:'patient_id', columns:['id','mrn','full_name'] },
      beds:     { table:'beds',     fk:'bed_id',     columns:['id','code'] },
      wards:    { table:'wards',    fk:'ward_id',    columns:['id','name'] },
      users:    { table:'users',    fk:'doctor_id',  columns:['id','full_name'] },
    },
  },
  payer_policies: { read:{roles:ALL_STAFF,columns:['id','name','payer_id','coverage_percent','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','payer_id','coverage_percent','active']},update:{roles:['admin'],columns:['name','payer_id','coverage_percent','active']},delete:{roles:[]}},
    filters:['id','active','payer_id'], embed:{ payers:{table:'payers',fk:'payer_id',columns:['id','name']} } },
  payment_providers: { read:{roles:ALL_STAFF,columns:['id','name','fee_percent','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','fee_percent','active']},update:{roles:['admin'],columns:['name','fee_percent','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  cashback_rules: { read:{roles:ALL_STAFF,columns:['id','name','percent','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','percent','active']},update:{roles:['admin'],columns:['name','percent','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  referral_source_categories: { read:{roles:ALL_STAFF,columns:['id','name','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','active']},update:{roles:['admin'],columns:['name','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  referral_rewards: { read:{roles:ALL_STAFF,columns:['id','name','percent','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','percent','active']},update:{roles:['admin'],columns:['name','percent','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  patient_discounts: { read:{roles:ALL_STAFF,columns:['id','name','kind','percent','amount','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','kind','percent','amount','active']},update:{roles:['admin'],columns:['name','kind','percent','amount','active']},delete:{roles:[]}},
    filters:['id','active','kind'], embed:{} },
  api_tokens: { read:{roles:['admin'],columns:['id','name','token','active','created_at']},
    write:{insert:{roles:['admin'],columns:['name','token','active']},update:{roles:['admin'],columns:['name','token','active']},delete:{roles:[]}},
    filters:['id','active'], embed:{} },
  doctor_rates: { read:{roles:ALL_STAFF,columns:['id','doctor_id','service_id','percent','active','created_at']},
    write:{insert:{roles:['admin'],columns:['doctor_id','service_id','percent','active']},update:{roles:['admin'],columns:['doctor_id','service_id','percent','active']},delete:{roles:[]}},
    filters:['id','active','doctor_id','service_id'],
    embed:{ users:{table:'users',fk:'doctor_id',columns:['id','full_name']}, services:{table:'services',fk:'service_id',columns:['id','name']} } },
  role_permissions: {
    read:  { roles: ALL_STAFF, columns: ['id','role','permissions','updated_at'] },
    write: { insert: { roles: ['admin'], columns: ['role','permissions'] },
             update: { roles: ['admin'], columns: ['permissions'] },
             delete: { roles: [] } },
    filters: ['id','role'], embed: {},
  },

  // ─── Clinical spine (migration 024) ──────────────────────────────────────
  // Doctor orders / referrals. consultation.js, service-workspace.js, visit-modal.js.
  recommended_services: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id','service_id','service_name','recommended_by',
             'recommended_by_name','source_visit_id','notes','status','closed_at','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['patient_id','service_id','service_name',
               'recommended_by','recommended_by_name','source_visit_id','notes','status'] },
             update: { roles: ['admin','registrar','doctor','nurse'], columns: ['status','closed_at','notes'] },
             delete: { roles: ['admin'] } },
    filters: ['id','patient_id','service_id','recommended_by','status','created_at'],
    embed:   { services: { table:'services', fk:'service_id', columns:['id','name','price','duration_minutes'] },
               patients: { table:'patients', fk:'patient_id', columns:['id','full_name','first_name','last_name','mrn'] },
               recommended_by: { table:'users', fk:'recommended_by', columns:['id','full_name','specialty'] } },
  },
  // Signed encounter snapshots + document archive. service-workspace.js, docs-archive.js.
  visit_documents: {
    read:  { roles: ALL_STAFF, columns: ['id','title','file_name','file_path','file_size','content_type','doc_type',
             'visit_id','visit_service_id','patient_id','body','created_by','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['title','file_name','file_path','file_size',
               'content_type','doc_type','visit_id','visit_service_id','patient_id','body','created_by'] },
             update: { roles: ['admin','doctor'], columns: ['title','doc_type','body'] },
             delete: { roles: ['admin','doctor'] } },   // workspace deletes the prior protocol/diag before re-signing
    filters: ['id','patient_id','visit_id','visit_service_id','doc_type','created_at'],
    json:    ['body'],   // WS sign-archive stores the document snapshot as an object (AURORA_PATIENT_DOCS_V1)
    embed:   {},
  },
  // Vitals strip (latest reading per patient). service-workspace.js.
  patient_vitals: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id','visit_id','bp_sys','bp_dia','pulse_bpm','temp_c',
             'spo2','resp_rate','height_cm','weight_kg','notes','recorded_by','recorded_at','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['patient_id','visit_id','bp_sys','bp_dia',
               'pulse_bpm','temp_c','spo2','resp_rate','height_cm','weight_kg','notes','recorded_by'] },
             update: { roles: ['admin','doctor','nurse'], columns: ['bp_sys','bp_dia','pulse_bpm','temp_c','spo2',
               'resp_rate','height_cm','weight_kg','notes'] },
             delete: { roles: ['admin'] } },
    filters: ['id','patient_id','visit_id','recorded_at'],
    embed:   {},
  },
  // Chronic conditions / structured medcard. data.js, service-workspace.js.
  patient_conditions: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id','code','label','since_date','resolved_date','status',
             'severity','note','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['patient_id','code','label','since_date',
               'resolved_date','status','severity','note'] },
             update: { roles: ['admin','registrar','doctor','nurse'], columns: ['code','label','since_date','resolved_date',
               'status','severity','note'] },
             delete: { roles: ['admin','doctor'] } },   // workspace drops the matching active dx when removed
    filters: ['id','patient_id','code','status','since_date','created_at'],
    embed:   {},
  },
  // Legal representative / guardian links written at registration. registration.js, data.js.
  patient_guardians: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id','guardian_patient_id','name','relationship','phone','created_at'] },
    write: { insert: { roles: ['admin','registrar'], columns: ['patient_id','guardian_patient_id','name','relationship','phone'] },
             update: { roles: ['admin','registrar'], columns: ['patient_id','guardian_patient_id','name','relationship','phone'] },
             delete: { roles: ['admin'] } },
    filters: ['id','patient_id','guardian_patient_id'],
    embed:   {},
  },
  // Prepaid balance ledger. cashier.js, deposit-modal.js, cashback.js, invoice-actions.js, service-picker-modal.js.
  patient_deposits: {
    read:  { roles: ALL_STAFF, columns: ['id','deposit_number','patient_id','branch_id','amount','method','status',
             'notes','refund_amount','created_by','created_by_name','received_by','received_by_name','received_at',
             'closed_at','created_at'] },
    write: { insert: { roles: ['admin','registrar','cashier'], columns: ['deposit_number','patient_id','branch_id','amount',
               'method','status','notes','refund_amount','created_by','created_by_name','received_by','received_by_name','received_at'] },
             update: { roles: ['admin','cashier'], columns: ['status','notes','refund_amount','received_by','received_by_name',
               'received_at','closed_at'] },
             delete: { roles: ['admin','cashier'] } },   // spend/pay rollback deletes its own ledger row
    filters: ['id','patient_id','status','notes','created_at'],
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','full_name','first_name','last_name','mrn','phone'] } },
  },
  // Shared SOAP templates. documents.js, service-workspace.js. (doctor/admin own them)
  consultation_templates: {
    read:  { roles: ALL_STAFF, columns: ['id','name','doc_type','scope','body','author_id','author_name','created_at','updated_at'] },
    write: { insert: { roles: ['admin','doctor'], columns: ['name','doc_type','scope','body','author_id','author_name'] },
             update: { roles: ['admin','doctor'], columns: ['name','doc_type','scope','body'] },
             delete: { roles: ['admin','doctor'] } },
    filters: ['id','author_id','scope','updated_at'],
    embed:   {},
  },
  // Per-doctor consultation prices (admin config). appointments.js, consultation-types.js, employee-editor.js.
  doctor_consultation_prices: {
    read:  { roles: ALL_STAFF, columns: ['id','doctor_id','consultation_type_id','price','available','is_free',
             'name_ru','name_uz','name_en','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['doctor_id','consultation_type_id','price','available','is_free',
               'name_ru','name_uz','name_en'] },
             update: { roles: ['admin'], columns: ['price','available','is_free','name_ru','name_uz','name_en'] },
             delete: { roles: ['admin'] } },   // save = reconcile (delete this doctor's rows, re-insert)
    filters: ['id','doctor_id','consultation_type_id'],
    embed:   {},
  },
  // Append-only invoice action trail. invoice-actions.js, visit-modal.js, cashier.js.
  invoice_audit_log: {
    read:  { roles: ALL_STAFF, columns: ['id','invoice_id','invoice_number','visit_id','action','from_status','to_status',
             'amount','refund_amount','actor_user_id','actor_name','actor_role','reason','notes','created_at'] },
    write: { insert: { roles: ['admin','registrar','cashier','doctor'], columns: ['invoice_id','invoice_number','visit_id',
               'action','from_status','to_status','amount','refund_amount','actor_user_id','actor_name','actor_role','reason','notes'] },
             update: { roles: [] },     // audit trail is append-only
             delete: { roles: [] } },
    filters: ['id','invoice_id','visit_id','created_at'],
    embed:   { actor_user_id: { table:'users', fk:'actor_user_id', columns:['id','full_name'] } },
  },
  // Queue numbers issued per service. cashier.js, service-picker-modal.js.
  service_queue_tickets: {
    read:  { roles: ALL_STAFF, columns: ['id','visit_service_id','visit_id','service_id','room_id','number','label',
             'queue_key','status','issued_at','created_at'] },
    write: { insert: { roles: ['admin','registrar'], columns: ['visit_service_id','visit_id','service_id','room_id','number',
               'label','queue_key','status'] },
             update: { roles: ['admin','registrar'], columns: ['status','number','label','queue_key','room_id'] },
             delete: { roles: ['admin'] } },
    filters: ['id','visit_service_id','visit_id','number','queue_key','issued_at'],
    embed:   {},
  },

  // ─── Inpatient + lab panels (migration 025) ──────────────────────────────
  // Inpatient line items — services, dispensed products, and accommodation
  // charges. beds.js, admission-modal.js, cashier.js, reports-export.js.
  // Nurses run the bed board; cashier touches these when billing the stay.
  admission_services: {
    read:  { roles: ALL_STAFF, columns: ['id','admission_id','service_id','clinic_item_id','doctor_id','bed_id',
             'ward_id','quantity','unit_price','total','status','notes','billable','performed_at','invoice_item_id','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse','cashier'], columns: ['admission_id','service_id',
               'clinic_item_id','doctor_id','bed_id','ward_id','quantity','unit_price','total','status','notes','billable','performed_at'] },
             update: { roles: ['admin','registrar','doctor','nurse','cashier'], columns: ['status','billable','notes','invoice_item_id'] },
             delete: { roles: ['admin','registrar','doctor','nurse'] } },   // unbilled lines are removed from the bed detail list
    filters: ['id','admission_id','service_id','invoice_item_id','performed_at'],
    embed:   { services: { table:'services', fk:'service_id',     columns:['id','name','price'] },
               products: { table:'products', fk:'clinic_item_id', columns:['id','name','unit'] },
               users:    { table:'users',    fk:'doctor_id',      columns:['id','full_name'] },
               beds:     { table:'beds',     fk:'bed_id',         columns:['id','code'] },
               wards:    { table:'wards',    fk:'ward_id',        columns:['id','name'] } },
  },
  // Bed movement log + accommodation billing-segment boundaries. beds.js,
  // admission-modal.js. Append-only (never updated/deleted in the UI).
  // The frontend selects aliased dual embeds (from/to beds, from/to wards, and
  // the acting user) via Supabase `alias:fk(cols)` syntax. The embed map is
  // keyed by the FK COLUMN (from_bed_id/to_bed_id/…), so the compiler resolves
  // `from:from_bed_id(code)` → an ALIASED `LEFT JOIN "beds" AS "from"` and can
  // emit two joins on the same table without colliding (Phase 2 compiler).
  admission_transfers: {
    read:  { roles: ALL_STAFF, columns: ['id','admission_id','from_bed_id','to_bed_id','from_ward_id','to_ward_id',
             'kind','reason','transferred_at','transferred_by','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['admission_id','from_bed_id','to_bed_id',
               'from_ward_id','to_ward_id','kind','reason','transferred_at','transferred_by'] },
             update: { roles: [] },       // movement log is append-only
             delete: { roles: ['admin'] } },
    filters: ['id','admission_id','kind','transferred_at'],
    embed:   { from_bed_id:  { table:'beds',  fk:'from_bed_id',  columns:['id','code'] },
               to_bed_id:    { table:'beds',  fk:'to_bed_id',    columns:['id','code'] },
               from_ward_id: { table:'wards', fk:'from_ward_id', columns:['id','name'] },
               to_ward_id:   { table:'wards', fk:'to_ward_id',   columns:['id','name'] } },
  },
  // Doctor's inpatient orders on a stay. beds.js, admission-modal.js.
  // Cancelled via active=0 (not deleted).
  admission_prescriptions: {
    read:  { roles: ALL_STAFF, columns: ['id','admission_id','patient_id','name','dose','freq','dur','nurse_notes',
             'prescribed_by','prescribed_by_name','active','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['admission_id','patient_id','name','dose',
               'freq','dur','nurse_notes','prescribed_by','prescribed_by_name','active'] },
             update: { roles: ['admin','registrar','doctor','nurse'], columns: ['active','nurse_notes','dose','freq','dur'] },
             delete: { roles: ['admin'] } },
    filters: ['id','admission_id','active','created_at'],
    embed:   {},
  },
  // Nurse execution journal. beds.js, admission-modal.js, pharmacy.js. Append-only.
  med_administrations: {
    read:  { roles: ALL_STAFF, columns: ['id','admission_id','patient_id','med_name','dose','instructions',
             'administered_by','administered_by_name','administered_at','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['admission_id','patient_id','med_name',
               'dose','instructions','administered_by','administered_by_name','administered_at'] },
             update: { roles: [] },       // execution journal is append-only
             delete: { roles: ['admin'] } },
    filters: ['id','admission_id','administered_at','created_at'],
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','full_name','first_name','last_name'] } },
  },
  // Lab/diagnostic panel definitions (config). views/lab-panels.js, mounted as
  // the «Панели» mode of Лаборатория. Owned by every labs-section role.
  lab_panels: {
    read:  { roles: ALL_STAFF, columns: ['id','name','code','modality','has_narrative','service_id','core_panel_id','active','created_at'] },
    write: { insert: { roles: LAB_SECTION_ROLES, columns: ['name','code','modality','has_narrative','service_id','core_panel_id','active'] },
             update: { roles: LAB_SECTION_ROLES, columns: ['name','code','modality','has_narrative','service_id','active'] },
             delete: { roles: LAB_SECTION_ROLES } },
    filters: ['id','modality','name','active'],
    embed:   {},
  },
  // Analytes within a panel (config). views/lab-panels.js. Saved by
  // delete-then-insert reconcile, so the labs roles need insert + delete.
  lab_panel_analytes: {
    read:  { roles: ALL_STAFF, columns: ['id','panel_id','code','name','unit','value_type','value_options','decimals',
             'ref_low','ref_high','ref_text','ref_low_m','ref_high_m','ref_low_f','ref_high_f','group_label','sort_order','ref_ranges','active','created_at'] },
    write: { insert: { roles: LAB_SECTION_ROLES, columns: ['panel_id','code','name','unit','value_type','value_options','decimals',
               'ref_low','ref_high','ref_text','ref_low_m','ref_high_m','ref_low_f','ref_high_f','group_label','sort_order','ref_ranges','active'] },
             update: { roles: LAB_SECTION_ROLES, columns: ['code','name','unit','value_type','value_options','decimals',
               'ref_low','ref_high','ref_text','ref_low_m','ref_high_m','ref_low_f','ref_high_f','group_label','sort_order','ref_ranges','active'] },
             delete: { roles: LAB_SECTION_ROLES } },
    // LAB_SVC_ANALYTE_FALLBACK_V1 — поиск по ИМЕНИ показателя: услуга без
    // панели («Д-димер» отдельной строкой в прайсе) берёт единицы и норму у
    // одноимённого показателя из справочника. Только чтение справочной
    // таблицы, доступной всему персоналу и без того.
    filters: ['id','panel_id','sort_order','name','code'],
    // LAB_MULTI_REF_V1 — ref_ranges holds the named age/sex/phase ranges as a JSON
    // array. Without this declaration bindWrite() never serialises it, bindable()
    // rejects the array with a 400, and saving ANY panel that has a named range
    // fails outright. Declaring it here also parses the value back on read, so
    // lab-settings.js and laboratory.js receive the array they expect.
    json:    ['ref_ranges'],
    embed:   {},
  },

  // LAB_TEMPLATES_V1 — the seeded laboratory catalogue (migrations 050/051) that
  // «Из каталога» browses. READ-ONLY through the API: it is reference content, not
  // clinic data, and it changes only by migration. Importing a template COPIES it
  // into lab_panels / lab_panel_analytes, which the clinic then owns and edits.
  lab_panel_templates: {
    read:  { roles: ALL_STAFF, columns: ['id','code','name','category','specimen','modality','description','preparation','sort_order','active','created_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','code','category','specimen','modality','active','name'],
    embed:   {},
  },
  lab_panel_template_analytes: {
    read:  { roles: ALL_STAFF, columns: ['id','template_id','code','name','unit','value_type','value_options','decimals','group_label','sort_order'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','template_id'],
    embed:   {},
  },

  // LAB_ANALYTE_LIBRARY_V1 — the parameter dictionary (migration 052) behind
  // «Из справочника» in the panel editor. Read-only for the same reason as the
  // panel catalogue above: reference content, changed only by migration. Picking a
  // parameter COPIES its name/unit/type into the panel's own analyte row, which the
  // clinic then owns — including the reference ranges, which this table has no
  // columns for and never supplies.
  lab_analyte_templates: {
    read:  { roles: ALL_STAFF, columns: ['id','code','name','category','unit','value_type','value_options','decimals','group_label','sort_order','active'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','code','category','value_type','active','name'],
    embed:   {},
  },

  // ─── Staff / RBAC / branch config (migration 026) ─────────────────────────
  // Dynamic RBAC roles (easymed's editable roles; separate from role_permissions).
  // admin.js, sections.js "Roles", section-crud.js, permissions.js. `permissions`
  // is the section_picker JSON blob. Config table → admin owns writes.
  roles: {
    read:  { roles: ALL_STAFF, columns: ['id','name','description','permissions','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['name','description','permissions','active'] },
             update: { roles: ['admin'], columns: ['name','description','permissions','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name'],
    embed:   {},
  },
  // User ↔ branch assignment junction. branch-context.js (selects `branches` embed),
  // employee-editor.js/cashier-shifts.js/consultation-types.js. Staff management → admin.
  user_branches: {
    read:  { roles: ALL_STAFF, columns: ['id','user_id','branch_id','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['user_id','branch_id'] },
             update: { roles: ['admin'], columns: ['user_id','branch_id'] },
             delete: { roles: ['admin'] } },   // save = delete this user's rows, re-insert the ticked set
    filters: ['id','user_id','branch_id'],
    embed:   { branches: { table:'branches', fk:'branch_id', columns:['id','name','active'] } },
  },
  // Doctor specialties junction. employee-editor.js, doctor-profile.js. Admin-managed.
  user_specialties: {
    read:  { roles: ALL_STAFF, columns: ['id','user_id','specialty_slug','name_ru','name_uz','is_primary','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['user_id','specialty_slug','name_ru','name_uz','is_primary'] },
             update: { roles: ['admin'], columns: ['specialty_slug','name_ru','name_uz','is_primary'] },
             delete: { roles: ['admin'] } },   // save = delete-then-insert reconcile
    filters: ['id','user_id','is_primary'],
    embed:   {},
  },
  // Job positions (config). sections.js "Positions", employee-editor.js. Admin config.
  positions: {
    read:  { roles: ALL_STAFF, columns: ['id','name','department_id','is_doctor','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['name','department_id','is_doctor','active'] },
             update: { roles: ['admin'], columns: ['name','department_id','is_doctor','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name','department_id','is_doctor'],
    embed:   {},
  },
  // Tele-medicine doctor profiles (parked catalog). sections.js "Virtual doctors". Admin config.
  virtual_doctors: {
    read:  { roles: ALL_STAFF, columns: ['id','user_id','specialty','consultation_fee','platforms','availability_note','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['user_id','specialty','consultation_fee','platforms','availability_note','active'] },
             update: { roles: ['admin'], columns: ['user_id','specialty','consultation_fee','platforms','availability_note','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','user_id','created_at'],
    embed:   {},
  },
  // Doctor's saved conditions / quick-picks. doctor-profile.js (doctor self-edit).
  // Doctor owns their own set (delete-then-insert); admin can also manage.
  doctor_conditions: {
    read:  { roles: ALL_STAFF, columns: ['id','doctor_id','kind','slug','name_ru','name_uz','created_at'] },
    write: { insert: { roles: ['admin','doctor'], columns: ['doctor_id','kind','slug','name_ru','name_uz'] },
             update: { roles: ['admin','doctor'], columns: ['kind','slug','name_ru','name_uz'] },
             delete: { roles: ['admin','doctor'] } },   // save = delete-then-insert reconcile
    filters: ['id','doctor_id','kind'],
    embed:   {},
  },
  // Clinic company / legal entity. sections.js "Companies", cash-shifts-store.js. Admin config.
  companies: {
    read:  { roles: ALL_STAFF, columns: ['id','name','legal_name','tax_id','license_number','director','phone',
             'email','website','logo_url','address','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['name','legal_name','tax_id','license_number','director','phone',
               'email','website','logo_url','address','active'] },
             update: { roles: ['admin'], columns: ['name','legal_name','tax_id','license_number','director','phone',
               'email','website','logo_url','address','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name'],
    embed:   {},
  },

  // ─── Reference / catalog tables (migration 027) ───────────────────────────
  // Mostly read-only dropdown sources. Writes are catalog config → admin only.
  // These ship empty; seeding reference rows is a separate follow-up.

  // Geography — patient-registration country→region→district cascade.
  // registration.js selects id/name filtered by active (+ parent FK for the
  // cascade); sections.js "Geography" maintains the catalog. No frontend embeds.
  countries: {
    read:  { roles: ALL_STAFF, columns: ['id','name','code','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['name','code','active'] },
             update: { roles: ['admin'], columns: ['name','code','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name','code'],
    embed:   {},
  },
  regions: {
    read:  { roles: ALL_STAFF, columns: ['id','country_id','name','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['country_id','name','active'] },
             update: { roles: ['admin'], columns: ['country_id','name','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name','country_id'],   // registration.js filters by country_id (cascade)
    embed:   {},
  },
  districts: {
    read:  { roles: ALL_STAFF, columns: ['id','region_id','name','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['region_id','name','active'] },
             update: { roles: ['admin'], columns: ['region_id','name','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name','region_id'],     // registration.js filters by region_id (cascade)
    embed:   {},
  },
  // Fiscal IKPU codes. sections.js "IKPU codes", section-import-export.js.
  ikpu_codes: {
    read:  { roles: ALL_STAFF, columns: ['id','code','name','group_code','unit','default_tax_rate','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['code','name','group_code','unit','default_tax_rate','active'] },
             update: { roles: ['admin'], columns: ['code','name','group_code','unit','default_tax_rate','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','code','name','group_code'],
    embed:   {},
  },
  // Marked-goods (NNM) catalogue, linked to an IKPU code. sections.js "Product NNM".
  product_nnm: {
    read:  { roles: ALL_STAFF, columns: ['id','nnm_code','name','ikpu_code_id','manufacturer','packaging','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['nnm_code','name','ikpu_code_id','manufacturer','packaging','active'] },
             update: { roles: ['admin'], columns: ['nnm_code','name','ikpu_code_id','manufacturer','packaging','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','nnm_code','name','manufacturer','ikpu_code_id'],
    embed:   {},
  },
  // Service category / direction tree (self-nesting). sections.js "Product categories".
  service_categories: {
    read:  { roles: ALL_STAFF, columns: ['id','code','name','parent_id','description','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['code','name','parent_id','description','active'] },
             update: { roles: ['admin'], columns: ['code','name','parent_id','description','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name','code','parent_id'],   // tree filters by parent_id
    embed:   {},
  },
  // ICD-10 diagnosis catalogue. service-workspace.js diagnosis picker (read-only in UI).
  icd10: {
    read:  { roles: ALL_STAFF, columns: ['id','code','name','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['code','name','active'] },
             update: { roles: ['admin'], columns: ['code','name','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','code','name'],
    embed:   {},
  },
  // Units of measure (unit-engine catalogue). procurement.js.
  units: {
    read:  { roles: ALL_STAFF, columns: ['id','code','name_ru','name_en','name_uz','kind','active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['code','name_ru','name_en','name_uz','kind','active'] },
             update: { roles: ['admin'], columns: ['code','name_ru','name_en','name_uz','kind','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','code','kind'],
    embed:   {},
  },
  // Subscription/price tariffs (read-only plan catalogue). upgrade-modal.js.
  // Uses is_active/visible_in_modal booleans (no `active` column).
  tariffs: {
    read:  { roles: ALL_STAFF, columns: ['id','key','display_name','tagline','price_monthly','currency','sort_order','visible_in_modal','is_active','created_at'] },
    write: { insert: { roles: ['admin'], columns: ['key','display_name','tagline','price_monthly','currency','sort_order','visible_in_modal','is_active'] },
             update: { roles: ['admin'], columns: ['key','display_name','tagline','price_monthly','currency','sort_order','visible_in_modal','is_active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','key','is_active','visible_in_modal','sort_order'],
    embed:   {},
  },
  // Reusable service-order templates (bundle of service ids). service-picker-modal.js.
  service_templates: {
    read:  { roles: ALL_STAFF, columns: ['id','name','service_ids','active','created_at'] },
    // WIZ_TEMPLATES_REGISTRAR_V1 — saving a смета as a template is done by the
    // role that builds the смета. Retiring one is an UPDATE (active = 0), which
    // is what the template list's «×» sends, so the registrar gets that too;
    // hard DELETE stays admin-only.
    write: { insert: { roles: ['admin','registrar'], columns: ['name','service_ids','active'] },
             update: { roles: ['admin','registrar'], columns: ['name','service_ids','active'] },
             delete: { roles: ['admin'] } },
    filters: ['id','active','name'],
    // service_ids is a JSON array of service ids in a TEXT column (mig 027).
    // Without this declaration bindWrite() never serialises it, bindable()
    // rejects the array with a 400, and «Сохранить как шаблон» fails for EVERY
    // role — admin included. On read it also parses the value back, so the
    // pickers receive the array they map over instead of the string "[1,2]"
    // (which Array.isArray() rejects, showing every template as «услуг: 0»).
    json:    ['service_ids'],
    embed:   {},
  },

  // ---------------------------------------------------------------------------
  // Procurement documents (migration 028) — single-warehouse model on `products`.
  // These are purchasing/counting PAPERWORK; they never move stock. Receiving a
  // PO, issuing a requisition, and posting a stock count all go through RPCs that
  // write stock_movements + products.on_hand — so on_hand can never desync.
  // ---------------------------------------------------------------------------
  suppliers: {
    read:  { roles: ALL_STAFF, columns: ['id','name','contact_name','phone','email','notes','active','created_at'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['name','contact_name','phone','email','notes','active'] },
             update: { roles: ['admin','inventory'], columns: ['name','contact_name','phone','email','notes','active'] },
             delete: { roles: [] } },   // retired via active=0, never removed (POs reference it)
    filters: ['id','active','name'],
    embed:   {},
  },
  item_suppliers: {
    read:  { roles: ALL_STAFF, columns: ['id','product_id','supplier_id','last_price','pack_factor','purchase_unit','created_at'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['product_id','supplier_id','last_price','pack_factor','purchase_unit'] },
             update: { roles: ['admin','inventory'], columns: ['last_price','pack_factor','purchase_unit'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','product_id','supplier_id'],
    embed:   { products:  { table:'products',  fk:'product_id',  columns:['id','name','base_unit'] },
               suppliers: { table:'suppliers', fk:'supplier_id', columns:['id','name'] } },
  },
  purchase_orders: {
    read:  { roles: ALL_STAFF, columns: ['id','po_number','supplier_id','status','order_date','expected_date','total','notes','created_by','created_at','received_at'] },
    // A PO is a purchasing DOCUMENT (no stock effect). Receiving it — the only
    // step that adds stock — is a Phase-2 RPC, not a write here.
    write: { insert: { roles: ['admin','inventory'], columns: ['po_number','supplier_id','status','order_date','expected_date','total','notes','created_by'] },
             update: { roles: ['admin','inventory'], columns: ['supplier_id','status','order_date','expected_date','total','notes','received_at'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','status','supplier_id'],
    embed:   { suppliers: { table:'suppliers', fk:'supplier_id', columns:['id','name'] },
               users:     { table:'users',     fk:'created_by',  columns:['id','full_name'] } },
  },
  purchase_order_items: {
    read:  { roles: ALL_STAFF, columns: ['id','po_id','product_id','qty_ordered','qty_received','unit_cost','line_total'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['po_id','product_id','qty_ordered','unit_cost'] },  // line_total is GENERATED
             update: { roles: ['admin','inventory'], columns: ['qty_ordered','unit_cost','qty_received'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','po_id','product_id'],
    embed:   { products: { table:'products', fk:'product_id', columns:['id','name','base_unit'] } },
  },
  purchase_requisitions: {
    read:  { roles: ALL_STAFF, columns: ['id','req_number','status','department_id','notes','reject_reason','requested_by','converted_po_id','created_at'] },
    // Any department head may raise a requisition; approving/issuing (the stock
    // move) and converting to a PO are Phase-2 RPCs.
    write: { insert: { roles: ['admin','inventory','doctor','nurse'], columns: ['req_number','status','department_id','notes','requested_by'] },
             update: { roles: ['admin','inventory'], columns: ['status','notes','reject_reason','converted_po_id'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','status','department_id','requested_by'],
    embed:   { departments: { table:'departments', fk:'department_id', columns:['id','name'] },
               users:       { table:'users',       fk:'requested_by',  columns:['id','full_name'] } },
  },
  purchase_requisition_items: {
    read:  { roles: ALL_STAFF, columns: ['id','req_id','product_id','qty','note'] },
    write: { insert: { roles: ['admin','inventory','doctor','nurse'], columns: ['req_id','product_id','qty','note'] },
             update: { roles: ['admin','inventory'], columns: ['qty','note'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','req_id','product_id'],
    embed:   { products: { table:'products', fk:'product_id', columns:['id','name','base_unit'] } },
  },
  stock_counts: {
    read:  { roles: ALL_STAFF, columns: ['id','count_number','status','note','counted_by','posted_at','created_at'] },
    // posted_at / status='posted' are set ONLY by the post_stock_count RPC (which
    // applies variances to on_hand) — hence not in the update column set.
    write: { insert: { roles: ['admin','inventory'], columns: ['count_number','status','note','counted_by'] },
             update: { roles: ['admin','inventory'], columns: ['status','note'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','status'],
    embed:   { users: { table:'users', fk:'counted_by', columns:['id','full_name'] } },
  },
  stock_count_items: {
    read:  { roles: ALL_STAFF, columns: ['id','count_id','product_id','system_qty','counted_qty','variance'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['count_id','product_id','system_qty','counted_qty'] },  // variance is GENERATED
             update: { roles: ['admin','inventory'], columns: ['counted_qty'] },
             delete: { roles: ['admin','inventory'] } },
    filters: ['id','count_id','product_id'],
    embed:   { products: { table:'products', fk:'product_id', columns:['id','name','base_unit'] } },
  },

  // ---------------------------------------------------------------------------
  // Patient history (migration 029). data.js / activity-log.js.
  // ---------------------------------------------------------------------------
  patient_relationships: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id_a','patient_id_b','relation_type','created_at'] },
    write: { insert: { roles: ['admin','registrar','doctor','nurse'], columns: ['patient_id_a','patient_id_b','relation_type'] },
             update: { roles: ['admin','registrar','doctor','nurse'], columns: ['relation_type'] },
             delete: { roles: ['admin','registrar','doctor','nurse'] } },
    filters: ['id','patient_id_a','patient_id_b'],
    embed:   {},
  },
  patient_activity_log: {
    read:  { roles: ALL_STAFF, columns: ['id','patient_id','visit_id','entity_type','entity_id','entity_label','action','summary','detail','actor_user_id','actor_name','actor_role','created_at'] },
    // Append-only audit trail: any role may record an event; nobody edits/deletes.
    write: { insert: { roles: ALL_STAFF, columns: ['patient_id','visit_id','entity_type','entity_id','entity_label','action','summary','detail','actor_user_id','actor_name','actor_role'] },
             update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','patient_id','visit_id','entity_type','action'],
    // colon-aliased embed: `users:actor_user_id(full_name, role)` — nests under `users`.
    embed:   { actor_user_id: { table:'users', fk:'actor_user_id', columns:['id','full_name','role'] } },
  },
};

export function tableEntry(t) { return Object.prototype.hasOwnProperty.call(REGISTRY, t) ? { table: t, ...REGISTRY[t] } : null; }
// MULTI_ROLE_SERVER_V1 — `role` is a single role name OR the caller's full
// effective set (primary + extra_roles). A grant to ANY role in the set allows
// the op: that is what «Дополнительные роли» means. An empty set allows nothing.
const asRoles = (role) => (Array.isArray(role) ? role : [role]);
export function canRead(t, role) { const e = REGISTRY[t]; return !!e && asRoles(role).some((r) => e.read.roles.includes(r)); }
export function canWrite(t, op, role) { const e = REGISTRY[t]; return !!e && !!e.write[op] && asRoles(role).some((r) => e.write[op].roles.includes(r)); }
export function readableColumns(t) { return REGISTRY[t] ? [...REGISTRY[t].read.columns] : []; }
export function writableColumns(t, op) { const e = REGISTRY[t]; return e && e.write[op] ? [...e.write[op].columns] : []; }
export function filterAllowed(t, col) { return !!REGISTRY[t] && REGISTRY[t].filters.includes(col); }
export function jsonColumns(t) { return (REGISTRY[t] && REGISTRY[t].json) ? [...REGISTRY[t].json] : []; }
export function embedEntry(t, name) {
  const e = REGISTRY[t];
  return e && Object.prototype.hasOwnProperty.call(e.embed, name) ? e.embed[name] : null;
}
