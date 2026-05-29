/**
 * End-to-end test for the automation framework against the REAL DATABASE.
 *
 * Drives the real DB-backed framework (store + audit recorder + DB ref sources — no mocks) and
 * asserts the full event → automation → condition → action → audit path against Postgres. Seeds a
 * dedicated test workspace (users, a station/work-center/job for the ref pickers), runs the
 * assertions, then tears the workspace + audit rows back down so re-runs start clean.
 *
 * Requires a reachable database (`DATABASE_URL`). Run:
 *   `pnpm --filter @rw/api exec tsx scripts/automations-db-e2e.ts`
 */
import "dotenv/config";
import {
  type AutomationAction,
  type AutomationStore,
  createActionRegistry,
  createAutomationFramework,
  statelessContextBuilder,
} from "@rw/automations";
import prisma from "@rw/db";
import { createDbAutomationStore } from "@rw/services/automation/store";
import { createAppAutomationFramework } from "../src/automations/index.js";

// Stable ids so re-runs upsert (not duplicate) and teardown is deterministic. Automation ids,
// AutomationRun.eventId, and the audit automationId columns are all `@db.Uuid`, so every id here
// is a valid UUID — same format `fw.store.newId()` mints in production.
const WORKSPACE_NAME = "Automation E2E";
const WORKSPACE_SLUG = "automation-e2e";
const SITE_ID = "a51c0000-0000-4000-8000-000000000001";
const WC_ID = "a51c0000-0000-4000-8000-000000000002";
const STATION_ID = "a51c0000-0000-4000-8000-000000000003";
const JOB_ID = "a51c0000-0000-4000-8000-000000000004";
const JOBBLOB_ID = "a51c0000-0000-4000-8000-000000000005";
const USR = [
  { id: "5e700000-0000-4000-8000-000000000001", email: "sam.supervisor@e2e.test" },
  { id: "5e700000-0000-4000-8000-000000000002", email: "riley.shiftlead@e2e.test" },
  { id: "5e700000-0000-4000-8000-000000000003", email: "ops.pager@e2e.test" },
];
const [USR_SUP, USR_LEAD, USR_OPS] = USR;
const AUTO_MAIN_ID = "a017a000-0000-4000-8000-000000000001";
const AUTO_AUTHOR_ID = "a017a000-0000-4000-8000-000000000002";
const AUTO_BROKEN_ID = "a017a000-0000-4000-8000-000000000003";
const AUTO_BADVER_ID = "a017a000-0000-4000-8000-000000000004";
const AUTOMATION_IDS = [AUTO_MAIN_ID, AUTO_AUTHOR_ID, AUTO_BROKEN_ID, AUTO_BADVER_ID];
const MAIN_LABEL = "E2E: alert on job change at s_1";
const AUTHOR_LABEL = "E2E: authored alert at s_9";

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

/** Capture `[automations] ALERT` log lines emitted while `fn` runs (the sendAlert handler logs them). */
async function captureAlerts<T>(fn: () => Promise<T>): Promise<{ result: T; alerts: string[] }> {
  const alerts: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (msg.startsWith("[automations] ALERT")) alerts.push(msg);
    else real(...(args as Parameters<typeof real>));
  };
  try {
    const result = await fn();
    return { result, alerts };
  } finally {
    console.log = real;
  }
}

