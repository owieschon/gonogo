/**
 * Judge-versus-human agreement, computed over rater events.
 *
 * Everything that scores a run — the judge, a human reviewer, an AI reviewer,
 * and later a second or third judge in a panel — is a rater with an id and a
 * declared `rater_kind`. Agreement is computed for every pair of raters that
 * scored the same run, so panel mode is data rather than code.
 *
 * The kind is what keeps the headline number honest. Only a rating declared
 * `human`, paired with a judge run on the same evidence, is judge-versus-human
 * calibration; LLM reviews, synthetic demo pairs and ratings with no declared
 * author are reported under their own names and never pooled into that count.
 * Load-bearing once Run 01 data exists; today it runs on the synthetic pairs
 * and says so.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS, RATER_KINDS, UNDECLARED_RATER_KIND, isRaterKind } from "./types.ts";
import type { ManualRatingFile, StoredRaterKind, VerdictFile } from "./types.ts";
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

function manualScores(value: unknown, label: string): Scores {
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
  /**
   * Declared at the point the rating was read, never derived from the rater id.
   * A judge run is a machine rating because a judge produced it, not because
   * its id happens to start with "judge:".
   */
  raterKind: StoredRaterKind;
  /** True for a gonogo judge invocation, as opposed to any other rater. */
  judgeRun: boolean;
  scores: Scores;
  synthetic: boolean;
  /** Present only for judge ratings; other raters inherit it through the comparison. */
  instrument?: InstrumentIdentity;
  notes?: string | null;
}

const KIND_LABEL: Record<StoredRaterKind, string> = {
  human: "human",
  llm: "LLM",
  synthetic: "synthetic",
  undeclared: "undeclared",
};

/**
 * How a comparison may be described. `judge-vs-human` is the only class that is
 * calibration in the sense METHODS.md section 2 means; everything else is
 * reported under its own name so it can never be quoted as one.
 */
type PairClass =
  | "judge-vs-human"
  | "human-vs-human"
  | "machine-vs-machine"
  | "synthetic"
  | "undeclared";

const PAIR_CLASS_LABEL: Record<PairClass, string> = {
  "judge-vs-human": "judge vs human (calibration)",
  "human-vs-human": "human vs human",
  "machine-vs-machine": "machine vs machine (not human calibration)",
  synthetic: "synthetic demo data (measures nothing)",
  undeclared: "undeclared rater (excluded)",
};

function classifyPair(a: Rating, b: Rating): PairClass {
  if (a.raterKind === "synthetic" || b.raterKind === "synthetic") return "synthetic";
  if (a.raterKind === UNDECLARED_RATER_KIND || b.raterKind === UNDECLARED_RATER_KIND) {
    return "undeclared";
  }
  const humans = [a, b].filter((r) => r.raterKind === "human").length;
  if (humans === 2) return "human-vs-human";
  if (humans === 1) return "judge-vs-human";
  return "machine-vs-machine";
}

/** Rater ids alone are ambiguous, so every printed pair carries both kinds. */
function raterPairLabel(a: Rating, b: Rating): string {
  return `${a.raterId} [${KIND_LABEL[a.raterKind]}] vs ${b.raterId} [${KIND_LABEL[b.raterKind]}]`;
}

/**
 * The rater kind of a manual rating file. Absent means undeclared: the record
 * predates the field, and nothing about the reviewer id licenses guessing.
 */
