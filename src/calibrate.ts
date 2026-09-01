/**
 * Judge-versus-human agreement, computed over rater events.
 *
 * Everything that scores a run — the judge, a human reviewer, and later a second
 * or third judge in a panel — is a rater with an id. Agreement is computed for
 * every pair of raters that scored the same run, so panel mode is data rather
 * than code. Load-bearing once Run 01 data exists; today it runs on the
 * synthetic pairs and says so.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type { HumanFile, VerdictFile } from "./types.ts";
import { EVENT_SCHEMA_VERSION, isJudgeEvent, isRaterEvent, readEvents } from "./events.ts";
import type { GonogoEvent } from "./events.ts";
import { GONOGO_VERSION } from "./version.ts";

type Scores = Record<string, number | "abstain">;

function score(value: unknown, label: string): number | "abstain" {
  if (value === "abstain") return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error(`${label} must be an integer from 0 to 4 or "abstain".`);
  }
  return value;
}

function exactDimensionKeys(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain exactly ${DIMENSIONS.join(", ")}.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...DIMENSIONS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${DIMENSIONS.join(", ")}.`);
  }
  return record;
}

function humanScores(value: unknown, label: string): Scores {
  const dimensions = exactDimensionKeys(value, label);
  return Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, score(dimensions[dimension], `${label}.${dimension}`)]),
  );
}

function verdictScores(value: unknown, label: string): Scores {
  const dimensions = exactDimensionKeys(value, label);
  return Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      const result = dimensions[dimension];
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`${label}.${dimension} must be a dimension result.`);
      }
      return [
        dimension,
        score((result as Record<string, unknown>).score, `${label}.${dimension}.score`),
      ];
    }),
  );
}

interface Rating {
  runId: string;
  raterId: string;
  scores: Scores;
  synthetic: boolean;
  /** Present only for judge ratings; humans inherit it through the comparison. */
  instrument?: InstrumentIdentity;
  notes?: string | null;
}

interface InstrumentIdentity {
  gonogoVersion: string;
  backend: string;
  model: string;
  promptHashes: [string, string][];
}

function instrument(
  gonogoVersion: string,
  backend: string,
  model: string,
  promptHashes: Record<string, string> | { path: string; sha256: string }[],
): InstrumentIdentity {
  const entries = Array.isArray(promptHashes)
    ? promptHashes.map((p): [string, string] => [p.path, p.sha256])
    : Object.entries(promptHashes);
  return {
    gonogoVersion,
    backend,
    model,
    promptHashes: entries.sort(([a], [b]) => a.localeCompare(b)),
  };
}

function instrumentKey(i: InstrumentIdentity): string {
  return JSON.stringify(i);
}

function instrumentLabel(i: InstrumentIdentity): string {
  const prompts = i.promptHashes.length
    ? i.promptHashes.map(([path, hash]) => `${path}=${hash}`).join(", ")
    : "(none)";
  return `gonogo=${i.gonogoVersion}; backend=${i.backend}; model=${i.model}; prompts=${prompts}`;
}

/**
 * The operator's flow is unchanged: write runs/<ts>/human.json next to
 * verdict.json. Those directories are read as rater events without being
 * rewritten, so the log can be the computation substrate without the directory
 * layout having to move first.
 */
function ratingsFromDirs(dir: string): Rating[] {
  if (!existsSync(dir)) return [];
  const out: Rating[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(dir, entry.name);
    const vp = join(runDir, "verdict.json");
    const hp = join(runDir, "human.json");
    if (!existsSync(hp)) {
      out.push(...ratingsFromDirs(runDir));
      continue;
    }
    const h = JSON.parse(readFileSync(hp, "utf8")) as HumanFile;
    const reviewerScores = humanScores(h.dimensions, `${hp}.dimensions`);
    const synthetic = h.synthetic === true;
    out.push({
      runId: h.run_id,
      raterId: h.reviewer,
      scores: reviewerScores,
      synthetic,
      notes: h.notes ?? null,
    });
    if (!existsSync(vp)) continue;
    const v = JSON.parse(readFileSync(vp, "utf8")) as VerdictFile;
    const sources = v.provenance.pass_sources;
    if (
      v.provenance.replayed === true ||
      sources?.blind === "cache" ||
      sources?.rubric === "cache"
    ) {
      continue;
    }
    const verdictRunId = v.run_id;
    const artifactRunId = verdictRunId ?? entry.name;
    if (h.run_id !== artifactRunId) {
      throw new Error(
        `Run id mismatch in ${hp}: human run_id ${JSON.stringify(h.run_id)} ` +
          `does not match artifact ${JSON.stringify(artifactRunId)}.`,
      );
    }
    const judgeScores = verdictScores(v.dimensions, `${vp}.dimensions`);
    out.push({
      runId: artifactRunId,
      raterId: `judge:${v.provenance.judge_backend}`,
      scores: judgeScores,
      synthetic,
      instrument: instrument(
        v.provenance.gonogo_version,
        v.provenance.judge_backend,
        v.provenance.model_version,
        v.provenance.prompt_files,
      ),
    });
  }
  return out;
}

