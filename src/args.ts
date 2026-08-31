export interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

export interface ParseOptions {
  booleanFlags: ReadonlySet<string>;
  multiFlags?: ReadonlySet<string>;
}

function booleanValue(flag: string, raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${flag} expects true or false, got "${raw}"`);
}

/** Parse long options without silently turning malformed booleans into strings. */
export function parseArgs(argv: string[], options: ParseOptions): Args {
  const args: Args = { _: [] };
  const multi = options.multiFlags ?? new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    if (key === "") throw new Error("empty flag name");

    let value: string | boolean;
    if (options.booleanFlags.has(key)) {
      if (inline !== undefined) {
        value = booleanValue(key, inline);
      } else {
        const next = argv[i + 1];
        if (next === "true" || next === "false") {
          value = booleanValue(key, next);
          i++;
        } else {
          value = true;
        }
      }
    } else {
      if (inline !== undefined) {
        if (inline === "") throw new Error(`--${key} requires a value`);
        value = inline;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`--${key} requires a value`);
        }
        value = next;
        i++;
      }
    }

    if (multi.has(key)) {
      const prior = args[key];
      if (prior === undefined) args[key] = [String(value)];
      else if (Array.isArray(prior)) prior.push(String(value));
      else args[key] = [String(prior), String(value)];
    } else if (args[key] !== undefined) {
      throw new Error(`--${key} may only be provided once`);
    } else {
      args[key] = value;
    }
  }

  return args;
}

export function assertKnownFlags(args: Args, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(args).filter((key) => key !== "_" && !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((f) => `--${f}`).join(", ")}`);
  }
  if (args._.length > 0) {
    throw new Error(`unexpected argument${args._.length === 1 ? "" : "s"}: ${args._.join(" ")}`);
  }
}

export function str(args: Args, key: string, fallback?: string): string | undefined {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return fallback;
  return Array.isArray(value) ? value[value.length - 1] : value;
}
