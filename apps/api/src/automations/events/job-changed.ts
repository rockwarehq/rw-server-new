import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";

/**
 * `job.changed` — fires when a job assignment changes at a station.
 */
export const schema: EventSchema = {
  type: "job.changed",
  displayName: "Job Changed",
  latest: "1",
  versions: {
    "1": {
      payload: {
        // Picker-typed payload fields: the condition builder renders a `RefRegistry.list(source)`
        // dropdown instead of a plain input. Stored value is the picked id — same `ref: { source }`
        // shape as action-input refs (see SchemaProperty.ref in @rw/automations).
        previousJobId: { type: "string", title: "Previous Job", ref: { source: "jobs" } },
        currentJobId: { type: "string", title: "Current Job", ref: { source: "jobs" } },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        workCenterId: { type: "string", title: "Work Center", ref: { source: "workCenters" } },
        // Free-text payload fields (no ref → querybuilder renders a plain input).
        department: { type: "string", title: "Department" },
        businessDate: { type: "string", title: "Business Date" },
        shift: { type: "string", title: "Shift" },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;
