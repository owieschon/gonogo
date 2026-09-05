import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PACKET_SCHEMA,
  validatePacket,
  type EvaluationArm,
  type PacketFile,
  type ValidationResult,
  type ExposureCheck,
  type ExternalProtocolPin,
} from "./packet.ts";
import { subjectHashOf } from "./subject.ts";

// All data below is synthetic fixture text for this test only; it is not a
// study result and no case_id here names a real evaluation.

const NOT_SUPPLIED: ExposureCheck = { supplied: false };
const NO_EXPOSURE: ExposureCheck = { supplied: true, complete: true, coveredThrough: null, exposedCaseIds: new Set() };
const A_BASE = "a".repeat(40);
const A_HEAD = "b".repeat(40);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writePacketFile(dir: string, relPath: string, content: string, role: PacketFile["role"]): PacketFile {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return { path: relPath, sha256: sha256(content), role };
}

interface Built {
  dir: string;
  externalProtocol: ExternalProtocolPin;
}

function buildValidPacket(dir: string): Built {
  const protocolFile = writePacketFile(dir, "PROTOCOL.md", "synthetic frozen protocol text", "protocol");
  const instrumentFile = writePacketFile(dir, "prompts/rubric.md", "synthetic frozen instrument text", "instrument");
  const externalProtocol: ExternalProtocolPin = new Map([[protocolFile.path, protocolFile.sha256]]);

  const payload = {
    spec: "synthetic spec",
    diff: "synthetic diff",
    commitMessages: "synthetic commits",
    transcript: null,
    test: null,
  };
  const subjectHash = subjectHashOf(payload);
  // The payload file IS the review file: every arm reviews exactly this,
  // the same bytes subject_hash is computed from — no separate rendering.
  const payloadFile = writePacketFile(dir, "payload.json", JSON.stringify(payload), "review");

  function arm(name: string): EvaluationArm {
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify([`${payloadFile.path}:${payloadFile.sha256}`]), "utf8")
      .digest("hex");
    return {
      name,
      review_files: [payloadFile],
      evidence_hash: evidenceHash,
    };
  }

  const manifest = {
    schema: PACKET_SCHEMA,
    packet_version: "1",
    case_id: "case-synthetic-001",
    provenance: "known",
    exposure: "untouched",
    data_cutoff: "2026-01-01",
    evidence: {
      payload_file: payloadFile,
      subject_hash: subjectHash,
      source: { repo: "https://example.invalid/synthetic.git", base: A_BASE, head: A_HEAD },
      artifact_provenance: {
        spec: "original",
        diff: "original",
        commit_messages: "original",
        transcript: "missing",
        test: "missing",
      },
    },
    protocol_files: [protocolFile],
    instrument_files: [instrumentFile],
    arms: [arm("gonogo"), arm("one_pass")],
    forbidden_markers: ["ANSWER_KEY"],
  };
  writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest, null, 2));
  return { dir, externalProtocol };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-packet-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readManifest(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
}

function writeManifest(dir: string, manifest: unknown): void {
  writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
}

test("a valid synthetic packet passes and is holdout-eligible", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const before = readFileSync(join(dir, "packet.json"), "utf8");
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.case_id).toBe("case-synthetic-001");
      expect(result.holdout_eligible).toBe(true);
    }
    // Read-only: validating must not touch the packet on disk.
    expect(readFileSync(join(dir, "packet.json"), "utf8")).toBe(before);
  });
});

test("a labeled development case can pass but is never holdout-eligible", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.exposure = "development";
    writeManifest(dir, manifest);
    // A development case needs no exposure record supplied at all.
    const result = validatePacket(dir, NOT_SUPPLIED, externalProtocol);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.holdout_eligible).toBe(false);
  });
});

test("a reconstructed artifact can pass but is never holdout-eligible", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // "reconstructed" requires actual content present (it is not "missing"),
    // so the payload must carry a non-null transcript to agree with it.
    const payload = {
      spec: "synthetic spec",
      diff: "synthetic diff",
      commitMessages: "synthetic commits",
      transcript: "a reconstructed transcript, not the original",
      test: null,
    };
    const content = JSON.stringify(payload);
    const digest = sha256(content);
    writeFileSync(join(dir, "payload.json"), content);
    manifest.evidence.payload_file.sha256 = digest;
    manifest.evidence.subject_hash = subjectHashOf(payload);
    manifest.evidence.artifact_provenance.transcript = "reconstructed";
    for (const arm of manifest.arms) {
      arm.review_files[0].sha256 = digest;
      arm.evidence_hash = createHash("sha256").update(JSON.stringify([`payload.json:${digest}`]), "utf8").digest("hex");
    }
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.holdout_eligible).toBe(false);
  });
});

