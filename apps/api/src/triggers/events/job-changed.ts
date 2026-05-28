import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/triggers";

/**
 * `job.changed` — fires when a job assignment changes at a station.
 *
 * The event's schema (versioned) and its context builder live together so they can't drift: a
 * future change to a `payload.X` shape adds a new entry to `versions` while keeping older versions
 * around for triggers that pin to them. The builder is shared across versions today; if a future
 * version needs payload-shape-specific facts, the builder can become a `Record<version, ContextBuilder>`.
 */
export const schema: EventSchema = {
  type: "job.changed",
  displayName: "Job Changed",
  latest: "1",
  versions: {
    "1": {
      payload: {
        previousJob: { type: "string", title: "Previous Job" },
        currentJob: { type: "string", title: "Current Job" },
        department: { type: "string", title: "Department" },
        station: { type: "string", title: "Station" },
        businessDate: { type: "string", title: "Business Date" },
        shift: { type: "string", title: "Shift" },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;
