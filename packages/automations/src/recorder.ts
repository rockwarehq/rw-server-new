import type { AppEvent } from "./types.js";

/**
 * Audit sink for automation runs. The engine calls a recorder at three moments per `fire()`:
 *   1. `startRun(event)` — before dispatch evaluates conditions. Returns an opaque `runId` the
 *      engine threads through subsequent calls. Anything the recorder needs to write is up to it
 *      (a DB row, a log line, nothing); the engine doesn't care.
 *   2. `recordAction(...)` — after each action attempt (success or failure).
 *   3. `finishRun(runId, ...)` — when dispatch settles, with the matched-automation list and the
 *      terminal status. Called even on failure (the error is passed alongside).
 *
 * `noopRunRecorder` is the default — useful for tests or when audit is not wired. App-side
 * implementations (e.g. `createDbRunRecorder` in `@rw/services/automation`) write to Postgres.
 */
export interface RunRecorder {
  /** Open a run row. Return an id used by `recordAction` + `finishRun`. */
  startRun(input: StartRunInput): Promise<string>;
  /** Append one action attempt to the run. */
  recordAction(input: RecordActionInput): Promise<void>;
  /** Close out the run with its terminal state. */
  finishRun(runId: string, input: FinishRunInput): Promise<void>;
}

export interface StartRunInput {
  /** The raised event, in full. The recorder can choose what to persist. */
  event: AppEvent;
}

export interface RecordActionInput {
  runId: string;
  automationId: string;
  /** Index within the automation's `actions[]` at the time of dispatch. */
  actionIdx: number;
  actionType: string;
  actionVersion: string;
  status: "SUCCESS" | "FAILED";
  /** Error message when status = FAILED. */
  error?: string;
  /** When the handler started running (ISO). */
  startedAt: string;
  /** When the handler finished or failed (ISO). */
  finishedAt: string;
}

export interface FinishRunInput {
  /** Automation ids whose conditions matched in this dispatch. */
  matched: string[];
  status: "SUCCESS" | "FAILED";
  /** Error message when status = FAILED. */
  error?: string;
}

/** Default no-op. Used when the consumer didn't supply a recorder (file-backed dev, tests). */
export const noopRunRecorder: RunRecorder = {
  startRun: async () => "noop",
  recordAction: async () => {},
  finishRun: async () => {},
};
