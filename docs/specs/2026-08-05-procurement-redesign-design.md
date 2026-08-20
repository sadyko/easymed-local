# Easy-Med Local — Procurement (Закупки) Redesign

Date: 2026-08-05
Status: approved by user (core-first scope, single stock pool, extend local view)

## Context

The local Закупки workspace (`public/js/admin/views/inventory.js`,
PROCUREMENT_WORKSPACE_V1) has only Dashboard / Product list / Audit log live,
with English labels and a layout that does not match cloud easymed.uz. The
user's requirement: **rebuild the workspace to match the cloud procurement
design** (reference: `Procurement/Easy-doctor Procurement.html` and the parked
cloud view `public/js/admin/views/procurement.js`) — Склад stock table with
filters, Excel import/export, Принять / Выдать / Корректировка actions,
reorder flags, plus Товары and Поставщики tabs.

## Decisions (made with user)

1. **Scope — core first.** Phase 1 (this spec): Склад tab fully working +
   Товары + Поставщики + Журнал + Дашборд. Заявки, Заказы на закупку,
   Отделения, Сроки годности, Инвентаризация are visible placeholders
   («Во 2-й фазе») and ship in a later phase.
2. **Stock — single warehouse pool.** One quantity per product
   (`products.on_hand`). Выдать records the recipient in the movement journal
   but keeps no per-department balance (that arrives with Отделения in
   phase 2). No `stock_locations` / `item_stock` tables now.
3. **Build — extend the local view.** The existing `inventory.js` is the base;
   the screenshot design is hand-built on it. The 5,300-line cloud
   `procurement.js` stays parked as a design/behavior reference only.

## User-facing behavior

### Page layout (matches the cloud screenshot)

- Page head «Закупки» + subtitle «Остатки, поставщики и заказы на закупку —
  по всем филиалам клиники». All labels Russian.
- Toolbar chips (top right): **Дашборд** (existing dashboard content),
  **Отделения**, **Сроки годности**, **Инвентаризация** (placeholder pane
  «Во 2-й фазе»), **Журнал** (existing audit log, relabeled «Журнал
  движений»), **Обновить** (refetch + repaint).
- Tabs: **Склад** (default, new) · **Заявки** (placeholder) · **Заказы на
  закупку** (placeholder) · **Товары** (existing Product list, restyled RU) ·
  **Поставщики** (new).

### Склад tab

Columns:

| Column        | Source                                                        |
|---------------|---------------------------------------------------------------|
| Product       | `products.name`                                               |
| Единица       | `products.base_unit`                                          |
| Поставщик     | primary supplier name via `products.supplier_id`, «—» if none |
| В наличии     | `on_hand` (red ⚠ icon when `on_hand ≤ reorder_level`)         |
| Выдать        | `on_hand × consumption_factor` + consumption unit (falls back to base unit when no consumption unit is set) |
| Себестоимость | `avg_cost`                                                    |
| Стоимость     | `on_hand × avg_cost`                                          |
| Flag          | tag: **Reorder** (red) when `on_hand ≤ reorder_level`, else **OK** (green) |
| (action)      | **Заказать** button — rendered but disabled in phase 1, tooltip «Заказы на закупку — во 2-й фазе» |

Filter row under the header: text search (name), unit dropdown («Все ед.»),
supplier dropdown («Все поставщики»), availability dropdown (Все / В наличии
`on_hand > 0` / Заканчивается `0 < on_hand ≤ reorder_level` / Нет в наличии
`on_hand = 0`), flag dropdown (Все / OK / Reorder). All filters client-side
over the fetched list.

Table toolbar: **Excel** (export the currently filtered rows to .xlsx via the
vendored `xlsx-0.20.3` lib), **Шаблон** (download the import template .xlsx),
**Импорт из Excel** (bulk add/receive — below), **Выдать** (issue modal),
**Корректировка** (existing adjust flow, restyled RU), **Принять** (existing
multi-line receive flow, restyled RU).

### Выдать (issue without a visit)

Modal: one or more product lines (search picker), quantity in issue
(consumption) units, recipient — a department from `departments` or free-text
name — and an optional note. Posts RPC `issue_stock_lines`. Insufficient
stock is rejected server-side and shown as a toast.

### Импорт из Excel

