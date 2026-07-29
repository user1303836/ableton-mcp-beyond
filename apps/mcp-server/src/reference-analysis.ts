import { analyzeReconstructedPcm, type PcmAnalysis } from "./analysis.js";
import type { ConventionalChannelLabel } from "./audio-standards.js";

export const REFERENCE_ANALYSIS_VERSION = "reference-analysis/v1" as const;
export const MAX_COMPARISON_TOTAL_SAMPLES = 4_000_000;
export const MAX_COMPARISON_SECONDS_PER_SOURCE = 30;
export const MAX_COMPARISON_CHANNELS = 2;
export const MIN_COMPARISON_SAMPLE_RATE = 32_000;
export const MAX_COMPARISON_SAMPLE_RATE = 96_000;
export const MAX_ALIGNMENT_LAG_SECONDS = 10;
export const COMPARISON_ANALYSIS_RATE = 48_000;
const ALIGNMENT_RATE = 1_000;
const RESAMPLER_RADIUS = 16;
const EPSILON = 1e-12;

export interface ReferencePcmSource {
  samples: ArrayLike<number>;
  sampleRate: number;
  channels: number;
  channelLayout?: readonly ConventionalChannelLabel[];
}

export interface ReferenceComparisonInput {
  project: ReferencePcmSource;
  reference: ReferencePcmSource;
  alignment?: { mode?: "auto" | "manual" | "disabled"; maxLagSeconds?: number; manualOffsetSeconds?: number };
}

export interface ReferenceComparison {
  version: typeof REFERENCE_ANALYSIS_VERSION;
  analysisRate: number;
  resampling: {
    method: "32-tap Blackman-windowed sinc";
    project: { sourceRate: number; targetRate: number; resampled: boolean };
    reference: { sourceRate: number; targetRate: number; resampled: boolean };
  };
  alignment: {
    available: boolean;
    reason?: string;
    mode: "auto" | "manual" | "disabled";
    referenceOffsetSeconds: number | null;
    correlation: number | null;
    confidence: number | null;
    ambiguous: boolean;
    overlapSeconds: number;
    maxLagSeconds: number;
    resolutionSeconds: number;
  };
  levelMatch: {
    available: boolean;
    reason?: string;
    projectIntegratedLufs: number | null;
    referenceIntegratedLufs: number | null;
    projectGainToReferenceDb: number | null;
    boundedSuggestedGainDb: number | null;
    suggestionLimitDb: 24;
    changesAudio: false;
  };
  deltas: {
    projectMinusReference: {
      integratedLoudnessLu: number | null;
      truePeakDb: number | null;
      samplePeakDb: number | null;
      rmsDb: number | null;
      crestFactorDb: number | null;
      dynamicRangeDb: number | null;
      spectralCentroidHz: number | null;
      dominantFrequencyHz: number | null;
      transientDensityPerSecond: number | null;
    };
  };
  project: PcmAnalysis;
  reference: PcmAnalysis;
  privacy: { rawAudioRetained: false; rawAudioReturned: false; sourcePathAccepted: false };
  performance: { bounded: true; maxTotalInputSamples: number; maxSecondsPerSource: number; maxChannels: number; alignmentRate: number; maxAlignmentLagSeconds: number };
}

function validateSource(source: ReferencePcmSource, label: string, observedLength?: number): ReferencePcmSource {
  if (!Number.isInteger(source.sampleRate) || source.sampleRate < MIN_COMPARISON_SAMPLE_RATE || source.sampleRate > MAX_COMPARISON_SAMPLE_RATE) throw new RangeError(`${label}.sampleRate must be an integer from ${MIN_COMPARISON_SAMPLE_RATE} to ${MAX_COMPARISON_SAMPLE_RATE} for the validated fixed-kernel comparison resampler`);
  if (!Number.isInteger(source.channels) || source.channels < 1 || source.channels > MAX_COMPARISON_CHANNELS) throw new RangeError(`${label}.channels must be an integer from 1 to ${MAX_COMPARISON_CHANNELS}`);
  const sampleLength = observedLength ?? source.samples.length;
  if (!Number.isSafeInteger(sampleLength) || sampleLength <= 0 || sampleLength % source.channels !== 0) throw new RangeError(`${label}.samples must contain complete channel frames`);
  if (sampleLength / source.channels / source.sampleRate > MAX_COMPARISON_SECONDS_PER_SOURCE) throw new RangeError(`${label} duration exceeds ${MAX_COMPARISON_SECONDS_PER_SOURCE} seconds`);
  const channelLayout = source.channelLayout ? [...source.channelLayout] : undefined;
  if (channelLayout && channelLayout.length !== source.channels) throw new RangeError(`${label}.channelLayout must match channels`);
  const samples = new Float64Array(sampleLength);
  for (let index = 0; index < sampleLength; index += 1) {
    const value = source.samples[index] ?? 0;
    if (!Number.isFinite(value) || value < -1 || value > 1) throw new RangeError(`${label}.samples[${index}] must be finite normalized PCM`);
    samples[index] = value;
  }
  return { samples, sampleRate: source.sampleRate, channels: source.channels, ...(channelLayout ? { channelLayout } : {}) };
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function blackman(distance: number): number {
  const normalized = (distance + RESAMPLER_RADIUS) / (2 * RESAMPLER_RADIUS);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * normalized) + 0.08 * Math.cos(4 * Math.PI * normalized);
}

