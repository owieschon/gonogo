/**
 * Content-addressed record/replay for raw judge output.
 *
 * The v2 identity includes the backend and gonogo instrument version. A model
 * requested explicitly by the backend is also part of the identity check. If
 * the backend selects its own model, the recorded model is still retained and
 * a second recording with a different model conflicts instead of replacing it.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CACHE_SCHEMA = "gonogo/replay@2" as const;
const LEGACY_COMPATIBLE_INSTRUMENT_VERSIONS = new Set(["0.1.0", "0.1.1"]);
const LEGACY_BACKEND = "claude-cli";

export interface CacheKey {
  promptHash: string;
  evidenceHash: string;
  sample: number;
  backend: string;
  instrumentVersion: string;
  /** Model requested before invocation. Undefined means the backend chooses. */
  model?: string;
}

export function hashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function identityDirectory(key: CacheKey): string {
  return hashOf(
    `${key.backend}\u0000${key.instrumentVersion}\u0000${key.model ?? "<backend-selected>"}`,
  ).slice(0, 16);
}

function entryPath(dir: string, key: CacheKey): string {
  return join(
    dir,
    "v2",
    identityDirectory(key),
    key.promptHash.slice(0, 16),
    `${key.evidenceHash.slice(0, 16)}-${key.sample}.json`,
  );
}

function legacyEntryPath(dir: string, key: CacheKey): string {
  return join(
    dir,
    key.promptHash.slice(0, 16),
    `${key.evidenceHash.slice(0, 16)}-${key.sample}.json`,
  );
}

interface StoredCacheKey extends CacheKey {
  /** Retained explicitly so a truncated-path collision is detectable. */
  promptHashFull: string;
  evidenceHashFull: string;
}

export interface CacheEntry {
  schema?: typeof CACHE_SCHEMA;
  key: StoredCacheKey;
  recorded_at: string;
  model_version: string;
  backend: string;
  instrument_version?: string;
  latency_ms: number;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** Provider text, or the backend's normalized structured output, retained without later scoring edits. */
  text: string;
}

export type CachePayload = Omit<CacheEntry, "schema" | "key" | "instrument_version">;

/**
 * Build the exact immutable receipt written by writeCache. Callers that retain
 * a run-local sidecar use this builder so its digest cannot diverge from the
 * replay artifact for the same provider call.
 */
export function buildCacheEntry(key: CacheKey, entry: CachePayload): CacheEntry {
  return {
    schema: CACHE_SCHEMA,
    key: {
      ...key,
      promptHashFull: key.promptHash,
      evidenceHashFull: key.evidenceHash,
    },
    ...entry,
    instrument_version: key.instrumentVersion,
  };
}

/** Canonical replay-receipt bytes: pretty JSON followed by one newline. */
export function serializeCacheEntry(entry: CacheEntry): string {
  return JSON.stringify(entry, null, 2) + "\n";
}

function parseEntry(path: string): CacheEntry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid replay receipt at ${path}: ${String(error)}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error(`invalid replay receipt at ${path}: expected a JSON object`);
  }
  return raw as CacheEntry;
}

function mismatch(path: string, field: string, expected: unknown, actual: unknown): never {
  throw new Error(
    `replay receipt identity conflict at ${path}: ${field} is ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)}. Do not reuse this receipt; record into a new cache directory ` +
      `or remove it only after verifying its provenance.`,
  );
}

