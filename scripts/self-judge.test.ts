import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvidence } from "../src/evidence.ts";

// These tests never run the real judge and never run this repository's own
// suite again: the dispatch test replaces bin/gonogo with a recording stub, and
// the execution test runs the unit-test segment inside a throwaway repository
// that contains one test file of its own. Both are offline and deterministic.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const selfJudge = join(scriptDir, "self-judge.sh");
const temps: string[] = [];

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A directory whose name contains a space, so quoting regressions surface. */
function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix} `));
  temps.push(path);
  return path;
}

/**
 * Fake transport: a copy of the script over a bin/gonogo that records argv
 * instead of judging. Proves what the script dispatches, without a judge call.
 */
function dispatch(args: string[]): { argv: string[]; testCmd: string } {
  const root = temp("gonogo self judge");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(selfJudge, join(root, "scripts", "self-judge.sh"));
  const record = join(root, "argv.txt");
  writeFileSync(
    join(root, "bin", "gonogo"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${record}"\n`,
  );
  chmodSync(join(root, "bin", "gonogo"), 0o755);

  execFileSync("bash", [join(root, "scripts", "self-judge.sh"), ...args], { stdio: "pipe" });

  const argv = readFileSync(record, "utf8").split("\n").slice(0, -1);
  const at = argv.indexOf("--test-cmd");
  expect(at).toBeGreaterThan(-1);
  return { argv, testCmd: argv[at + 1]! };
}

/** The `&&`-joined segment of the dispatched command that runs the unit tests. */
function unitTestSegment(testCmd: string): string | undefined {
  return testCmd
    .split("&&")
    .map((s) => s.trim())
    .find((s) => /\bbun\s+test\b/.test(s));
}

describe("self-judge.sh dispatch (fake transport)", () => {
  test("dispatches this repository's unit tests as test evidence", () => {
    const { testCmd } = dispatch(["--spec", "SPEC.md"]);

    // The named gap: on unchanged main no segment runs the unit tests, so their
    // output can never reach TEST_RESULT.
    expect(unitTestSegment(testCmd)).toBeDefined();
  });

  test("keeps the existing typecheck and replay evidence and the && short-circuit", () => {
    const { testCmd } = dispatch(["--spec", "SPEC.md"]);
    const segments = testCmd.split("&&").map((s) => s.trim());

    expect(segments.some((s) => s.includes("tsc --noEmit"))).toBe(true);
    expect(segments.some((s) => /gonogo eval .*--replay/.test(s))).toBe(true);
    // No `;` or `||` sequencing: a failing segment must stop the chain and set a
    // non-zero exit code rather than being reported as a pass.
    expect(testCmd).not.toMatch(/;|\|\|/);
    expect(segments.length).toBeGreaterThanOrEqual(3);
  });

  test("keeps run-local event paths, passthrough args and paths with spaces intact", () => {
    const out = temp("self judge out");
    const { argv, testCmd } = dispatch(["--spec", "SPEC.md", "--out", out, "--judge", "claude"]);

    // Private event destination: eval events stay inside the run directory.
    expect(testCmd).toContain(`--events "${out}/eval-events.jsonl"`);
    // A path with a space stayed one argument through the script.
    expect(argv).toContain(out);
    expect(argv).toContain("--judge");
    expect(argv).toContain("claude");
  });
});

describe("self-judge.sh unit-test evidence (real execution boundary)", () => {
  test("a failing unit test propagates its real output and exit code to the judge", () => {
    const segment = unitTestSegment(dispatch(["--spec", "SPEC.md"]).testCmd);
    expect(segment).toBeDefined();

    // A throwaway repository with exactly one deliberately failing test, so the
    // segment runs for real without re-entering this repository's suite.
    const repo = temp("gonogo subject");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "--quiet");
    git("config", "user.name", "Self Judge Test");
    git("config", "user.email", "self-judge@example.invalid");
    writeFileSync(join(repo, "tracked.ts"), "export const tracked = true;\n");
    git("add", "tracked.ts");
    git("commit", "--quiet", "-m", "initial");
    writeFileSync(
      join(repo, "subject.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'test("subject invariant holds", () => {\n' +
        "  expect(1).toBe(2);\n" +
        "});\n",
    );

    const evidence = collectEvidence({
      repo,
      base: "HEAD",
      spec: "unit-test evidence",
      testCmd: segment,
    });

    // TEST_RESULT is rendered from these three fields, so a failure cannot be
    // read as a pass and the judge sees the real failure text.
    expect(evidence.test).not.toBeNull();
    expect(evidence.test!.exitCode).not.toBe(0);
    expect(evidence.test!.output).toContain("subject invariant holds");
    expect(evidence.test!.output).toContain("1 fail");
  });
});