test("missing packet.json fails closed with malformed_metadata", () => {
  withTempDir((dir) => {
    const result = validatePacket(dir, NO_EXPOSURE, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a tampered protocol file after the digest was declared is caught, not silently passed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    writeFileSync(join(dir, "PROTOCOL.md"), "tampered protocol text");
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "protocol_digest_mismatch")).toBe(true);
    }
  });
});

test("no externally supplied protocol pin fails closed, even when the manifest is self-consistent", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const result = validatePacket(dir, NO_EXPOSURE, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
    }
  });
});

test("a protocol file matching its own manifest but not the external pin fails closed", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    // Self-consistent (declared sha256 matches actual bytes) but the caller's
    // trusted reference disagrees — this is exactly the gap an earlier
    // version of this file had: a manifest could only ever check itself.
    const wrongPin: ExternalProtocolPin = new Map([["PROTOCOL.md", "0".repeat(64)]]);
    const result = validatePacket(dir, NO_EXPOSURE, wrongPin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "protocol_digest_mismatch")).toBe(true);
  });
});

test("an empty declared sha256 does not count as a passing nonempty check", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.instrument_files[0].sha256 = "";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("an arm substituting different (but internally consistent) review bytes fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // Recompute a fully self-consistent but different review file+hash for
    // one arm — not a stale/leftover hash, an actively recomputed one.
    const altContent = "a completely different rendering, not the shared evidence";
    const altFile = { path: "review/alt.md", sha256: sha256(altContent), role: "review" as const };
    mkdirSync(join(dir, "review"), { recursive: true });
    writeFileSync(join(dir, "review/alt.md"), altContent);
    manifest.arms[1].review_files = [altFile];
    manifest.arms[1].evidence_hash = createHash("sha256")
      .update(JSON.stringify([`${altFile.path}:${altFile.sha256}`]), "utf8")
      .digest("hex");
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "arm_evidence_mismatch")).toBe(true);
  });
});

test("unknown provenance and unknown exposure both fail closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.provenance = "unknown";
    manifest.exposure = "unknown";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "unknown_provenance")).toBe(true);
      expect(result.failures.some((f) => f.reason === "unknown_exposure_state")).toBe(true);
    }
  });
});

test("a case in the exposure log cannot pass as untouched", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const result = validatePacket(
      dir,
      { supplied: true, complete: true, coveredThrough: null, exposedCaseIds: new Set(["case-synthetic-001"]) },
      externalProtocol,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "exposed_case_claims_untouched")).toBe(true);
    }
  });
});

test("an untouched claim with no exposure record supplied fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    // exposure: "untouched" in the manifest, but the caller never supplied a
    // record at all — this must not silently default to "clean".
    const result = validatePacket(dir, NOT_SUPPLIED, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "exposure_record_not_supplied")).toBe(true);
    }
  });
});

test("a named forbidden marker in review material is refused with a stable reason", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // The review file is the payload file itself, so poisoning it means
    // rewriting the payload (with a recomputed subject_hash) to still be a
    // valid SubjectInput whose text happens to contain the forbidden marker.
    const payload = {
      spec: "synthetic spec containing ANSWER_KEY: no-go",
      diff: "synthetic diff",
      commitMessages: "synthetic commits",
      transcript: null,
      test: null,
    };
    const content = JSON.stringify(payload);
    const digest = sha256(content);
    writeFileSync(join(dir, "payload.json"), content);
    manifest.evidence.payload_file.sha256 = digest;
    manifest.evidence.subject_hash = subjectHashOf(payload);
    for (const arm of manifest.arms) {
      arm.review_files[0].sha256 = digest;
      arm.evidence_hash = createHash("sha256")
        .update(JSON.stringify([`payload.json:${digest}`]), "utf8")
        .digest("hex");
    }
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "forbidden_review_material")).toBe(true);
    }
  });
});

