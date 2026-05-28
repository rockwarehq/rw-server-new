# @rw/triggers

A small, domain-agnostic, event-driven trigger engine: an **event** comes in, its
**conditions** are evaluated, and if they match, its **actions** run. Deliberately flat and
stateless — one event → one condition group → one or more actions run sequentially in a single
pass.

This package is the reusable **engine**. It contains no domain data (no concrete event types,
no actions). The consuming app supplies its domain — event/action schemas, fact builders, action
handlers, and a store — and calls `createTriggerFramework(config)`. The evaluation core never
changes; everything that *does* vary is reached through a **seam**.

## What "seam" means here

A **seam** is a place where the inputs and outputs stay fixed but the code behind them can be
swapped out — an interface whose concrete implementation is chosen from the *outside* rather than
hardcoded in the engine. Adding a new behavior = write a new implementation of the interface and
register it; the engine, ingestion, and validation are never edited. Contrast with a **branch**
(an inline `if`/`switch`): there the choice is baked into the code. Same input/output contract is
what makes the swap safe; the decision living *outside* the engine is what makes it a seam.

### The seams

| Seam | Interface | What you swap |
| --- | --- | --- |
| A — event → facts | `ContextBuilder` | how an event is turned into the fact map conditions read |
| B — event delivery | `IngestRuntime` | how events get into the engine (sync now; a queue later) |
| C — what an action does | `ActionHandler` / `ActionRegistry` | the effect a matched trigger runs |
| Definition storage | `TriggerStore` | where trigger definitions live (file mock, Prisma, …) |

## Consuming it

Supply your domain in one config object. This is the app's composition root:

```ts
import { createTriggerFramework } from "@rw/triggers";

const fw = createTriggerFramework({
  eventSchemas: EVENT_SCHEMAS,      // your domain
  actionSchemas: ACTION_SCHEMAS,    // your domain
  store,                            // your TriggerStore impl
  contextBuilders,                  // Record<eventType, ContextBuilder> — must cover every event schema
  actions,                          // ActionRegistry of your handlers
});
```

The returned framework exposes `store`, `engine`, `ingest`, `catalog()`,
`validateActionInputs()`, and `fire()`.

For a step-by-step guide that builds this config from scratch (declare schemas → write a handler →
wire → assemble → author → fire), see [`WALKTHROUGH.md`](./WALKTHROUGH.md).

## Error model

**One model: throw on every failure.** `fire()`, the validators, and the action runner all throw
`Error` when something is wrong — invalid payload, unknown event/action type, missing context
builder for a declared event type, missing action handler, missing required action input. On
success they return data, not a discriminated union. RPC layers convert thrown errors into HTTP
responses at the boundary (see `apps/api/src/rpc/triggers.ts` for the `BAD_REQUEST` mapping);
in-process callers `try`/`catch` if they want graceful handling.

The one path that *isn't* an error and *isn't* a throw: dispatching an event whose type has no
registered triggers. That's a legitimate empty result — `fire()` returns `{ eventId, matched: [] }`.

## Raising an event

Events are raised **in-process** — there is no HTTP endpoint. Wherever the app detects something
worth reacting to, call `fire(type, payload)`. It validates the payload against the event type's
schema, builds the event (generates `id` + `ts`), runs it through the engine, and returns
`{ eventId, matched }`. It throws on a bad payload, an unknown event type, or any matched trigger
whose action is misconfigured.

```ts
try {
  const { eventId, matched } = await fw.fire("job.changed", {
    previousJob: "J-100",
    currentJob: "J-200",
    station: "S-1",
  });
  // eventId → generated id (for tracing)
  // matched → ids of triggers whose conditions matched, e.g. ["trg_seed"]
} catch (err) {
  // bad payload, unknown event type, or misconfigured action (missing handler / missing input)
  log.warn(`fire failed: ${(err as Error).message}`);
}
```

