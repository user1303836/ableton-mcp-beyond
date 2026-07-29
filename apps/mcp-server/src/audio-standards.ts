/**
 * Standards-grounded programme loudness and true-peak analysis.
 *
 * Loudness follows ITU-R BS.1770-5 Annex 1 and EBU R128/Tech 3341/3342.
 * True peak uses the 48 kHz, order-48, four-phase interpolator published in
 * BS.1770-5 Annex 2. Raw PCM is neither retained nor returned by this module.
 */

export const STANDARDS_AUDIO_VERSION = "bs1770-5-ebu-r128-2023/v1" as const;
export const MAX_TRUE_PEAK_FRAMES = 1_440_000; // 30 s at 48 kHz for mono.
export const MAX_TRUE_PEAK_SAMPLES = 2_880_000; // Shared bound across channels.
export const MAX_LOUDNESS_SERIES_POINTS = 128;

export type ConventionalChannelLabel = "M" | "L" | "R" | "C" | "Ls" | "Rs" | "LFE";

export interface StandardsAudioInput {
  samples: ArrayLike<number>;
  sampleRate: number;
  channels: number;
  channelLayout?: readonly ConventionalChannelLabel[];
}

export interface LoudnessPoint {
  timeSeconds: number;
  lufs: number;
}

export interface StandardsAudioAnalysis {
  version: typeof STANDARDS_AUDIO_VERSION;
  standards: {
    programmeLoudness: "ITU-R BS.1770-5";
    operatingRecommendation: "EBU R128";
    meter: "EBU Tech 3341";
    loudnessRange: "EBU Tech 3342";
  };
  channelLayout: {
    labels: ConventionalChannelLabel[];
    weights: number[];
    explicit: boolean;
    lfeExcluded: boolean;
  };
  loudness: {
    available: boolean;
    reason?: string;
    standardsCompliant: boolean;
    integratedLufs: number | null;
    absoluteGateLufs: -70;
    relativeGateLufs: number | null;
    blocks: { total: number; aboveAbsoluteGate: number; aboveRelativeGate: number };
    momentary: { windowSeconds: 0.4; cadenceSeconds: 0.1; currentLufs: number | null; maximumLufs: number | null; series: LoudnessPoint[]; seriesLossy: true };
    shortTerm: { windowSeconds: 3; cadenceSeconds: 0.1; currentLufs: number | null; maximumLufs: number | null; series: LoudnessPoint[]; seriesLossy: true };
    loudnessRange: { available: boolean; reason?: string; lraLu: number | null; lowLufs: number | null; highLufs: number | null; absoluteGateLufs: -70; relativeGateOffsetLu: -20; percentileMethod: "linear-r7" };
  };
  truePeak: {
    available: boolean;
    reason?: string;
    standardsCompliant: boolean;
    aggregateDbtp: number | null;
    perChannelDbtp: Array<number | null>;
    sampleRate: number;
    oversamplingFactor: number | null;
    method: "ITU-R BS.1770-5 Annex 2 order-48 four-phase FIR" | "64-tap Blackman-sinc 44.1-to-48 kHz then Annex 2 FIR";
    maxFrames: number;
    maxSamples: number;
  };
}

const LOUDNESS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const EPSILON_ENERGY = 1e-30;
const CHANNEL_WEIGHTS: Readonly<Record<ConventionalChannelLabel, number>> = {
  M: 1,
  L: 1,
  R: 1,
  C: 1,
  Ls: 1.41,
  Rs: 1.41,
  LFE: 0,
};

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function biquad(value: number, coefficients: BiquadCoefficients, state: BiquadState): number {
  const output = coefficients.b0 * value + coefficients.b1 * state.x1 + coefficients.b2 * state.x2
    - coefficients.a1 * state.y1 - coefficients.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = value;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
}

