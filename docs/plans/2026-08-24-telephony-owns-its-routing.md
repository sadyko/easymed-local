# Plan: each source owns its own routing — move «Звонки → карточки» into Телефония

Owner's correction (2026-08-24), after seeing the first version:

> "crm kanban structure + design — the columns (created, edited name), added leads
> based off a source and status of the lead. for example: telephony gives
> unanswered lead → kanban decides where its goes in the kanban. telephony is
> located in the system settings menu section, inside of the sources, where its
> shows the statuses given by binotel (**not written but fetched** from the binotel
> api or connection) and the other settings of the binotel is set up"

Two changes, one of them a real correction to the model I built.

## 1. The routing table moves out of CRM settings into Телефония

**Why the owner is right.** The mapping is not a property of the kanban — it is a
property of *that source*. Binotel has dispositions; a website form will have its
own outcomes; Instagram has none at all. Putting every source's rules in one CRM
screen means that screen grows a section per integration and none of them are where
you configured the integration itself. Each source configures its own routing, on
its own page, next to its own credentials.

- **Настройки → Системные настройки → CRM-канбан** keeps: the columns (add, rename,
  recolour, reorder, hide) and the list of sources. That is the board's structure —
  nothing else.
- **Настройки → Системные настройки → Телефония** gains a card «Звонки → заявки»:
  for each call outcome Binotel reports, create a lead or not, and into which column.
  It sits under the existing connection/polling cards, because it is meaningless
  until the connection works.

Mechanically this is a UI move only: `crm_call_routing`, the RPCs and
`lead-from-call.js` are unchanged and already keyed by `provider` — which is exactly
what makes per-source ownership natural.

## 2. Statuses are DISCOVERED, not typed

Today the 15 dispositions are a static seed from the vendor docs. The owner is right
that this is fragile: the documented list is what Binotel published in 2024, not what
this clinic's PBX actually reports.

Binotel has no "list every possible disposition" endpoint (checked the archived API
docs: `stats/*` return calls, not vocabularies). So "fetched from the connection"
means, honestly:

- **Observed** — `SELECT DISTINCT disposition FROM calls`, i.e. what this clinic's own
  PBX has actually sent. This is the real answer to "what statuses do we get?" and it
  needs no new API call.
- **Documented** — the seeded vendor list, shown as the baseline so a rule can be set
  for an outcome *before* it happens for the first time.

The card shows both, marked: a row Binotel has actually sent carries a count («15
звонков»), one only from the docs is dimmed («ещё не встречалось»). A disposition that
arrives and matches no rule creates nothing and appears in the list on the next load,
so the owner is never silently missing a rule — a NEW row is badged «новое».

`telephony_dispositions` (new RPC, or extra field on `telephony_settings_get`):
returns `[{disposition, seen_count, last_seen_at, documented}]` merged from the two
sources above, plus the current rule for each.

## Also fix (found while reviewing the first version)

- **Inputs and selects had no styling at all.** `admin.html` loads no base rule for
  them — `local.css`'s input styling belongs to the LOGIN page and is never loaded in
  the app. Every field on the new screen rendered as a raw browser box. Fixed with a
  scoped `.crm-set-card input/select` block, the same way `.np-grid` and `.tp-input`
  do it. The same block is needed for the telephony card that receives the routing UI.
- **Enter did not submit** the «Добавить колонку» field.

## Tasks

1. Styling + Enter (done inline — small, blocks nothing).
2. Move the routing card into `views/telephony-settings.js`; delete it from
   `views/crm-settings.js`; keep both screens' tests honest.
3. `telephony_dispositions` server-side: observed ∪ documented, with counts.
4. The card renders observed-vs-documented, badges unseen/new, and saves through the
   existing `crm_config_save {routing}`.
