import { createHash } from "node:crypto";
import type { PcmAnalysis } from "./analysis.js";
import type { Device, LiveRef, LiveSnapshot, Track } from "./live.js";

export const AUDIO_DIAGNOSIS_VERSION = "audio-diagnosis/v1" as const;

export interface AudioSourceProvenance {
  kind: "caller-supplied-pcm" | "verified-live-resampling-capture";
  observedAt: string;
  description: string;
  captureId?: string;
}

export interface AudioDiagnosticFinding {
  findingId: string;
  severity: "info" | "warning" | "critical";
  measuredEvidence: Record<string, number | string | boolean | null>;
  projectRefs: LiveRef[];
  hypothesis: string;
  confidence: "high-measurement" | "medium" | "low-context-only";
  missingEvidence: string[];
  suggestedPreview: { tool: "live_mixer_preview"; arguments: { trackRef: LiveRef; volume: number }; verification: string } | null;
}

export interface AudioDiagnosis {
  version: typeof AUDIO_DIAGNOSIS_VERSION;
  diagnosisId: string;
  source: AudioSourceProvenance & { relationshipToLive: "verified-by-capture-lifecycle" | "declared-by-caller-not-verified" };
  context: {
    capturedAt: string;
    epoch: number;
    set: { ref: LiveRef; name: string };
    track: { ref: LiveRef; name: string; kind: string };
    mixer: unknown;
    routing: unknown;
    devices: Array<{ ref: LiveRef; name: string; kind: string; enabled: boolean | null; parentRef: LiveRef; parameters: Array<{ ref: LiveRef; name: string; value: number; displayValue: string | null }> }>;
    contextRevision: string;
    latencyAvailable: false;
    captureTap: "session-resampling" | "caller-declared-unknown";
  };
  findings: AudioDiagnosticFinding[];
  causality: { claimed: false; statement: string };
  privacy: { rawAudioRetained: false; rawAudioReturned: false };
}

function flattenDevices(devices: readonly Device[], parentRef: LiveRef, output: AudioDiagnosis["context"]["devices"]): void {
  for (const device of devices) {
    if (output.length >= 64) return;
    output.push({
      ref: device.ref,
      name: device.name,
      kind: device.kind,
      enabled: typeof device.enabled === "boolean" ? device.enabled : null,
      parentRef,
      parameters: device.parameters.slice(0, 32).map((parameter) => ({ ref: parameter.ref, name: parameter.name, value: parameter.value, displayValue: parameter.displayValue ?? null })),
    });
    for (const chain of device.chains ?? []) flattenDevices(chain.devices, chain.ref, output);
    for (const pad of device.drumPads ?? []) for (const chain of pad.chains) flattenDevices(chain.devices, chain.ref, output);
  }
}

function refs(track: Track): LiveRef[] {
  const result: LiveRef[] = [track.ref];
  for (const ref of [track.mixer?.volumeRef, track.mixer?.panRef, track.mixer?.cueRef, ...(track.mixer?.sendRefs ?? [])]) if (ref) result.push(ref);
  return [...new Set(result)];
}

function mixerSuggestion(track: Track): AudioDiagnosticFinding["suggestedPreview"] {
  const volume = track.mixer?.volume;
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0) return null;
  return {
    tool: "live_mixer_preview",
    arguments: { trackRef: track.ref, volume: Math.max(0, Math.round(volume * 0.9 * 1_000_000) / 1_000_000) },
    verification: "This is a reversible 10% normalized-control intervention, not a promised dB change. Confirm explicitly, recapture the identical scope, and compare before/after measurements.",
  };
}