/** Seed (idempotently) the dedicated test workspace + the rows the framework reads. */
async function setup(): Promise<{ workspaceId: string }> {
  const workspace = await prisma.workspace.upsert({
    where: { slug: WORKSPACE_SLUG },
    create: { name: WORKSPACE_NAME, slug: WORKSPACE_SLUG },
    update: {},
  });
  const workspaceId = workspace.id;

  await prisma.site.upsert({
    where: { id: SITE_ID },
    create: { id: SITE_ID, name: "E2E Site", workspaceId },
    update: {},
  });
  await prisma.workcenter.upsert({
    where: { id: WC_ID },
    create: { id: WC_ID, name: "E2E Workcenter", siteId: SITE_ID },
    update: {},
  });
  await prisma.station.upsert({
    where: { id: STATION_ID },
    create: { id: STATION_ID, name: "E2E Station", siteId: SITE_ID },
    update: {},
  });
  await prisma.job.upsert({ where: { id: JOB_ID }, create: { id: JOB_ID, siteId: SITE_ID }, update: {} });
  await prisma.jobBlob.upsert({
    where: { id: JOBBLOB_ID },
    create: { id: JOBBLOB_ID, jobId: JOB_ID, version: 1, name: "E2E Job" },
    update: {},
  });
  await prisma.job.update({ where: { id: JOB_ID }, data: { currentBlobId: JOBBLOB_ID } });

  // Users (recipients are picked as users — only User carries an email).
  for (const u of USR) {
    await prisma.user.upsert({
      where: { id: u.id },
      create: { id: u.id, email: u.email, status: "ACTIVE" },
      update: { email: u.email },
    });
  }

  return { workspaceId };
}

/** eventIds fired during this test. Runs are global (no workspace FK), so teardown targets its own rows by these. */
const firedEventIds = new Set<string>();

/**
 * Delete this test's automations (global — no workspace FK) and its audit runs (cascade to their
 * matches + action runs). Runs are global too, so target them by the automations they matched
 * (covers success + failed runs) plus the eventIds we fired (covers no-match runs). Shared by the
 * pre-run clean and the full teardown.
 */
async function cleanupTestData(): Promise<void> {
  await prisma.automation.deleteMany({ where: { id: { in: AUTOMATION_IDS } } });
  await prisma.automationRun.deleteMany({
    where: {
      OR: [{ matches: { some: { automationId: { in: AUTOMATION_IDS } } } }, { eventId: { in: [...firedEventIds] } }],
    },
  });
}

