/**
 * Evaluation packet contract: an offline, read-only check that a versioned,
 * frozen packet is eligible for review before any reviewer sees it.
 *
 * This validates packaging integrity — declared identity against actual
 * bytes, arm consistency, exposure eligibility, and named forbidden markers.
 * It is not a semantic leakage detector: free text can carry meaning this
 * check cannot see, and passing here is not a claim of a clean review.
 *
 * `subject_hash` (subject.ts) is the raw, pre-elision evidence identity.
 * `evidence_hash` here is the identity of what a reviewer is actually shown
 * for one arm. Two arms of the same case must share the same subject_hash
 * (same underlying evidence) even though each may render a different
 * evidence_hash; the two are never treated as interchangeable.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { subjectHashOf, type SubjectInput } from "./subject.ts";

export const PACKET_SCHEMA = "gonogo/eval-packet@1" as const;

export const DISQUALIFY_REASONS = [
  "malformed_metadata",
  "missing_identity",
  "protocol_digest_mismatch",
  "payload_digest_mismatch",
  "arm_evidence_mismatch",
  "unknown_provenance",
  "unknown_exposure_state",
  "forbidden_review_material",
  "exposed_case_claims_untouched",
] as const;

export type DisqualifyReason = (typeof DISQUALIFY_REASONS)[number];

export interface PacketFile {
  path: string;
  sha256: string;
}

export interface EvaluationArm {
  name: string;
  /** Path, relative to the packet directory, to a JSON SubjectInput payload. */
  payload_path: string;
  /** Declared identity of the raw evidence in `payload_path`; recomputed and checked. */
  subject_hash: string;
  /** Declared identity of what this arm shows the reviewer; recomputed and checked. */
  evidence_hash: string;
  /** Exact bytes shown to the reviewer for this arm; each entry's sha256 is checked. */
  review_files: PacketFile[];
}

export interface EvaluationPacket {
  schema: typeof PACKET_SCHEMA;
  packet_version: string;
  case_id: string;
  /** "known" is the only provenance that can pass; "unknown" fails closed. */
  provenance: "known" | "unknown";
  /** "untouched" is checked against the exposure log; "unknown" fails closed. */
  exposure: "untouched" | "development" | "unknown";
  /** Frozen protocol document(s), e.g. METHODS.md, checked byte-for-byte. */
  protocol_files: PacketFile[];
  /** Frozen judge instrument/prompt files, checked byte-for-byte. */
  instrument_files: PacketFile[];
  /** At least one arm; two or more arms are a paired comparison. */
  arms: EvaluationArm[];
  /** Exact strings that must not appear in any review_files content. */
  forbidden_markers: string[];
}

export interface ValidationFailure {
  reason: DisqualifyReason;
  detail: string;
}

export type ValidationResult =
  | {
      ok: true;
      case_id: string;
      subject_hash: string;
      /** False for a labeled development case, even when every check passes. */
      holdout_eligible: boolean;
    }
  | { ok: false; case_id: string | null; failures: ValidationFailure[] };

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256OfFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Validate and check a declared file list. Every element is treated as
 * untrusted input straight from parsed JSON: a non-object, a missing path or
 * a malformed digest is a named refusal, never a thrown TypeError. Returns
 * only the entries that were well-formed enough to be checked against disk,
 * so a caller can still tell "nothing declared" from "declared and clean".
 */
