/**
 * Where an event is allowed to be written.
 *
 * `events.jsonl` at the root of the gonogo checkout is committed. It is the
 * fixture-sweep log: every line in it describes this repository's own public
 * fixtures, and `eval` reads it back as its substrate. A `real`, `rater` or
 * `outcome` event is not that. It describes somebody's actual work — the spec
 * they were given, the repository they changed, the verdict on it — and
 * appending one to a tracked file publishes it at the next `git add`.
 *
 * So the boundary is a location, not a guess about content: subject events may
 * not be written anywhere inside the gonogo checkout except the gitignored
 * `private/` directory, which is the documented default for them. Outside the
 * checkout the operator has named a destination explicitly and owns it.
 * Fixture events are unaffected and keep the tracked log.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventKind } from "./events.ts";

/** The gonogo checkout itself — the git repository this file is committed to. */
export const GONOGO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked, committed, public. Fixture events only. */
export const TRACKED_FIXTURE_EVENTS = join(GONOGO_ROOT, "events.jsonl");

/** Gitignored. The default destination for real, rater and outcome events. */
export const PRIVATE_EVENTS_DIR = join(GONOGO_ROOT, "private");
export const PRIVATE_EVENTS = join(PRIVATE_EVENTS_DIR, "events.jsonl");

/** Kinds that record a subject's real work rather than a committed fixture. */
const SUBJECT_KINDS = new Set<EventKind>(["real", "rater", "outcome"]);

export function isSubjectEventKind(kind: EventKind): boolean {
  return SUBJECT_KINDS.has(kind);
}

/**
 * The real path of `path`, symlinks resolved as far as the filesystem knows it.
 * A destination that does not exist yet resolves through its deepest existing
 * ancestor, so `private/../events.jsonl` and a symlinked directory both land on
 * the same string as the file they would actually write.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...trailing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      trailing.push(basename(current));
      current = parent;
    }
  }
}

function comparable(path: string): string {
  // darwin and win32 are case-insensitive by default, so EVENTS.JSONL and
  // events.jsonl are one file there and must compare as one.
  return process.platform === "darwin" || process.platform === "win32"
    ? path.toLowerCase()
    : path;
}

function within(parent: string, child: string): boolean {
  if (comparable(parent) === comparable(child)) return true;
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** True when both paths name one file on disk: same device, same inode. */
function sameFileOnDisk(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** True when `path` is the committed fixture log, by any spelling of it. */
export function isTrackedFixtureLog(path: string): boolean {
  const candidate = canonicalPath(path);
  const tracked = canonicalPath(TRACKED_FIXTURE_EVENTS);
  return comparable(candidate) === comparable(tracked) || sameFileOnDisk(candidate, tracked);
}

/** True when `path` would be written inside the gonogo checkout's public area. */
export function isPublishedLocation(path: string): boolean {
  const candidate = canonicalPath(path);
  const root = canonicalPath(GONOGO_ROOT);
  const priv = canonicalPath(PRIVATE_EVENTS_DIR);
  return within(root, candidate) && !within(priv, candidate);
}

function describe(kind: EventKind): string {
  if (kind === "real") return "a real judge event";
  if (kind === "outcome") return "an outcome event";
  return "a rater event";
}

function safeCommandFor(kind: EventKind): string {
  if (kind === "real") return `gonogo judge ... --events ${PRIVATE_EVENTS}`;
  if (kind === "outcome") return `gonogo outcome ... --events ${PRIVATE_EVENTS}`;
  return `record it with --events ${PRIVATE_EVENTS}`;
}

/**
 * Fail closed before anything is opened, created or appended. Called by
 * `appendEvent`, so no writer can reach the tracked log by another route, and
 * again by the CLI so a doomed run stops before it costs a judge call.
 */
export function assertWritableDestination(path: string, kind: EventKind): void {
  // Both checks, not one: a location test alone misses a hard link inside
  // `private/` pointing at the tracked log, which has no symlink to resolve.
  if (!isSubjectEventKind(kind)) return;
  if (!isPublishedLocation(path) && !isTrackedFixtureLog(path)) return;
  const where = isTrackedFixtureLog(path)
    ? "the tracked fixture event log"
    : "a public location inside the gonogo checkout";
  throw new Error(
    `refusing to write ${describe(kind)} to ${resolve(path)}: that is ${where}, ` +
      `and it is committed to a public repository. Only fixture events belong there. ` +
      `Write subject events to the gitignored private log or to a path outside ` +
      `${GONOGO_ROOT}: ${safeCommandFor(kind)}`,
  );
}
