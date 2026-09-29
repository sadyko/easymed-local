-- ROLES_SAVE_TRUTH_V1 (2026-09-29) — «ПРОВЕРЬТЕ ПРАВА ЭТОЙ РОЛИ»: ПРАВА ВЫШЕ ОБЫЧНЫХ ДЛЯ ОСНОВЫ.
--
-- ЧТО СЛУЧИЛОСЬ. Экран «Роли» рисовал у ключа, который роль не настраивала,
-- СВОЮ ДОГАДКУ из старой галочки раздела («раздел выдан — внутри всё»), а
-- «Сохранить роль» писал матрицу целиком. Первое же сохранение — даже без единой
-- правки — превращало догадку в настоящее право: на копии данных оператор
-- колл-центра получил crm.all и читал чужую заявку, регистратура — измерения,
-- назначения, отметки и выписку стационара (admission_vitals_add 403 → 200).
-- С этого выпуска экран показывает правду сервера и пишет только тронутое
-- (docs/specs/2026-09-29-roles-save-truth-design.md), но роли, сохранённые
-- раньше, уже могут нести такие права.
--
-- ПОЧЕМУ НЕ ИСПРАВЛЯЕМ САМИ. Право, выданное экраном, и право, выданное
-- нарочно, в базе выглядят одинаково. Поэтому права здесь НЕ меняются: пары
-- (роль, ключ), где записанный уровень СТАРШЕ стандарта основы, записываются в
-- role_grant_reviews, а экран «Роли» показывает такую роль с плашкой
-- «Проверьте права этой роли» и выбором «Убрать эти права» или «Оставить как
-- есть» (public/js/admin/views/roles-grant-review.js).
--
-- СТАНДАРТ ОСНОВЫ — уровень, который ворота ключа дают роли по списку ролей в
-- коде (server/services/gate-fallbacks.js fallbackLevel, режим 'all': у уровня
-- с несколькими воротами засчитан тот, что пускают ВСЕ). Ключи — все строки
-- GATE_FALLBACK; основы — штатные роли без администратора. Таблица собрана по
-- самим воротам, и тест 230.test.js сверяет её с fallbackLevel для каждой
-- основы × ключа: разойтись молча они не могут.
--
-- Администратор и свои роли на его основе пропускаются: у администратора
-- стандарт — всё. Своя роль клиники сверяется со своей основой. Уровень, не
-- являющийся строкой уровня ('admin', число), выше стандарта не считается — так
-- его читают и ворота (grants.js grantLevel). Повторный накат ничего не
-- добавляет (INSERT OR IGNORE) и принятых решений не сбрасывает.
CREATE TABLE IF NOT EXISTS role_grant_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT NOT NULL,
  key         TEXT NOT NULL,
  level       TEXT NOT NULL,
  standard    TEXT NOT NULL,
  found_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolution  TEXT CHECK (resolution IS NULL OR resolution IN ('restored', 'kept')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  UNIQUE (role, key)
);