function manualRaterKind(value: unknown, label: string): StoredRaterKind {
  if (value === undefined) return UNDECLARED_RATER_KIND;
  if (!isRaterKind(value)) {
    throw new Error(`${label} must be one of ${RATER_KINDS.join(", ")} when present.`);
  }
  return value;
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
    const h = JSON.parse(readFileSync(hp, "utf8")) as ManualRatingFile;
    const reviewerScores = manualScores(h.dimensions, `${hp}.dimensions`);
    const synthetic = h.synthetic === true;
    const raterKind = manualRaterKind(h.rater_kind, `${hp}.rater_kind`);
    if (raterKind !== UNDECLARED_RATER_KIND && (raterKind === "synthetic") !== synthetic) {
      throw new Error(
        `${hp}: rater_kind ${JSON.stringify(raterKind)} and synthetic ` +
          `${JSON.stringify(synthetic)} disagree about who wrote this rating.`,
      );
    }
    out.push({
      runId: h.run_id,
      raterId: h.reviewer,
      raterKind,
      judgeRun: false,
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
      raterKind: synthetic ? "synthetic" : "llm",
      judgeRun: true,
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
        raterKind: e.kind === "fixture" ? "synthetic" : "llm",
        judgeRun: true,
        scores: e.scores,
        synthetic: e.kind === "fixture",
        instrument: instrument(e.gonogo_version, e.backend, e.model_version, e.prompt_hashes),
      });
    } else if (isRaterEvent(e)) {
      out.push({
        runId: e.run_id,
        raterId: e.rater_id,
        raterKind: e.rater_kind,
        judgeRun: false,
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
    if (
      !sameScores ||
      prior.synthetic !== r.synthetic ||
      prior.raterKind !== r.raterKind ||
      !sameInstrument
    ) {
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
    pairClass: PairClass;
    raterPairLabel: string;
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
        const [a, b] = first.judgeRun ? [first, second] : [second, first];
        const instruments = [a.instrument, b.instrument]
          .filter((value): value is InstrumentIdentity => value !== undefined)
          .sort((x, y) => instrumentKey(x).localeCompare(instrumentKey(y)));
        const identities = [...new Map(instruments.map((i) => [instrumentKey(i), i])).values()];
        pairs.push({
          runId,
          a,
          b,
          synthetic: first.synthetic || second.synthetic,
          pairClass: classifyPair(a, b),
          raterPairLabel: raterPairLabel(a, b),
          instrumentKey: JSON.stringify(identities.map(instrumentKey)),
          instrumentLabel:
            identities.length > 0
              ? identities.map(instrumentLabel).join(" <> ")
              : "no judge instrument in this comparison",
        });
      }
    }
  }

  const out: string[] = [];
  const unscored = [...byRun.values()].filter((rs) => rs.length < 2).length;
  const orphans = [...byRun.values()]
    .filter((ratings) => ratings.length < 2)
    .flatMap((ratings) => ratings)
    .filter((rating) => !rating.judgeRun && !rating.synthetic);
  const anyRealHumanRating = [...seen.values()].some(
    (rating) => !rating.judgeRun && !rating.synthetic && rating.raterKind === "human",
  );

  /**
   * Unpaired ratings, listed under the kind of rater that wrote each one. An
   * AI review and a human review are both review effort and neither is
   * agreement data, but they are never printed under one heading.
   */
  const orphanBlock = (): string[] => {
    if (orphans.length === 0) return [];
    const headings: Record<string, string> = {
      human: "human ratings with nothing to compare against",
      llm: "LLM-written ratings with nothing to compare against (not human calibration)",
      synthetic: "synthetic ratings with nothing to compare against",
      undeclared:
        "ratings with no declared rater kind, with nothing to compare against (excluded)",
    };
    const lines: string[] = [];
    for (const kind of ["human", "llm", "undeclared", "synthetic"] as StoredRaterKind[]) {
      const group = orphans.filter((rating) => rating.raterKind === kind);
      if (group.length === 0) continue;
      lines.push("", headings[kind]!);
      for (const rating of group) {
        const shown = DIMENSIONS.map(
          (dimension) => `${dimension} ${rating.scores[dimension]}`,
        ).join(", ");
        lines.push(`  ${rating.runId}  by ${rating.raterId} [${KIND_LABEL[kind]}]`);
        lines.push(`    ${shown}`);
        if (rating.notes) {
          const note = rating.notes.length > 300 ? `${rating.notes.slice(0, 300)}...` : rating.notes;
          lines.push(`    ${JSON.stringify(note)}`);
        }
      }
    }
    lines.push(
      "  These are review records, not agreement data. Pair only ratings made from",
      "  the same evidence snapshot under the same run_id, and only a human rating",
      "  paired with a judge run is human calibration.",
    );
    return lines;
  };

  if (pairs.length === 0) {
    return [
      "No double-scored runs found.",
      "",
      "judge-vs-human calibration pairs: 0",
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

  const synth = pairs.filter((p) => p.synthetic);
  const realPairs = pairs.filter((p) => !p.synthetic);
  // An undeclared rater has no recorded author, so its comparisons are held out
  // of every figure rather than being attributed to whichever kind would be
  // convenient. They are listed below so the exclusion is visible, not silent.
  const undeclared = realPairs.filter((p) => p.pairClass === "undeclared");
  const real = realPairs.filter((p) => p.pairClass !== "undeclared");
  const humanPairs = real.filter((p) => p.pairClass === "judge-vs-human");

  // The count that may never be inflated: only a declared human rating paired
  // with a judge run on the same evidence is judge-versus-human calibration.
  out.push(`judge-vs-human calibration pairs: ${humanPairs.length}`);
  for (const pairClass of ["human-vs-human", "machine-vs-machine"] as PairClass[]) {
    const count = real.filter((p) => p.pairClass === pairClass).length;
    if (count > 0) out.push(`${PAIR_CLASS_LABEL[pairClass]} pairs: ${count}`);
  }
  if (undeclared.length > 0) {
    out.push(`pairs excluded for an undeclared rater kind: ${undeclared.length}`);
  }
  if (humanPairs.length === 0) {
    out.push(
      "No human has recorded a same-evidence rating against a judge run, so gonogo",
      "is uncalibrated against human review. Any figure below is something else.",
    );
  }
  out.push("");

  if (real.length === 0 && synth.length === 0) {
    out.push("No comparison remains after excluding pairs with an undeclared rater kind.");
    out.push("");
  } else if (real.length === 0) {
    out.push("=".repeat(72));
    out.push("SYNTHETIC DATA ONLY — these numbers measure nothing.");
    out.push("Every pair below was hand-written to exercise the aggregation.");
    out.push(
      anyRealHumanRating
        ? "Real human ratings exist, but none forms a same-evidence judge pair."
        : "No human has reviewed a real gonogo run yet.",
    );
    if (undeclared.length > 0) {
      out.push(
        `${undeclared.length} real pair(s) exist but carry an undeclared rater kind and are excluded.`,
      );
    }
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
  // Rater kind is part of the group key, so a human pair and an LLM pair over
  // the same instrument can never land in one table.
  const pairKeys = [
    ...new Set(scored.map((p) => JSON.stringify([p.instrumentKey, p.raterPairLabel]))),
  ].sort();

  for (const groupKey of pairKeys) {
    const [instrumentId, raterPair] = JSON.parse(groupKey) as [string, string];
    const group = scored.filter(
      (p) => p.instrumentKey === instrumentId && p.raterPairLabel === raterPair,
    );
    out.push(`instrument: ${group[0]!.instrumentLabel}`);
    out.push(
      `rater pair: ${raterPair}   (${group.length} run${group.length === 1 ? "" : "s"})`,
    );
    out.push(`comparison: ${PAIR_CLASS_LABEL[group[0]!.pairClass]}`);
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
        `; raters: ${p.raterPairLabel}` +
        `; instrument: ${p.instrumentLabel}`,
    );
  }

  if (undeclared.length > 0) {
    out.push("");
    out.push("pairs excluded because a rater kind was never declared");
    for (const p of undeclared) {
      out.push(`  ${pad(p.runId, 30)}${p.raterPairLabel}`);
    }
    out.push(
      "  A rating written before rater_kind existed is not evidence that a human",
      "  wrote it. Re-record it with an explicit rater_kind to make it countable.",
    );
  }

  out.push(...orphanBlock());

  out.push("");
  out.push(
    `${scored.length} comparison(s)${
      scored.length === 0 ? "" : real.length === 0 ? ", all synthetic" : `, ${real.length} real`
    }, ${humanPairs.length} of them judge-vs-human; ` +
      `${unscored} run(s) have only one rating and were not compared.`,
  );
  out.push(
    `events schema v${EVENT_SCHEMA_VERSION}, gonogo ${GONOGO_VERSION}. ` +
      `"A harsher" counts runs where side A scored below side B.`,
  );
  if (malformed > 0) out.push(`${malformed} malformed line(s) skipped in ${o.eventsPath}.`);
  return out.join("\n");
}
