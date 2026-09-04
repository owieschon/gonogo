/**
 * Where an event is allowed to be written.
 *
 * `events.jsonl` at the root of the gonogo checkout is committed. It is the
 * fixture-sweep destination, and `eval` reads it back as its substrate. Its
 * append-only history retains ten public non-fixture records written before
 * this boundary existed; their exact fingerprints are pinned by the privacy
 * tests. A new `real`, `rater` or `outcome` event describes somebody's actual
 * work — the spec they were given, the repository they changed, the verdict on
 * it — and appending one to a tracked file publishes it at the next `git add`.
 *
 * So the boundary is a location, not a guess about content: subject events may
 * not be written anywhere inside the gonogo checkout except the gitignored
 * `private/` directory, which is the documented default for them. Outside the
 * checkout the operator has named a destination explicitly and owns it.
 * Fixture events are unaffected and keep the tracked log.
 */
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventKind } from "./events.ts";

/** The gonogo checkout itself — the git repository this file is committed to. */
export const GONOGO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked, committed and public. Only fixture events may be appended now. */
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
 * The path `path` really names on this filesystem, resolved the way the kernel
 * resolves it: one component at a time, left to right, each prefix run through
 * `realpath` before the next component is applied.
 *
 * The order is the whole point. `path.resolve` collapses `..` lexically, before
 * any symlink is followed, so `outside/link/../events.jsonl` — where `link` is a
 * symlink into this checkout — reads as `outside/events.jsonl` to a lexical
 * normalizer and as `<checkout>/events.jsonl` to `open(2)`. Applying `..` to the
 * already-resolved prefix instead makes the two agree.
 *
 * A component that does not exist yet keeps its lexical form and the walk
 * continues, so a destination whose directories `appendEvent` is about to create
 * normalizes to the file it will create.
 *
 * A component that exists but is a symlink whose target does not exist yet is
 * neither of those. `realpath` fails on it, so it used to keep its lexical form
 * too — while `open(2)` still followed it and created its target. Such a
 * component is expanded by reading the link and continuing the walk at the
 * target, so a dangling symlink normalizes to the file it will create.
 */
export function canonicalPath(path: string): string {
  return walk(path, { hops: 0 });
}

/**
 * `realpath` gives up after this many links; so does this walk, and it refuses
 * rather than returning a path that names no file.
 */
const SYMLINK_HOPS_LIMIT = 40;

function walk(path: string, budget: { hops: number }): string {
  // Not `resolve`/`join`: both would collapse `..` before a symlink is seen.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const root = parse(absolute).root;
  const components = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((component) => component !== "" && component !== ".");
  let current = root;
  for (const component of components) {
    current = component === ".." ? dirname(current) : join(current, component);
    current = expand(current, budget);
  }
  return current;
}

/** One component, already appended to a resolved prefix, resolved in place. */
function expand(current: string, budget: { hops: number }): string {
  try {
    return realpathSync.native(current);
  } catch {
    // Either nothing is there, or a symlink is there whose target is not.
  }
  let target: string;
  try {
    if (!lstatSync(current).isSymbolicLink()) return current;
    target = readlinkSync(current);
  } catch {
    // Does not exist yet. The lexical form stands and the components after it
    // are applied to it, which is what the kernel will do once it is created.
    return current;
  }
  if (++budget.hops > SYMLINK_HOPS_LIMIT) {
    throw new Error(`too many symbolic links while resolving ${current}`);
  }
  // Concatenated, not joined: a relative target may begin with `..`, and that
  // `..` belongs to the walk, which applies it to the resolved prefix.
  return walk(isAbsolute(target) ? target : `${dirname(current)}${sep}${target}`, budget);
}

/** True when two paths name the same file, by the same rules as the boundary. */
export function isSamePath(a: string, b: string): boolean {
  return comparable(canonicalPath(a)) === comparable(canonicalPath(b));
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

/** True when the canonical `candidate` is the committed fixture log. */
function resolvedIsTrackedFixtureLog(candidate: string): boolean {
  const tracked = canonicalPath(TRACKED_FIXTURE_EVENTS);
  return comparable(candidate) === comparable(tracked) || sameFileOnDisk(candidate, tracked);
}

/** True when the canonical `candidate` sits in the checkout's public area. */
function resolvedIsPublishedLocation(candidate: string): boolean {
  const root = canonicalPath(GONOGO_ROOT);
  const priv = canonicalPath(PRIVATE_EVENTS_DIR);
  return within(root, candidate) && !within(priv, candidate);
}

/** True when `path` is the committed fixture log, by any spelling of it. */
export function isTrackedFixtureLog(path: string): boolean {
  return resolvedIsTrackedFixtureLog(canonicalPath(path));
}

/** True when `path` would be written inside the gonogo checkout's public area. */
export function isPublishedLocation(path: string): boolean {
  return resolvedIsPublishedLocation(canonicalPath(path));
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
 * Normalize the destination once, decide on that exact string, and return it.
 *
 * The returned path is the one every caller must use for its existence check,
 * its read, its `mkdir` and its append. Deciding on one spelling and writing to
 * another is the bug this function exists to make impossible: a lexical
 * normalizer collapses `..` before symlinks, so a destination could be approved
 * as "outside the checkout" while `open(2)` landed on the tracked log.
 *
 * What this does not close, stated so nobody reads more into it:
 *
 * - **Final-component TOCTOU.** The decision is made from the filesystem as it
 *   stands at this call. Anything with write access to a directory on the path
 *   can replace a component between this check and the append.
 * - **Alternate mount aliases.** One file reachable through two mount points is
 *   two canonical paths here. The device-and-inode comparison catches that for
 *   the tracked log itself, but not for the rest of the checkout.
 * - **Case-insensitive filesystems on Linux.** The case-folded comparison is
 *   applied on darwin and win32 only, by platform, not by asking the filesystem.
 *   A case-insensitive mount on Linux is compared case-sensitively.
 */
export function resolveEventDestination(path: string, kind: EventKind): string {
  const destination = canonicalPath(path);
  // Both checks, not one: a location test alone misses a hard link inside
  // `private/` pointing at the tracked log, which has no symlink to resolve.
  if (!isSubjectEventKind(kind)) return destination;
  const tracked = resolvedIsTrackedFixtureLog(destination);
  if (!resolvedIsPublishedLocation(destination) && !tracked) return destination;
  const where = tracked
    ? "the tracked fixture event log"
    : "a public location inside the gonogo checkout";
  throw new Error(
    `refusing to write ${describe(kind)} to ${destination}: that is ${where}, ` +
      `and it is committed to a public repository. Only fixture events belong there. ` +
      `Write subject events to the gitignored private log or to a path outside ` +
      `${GONOGO_ROOT}: ${safeCommandFor(kind)}`,
  );
}

/**
 * Fail closed before anything is opened, created or appended. Called by
 * `appendEvent`, so no writer can reach the tracked log by another route, and
 * again by the CLI so a doomed run stops before it costs a judge call.
 */
export function assertWritableDestination(path: string, kind: EventKind): void {
  resolveEventDestination(path, kind);
}