/** Deterministic band-limited resampling with a fixed, bounded 32-tap kernel. */
function resampleValidatedPcm(source: ReferencePcmSource, targetRate = COMPARISON_ANALYSIS_RATE): Float64Array {
  if (targetRate !== COMPARISON_ANALYSIS_RATE) throw new RangeError(`targetRate must be the fixed ${COMPARISON_ANALYSIS_RATE} Hz comparison rate`);
  const inputFrames = source.samples.length / source.channels;
  const outputFrames = Math.max(1, Math.round(inputFrames * targetRate / source.sampleRate));
  if (!Number.isSafeInteger(outputFrames) || outputFrames * source.channels > MAX_COMPARISON_TOTAL_SAMPLES) throw new RangeError("resampled output exceeds the bounded comparison work limit");
  const output = new Float64Array(outputFrames * source.channels);
  if (targetRate === source.sampleRate) {
    for (let index = 0; index < output.length; index += 1) output[index] = source.samples[index] ?? 0;
    return output;
  }
  const cutoff = Math.min(1, targetRate / source.sampleRate) * 0.94;
  for (let outputFrame = 0; outputFrame < outputFrames; outputFrame += 1) {
    const sourcePosition = outputFrame * source.sampleRate / targetRate;
    const center = Math.floor(sourcePosition);
    for (let channel = 0; channel < source.channels; channel += 1) {
      let value = 0;
      let normalization = 0;
      for (let tap = center - RESAMPLER_RADIUS + 1; tap <= center + RESAMPLER_RADIUS; tap += 1) {
        const distance = sourcePosition - tap;
        const coefficient = cutoff * sinc(distance * cutoff) * blackman(distance);
        // A complete kernel with constant edge extension avoids dividing a
        // truncated near-zero boundary sum and cannot turn normalized short
        // programmes into unbounded reconstructed peaks.
        const sourceFrame = Math.max(0, Math.min(inputFrames - 1, tap));
        value += coefficient * (source.samples[sourceFrame * source.channels + channel] ?? 0);
        normalization += coefficient;
      }
      output[outputFrame * source.channels + channel] = Math.abs(normalization) > EPSILON ? value / normalization : 0;
    }
  }
  return output;
}

export function resamplePcm(source: ReferencePcmSource, targetRate = COMPARISON_ANALYSIS_RATE): Float64Array {
  return resampleValidatedPcm(validateSource(source, "source"), targetRate);
}

function alignmentEnvelope(samples: Float64Array, channels: number): Float64Array {
  const frames = samples.length / channels;
  const blockFrames = COMPARISON_ANALYSIS_RATE / ALIGNMENT_RATE;
  const outputFrames = Math.floor(frames / blockFrames);
  const output = new Float64Array(outputFrames);
  for (let block = 0; block < outputFrames; block += 1) {
    let sum = 0;
    for (let frame = 0; frame < blockFrames; frame += 1) {
      let mono = 0;
      for (let channel = 0; channel < channels; channel += 1) mono += samples[(block * blockFrames + frame) * channels + channel] ?? 0;
      mono /= channels;
      sum += mono * mono;
    }
    output[block] = Math.sqrt(sum / blockFrames);
  }
  return output;
}

interface AlignmentCandidate {
  lag: number;
  correlation: number;
}

