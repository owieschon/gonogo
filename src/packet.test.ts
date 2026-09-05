import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKET_SCHEMA, validatePacket, type EvaluationArm, type PacketFile } from "./packet.ts";
import { subjectHashOf } from "./subject.ts";

// All data below is synthetic fixture text for this test only; it is not a
// study result and no case_id here names a real evaluation.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writePacketFile(dir: string, relPath: string, content: string): PacketFile {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return { path: relPath, sha256: sha256(content) };
}

function buildValidPacket(dir: string): void {
  const protocolFile = writePacketFile(dir, "PROTOCOL.md", "synthetic frozen protocol text");
  const instrumentFile = writePacketFile(dir, "prompts/rubric.md", "synthetic frozen instrument text");

  const payload = {
    spec: "synthetic spec",
    diff: "synthetic diff",
    commitMessages: "synthetic commits",
    transcript: null,
    test: null,
  };
  const subjectHash = subjectHashOf(payload);
  const payloadText = JSON.stringify(payload);

  function arm(name: string): EvaluationArm {
    mkdirSync(join(dir, `arms/${name}`), { recursive: true });
    writeFileSync(join(dir, `arms/${name}/payload.json`), payloadText);
    const reviewFile = writePacketFile(dir, `arms/${name}/review.md`, `synthetic review material for ${name}`);
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify([`${reviewFile.path}:${reviewFile.sha256}`]), "utf8")
      .digest("hex");
    return {
      name,
      payload_path: `arms/${name}/payload.json`,
      subject_hash: subjectHash,
      evidence_hash: evidenceHash,
      review_files: [reviewFile],
    };
  }

  const manifest = {
    schema: PACKET_SCHEMA,
    packet_version: "1",
    case_id: "case-synthetic-001",
    provenance: "known",
    exposure: "untouched",
    protocol_files: [protocolFile],
    instrument_files: [instrumentFile],
    arms: [arm("gonogo"), arm("one_pass")],
    forbidden_markers: ["ANSWER_KEY"],
  };
  writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest, null, 2));
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-packet-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a valid synthetic packet passes and is holdout-eligible", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const before = readFileSync(join(dir, "packet.json"), "utf8");
    const result = validatePacket(dir, new Set());
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
    buildValidPacket(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
    manifest.exposure = "development";
    writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.holdout_eligible).toBe(false);
  });
});

test("missing packet.json fails closed with malformed_metadata", () => {
  withTempDir((dir) => {
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("a tampered protocol file after the digest was declared is caught, not silently passed", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    writeFileSync(join(dir, "PROTOCOL.md"), "tampered protocol text");
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "protocol_digest_mismatch")).toBe(true);
    }
  });
});

test("an empty declared sha256 does not count as a passing nonempty check", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
    manifest.instrument_files[0].sha256 = "";
    writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "malformed_metadata")).toBe(true);
  });
});

test("comparison arms reviewing different underlying evidence fail closed", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
    const otherPayload = { spec: "a different spec", diff: "d", commitMessages: "c", transcript: null, test: null };
    writeFileSync(join(dir, "arms/one_pass/payload.json"), JSON.stringify(otherPayload));
    manifest.arms[1].subject_hash = subjectHashOf(otherPayload);
    writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "arm_evidence_mismatch")).toBe(true);
  });
});

test("unknown provenance and unknown exposure both fail closed", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
    manifest.provenance = "unknown";
    manifest.exposure = "unknown";
    writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "unknown_provenance")).toBe(true);
      expect(result.failures.some((f) => f.reason === "unknown_exposure_state")).toBe(true);
    }
  });
});

test("a case in the exposure log cannot pass as untouched", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const result = validatePacket(dir, new Set(["case-synthetic-001"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "exposed_case_claims_untouched")).toBe(true);
    }
  });
});

test("a named forbidden marker in review material is refused with a stable reason", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
    const reviewPath = join(dir, "arms/gonogo/review.md");
    const content = "synthetic review material containing ANSWER_KEY: no-go";
    writeFileSync(reviewPath, content);
    manifest.arms[0].review_files[0].sha256 = sha256(content);
    manifest.arms[0].evidence_hash = createHash("sha256")
      .update(JSON.stringify([`arms/gonogo/review.md:${sha256(content)}`]), "utf8")
      .digest("hex");
    writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.reason === "forbidden_review_material")).toBe(true);
    }
  });
});

test("missing case_id fails closed with missing_identity", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "packet.json"), "utf8"));
    delete manifest.case_id;
    writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest));
    const result = validatePacket(dir, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.some((f) => f.reason === "missing_identity")).toBe(true);
  });
});

test("on failure, original packet files are left intact", () => {
  withTempDir((dir) => {
    buildValidPacket(dir);
    const before = readFileSync(join(dir, "PROTOCOL.md"), "utf8");
    const beforeStat = statSync(join(dir, "PROTOCOL.md"));
    writeFileSync(join(dir, "packet.json"), "{not json");
    validatePacket(dir, new Set());
    expect(readFileSync(join(dir, "PROTOCOL.md"), "utf8")).toBe(before);
    expect(statSync(join(dir, "PROTOCOL.md")).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
