# Integration walkthrough

How to wire `@rw/triggers` into a new app, from nothing to a firing event. This is the
**build-time** view — the six config fields and where each comes from. For the **runtime** view
(an event flowing through the engine value-by-value), see the consuming app's
[`WALKTHROUGH.md`](../../apps/api/src/triggers/WALKTHROUGH.md).

The package is domain-agnostic, so this guide invents its own throwaway domain — an
`order.placed` event and a `sendSlack` action — to show that none of it lives in the engine. Your
app substitutes its own.

## 0. Add the dependency

```jsonc
// your app's package.json
"dependencies": { "@rw/triggers": "workspace:*" }
```
```jsonc
// your app's tsconfig.json — so project references build it
"references": [{ "path": "../../packages/triggers" }]
```

Everything below assembles into one call: `createTriggerFramework(config)`. The config has five
required fields (plus an optional `notify`); the next steps build them one at a time.

## 1. Declare your schemas (`eventSchemas` + `actionSchemas`)

The single source of truth the engine validates against and a UI renders from. No engine code
changes when you add a type here.

```ts
import type { ActionSchema, EventSchema, EventType } from "@rw/triggers";

export const EVENT_SCHEMAS: Record<EventType, EventSchema> = {
  "order.placed": {
    type: "order.placed",
    displayName: "Order Placed",
    payload: {
      orderId: { type: "string", title: "Order ID" },
      total: { type: "number", title: "Total" },
      region: { type: "string", title: "Region" },
    },
  },
};

export const ACTION_SCHEMAS: Record<string, ActionSchema> = {
  sendSlack: {
    type: "sendSlack",
    displayName: "Send Slack message",
    inputSchema: {
      required: ["channel", "text"],
      properties: {
        channel: { type: "string", title: "Channel" },
        text: { type: "string", title: "Text", description: "Supports {{event.payload.*}}." },
      },
    },
  },
};
```

## 2. Write an action handler (`actions`) — SEAM C

`inputSchema` drives validation + the editor; `run` does the work. The engine resolves the handler
by `trigger.action.type`, so adding actions never touches the engine.

```ts
import { type ActionHandler, createActionRegistry } from "@rw/triggers";

const sendSlackHandler: ActionHandler = {
  type: "sendSlack",
  inputSchema: ACTION_SCHEMAS.sendSlack.inputSchema,
  async run(inputs, _ctx) {
    await slack.post(String(inputs.channel), String(inputs.text)); // your real effect
  },
};

const actions = createActionRegistry().register(sendSlackHandler);
```

## 3. Map event types to fact builders (`contextBuilders`) — SEAM A

A builder turns an event into the flat fact map conditions read. **Every event type in your
schemas must have an entry here** — `createTriggerFramework` validates this at construction time
and throws on a miss, so a typo or forgotten registration fails fast instead of silently using
wrong facts. Most self-contained events just point at `statelessContextBuilder` (which flattens the
payload); supply a custom builder for types that need extra facts (e.g. reading other values from a
cache).

```ts
import { statelessContextBuilder, type ContextBuilder, type EventType } from "@rw/triggers";

const contextBuilders: Record<EventType, ContextBuilder> = {
  "order.placed": statelessContextBuilder,
  // "point.reading": snapshotContextBuilder,  // a type that needs custom fact extraction
};
```

## 4. Provide a store (`store`) — the persistence seam

Implement `TriggerStore` against your database. For dev, an in-memory map is enough — the engine
only needs these five methods:

```ts
import type { Trigger, TriggerStore } from "@rw/triggers";

function createMemoryStore(): TriggerStore {
  const map = new Map<string, Trigger>();
  let n = 0;
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    upsert: (t) => (map.set(t.id, t), t),
    remove: (id) => map.delete(id),
    newId: () => `trg_${++n}`,
  };
}
```

> The store persists trigger **definitions** only — it does not drive evaluation. After any
> `upsert`/`remove` you MUST call `engine.reload()` (see step 6/7). See the `TriggerStore` doc
> comment in [`store.ts`](./src/store.ts) for the multi-instance (Redis pub/sub) plan.

## 5. Assemble — `createTriggerFramework(config)`

The five required fields from steps 1–4:

```ts
import { createTriggerFramework } from "@rw/triggers";

const fw = createTriggerFramework({
  eventSchemas: EVENT_SCHEMAS,         // step 1
  actionSchemas: ACTION_SCHEMAS,       // step 1
  store: createMemoryStore(),          // step 4
  contextBuilders,                     // step 3 — must cover every event in eventSchemas (throws otherwise)
  actions,                             // step 2
});
// fw.catalog(eventType, actionType) is required — the editor must pick both. No engine-side defaults.
```

`createTriggerFramework` calls `engine.reload()` for you, so the framework is ready to fire as
soon as it returns. Expose `fw` as a singleton (e.g. `getTriggerFramework()`).

## 6. Author a trigger, then raise an event

Triggers are authored through your own UI/RPC, which writes to the store and reloads:

```ts
const t = fw.store.upsert({
  id: fw.store.newId(),
  label: "Big EU order",
  enabled: true,
  event: "order.placed",
  conditions: { combinator: "and", rules: [
    { field: "event.payload.region", operator: "=", value: "EU" },
    { field: "event.payload.total", operator: ">", value: 1000 },
  ] },
  // One or more actions — they run sequentially when conditions match.
  actions: [
    { type: "sendSlack", inputs: { channel: "#orders", text: "Big order {{event.payload.orderId}}" } },
    // { type: "logAudit", inputs: { … } },   // add as many as you need
  ],
});
fw.engine.reload(); // REQUIRED after every write — rebuilds the compiled engines from the store
```

Then, wherever the event happens in your app, fire it. `fire()` throws on a bad payload, an
unknown event type, or any misconfigured matched action (no handler / missing required input), so
wrap the call if you want graceful handling:

```ts
try {
  const { eventId, matched } = await fw.fire("order.placed", { orderId: "o_42", total: 5000, region: "EU" });
  log.info(`event ${eventId} matched: ${matched.join(",")}`);   // ["trg_1"]
} catch (err) {
  log.warn(`fire failed: ${(err as Error).message}`);
}
```

That's the whole loop: **declare → handle → wire → assemble → author → fire.** Adding a new event
or action later touches only steps 1–3 (your domain) — never the engine.

## What you did NOT have to do

- Write any validation — it's derived from your schemas (`createValidators`, used internally).
- Touch condition evaluation, fact extraction, interpolation, or the json-rules wiring.
- Edit anything inside `@rw/triggers`.

For the field-by-field reference (the seam table, the `fire()` contract, every file), see
[`README.md`](./README.md).
