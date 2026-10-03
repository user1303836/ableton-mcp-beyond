/**
 * A spinner after a step's words while Kumi works ("Updating Live's Remote Script and the bridge… ⠹"),
 * so a step that takes a minute doesn't look stuck. Only in a terminal: piped, or with KUMI_UI=plain
 * (screen readers) or TERM=dumb, a step is just its line and nothing moves. It's the full-screen app's
 * thinking spinner, in characters every console font has where Kumi's icons are badges.
 */
import type { Writable } from "node:stream";
import { activityGlyph } from "./tui/activity.js";
import { detectIconStyle } from "./tui/icons.js";
import { detectColorDepth, sgr } from "./tui/style.js";

type Env = Readonly<Record<string, string | undefined>>;
type Out = Writable & { isTTY?: boolean; columns?: number };

export interface Spinning {
  /** The spinner goes; a kept line stays as its words. Saying it twice does nothing. */
  stop(): void;
}

/** Whether `out` gets a spinner: a terminal, and plain lines weren't asked for. */
export const spins = (out: Writable, env: Env) => Boolean((out as Out).isTTY) && env.KUMI_UI !== "plain" && env.TERM !== "dumb";

/**
 * `line` with a spinner after it until stop(). Kept (the default), the line stays once stopped, and is
 * all that's written where nothing spins; otherwise it shows only while spinning, for a wait nothing
 * else describes. Nothing else may write to `out` until it's stopped.
 */
export function spin(out: Writable, env: Env, line: string, options: { keep?: boolean } = {}): Spinning {
  const keep = options.keep ?? true;
  if (!spins(out, env)) { if (keep) out.write(`${line}\n`); return { stop() {} }; }
  const plain = detectIconStyle(env) === "badges"; const depth = detectColorDepth(env as NodeJS.ProcessEnv);
  const started = Date.now();
  const draw = () => {
    const glyph = activityGlyph("think", Date.now() - started, plain);
    // On one row, so each frame replaces the last: a line too wide for the window is shortened while it spins.
    const room = Math.max(8, ((out as Out).columns ?? 80) - 3);
    const words = line.length > room ? `${line.slice(0, room - 1)}…` : line;
    out.write(`\r\u001b[2K${words} ${depth === "none" ? glyph.text : `${sgr(glyph.style, depth)}${glyph.text}\u001b[0m`}`);
  };
  draw();
  // Never what keeps Kumi running: the work it shows does that.
  const timer = setInterval(draw, 100); timer.unref();
  let stopped = false;
  return { stop() { if (stopped) return; stopped = true; clearInterval(timer); out.write(`\r\u001b[2K${keep ? `${line}\n` : ""}`); } };
}

/** `line` (a step: "Copying the bridge…") with a spinner after it while `work` runs. */
export async function step<T>(out: Writable, env: Env, line: string, work: () => Promise<T>, options: { keep?: boolean } = {}): Promise<T> {
  const spinning = spin(out, env, line, options);
  try { return await work(); } finally { spinning.stop(); }
}
