// BRANCH_PROFILE_V1 · CLINIC_API_STEP7_V1 (ревью слияния шага 7 №3) — КАКИЕ СТРОКИ
// branches ПРАВИТ ЗАПРОС /api/db. Одна функция на двух стражей: правило «одно место
// адреса на здание» шага 4 (routes/db.js branchWriteRefusal) и решение владельца 11
// по зданиям (services/api/partner-address.js branchAddressRefusal). Раньше у
// второго был свой разбор отбора, и «in» строкой «(5)» превращался в [NaN] — страж
// не проверял ни одной строки, а компилятор такой отбор принимает.
//
// Отбор только по id (eq / in массивом — так пишут экраны; правку без выбора строк
// компилятор не пускает сам) — строки этих id. Что-то иное — null: какие строки
// правятся, заранее не известно, и тогда страж судит так, будто правятся все:
//   • отбор не по id или не eq / in;
//   • «in» не массивом (PostgREST-строка «(5)»);
//   • id, который не число (Number(...) = NaN).
// Этот файл — сервер, без express: его можно звать из любого стража.
export function targetBranches(db, body) {
  const f = body && Array.isArray(body.filters) ? body.filters : [];
  let ids = null;
  for (const x of f) {
    if (!x || x.col !== 'id' || (x.op !== 'eq' && x.op !== 'in')) return null;
    if (x.op === 'in' && !Array.isArray(x.val)) return null;
    const list = (x.op === 'in' ? x.val : [x.val]).map(Number);
    if (list.some((i) => Number.isNaN(i))) return null;   // CLINIC_API_STEP7_V1 (ревью слияния №3)
    ids = ids == null ? list : ids.filter((i) => list.includes(i));
  }
  if (ids == null) return null;
  const one = db.prepare('SELECT * FROM branches WHERE id = ?');
  return [...new Set(ids)].map((i) => one.get(i)).filter(Boolean);
}