function correlationAt(project: Float64Array, reference: Float64Array, lag: number, minimumCount = ALIGNMENT_RATE / 2): number | null {
  const projectStart = Math.max(0, -lag);
  const referenceStart = Math.max(0, lag);
  const count = Math.min(project.length - projectStart, reference.length - referenceStart);
  if (count < minimumCount) return null;
  let projectMean = 0;
  let referenceMean = 0;
  for (let index = 0; index < count; index += 1) {
    projectMean += project[projectStart + index] ?? 0;
    referenceMean += reference[referenceStart + index] ?? 0;
  }
  projectMean /= count;
  referenceMean /= count;
  let product = 0;
  let projectSquares = 0;
  let referenceSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const projectValue = (project[projectStart + index] ?? 0) - projectMean;
    const referenceValue = (reference[referenceStart + index] ?? 0) - referenceMean;
    product += projectValue * referenceValue;
    projectSquares += projectValue * projectValue;
    referenceSquares += referenceValue * referenceValue;
  }
  if (projectSquares <= EPSILON || referenceSquares <= EPSILON) return null;
  return Math.max(-1, Math.min(1, product / Math.sqrt(projectSquares * referenceSquares)));
}

function downsampleEnvelope(input: Float64Array, factor: number): Float64Array {
  const length = Math.floor(input.length / factor);
  const output = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < factor; offset += 1) sum += input[index * factor + offset] ?? 0;
    output[index] = sum / factor;
  }
  return output;
}

function alignAutomatically(project: Float64Array, projectChannels: number, reference: Float64Array, referenceChannels: number, maxLagSeconds: number): { candidate: AlignmentCandidate | null; confidence: number | null; ambiguous: boolean; reason?: string } {
  const projectEnvelope = alignmentEnvelope(project, projectChannels);
  const referenceEnvelope = alignmentEnvelope(reference, referenceChannels);
  if (projectEnvelope.length < ALIGNMENT_RATE / 2 || referenceEnvelope.length < ALIGNMENT_RATE / 2) return { candidate: null, confidence: null, ambiguous: true, reason: "automatic alignment requires at least 0.5 seconds from each source" };

  // Scan a 100 Hz envelope first, then refine only ±10 ms at 1 kHz. This
  // freezes worst-case correlation work below roughly eight million products
  // instead of allowing O(programmeLength × fineLagRange) growth.
  const coarseFactor = 10;
  const coarseRate = ALIGNMENT_RATE / coarseFactor;
  const projectCoarse = downsampleEnvelope(projectEnvelope, coarseFactor);
  const referenceCoarse = downsampleEnvelope(referenceEnvelope, coarseFactor);
  const maxCoarseLag = Math.min(Math.round(maxLagSeconds * coarseRate), Math.max(projectCoarse.length, referenceCoarse.length) - Math.round(coarseRate / 2));
  let coarseBest: AlignmentCandidate | null = null;
  const coarseCandidates: AlignmentCandidate[] = [];
  for (let lag = -maxCoarseLag; lag <= maxCoarseLag; lag += 1) {
    const correlation = correlationAt(projectCoarse, referenceCoarse, lag, coarseRate / 2);
    if (correlation === null) continue;
    const candidate = { lag, correlation };
    coarseCandidates.push(candidate);
    if (!coarseBest || correlation > coarseBest.correlation) coarseBest = candidate;
  }
  if (!coarseBest) return { candidate: null, confidence: null, ambiguous: true, reason: "automatic alignment has insufficient non-silent envelope variation" };

  let best: AlignmentCandidate | null = null;
  const center = coarseBest.lag * coarseFactor;
  const fineMaximum = Math.round(maxLagSeconds * ALIGNMENT_RATE);
  for (let lag = Math.max(-fineMaximum, center - coarseFactor); lag <= Math.min(fineMaximum, center + coarseFactor); lag += 1) {
    const correlation = correlationAt(projectEnvelope, referenceEnvelope, lag);
    if (correlation !== null && (!best || correlation > best.correlation)) best = { lag, correlation };
  }
  if (!best) return { candidate: null, confidence: null, ambiguous: true, reason: "automatic alignment refinement has insufficient overlap" };
  const coarseExclusion = Math.round(0.05 * coarseRate);
  const competing = coarseCandidates.filter((candidate) => Math.abs(candidate.lag - coarseBest!.lag) > coarseExclusion).sort((left, right) => right.correlation - left.correlation)[0];
  const separation = coarseBest.correlation - (competing?.correlation ?? -1);
  const confidence = Math.max(0, Math.min(1, best.correlation)) * Math.max(0, Math.min(1, separation / 0.1));
  const ambiguous = best.correlation < 0.5 || separation < 0.02;
  return { candidate: best, confidence, ambiguous, ...(ambiguous ? { reason: "alignment is weak or has a competing envelope match" } : {}) };
}

