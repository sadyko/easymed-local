import assert from "node:assert";

// Mirror of setup-checklist.js + public-site.js predicate logic (kept in sync intentionally).
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
const BRANCH_PUBLISH_REQUIRED = ["Адрес", "Часы работы"];
function publishBlocked(dash) {
  return BRANCH_PUBLISH_REQUIRED.filter((l) => (dash.clinic_missing || []).includes(l)).length > 0;
}

assert.equal(companyComplete(null), false, "null company");
assert.equal(companyComplete({ name: "X" }), false, "name only");
assert.equal(companyComplete({ name: "X", phone: "1" }), false, "no address");
assert.equal(companyComplete({ name: "X", phone: "1", address: "A" }), true, "complete");
assert.equal(companyComplete({ name_ru: "Х", phone: "1", address: "A" }), true, "name_ru fallback");

assert.equal(branchProfileComplete(null, {}), false, "no dash");
assert.equal(branchProfileComplete({}, null), false, "no branch");
assert.equal(branchProfileComplete({ clinic_missing: [] }, { name: "B", district: "D" }), true, "complete");
assert.equal(branchProfileComplete({ clinic_missing: ["Адрес"] }, { name: "B", district: "D" }), false, "address missing");
assert.equal(branchProfileComplete({ clinic_missing: [] }, { name: "B" }), false, "no district");
assert.equal(branchProfileComplete({ clinic_missing: ["Часы работы"] }, { name_uz: "B", district: "D" }), false, "hours missing");

assert.equal(publishBlocked({ clinic_missing: [] }), false, "nothing missing -> not blocked");
assert.equal(publishBlocked({ clinic_missing: ["Адрес"] }), true, "address missing -> blocked");
assert.equal(publishBlocked({ clinic_missing: ["Телефон"] }), false, "non-core missing -> not blocked");
assert.equal(publishBlocked({}), false, "no clinic_missing -> not blocked");

console.log("setup-checklist predicates: all assertions passed");
