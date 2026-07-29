import { stdin, stdout } from "node:process";
import { analyzePcm, decodeFloat32Le } from "./analysis.js";
import { compareReferenceAudio } from "./reference-analysis.js";
import type { ConventionalChannelLabel } from "./audio-standards.js";
import { MAX_ANALYSIS_JOB_REQUEST_BYTES } from "./analysis-runner.js";

interface EncodedSource {
  pcmBase64: string;
  sampleRate: number;
  channels?: number;
  channelLayout?: ConventionalChannelLabel[];
  frameSize?: number;
}

type WorkerRequest =
  | { mode: "analyze"; source: EncodedSource }
  | { mode: "compare"; project: EncodedSource; reference: EncodedSource; alignment?: { mode?: "auto" | "manual" | "disabled"; maxLagSeconds?: number; manualOffsetSeconds?: number } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseSource(value: unknown, label: string): EncodedSource {
  if (!isObject(value) || !hasOnly(value, ["pcmBase64", "sampleRate", "channels", "channelLayout", "frameSize"]) || typeof value.pcmBase64 !== "string" || !Number.isInteger(value.sampleRate) || (value.channels !== undefined && !Number.isInteger(value.channels)) || (value.frameSize !== undefined && !Number.isInteger(value.frameSize))) throw new RangeError(`${label} is invalid`);
  if (value.channelLayout !== undefined && (!Array.isArray(value.channelLayout) || value.channelLayout.some((item) => !["M", "L", "R", "C", "Ls", "Rs", "LFE"].includes(String(item))))) throw new RangeError(`${label}.channelLayout is invalid`);
  return value as unknown as EncodedSource;
}

function parseAlignment(value: unknown): { mode?: "auto" | "manual" | "disabled"; maxLagSeconds?: number; manualOffsetSeconds?: number } | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !hasOnly(value, ["mode", "maxLagSeconds", "manualOffsetSeconds"]) || (value.mode !== undefined && !["auto", "manual", "disabled"].includes(String(value.mode))) || (value.maxLagSeconds !== undefined && typeof value.maxLagSeconds !== "number") || (value.manualOffsetSeconds !== undefined && typeof value.manualOffsetSeconds !== "number")) throw new RangeError("alignment is invalid");
  return value as { mode?: "auto" | "manual" | "disabled"; maxLagSeconds?: number; manualOffsetSeconds?: number };
}

async function readRequest(): Promise<WorkerRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_ANALYSIS_JOB_REQUEST_BYTES) throw new RangeError("analysis job request exceeds the worker input limit");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isObject(value) || (value.mode !== "analyze" && value.mode !== "compare")) throw new RangeError("analysis job mode is invalid");
  if (value.mode === "analyze") {
    if (!hasOnly(value, ["mode", "source"])) throw new RangeError("analysis job has unknown fields");
    return { mode: "analyze", source: parseSource(value.source, "source") };
  }
  if (!hasOnly(value, ["mode", "project", "reference", "alignment"])) throw new RangeError("comparison job has unknown fields");
  const alignment = parseAlignment(value.alignment);
  return { mode: "compare", project: parseSource(value.project, "project"), reference: parseSource(value.reference, "reference"), ...(alignment ? { alignment } : {}) };
}

function decode(source: EncodedSource): { samples: Float32Array; sampleRate: number; channels: number; channelLayout?: ConventionalChannelLabel[]; frameSize?: number } {
  return {
    samples: decodeFloat32Le(source.pcmBase64),
    sampleRate: source.sampleRate,
    channels: source.channels ?? 1,
    ...(source.channelLayout ? { channelLayout: source.channelLayout } : {}),
    ...(source.frameSize ? { frameSize: source.frameSize } : {}),
  };
}

try {
  const request = await readRequest();
  const result = request.mode === "analyze"
    ? analyzePcm(decode(request.source))
    : compareReferenceAudio({ project: decode(request.project), reference: decode(request.reference), ...(request.alignment ? { alignment: request.alignment } : {}) });
  stdout.write(JSON.stringify({ ok: true, result }));
} catch (cause) {
  const message = cause instanceof Error ? cause.message : "analysis job failed";
  stdout.write(JSON.stringify({ ok: false, error: message.slice(0, 1_024) }));
  process.exitCode = 1;
}
