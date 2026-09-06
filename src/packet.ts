/**
 * Evaluation packet contract: an offline, read-only check that a versioned,
 * frozen packet is eligible for review before any reviewer sees it.
 *
 * This validates packaging integrity — declared identity against actual
 * bytes, checked against an externally supplied expectation rather than the
 * packet's own say-so, plus role-based exclusion of answer/outcome/
 * post-cutoff material and exposure eligibility. It is not a semantic
 * leakage detector: free text can carry meaning no hash or role tag can see,
 * and passing here is not a claim of a clean review or of a real study.
 *
 * `subject_hash` (subject.ts) is the raw, pre-elision evidence identity.
 * `evidence_hash` here is the identity of what a reviewer is actually shown
 * for one arm. The two are never treated as interchangeable, but they are
 * tied together: every arm's `review_files` is required to equal, byte for
 * byte, `evidence.payload_file` — the exact same file `subject_hash` is
 * computed from, not a second file that merely claims to represent it — so
 * two arms showing different evidence, or a reviewer being shown something
 * other than what subject_hash covers, is a checked refusal
 * (`arm_evidence_mismatch`), not a gap left open by independently-declared,
 * unlinked hashes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { subjectHashOf, type SubjectInput } from "./subject.ts";

export const PACKET_SCHEMA = "gonogo/eval-packet@2" as const;

export const DISQUALIFY_REASONS = [
  "malformed_metadata",
  "missing_identity",
  "unsafe_path",
  "protocol_digest_mismatch",
  "payload_digest_mismatch",
  "unknown_provenance",
  "unknown_exposure_state",
  "forbidden_review_material",
  "exposed_case_claims_untouched",
  "exposure_record_not_supplied",
  "exposure_record_incomplete",
  "arm_evidence_mismatch",
] as const;

export type DisqualifyReason = (typeof DISQUALIFY_REASONS)[number];

/**
 * Declared role of one file. `review` and `instruction` are the only roles
 * allowed into an arm's reviewer-facing lists; `answer`, `outcome` and
 * `post_cutoff` exist so a packet can be honest about carrying such material
 * elsewhere (e.g. for later adjudication) while being structurally refused
 * if it appears in what a reviewer is actually shown. This is a declared-tag
 * check, not a scan for undeclared leakage.
 */
export const FILE_ROLES = [
  "protocol",
  "instrument",
  "review",
  "instruction",
  "answer",
  "outcome",
  "post_cutoff",
] as const;

export type FileRole = (typeof FILE_ROLES)[number];

const FORBIDDEN_IN_REVIEW_INPUT: readonly FileRole[] = ["answer", "outcome", "post_cutoff"];

export interface PacketFile {
  path: string;
  sha256: string;
  role: FileRole;
}