function checkFiles(
  root: string,
  label: string,
  files: unknown[],
  reason: DisqualifyReason,
  failures: ValidationFailure[],
): PacketFile[] {
  const wellFormed: PacketFile[] = [];
  for (const entry of files) {
    if (!isPlainObject(entry)) {
      failures.push({ reason: "malformed_metadata", detail: `${label}: a declared file entry is not an object` });
      continue;
    }
    const f = entry as { path?: unknown; sha256?: unknown };
    if (typeof f.path !== "string" || f.path.trim() === "") {
      failures.push({ reason: "malformed_metadata", detail: `${label}: a declared file is missing a path` });
      continue;
    }
    if (typeof f.sha256 !== "string" || !SHA256_HEX.test(f.sha256)) {
      failures.push({
        reason: "malformed_metadata",
        detail: `${f.path}: declared sha256 is not a lowercase 64-character hex digest`,
      });
      continue;
    }
    const declared: PacketFile = { path: f.path, sha256: f.sha256 };
    const actual = sha256OfFile(resolve(root, declared.path));
    if (actual === null) {
      failures.push({ reason, detail: `${declared.path}: file is missing` });
    } else if (actual !== declared.sha256) {
      failures.push({
        reason,
        detail: `${declared.path}: declared sha256 ${declared.sha256} does not match actual ${actual}`,
      });
    } else {
      wellFormed.push(declared);
    }
  }
  return wellFormed;
}