function validateEntry(path: string, key: CacheKey, entry: CacheEntry, legacy: boolean): CacheEntry {
  const stored = entry.key as Partial<StoredCacheKey> | undefined;
  if (!stored) mismatch(path, "key", "a complete key", stored);
  if (stored.promptHash !== key.promptHash) mismatch(path, "prompt hash", key.promptHash, stored.promptHash);
  if (stored.evidenceHash !== key.evidenceHash) {
    mismatch(path, "evidence hash", key.evidenceHash, stored.evidenceHash);
  }
  if (stored.promptHashFull !== undefined && stored.promptHashFull !== key.promptHash) {
    mismatch(path, "full prompt hash", key.promptHash, stored.promptHashFull);
  }
  if (stored.evidenceHashFull !== undefined && stored.evidenceHashFull !== key.evidenceHash) {
    mismatch(path, "full evidence hash", key.evidenceHash, stored.evidenceHashFull);
  }
  if (stored.sample !== key.sample) mismatch(path, "sample", key.sample, stored.sample);
  if (entry.backend !== key.backend) mismatch(path, "backend", key.backend, entry.backend);

  if (legacy) {
    // v1 receipts predate an instrument field. Compatibility is intentionally
    // narrow: the committed Claude raw replies may exercise the 0.1.0 parser
    // and its 0.1.1 hardening because full prompt and evidence hashes still
    // have to match. Replayed events never enter calibration statistics.
    if (!LEGACY_COMPATIBLE_INSTRUMENT_VERSIONS.has(key.instrumentVersion)) {
      mismatch(path, "instrument version", key.instrumentVersion, "legacy/unknown");
    }
    // v1 retained only the resolved model. An explicit request is compatible
    // only when it names that exact version; aliases cannot be proven equal.
    if (key.model !== undefined && entry.model_version !== key.model) {
      mismatch(path, "model", key.model, entry.model_version);
    }
    return entry;
  }

  if (entry.schema !== CACHE_SCHEMA) mismatch(path, "schema", CACHE_SCHEMA, entry.schema);
  if (stored.backend !== key.backend) mismatch(path, "key.backend", key.backend, stored.backend);
  if (stored.model !== key.model) mismatch(path, "key.model", key.model, stored.model);
  if (stored.instrumentVersion !== key.instrumentVersion) {
    mismatch(path, "key.instrumentVersion", key.instrumentVersion, stored.instrumentVersion);
  }
  if (entry.instrument_version !== key.instrumentVersion) {
    mismatch(path, "instrument_version", key.instrumentVersion, entry.instrument_version);
  }
  return entry;
}

export function readCache(dir: string, key: CacheKey): CacheEntry | null {
  const path = entryPath(dir, key);
  if (existsSync(path)) return validateEntry(path, key, parseEntry(path), false);

  if (
    key.backend === LEGACY_BACKEND &&
    LEGACY_COMPATIBLE_INSTRUMENT_VERSIONS.has(key.instrumentVersion)
  ) {
    const legacyPath = legacyEntryPath(dir, key);
    if (existsSync(legacyPath)) return validateEntry(legacyPath, key, parseEntry(legacyPath), true);
  }
  return null;
}

function equivalentReceipt(a: CacheEntry, b: CacheEntry): boolean {
  // recorded_at is not content identity: retrying the exact recording is safe
  // and idempotent, but a different stochastic reply or provenance is not.
  const { recorded_at: _a, ...left } = a;
  const { recorded_at: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Publish one receipt atomically. A hard link supplies create-if-absent
 * semantics that rename does not: readers see the whole file, and an existing
 * receipt can never be overwritten in the race between checking and writing.
 */
export function writeCache(dir: string, key: CacheKey, entry: CachePayload): void {
  if (entry.backend !== key.backend) {
    throw new Error(`cannot record replay receipt: response backend ${entry.backend} does not match ${key.backend}`);
  }

  const path = entryPath(dir, key);
  mkdirSync(dirname(path), { recursive: true });
  const full = buildCacheEntry(key, entry);

  const temp = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, serializeCacheEntry(full));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, path);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = validateEntry(path, key, parseEntry(path), false);
      if (!equivalentReceipt(existing, full)) {
        throw new Error(
          `replay receipt already exists at ${path} with different model, output, or provenance. ` +
            `Record this stochastic sample into a new cache directory or use a different sample index.`,
        );
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function describeMiss(dir: string, key: CacheKey): string {
  const model = key.model === undefined ? "backend-selected model" : `model ${key.model}`;
  return (
    `no recorded judge output at ${entryPath(dir, key)} for backend ${key.backend}, ` +
    `instrument ${key.instrumentVersion}, and ${model}.\n` +
    `  --replay serves recorded output only. Either the prompt, evidence, backend,\n` +
    `  model, or instrument changed, or this sample was never recorded. Re-record\n` +
    `  with --record against a live judge.`
  );
}
