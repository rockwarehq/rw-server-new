import type * as z from "zod";
import { actionInputsToZod, formatZodError, payloadToZod } from "./schema-to-zod.js";
import type { ActionSchema, EventSchema, EventType } from "./types.js";

/** Validates inputs/payloads against the schemas it's given. Throws on failure; returns the normalized value on success. */
export interface Validators {
  /** Validate a trigger's action inputs against a specific schema version. Throws on unknown (type, version) or schema mismatch. */
  validateActionInputs(actionType: string, version: string, inputs: unknown): Record<string, unknown>;
  /** Validate an event payload against a specific schema version. Throws on unknown (type, version) or schema mismatch. */
  validateEventPayload(eventType: EventType, version: string, payload: unknown): Record<string, unknown>;
}

/**
 * Builds validators bound to a set of catalog schemas. Schemas are passed in (not imported) so the
 * engine stays domain-agnostic: the consuming app owns its `EVENT_SCHEMAS` / `ACTION_SCHEMAS`.
 *
 * Each derived Zod validator is built once and cached per (type, version) — schemas are static for
 * the process' lifetime, so repeated validation is cheap.
 *
 * Validators throw on any failure rather than returning a discriminated union — see the README's
 * "Error model" section.
 */
export function createValidators(
  eventSchemas: Record<EventType, EventSchema>,
  actionSchemas: Record<string, ActionSchema>,
): Validators {
  // Keyed `${type}@${version}` so different versions cache independently.
  const actionValidators = new Map<string, z.ZodTypeAny>();
  const payloadValidators = new Map<string, z.ZodTypeAny>();

  return {
    validateActionInputs(actionType, version, inputs) {
      const schema = actionSchemas[actionType];
      if (!schema) throw new Error(`unknown action type: ${actionType}`);
      const versioned = schema.versions[version];
      if (!versioned) {
        const known = Object.keys(schema.versions).join(", ");
        throw new Error(`unknown action version: ${actionType}@${version} (known: ${known})`);
      }

      const key = `${actionType}@${version}`;
      let validator = actionValidators.get(key);
      if (!validator) {
        validator = actionInputsToZod(versioned.inputSchema);
        actionValidators.set(key, validator);
      }

      const result = validator.safeParse(inputs ?? {});
      if (!result.success) throw new Error(formatZodError(result.error));
      return result.data as Record<string, unknown>;
    },

    validateEventPayload(eventType, version, payload) {
      const schema = eventSchemas[eventType];
      if (!schema) throw new Error(`unknown event type: ${eventType}`);
      const versioned = schema.versions[version];
      if (!versioned) {
        const known = Object.keys(schema.versions).join(", ");
        throw new Error(`unknown event version: ${eventType}@${version} (known: ${known})`);
      }

      const key = `${eventType}@${version}`;
      let validator = payloadValidators.get(key);
      if (!validator) {
        validator = payloadToZod(versioned.payload);
        payloadValidators.set(key, validator);
      }

      const result = validator.safeParse(payload ?? {});
      if (!result.success) throw new Error(formatZodError(result.error));
      return result.data as Record<string, unknown>;
    },
  };
}