Шаблон columns: Название*, Единица (→ `base_unit`), Кол-во, Себестоимость,
Мин. остаток (→ `reorder_level`), Поставщик. Client parses the workbook (vendored xlsx), shows a preview with
row count, then posts rows to RPC `import_products_excel`. Matching is by
exact product name: existing products are updated (unit/reorder
level/supplier), missing ones are created; a positive Кол-во is recorded as a
`receive` movement at the given cost with weighted-average costing. The whole
import is one transaction — a bad row aborts everything and the toast names
the failing row number.

### Товары tab

The existing Product list stays (catalog CRUD, receive/adjust entry points),
relabeled Russian; the product form gains a «Поставщик» select
(`supplier_id`). `on_hand` / `avg_cost` remain read-only in the form — they
change only through RPCs.

### Поставщики tab

Simple CRUD list (modal form, same chrome as other views): name*, contact
person, phone, note, active. Deactivated suppliers stay on past records but
leave the pickers.

### Журнал

Existing audit tab relabeled «Журнал движений»: Когда / Товар / Тип /
Кол-во / Основание / Кто, with type filter and product search. Issue
movements show the recipient from the note.

## Data model — migration `017_suppliers.sql`

```sql
CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
```

- One primary supplier per product (plain FK). The cloud's `item_suppliers`
  many-to-many with price history is out of scope.
- Schema-registry: new `suppliers` entry (read: all staff roles; insert/update:
  admin; delete: nobody — deactivate instead); `products` gains `supplier_id`
  in read/insert/update columns and a `suppliers` embed.
- Per-migration test `017.test.js` (pattern of 002–016 tests).

## RPCs (`server/services/rpc/procurement.js`)

- **`issue_stock_lines(lines, recipient, note)`** — multi-line issue.
  Converts issue units → base units via `consumption_factor`, validates every
  line has sufficient `on_hand` (no negative stock), then in one transaction
  decrements `on_hand` and writes `stock_movements` kind `dispense`,
  `reference_type 'issue'`, recipient recorded in the note.
- **`import_products_excel(rows)`** — one transaction: per row, match product
  by exact name → update catalog fields, or create; positive quantity becomes
  a `receive` movement with weighted-average `avg_cost` update (same math as
  `receive_stock_lines`). Any invalid row throws with its row number; nothing
  partial is committed. Unknown supplier names are created as new suppliers.
- Existing `receive_stock_lines` / `adjust_stock` are reused unchanged by
  Принять / Корректировка.

## Enforcement level

As in every converted module: the compat layer's allow-list is the security
boundary; `on_hand` and `avg_cost` are never writable via `/api/db` — only
via the RPCs above. Role access for the workspace is unchanged (sidebar id
`inventory`) and stays configurable through the Roles editor.

## Error handling

- All failures surface as toasts (existing pattern).
- Issue: insufficient stock → per-line server error naming the product.
- Import: first invalid row aborts the transaction; toast shows row number
  and reason.
- Export/Шаблон are client-side; no server state involved.

## Testing

- `017.test.js` — migration/schema test.
- RPC tests beside `procurement.test.js`: `issue_stock_lines` (unit
  conversion, insufficient stock rejected, multi-line atomicity, journal row
  shape) and `import_products_excel` (create + update paths, receive
  movement + avg-cost math, bad-row abort leaves DB untouched, new supplier
  auto-created).
- Manual smoke: download Шаблон → fill → import → products appear with stock
  and supplier → Склад filters/flags/export behave like the screenshot →
  Выдать to a department decrements stock and shows in Журнал → Корректировка
  and Принять still work.

## Out of scope (YAGNI / phase 2)

- Заявки (requisitions), Заказы на закупку (purchase orders) and the live
  Заказать button.
- Отделения (per-department balances), Сроки годности (batches/FEFO),
  Инвентаризация (stock counts) — chips render a placeholder.
- Multi-supplier price lists (`item_suppliers`), batch tracking, per-branch
  stock.

## Success criteria

1. Закупки opens on a Russian Склад table visually matching the cloud
   screenshot: filters, ⚠ low-stock marks, OK/Reorder flags, Excel
   export/import, Принять / Выдать / Корректировка all functional.
2. A stock issue to a department decrements `on_hand`, appears in Журнал with
   recipient, and can never drive stock negative.
3. Excel import creates/updates products, records opening stock with correct
   weighted-average cost, and is all-or-nothing.
4. Поставщики CRUD works and the chosen supplier shows on Склад and in the
   product form.
5. Existing flows (visit dispensing, receive, adjust, reports) are unaffected;
   all current tests still pass.
