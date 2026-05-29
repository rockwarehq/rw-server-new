# Automations (this app)

This app's domain + wiring for the automation engine. The reusable engine lives in
[`@rw/automations`](../../../../packages/automations/README.md); this folder supplies the concrete
**event/action schemas**, the **handlers** that do the work, the **fact builders**, and the
composition root that assembles them.

```
events/<type>.ts    one event:  schema (versioned) + contextBuilder
actions/<type>.ts   one action: handler with all versions inside
index.ts            composition root — createAppAutomationFramework()
```

The DB-backed seams (store, audit recorder, ref sources for the pickers) live in `@rw/services` and
are wired in by `index.ts`.

## How to use

Get the shared framework and `fire()` an event in-process:

```ts
import { getAutomationFramework } from "./automations/index.js";

const fw = await getAutomationFramework();
const { eventId, matched } = await fw.fire("job.changed", {
  previousJobId: "j_100",
  currentJobId: "j_200",
  stationId: "s_1",
});
```

`fire()` throws on a bad payload, unknown event type, or a misconfigured matched action — wrap it if
you want graceful handling.

## Adding things

- **New action** → add `actions/<type>.ts`, then one import line in `actions/index.ts`.
- **New event** → add `events/<type>.ts` (use `statelessContextBuilder` unless it needs joined data),
  then one import line in `events/index.ts`.
- **New version** → add a `"2"` entry to that action/event's `versions` map; keep `"1"` while any
  automation pins it.
- **New ref picker** → add a `RefSource` under `@rw/services` and `.register(...)` it in `index.ts`.

## Notes

- **Just-in-time, no queue.** Events fire synchronously in-process — no broker, no background worker.
  `fire()` runs the matched automations' actions in order and returns when they're done.
- **In-memory + reload.** Automations are cached in memory; every create/update/delete must call
  `engine.reload()` (the RPC handlers do this). A write that bypasses them runs against stale rules.
- **Horizontal scaling — not implemented.** The cache is per-instance, so a config upsert/delete only
  refreshes the instance that handled it. Scaling the API to multiple instances needs Redis pub/sub to
  notify the others to reload. Single-instance until that lands.

## Test

End-to-end against the real DB (needs `DATABASE_URL`):

```bash
pnpm --filter @rw/api exec tsx scripts/automations-db-e2e.ts
```
