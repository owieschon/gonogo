import { expect, test } from "bun:test";
import { claudeFailureDetail } from "./claude.ts";

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