/** Deterministic identity of exactly what a reviewer is shown for one arm. */
function renderedEvidenceHash(root: string, files: PacketFile[]): string {
  const parts = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${sha256OfFile(resolve(root, f.path)) ?? "MISSING"}`);
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate one packet directory against `packet.json` inside it.
 *
 * Offline and read-only: makes no judge calls, mutates nothing, and leaves
 * every input file untouched whether validation passes or fails.
 *
 * `exposedCaseIds` is the operator's own exposure log (case ids known to be
 * development cases or otherwise seen), read by the caller and passed in —
 * this function never discovers or writes it.
 */
export function validatePacket(packetDir: string, exposedCaseIds: ReadonlySet<string>): ValidationResult {
  const manifestPath = join(packetDir, "packet.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      case_id: null,
      failures: [
        {
          reason: "malformed_metadata",
          detail: `${manifestPath} is missing or not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, case_id: null, failures: [{ reason: "malformed_metadata", detail: "packet.json is not an object" }] };
  }

  const failures: ValidationFailure[] = [];
  const caseId = typeof raw.case_id === "string" && raw.case_id.trim() !== "" ? raw.case_id : null;
  if (caseId === null) {
    failures.push({ reason: "missing_identity", detail: "packet.json case_id is missing or empty" });
  }

  if (raw.schema !== PACKET_SCHEMA) {
    failures.push({
      reason: "malformed_metadata",
      detail: `packet.json schema is "${String(raw.schema)}", expected "${PACKET_SCHEMA}"`,
    });
  }
  if (typeof raw.packet_version !== "string" || raw.packet_version.trim() === "") {
    failures.push({ reason: "malformed_metadata", detail: "packet.json packet_version is missing or empty" });
  }

  const provenance = raw.provenance;
  if (provenance !== "known" && provenance !== "unknown") {
    failures.push({ reason: "malformed_metadata", detail: `packet.json provenance must be "known" or "unknown"` });
  } else if (provenance === "unknown") {
    failures.push({ reason: "unknown_provenance", detail: "packet declares unknown provenance" });
  }

  const exposure = raw.exposure;
  if (exposure !== "untouched" && exposure !== "development" && exposure !== "unknown") {
    failures.push({
      reason: "malformed_metadata",
      detail: `packet.json exposure must be "untouched", "development" or "unknown"`,
    });
  } else if (exposure === "unknown") {
    failures.push({ reason: "unknown_exposure_state", detail: "packet declares unknown exposure" });
  } else if (exposure === "untouched" && caseId !== null && exposedCaseIds.has(caseId)) {
    failures.push({
      reason: "exposed_case_claims_untouched",
      detail: `case ${caseId} appears in the exposure log and cannot be declared untouched`,
    });
  }

  const protocolFiles = Array.isArray(raw.protocol_files) ? raw.protocol_files : null;
  if (protocolFiles === null) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json protocol_files must be an array" });
  } else if (protocolFiles.length === 0) {
    failures.push({
      reason: "missing_identity",
      detail: "packet.json protocol_files declares no frozen protocol document",
    });
  } else {
    checkFiles(packetDir, "protocol_files", protocolFiles, "protocol_digest_mismatch", failures);
  }

  const instrumentFiles = Array.isArray(raw.instrument_files) ? raw.instrument_files : null;
  if (instrumentFiles === null) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json instrument_files must be an array" });
  } else if (instrumentFiles.length === 0) {
    failures.push({
      reason: "missing_identity",
      detail: "packet.json instrument_files declares no frozen judge instrument",
    });
  } else {
    checkFiles(packetDir, "instrument_files", instrumentFiles, "payload_digest_mismatch", failures);
  }

  const forbiddenMarkers = Array.isArray(raw.forbidden_markers)
    ? (raw.forbidden_markers as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  if (!Array.isArray(raw.forbidden_markers)) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json forbidden_markers must be an array of strings" });
  }

  const arms = Array.isArray(raw.arms) ? (raw.arms as EvaluationArm[]) : null;
  const subjectHashes: string[] = [];
  if (arms === null || arms.length === 0) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json arms must be a non-empty array" });
  } else {
    for (const arm of arms) {
      if (
        !isPlainObject(arm) ||
        typeof (arm as { name?: unknown }).name !== "string" ||
        typeof arm.payload_path !== "string" ||
        !SHA256_HEX.test(arm.subject_hash ?? "") ||
        !SHA256_HEX.test(arm.evidence_hash ?? "") ||
        !Array.isArray(arm.review_files)
      ) {
        failures.push({ reason: "malformed_metadata", detail: "an arm is missing a required field" });
        continue;
      }

      if (arm.review_files.length === 0) {
        failures.push({
          reason: "missing_identity",
          detail: `${arm.name}: review_files declares nothing shown to the reviewer`,
        });
        continue;
      }
      const wellFormedReviewFiles = checkFiles(
        packetDir,
        `${arm.name}.review_files`,
        arm.review_files,
        "payload_digest_mismatch",
        failures,
      );
      const reviewFilesFullyWellFormed = wellFormedReviewFiles.length === arm.review_files.length;
      for (const marker of forbiddenMarkers) {
        for (const f of wellFormedReviewFiles) {
          const abs = resolve(packetDir, f.path);
          if (!existsSync(abs)) continue;
          if (readFileSync(abs, "utf8").includes(marker)) {
            failures.push({
              reason: "forbidden_review_material",
              detail: `${arm.name}/${f.path} contains forbidden marker "${marker}"`,
            });
          }
        }
      }

      const payloadAbs = resolve(packetDir, arm.payload_path);
      if (!existsSync(payloadAbs)) {
        failures.push({ reason: "payload_digest_mismatch", detail: `${arm.name}: payload ${arm.payload_path} is missing` });
        continue;
      }
      let payload: SubjectInput;
      try {
        payload = JSON.parse(readFileSync(payloadAbs, "utf8"));
      } catch (error) {
        failures.push({
          reason: "malformed_metadata",
          detail: `${arm.name}: payload ${arm.payload_path} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
      const actualSubjectHash = subjectHashOf(payload);
      if (actualSubjectHash !== arm.subject_hash) {
        failures.push({
          reason: "payload_digest_mismatch",
          detail: `${arm.name}: declared subject_hash does not match the actual payload bytes`,
        });
      } else {
        subjectHashes.push(actualSubjectHash);
      }

      if (reviewFilesFullyWellFormed) {
        const actualEvidenceHash = renderedEvidenceHash(packetDir, wellFormedReviewFiles);
        if (actualEvidenceHash !== arm.evidence_hash) {
          failures.push({
            reason: "payload_digest_mismatch",
            detail: `${arm.name}: declared evidence_hash does not match the actual review material`,
          });
        }
      }
    }
    if (arms !== null && arms.length >= 2 && subjectHashes.length === arms.length) {
      const distinct = new Set(subjectHashes);
      if (distinct.size > 1) {
        failures.push({
          reason: "arm_evidence_mismatch",
          detail: "comparison arms do not share the same underlying evidence (subject_hash differs)",
        });
      }
    }
  }

  if (failures.length > 0) {
    return { ok: false, case_id: caseId, failures };
  }

  return {
    ok: true,
    case_id: caseId!,
    subject_hash: subjectHashes[0]!,
    holdout_eligible: exposure === "untouched",
  };
}
