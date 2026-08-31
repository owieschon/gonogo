/** Evidence collection: everything the judge is allowed to look at. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Evidence, TestResult } from "./types.ts";

const MAX_DIFF_CHARS = 120_000;
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_TEST_OUTPUT_CHARS = 20_000;

export function git(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${repo} (${r.status}): ${r.stderr?.trim()}`,
    );
  }
  return r.stdout;
}

/**
 * Untracked files are part of the agent's work but invisible to `git diff`.
 * Synthesise a diff for them so the judge sees new files it would otherwise miss.
 */
function untrackedDiff(repo: string): string {
  const listing = git(repo, ["ls-files", "--others", "--exclude-standard"]);
  const files = listing.split("\n").map((f) => f.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const f of files) {
    const r = spawnSync("git", ["-C", repo, "diff", "--no-index", "--", "/dev/null", f], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.stdout) parts.push(r.stdout);
  }
  return parts.join("");
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.3));
  return {
    text: `${head}\n\n[... ${s.length - max} characters elided by gonogo ...]\n\n${tail}`,
    truncated: true,
  };
}

export function runTests(repo: string, cmd: string): TestResult {
  const r = spawnSync(cmd, {
    cwd: repo,
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    command: cmd,
    exitCode: r.status === null ? 124 : r.status,
    output: truncate(raw, MAX_TEST_OUTPUT_CHARS).text,
  };
}

export interface CollectOptions {
  repo: string;
  base: string;
  spec: string;
  transcriptPath?: string;
  testCmd?: string;
}

export function collectEvidence(opts: CollectOptions): Evidence {
  const repo = resolve(opts.repo);
  if (!existsSync(join(repo, ".git"))) {
    throw new Error(`${repo} is not a git repository (no .git directory)`);
  }
  // Resolve the base ref up front so provenance records a sha, not a moving name.
  let baseSha: string;
  try {
    baseSha = git(repo, ["rev-parse", opts.base]).trim();
  } catch {
    throw new Error(
      `base ref "${opts.base}" does not resolve in ${repo}. Pass --base with a ref that exists.`,
    );
  }
  const head = git(repo, ["rev-parse", "HEAD"]).trim();

  // Worktree-vs-base, so committed and uncommitted agent work are both seen.
  const tracked = git(repo, ["diff", baseSha]);
  const rawDiff = tracked + untrackedDiff(repo);
  const diffStat = git(repo, ["diff", "--stat", baseSha]).trim();
  const changedFiles = git(repo, ["diff", "--name-only", baseSha])
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .concat(
      git(repo, ["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean),
    );

  const diff = truncate(rawDiff, MAX_DIFF_CHARS);

  let transcript: { text: string; truncated: boolean } | null = null;
  if (opts.transcriptPath) {
    // Opaque text on purpose: no format-specific parsing today.
    transcript = truncate(readFileSync(opts.transcriptPath, "utf8"), MAX_TRANSCRIPT_CHARS);
  }

  const test = opts.testCmd ? runTests(repo, opts.testCmd) : null;

  return {
    repo,
    base: baseSha,
    head,
    diff: diff.text,
    diffStat,
    changedFiles: [...new Set(changedFiles)],
    spec: opts.spec,
    transcript: transcript?.text ?? null,
    test,
    truncated: { diff: diff.truncated, transcript: transcript?.truncated ?? false },
  };
}

/** Persist raw evidence so a verdict can be re-read against what the judge saw. */
export function writeEvidence(dir: string, ev: Evidence): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), ev.spec);
  writeFileSync(join(dir, "diff.patch"), ev.diff);
  writeFileSync(join(dir, "changed-files.txt"), ev.changedFiles.join("\n") + "\n");
  writeFileSync(join(dir, "diffstat.txt"), ev.diffStat + "\n");
  if (ev.transcript !== null) writeFileSync(join(dir, "transcript.txt"), ev.transcript);
  if (ev.test) {
    writeFileSync(
      join(dir, "test-result.txt"),
      `$ ${ev.test.command}\nexit code: ${ev.test.exitCode}\n\n${ev.test.output}`,
    );
  }
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      { repo: ev.repo, base: ev.base, head: ev.head, truncated: ev.truncated },
      null,
      2,
    ) + "\n",
  );
}