function alignedSlices(project: Float64Array, projectChannels: number, reference: Float64Array, referenceChannels: number, lagFrames: number): { project: Float64Array; reference: Float64Array; frames: number } {
  const projectFrames = project.length / projectChannels;
  const referenceFrames = reference.length / referenceChannels;
  const projectStart = Math.max(0, -lagFrames);
  const referenceStart = Math.max(0, lagFrames);
  const frames = Math.max(0, Math.min(projectFrames - projectStart, referenceFrames - referenceStart));
  const projectSlice = new Float64Array(frames * projectChannels);
  const referenceSlice = new Float64Array(frames * referenceChannels);
  projectSlice.set(project.subarray(projectStart * projectChannels, (projectStart + frames) * projectChannels));
  referenceSlice.set(reference.subarray(referenceStart * referenceChannels, (referenceStart + frames) * referenceChannels));
  return { project: projectSlice, reference: referenceSlice, frames };
}

function finiteDifference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

export function compareReferenceAudio(input: ReferenceComparisonInput): ReferenceComparison {
  const projectLength = input.project.samples.length;
  const referenceLength = input.reference.samples.length;
  if (!Number.isSafeInteger(projectLength) || !Number.isSafeInteger(referenceLength) || projectLength <= 0 || referenceLength <= 0 || projectLength + referenceLength > MAX_COMPARISON_TOTAL_SAMPLES) throw new RangeError(`comparison exceeds the ${MAX_COMPARISON_TOTAL_SAMPLES}-sample pair limit`);
  const projectSource = validateSource(input.project, "project", projectLength);
  const referenceSource = validateSource(input.reference, "reference", referenceLength);

  const mode = input.alignment?.mode ?? "auto";
  const maxLagSeconds = input.alignment?.maxLagSeconds ?? 5;
  if (!Number.isFinite(maxLagSeconds) || maxLagSeconds < 0 || maxLagSeconds > MAX_ALIGNMENT_LAG_SECONDS) throw new RangeError(`alignment.maxLagSeconds must be from 0 to ${MAX_ALIGNMENT_LAG_SECONDS}`);
  const projectResampled = resampleValidatedPcm(projectSource);
  const referenceResampled = resampleValidatedPcm(referenceSource);
  let offsetSeconds = 0;
  let correlation: number | null = null;
  let confidence: number | null = null;
  let ambiguous = false;
  let alignmentAvailable = true;
  let alignmentReason: string | undefined;

  if (mode === "manual") {
    const manual = input.alignment?.manualOffsetSeconds;
    if (!Number.isFinite(manual) || Math.abs(manual ?? 0) > maxLagSeconds) throw new RangeError("alignment.manualOffsetSeconds must be finite and within maxLagSeconds");
    offsetSeconds = manual!;
  } else if (mode === "disabled") {
    offsetSeconds = 0;
    alignmentReason = "alignment was disabled; sources are compared from their starts";
  } else {
    const automatic = alignAutomatically(projectResampled, projectSource.channels, referenceResampled, referenceSource.channels, maxLagSeconds);
    if (!automatic.candidate || automatic.ambiguous) {
      alignmentAvailable = false;
      ambiguous = automatic.ambiguous;
      alignmentReason = automatic.reason ?? "automatic alignment unavailable";
      offsetSeconds = 0;
      correlation = automatic.candidate?.correlation ?? null;
      confidence = automatic.confidence;
    } else {
      offsetSeconds = automatic.candidate.lag / ALIGNMENT_RATE;
      correlation = automatic.candidate.correlation;
      confidence = automatic.confidence;
    }
  }

  const comparisonTrusted = alignmentAvailable || mode !== "auto";
  const lagFrames = Math.round(offsetSeconds * COMPARISON_ANALYSIS_RATE);
  const aligned = alignedSlices(projectResampled, projectSource.channels, referenceResampled, referenceSource.channels, lagFrames);
  if (comparisonTrusted && aligned.frames <= 0) throw new RangeError("alignment leaves no overlapping audio");
  const projectSamples = comparisonTrusted ? aligned.project : projectResampled;
  const referenceSamples = comparisonTrusted ? aligned.reference : referenceResampled;
  const project = analyzeReconstructedPcm({ samples: projectSamples, sampleRate: COMPARISON_ANALYSIS_RATE, channels: projectSource.channels, ...(projectSource.channelLayout ? { channelLayout: projectSource.channelLayout } : {}) });
  const reference = analyzeReconstructedPcm({ samples: referenceSamples, sampleRate: COMPARISON_ANALYSIS_RATE, channels: referenceSource.channels, ...(referenceSource.channelLayout ? { channelLayout: referenceSource.channelLayout } : {}) });
  const projectLufs = project.standardsAudio.loudness.integratedLufs;
  const referenceLufs = reference.standardsAudio.loudness.integratedLufs;
  const gain = comparisonTrusted ? finiteDifference(referenceLufs, projectLufs) : null;
  const levelAvailable = comparisonTrusted && gain !== null;
  const projectTruePeak = project.standardsAudio.truePeak.aggregateDbtp;
  const referenceTruePeak = reference.standardsAudio.truePeak.aggregateDbtp;

  return {
    version: REFERENCE_ANALYSIS_VERSION,
    analysisRate: COMPARISON_ANALYSIS_RATE,
    resampling: {
      method: "32-tap Blackman-windowed sinc",
      project: { sourceRate: projectSource.sampleRate, targetRate: COMPARISON_ANALYSIS_RATE, resampled: projectSource.sampleRate !== COMPARISON_ANALYSIS_RATE },
      reference: { sourceRate: referenceSource.sampleRate, targetRate: COMPARISON_ANALYSIS_RATE, resampled: referenceSource.sampleRate !== COMPARISON_ANALYSIS_RATE },
    },
    alignment: {
      available: alignmentAvailable,
      ...(alignmentReason ? { reason: alignmentReason } : {}),
      mode,
      referenceOffsetSeconds: alignmentAvailable || mode !== "auto" ? offsetSeconds : null,
      correlation,
      confidence,
      ambiguous,
      overlapSeconds: comparisonTrusted ? aligned.frames / COMPARISON_ANALYSIS_RATE : 0,
      maxLagSeconds,
      resolutionSeconds: 1 / ALIGNMENT_RATE,
    },
    levelMatch: {
      available: levelAvailable,
      ...(!levelAvailable ? { reason: comparisonTrusted ? "both aligned sources need qualifying BS.1770 integrated loudness" : "automatic alignment is unavailable; choose manual or disabled alignment before comparing levels" } : {}),
      projectIntegratedLufs: projectLufs,
      referenceIntegratedLufs: referenceLufs,
      projectGainToReferenceDb: gain,
      boundedSuggestedGainDb: gain === null ? null : Math.max(-24, Math.min(24, gain)),
      suggestionLimitDb: 24,
      changesAudio: false,
    },
    deltas: {
      projectMinusReference: {
        integratedLoudnessLu: comparisonTrusted ? finiteDifference(projectLufs, referenceLufs) : null,
        truePeakDb: comparisonTrusted ? finiteDifference(projectTruePeak, referenceTruePeak) : null,
        samplePeakDb: comparisonTrusted ? project.peakDbfs - reference.peakDbfs : null,
        rmsDb: comparisonTrusted ? project.rmsDbfs - reference.rmsDbfs : null,
        crestFactorDb: comparisonTrusted ? project.dynamics.crestFactorDb - reference.dynamics.crestFactorDb : null,
        dynamicRangeDb: comparisonTrusted ? project.dynamics.dynamicRangeDb - reference.dynamics.dynamicRangeDb : null,
        spectralCentroidHz: comparisonTrusted ? project.spectral.centroidHz - reference.spectral.centroidHz : null,
        dominantFrequencyHz: comparisonTrusted ? project.spectral.dominantFrequencyHz - reference.spectral.dominantFrequencyHz : null,
        transientDensityPerSecond: comparisonTrusted ? project.transients.densityPerSecond - reference.transients.densityPerSecond : null,
      },
    },
    project,
    reference,
    privacy: { rawAudioRetained: false, rawAudioReturned: false, sourcePathAccepted: false },
    performance: { bounded: true, maxTotalInputSamples: MAX_COMPARISON_TOTAL_SAMPLES, maxSecondsPerSource: MAX_COMPARISON_SECONDS_PER_SOURCE, maxChannels: MAX_COMPARISON_CHANNELS, alignmentRate: ALIGNMENT_RATE, maxAlignmentLagSeconds: MAX_ALIGNMENT_LAG_SECONDS },
  };
}
