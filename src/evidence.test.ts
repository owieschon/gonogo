import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectEvidence } from "./evidence.ts";

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
