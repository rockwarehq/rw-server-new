import type * as z from "zod";
import { actionInputsToZod, formatZodError, payloadToZod } from "./schema-to-zod.js";
import type { ActionSchema, EventSchema, EventType } from "./types.js";

/** Validates inputs/payloads against the schemas it's given. Throws on failure; returns the normalized value on success. */
export interface Validators {
  /** Validate a trigger's action inputs. Throws on unknown action type or schema mismatch. */
  validateActionInputs(actionType: string, inputs: unknown): Record<string, unknown>;
  /** Validate an event payload. Throws on unknown event type or schema mismatch. */
  validateEventPayload(eventType: EventType, payload: unknown): Record<string, unknown>;
}

/**
 * Builds validators bound to a set of catalog schemas. Schemas are passed in (not imported) so the
 * engine stays domain-agnostic: the consuming app owns its `EVENT_SCHEMAS` / `ACTION_SCHEMAS`.
 *
 * Each derived Zod validator is built once and cached (the schemas are static for the process'
 * lifetime), so repeated validation is cheap.
 *
 * Validators throw on any failure rather than returning a discriminated union — see the README's
 * "Error model" section.
 */
export function createValidators(
  eventSchemas: Record<EventType, EventSchema>,
  actionSchemas: Record<string, ActionSchema>,
): Validators {
  const actionValidators = new Map<string, z.ZodTypeAny>();
  const payloadValidators = new Map<EventType, z.ZodTypeAny>();

  return {
    validateActionInputs(actionType, inputs) {
      const schema = actionSchemas[actionType];
      if (!schema) throw new Error(`unknown action type: ${actionType}`);

      let validator = actionValidators.get(actionType);
      if (!validator) {
        validator = actionInputsToZod(schema.inputSchema);
        actionValidators.set(actionType, validator);
      }

      const result = validator.safeParse(inputs ?? {});
      if (!result.success) throw new Error(formatZodError(result.error));
      return result.data as Record<string, unknown>;
    },

    validateEventPayload(eventType, payload) {
      const schema = eventSchemas[eventType];
      if (!schema) throw new Error(`unknown event type: ${eventType}`);

      let validator = payloadValidators.get(eventType);
      if (!validator) {
        validator = payloadToZod(schema.payload);
        payloadValidators.set(eventType, validator);
      }

      const result = validator.safeParse(payload ?? {});
      if (!result.success) throw new Error(formatZodError(result.error));
      return result.data as Record<string, unknown>;
    },
  };
}
