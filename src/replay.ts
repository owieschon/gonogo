/**
 * Content-addressed record/replay for raw judge output.
 *
 * Keyed by (prompt hash, evidence hash, sample index). The sample index is part
 * of the key on purpose: judges are stochastic, `gonogo eval` measures that
 * stochasticity across k runs, and a purely content-addressed cache would
 * collapse all k samples of one fixture into a single entry and quietly report
 * zero variance.
 *
 * The honest limit, stated here and in the README: replay tests the pipeline,
 * not the model. Recorded output cannot move when a prompt changes, so a replay
 * run can never catch a prompt regression.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheKey {
  promptHash: string;
  evidenceHash: string;
  sample: number;
}

export function hashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function entryPath(dir: string, key: CacheKey): string {
  return join(
    dir,
    key.promptHash.slice(0, 16),
    `${key.evidenceHash.slice(0, 16)}-${key.sample}.json`,
  );
}

export interface CacheEntry {
  key: CacheKey & { promptHashFull: string; evidenceHashFull: string };
  recorded_at: string;
  model_version: string;
  backend: string;
  latency_ms: number;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** The judge's reply, verbatim. Never reformatted. */
  text: string;
}

export function readCache(dir: string, key: CacheKey): CacheEntry | null {
  const p = entryPath(dir, key);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
}

export function writeCache(dir: string, key: CacheKey, entry: Omit<CacheEntry, "key">): void {
  const p = entryPath(dir, key);
  mkdirSync(join(p, ".."), { recursive: true });
  const full: CacheEntry = {
    key: {
      ...key,
      promptHashFull: key.promptHash,
      evidenceHashFull: key.evidenceHash,
    },
    ...entry,
  };
  writeFileSync(p, JSON.stringify(full, null, 2) + "\n");
}

export function describeMiss(dir: string, key: CacheKey): string {
  return (
    `no recorded judge output at ${entryPath(dir, key)}.\n` +
    `  --replay serves recorded output only. Either the prompts changed (the prompt\n` +
    `  hash is part of the key), the evidence changed, or this sample was never\n` +
    `  recorded. Re-record with --record against a live judge.`
  );
}