WITH standards(base, key, standard) AS (VALUES
  ('registrar', 'inpatient.services', 'view'),
  ('registrar', 'inpatient.history', 'view'),
  ('registrar', 'inpatient.patients', 'none'),
  ('registrar', 'inpatient.reviews', 'none'),
  ('registrar', 'inpatient.discharge', 'none'),
  ('registrar', 'inpatient.beds', 'edit'),
  ('registrar', 'inpatient.requests', 'edit'),
  ('registrar', 'inpatient.prescriptions', 'none'),
  ('registrar', 'inpatient.marks', 'none'),
  ('registrar', 'inpatient.vitals', 'none'),
  ('registrar', 'procurement.issue', 'none'),
  ('registrar', 'crm.dial', 'edit'),
  ('registrar', 'crm.calls', 'view'),
  ('registrar', 'crm.recording', 'edit'),
  ('registrar', 'crm.all', 'none'),
  ('registrar', 'crm.convert', 'edit'),
  ('doctor', 'inpatient.services', 'edit'),
  ('doctor', 'inpatient.history', 'view'),
  ('doctor', 'inpatient.patients', 'view'),
  ('doctor', 'inpatient.reviews', 'edit'),
  ('doctor', 'inpatient.discharge', 'none'),
  ('doctor', 'inpatient.beds', 'none'),
  ('doctor', 'inpatient.requests', 'edit'),
  ('doctor', 'inpatient.prescriptions', 'delete'),
  ('doctor', 'inpatient.marks', 'view'),
  ('doctor', 'inpatient.vitals', 'edit'),
  ('doctor', 'procurement.issue', 'none'),
  ('doctor', 'crm.dial', 'none'),
  ('doctor', 'crm.calls', 'none'),
  ('doctor', 'crm.recording', 'none'),
  ('doctor', 'crm.all', 'none'),
  ('doctor', 'crm.convert', 'none'),
  ('cashier', 'inpatient.services', 'view'),
  ('cashier', 'inpatient.history', 'view'),
  ('cashier', 'inpatient.patients', 'none'),
  ('cashier', 'inpatient.reviews', 'none'),
  ('cashier', 'inpatient.discharge', 'none'),
  ('cashier', 'inpatient.beds', 'none'),
  ('cashier', 'inpatient.requests', 'none'),
  ('cashier', 'inpatient.prescriptions', 'none'),
  ('cashier', 'inpatient.marks', 'none'),
  ('cashier', 'inpatient.vitals', 'none'),
  ('cashier', 'procurement.issue', 'none'),
  ('cashier', 'crm.dial', 'none'),
  ('cashier', 'crm.calls', 'none'),
  ('cashier', 'crm.recording', 'none'),
  ('cashier', 'crm.all', 'none'),
  ('cashier', 'crm.convert', 'none'),
  ('lab', 'inpatient.services', 'none'),
  ('lab', 'inpatient.history', 'none'),
  ('lab', 'inpatient.patients', 'none'),
  ('lab', 'inpatient.reviews', 'none'),
  ('lab', 'inpatient.discharge', 'none'),
  ('lab', 'inpatient.beds', 'none'),
  ('lab', 'inpatient.requests', 'none'),
  ('lab', 'inpatient.prescriptions', 'none'),
  ('lab', 'inpatient.marks', 'none'),
  ('lab', 'inpatient.vitals', 'none'),
  ('lab', 'procurement.issue', 'none'),
  ('lab', 'crm.dial', 'none'),
  ('lab', 'crm.calls', 'none'),
  ('lab', 'crm.recording', 'none'),
  ('lab', 'crm.all', 'none'),
  ('lab', 'crm.convert', 'none'),
  ('nurse', 'inpatient.services', 'edit'),
  ('nurse', 'inpatient.history', 'view'),
  ('nurse', 'inpatient.patients', 'view'),
  ('nurse', 'inpatient.reviews', 'view'),
  ('nurse', 'inpatient.discharge', 'edit'),
  ('nurse', 'inpatient.beds', 'edit'),
  ('nurse', 'inpatient.requests', 'none'),
  ('nurse', 'inpatient.prescriptions', 'view'),
  ('nurse', 'inpatient.marks', 'edit'),
  ('nurse', 'inpatient.vitals', 'edit'),
  ('nurse', 'procurement.issue', 'none'),
  ('nurse', 'crm.dial', 'none'),
  ('nurse', 'crm.calls', 'none'),
  ('nurse', 'crm.recording', 'none'),
  ('nurse', 'crm.all', 'none'),
  ('nurse', 'crm.convert', 'none'),
  ('inventory', 'inpatient.services', 'none'),
  ('inventory', 'inpatient.history', 'none'),
  ('inventory', 'inpatient.patients', 'none'),
  ('inventory', 'inpatient.reviews', 'none'),
  ('inventory', 'inpatient.discharge', 'none'),
  ('inventory', 'inpatient.beds', 'none'),
  ('inventory', 'inpatient.requests', 'none'),
  ('inventory', 'inpatient.prescriptions', 'none'),
  ('inventory', 'inpatient.marks', 'none'),
  ('inventory', 'inpatient.vitals', 'none'),
  ('inventory', 'procurement.issue', 'edit'),
  ('inventory', 'crm.dial', 'none'),
  ('inventory', 'crm.calls', 'none'),
  ('inventory', 'crm.recording', 'none'),
  ('inventory', 'crm.all', 'none'),
  ('inventory', 'crm.convert', 'none'),
  ('callcenter', 'inpatient.services', 'none'),
  ('callcenter', 'inpatient.history', 'none'),
  ('callcenter', 'inpatient.patients', 'none'),
  ('callcenter', 'inpatient.reviews', 'none'),
  ('callcenter', 'inpatient.discharge', 'none'),
  ('callcenter', 'inpatient.beds', 'none'),
  ('callcenter', 'inpatient.requests', 'none'),
  ('callcenter', 'inpatient.prescriptions', 'none'),
  ('callcenter', 'inpatient.marks', 'none'),
  ('callcenter', 'inpatient.vitals', 'none'),
  ('callcenter', 'procurement.issue', 'none'),
  ('callcenter', 'crm.dial', 'edit'),
  ('callcenter', 'crm.calls', 'view'),
  ('callcenter', 'crm.recording', 'edit'),
  ('callcenter', 'crm.all', 'none'),
  ('callcenter', 'crm.convert', 'edit'),
  ('head_doctor', 'inpatient.services', 'edit'),
  ('head_doctor', 'inpatient.history', 'view'),
  ('head_doctor', 'inpatient.patients', 'view'),
  ('head_doctor', 'inpatient.reviews', 'edit'),
  ('head_doctor', 'inpatient.discharge', 'edit'),
  ('head_doctor', 'inpatient.beds', 'edit'),
  ('head_doctor', 'inpatient.requests', 'edit'),
  ('head_doctor', 'inpatient.prescriptions', 'delete'),
  ('head_doctor', 'inpatient.marks', 'view'),
  ('head_doctor', 'inpatient.vitals', 'edit'),
  ('head_doctor', 'procurement.issue', 'none'),
  ('head_doctor', 'crm.dial', 'none'),
  ('head_doctor', 'crm.calls', 'none'),
  ('head_doctor', 'crm.recording', 'none'),
  ('head_doctor', 'crm.all', 'none'),
  ('head_doctor', 'crm.convert', 'none'),
  ('senior_nurse', 'inpatient.services', 'edit'),
  ('senior_nurse', 'inpatient.history', 'view'),
  ('senior_nurse', 'inpatient.patients', 'view'),
  ('senior_nurse', 'inpatient.reviews', 'view'),
  ('senior_nurse', 'inpatient.discharge', 'edit'),
  ('senior_nurse', 'inpatient.beds', 'edit'),
  ('senior_nurse', 'inpatient.requests', 'edit'),
  ('senior_nurse', 'inpatient.prescriptions', 'view'),
  ('senior_nurse', 'inpatient.marks', 'edit'),
  ('senior_nurse', 'inpatient.vitals', 'edit'),
  ('senior_nurse', 'procurement.issue', 'none'),
  ('senior_nurse', 'crm.dial', 'none'),
  ('senior_nurse', 'crm.calls', 'none'),
  ('senior_nurse', 'crm.recording', 'none'),
  ('senior_nurse', 'crm.all', 'none'),
  ('senior_nurse', 'crm.convert', 'none'),
  ('head_cashier', 'inpatient.services', 'none'),
  ('head_cashier', 'inpatient.history', 'none'),
  ('head_cashier', 'inpatient.patients', 'none'),
  ('head_cashier', 'inpatient.reviews', 'none'),
  ('head_cashier', 'inpatient.discharge', 'none'),
  ('head_cashier', 'inpatient.beds', 'none'),
  ('head_cashier', 'inpatient.requests', 'none'),
  ('head_cashier', 'inpatient.prescriptions', 'none'),
  ('head_cashier', 'inpatient.marks', 'none'),
  ('head_cashier', 'inpatient.vitals', 'none'),
  ('head_cashier', 'procurement.issue', 'none'),
  ('head_cashier', 'crm.dial', 'none'),
  ('head_cashier', 'crm.calls', 'none'),
  ('head_cashier', 'crm.recording', 'none'),
  ('head_cashier', 'crm.all', 'none'),
  ('head_cashier', 'crm.convert', 'none')
),
roles AS (
  SELECT rp.role AS role, COALESCE(cr.base_role, rp.role) AS base, rp.permissions AS permissions
    FROM role_permissions rp
    LEFT JOIN custom_roles cr ON cr.code = rp.role
)
INSERT OR IGNORE INTO role_grant_reviews (role, key, level, standard)
SELECT r.role, s.key, json_extract(r.permissions, '$.grants."' || s.key || '"'), s.standard
  FROM roles r
  JOIN standards s ON s.base = r.base
 WHERE r.role <> 'admin' AND r.base <> 'admin'
   AND json_valid(r.permissions)
   AND json_type(r.permissions, '$.grants."' || s.key || '"') = 'text'
   AND (CASE json_extract(r.permissions, '$.grants."' || s.key || '"')
          WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'delete' THEN 3 ELSE 0 END)
     > (CASE s.standard WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'delete' THEN 3 ELSE 0 END);
