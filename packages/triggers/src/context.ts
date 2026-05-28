import type { AppEvent, FactMap } from "./types.js";

/**
 * SEAM A — turns an event into the flat fact map the engine evaluates conditions against.
 *
 * Today the only builder is stateless: it flattens the event's own payload. That is all a
 * self-contained business event needs (job.changed carries previousJob AND currentJob, so a
 * transition like "job changed to X" is decidable from the event alone).
 *
 * A high-volume processor/telemetry event type would supply its OWN builder implementing this
 * same interface — one that also reads other referenced tags' current values from a snapshot
 * cache before returning facts. Everything downstream of the builder is identical.
 */
export interface ContextBuilder {
  build(event: AppEvent): FactMap | Promise<FactMap>;
}

/** Flatten the event into facts: `event.type` + `event.payload.*`. No external state. 
 * Example:
   event = {
    id: "a1b2c3d4",
    type: "job.changed",
    ts: "2026-05-28T15:00:00Z",
    payload: { previousJob: "J-100", currentJob: "J-200", station: "S-1" },
  }

  it produces:

  {
    "event.type": "job.changed",
    "event.payload.previousJob": "J-100",
    "event.payload.currentJob": "J-200",
    "event.payload.station": "S-1",
  }
*/
export const statelessContextBuilder: ContextBuilder = {
  build(event: AppEvent): FactMap {
    const facts: FactMap = { "event.type": event.type };
    for (const [k, v] of Object.entries(event.payload)) facts[`event.payload.${k}`] = v;
    return facts;
  },
};
