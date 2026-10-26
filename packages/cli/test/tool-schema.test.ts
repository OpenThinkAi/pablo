import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { harnessTools } from "../src/harness/tools";
import { parseToolArguments, toJsonSchemaTool, toJsonSchemaTools } from "../src/harness/tool-schema";
import type { McpToolSpec } from "../src/verbs";

const spec: McpToolSpec = {
  name: "demo",
  description: "A demo tool.",
  args: z.object({ title: z.string().describe("the title"), count: z.number().int().optional() }),
  run: async () => ({ body: {}, exitCode: 0 }),
};

describe("toJsonSchemaTool", () => {
  test("produces a neutral object schema", () => {
    const tool = toJsonSchemaTool(spec);
    expect(tool.name).toBe("demo");
    expect(tool.description).toBe("A demo tool.");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.$schema).toBeUndefined();
    expect(tool.parameters.required).toEqual(["title"]);
    const props = tool.parameters.properties as Record<string, { type: string; description?: string }>;
    expect(props.title).toEqual({ type: "string", description: "the title" });
    expect(props.count?.type).toBe("integer");
  });

  test("converts every registered MCP tool (plus ask_author) without error", () => {
    const specs = harnessTools(async () => "ok");
    expect(specs.length).toBeGreaterThan(0);
    const tools = toJsonSchemaTools(specs);
    expect(tools.map((t) => t.name)).toEqual(specs.map((s) => s.name));
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(() => JSON.stringify(tool)).not.toThrow();
    }
  });
});

describe("parseToolArguments", () => {
  test("accepts valid arguments", () => {
    expect(parseToolArguments(spec, { title: "x", count: 2 })).toEqual({ ok: true, args: { title: "x", count: 2 } });
  });

  test("refuses invalid arguments, naming the field", () => {
    const bad = parseToolArguments(spec, { count: "two" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("demo");
      expect(bad.error).toContain("title");
      expect(bad.error).toContain("count");
    }
  });

  test("treats missing arguments as an empty object", () => {
    expect(parseToolArguments(spec, undefined).ok).toBe(false);
  });
});