export function diagnoseAudioWithLiveContext(analysis: PcmAnalysis, snapshot: LiveSnapshot, epoch: number, trackRef: LiveRef, source: AudioSourceProvenance, capturedAt = new Date().toISOString()): AudioDiagnosis {
  const track = snapshot.tracks.find((item) => item.ref === trackRef);
  if (!track) throw new Error("diagnosis trackRef is not present in the authoritative snapshot");
  const devices: AudioDiagnosis["context"]["devices"] = [];
  flattenDevices(track.devices, track.ref, devices);
  const contextPayload = { epoch, set: { ref: snapshot.set.ref, name: snapshot.set.name }, track: { ref: track.ref, name: track.name, kind: track.kind }, mixer: track.mixer ?? null, routing: track.routing ?? null, devices };
  const contextRevision = createHash("sha256").update(JSON.stringify(contextPayload)).digest("hex");
  const projectRefs = refs(track);
  const findings: AudioDiagnosticFinding[] = [];
  const truePeak = analysis.standardsAudio.truePeak.aggregateDbtp;

  if (analysis.clipping.count > 0) {
    findings.push({
      findingId: "sample-full-scale-boundary",
      severity: "critical",
      measuredEvidence: { clippingSamples: analysis.clipping.count, clippingRatio: analysis.clipping.ratio, samplePeakDbfs: analysis.peakDbfs },
      projectRefs,
      hypothesis: "The analyzed programme reaches the normalized sample boundary; gain staging or limiting in the measured path may need inspection.",
      confidence: "high-measurement",
      missingEvidence: ["No Live meter history or per-device gain-reduction telemetry is available, so no device is identified as causal."],
      suggestedPreview: mixerSuggestion(track),
    });
  } else if (truePeak !== null && truePeak > -1) {
    findings.push({
      findingId: "limited-true-peak-headroom",
      severity: "warning",
      measuredEvidence: { truePeakDbtp: truePeak, samplePeakDbfs: analysis.peakDbfs, thresholdDbtp: -1 },
      projectRefs,
      hypothesis: "The measured signal has less than 1 dB of true-peak headroom at this capture point.",
      confidence: "high-measurement",
      missingEvidence: ["Delivery target and downstream codec behavior were not provided.", "Ordered devices are context only; their presence does not prove causation."],
      suggestedPreview: mixerSuggestion(track),
    });
  }

  const dcMaximum = Math.max(...analysis.channelsDetail.map((channel) => Math.abs(channel.dcOffset)));
  if (dcMaximum > 0.01) findings.push({
    findingId: "dc-offset-observed",
    severity: "warning",
    measuredEvidence: { maximumAbsoluteDcOffset: dcMaximum },
    projectRefs,
    hypothesis: "The analyzed selection contains a measurable DC component or an asymmetric short selection.",
    confidence: "high-measurement",
    missingEvidence: ["A longer, silence-trimmed capture may be needed to distinguish sustained DC from selection bias."],
    suggestedPreview: null,
  });

  if (analysis.stereo.phaseCorrelation !== null && analysis.stereo.phaseCorrelation < -0.2) findings.push({
    findingId: "negative-stereo-correlation",
    severity: "warning",
    measuredEvidence: { phaseCorrelation: analysis.stereo.phaseCorrelation },
    projectRefs,
    hypothesis: "The measured stereo programme has substantial anti-correlated energy and may lose level when collapsed to mono.",
    confidence: "high-measurement",
    missingEvidence: ["No mono fold-down audition or downstream playback topology was observed."],
    suggestedPreview: null,
  });

  if (devices.length > 0) findings.push({
    findingId: "signal-chain-context-observed",
    severity: "info",
    measuredEvidence: { orderedDeviceCount: devices.length, publishedParameterCount: devices.reduce((sum, device) => sum + device.parameters.length, 0) },
    projectRefs: [track.ref, ...devices.map((device) => device.ref)],
    hypothesis: "The ordered device and published-parameter rows are available for operator inspection, but they are not attributed as causes of any measured delta.",
    confidence: "low-context-only",
    missingEvidence: ["Device latency, sidechain topology, hidden parameters, gain reduction, and exact capture position inside the device chain are unavailable."],
    suggestedPreview: null,
  });

  if (findings.length === 0) findings.push({
    findingId: "no-threshold-finding",
    severity: "info",
    measuredEvidence: { clippingSamples: 0, truePeakDbtp: truePeak, phaseCorrelation: analysis.stereo.phaseCorrelation },
    projectRefs,
    hypothesis: "No configured clipping, true-peak-headroom, DC-offset, or stereo-correlation threshold was crossed by this bounded analysis.",
    confidence: "high-measurement",
    missingEvidence: ["This is not a mastering, compliance, or perceptual-quality verdict."],
    suggestedPreview: null,
  });

  const relationshipToLive = source.kind === "verified-live-resampling-capture" ? "verified-by-capture-lifecycle" : "declared-by-caller-not-verified";
  const diagnosisId = createHash("sha256").update(JSON.stringify({ source, contextRevision, analysisVersion: analysis.version, integrated: analysis.standardsAudio.loudness.integratedLufs, truePeak })).digest("hex");
  return {
    version: AUDIO_DIAGNOSIS_VERSION,
    diagnosisId,
    source: { ...source, relationshipToLive },
    context: { ...contextPayload, capturedAt, contextRevision, latencyAvailable: false, captureTap: source.kind === "verified-live-resampling-capture" ? "session-resampling" : "caller-declared-unknown" },
    findings,
    causality: { claimed: false, statement: "Measured audio and observed Live state are linked by the stated source provenance; device presence and parameter values are never treated as proof of cause." },
    privacy: { rawAudioRetained: false, rawAudioReturned: false },
  };
}