`matched` means "every action of every matched trigger ran" — `fire()` only returns successfully
if all matched triggers' actions completed in sequence. A misconfigured action (no handler
registered, or a required input is empty) throws *during* dispatch, which aborts the loop; the
caller never gets `matched`. Actions that already ran before the throw produced their side effects;
those side effects don't roll back.

If you already have a fully-formed, trusted event (your own `id`/`ts`, already validated), skip
validation and submit straight to the ingest seam — this path does **not** validate, but
`runAction` will still throw on a misconfigured action:

```ts
await fw.ingest.submit({ id: "evt_1", type: "job.changed", ts: new Date().toISOString(), payload: {…} });
```

## How an event flows

Triggers are **indexed by event type up front**: on boot, and again after every
create/update/delete, the enabled triggers are grouped by event type and one condition engine is
built per type (`engine.reload()`). So at runtime "find the triggers for this event" is a lookup;
evaluation only decides which of that type's triggers *match*.

```
(1) fire(type, payload)
(2) validate payload vs the event type's schema ──✗──▶ throw Error            (validate.ts)
(3) build the event { id, type, ts, payload }                                 (framework.ts)
(4) look up the condition engine for this type ──none──▶ done (matched: [])   (engine.ts)
(5) build facts from the event (event ─▶ flat fact map)            SEAM A     (context.ts)
(6) evaluate conditions ─▶ the set of matched triggers                        (json-rules-engine)
(7) for each matched trigger, for each action on the trigger (in order):       SEAM C
       resolve handler, interpolate {{...}}, check required inputs, run it     (engine.ts /
       any failure here throws and aborts the loop                              actions.ts /
                                                                                interpolate.ts)
(8) return { eventId, matched }
```

Validation runs on the **event entry** in `fire()` and (via `validateActionInputs`) on the
**trigger write path** in the app. It does **not** run inside the engine: the runtime re-checks
only input *presence* (`missingRequired`), trusting that the event and trigger were validated on
the way in.

A concrete, value-by-value trace of one event lives in the consuming app's
[`WALKTHROUGH.md`](../../apps/api/src/triggers/WALKTHROUGH.md).

## Files

| File | What it does |
| --- | --- |
| `types.ts` | Pure contract/domain types shared everywhere (`Trigger`, `AppEvent`, schemas, `Catalog`, notifications). No logic. |
| `query-builder-types.ts` | Minimal vendored subset of react-querybuilder's tree types (`RuleGroupType` / `RuleType`), so the server reads conditions without depending on the React library. |
| `qb-to-engine.ts` | Converts the query-builder condition tree into json-rules-engine conditions; defines the operator map (`=` → `equal`, `contains` → `stringContains`, …). |
| `schema-to-zod.ts` | Derives Zod validators from catalog schemas, so validation falls out of the same declaration the editor uses. |
| `validate.ts` | `createValidators(schemas)` — validates action inputs and event payloads against the derived Zod schemas (built once and cached). |
| `interpolate.ts` | Resolves `{{...}}` template variables in action inputs at fire time (`event.payload.*`, `event.id`, `sys.timestamp`, …). |
| `context.ts` | **Seam A.** `ContextBuilder` interface + the stateless builder that flattens an event into the fact map. |
| `actions.ts` | **Seam C.** `ActionHandler` interface, `ActionRegistry`, and the required-input check. |
| `ingest.ts` | **Seam B.** `IngestRuntime` interface + `SyncIngestRuntime` (evaluates inline on the calling request). |
| `store.ts` | `TriggerStore` interface (the definition-storage seam). Implementations live in the consuming app. |
| `catalog.ts` | `buildCatalog(schemas, …)` — builds the editor catalog (fields, variables, operators) a UI renders from. |
| `engine.ts` | The evaluation core. Indexes enabled triggers per event type, builds a json-rules-engine per type, then `dispatch()` turns an event into facts, evaluates conditions, and runs the action of each matched trigger. |
| `framework.ts` | `createTriggerFramework(config)` — assembles the engine, ingestion, validators, and `fire()` from an app's domain config. |
| `index.ts` | Public barrel. |
