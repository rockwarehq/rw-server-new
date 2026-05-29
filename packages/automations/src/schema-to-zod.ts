import * as z from "zod";
import type { ActionInputSchema, SchemaProperty } from "./types.js";

/**
 * Derives runtime validators from the catalog schemas, so validation is never
 * hand-written per event/action — it falls out of the same declaration the editor
 * renders from. Add an event/action type to the catalog and its validator comes
 * for free; there is no second place to update.
 */

function propToZod(prop: SchemaProperty): z.ZodTypeAny {
  if (prop.type === "array") return z.array(z.string());
  if (prop.enum && prop.enum.length) return z.enum(prop.enum as [string, ...string[]]);
  if (prop.type === "number") return z.number();
  return z.string();
}

/** Action inputs: required keys enforced (and non-empty), others optional. */
export function actionInputsToZod(schema: ActionInputSchema): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const required = schema.required.includes(key);
    let field = propToZod(prop);
    if (required) {
      if (prop.type === "string" && !prop.enum) field = z.string().min(1);
      else if (prop.type === "array") field = z.array(z.string().min(1)).min(1);
    } else {
      field = field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape);
}

/** Event payload: declared fields type-checked, all optional. */
export function payloadToZod(payload: Record<string, SchemaProperty>): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(payload)) {
    shape[key] = propToZod(prop).optional();
  }
  return z.object(shape);
}

/** Flatten a ZodError into a one-line, human-readable message. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
