# Triggers — app composition root

This folder is **this app's domain + wiring** for the trigger framework. The reusable engine
(event → conditions → action, the seams, validation, interpolation) lives in the
[`@rw/triggers`](../../../../packages/triggers/README.md) package — start there for the seam model,
the `fire()` contract, and how an event flows through the engine (and its
[`WALKTHROUGH.md`](../../../../packages/triggers/WALKTHROUGH.md) for wiring the engine into a new app).

Everything here is what makes the engine *this app's*: the concrete event/action **schemas**, the
**handlers** that do real work, the **fact builders**, the **store**, and the call that assembles
them into the engine.

## The split

```
@rw/triggers (package)            apps/api/src/triggers (this folder)
─────────────────────             ───────────────────────────────────
engine, ingestion, validation,    EVENT_SCHEMAS / ACTION_SCHEMAS  (catalog.ts)
interpolation, catalog builder,   sendAlert handler              (actions.ts)
seam interfaces, fire()           event→builder / handler wiring (registry.ts)
                                  seed + file-backed store mock  (store.ts)
   createTriggerFramework(cfg) ◀──── createAppTriggerFramework() (index.ts)
```

The dependency only points one way: this folder imports from `@rw/triggers`; the package never
imports app code. That boundary is what keeps the engine reusable.

## Files

| File | What it does |
| --- | --- |
| `catalog.ts` | This app's event + action **schemas** (`EVENT_SCHEMAS`, `ACTION_SCHEMAS`) and the editor defaults. The single source of truth the engine validates against and the UI renders from. |
| `actions.ts` | The `sendAlert` **handler** (Seam C) — the example effect (logs the alert). A real `sendEmail`/`createForm` handler would look like this. |
| `registry.ts` | Maps each event type to its `ContextBuilder` and registers the action handlers. The one place to edit when adding an event or action type. |
| `store.ts` | A MOCK file-backed `TriggerStore` (persists triggers to JSON for dev) + the seed trigger. Swap for a `@rw/db`-backed store later; nothing else changes. |
| `index.ts` | Composition root — `createAppTriggerFramework()` feeds the above into `@rw/triggers`' `createTriggerFramework()`, and `getTriggerFramework()` is the shared singleton the oRPC layer uses. |

## Raising an event

In-process only — no HTTP endpoint. Get the shared framework and call `fire(type, payload)`. It
throws on a bad payload, an unknown event type, or any misconfigured matched action:

```ts
import { getTriggerFramework } from "./triggers/index.js";

// e.g. inside the code path that persists a job change
const fw = getTriggerFramework();
try {
  const { eventId, matched } = await fw.fire("job.changed", {
    previousJob: "J-100",
    currentJob: "J-200",
    station: "S-1",
  });
  // eventId → generated event id (for tracing); matched → matched trigger ids
} catch (err) {
  log.warn(`fire failed: ${(err as Error).message}`);
}
```

See [`@rw/triggers`](../../../../packages/triggers/README.md#error-model) for the framework-wide
error model and the `ingest.submit` escape hatch.

## Adding things

- **New action** → add its schema to `ACTION_SCHEMAS` (`catalog.ts`), write an `ActionHandler`
  (`actions.ts`), register it in `registry.ts`. Validation and the editor form derive
  automatically.
- **New event type** → add its schema to `EVENT_SCHEMAS` (`catalog.ts`); register a
  `ContextBuilder` for it in `registry.ts` if it needs more than its raw payload as facts
  (otherwise it uses the default stateless builder).

## Trace

For a concrete, value-by-value trace of one event (the seed trigger) through every step, see
[`WALKTHROUGH.md`](./WALKTHROUGH.md).

## Test

An end-to-end smoke test against the mock store lives at
[`apps/api/scripts/triggers-e2e.ts`](../../scripts/triggers-e2e.ts):

```bash
pnpm --filter @rw/api exec tsx scripts/triggers-e2e.ts
```
