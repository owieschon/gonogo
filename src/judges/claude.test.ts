import { expect, test } from "bun:test";
import {
  claudeArgs,
  claudeFailureDetail,
  parseClaudeResponse,
} from "./claude.ts";

const structuredSchema = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
} as const;

test("passes a structured schema to Claude without changing ordinary calls", () => {
  const ordinary = claudeArgs("claude-sonnet-5");
  expect(ordinary).toContain("--bare");
  expect(ordinary).toContain("--tools");
  expect(ordinary[ordinary.indexOf("--tools") + 1]).toBe("");
  expect(ordinary).not.toContain("--allowed-tools");
  expect(ordinary).toContain("--model");
  expect(ordinary).not.toContain("--json-schema");

  const structured = claudeArgs("claude-sonnet-5", structuredSchema);
  const schemaIndex = structured.indexOf("--json-schema");
  expect(schemaIndex).toBeGreaterThan(-1);
  expect(structured[schemaIndex + 1]).toBe(JSON.stringify(structuredSchema));
});

test("uses structured_output as the response text for schema-constrained calls", () => {
  const value = { verdict: "hold" };
  const response = parseClaudeResponse(
    JSON.stringify({
      result: "prose that must not become rubric input",
      structured_output: value,
      modelUsage: { "claude-sonnet-5": { outputTokens: 12 } },
      usage: { input_tokens: 7, output_tokens: 3 },
      total_cost_usd: 0.01,
    }),
    true,
    25,
  );
  expect(response.text).toBe(JSON.stringify(value));
  expect(response.model).toBe("claude-sonnet-5");
  expect(response.durationMs).toBe(25);
});

test("rejects a schema-constrained response without structured_output", () => {
  expect(() =>
    parseClaudeResponse(JSON.stringify({ result: '{"verdict":"hold"}' }), true),
  ).toThrow("omitted structured_output");
});

test("ordinary calls still use the result field", () => {
  expect(parseClaudeResponse(JSON.stringify({ result: "inferred goal" }), false).text).toBe(
    "inferred goal",
  );
});

test("uses stderr when the failed Claude process supplied it", () => {
  expect(claudeFailureDetail('{"result":"stdout detail"}', "stderr detail\n")).toBe(
    "stderr detail",
  );
});

test("extracts the Claude JSON result when a failed process writes only stdout", () => {
  expect(
    claudeFailureDetail(
      JSON.stringify({ is_error: true, result: "OAuth session expired and could not be refreshed" }),
      "",
    ),
  ).toBe("OAuth session expired and could not be refreshed");
});

test("retains non-JSON and empty failure evidence", () => {
  expect(claudeFailureDetail("plain stdout\n", "")).toBe("plain stdout");
  expect(claudeFailureDetail("", "")).toBe("no stdout or stderr");
});
