import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CacheEntry, CacheKey } from "./replay.ts";
import { serializeCacheEntry } from "./replay.ts";
import type { JudgeCallRole } from "./types.ts";
import type { JudgePassSource } from "./types.ts";

export type CallFailureStage = "backend" | "parse" | "validation" | "receipt";

export interface CallFailureReceipt {
  schema: "gonogo/call-failure@1";
  role: JudgeCallRole;
  stage: CallFailureStage;
  recorded_at: string;
  key: CacheKey;
  /** Digest of the adjacent replay receipt, or null when no response was returned. */
  receipt_sha256: string | null;
  error: string;
}

export interface CallEvidenceSink {
  receipt(role: JudgeCallRole, receipt: CacheEntry, source: JudgePassSource): void;
  failure(failure: CallFailureReceipt): void;
}

function writeNew(path: string, bytes: string): void {
  try {
    writeFileSync(path, bytes, { flag: "wx" });
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error(`call evidence already exists at ${path}; refusing to overwrite it`);
    }
    throw error;
  }
}

/**
 * Persist role-named run-local evidence without replacement. Replay receipts
 * retain their canonical bytes; validation failures live beside, not inside,
 * the provider receipt so the latter remains replay-compatible.
 */
export function fileCallEvidenceSink(evidenceDir: string): CallEvidenceSink {
  const callsDir = join(evidenceDir, "calls");
  mkdirSync(callsDir, { recursive: true });
  return {
    receipt(role, receipt, _source) {
      writeNew(join(callsDir, `${role}.receipt.json`), serializeCacheEntry(receipt));
    },
    failure(failure) {
      writeNew(
        join(callsDir, `${failure.role}.failure.json`),
        JSON.stringify(failure, null, 2) + "\n",
      );
    },
  };
}
