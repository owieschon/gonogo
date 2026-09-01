/** Evidence collection: everything the judge is allowed to look at. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Evidence, TestResult } from "./types.ts";
import { subjectHashOf } from "./subject.ts";

const DEFAULT_MAX_DIFF_CHARS = 120_000;
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
function nulSeparatedGit(repo: string, args: string[]): string[] {
  const output = git(repo, [...args, "-z"]);
  if (output === "") return [];
  const files = output.split("\0");
  if (files.at(-1) === "") files.pop();
  return files;
}

function noIndexDiff(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, "diff", "--no-index", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  // `git diff --no-index` uses 1 for an ordinary difference.
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(
      `git diff --no-index ${args.join(" ")} failed in ${repo} (${r.status}): ${r.stderr?.trim()}`,
    );
  }
  return r.stdout ?? "";
}

function untrackedDiff(repo: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const diff = noIndexDiff(repo, ["--", "/dev/null", f]);
    if (diff) parts.push(diff);
  }
  return parts.join("");
}

function repoRelativeRoots(repo: string, roots: string[]): string[] {
  return [...new Set(roots.map((root) => {
    const absolute = isAbsolute(root) ? resolve(root) : resolve(repo, root);
    const path = relative(repo, absolute);
    if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error(`untracked exclusion root must be inside ${repo}: ${root}`);
    }
    // Git always reports paths with forward slashes, including on Windows.
    return path.split(sep).join("/").replace(/\/$/, "");
  }))];
}

function outsideRoots(path: string, roots: string[]): boolean {
  return !roots.some((root) => path === root || path.startsWith(`${root}/`));
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

interface TestCapture {
  visible: TestResult;
  complete: TestResult;
}

function captureTests(repo: string, cmd: string): TestCapture {
  const r = spawnSync(cmd, {
    cwd: repo,
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const complete = {
    command: cmd,
    exitCode: r.status === null ? 124 : r.status,
    output: raw,
  };
  return {
    complete,
    visible: { ...complete, output: truncate(raw, MAX_TEST_OUTPUT_CHARS).text },
  };
}

export function runTests(repo: string, cmd: string): TestResult {
  return captureTests(repo, cmd).visible;
}

export interface CollectOptions {
  repo: string;
  base: string;
  spec: string;
  transcriptPath?: string;
  testCmd?: string;
  /** Raise for a large change; the judge sees eliding as a caveat on the verdict. */
  maxDiffChars?: number;
  /**
   * Repo-relative or absolute tool-owned directories to omit from untracked
   * evidence. This prevents a later run from judging artifacts of an earlier
   * run while preserving deliberately tracked fixture data.
   */
  excludeUntrackedRoots?: string[];
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
  const excludedRoots = repoRelativeRoots(repo, opts.excludeUntrackedRoots ?? []);
  const untrackedFiles = nulSeparatedGit(repo, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).filter((path) => outsideRoots(path, excludedRoots));

  // Worktree-vs-base, so committed and uncommitted agent work are both seen.
  const tracked = git(repo, ["diff", baseSha]);
  const rawDiff = tracked + untrackedDiff(repo, untrackedFiles);
  const diffStat = git(repo, ["diff", "--stat", baseSha]).trim();
  const changedFiles = nulSeparatedGit(repo, ["diff", "--name-only", baseSha])
    .concat(untrackedFiles);

  // RUBRIC.md counts commit messages as claims the agent made about its work,
  // alongside the transcript. Collect them or claim_verification is judging
  // half the record.
  const commitMessages = git(repo, [
    "log",
    "--no-merges",
    "--format=commit %h%n%B%n---",
    `${baseSha}..HEAD`,
  ]).trim();

  const diff = truncate(rawDiff, opts.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS);

  let transcriptRaw: string | null = null;
  let transcript: { text: string; truncated: boolean } | null = null;
  if (opts.transcriptPath) {
    // Opaque text on purpose: no format-specific parsing today.
    transcriptRaw = readFileSync(opts.transcriptPath, "utf8");
    transcript = truncate(transcriptRaw, MAX_TRANSCRIPT_CHARS);
  }

  const testCapture = opts.testCmd ? captureTests(repo, opts.testCmd) : null;
  const test = testCapture?.visible ?? null;

  return {
    subjectHash: subjectHashOf({
      spec: opts.spec,
      diff: rawDiff,
      commitMessages,
      transcript: transcriptRaw,
      test: testCapture?.complete ?? null,
    }),
    repo,
    base: baseSha,
    head,
    diff: diff.text,
    diffStat,
    changedFiles: [...new Set(changedFiles)],
    commitMessages,
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
  writeFileSync(join(dir, "commit-messages.txt"), ev.commitMessages + "\n");
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
      {
        repo: ev.repo,
        base: ev.base,
        head: ev.head,
        subject_hash: ev.subjectHash,
        truncated: ev.truncated,
      },
      null,
      2,
    ) + "\n",
  );
}
