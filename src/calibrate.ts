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

interface Rating {
  runId: string;
  raterId: string;
  scores: Scores;
  synthetic: boolean;
  /**
   * Which prompt version produced (or was compared against) this rating.
   * METHODS.md: a prompt change makes a new instrument, and runs from
   * different instruments are never pooled silently into one figure.
   */
  promptSignature?: string | null;
  notes?: string | null;
}

/** A short, stable label for one set of prompt files. */
export function promptSignatureOf(
  files: { path: string; sha256: string }[] | Record<string, string> | undefined,
): string | null {
  if (!files) return null;
  const pairs = Array.isArray(files)
    ? files.map((f) => [f.path, f.sha256] as const)
    : Object.entries(files);
  if (pairs.length === 0) return null;
  return pairs
    .slice()
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, sha]) => `${path.split("/").pop()}@${sha.slice(0, 8)}`)
    .join(" ");
}

/**
 * The operator's flow is unchanged: write runs/<ts>/human.json next to
 * verdict.json. Those directories are read as rater events without being
 * rewritten, so the log can be the computation substrate without the directory
 * layout having to move first.
 */
function ratingsFromDirs(dir: string, depth = 3): Rating[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: Rating[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(dir, entry.name);
    // Recurse: a rating directory can sit anywhere under calibration/ or runs/,
    // and a layout convention is not a good reason to lose a human verdict.
    if (!existsSync(join(runDir, "human.json"))) {
      out.push(...ratingsFromDirs(runDir, depth - 1));
      continue;
    }
    const vp = join(runDir, "verdict.json");
    const hp = join(runDir, "human.json");
    // A human verdict counts whether or not a machine verdict sits beside it.
    // Requiring the pair meant a reviewer's scores for a run gonogo never
    // judged were dropped without a word, which is the one thing a calibration
    // tool must never do with the evidence it exists to collect.
    if (!existsSync(hp)) continue;
    const h = JSON.parse(readFileSync(hp, "utf8")) as HumanFile;
    const synthetic = h.synthetic === true;
    if (existsSync(vp)) {
      const v = JSON.parse(readFileSync(vp, "utf8")) as VerdictFile;
      const judgeScores: Scores = {};
      for (const d of DIMENSIONS) {
        const r = v.dimensions[d];
        judgeScores[d] = r.score === "abstain" ? "abstain" : (r.score as number);
      }
      out.push({
        runId: h.run_id || entry.name,
        raterId: `judge:${v.provenance.judge_backend}`,
        scores: judgeScores,
        synthetic,
        promptSignature: promptSignatureOf(v.provenance.prompt_files),
      });
    }
    out.push({
      runId: h.run_id || entry.name,
      raterId: h.reviewer,
      scores: h.dimensions as Scores,
      synthetic,
      notes: h.notes ?? null,
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
        synthetic: false,
        promptSignature: promptSignatureOf(e.prompt_hashes),
      });
    } else if (isRaterEvent(e)) {
      out.push({
        runId: e.run_id,
        raterId: e.rater_id,
        scores: e.scores,
        synthetic: e.synthetic === true,
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
  const ratings = [...ratingsFromEvents(events), ...o.dirs.flatMap((d) => ratingsFromDirs(d))];

  // The same (run, rater) may appear both in the log and in a run directory.
  // First writer wins; the log is read first because it carries more fields.
  const seen = new Map<string, Rating>();
  for (const r of ratings) {
    const key = `${r.runId} ${r.raterId}`;
    if (!seen.has(key)) seen.set(key, r);
  }

  const byRun = new Map<string, Rating[]>();
  for (const r of seen.values()) {
    if (!byRun.has(r.runId)) byRun.set(r.runId, []);
    byRun.get(r.runId)!.push(r);
  }

  // A comparison needs two raters on the same run. Anything else is a run
  // nobody double-scored, which is what Phase 1 of the trust ratchet exists
  // to eliminate.
  const pairs: { runId: string; a: Rating; b: Rating; synthetic: boolean }[] = [];
  for (const [runId, rs] of byRun) {
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const first = rs[i]!;
        const second = rs[j]!;
        // Order the pair so a judge is always side A; the direction of
        // disagreement only means something if the sides are stable.
        const [a, b] = first.raterId.startsWith("judge:") ? [first, second] : [second, first];
        pairs.push({ runId, a, b, synthetic: first.synthetic || second.synthetic });
      }
    }
  }

  const out: string[] = [];
  const unscored = [...byRun.values()].filter((rs) => rs.length < 2).length;

  // Ratings by someone other than the judge, on runs nobody else scored. These
  // are real review effort, and a calibration tool that drops them on the floor
  // is lying by omission about the evidence it holds.
  const orphanHuman = [...byRun.values()]
    .filter((rs) => rs.length < 2)
    .flatMap((rs) => rs)
    .filter((r) => !r.raterId.startsWith("judge:") && !r.synthetic);
  const anyRealHumanRating = [...seen.values()].some(
    (r) => !r.raterId.startsWith("judge:") && !r.synthetic,
  );

  const orphanBlock = (): string[] => {
    if (orphanHuman.length === 0) return [];
    const lines = ["", "human ratings with nothing to compare against"];
    for (const r of orphanHuman) {
      const shown = DIMENSIONS.map((d) => `${d} ${r.scores[d] ?? "-"}`).join(", ");
      lines.push(`  ${r.runId}  by ${r.raterId}`);
      lines.push(`    ${shown}`);
      if (r.notes) lines.push(`    "${r.notes.slice(0, 300)}${r.notes.length > 300 ? "..." : ""}"`);
    }
    lines.push(
      "  These are counted as review effort, not as agreement. To turn one into a",
      "  calibration pair, judge the same run with the same evidence and the same",
      "  run_id, so both raters scored the same thing.",
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
        ? "Real human ratings DO exist (listed below) but none share a run with a judge"
        : "No human has reviewed a real gonogo run yet.",
    );
    out.push(
      anyRealHumanRating
        ? "verdict, so none of them contribute here. Do not quote these figures anywhere."
        : "Do not quote these figures anywhere.",
    );
    out.push("=".repeat(72));
    out.push("");
  } else if (synth.length > 0) {
    out.push(
      `NOTE: ${synth.length} synthetic pair(s) present and EXCLUDED from the statistics below.`,
    );
    out.push("");
  }

  const scored = real.length > 0 ? real : synth;

  // METHODS.md: a prompt change makes a new instrument version, and runs from
  // different versions are reported separately, never pooled silently into one
  // agreement figure. The judge side of each pair carries the signature.
  const stratumOf = (p: { a: Rating }) => p.a.promptSignature ?? "(prompt version not recorded)";
  const pairKeys = [
    ...new Set(scored.map((p) => `${p.a.raterId} vs ${p.b.raterId}\u0000${stratumOf(p)}`)),
  ].sort();
  const strata = new Set(scored.map(stratumOf));
  if (strata.size > 1) {
    out.push(
      `${strata.size} prompt versions present. Agreement is reported per version and`,
      "never pooled across them: a prompt change makes a new instrument, not more data.",
      "",
    );
  }

  for (const compositeKey of pairKeys) {
    const [key, stratum] = compositeKey.split("\u0000") as [string, string];
    const group = scored.filter(
      (p) => `${p.a.raterId} vs ${p.b.raterId}` === key && stratumOf(p) === stratum,
    );
    out.push(`rater pair: ${key}   (${group.length} run${group.length === 1 ? "" : "s"})`);
    out.push(`  prompt version: ${stratum}`);
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
        (abst.length ? `; abstentions: ${abst.join(", ")}` : ""),
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