export const ARTIFACT_STATUSES = ["original", "missing", "reconstructed"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** Operator attestation, not proof: declared status of each evidence artifact. */
export interface ArtifactProvenance {
  spec: ArtifactStatus;
  diff: ArtifactStatus;
  commit_messages: ArtifactStatus;
  transcript: ArtifactStatus;
  test: ArtifactStatus;
}

/** Operator attestation, not proof: where the work under review came from. */
export interface SourceIdentity {
  repo: string;
  base: string;
  head: string;
}

/**
 * The one evidence collection every arm's declared review material must
 * reference. There is deliberately no per-arm evidence or subject_hash, and
 * deliberately no separate "rendering" of the payload: `payload_file` is
 * both the exact bytes `subject_hash` is computed from AND the exact bytes
 * every arm's `review_files` must consist of. Tying the declared
 * reviewer-facing reference directly to the subject-identity file — rather
 * than to a second, independently declared file that merely claims to
 * represent it — is what makes "the arms declare different evidence" (or "an
 * arm's declared material is something other than what subject_hash
 * covers") a structural impossibility (checked as `arm_evidence_mismatch`
 * below), not an inference from independently-declared, unlinked hashes.
 * This checks the declared reference and the bytes behind it, not that a
 * reviewer actually opened the file. No general rendering/redaction
 * framework: a packet that needs the reviewer to see something other than
 * the raw payload is out of scope for this check.
 */
export interface SharedEvidence {
  /** The one file every arm's review_files must reference; role must be "review". */
  payload_file: PacketFile;
  /** Declared identity of payload_file's parsed content; recomputed and checked. */
  subject_hash: string;
  source: SourceIdentity;
  artifact_provenance: ArtifactProvenance;
}

export interface EvaluationArm {
  name: string;
  /**
   * What this arm shows the reviewer as evidence. Must equal exactly
   * `[evidence.payload_file]` — same path, same sha256, same role — so no
   * arm can substitute different bytes, and what the reviewer sees is
   * provably the same bytes subject_hash was computed from. Extra
   * arm-specific material belongs in `instructions_files`, not here.
   */
  review_files: PacketFile[];
  /** Declared identity of what this arm shows the reviewer; recomputed and checked. */
  evidence_hash: string;
  /** Arm-specific instructions text, kept separate from evidence; role must be "instruction". */
  instructions_files?: PacketFile[];
}

export interface EvaluationPacket {
  schema: typeof PACKET_SCHEMA;
  packet_version: string;
  case_id: string;
  /** "known" is the only provenance that can pass; "unknown" fails closed. */
  provenance: "known" | "unknown";
  /** "untouched" is checked against the exposure log; "unknown" fails closed. */
  exposure: "untouched" | "development" | "unknown";
  /** Declared boundary; files tagged "post_cutoff" may never enter review input. */
  data_cutoff: string;
  evidence: SharedEvidence;
  /** Frozen protocol document(s), e.g. METHODS.md; checked against an external pin. */
  protocol_files: PacketFile[];
  /** Frozen judge instrument/prompt files, checked byte-for-byte. */
  instrument_files: PacketFile[];
  /** At least one arm; two or more arms are a paired comparison over shared evidence. */
  arms: EvaluationArm[];
  /** Exact strings that must not appear in any arm's review or instruction files. */
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
      /** False for a labeled development case or a reconstructed artifact, even when every check passes. */
      holdout_eligible: boolean;
    }
  | { ok: false; case_id: string | null; failures: ValidationFailure[] };

/**
 * Whether an "untouched" declaration is even checkable. A caller that
 * supplies no exposure record at all gets no default — "no record" and
 * "record with nothing in it" are different claims, and only the latter can
 * back an untouched declaration. Supplying a record is still not enough on
 * its own: `complete` is the operator's explicit assertion that the record
 * covers every case it should, and a bare id array with no such assertion
 * cannot support "untouched" either — a caller who only ever checked half
 * their history and forgot to say so would otherwise look identical to one
 * who checked everything. `coveredThrough`, when given, must reach at least
 * the packet's own `data_cutoff` or the record does not cover this packet's
 * declared window. None of this proves the record is historically true.
 */
export type ExposureCheck =
  | { supplied: true; complete: boolean; coveredThrough: string | null; exposedCaseIds: ReadonlySet<string> }
  | { supplied: false };

/**
 * A frozen protocol document's identity as pinned by someone other than the
 * packet itself — e.g. computed by the caller from their own trusted copy of
 * METHODS.md. Keyed by the exact `path` a protocol_files entry declares. A
 * packet cannot pass by only matching its own manifest's digest of itself.
 */
export type ExternalProtocolPin = ReadonlyMap<string, string>;

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A full, unabbreviated git object id. A prefix is not an identity: two different
 *  commits can share a short prefix, so only the complete hash is accepted. */
const GIT_SHA_FULL = /^[0-9a-f]{40}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFileRole(v: unknown): v is FileRole {
  return typeof v === "string" && (FILE_ROLES as readonly string[]).includes(v);
}

function isArtifactStatus(v: unknown): v is ArtifactStatus {
  return typeof v === "string" && (ARTIFACT_STATUSES as readonly string[]).includes(v);
}

/**
 * A real calendar date in exact `YYYY-MM-DD` form — anchored at both ends
 * (no trailing time component or garbage) and semantically valid (rejects
 * e.g. "2026-02-30", which `Date` would otherwise silently roll into March).
 */
export function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Resolve a declared relative path against the packet directory and refuse
 * anything that would read outside it — an absolute path, a `..` escape, or
 * (for a path that exists) a symlink whose real location is outside the
 * packet. Returns null for any of those; callers turn null into a named
 * refusal rather than reading the path.
 */
function resolveWithinPacket(root: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.trim() === "" || isAbsolute(relPath)) return null;
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  if (existsSync(abs)) {
    try {
      const realAbs = realpathSync(abs);
      const realRoot = realpathSync(root);
      const realRel = relative(realRoot, realAbs);
      if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return null;
    } catch {
      return null;
    }
  }
  return abs;
}

