# End-to-end trace

A concrete, value-by-value walk of **one event** through the framework, using the
seed trigger. Read alongside the flow diagram in
[`@rw/triggers`](../../../../packages/triggers/README.md#how-an-event-flows) — that shows the
shape, this shows the actual data at each step.

> **Where the files live.** The engine steps (validation, dispatch, fact-building, condition
> evaluation, action execution) run in the **`@rw/triggers`** package. Only the *domain* pieces —
> the seed trigger (`store.ts`), the event modules (`events/<type>.ts` — schema + context builder),
> the action modules (`actions/<type>.ts` — schema + handler), the ref sources (`refs.ts`), and the
> composition root (`index.ts`) — live in this app folder. File references below note the package
> where relevant.

## Given: the seed trigger (already loaded)

`store.ts` seeds one trigger, and at boot `engine.reload()` grouped it under
`job.changed` and compiled its condition into a json-rules rule whose event carries the
trigger id (`event: { type: "trg_seed" }`):

```ts
{
  id: "trg_seed",
  label: "Alert on job change at S-1",
  enabled: true,
  event: "job.changed",
  eventVersion: "1",                                 // ← pinned to v1 of the event payload shape
  conditions: { combinator: "and", rules: [
    { field: "event.payload.station", operator: "=", value: "S-1" },
  ] },
  actions: [
    {
      type: "sendAlert",
      version: "1",                                  // ← pinned to sendAlert v1's inputSchema + run
      inputs: {
        text: "Job changed from {{event.payload.previousJob}} to {{event.payload.currentJob}} at {{event.payload.station}}",
        recipientUserIds: ["u_supervisor"],
      },
    },
    {
      type: "sendAlert",
      version: "1",
      inputs: {
        text: "FYI: shift lead notified of change at {{event.payload.station}}",
        recipientUserIds: ["u_shift_lead"],
      },
    },
  ],
}
```

> **Version pins.** Each `TriggerAction.version` is strict-matched against the action handler's
> registered versions at dispatch time. `eventVersion` is informational at dispatch (conditions
> evaluate against whatever payload was raised); the editor uses it to render the right form when
> the trigger is opened for editing. See the package
> [README → "Versioning"](../../../../packages/triggers/README.md#versioning).

> **Recipients are stored as user ids, not emails.** `sendAlert.recipientUserIds` declares
> `ref: { source: "users" }` on its schema property (see `actions/send-alert.ts`); the editor renders a picker
> populated by `RefRegistry.list("users")` and stores the picked ids. The handler resolves the ids
> to `User` objects at run time using `getUserById` from `refs.ts`. See the package
> [README → "Ref data sources"](../../../../packages/triggers/README.md#ref-data-sources) for the
> framework side of this.

> **Note — triggers are held in memory; updating one needs a reload.** Two in-memory
> stores back this: the trigger *definitions* in the mock `TriggerStore` (`store.ts`, this app,
> file-backed for now, `@rw/db` later) and the *compiled* condition engines
> (`this.engines`, `engine.ts` in @rw/triggers) built from them. Neither picks up changes on its
> own — a create/update/delete must call `engine.reload()` to rebuild the engines from the
> store. The RPC handlers (`rpc/triggers.ts`) do this after every mutation; a write
> that bypasses them leaves evaluation running against the old rules until the next
> reload, and a disabled trigger is only dropped from the engines on that reload.

## When: we raise an event

```ts
const { eventId, matched } = await fw.fire("job.changed", {
  previousJob: "J-100",
  currentJob: "J-200",
  station: "S-1",
});
```

## The trace

### 1. `fire()` resolves the version + validates the payload — `framework.ts` (@rw/triggers)
- The caller didn't pass `opts.version`, so the framework uses the event's `latest` ("1").
- Calls `validateEventPayload("job.changed", "1", payload)` (`validate.ts`, @rw/triggers).
- Looks up `EVENT_SCHEMAS["job.changed"].versions["1"]` (aggregated from `events/job-changed.ts` by `events/index.ts`) — found.
- Runs the cached zod validator (built once per `(type, version)`) → **ok**, returns the normalized value:
  ```ts
  { previousJob: "J-100", currentJob: "J-200", station: "S-1" }
  ```
If it were invalid, `validateEventPayload` would `throw new Error(...)` here and `fire()` would
propagate the throw — no event built, the engine never touched.

### 2. `fire()` builds the event — `framework.ts` (@rw/triggers)
Wraps the normalized payload in an `AppEvent` envelope (generates `id`, stamps `version` + `ts`):
```ts
{
  id: "a1b2c3d4",                       // nanoid(8)
  type: "job.changed",
  version: "1",                         // resolved from opts.version ?? eventSchema.latest
  ts: "2026-05-27T15:00:00.000Z",       // new Date().toISOString()
  payload: { previousJob: "J-100", currentJob: "J-200", station: "S-1" },
}
```

### 3. `ingest.submit(event)` — `ingest.ts`, @rw/triggers (SEAM B)
`SyncIngestRuntime` forwards straight to `engine.dispatch(event, notify)`. (Swap this
seam for a queue later; the engine call is unchanged.)

### 4. `dispatch()` routes — `engine.ts` (@rw/triggers)
- `this.engines.get("job.changed")` → the condition engine holding this type's triggers.
  (No engine for the type → `return []`, and `fire()` resolves to `{ eventId, matched: [] }` —
  legitimately empty, not an error.)

### 5. `dispatch()` builds facts — `context.ts`, @rw/triggers (SEAM A)
`statelessContextBuilder.build(event)` flattens the event into the fact map:
```ts
{
  "event.type": "job.changed",
  "event.payload.previousJob": "J-100",
  "event.payload.currentJob": "J-200",
  "event.payload.station": "S-1",
}
```

### 6. `engine.run(facts)` evaluates conditions — `engine.ts` (@rw/triggers) → json-rules-engine
The seed rule's condition is `{ all: [{ fact: "event.payload.station", operator: "equal", value: "S-1" }] }`.
The fact `"event.payload.station"` is `"S-1"` → **passes**. `results` comes back with one
entry carrying `event: { type: "trg_seed" }`.

### 7. `dispatch()` maps the result back to a trigger — `engine.ts` (@rw/triggers)
- `triggerId = "trg_seed"`.
- `store.get("trg_seed")` → the full trigger (re-fetched because the rule only carried the id).
- `matched.push("trg_seed")`.
- `await runActions(trigger, event)` → step 8 (iterates `trigger.actions` in order; this seed trigger has exactly one).

### 8. `runActions()` executes each action — `engine.ts`, @rw/triggers (SEAM C)
The loop iterates `trigger.actions` in order. The seed has **two** actions, so the loop runs twice.

**Action #0 (supervisor alert):**
1. `actions.get("sendAlert", "1")` → the v1 `ActionVersion` (`{ inputSchema, run }`) from the `handler` exported by `actions/send-alert.ts` (this app). Lookup is STRICT — an unknown version would throw with the failing `sendAlert@<version>` named.
2. `interpolateInputs(action.inputs, { event })` (`interpolate.ts`, @rw/triggers) resolves the `{{...}}`. User-id arrays don't contain templates, so they pass through untouched:
   ```ts
   {
     text: "Job changed from J-100 to J-200 at S-1",
     recipientUserIds: ["u_supervisor"],
   }
   ```
3. `missingRequired(inputs, versioned.inputSchema)` — looked up via `actions.get("sendAlert", "1")`, which returns the v1 `{ inputSchema, run }` pair. v1 requires `["text","recipientUserIds"]`; both present → `null` (ok). (If either were missing, `runActions` would throw and abort the dispatch loop. The throw names the action index + `type@version` — e.g. `action #0 ("sendAlert@1"): missing required input "recipientUserIds"` — so you can tell which action of which trigger failed.)
4. `await versioned.run(inputs, { trigger, eventId: "a1b2c3d4" })`:
   - Inside the handler, each id is resolved via `getUserById("u_supervisor")` → `{ id, name: "Sam Supervisor", email: "supervisor@example.com" }`. Unknown ids are skipped with a `console.warn` and don't appear in the log line.
   - logs: `[triggers] ALERT (Alert on job change at S-1): Job changed from J-100 to J-200 at S-1 -> Sam Supervisor <supervisor@example.com>`

**Action #1 (shift-lead alert):**
The same handler is resolved (both actions are `sendAlert` here), with different inputs interpolated from this action's template:
   ```ts
   { text: "FYI: shift lead notified of change at S-1", recipientUserIds: ["u_shift_lead"] }
   ```
- After handler-side id resolution, logs: `[triggers] ALERT (Alert on job change at S-1): FYI: shift lead notified of change at S-1 -> Riley Shift-Lead <shift-lead@example.com>`

The loop then exits (no more actions on this trigger) and `dispatch` moves on to any other matched triggers.

### 9. Unwind — back to the caller
```
runActions resolves
  └─ dispatch loop ends → returns ["trg_seed"]
       └─ ingest.submit resolves
            └─ fire() returns:
               { eventId: "a1b2c3d4", matched: ["trg_seed"] }
```

The action's `console.log` line is the only effect observable from outside — there is no
lifecycle-notification sink at this layer. (A future observability seam can be added as a
parameter to `dispatch` / `runActions` when needed.)

## The same event, three other outcomes

- **Condition doesn't match** — `station: "S-2"`. Steps 1–6 run; the rule fails at step 6,
  `results` is empty, nothing is pushed to `matched`. `fire()` returns
  `{ eventId, matched: [] }`. (Valid event, just nobody cared — not an error.)

- **Invalid payload** — `station: 123` (a number, schema wants a string). Step 1 fails;
  `validateEventPayload` throws `Error("station: Expected string, received number")` and `fire()`
  propagates the throw. No event is built, the engine is never touched.

- **Unknown event type** — `fire("foo.bar", {})`. Step 1's catalog lookup misses;
  `validateEventPayload` throws `Error("unknown event type: foo.bar")`.

## Misconfigured-but-matching trigger

If the seed trigger's conditions matched but one of its actions were broken (e.g. an `"sendSms"`
action with no registered handler, or a required input left empty), step 8 **throws** at that
action — `runActions` raises an error naming the trigger label, id, action index, and action type
— which propagates out of `dispatch` and out of `fire()`. `matched.push(...)` happens before
`runActions` is called, but `fire()` never returns the array; the caller sees the throw.

Any **earlier** actions on the same trigger already ran (and their side effects, like a logged
ALERT, persist). Subsequent actions on the trigger don't run, and if a *later* matched trigger had
its own actions to run for the same event, those don't run either — the throw aborts the whole
dispatch loop. The next call to `fire()` starts fresh.
