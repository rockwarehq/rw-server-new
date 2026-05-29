import type { AppEvent, FactMap } from "./types.js";

/**
 * SEAM A — turns an event into the flat fact map conditions are evaluated against. The only builder
 * today is stateless (flattens the event's own payload); an app can supply a custom builder that also
 * pulls in external state (e.g. other values from a cache) without changing anything downstream.
 */
export interface ContextBuilder {
  build(event: AppEvent): FactMap | Promise<FactMap>;
}

/**
 * Flatten the event into facts: `event.type` + `event.payload.*`. No external state. E.g.
 * `{ type: "job.changed", payload: { stationId: "s_1" } }` → `{ "event.type": "job.changed", "event.payload.stationId": "s_1" }`.
 */
export const statelessContextBuilder: ContextBuilder = {
  build(event: AppEvent): FactMap {
    const facts: FactMap = { "event.type": event.type };
    for (const [k, v] of Object.entries(event.payload)) facts[`event.payload.${k}`] = v;
    return facts;
  },
};
