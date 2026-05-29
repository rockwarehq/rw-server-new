# @rw/automations

A small, domain-agnostic, event-driven automation engine: an **event** comes in, its **conditions**
are evaluated, and if they match, its **actions** run — sequentially, in one pass. Just-in-time and
in-process: no queue, no worker.

This package is the reusable **engine** only — no concrete event/action types. The consuming app
supplies its domain (schemas, fact builders, handlers, a store) and calls
`createAutomationFramework(config)`. Everything that varies is reached through a **seam** (an
interface swapped from outside the engine), so adding behavior never edits the engine.

## Consuming it

```ts
import { createAutomationFramework } from "@rw/automations";

const fw = createAutomationFramework({
  eventSchemas: EVENT_SCHEMAS,    // your domain
  actionSchemas: ACTION_SCHEMAS,  // your domain
  store,                          // your AutomationStore impl
  contextBuilders,                // Record<eventType, ContextBuilder> — must cover every event schema
  actions,                        // ActionRegistry of your handlers
  // refs, recorder — optional
});
```

The returned framework exposes `store`, `engine`, `catalog()`, `validateActionInputs()`,
`listRefOptions()`, and `fire()`. For a concrete consumer, see
[`apps/api/src/automations`](../../apps/api/src/automations/README.md).

## The seams

| Seam | Interface | What you swap |
| --- | --- | --- |
| event → facts | `ContextBuilder` | how an event becomes the fact map conditions read |
| what an action does | `ActionHandler` / `ActionRegistry` | the effect a matched automation runs |
| definition storage | `AutomationStore` | where automation definitions live |
| ref pickers | `RefSource` / `RefRegistry` | picker data for ref-typed action inputs |

## Raising an event

```ts
const { eventId, matched } = await fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_1" });
// matched → ids of automations whose conditions matched
```

`fire()` validates the payload, builds the event (`id` + `ts`, stamps `version`), dispatches it, and
runs every action of every matched automation in order. It **throws** on a bad payload, unknown
event type/version, or a misconfigured matched action (missing handler / missing required input) —
side effects of actions that already ran do not roll back. The one non-error empty case: an event
type with no automations returns `{ eventId, matched: [] }`.

Pass `{ version }` to raise a specific event version; defaults to the schema's `latest`.

## Versioning

Schemas and handlers carry a `latest` pointer and a `versions` map. Each `ActionVersion` is
`{ inputSchema, run }` — schema and behavior live together and can't drift. Old versions stay as
long as any automation pins them.

- **Action lookup is strict** — an automation pinned to an unknown action version throws at dispatch.
- **Event version at dispatch is lenient** — conditions evaluate against whatever payload was raised;
  the automation's `eventVersion` is informational/audit.
- `createAutomationFramework` validates at boot: every schema's `latest` exists, every declared
  action version has a registered handler, every `ref.source` is registered, every event type has a
  `ContextBuilder`.

You carry old handler versions until every automation pinned to them is migrated — set a sunset
policy early.

## Reload

Automations are indexed by event type up front: on boot and after every create/update/delete the
enabled automations are grouped and one condition engine is built per type via `engine.reload()`.
**Any `store.upsert`/`remove` must be followed by `engine.reload()`** or evaluation runs against
stale rules.


## Flow

 fire(type, payload) → validate & normalize payload → build event envelope → open audit run → flatten event to a fact map → run pre-compiled conditions → for each match, interpolate inputs + execute actions in order
 (auditing each) → finalize audit run (matches + status) → return.

  Three things worth remembering: it's synchronous, in-process, no queue — fire() returns only after all matched actions finish; and the audit run brackets the whole thing (opened before, closed after) so even no-match and
  failed fires are recorded. Currently not horizontally scaleable 


## Files

| File | What it does |
| --- | --- |
| `types.ts` | Pure contract/domain types (`Automation`, `AppEvent`, schemas, `Catalog`, …). |
| `query-builder-types.ts` | Vendored subset of react-querybuilder tree types, so the server reads conditions without the React lib. |
| `qb-to-engine.ts` | Converts the query-builder condition tree into json-rules-engine conditions + operator map. |
| `schema-to-zod.ts` | Derives Zod validators from catalog schemas. |
| `validate.ts` | `createValidators(schemas)` — validates action inputs and event payloads (cached). |
| `interpolate.ts` | Resolves `{{...}}` templates in action inputs at fire time. |
| `context.ts` | **Seam A.** `ContextBuilder` + the stateless builder that flattens an event into facts. |
| `actions.ts` | **Seam C.** `ActionHandler`, `ActionRegistry`, required-input check. |
| `store.ts` | `AutomationStore` interface (storage seam). Implementations live in the app. |
| `refs.ts` | `RefSource` / `RefRegistry` — picker data sources for ref-typed inputs. |
| `catalog.ts` | `buildCatalog(...)` — the editor catalog (fields, variables, operators) a UI renders from. |
| `engine.ts` | Evaluation core. Indexes automations per event type, builds a json-rules-engine per type, `dispatch()`. |
| `framework.ts` | `createAutomationFramework(config)` — assembles engine, validators, and `fire()`. |
| `index.ts` | Public barrel. |