test("a forbidden marker in an instructions file is also caught", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    const content = "arm-specific framing that leaks ANSWER_KEY: go";
    const instructionsFile = { path: "arms/gonogo/instructions.md", sha256: sha256(content), role: "instruction" };
    mkdirSync(join(dir, "arms/gonogo"), { recursive: true });
    writeFileSync(join(dir, "arms/gonogo/instructions.md"), content);
    manifest.arms[0].instructions_files = [instructionsFile];
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "forbidden_review_material")).toBe(true);
    }
  });
});

test("a review_files entry declared role answer is structurally refused", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.arms[0].review_files[0].role = "answer";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "forbidden_review_material")).toBe(true);
    }
  });
});

test("an instructions_files entry declared role outcome is structurally refused", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    const content = "framing text";
    mkdirSync(join(dir, "arms/gonogo"), { recursive: true });
    writeFileSync(join(dir, "arms/gonogo/instructions.md"), content);
    manifest.arms[0].instructions_files = [{ path: "arms/gonogo/instructions.md", sha256: sha256(content), role: "outcome" }];
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "forbidden_review_material")).toBe(true);
    }
  });
});

test("a path escaping the packet directory via traversal fails closed, not read", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const outside = mkdtempSync(join(tmpdir(), "gonogo-outside-"));
    try {
      const secretContent = "outside-the-packet secret";
      writeFileSync(join(outside, "secret.txt"), secretContent);
      const manifest = readManifest(dir);
      manifest.instrument_files.push({
        path: `../../../../../../../../${outside.replace(/^\//, "")}/secret.txt`,
        sha256: sha256(secretContent),
        role: "instrument",
      });
      writeManifest(dir, manifest);
      const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures.some((f) => f.reason === "unsafe_path")).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a symlink escaping the packet directory fails closed, not read", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const outside = mkdtempSync(join(tmpdir(), "gonogo-outside-"));
    try {
      const secretContent = "outside-the-packet secret via symlink";
      writeFileSync(join(outside, "secret.txt"), secretContent);
      symlinkSync(join(outside, "secret.txt"), join(dir, "linked.txt"));
      const manifest = readManifest(dir);
      manifest.instrument_files.push({ path: "linked.txt", sha256: sha256(secretContent), role: "instrument" });
      writeManifest(dir, manifest);
      const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures.some((f) => f.reason === "unsafe_path")).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("missing case_id fails closed with missing_identity", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    delete manifest.case_id;
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("missing source repo/base/head fails closed with missing_identity", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.evidence.source = { repo: "", base: "not-a-sha", head: A_HEAD };
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("a short (abbreviated) commit hash is refused, not accepted as identity", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.evidence.source.base = A_BASE.slice(0, 7);
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("a malformed artifact_provenance value fails closed with malformed_metadata", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.evidence.artifact_provenance.spec = "fabricated";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a payload missing the required SubjectInput shape is a named refusal, not a thrown error", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    // No `test` key at all — this exact shape used to throw inside subjectHashOf.
    // Digests are recomputed so the failure is specifically the shape check,
    // not masked by an unrelated digest mismatch.
    const malformed = JSON.stringify({ spec: "s", diff: "d", commitMessages: "c", transcript: null });
    writeFileSync(join(dir, "payload.json"), malformed);
    const digest = sha256(malformed);
    const manifest = readManifest(dir);
    manifest.evidence.payload_file.sha256 = digest;
    for (const arm of manifest.arms) {
      arm.review_files[0].sha256 = digest;
      arm.evidence_hash = createHash("sha256").update(JSON.stringify([`payload.json:${digest}`]), "utf8").digest("hex");
    }
    writeManifest(dir, manifest);
    let result: ValidationResult;
    expect(() => {
      result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("missing data_cutoff fails closed with missing_identity", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    delete manifest.data_cutoff;
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("a calendar-invalid data_cutoff (e.g. Feb 30) is refused, not silently normalised", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.data_cutoff = "2026-02-30";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("a data_cutoff with trailing garbage after a valid date prefix is refused", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.data_cutoff = "2026-01-01T not a real timestamp";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("a non-string entry in forbidden_markers fails closed rather than being silently dropped", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.forbidden_markers = ["ANSWER_KEY", 12345];
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a packet with no protocol, instrument or review files never passes as untouched", () => {
  withTempDir((dir) => {
    const payload = { spec: "synthetic", diff: "synthetic", commitMessages: "synthetic", transcript: null, test: null };
    writeFileSync(join(dir, "payload.json"), JSON.stringify(payload));
    const manifest = {
      schema: PACKET_SCHEMA,
      packet_version: "1",
      case_id: "synthetic",
      provenance: "known",
      exposure: "untouched",
      data_cutoff: "2026-01-01",
      evidence: {
        // payload_file intentionally omitted
        subject_hash: subjectHashOf(payload),
        source: { repo: "r", base: A_BASE, head: A_HEAD },
        artifact_provenance: {
          spec: "original", diff: "original", commit_messages: "original", transcript: "missing", test: "missing",
        },
      },
      protocol_files: [],
      instrument_files: [],
      forbidden_markers: [],
      arms: [{ name: "a", review_files: [], evidence_hash: sha256("[]") }],
    };
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("a malformed null entry in a declared file list is a named refusal, not a thrown error", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.protocol_files.push(null);
    writeManifest(dir, manifest);
    let result: ValidationResult;
    expect(() => {
      result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a payload with an extra reviewer-visible key fails closed, even with every digest recomputed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    const payload: Record<string, unknown> = {
      spec: "synthetic spec",
      diff: "synthetic diff",
      commitMessages: "synthetic commits",
      transcript: null,
      test: null,
      answer_or_outcome: "known answer",
    };
    const content = JSON.stringify(payload);
    const digest = sha256(content);
    writeFileSync(join(dir, "payload.json"), content);
    manifest.evidence.payload_file.sha256 = digest;
    // subjectHashOf ignores the extra key, so the recomputed subject_hash is
    // unaffected by it — the shape check must catch it regardless.
    manifest.evidence.subject_hash = subjectHashOf(payload as any);
    for (const arm of manifest.arms) {
      arm.review_files[0].sha256 = digest;
      arm.evidence_hash = createHash("sha256").update(JSON.stringify([`payload.json:${digest}`]), "utf8").digest("hex");
    }
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("an extra key nested inside test also fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    const payload: Record<string, unknown> = {
      spec: "synthetic spec",
      diff: "synthetic diff",
      commitMessages: "synthetic commits",
      transcript: null,
      test: { command: "npm test", exitCode: 0, output: "ok", extra: "smuggled" },
    };
    const content = JSON.stringify(payload);
    const digest = sha256(content);
    writeFileSync(join(dir, "payload.json"), content);
    manifest.evidence.payload_file.sha256 = digest;
    for (const arm of manifest.arms) {
      arm.review_files[0].sha256 = digest;
      arm.evidence_hash = createHash("sha256").update(JSON.stringify([`payload.json:${digest}`]), "utf8").digest("hex");
    }
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a non-finite test.exitCode (JSON 1e309 parses to Infinity) fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // JSON.parse("1e309") yields the number Infinity; typeof Infinity is
    // "number", so only a finite-integer check catches this.
    const content = '{"spec":"s","diff":"d","commitMessages":"c","transcript":null,"test":{"command":"c","exitCode":1e309,"output":"o"}}';
    const digest = sha256(content);
    writeFileSync(join(dir, "payload.json"), content);
    manifest.evidence.payload_file.sha256 = digest;
    for (const arm of manifest.arms) {
      arm.review_files[0].sha256 = digest;
      arm.evidence_hash = createHash("sha256").update(JSON.stringify([`payload.json:${digest}`]), "utf8").digest("hex");
    }
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("provenance declaring content present when the payload has none fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // Payload's transcript/test are both null (missing), but provenance
    // claims "original" for both — a mechanical contradiction.
    manifest.evidence.artifact_provenance.transcript = "original";
    manifest.evidence.artifact_provenance.test = "original";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("provenance declaring content missing when the payload actually has it fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // spec/diff/commitMessages are all non-empty in buildValidPacket's
    // payload, but provenance claims spec is "missing".
    manifest.evidence.artifact_provenance.spec = "missing";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("changed instruction bytes with an unchanged (stale) arm evidence_hash fail closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    const firstContent = "first framing";
    writeFileSync(join(dir, "instructions.md"), firstContent);
    manifest.arms[0].instructions_files = [{ path: "instructions.md", sha256: sha256(firstContent), role: "instruction" }];
    manifest.arms[0].evidence_hash = createHash("sha256")
      .update(
        JSON.stringify([`instructions.md:${sha256(firstContent)}`, `payload.json:${manifest.evidence.payload_file.sha256}`].sort()),
        "utf8",
      )
      .digest("hex");
    writeManifest(dir, manifest);
    const first = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(first.ok).toBe(true);

    // Instruction bytes change; evidence_hash is deliberately left stale.
    writeFileSync(join(dir, "instructions.md"), "materially different framing");
    manifest.arms[0].instructions_files[0].sha256 = sha256("materially different framing");
    writeManifest(dir, manifest);
    const second = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failures.some((f) => f.reason === "payload_digest_mismatch")).toBe(true);
  });
});

test("a properly recomputed arm evidence_hash may legitimately differ from another arm's", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    const content = "gonogo-specific framing";
    writeFileSync(join(dir, "instructions.md"), content);
    const instructionsFile = { path: "instructions.md", sha256: sha256(content), role: "instruction" as const };
    manifest.arms[0].instructions_files = [instructionsFile];
    manifest.arms[0].evidence_hash = createHash("sha256")
      .update(JSON.stringify([`instructions.md:${instructionsFile.sha256}`, `payload.json:${manifest.evidence.payload_file.sha256}`].sort()), "utf8")
      .digest("hex");
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The two arms' review_files are identical (the shared payload), but
      // arm "gonogo" now also has instructions and arm "one_pass" does not,
      // so this passing result rests on their evidence_hash values differing.
      expect(manifest.arms[0].evidence_hash).not.toBe(manifest.arms[1].evidence_hash);
    }
  });
});

test("a blank arm name fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.arms[0].name = "   ";
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("duplicate arm names fail closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.arms[1].name = manifest.arms[0].name;
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a duplicate file declaration within one list fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    manifest.protocol_files.push({ ...manifest.protocol_files[0] });
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a hard-linked duplicate declaration within one list is still caught by physical identity", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    linkSync(join(dir, "PROTOCOL.md"), join(dir, "PROTOCOL-hardlink.md"));
    manifest.protocol_files.push({ path: "PROTOCOL-hardlink.md", sha256: manifest.protocol_files[0].sha256, role: "protocol" });
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("one physical file assigned conflicting roles across lists fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const manifest = readManifest(dir);
    // Same declared path as protocol_files[0], but also listed as an
    // instrument file with a different role for the identical physical file.
    manifest.instrument_files.push({ ...manifest.protocol_files[0], role: "instrument" });
    writeManifest(dir, manifest);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("the same physical evidence file reused with the same role by every arm remains legitimate", () => {
  // This is the baseline packet itself: every arm's review_files points at
  // the identical evidence.payload_file with role "review". It must pass.
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const result = validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(result.ok).toBe(true);
  });
});

test("an external pin for a path the packet does not declare fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const pinWithExtra = new Map(externalProtocol);
    pinWithExtra.set("REQUIRED-SECOND.md", sha256("an externally required second protocol"));
    const result = validatePacket(dir, NO_EXPOSURE, pinWithExtra);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "protocol_digest_mismatch")).toBe(true);
  });
});

test("an exposure record that is supplied but not marked complete fails closed on an untouched claim", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const result = validatePacket(
      dir,
      { supplied: true, complete: false, coveredThrough: null, exposedCaseIds: new Set() },
      externalProtocol,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "exposure_record_incomplete")).toBe(true);
  });
});

test("an exposure record whose covered_through predates the packet's data_cutoff fails closed", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    // Packet's data_cutoff is 2026-01-01.
    const result = validatePacket(
      dir,
      { supplied: true, complete: true, coveredThrough: "2025-06-01", exposedCaseIds: new Set() },
      externalProtocol,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "exposure_record_incomplete")).toBe(true);
  });
});

test("an exposure record whose covered_through reaches the packet's data_cutoff passes", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const result = validatePacket(
      dir,
      { supplied: true, complete: true, coveredThrough: "2026-01-01", exposedCaseIds: new Set() },
      externalProtocol,
    );
    expect(result.ok).toBe(true);
  });
});

test("on failure, original packet files are left intact", () => {
  withTempDir((dir) => {
    const { externalProtocol } = buildValidPacket(dir);
    const before = readFileSync(join(dir, "PROTOCOL.md"), "utf8");
    const beforeStat = statSync(join(dir, "PROTOCOL.md"));
    writeFileSync(join(dir, "packet.json"), "{not json");
    validatePacket(dir, NO_EXPOSURE, externalProtocol);
    expect(readFileSync(join(dir, "PROTOCOL.md"), "utf8")).toBe(before);
    expect(statSync(join(dir, "PROTOCOL.md")).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
