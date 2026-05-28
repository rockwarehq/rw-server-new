import {
  type ActionRegistry,
  type ContextBuilder,
  createActionRegistry,
  type EventType,
  statelessContextBuilder,
} from "@rw/triggers";
import { sendAlertHandler } from "./actions.js";

/**
 * Composition root — the ONE place to extend the framework with new behavior.
 *
 * Map each event type to the ContextBuilder that turns it into facts, and register action
 * handlers. To add a real business action (sendEmail, createForm) or a new event
 * type, edit here + the catalog schemas;
 */

export function buildContextBuilders(): Record<EventType, ContextBuilder> {
  return {
    "job.changed": statelessContextBuilder,
    // Later: "point.reading": snapshotContextBuilder,
  };
}

export function buildActionRegistry(): ActionRegistry {
  return createActionRegistry().register(sendAlertHandler);
  // Later: .register(createFormHandler).register(sendEmailHandler);
}
