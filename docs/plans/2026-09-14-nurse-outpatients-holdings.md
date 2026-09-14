# Plan: the nurse's «Амбулаторные» tab, and stock that is counted once

Owner (2026-09-14):

> "in the #mar-nurse we need to create one tab for patients in the ambulatory.
> there will be list, and nurses can dispense items which is dispensed from the
> procurement either to the nurse or either to the cabinet or to the department.
> please inspect that flow too, so it will work seamlessly."

## What was wrong with the flow

«Склад → Выдать» (`issue_stock_lines`) deducted `products.on_hand` and wrote the
recipient as free text in the movement note — and the trail ended there. When the
nurse later gave the same item to a patient (`dispense_item` from the visit,
`dispense_admission_item` from the ward, or a MAR dose with a stock item) the
warehouse was deducted **again**. One pack left the stock twice, and nobody could
say where it actually was.

## The model (migration 128, `stock_holdings`)

Every recipient — an employee, a room, a department — has its own balance per
product, in base units like the warehouse. An issue **moves** stock (warehouse −,
holder +). A dispense from a holding takes from the holder and leaves the
warehouse alone. Warehouse + holders = everything bought and not yet used.
`stock_movements` gained `holder_type`/`holder_id` so the journal says where a
quantity went or came from.

- `issue_stock_lines` accepts `holder: {type, id}` (the «Выдать» dialog now picks
  «Сотруднику / В кабинет / В отделение» + who); a free-text recipient without a
  holder is still a plain write-off, as before.
- `holdings_list`, `dispense_from_holding` (visit or admission; billed per
  consumption unit at sale price ÷ factor; «в счёт» off → line at zero),
  `void_holding_dispense` (back to the same holder), `outpatients_today`,
  `visit_items`.
- **Ward doses**: `dispense_admission_item(prefer_holdings)` — used by the MAR
  when a dose is marked given — takes the nurse's own stock first, then her
  ward's department, then the warehouse; a void goes back to the same source.
  The ward console's own «выдать» dialog still takes from the warehouse
  (unchanged; a source choice there is a follow-up).

## The screen

Задачи медсестры gains two tabs: **Стационар** (unchanged) and **Амбулаторные**.
The new tab keeps the same anatomy: today's outpatient visits on the left (time ·
card № · doctor · «выдано: n»), the chosen patient on the right — name anchor,
red allergy banner, «Выдано на этом визите» (with «Отменить» on un-invoiced lines
given from a holding), and «Выдать пациенту»: source (Мои запасы / Кабинет: … /
Отделение: … — only what has stock; other people's personal stock is never
offered), product with what's left, quantity in the consumption unit, «В счёт
пациента». What is given becomes a visit line the cashier sees.

## Not in this step

- A «Кто что держит» view for the warehouse keeper (holdings are visible today
  only to the nurse on her tab and in the journal's holder columns).
- Source choice in the ward console's own dispense dialog.
