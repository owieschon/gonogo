import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EvidenceConsistencyError, collectEvidence, writeEvidence } from "./evidence.ts";
import { subjectHashOf } from "./subject.ts";

const repos: string[] = [];

function runGit(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "gonogo-evidence-"));
  repos.push(path);
  runGit(path, "init", "--quiet");
  runGit(path, "config", "user.name", "Evidence Test");
  runGit(path, "config", "user.email", "evidence@example.invalid");
  writeFileSync(join(path, "tracked.ts"), "export const tracked = true;\n");
  runGit(path, "add", "tracked.ts");
  runGit(path, "commit", "--quiet", "-m", "initial");
  return path;
}

afterEach(() => {
  for (const path of repos.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("collectEvidence untracked-file boundary", () => {
  test("includes untracked files in the patch and file list", () => {
    const path = repo();
    writeFileSync(join(path, "feature.ts"), "export const feature = true;\n");

    const evidence = collectEvidence({ repo: path, base: "HEAD", spec: "test" });

    expect(evidence.changedFiles).toEqual(["feature.ts"]);
    expect(evidence.diff).toContain("export const feature = true;");
    // Preserve the v0.1 evidence contract: diffstat describes tracked changes,
    // while the complete patch and changed-files list carry untracked work.
    expect(evidence.diffStat).toBe("");
    expect(evidence.subjectHash).toBe(subjectHashOf(evidence));
  });

  test("subject identity changes when only the elided middle of a diff changes", () => {
    const path = repo();
    const file = join(path, "large.txt");
    writeFileSync(file, `${"a".repeat(6000)}X${"b".repeat(6000)}`);
    const first = collectEvidence({ repo: path, base: "HEAD", spec: "test", maxDiffChars: 1000 });
    writeFileSync(file, `${"a".repeat(6000)}Y${"b".repeat(6000)}`);
    const second = collectEvidence({ repo: path, base: "HEAD", spec: "test", maxDiffChars: 1000 });

    expect(first.truncated.diff).toBe(true);
    expect(second.truncated.diff).toBe(true);
    // Git exposes the changed blob identity in the patch header, but neither
    // changed payload byte survives the bounded evidence rendering.
    expect(first.diff).not.toContain("X");
    expect(second.diff).not.toContain("Y");
    expect(second.diff.replace(/^index .*$/m, "index <blob-ids>"))
      .toBe(first.diff.replace(/^index .*$/m, "index <blob-ids>"));
    expect(second.subjectHash).not.toBe(first.subjectHash);
  });

  test("writes subject identity with the persisted evidence metadata", () => {
    const path = repo();
    writeFileSync(join(path, "new.txt"), "new evidence\n");
    const evidence = collectEvidence({ repo: path, base: "HEAD", spec: "test" });
    const out = join(path, "artifact");
    writeEvidence(out, evidence);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.subject_hash).toBe(evidence.subjectHash);
  });

  test("subject identity binds transcript and test bytes hidden by evidence elision", () => {
    const path = repo();
    const transcript = join(path, "session.txt");
    const testOutput = join(path, "test-output.txt");
    const excluded = [transcript, testOutput];
    writeFileSync(transcript, `${"t".repeat(50_000)}X${"u".repeat(30_000)}`);
    writeFileSync(testOutput, `${"a".repeat(15_000)}X${"b".repeat(15_000)}`);
    const options = {
      repo: path,
      base: "HEAD",
      spec: "test",
      transcriptPath: transcript,
      testCmd: "cat test-output.txt",
      excludeUntrackedRoots: excluded,
    };
    const first = collectEvidence(options);
    writeFileSync(transcript, `${"t".repeat(50_000)}Y${"u".repeat(30_000)}`);
    writeFileSync(testOutput, `${"a".repeat(15_000)}Y${"b".repeat(15_000)}`);
    const second = collectEvidence(options);

    expect(first.truncated.transcript).toBe(true);
    expect(first.transcript).toBe(second.transcript);
    expect(first.test?.output).toBe(second.test?.output);
    expect(first.diff).toBe(second.diff);
    expect(first.subjectHash).not.toBe(second.subjectHash);
  });

  test("omits tool output below an absolute exclusion root", () => {
    const path = repo();
    const runs = join(path, "runs");
    mkdirSync(join(runs, "prior-run"), { recursive: true });
    writeFileSync(join(runs, "prior-run", "evidence.json"), "PRIOR-RUN-SENTINEL\n");
    writeFileSync(join(path, "runs-adjacent.txt"), "keep this\n");

    const evidence = collectEvidence({
      repo: path,
      base: "HEAD",
      spec: "test",
      excludeUntrackedRoots: [runs],
    });

    expect(evidence.changedFiles).toEqual(["runs-adjacent.txt"]);
    expect(evidence.diff).not.toContain("PRIOR-RUN-SENTINEL");
  });

  test("an exact untracked output file can be excluded without hiding its neighbours", () => {
    const path = repo();
    const events = join(path, "events.jsonl");
    writeFileSync(events, "TOOL-EVENT-SENTINEL\n");
    writeFileSync(join(path, "events-notes.md"), "keep this\n");

    const evidence = collectEvidence({
      repo: path,
      base: "HEAD",
      spec: "test",
      excludeUntrackedRoots: [events],
    });

    expect(evidence.changedFiles).toEqual(["events-notes.md"]);
    expect(evidence.diff).not.toContain("TOOL-EVENT-SENTINEL");
  });

  test("preserves unusual filenames returned by git", () => {
    const path = repo();
    const filename = " leading space\nand newline.ts";
    writeFileSync(join(path, filename), "export const unusual = true;\n");

    const evidence = collectEvidence({ repo: path, base: "HEAD", spec: "test" });

    expect(evidence.changedFiles).toContain(filename);
    expect(evidence.diff).toContain("export const unusual = true;");
  });

  test("rejects exclusion roots outside the evidence repository", () => {
    const path = repo();
    expect(() => collectEvidence({
      repo: path,
      base: "HEAD",
      spec: "test",
      excludeUntrackedRoots: [join(path, "..", "other-repo", "runs")],
    })).toThrow("untracked exclusion root must be inside");
  });
});

describe("collectEvidence pre/post test consistency", () => {
  test("passes when an ordinary test leaves the repo unchanged", () => {
    const path = repo();
    const evidence = collectEvidence({
      repo: path,
      base: "HEAD",
      spec: "test",
      testCmd: "true",
    });
    expect(evidence.test?.exitCode).toBe(0);
  });

  test("passes when the test only writes a gitignored build artifact", () => {
    const path = repo();
    writeFileSync(join(path, ".gitignore"), "dist/\n");
    runGit(path, "add", ".gitignore");
    runGit(path, "commit", "--quiet", "-m", "ignore dist");

    const evidence = collectEvidence({
      repo: path,
      base: "HEAD",
      spec: "test",
      testCmd: "mkdir -p dist && echo built > dist/out.js",
    });
    expect(evidence.test?.exitCode).toBe(0);
  });

  test("retains mutation and test evidence without resetting the source", () => {
    const path = repo();
    let caught: unknown;
    try {
      collectEvidence({
        repo: path,
        base: "HEAD",
        spec: "test",
        testCmd: "echo mutated >> tracked.ts; echo PASS",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvidenceConsistencyError);
    const error = caught as EvidenceConsistencyError;
    expect(error.before.rawDiff).toBe("");
    expect(error.after.rawDiff).toContain("+mutated");
    expect(error.test).toEqual({
      command: "echo mutated >> tracked.ts; echo PASS",
      exitCode: 0,
      output: "PASS\n",
    });
    expect(readFileSync(join(path, "tracked.ts"), "utf8")).toContain("mutated");
  });

  test("rejects a test that writes a new, non-ignored untracked source file", () => {
    const path = repo();
    expect(() =>
      collectEvidence({
        repo: path,
        base: "HEAD",
        spec: "test",
        testCmd: "echo 'export const sneaky = true;' > sneaky.ts",
      }),
    ).toThrow(EvidenceConsistencyError);
  });

  test("rejects a test that commits, moving HEAD", () => {
    const path = repo();
    expect(() =>
      collectEvidence({
        repo: path,
        base: "HEAD",
        spec: "test",
        testCmd: 'echo x >> tracked.ts && git add tracked.ts && git commit --quiet -m "sneaky"',
      }),
    ).toThrow(EvidenceConsistencyError);
  });

  test("rejects a mutation hidden in the truncated middle of a large diff", () => {
    const path = repo();
    const file = join(path, "large.txt");
    writeFileSync(file, `${"a".repeat(6000)}X${"b".repeat(6000)}`);

    let thrown: unknown;
    try {
      collectEvidence({
        repo: path,
        base: "HEAD",
        spec: "test",
        maxDiffChars: 1000,
        testCmd: `printf '${"a".repeat(6000)}Y${"b".repeat(6000)}' > large.txt`,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EvidenceConsistencyError);
    const err = thrown as EvidenceConsistencyError;
    expect(err.before.rawDiff).not.toBe(err.after.rawDiff);
  });

  test("respects excludeUntrackedRoots when checking for test-induced changes", () => {
    const path = repo();
    const runs = join(path, "runs");
    const evidence = collectEvidence({
      repo: path,
      base: "HEAD",
      spec: "test",
      excludeUntrackedRoots: [runs],
      testCmd: "mkdir -p runs && echo output > runs/result.json",
    });
    expect(evidence.test?.exitCode).toBe(0);
  });
});