type FileRead = { ok: true; sha256: string } | { ok: false; error: string };

function readForDigest(absPath: string): FileRead {
  try {
    if (!existsSync(absPath)) return { ok: false, error: "file is missing" };
    return { ok: true, sha256: createHash("sha256").update(readFileSync(absPath)).digest("hex") };
  } catch (error) {
    return { ok: false, error: `could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Validate and digest-check a declared file list. Every element is treated
 * as untrusted input straight from parsed JSON: a non-object, a missing
 * path, an unsafe path or a malformed digest is a named refusal, never a
 * thrown error. `forbidExtraRoles` names roles that must never appear here
 * regardless of what `expectedRole` is — used for the two reviewer-facing
 * lists so an "answer" or "outcome" file cannot masquerade as review or
 * instruction material. Returns only entries that were well-formed and
 * matched on disk, so a caller can tell "nothing declared" from "clean".
 *
 * `pathRoles` is shared across every call for one packet: it is how a
 * single physical file (by realpath, so an alias is not a way around this)
 * is refused a second, conflicting role when it appears in a different list
 * elsewhere in the same packet — a protocol file cannot separately be
 * declared an instrument file. The same file appearing with the *same* role
 * in more than one place (e.g. every arm's review_files pointing at the one
 * shared evidence file) is expected and stays valid. Duplicate declarations
 * of the same physical file *within* one list — even naming it identically
 * twice — are refused regardless of role, since a list is not a set here and
 * a repeated entry only pads or confuses it.
 */
function checkFiles(
  root: string,
  label: string,
  files: unknown[],
  expectedRole: FileRole,
  digestReason: DisqualifyReason,
  failures: ValidationFailure[],
  forbidExtraRoles: readonly FileRole[] = [],
  pathRoles: Map<string, FileRole> = new Map(),
): PacketFile[] {
  const wellFormed: PacketFile[] = [];
  const seenInThisList = new Set<string>();
  for (const entry of files) {
    if (!isPlainObject(entry)) {
      failures.push({ reason: "malformed_metadata", detail: `${label}: a declared file entry is not an object` });
      continue;
    }
    const f = entry as { path?: unknown; sha256?: unknown; role?: unknown };
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
    if (!isFileRole(f.role)) {
      failures.push({ reason: "malformed_metadata", detail: `${f.path}: declared role is missing or unrecognised` });
      continue;
    }
    if (forbidExtraRoles.includes(f.role)) {
      failures.push({
        reason: "forbidden_review_material",
        detail: `${label}: ${f.path} is declared role "${f.role}", which may never appear in review input`,
      });
      continue;
    }
    if (f.role !== expectedRole) {
      failures.push({
        reason: "malformed_metadata",
        detail: `${label}: ${f.path} is declared role "${f.role}", expected "${expectedRole}"`,
      });
      continue;
    }
    const abs = resolveWithinPacket(root, f.path);
    if (abs === null) {
      failures.push({ reason: "unsafe_path", detail: `${f.path}: path escapes the packet directory` });
      continue;
    }
    const read = readForDigest(abs);
    const declared: PacketFile = { path: f.path, sha256: f.sha256, role: f.role };
    if (!read.ok) {
      failures.push({ reason: digestReason, detail: `${declared.path}: ${read.error}` });
      continue;
    }
    if (read.sha256 !== declared.sha256) {
      failures.push({
        reason: digestReason,
        detail: `${declared.path}: declared sha256 ${declared.sha256} does not match actual ${read.sha256}`,
      });
      continue;
    }
    // realpath alone identifies a symlink alias but not a hard link: two
    // hard-linked paths are two independent directory entries with no
    // symlink between them, so realpath returns each path unchanged. Device
    // and inode are what the kernel actually uses to say "this is one
    // file," so that identity — not the path spelling — is the key.
    let physicalKey: string;
    try {
      const real = realpathSync(abs);
      const stat = statSync(real);
      physicalKey = `${stat.dev}:${stat.ino}`;
    } catch {
      physicalKey = abs;
    }
    if (seenInThisList.has(physicalKey)) {
      failures.push({
        reason: "malformed_metadata",
        detail: `${label}: ${declared.path} is a duplicate declaration of a file already listed here`,
      });
      continue;
    }
    seenInThisList.add(physicalKey);
    const priorRole = pathRoles.get(physicalKey);
    if (priorRole !== undefined && priorRole !== declared.role) {
      failures.push({
        reason: "malformed_metadata",
        detail: `${declared.path} is declared role "${declared.role}" here but role "${priorRole}" elsewhere for the same physical file`,
      });
      continue;
    }
    pathRoles.set(physicalKey, declared.role);
    wellFormed.push(declared);
  }
  return wellFormed;
}

/** Deterministic identity of exactly what a reviewer is shown for one arm. */
function renderedEvidenceHash(root: string, files: PacketFile[]): string {
  const parts = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => {
      const abs = resolveWithinPacket(root, f.path);
      const read = abs === null ? { ok: false as const, error: "unsafe path" } : readForDigest(abs);
      return `${f.path}:${read.ok ? read.sha256 : "MISSING"}`;
    });
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function checkSourceIdentity(source: unknown, failures: ValidationFailure[]): void {
  if (!isPlainObject(source)) {
    failures.push({ reason: "missing_identity", detail: "evidence.source is missing or not an object" });
    return;
  }
  if (typeof source.repo !== "string" || source.repo.trim() === "") {
    failures.push({ reason: "missing_identity", detail: "evidence.source.repo is missing or empty" });
  }
  for (const field of ["base", "head"] as const) {
    const value = source[field];
    if (typeof value !== "string" || !GIT_SHA_FULL.test(value)) {
      failures.push({
        reason: "missing_identity",
        detail: `evidence.source.${field} must be a full 40-character git commit hash, not a prefix`,
      });
    }
  }
}

const SUBJECT_INPUT_KEYS = new Set(["spec", "diff", "commitMessages", "transcript", "test"]);
const TEST_RESULT_KEYS = new Set(["command", "exitCode", "output"]);

function hasExactKeys(obj: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(obj);
  return actual.length === keys.size && actual.every((k) => keys.has(k));
}

/**
 * `subjectHashOf` assumes its input already has the shape it hashes; a
 * missing `test` or a `test` that is not `null`/`{command, exitCode, output}`
 * throws instead of failing closed, and it silently ignores any property
 * outside its fixed tuple — so a reviewer-visible payload could carry an
 * extra field (e.g. an answer or outcome marker) that never affects
 * subject_hash and is never barred by the SubjectInput shape check. Both are
 * closed here: every top-level and nested key must be exactly the expected
 * set, no more and no fewer, before the payload is accepted or hashed.
 */
function isSubjectInput(v: unknown): v is SubjectInput {
  if (!isPlainObject(v) || !hasExactKeys(v, SUBJECT_INPUT_KEYS)) return false;
  if (typeof v.spec !== "string" || typeof v.diff !== "string" || typeof v.commitMessages !== "string") return false;
  if (v.transcript !== null && typeof v.transcript !== "string") return false;
  if (v.test !== null) {
    if (!isPlainObject(v.test) || !hasExactKeys(v.test, TEST_RESULT_KEYS)) return false;
    // Number.isInteger, not typeof: JSON's 1e309 parses to the *number*
    // Infinity, which subjectHashOf's JSON.stringify silently normalizes to
    // null — a finite-integer check is what actually rejects that.
    if (
      typeof v.test.command !== "string" ||
      !Number.isInteger(v.test.exitCode) ||
      typeof v.test.output !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function checkArtifactProvenance(prov: unknown, failures: ValidationFailure[]): ArtifactProvenance | null {
  if (!isPlainObject(prov)) {
    failures.push({ reason: "missing_identity", detail: "evidence.artifact_provenance is missing or not an object" });
    return null;
  }
  const fields = ["spec", "diff", "commit_messages", "transcript", "test"] as const;
  let allValid = true;
  for (const field of fields) {
    if (!isArtifactStatus(prov[field])) {
      failures.push({
        reason: "malformed_metadata",
        detail: `evidence.artifact_provenance.${field} must be one of ${ARTIFACT_STATUSES.join(", ")}`,
      });
      allValid = false;
    }
  }
  return allValid ? (prov as unknown as ArtifactProvenance) : null;
}

/**
 * `original`/`missing`/`reconstructed` is an attestation this checker cannot
 * prove — but "missing" versus "present" is not: it is mechanically visible
 * in the payload itself, and a declaration that contradicts it is refused.
 * `transcript`/`test` are nullable, so absence is `=== null`. `spec`/`diff`/
 * `commitMessages` are required strings with no null case in SubjectInput;
 * the documented representation of "missing" for them is the empty string
 * `""` — a declared status of `missing` requires that exact representation,
 * and any non-`missing` status requires a non-empty string.
 */
function checkProvenanceAgreement(
  prov: ArtifactProvenance,
  payload: SubjectInput,
  failures: ValidationFailure[],
): void {
  const checks: [field: keyof ArtifactProvenance, present: boolean][] = [
    ["spec", payload.spec !== ""],
    ["diff", payload.diff !== ""],
    ["commit_messages", payload.commitMessages !== ""],
    ["transcript", payload.transcript !== null],
    ["test", payload.test !== null],
  ];
  for (const [field, present] of checks) {
    const declared = prov[field];
    if (declared === "missing" && present) {
      failures.push({
        reason: "malformed_metadata",
        detail: `evidence.artifact_provenance.${field} is declared "missing" but the payload contains content for it`,
      });
    } else if (declared !== "missing" && !present) {
      failures.push({
        reason: "malformed_metadata",
        detail: `evidence.artifact_provenance.${field} is declared "${declared}" but the payload has no content for it (must be "missing")`,
      });
    }
  }
}

/**
 * Validate one packet directory against `packet.json` inside it.
 *
 * Offline and read-only: makes no judge calls, mutates nothing, and leaves
 * every input file untouched whether validation passes or fails.
 *
 * `exposure` is the operator's own exposure record, read by the caller and
 * passed in — this function never discovers or writes it, and an
 * "untouched" declaration cannot pass without one actually being supplied.
 *
 * `externalProtocol` is a digest pin the caller computed independently of
 * this packet (e.g. from their own trusted copy of the protocol document).
 * A packet's protocol_files must match it; matching only the packet's own
 * declared digest of itself is not accepted as frozen protocol identity.
 */
export function validatePacket(
  packetDir: string,
  exposure: ExposureCheck,
  externalProtocol: ExternalProtocolPin,
): ValidationResult {
  const manifestPath = resolve(packetDir, "packet.json");
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
  if (!isValidIsoDate(raw.data_cutoff)) {
    failures.push({ reason: "missing_identity", detail: "packet.json data_cutoff must be a valid YYYY-MM-DD calendar date" });
  }

  const provenance = raw.provenance;
  if (provenance !== "known" && provenance !== "unknown") {
    failures.push({ reason: "malformed_metadata", detail: `packet.json provenance must be "known" or "unknown"` });
  } else if (provenance === "unknown") {
    failures.push({ reason: "unknown_provenance", detail: "packet declares unknown provenance" });
  }

  const exposureState = raw.exposure;
  if (exposureState !== "untouched" && exposureState !== "development" && exposureState !== "unknown") {
    failures.push({
      reason: "malformed_metadata",
      detail: `packet.json exposure must be "untouched", "development" or "unknown"`,
    });
  } else if (exposureState === "unknown") {
    failures.push({ reason: "unknown_exposure_state", detail: "packet declares unknown exposure" });
  } else if (exposureState === "untouched") {
    if (!exposure.supplied) {
      failures.push({
        reason: "exposure_record_not_supplied",
        detail: "packet declares untouched but the caller supplied no exposure record to check it against",
      });
    } else if (!exposure.complete) {
      failures.push({
        reason: "exposure_record_incomplete",
        detail: "the supplied exposure record does not assert completeness, so it cannot back an untouched declaration",
      });
    } else if (
      exposure.coveredThrough !== null &&
      isValidIsoDate(raw.data_cutoff) &&
      exposure.coveredThrough < (raw.data_cutoff as string)
    ) {
      failures.push({
        reason: "exposure_record_incomplete",
        detail: `exposure record covered_through ${exposure.coveredThrough} does not reach the packet's data_cutoff ${raw.data_cutoff}`,
      });
    } else if (caseId !== null && exposure.exposedCaseIds.has(caseId)) {
      failures.push({
        reason: "exposed_case_claims_untouched",
        detail: `case ${caseId} appears in the exposure log and cannot be declared untouched`,
      });
    }
  }

  if (externalProtocol.size === 0) {
    failures.push({
      reason: "missing_identity",
      detail: "no external protocol pin was supplied; a packet cannot attest its own frozen protocol identity",
    });
  }

  // Shared across every checkFiles call below: one physical file, by
  // realpath, cannot carry two different declared roles across lists.
  const pathRoles = new Map<string, FileRole>();

  const protocolFiles = Array.isArray(raw.protocol_files) ? raw.protocol_files : null;
  if (protocolFiles === null) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json protocol_files must be an array" });
  } else if (protocolFiles.length === 0) {
    failures.push({
      reason: "missing_identity",
      detail: "packet.json protocol_files declares no frozen protocol document",
    });
  } else {
    const wellFormedProtocol = checkFiles(
      packetDir, "protocol_files", protocolFiles, "protocol", "protocol_digest_mismatch", failures, [], pathRoles,
    );
    const declaredPaths = new Set(wellFormedProtocol.map((f) => f.path));
    for (const f of wellFormedProtocol) {
      const pin = externalProtocol.get(f.path);
      if (pin === undefined) {
        failures.push({
          reason: "protocol_digest_mismatch",
          detail: `${f.path}: no external pin was supplied for this declared protocol file`,
        });
      } else if (pin !== f.sha256) {
        failures.push({
          reason: "protocol_digest_mismatch",
          detail: `${f.path}: declared sha256 ${f.sha256} does not match the externally pinned ${pin}`,
        });
      }
    }
    // The reverse direction: a pin the caller supplied but the packet never
    // declares is an incomplete or ambiguous frozen identity, not a no-op —
    // the caller believed a second protocol document was part of this
    // packet's frozen identity, and the packet silently disagrees.
    for (const pinnedPath of externalProtocol.keys()) {
      if (!declaredPaths.has(pinnedPath)) {
        failures.push({
          reason: "protocol_digest_mismatch",
          detail: `${pinnedPath}: an external pin was supplied for this path but packet.json protocol_files does not declare it`,
        });
      }
    }
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
    checkFiles(packetDir, "instrument_files", instrumentFiles, "instrument", "payload_digest_mismatch", failures, [], pathRoles);
  }

  const forbiddenMarkers: string[] = [];
  if (!Array.isArray(raw.forbidden_markers)) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json forbidden_markers must be an array of strings" });
  } else {
    for (const m of raw.forbidden_markers) {
      if (typeof m !== "string") {
        failures.push({
          reason: "malformed_metadata",
          detail: "packet.json forbidden_markers must contain only strings",
        });
      } else {
        forbiddenMarkers.push(m);
      }
    }
  }

  let subjectHash: string | null = null;
  let evidenceReconstructed = false;
  let payloadFile: PacketFile | null = null;
  const evidence = raw.evidence;
  if (!isPlainObject(evidence)) {
    failures.push({ reason: "missing_identity", detail: "packet.json evidence is missing or not an object" });
  } else {
    checkSourceIdentity(evidence.source, failures);
    const artifactProvenance = checkArtifactProvenance(evidence.artifact_provenance, failures);
    evidenceReconstructed = artifactProvenance !== null
      && Object.values(artifactProvenance).some((status) => status === "reconstructed");

    if (evidence.payload_file === undefined) {
      failures.push({ reason: "missing_identity", detail: "packet.json evidence.payload_file is missing" });
    } else if (!SHA256_HEX.test(String(evidence.subject_hash ?? ""))) {
      failures.push({ reason: "missing_identity", detail: "packet.json evidence.subject_hash is missing or malformed" });
    } else {
      const wellFormedPayload = checkFiles(
        packetDir,
        "evidence.payload_file",
        [evidence.payload_file],
        "review",
        "payload_digest_mismatch",
        failures,
        [],
        pathRoles,
      );
      payloadFile = wellFormedPayload[0] ?? null;
      if (payloadFile !== null) {
        const abs = resolveWithinPacket(packetDir, payloadFile.path)!;
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(abs, "utf8"));
        } catch (error) {
          failures.push({
            reason: "malformed_metadata",
            detail: `evidence.payload_file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          });
          parsed = undefined;
        }
        if (parsed !== undefined) {
          if (!isSubjectInput(parsed)) {
            failures.push({
              reason: "malformed_metadata",
              detail: "evidence.payload_file does not have the required SubjectInput shape: exactly the keys spec/diff/commitMessages/transcript/test, with spec/diff/commitMessages strings, transcript null-or-string, and test null or exactly {command, exitCode, output}",
            });
          } else {
            const actual = subjectHashOf(parsed);
            if (actual !== evidence.subject_hash) {
              failures.push({
                reason: "payload_digest_mismatch",
                detail: "declared evidence.subject_hash does not match the actual payload_file bytes",
              });
            } else {
              subjectHash = actual;
            }
            if (artifactProvenance !== null) {
              checkProvenanceAgreement(artifactProvenance, parsed, failures);
            }
          }
        }
      }
    }
  }

  const arms = Array.isArray(raw.arms) ? raw.arms : null;
  const seenArmNames = new Set<string>();
  if (arms === null || arms.length === 0) {
    failures.push({ reason: "malformed_metadata", detail: "packet.json arms must be a non-empty array" });
  } else {
    for (const arm of arms) {
      if (
        !isPlainObject(arm) ||
        typeof arm.name !== "string" ||
        arm.name.trim() === "" ||
        !SHA256_HEX.test(String(arm.evidence_hash ?? "")) ||
        !Array.isArray(arm.review_files) ||
        (arm.instructions_files !== undefined && !Array.isArray(arm.instructions_files))
      ) {
        failures.push({ reason: "malformed_metadata", detail: "an arm is missing a required field, or its name is blank" });
        continue;
      }
      if (seenArmNames.has(arm.name)) {
        failures.push({ reason: "malformed_metadata", detail: `duplicate arm name "${arm.name}"` });
        continue;
      }
      seenArmNames.add(arm.name);

      if (arm.review_files.length === 0) {
        failures.push({
          reason: "missing_identity",
          detail: `${arm.name}: review_files declares nothing shown to the reviewer`,
        });
        continue;
      }
      if (
        payloadFile !== null &&
        (arm.review_files.length !== 1 ||
          !isPlainObject(arm.review_files[0]) ||
          (arm.review_files[0] as Record<string, unknown>).path !== payloadFile.path ||
          (arm.review_files[0] as Record<string, unknown>).sha256 !== payloadFile.sha256)
      ) {
        failures.push({
          reason: "arm_evidence_mismatch",
          detail: `${arm.name}: review_files must consist of exactly evidence.payload_file (${payloadFile.path}), the same bytes subject_hash was computed from`,
        });
      }
      const wellFormedReview = checkFiles(
        packetDir,
        `${arm.name}.review_files`,
        arm.review_files,
        "review",
        "payload_digest_mismatch",
        failures,
        FORBIDDEN_IN_REVIEW_INPUT,
        pathRoles,
      );
      const instructionFiles = Array.isArray(arm.instructions_files) ? arm.instructions_files : [];
      const wellFormedInstructions = checkFiles(
        packetDir,
        `${arm.name}.instructions_files`,
        instructionFiles,
        "instruction",
        "payload_digest_mismatch",
        failures,
        FORBIDDEN_IN_REVIEW_INPUT,
        pathRoles,
      );

      for (const marker of forbiddenMarkers) {
        for (const f of [...wellFormedReview, ...wellFormedInstructions]) {
          const abs = resolveWithinPacket(packetDir, f.path);
          if (abs === null) continue;
          let text: string;
          try {
            text = readFileSync(abs, "utf8");
          } catch (error) {
            failures.push({
              reason: "malformed_metadata",
              detail: `${arm.name}/${f.path}: could not be read for forbidden-marker check: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
            continue;
          }
          if (text.includes(marker)) {
            failures.push({
              reason: "forbidden_review_material",
              detail: `${arm.name}/${f.path} contains forbidden marker "${marker}"`,
            });
          }
        }
      }

      if (wellFormedReview.length === arm.review_files.length && wellFormedInstructions.length === instructionFiles.length) {
        // Everything reviewer-visible for this arm: review files and
        // instructions together, so changed instruction bytes change this
        // arm's identity even when review_files (the shared evidence) does
        // not. subject_hash stays the separate, narrower identity of the
        // raw evidence tuple alone.
        const actualEvidenceHash = renderedEvidenceHash(packetDir, [...wellFormedReview, ...wellFormedInstructions]);
        if (actualEvidenceHash !== arm.evidence_hash) {
          failures.push({
            reason: "payload_digest_mismatch",
            detail: `${arm.name}: declared evidence_hash does not match the actual review and instruction material`,
          });
        }
      }
    }
  }

  if (failures.length > 0) {
    return { ok: false, case_id: caseId, failures };
  }

  return {
    ok: true,
    case_id: caseId!,
    subject_hash: subjectHash!,
    holdout_eligible: exposureState === "untouched" && !evidenceReconstructed,
  };
}
