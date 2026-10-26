/**
 * zod -> JSON Schema bridge (AGT-2119, decision D-12): pablo's agent loop
 * speaks provider-neutral `JsonSchemaTool`s, while every pablo tool is an
 * `McpToolSpec` whose `args` is a zod object. `toJsonSchemaTool` converts a
 * spec for the model; `parseToolArguments` validates the model's call
 * arguments back through the same zod schema, so a malformed call is refused
 * with a readable message instead of reaching `run`.
 */

import { z } from "zod";
import type { JsonSchemaTool } from "@openthink/pablo-core";
import type { McpToolSpec } from "../verbs";

export function toJsonSchemaTool(spec: McpToolSpec): JsonSchemaTool {
  const schema = z.toJSONSchema(spec.args, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const { $schema: _dropped, ...parameters } = schema;
  return { name: spec.name, description: spec.description, parameters };
}

export function toJsonSchemaTools(specs: readonly McpToolSpec[]): readonly JsonSchemaTool[] {
  return specs.map(toJsonSchemaTool);
}

export type ParsedToolArguments =
  | { readonly ok: true; readonly args: z.infer<z.ZodObject<z.ZodRawShape>> }
  | { readonly ok: false; readonly error: string };

/** Validates a model's `arguments` object against the spec's zod schema. */
export function parseToolArguments(spec: McpToolSpec, args: unknown): ParsedToolArguments {
  const result = spec.args.safeParse(args ?? {});
  if (result.success) return { ok: true, args: result.data };
  const detail = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(arguments)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: `invalid arguments for ${spec.name}: ${detail}` };
}