/** Remove every row this test created so re-runs start clean (and CI leaves no residue). */
async function teardown(workspaceId: string): Promise<void> {
  await cleanupTestData();
  // Clear Job→currentBlob then drop the blob + job (Job→Site may restrict the workspace cascade).
  await prisma.job.updateMany({ where: { id: JOB_ID }, data: { currentBlobId: null } });
  await prisma.jobBlob.deleteMany({ where: { id: JOBBLOB_ID } });
  await prisma.job.deleteMany({ where: { id: JOB_ID } });
  // Workspace delete cascades site (→ station, workcenter). Users are global (no workspace FK), so
  // drop the seeded ones explicitly.
  await prisma.user.deleteMany({ where: { id: { in: USR.map((u) => u.id) } } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
}

async function main(): Promise<void> {
  console.log("─── Setup: dedicated test workspace + seed data ──────────────────────");
  const { workspaceId } = await setup();
  console.log(`  workspace=${workspaceId}  users=${USR.length}  station/workcenter/job seeded`);

  // Pre-clean any residue from a prior crashed run BEFORE building the framework, so the store's
  // initial load doesn't pick up stale test automations.
  await cleanupTestData();

  const fw = await createAppAutomationFramework();

  /** Upsert a `job.changed` automation matching `stationId == value`, with the given actions. */
  const seedAutomation = (spec: { id: string; label: string; value: string; actions: AutomationAction[] }) =>
    fw.store.upsert({
      id: spec.id,
      label: spec.label,
      enabled: true,
      event: "job.changed",
      eventVersion: "1",
      conditions: { combinator: "and", rules: [{ field: "event.payload.stationId", operator: "=", value: spec.value }] },
      actions: spec.actions,
    });

  try {
    // -------------------------------------------------------------------------
    console.log("\n1. Happy path — automation matches (stationId s_1), both actions fire");
    await seedAutomation({
      id: AUTO_MAIN_ID,
      label: MAIN_LABEL,
      value: "s_1",
      actions: [
        {
          type: "sendAlert",
          version: "1",
          inputs: {
            text: "Job changed from {{event.payload.previousJobId}} to {{event.payload.currentJobId}} at {{event.payload.stationId}}",
            recipientUserIds: [USR_SUP.id],
          },
        },
        {
          type: "sendAlert",
          version: "1",
          inputs: { text: "FYI: shift lead notified of change at {{event.payload.stationId}}", recipientUserIds: [USR_LEAD.id] },
        },
      ],
    });
    fw.engine.reload();

    const { result: r1, alerts } = await captureAlerts(() =>
      fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_1" }),
    );
    firedEventIds.add(r1.eventId);
    const ourAlerts = alerts.filter((a) => a.includes(MAIN_LABEL));
    check("eventId generated", typeof r1.eventId === "string" && r1.eventId.length > 0, r1.eventId);
    check("our automation matched", r1.matched.includes(AUTO_MAIN_ID), r1.matched);
    check("both actions ran (2 ALERT lines)", ourAlerts.length === 2, ourAlerts);
    check("supervisor alert ran first (resolved email)", ourAlerts[0]?.includes(USR_SUP.email) === true, ourAlerts[0]);
    check("shift-lead alert ran second (resolved email)", ourAlerts[1]?.includes(USR_LEAD.email) === true, ourAlerts[1]);
    check(
      "no raw user ids leaked into the alert text",
      ourAlerts.every((a) => !a.includes(USR_SUP.id) && !a.includes(USR_LEAD.id)),
      ourAlerts,
    );

    // -------------------------------------------------------------------------
    console.log("\n2. Audit — the happy-path fire persisted a run + action rows in Postgres");
    const run1 = await prisma.automationRun.findFirst({
      where: { eventId: r1.eventId },
      include: { matches: true, actionRuns: { orderBy: { actionIdx: "asc" } } },
    });
    check("AutomationRun row written for the fire", run1 !== null);
    check("run status = SUCCESS", run1?.status === "SUCCESS", run1?.status);
    check("run recorded our automation as matched", run1?.matches.some((m) => m.automationId === AUTO_MAIN_ID) === true, run1?.matches);
    check(
      "two SUCCESS AutomationActionRun rows",
      run1?.actionRuns.filter((a) => a.status === "SUCCESS").length === 2,
      run1?.actionRuns,
    );

    // -------------------------------------------------------------------------
    console.log("\n3. Condition mismatch — valid event, our automation doesn't match (stationId s_2)");
    const r2 = await fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_2" });
    firedEventIds.add(r2.eventId);
    check("our automation NOT in matched", !r2.matched.includes(AUTO_MAIN_ID), r2.matched);

    // -------------------------------------------------------------------------
    console.log("\n4. Invalid payload — wrong type (stationId is a number) — throws");
    const e4 = await assertThrows(() => fw.fire("job.changed", { stationId: 123 } as unknown as Record<string, unknown>));
    check("threw on invalid payload", e4 !== null);
    check("error mentions stationId", e4 !== null && /stationId/i.test(e4.message), e4?.message);

    // -------------------------------------------------------------------------
    console.log("\n5. Unknown event type — throws");
    const e5 = await assertThrows(() => fw.fire("foo.bar", {}));
    check("threw on unknown event type", e5 !== null);
    check("error mentions unknown event type", e5 !== null && /unknown event type/i.test(e5.message), e5?.message);

    // -------------------------------------------------------------------------
    console.log("\n6. Authoring — create a new automation, reload, it fires");
    const created = await seedAutomation({
      id: AUTO_AUTHOR_ID,
      label: AUTHOR_LABEL,
      value: "s_9",
      actions: [{ type: "sendAlert", version: "1", inputs: { text: "hit {{event.payload.stationId}}", recipientUserIds: [USR_OPS.id] } }],
    });
    check("upsert returned the automation", created.label === AUTHOR_LABEL);
    const beforeReload = await fw.fire("job.changed", { stationId: "s_9" });
    firedEventIds.add(beforeReload.eventId);
    check("does NOT fire before reload()", !beforeReload.matched.includes(AUTO_AUTHOR_ID), beforeReload.matched);
    fw.engine.reload();
    const afterReload = await fw.fire("job.changed", { stationId: "s_9" });
    firedEventIds.add(afterReload.eventId);
    check("fires after reload()", afterReload.matched.includes(AUTO_AUTHOR_ID), afterReload.matched);

    // -------------------------------------------------------------------------
    console.log("\n7. Disable — disabled automation drops out on reload");
    await fw.store.upsert({ ...created, enabled: false });
    fw.engine.reload();
    const afterDisable = await fw.fire("job.changed", { stationId: "s_9" });
    firedEventIds.add(afterDisable.eventId);
    check("disabled automation no longer matches", !afterDisable.matched.includes(AUTO_AUTHOR_ID), afterDisable.matched);

    // -------------------------------------------------------------------------
    console.log("\n8. Persistence — a fresh DB store loads the automations from Postgres");
    const reopened = await createDbAutomationStore();
    check("happy-path automation persisted", reopened.get(AUTO_MAIN_ID) !== undefined);
    check("authored automation persisted", reopened.get(AUTO_AUTHOR_ID) !== undefined);

    // -------------------------------------------------------------------------
    console.log("\n9. Misconfigured action — fire() throws + records a FAILED run when no handler exists");
    await seedAutomation({
      id: AUTO_BROKEN_ID,
      label: "E2E: broken action (sendSms)",
      value: "s_7",
      actions: [{ type: "sendSms", version: "1", inputs: {} }],
    });
    fw.engine.reload();
    const e9 = await assertThrows(() => fw.fire("job.changed", { stationId: "s_7" }));
    check("fire() threw", e9 !== null);
    check("error names the missing handler 'sendSms'", e9 !== null && /sendSms/.test(e9.message), e9?.message);
    const failedRun = await prisma.automationRun.findFirst({
      where: { status: "FAILED" },
      orderBy: { firedAt: "desc" },
      include: { actionRuns: true },
    });
    check("audit recorded a FAILED run", failedRun !== null, failedRun?.status);
    check("FAILED run carries the error message", !!failedRun?.error && /sendSms/.test(failedRun.error), failedRun?.error);

    // -------------------------------------------------------------------------
    console.log("\n9b. Unknown action version — fire() throws when the version pin has no handler");
    await seedAutomation({
      id: AUTO_BADVER_ID,
      label: "E2E: bad version pin (sendAlert@999)",
      value: "s_99",
      actions: [{ type: "sendAlert", version: "999", inputs: { text: "x", recipientUserIds: [USR_OPS.id] } }],
    });
    fw.engine.reload();
    const e9b = await assertThrows(() => fw.fire("job.changed", { stationId: "s_99" }));
    check("fire() threw on bad version", e9b !== null);
    check("error names the missing version 'sendAlert@999'", e9b !== null && /sendAlert@999/.test(e9b.message), e9b?.message);

    // -------------------------------------------------------------------------
    console.log("\n10. Construction validation — missing builder for a declared event type throws");
    const emptyStore: AutomationStore = {
      list: () => [],
      get: () => undefined,
      upsert: async (t) => t,
      remove: async () => false,
      newId: () => "x",
    };
    const eBuild = await assertThrows(async () =>
      createAutomationFramework({
        eventSchemas: {
          foo: { type: "foo", displayName: "Foo", latest: "1", versions: { "1": { payload: {} } } },
          bar: { type: "bar", displayName: "Bar", latest: "1", versions: { "1": { payload: {} } } },
        },
        actionSchemas: {},
        store: emptyStore,
        contextBuilders: { foo: statelessContextBuilder }, // "bar" intentionally missing
        actions: createActionRegistry(),
      }),
    );
    check("threw at construction", eBuild !== null);
    check('error names the missing type "bar"', eBuild !== null && /bar/.test(eBuild.message), eBuild?.message);

    console.log("\n10b. Construction validation — `latest` pointing at a non-existent version throws");
    const eLatest = await assertThrows(async () =>
      createAutomationFramework({
        eventSchemas: { foo: { type: "foo", displayName: "Foo", latest: "99", versions: { "1": { payload: {} } } } },
        actionSchemas: {},
        store: emptyStore,
        contextBuilders: { foo: statelessContextBuilder },
        actions: createActionRegistry(),
      }),
    );
    check("threw on bad latest pointer", eLatest !== null);
    check('error names latest="99"', eLatest !== null && /99/.test(eLatest.message), eLatest?.message);

    // -------------------------------------------------------------------------
    console.log("\n11. Ref pickers — each DB-backed source returns the seeded rows");
    const users = await fw.listRefOptions("users");
    check("users picker includes the supervisor", users.some((o) => o.id === USR_SUP.id && o.label === USR_SUP.email), users);
    check("users picker includes the ops pager", users.some((o) => o.id === USR_OPS.id && o.label === USR_OPS.email), users);
    const stations = await fw.listRefOptions("stations");
    check("stations picker includes the seeded station", stations.some((o) => o.label === "E2E Station"), stations);
    const jobs = await fw.listRefOptions("jobs");
    check("jobs picker includes the seeded job", jobs.some((o) => o.label === "E2E Job"), jobs);
    const workCenters = await fw.listRefOptions("workCenters");
    check("workCenters picker includes the seeded work center", workCenters.some((o) => o.label === "E2E Workcenter"), workCenters);
    const eRef = await assertThrows(() => fw.listRefOptions("nonsense"));
    check("unknown source throws", eRef !== null && /unknown ref source/i.test(eRef.message), eRef?.message);

    // -------------------------------------------------------------------------
    console.log("\n12. Catalog — ref metadata on action inputs + event payload facts");
    const catalog = fw.catalog("job.changed", "sendAlert");
    check("catalog reports event version", catalog.eventVersion === "1", catalog.eventVersion);
    check("catalog reports action version (latest)", catalog.actionVersion === "1", catalog.actionVersion);
    const recipientsProp = catalog.action.versions[catalog.actionVersion]?.inputSchema.properties.recipientUserIds;
    check("recipientUserIds has ref source 'users'", recipientsProp?.ref?.source === "users", recipientsProp?.ref);
    check("recipientUserIds is multi", recipientsProp?.ref?.multi === true, recipientsProp?.ref);
    const stationFact = catalog.facts.find((f) => f.id === "event.payload.stationId");
    check("stationId fact carries ref.source = 'stations'", stationFact?.ref?.source === "stations", stationFact?.ref);
    const jobFact = catalog.facts.find((f) => f.id === "event.payload.currentJobId");
    check("currentJobId fact carries ref.source = 'jobs'", jobFact?.ref?.source === "jobs", jobFact?.ref);
    const wcFact = catalog.facts.find((f) => f.id === "event.payload.workCenterId");
    check("workCenterId fact carries ref.source = 'workCenters'", wcFact?.ref?.source === "workCenters", wcFact?.ref);
    const deptFact = catalog.facts.find((f) => f.id === "event.payload.department");
    check("department fact has NO ref (free-text)", deptFact?.ref === undefined, deptFact?.ref);

    // -------------------------------------------------------------------------
    console.log("\n13. Versioning — explicit unknown event version throws");
    const e13 = await assertThrows(() => fw.fire("job.changed", { stationId: "s_1" }, { version: "999" }));
    check("threw on explicit unknown event version", e13 !== null);
    check("error names the unknown version", e13 !== null && /999/.test(e13.message), e13?.message);
  } finally {
    await teardown(workspaceId);
    await prisma.$disconnect();
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("DB e2e crashed:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
