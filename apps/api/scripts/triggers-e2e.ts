/**
 * End-to-end smoke test for the trigger framework against the MOCK store.
 *
 * Drives the real framework (no mocks of internals) over an isolated temp store file and asserts
 * the full event → trigger → condition → action path.
 * Run: `pnpm --filter @rw/api exec tsx scripts/triggers-e2e.ts`
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionRegistry, createTriggerFramework, statelessContextBuilder, type TriggerStore } from "@rw/triggers";
import { createAppTriggerFramework } from "../src/triggers/index.js";
import { createFileTriggerStore } from "../src/triggers/store.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
  }
}

/** Run `fn` and return the Error it throws, or null if it didn't throw. */
async function assertThrows(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function main(): Promise<void> {
  // Isolated store so we never touch the dev .triggers-mock.json. Seeds trg_seed on first load.
  const dir = mkdtempSync(join(tmpdir(), "triggers-e2e-"));
  const storePath = join(dir, "triggers.json");
  const store = createFileTriggerStore(storePath);
  const fw = createAppTriggerFramework({ store });

  // ---------------------------------------------------------------------------
  // Seed trigger has TWO actions (supervisor alert + shift-lead alert). Test verifies BOTH ran.
  console.log("\n1. Happy path — seed trigger matches (station S-1), both actions fire");
  const alerts: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (msg.startsWith("[triggers] ALERT")) alerts.push(msg);
    else realLog(...(args as Parameters<typeof realLog>));
  };
  let r1: { eventId: string; matched: string[] };
  try {
    r1 = await fw.fire("job.changed", { previousJob: "J-100", currentJob: "J-200", station: "S-1" });
  } finally {
    console.log = realLog;
  }
  check("eventId generated", typeof r1.eventId === "string" && r1.eventId.length > 0, r1.eventId);
  check("matched = [trg_seed]", JSON.stringify(r1.matched) === '["trg_seed"]', r1.matched);
  check("both actions ran (two ALERT lines)", alerts.length === 2, alerts);
  check("supervisor alert ran first", alerts[0]?.includes("supervisor@example.com") === true, alerts[0]);
  check("shift-lead alert ran second", alerts[1]?.includes("shift-lead@example.com") === true, alerts[1]);

  // ---------------------------------------------------------------------------
  console.log("\n2. Condition mismatch — valid event, nobody cares (station S-2)");
  const r2 = await fw.fire("job.changed", { previousJob: "J-100", currentJob: "J-200", station: "S-2" });
  check("matched = []", JSON.stringify(r2.matched) === "[]", r2.matched);

  // ---------------------------------------------------------------------------
  console.log("\n3. Invalid payload — wrong type (station is a number) — throws");
  const e3 = await assertThrows(() => fw.fire("job.changed", { station: 123 } as never));
  check("threw on invalid payload", e3 !== null);
  check("error mentions station", e3 !== null && /station/i.test(e3.message), e3?.message);

  // ---------------------------------------------------------------------------
  console.log("\n4. Unknown event type — throws");
  const e4 = await assertThrows(() => fw.fire("foo.bar", {}));
  check("threw on unknown event type", e4 !== null);
  check("error mentions unknown event type", e4 !== null && /unknown event type/i.test(e4.message), e4?.message);

  // ---------------------------------------------------------------------------
  console.log("\n5. Authoring — create a new trigger, reload, it fires");
  const created = store.upsert({
    id: store.newId(),
    label: "Alert at S-9",
    enabled: true,
    event: "job.changed",
    conditions: { combinator: "and", rules: [{ field: "event.payload.station", operator: "=", value: "S-9" }] },
    actions: [{ type: "sendAlert", inputs: { text: "hit {{event.payload.station}}", emails: ["ops@example.com"] } }],
  });
  check("upsert returned the trigger", created.label === "Alert at S-9");
  // Before reload the engine still runs the old rule set — the new trigger is invisible.
  const beforeReload = await fw.fire("job.changed", { station: "S-9" });
  check("does NOT fire before reload()", beforeReload.matched.length === 0, beforeReload.matched);
  // Reload rebuilds the compiled engines from the store (what rpc/triggers.ts does after a write).
  fw.engine.reload();
  const afterReload = await fw.fire("job.changed", { station: "S-9" });
  check("fires after reload()", afterReload.matched.includes(created.id), afterReload.matched);

  // ---------------------------------------------------------------------------
  console.log("\n6. Disable — disabled trigger drops out on reload");
  store.upsert({ ...created, enabled: false });
  fw.engine.reload();
  const afterDisable = await fw.fire("job.changed", { station: "S-9" });
  check("disabled trigger no longer matches", afterDisable.matched.length === 0, afterDisable.matched);

  // ---------------------------------------------------------------------------
  console.log("\n7. Persistence — store survives a reopen (mock file round-trip)");
  const reopened = createFileTriggerStore(storePath);
  check("seed trigger persisted", reopened.get("trg_seed") !== undefined);
  check("authored trigger persisted", reopened.get(created.id) !== undefined);

  // ---------------------------------------------------------------------------
  console.log("\n8. Misconfigured action — fire() throws when matched trigger has no handler");
  store.upsert({
    id: store.newId(),
    label: "Broken action",
    enabled: true,
    event: "job.changed",
    conditions: { combinator: "and", rules: [{ field: "event.payload.station", operator: "=", value: "S-7" }] },
    actions: [{ type: "sendSms", inputs: {} }], // no registered handler for sendSms
  });
  fw.engine.reload();
  const e8 = await assertThrows(() => fw.fire("job.changed", { station: "S-7" }));
  check("fire() threw", e8 !== null);
  check("error names the missing handler 'sendSms'", e8 !== null && /sendSms/.test(e8.message), e8?.message);

  // ---------------------------------------------------------------------------
  console.log("\n9. Construction validation — missing builder for declared event type throws");
  const emptyStore: TriggerStore = {
    list: () => [],
    get: () => undefined,
    upsert: (t) => t,
    remove: () => false,
    newId: () => "x",
  };
  let threw = false;
  let errMsg = "";
  try {
    createTriggerFramework({
      eventSchemas: {
        foo: { type: "foo", displayName: "Foo", payload: {} },
        bar: { type: "bar", displayName: "Bar", payload: {} },
      },
      actionSchemas: {},
      store: emptyStore,
      contextBuilders: { foo: statelessContextBuilder }, // "bar" intentionally missing
      actions: createActionRegistry(),
    });
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  check("threw at construction", threw);
  check('error names the missing type "bar"', /bar/.test(errMsg), errMsg);

  // ---------------------------------------------------------------------------
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
