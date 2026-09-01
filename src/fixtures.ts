/** Materialise a fixture into a throwaway git repo the judge can diff. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

export interface FixtureLabels {
  /** Inclusive [min, max] the judge's score must land in for each dimension. */
  dimensions: Record<string, [number, number]>;
  expected_verdicts: string[];
  /** Which failure mode this fixture represents; checked when present. */
  expected_drift_type?: string;
  /** Named assertions this fixture exists to enforce; printed by `gonogo eval`. */
  core_checks?: {
    id: string;
    /** Either a dimension bound... */
    dimension?: string;
    max?: number;
    min?: number;
    /** ...or a boolean verdict flag. */
    flag?: "attempted_gaming";
    equals?: boolean;
    why: string;
  }[];
  notes?: string;
}

export interface Fixture {
  name: string;
  dir: string;
  description: string;
  spec: string;
  testCmd?: string;
  transcriptPath?: string;
  labels: FixtureLabels;
}

export function listFixtures(root: string): Fixture[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "fixture.json")))
    .map((e) => loadFixture(join(root, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadFixture(dir: string): Fixture {
  const meta = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
  const transcript = join(dir, "transcript.txt");
  return {
    name: meta.name,
    dir,
    description: meta.description ?? "",
    spec: readFileSync(join(dir, "spec.md"), "utf8"),
    testCmd: meta.testCmd,
    transcriptPath: existsSync(transcript) ? transcript : undefined,
    labels: JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")),
  };
}

function g(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/**
 * base/ becomes the base commit; head/ replaces the worktree. The agent's work
 * is therefore uncommitted, which is also how `scripts/self-judge.sh` runs.
 * Returns the repo path and the base sha; caller owns cleanup.
 */
export function materialize(fx: Fixture): { repo: string; base: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), `gonogo-fx-${fx.name}-`));
  cpSync(join(fx.dir, "base"), repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  g(repo, ["config", "user.email", "fixtures@gonogo.invalid"]);
  g(repo, ["config", "user.name", "gonogo fixtures"]);
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "base: state before the agent ran"]);
  const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  for (const entry of readdirSync(repo)) {
    if (entry === ".git") continue;
    rmSync(join(repo, entry), { recursive: true, force: true });
  }
  cpSync(join(fx.dir, "head"), repo, { recursive: true });

  return { repo, base, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

export function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}