function ratingsFromEvents(events: GonogoEvent[]): Rating[] {
  const out: Rating[] = [];
  for (const e of events) {
    if (isJudgeEvent(e)) {
      // Replayed runs are the same judgement served twice; counting them would
      // inflate agreement without adding an observation.
      if (e.replay) continue;
      out.push({
        runId: e.run_id,
        raterId: e.rater_id,
        scores: e.scores,
        synthetic: e.kind === "fixture",
        instrument: instrument(e.gonogo_version, e.backend, e.model_version, e.prompt_hashes),
      });
    } else if (isRaterEvent(e)) {
      out.push({
        runId: e.run_id,
        raterId: e.rater_id,
        scores: e.scores,
        synthetic: e.synthetic === true,
        notes: e.notes ?? null,
      });
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export interface CalibrateOptions {
  eventsPath: string;
  dirs: string[];
}

export function runCalibrate(o: CalibrateOptions): string {
  const { events, malformed } = readEvents(o.eventsPath);
  const ratings = [...ratingsFromEvents(events), ...o.dirs.flatMap(ratingsFromDirs)];

  // The same (run, rater) may appear both in the log and in a run directory.
  // Exact duplicates add no observation. Conflicts are data corruption, not a
  // precedence question: choosing either one would silently change the result.
  const seen = new Map<string, Rating>();
  for (const r of ratings) {
    const key = JSON.stringify([r.runId, r.raterId]);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, r);
      continue;
    }
    const sameScores = DIMENSIONS.every((d) => prior.scores[d] === r.scores[d]);
    const sameInstrument =
      prior.instrument === undefined && r.instrument === undefined
        ? true
        : prior.instrument !== undefined &&
          r.instrument !== undefined &&
          instrumentKey(prior.instrument) === instrumentKey(r.instrument);
    if (!sameScores || prior.synthetic !== r.synthetic || !sameInstrument) {
      throw new Error(
        `Conflicting ratings for run ${JSON.stringify(r.runId)}, ` +
          `rater ${JSON.stringify(r.raterId)}.`,
      );
    }
  }

  const byRun = new Map<string, Rating[]>();
  for (const r of seen.values()) {
    if (!byRun.has(r.runId)) byRun.set(r.runId, []);
    byRun.get(r.runId)!.push(r);
  }

  // A comparison needs two raters on the same run. Anything else is a run
  // nobody double-scored, which is what Phase 1 of the trust ratchet exists
  // to eliminate.
  const pairs: {
    runId: string;
    a: Rating;
    b: Rating;
    synthetic: boolean;
    instrumentKey: string;
    instrumentLabel: string;
  }[] = [];
  for (const [runId, rs] of byRun) {
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const first = rs[i]!;
        const second = rs[j]!;
        // Order the pair so a judge is always side A; the direction of
        // disagreement only means something if the sides are stable.
        const [a, b] = first.raterId.startsWith("judge:") ? [first, second] : [second, first];
        const instruments = [a.instrument, b.instrument]
          .filter((value): value is InstrumentIdentity => value !== undefined)
          .sort((x, y) => instrumentKey(x).localeCompare(instrumentKey(y)));
        const identities = [...new Map(instruments.map((i) => [instrumentKey(i), i])).values()];
        pairs.push({
          runId,
          a,
          b,
          synthetic: first.synthetic || second.synthetic,
          instrumentKey: JSON.stringify(identities.map(instrumentKey)),
          instrumentLabel:
            identities.length > 0
              ? identities.map(instrumentLabel).join(" <> ")
              : "human-only comparison (no judge instrument)",
        });
      }
    }
  }

  const out: string[] = [];
  const unscored = [...byRun.values()].filter((rs) => rs.length < 2).length;
  const orphanHuman = [...byRun.values()]
    .filter((ratings) => ratings.length < 2)
    .flatMap((ratings) => ratings)
    .filter((rating) => !rating.raterId.startsWith("judge:") && !rating.synthetic);
  const anyRealHumanRating = [...seen.values()].some(
    (rating) => !rating.raterId.startsWith("judge:") && !rating.synthetic,
  );

  const orphanBlock = (): string[] => {
    if (orphanHuman.length === 0) return [];
    const lines = ["", "human ratings with nothing to compare against"];
    for (const rating of orphanHuman) {
      const shown = DIMENSIONS.map(
        (dimension) => `${dimension} ${rating.scores[dimension]}`,
      ).join(", ");
      lines.push(`  ${rating.runId}  by ${rating.raterId}`);
      lines.push(`    ${shown}`);
      if (rating.notes) {
        const note = rating.notes.length > 300 ? `${rating.notes.slice(0, 300)}...` : rating.notes;
        lines.push(`    ${JSON.stringify(note)}`);
      }
    }
    lines.push(
      "  These are review records, not agreement data. Pair only ratings made from",
      "  the same evidence snapshot under the same run_id.",
    );
    return lines;
  };

  if (pairs.length === 0) {
    return [
      "No double-scored runs found.",
      "",
      `${byRun.size} run(s) carry exactly one rating, so there is nothing to compare.`,
      "Agreement needs two raters on the same run: the judge, and you.",
      ...orphanBlock(),
      "",
      "Record your own verdict after a judged run as runs/<ts>/human.json — same four",
      "dimensions, same 0-4 anchors as RUBRIC.md, written before you read the judge's.",
      "calibration/README.md has the protocol; calibration/synthetic/ has the shape.",
      malformed > 0 ? `\n${malformed} malformed line(s) skipped in ${o.eventsPath}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const real = pairs.filter((p) => !p.synthetic);
  const synth = pairs.filter((p) => p.synthetic);

  if (real.length === 0) {
    out.push("=".repeat(72));
    out.push("SYNTHETIC DATA ONLY — these numbers measure nothing.");
    out.push("Every pair below was hand-written to exercise the aggregation.");
    out.push(
      anyRealHumanRating
        ? "Real human ratings exist, but none forms a same-evidence judge pair."
        : "No human has reviewed a real gonogo run yet.",
    );
    out.push("Do not quote these figures anywhere.");
    out.push("=".repeat(72));
    out.push("");
  } else if (synth.length > 0) {
    out.push(
      `NOTE: ${synth.length} synthetic pair(s) present and EXCLUDED from the statistics below.`,
    );
    out.push("");
  }

  const scored = real.length > 0 ? real : synth;
  const pairKeys = [
    ...new Set(
      scored.map((p) =>
        JSON.stringify([p.instrumentKey, `${p.a.raterId} vs ${p.b.raterId}`]),
      ),
    ),
  ].sort();

  for (const groupKey of pairKeys) {
    const [instrumentId, raterPair] = JSON.parse(groupKey) as [string, string];
    const group = scored.filter(
      (p) =>
        p.instrumentKey === instrumentId && `${p.a.raterId} vs ${p.b.raterId}` === raterPair,
    );
    out.push(`instrument: ${group[0]!.instrumentLabel}`);
    out.push(
      `rater pair: ${raterPair}   (${group.length} run${group.length === 1 ? "" : "s"})`,
    );
    out.push(
      pad("  dimension", 20) +
        padL("exact", 8) +
        padL("within 1", 10) +
        padL("mean gap", 10) +
        padL("A harsher", 12) +
        padL("B harsher", 12),
    );
    out.push("  " + "-".repeat(70));
    for (const d of DIMENSIONS) {
      const usable = group.filter(
        (p) =>
          typeof p.a.scores[d] === "number" && typeof p.b.scores[d] === "number",
      );
      if (usable.length === 0) {
        out.push(pad(`  ${d}`, 20) + padL("no comparable pairs (abstentions only)", 52));
        continue;
      }
      const deltas = usable.map((p) => (p.a.scores[d] as number) - (p.b.scores[d] as number));
      const exact = deltas.filter((x) => x === 0).length;
      const within1 = deltas.filter((x) => Math.abs(x) <= 1).length;
      const mean = deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length;
      out.push(
        pad(`  ${d}`, 20) +
          padL(`${exact}/${usable.length}`, 8) +
          padL(`${within1}/${usable.length}`, 10) +
          padL(mean.toFixed(2), 10) +
          padL(String(deltas.filter((x) => x < 0).length), 12) +
          padL(String(deltas.filter((x) => x > 0).length), 12),
      );
    }
    out.push("");
  }

  out.push("per-run disagreements (published as-is)");
  for (const p of scored) {
    const diffs = DIMENSIONS.filter(
      (d) =>
        p.a.scores[d] !== "abstain" &&
        p.b.scores[d] !== "abstain" &&
        p.a.scores[d] !== p.b.scores[d],
    ).map((d) => `${d} ${p.a.raterId} ${p.a.scores[d]} / ${p.b.raterId} ${p.b.scores[d]}`);
    const abst = DIMENSIONS.filter(
      (d) => p.a.scores[d] === "abstain" || p.b.scores[d] === "abstain",
    );
    out.push(
      `  ${pad(p.runId, 30)}${p.synthetic ? "[synthetic] " : ""}` +
        (diffs.length ? diffs.join("; ") : "full agreement") +
        (abst.length ? `; abstentions: ${abst.join(", ")}` : "") +
        `; instrument: ${p.instrumentLabel}`,
    );
  }

  out.push(...orphanBlock());

  out.push("");
  out.push(
    `${scored.length} comparison(s)${
      real.length === 0 ? ", all synthetic" : `, ${real.length} real`
    }; ${unscored} run(s) have only one rating and were not compared.`,
  );
  out.push(
    `events schema v${EVENT_SCHEMA_VERSION}, gonogo ${GONOGO_VERSION}. ` +
      `"A harsher" counts runs where side A scored below side B.`,
  );
  if (malformed > 0) out.push(`${malformed} malformed line(s) skipped in ${o.eventsPath}.`);
  return out.join("\n");
}
