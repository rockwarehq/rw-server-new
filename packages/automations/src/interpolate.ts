import type { AppEvent } from "./types.js";

/**
 * Resolves `{{...}}` template variables in action inputs at fire time.
 *   - `event.payload.x`, `event.type`, `event.id`, `event.ts` -> the raised event
 *   - `sys.timestamp` -> now (ISO)
 * Add a new source by adding a case in `resolveToken`.
 */
const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export interface VariableContext {
  event: AppEvent;
}

export function interpolateInputs<T extends Record<string, unknown>>(inputs: T, ctx: VariableContext): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === "string") {
      out[k] = interpolateString(v, ctx);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? interpolateString(item, ctx) : item));
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function interpolateString(raw: string, ctx: VariableContext): string {
  if (!raw.includes("{{")) return raw;
  return raw.replace(TOKEN_RE, (_full, token: string) => {
    const value = resolveToken(token.trim(), ctx);
    return value == null ? "" : String(value);
  });
}

function resolveToken(token: string, ctx: VariableContext): unknown {
  if (token.startsWith("event.")) return readPath(ctx.event, token.slice("event.".length));
  if (token === "sys.timestamp") return new Date().toISOString();
  return undefined;
}

function readPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
