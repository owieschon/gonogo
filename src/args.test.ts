import { describe, expect, test } from "bun:test";
import { assertKnownFlags, parseArgs } from "./args.ts";

const booleans = new Set(["replay", "record"]);

describe("CLI argument parsing", () => {
  test("accepts explicit boolean spellings without changing their meaning", () => {
    expect(parseArgs(["--replay"], { booleanFlags: booleans }).replay).toBe(true);
    expect(parseArgs(["--replay=true"], { booleanFlags: booleans }).replay).toBe(true);
    expect(parseArgs(["--replay", "false"], { booleanFlags: booleans }).replay).toBe(false);
  });

  test("rejects missing values and repeated scalar flags", () => {
    expect(() => parseArgs(["--spec"], { booleanFlags: booleans })).toThrow("requires a value");
    expect(() =>
      parseArgs(["--spec", "one", "--spec", "two"], { booleanFlags: booleans }),
    ).toThrow("may only be provided once");
  });

  test("retains repeated multi-value flags", () => {
    const args = parseArgs(["--dir", "one", "--dir=two"], {
      booleanFlags: booleans,
      multiFlags: new Set(["dir"]),
    });
    expect(args.dir).toEqual(["one", "two"]);
  });

  test("rejects unknown flags and positional arguments", () => {
    const args = parseArgs(["--repla", "fixture"], { booleanFlags: booleans });
    expect(() => assertKnownFlags(args, new Set(["replay"]))).toThrow("--repla");
    expect(() => assertKnownFlags({ _: ["extra"] }, new Set())).toThrow("unexpected argument");
  });
});