/**
 * BS.1770 gives exact 48 kHz coefficients and requires equivalent responses at
 * other rates. These are the pre-warped De Man parameterizations of those two
 * published biquads; the 48 kHz branch preserves the normative table exactly.
 */
function kWeightingCoefficients(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  if (sampleRate === 48_000) {
    return [
      { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
      { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 },
    ];
  }

  const shelfFrequency = 1_681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan(Math.PI * shelfFrequency / sampleRate);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: BiquadCoefficients = {
    b0: (vh + vb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    b1: 2 * (shelfK * shelfK - vh) / shelfA0,
    b2: (vh - vb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    a1: 2 * (shelfK * shelfK - 1) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
  };

  const highPassFrequency = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  const highPassK = Math.tan(Math.PI * highPassFrequency / sampleRate);
  const highPassA0 = 1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass: BiquadCoefficients = {
    // The BS.1770 RLB numerator is intentionally not divided by a0.
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (highPassK * highPassK - 1) / highPassA0,
    a2: (1 - highPassK / highPassQ + highPassK * highPassK) / highPassA0,
  };
  return [shelf, highPass];
}

function defaultLayout(channels: number): ConventionalChannelLabel[] | null {
  if (channels === 1) return ["M"];
  if (channels === 2) return ["L", "R"];
  return null;
}

function resolveLayout(input: StandardsAudioInput): { labels: ConventionalChannelLabel[]; weights: number[]; explicit: boolean } | { reason: string } {
  const fallback = defaultLayout(input.channels);
  const labels = input.channelLayout ? [...input.channelLayout] : fallback;
  if (!labels) return { reason: "channelLayout is required for standards loudness when channels is greater than two" };
  if (labels.length !== input.channels) return { reason: "channelLayout must contain exactly one semantic label per channel" };
  const supported = new Set<ConventionalChannelLabel>(["M", "L", "R", "C", "Ls", "Rs", "LFE"]);
  if (labels.some((label) => !supported.has(label))) return { reason: "channelLayout contains a label outside the supported conventional BS.1770 layout" };
  if (new Set(labels).size !== labels.length) return { reason: "channelLayout labels must be unique" };
  if (labels.includes("M") && labels.length !== 1) return { reason: "the mono channel label M is valid only for one-channel input" };
  if (labels.every((label) => label === "LFE")) return { reason: "channelLayout must contain at least one programme channel; LFE is excluded from loudness" };
  return { labels, weights: labels.map((label) => CHANNEL_WEIGHTS[label]), explicit: input.channelLayout !== undefined };
}

function loudnessFromEnergy(energy: number): number | null {
  if (!(energy > EPSILON_ENERGY)) return null;
  return LOUDNESS_OFFSET + 10 * Math.log10(energy);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const adjusted = value - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return sum / values.length;
}

function percentileR7(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function boundedSeries(points: readonly LoudnessPoint[]): LoudnessPoint[] {
  if (points.length <= MAX_LOUDNESS_SERIES_POINTS) return [...points];
  return Array.from({ length: MAX_LOUDNESS_SERIES_POINTS }, (_, index) => {
    const source = Math.round(index * (points.length - 1) / (MAX_LOUDNESS_SERIES_POINTS - 1));
    return points[source]!;
  });
}

interface LoudnessMeasurements {
  blockEnergies: number[];
  momentaryPoints: LoudnessPoint[];
  momentaryCurrent: number | null;
  shortTermPoints: LoudnessPoint[];
  shortTermCurrent: number | null;
}

function measureLoudness(input: StandardsAudioInput, weights: readonly number[]): LoudnessMeasurements {
  const [shelf, highPass] = kWeightingCoefficients(input.sampleRate);
  const shelfStates = Array.from({ length: input.channels }, (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  const highPassStates = Array.from({ length: input.channels }, (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  const frameCount = input.samples.length / input.channels;
  const momentaryFrames = Math.round(input.sampleRate * 0.4);
  const momentaryHop = Math.round(input.sampleRate * 0.1);
  const shortTermFrames = Math.round(input.sampleRate * 3);
  const shortTermHop = Math.round(input.sampleRate * 0.1);
  const ring = new Float64Array(shortTermFrames);
  let momentarySum = 0;
  let shortTermSum = 0;
  const blockEnergies: number[] = [];
  const momentaryPoints: LoudnessPoint[] = [];
  const shortTermPoints: LoudnessPoint[] = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    let frameEnergy = 0;
    for (let channel = 0; channel < input.channels; channel += 1) {
      const sample = input.samples[frame * input.channels + channel] ?? 0;
      const shelfOutput = biquad(sample, shelf, shelfStates[channel]!);
      const weighted = biquad(shelfOutput, highPass, highPassStates[channel]!);
      frameEnergy += (weights[channel] ?? 0) * weighted * weighted;
    }

    const momentaryOld = frame >= momentaryFrames ? (ring[(frame - momentaryFrames) % shortTermFrames] ?? 0) : 0;
    const shortTermOld = frame >= shortTermFrames ? (ring[frame % shortTermFrames] ?? 0) : 0;
    momentarySum += frameEnergy - momentaryOld;
    shortTermSum += frameEnergy - shortTermOld;
    ring[frame % shortTermFrames] = frameEnergy;
    const endFrame = frame + 1;

    if (endFrame >= momentaryFrames && (endFrame - momentaryFrames) % momentaryHop === 0) {
      const energy = Math.max(0, momentarySum / momentaryFrames);
      blockEnergies.push(energy);
      const lufs = loudnessFromEnergy(energy);
      if (lufs !== null) momentaryPoints.push({ timeSeconds: endFrame / input.sampleRate, lufs });
    }
    if (endFrame >= shortTermFrames && (endFrame - shortTermFrames) % shortTermHop === 0) {
      const lufs = loudnessFromEnergy(Math.max(0, shortTermSum / shortTermFrames));
      if (lufs !== null) shortTermPoints.push({ timeSeconds: endFrame / input.sampleRate, lufs });
    }
  }

  return {
    blockEnergies,
    momentaryPoints,
    momentaryCurrent: frameCount >= momentaryFrames ? loudnessFromEnergy(Math.max(0, momentarySum / momentaryFrames)) : null,
    shortTermPoints,
    shortTermCurrent: frameCount >= shortTermFrames ? loudnessFromEnergy(Math.max(0, shortTermSum / shortTermFrames)) : null,
  };
}

function unavailableLoudness(reason: string): StandardsAudioAnalysis["loudness"] {
  return {
    available: false,
    reason,
    standardsCompliant: false,
    integratedLufs: null,
    absoluteGateLufs: -70,
    relativeGateLufs: null,
    blocks: { total: 0, aboveAbsoluteGate: 0, aboveRelativeGate: 0 },
    momentary: { windowSeconds: 0.4, cadenceSeconds: 0.1, currentLufs: null, maximumLufs: null, series: [], seriesLossy: true },
    shortTerm: { windowSeconds: 3, cadenceSeconds: 0.1, currentLufs: null, maximumLufs: null, series: [], seriesLossy: true },
    loudnessRange: { available: false, reason, lraLu: null, lowLufs: null, highLufs: null, absoluteGateLufs: -70, relativeGateOffsetLu: -20, percentileMethod: "linear-r7" },
  };
}

// Rows are the twelve taps; columns are the four phases from BS.1770-5 Annex 2.
const TRUE_PEAK_PHASES: readonly (readonly number[])[] = [
  [0.0017089843750, -0.0291748046875, -0.0189208984375, -0.0083007812500],
  [0.0109863281250, 0.0292968750000, 0.0330810546875, 0.0148925781250],
  [-0.0196533203125, -0.0517578125000, -0.0582275390625, -0.0266113281250],
  [0.0332031250000, 0.0891113281250, 0.1015625000000, 0.0476074218750],
  [-0.0594482421875, -0.1665039062500, -0.2003173828125, -0.1022949218750],
  [0.1373291015625, 0.4650878906250, 0.7797851562500, 0.9721679687500],
  [0.9721679687500, 0.7797851562500, 0.4650878906250, 0.1373291015625],
  [-0.1022949218750, -0.2003173828125, -0.1665039062500, -0.0594482421875],
  [0.0476074218750, 0.1015625000000, 0.0891113281250, 0.0332031250000],
  [-0.0266113281250, -0.0582275390625, -0.0517578125000, -0.0196533203125],
  [0.0148925781250, 0.0330810546875, 0.0292968750000, 0.0109863281250],
  [-0.0083007812500, -0.0189208984375, -0.0291748046875, 0.0017089843750],
];

function truePeakChannel48k(samples: ArrayLike<number>): number | null {
  let maximum = 0;
  for (let index = 0; index < samples.length; index += 1) maximum = Math.max(maximum, Math.abs(samples[index] ?? 0));
  // Measure only positions with the complete published FIR support. Treating
  // programme boundaries as zero-valued discontinuities creates a false edge
  // overshoot (for example +0.95 dBTP for a constant full-scale programme),
  // unlike BS.1770 meters and the independent FFmpeg oracle.
  for (let outputFrame = 5; outputFrame < samples.length - 6; outputFrame += 1) {
    for (let phase = 0; phase < 4; phase += 1) {
      let value = 0;
      for (let tap = 0; tap < TRUE_PEAK_PHASES.length; tap += 1) {
        const inputFrame = outputFrame - tap + 6;
        value += (TRUE_PEAK_PHASES[tap]?.[phase] ?? 0) * (samples[inputFrame] ?? 0);
      }
      maximum = Math.max(maximum, Math.abs(value));
    }
  }
  return maximum > 0 ? 20 * Math.log10(maximum) : null;
}

function truePeak48k(input: StandardsAudioInput): Array<number | null> {
  const frameCount = input.samples.length / input.channels;
  return Array.from({ length: input.channels }, (_, channel) => {
    const samples = new Float64Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) samples[frame] = input.samples[frame * input.channels + channel] ?? 0;
    return truePeakChannel48k(samples);
  });
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function truePeak44100(input: StandardsAudioInput): Array<number | null> {
  const inputFrames = input.samples.length / input.channels;
  const outputFrames = Math.round(inputFrames * 48_000 / 44_100);
  const radius = 32;
  return Array.from({ length: input.channels }, (_, channel) => {
    const resampled = new Float64Array(outputFrames);
    for (let outputFrame = 0; outputFrame < outputFrames; outputFrame += 1) {
      const position = outputFrame * 44_100 / 48_000;
      const center = Math.floor(position);
      let value = 0;
      let normalization = 0;
      for (let tap = center - radius + 1; tap <= center + radius; tap += 1) {
        const distance = position - tap;
        const windowPosition = (distance + radius) / (2 * radius);
        const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * windowPosition) + 0.08 * Math.cos(4 * Math.PI * windowPosition);
        const coefficient = sinc(distance) * window;
        // Constant edge extension keeps the bounded programme boundary from
        // becoming an artificial impulse while retaining a complete kernel.
        const sourceFrame = Math.max(0, Math.min(inputFrames - 1, tap));
        value += coefficient * (input.samples[sourceFrame * input.channels + channel] ?? 0);
        normalization += coefficient;
      }
      resampled[outputFrame] = Math.abs(normalization) > 1e-12 ? value / normalization : 0;
    }
    return truePeakChannel48k(resampled);
  });
}

function analyzeTruePeak(input: StandardsAudioInput): StandardsAudioAnalysis["truePeak"] {
  const base = {
    sampleRate: input.sampleRate,
    method: (input.sampleRate === 44_100 ? "64-tap Blackman-sinc 44.1-to-48 kHz then Annex 2 FIR" : "ITU-R BS.1770-5 Annex 2 order-48 four-phase FIR") as StandardsAudioAnalysis["truePeak"]["method"],
    maxFrames: Math.min(MAX_TRUE_PEAK_FRAMES, Math.floor(MAX_TRUE_PEAK_SAMPLES / input.channels)),
    maxSamples: MAX_TRUE_PEAK_SAMPLES,
  };
  const frameCount = input.samples.length / input.channels;
  if (input.sampleRate !== 48_000 && input.sampleRate !== 44_100) {
    return { ...base, available: false, reason: "standards true peak is currently validated only for 44.1 and 48 kHz input", standardsCompliant: false, aggregateDbtp: null, perChannelDbtp: Array.from({ length: input.channels }, () => null), oversamplingFactor: null };
  }
  if (frameCount > base.maxFrames || input.samples.length > MAX_TRUE_PEAK_SAMPLES) {
    return { ...base, available: false, reason: `true-peak input exceeds the bounded ${base.maxFrames}-frame/${MAX_TRUE_PEAK_SAMPLES}-sample analysis limit`, standardsCompliant: false, aggregateDbtp: null, perChannelDbtp: Array.from({ length: input.channels }, () => null), oversamplingFactor: null };
  }
  const perChannelDbtp = input.sampleRate === 48_000 ? truePeak48k(input) : truePeak44100(input);
  const finite = perChannelDbtp.filter((value): value is number => value !== null);
  return { ...base, available: true, standardsCompliant: true, aggregateDbtp: finite.length > 0 ? Math.max(...finite) : null, perChannelDbtp, oversamplingFactor: 192_000 / input.sampleRate };
}

export function analyzeStandardsAudio(input: StandardsAudioInput): StandardsAudioAnalysis {
  if (!Number.isInteger(input.sampleRate) || input.sampleRate < 8_000 || input.sampleRate > 384_000) throw new RangeError("sampleRate must be an integer from 8000 to 384000");
  const sampleLength = input.samples.length;
  if (!Number.isInteger(input.channels) || input.channels < 1 || input.channels > 32 || !Number.isSafeInteger(sampleLength) || sampleLength <= 0 || sampleLength > 10_000_000 || sampleLength % input.channels !== 0) throw new RangeError("channels and samples must contain 1-10000000 complete frames across at most 32 channels");
  // Snapshot observable/mutable ArrayLike storage exactly once so validation,
  // loudness, and true peak describe the same finite programme.
  const samples = new Float64Array(sampleLength);
  for (let index = 0; index < sampleLength; index += 1) {
    const sample = input.samples[index] ?? 0;
    // The package-internal reference resampler can reconstruct bounded
    // inter-sample values above normalized sample full scale.
    if (!Number.isFinite(sample) || sample < -4 || sample > 4) throw new RangeError(`samples[${index}] must be finite and within the bounded analysis range`);
    samples[index] = sample;
  }
  const stableInput: StandardsAudioInput = { samples, sampleRate: input.sampleRate, channels: input.channels, ...(input.channelLayout ? { channelLayout: [...input.channelLayout] } : {}) };
  const layout = resolveLayout(stableInput);
  let loudness: StandardsAudioAnalysis["loudness"];
  let labels: ConventionalChannelLabel[];
  let weights: number[];
  let explicit: boolean;

  if ("reason" in layout) {
    labels = [];
    weights = [];
    explicit = input.channelLayout !== undefined;
    loudness = unavailableLoudness(layout.reason);
  } else {
    ({ labels, weights, explicit } = layout);
    const measured = measureLoudness(stableInput, weights);
    const absoluteEnergy = Math.pow(10, (ABSOLUTE_GATE_LUFS - LOUDNESS_OFFSET) / 10);
    const aboveAbsolute = measured.blockEnergies.filter((energy) => energy > absoluteEnergy);
    const absoluteGatedLoudness = loudnessFromEnergy(mean(aboveAbsolute));
    const relativeGateLufs = absoluteGatedLoudness === null ? null : absoluteGatedLoudness - 10;
    const relativeEnergy = relativeGateLufs === null ? Number.POSITIVE_INFINITY : Math.pow(10, (relativeGateLufs - LOUDNESS_OFFSET) / 10);
    const aboveRelative = aboveAbsolute.filter((energy) => energy > relativeEnergy);
    const integratedLufs = loudnessFromEnergy(mean(aboveRelative));

    const lraAbsolute = measured.shortTermPoints.filter((point) => point.lufs > ABSOLUTE_GATE_LUFS);
    const lraAbsoluteEnergies = lraAbsolute.map((point) => Math.pow(10, (point.lufs - LOUDNESS_OFFSET) / 10));
    const lraCenter = loudnessFromEnergy(mean(lraAbsoluteEnergies));
    const lraGate = lraCenter === null ? null : lraCenter - 20;
    const lraValues = lraAbsolute.filter((point) => lraGate !== null && point.lufs > lraGate).map((point) => point.lufs).sort((left, right) => left - right);
    const lraLow = percentileR7(lraValues, 0.1);
    const lraHigh = percentileR7(lraValues, 0.95);
    const lraAvailable = lraLow !== null && lraHigh !== null && lraValues.length >= 2;
    const momentaryValues = measured.momentaryPoints.map((point) => point.lufs);
    const shortValues = measured.shortTermPoints.map((point) => point.lufs);
    const hasCompleteBlock = measured.blockEnergies.length > 0;
    const enoughForIntegrated = hasCompleteBlock && integratedLufs !== null;

    loudness = {
      available: enoughForIntegrated,
      ...(!enoughForIntegrated ? { reason: hasCompleteBlock ? "programme is below the standards absolute loudness gate" : "standards integrated loudness requires at least one complete 400 ms block" } : {}),
      standardsCompliant: true,
      integratedLufs,
      absoluteGateLufs: -70,
      relativeGateLufs,
      blocks: { total: measured.blockEnergies.length, aboveAbsoluteGate: aboveAbsolute.length, aboveRelativeGate: aboveRelative.length },
      momentary: {
        windowSeconds: 0.4,
        cadenceSeconds: 0.1,
        currentLufs: measured.momentaryCurrent,
        maximumLufs: momentaryValues.length > 0 ? Math.max(...momentaryValues) : null,
        series: boundedSeries(measured.momentaryPoints),
        seriesLossy: true,
      },
      shortTerm: {
        windowSeconds: 3,
        cadenceSeconds: 0.1,
        currentLufs: measured.shortTermCurrent,
        maximumLufs: shortValues.length > 0 ? Math.max(...shortValues) : null,
        series: boundedSeries(measured.shortTermPoints),
        seriesLossy: true,
      },
      loudnessRange: {
        available: lraAvailable,
        ...(!lraAvailable ? { reason: "loudness range requires at least two qualifying 3 s short-term measurements" } : {}),
        lraLu: lraAvailable ? (lraHigh! - lraLow!) : null,
        lowLufs: lraAvailable ? lraLow : null,
        highLufs: lraAvailable ? lraHigh : null,
        absoluteGateLufs: -70,
        relativeGateOffsetLu: -20,
        percentileMethod: "linear-r7",
      },
    };
  }

  return {
    version: STANDARDS_AUDIO_VERSION,
    standards: {
      programmeLoudness: "ITU-R BS.1770-5",
      operatingRecommendation: "EBU R128",
      meter: "EBU Tech 3341",
      loudnessRange: "EBU Tech 3342",
    },
    channelLayout: { labels, weights, explicit, lfeExcluded: labels.includes("LFE") },
    loudness,
    truePeak: analyzeTruePeak(stableInput),
  };
}
