/** Deterministic, local-only analysis of normalized PCM samples.
 *
 * This module deliberately accepts samples rather than paths or URLs. It never
 * retains or returns audio data; callers receive aggregate measurements only.
 */

export const ANALYSIS_VERSION = "pcm-analysis/v1";
export const MAX_ANALYSIS_SAMPLES = 10_000_000;
export const MAX_ANALYSIS_SECONDS = 600;
export const MAX_SPECTRAL_FRAMES = 32;
export const MAX_FFT_SIZE = 4096;

export interface PcmAnalysisInput {
  samples: ArrayLike<number>;
  sampleRate: number;
  channels?: number;
  frameSize?: number;
}

export interface AudioRemediation {
  id: string;
  severity: "info" | "warning" | "critical";
  reason: string;
  action: string;
  reversible: true;
  changesAudio: false;
}

export interface PcmAnalysis {
  version: typeof ANALYSIS_VERSION;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  sampleCount: number;
  peak: number;
  peakDbfs: number;
  rms: number;
  rmsDbfs: number;
  loudness: { integratedLufsEstimate: number; method: "mono-rms-estimate" };
  dynamics: { crestFactorDb: number; dynamicRangeDb: number; silenceRatio: number };
  clipping: { count: number; ratio: number };
  spectral: { centroidHz: number; dominantFrequencyHz: number; analyzedFrames: number; fftSize: number };
  privacy: { rawAudioRetained: false; rawAudioReturned: false; sourcePathAccepted: false };
  safety: { playbackStarted: false; projectMutated: false; destructiveActionRequired: false };
  performance: { bounded: true; maxSamples: number; maxSeconds: number; maxSpectralFrames: number; maxFftSize: number };
  remediation: AudioRemediation[];
}

const EPSILON = 1e-12;

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, EPSILON));
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function analyzeSpectrum(samples: ArrayLike<number>, sampleRate: number, frameSize: number): PcmAnalysis["spectral"] {
  const fftSize = nextPowerOfTwo(Math.min(Math.max(frameSize, 256), MAX_FFT_SIZE));
  const frameCount = Math.max(1, Math.ceil(samples.length / frameSize));
  const analyzedFrames = Math.min(frameCount, MAX_SPECTRAL_FRAMES);
  let centroidTotal = 0;
  let activeFrames = 0;
  let dominantFrequency = 0;
  let dominantMagnitude = -1;
  for (let frame = 0; frame < analyzedFrames; frame += 1) {
    const start = Math.floor((frame * Math.max(samples.length - frameSize, 0)) / Math.max(analyzedFrames - 1, 1));
    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i += 1) {
      const sample = start + i < samples.length ? samples[start + i] ?? 0 : 0;
      real[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    for (let i = 1, j = 0; i < fftSize; i += 1) {
      let bit = fftSize >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const realValue = real[i] ?? 0;
        real[i] = real[j] ?? 0;
        real[j] = realValue;
        const imaginaryValue = imaginary[i] ?? 0;
        imaginary[i] = imaginary[j] ?? 0;
        imaginary[j] = imaginaryValue;
      }
    }
    for (let width = 2; width <= fftSize; width *= 2) {
      const half = width / 2;
      const phase = (-2 * Math.PI) / width;
      for (let offset = 0; offset < fftSize; offset += width) {
        for (let i = 0; i < half; i += 1) {
          const angle = phase * i;
          const cosine = Math.cos(angle);
          const sine = Math.sin(angle);
          const even = offset + i;
          const odd = even + half;
          const evenReal = real[even] ?? 0;
          const evenImaginary = imaginary[even] ?? 0;
          const oddReal = (real[odd] ?? 0) * cosine - (imaginary[odd] ?? 0) * sine;
          const oddImaginary = (real[odd] ?? 0) * sine + (imaginary[odd] ?? 0) * cosine;
          real[odd] = evenReal - oddReal;
          imaginary[odd] = evenImaginary - oddImaginary;
          real[even] = evenReal + oddReal;
          imaginary[even] = evenImaginary + oddImaginary;
        }
      }
    }
    let totalMagnitude = 0;
    let weightedFrequency = 0;
    for (let bin = 1; bin <= fftSize / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0);
      const frequency = (bin * sampleRate) / fftSize;
      totalMagnitude += magnitude;
      weightedFrequency += frequency * magnitude;
      if (magnitude > dominantMagnitude) {
        dominantMagnitude = magnitude;
        dominantFrequency = frequency;
      }
    }
    if (totalMagnitude > EPSILON) {
      centroidTotal += weightedFrequency / totalMagnitude;
      activeFrames += 1;
    }
  }
  return { centroidHz: activeFrames > 0 ? centroidTotal / activeFrames : 0, dominantFrequencyHz: activeFrames > 0 ? dominantFrequency : 0, analyzedFrames, fftSize };
}

function remediation(analysis: Pick<PcmAnalysis, "peakDbfs" | "clipping" | "loudness" | "dynamics">): AudioRemediation[] {
  const result: AudioRemediation[] = [];
  if (analysis.clipping.count > 0) {
    result.push({ id: "reduce-clipping", severity: "warning", reason: "Samples reach the normalized full-scale boundary.", action: "Preview a reversible gain reduction or limiter adjustment before applying it.", reversible: true, changesAudio: false });
  }
  if (analysis.peakDbfs > -1) {
    result.push({ id: "leave-headroom", severity: "warning", reason: "Peak level is within 1 dB of full scale.", action: "Preview at least 1 dB of headroom; do not change the Live set automatically.", reversible: true, changesAudio: false });
  }
  if (analysis.loudness.integratedLufsEstimate > -9) {
    result.push({ id: "check-loudness", severity: "info", reason: "The RMS-based loudness estimate is high.", action: "Compare against the delivery target and audition at a safe monitoring level.", reversible: true, changesAudio: false });
  }
  if (analysis.dynamics.silenceRatio > 0.95) {
    result.push({ id: "inspect-silence", severity: "info", reason: "More than 95% of samples are near silence.", action: "Inspect the capture range before editing or deleting anything.", reversible: true, changesAudio: false });
  }
  return result;
}

export function analyzePcm(input: PcmAnalysisInput): PcmAnalysis {
  const channels = input.channels ?? 1;
  const frameSize = input.frameSize ?? 2048;
  finite(input.sampleRate, "sampleRate");
  finite(channels, "channels");
  finite(frameSize, "frameSize");
  if (!Number.isInteger(input.sampleRate) || input.sampleRate < 8_000 || input.sampleRate > 384_000) throw new RangeError("sampleRate must be an integer from 8000 to 384000");
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) throw new RangeError("channels must be an integer from 1 to 32");
  if (!Number.isInteger(frameSize) || frameSize < 256 || frameSize > 4096) throw new RangeError("frameSize must be an integer from 256 to 4096");
  if (input.samples.length === 0 || input.samples.length > MAX_ANALYSIS_SAMPLES) throw new RangeError(`samples must contain 1-${MAX_ANALYSIS_SAMPLES} values`);
  if (input.samples.length % channels !== 0) throw new RangeError("samples must contain complete channel frames");
  if (input.samples.length / channels / input.sampleRate > MAX_ANALYSIS_SECONDS) throw new RangeError(`analysis duration exceeds ${MAX_ANALYSIS_SECONDS} seconds`);

  let sumSquares = 0;
  let peak = 0;
  let clippingCount = 0;
  let silenceCount = 0;
  const histogram = new Uint32Array(2048);
  for (let i = 0; i < input.samples.length; i += 1) {
    const sample = input.samples[i] ?? 0;
    finite(sample, `samples[${i}]`);
    if (sample < -1 || sample > 1) throw new RangeError(`samples[${i}] must be normalized between -1 and 1`);
    const magnitude = Math.abs(sample);
    const bucket = Math.min(histogram.length - 1, Math.floor(magnitude * histogram.length));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 0.999999) clippingCount += 1;
    if (magnitude < 0.0001) silenceCount += 1;
  }
  const rms = Math.sqrt(sumSquares / input.samples.length);
  const quantile = (fraction: number): number => {
    const target = Math.floor(input.samples.length * fraction);
    let seen = 0;
    for (let bucket = 0; bucket < histogram.length; bucket += 1) {
      seen += histogram[bucket] ?? 0;
      if (seen > target) return bucket / histogram.length;
    }
    return 1;
  };
  const p10 = quantile(0.1);
  const p95 = quantile(0.95);
  const monoSamples = new Float64Array(input.samples.length / channels);
  for (let frame = 0; frame < monoSamples.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += input.samples[frame * channels + channel] ?? 0;
    monoSamples[frame] = sum / channels;
  }
  const dynamicRangeDb = db(p95) - db(Math.max(p10, EPSILON));
  const analysis: PcmAnalysis = {
    version: ANALYSIS_VERSION,
    sampleRate: input.sampleRate,
    channels,
    durationSeconds: input.samples.length / channels / input.sampleRate,
    sampleCount: input.samples.length,
    peak,
    peakDbfs: db(peak),
    rms,
    rmsDbfs: db(rms),
    loudness: { integratedLufsEstimate: db(rms), method: "mono-rms-estimate" },
    dynamics: { crestFactorDb: db(peak / Math.max(rms, EPSILON)), dynamicRangeDb, silenceRatio: silenceCount / input.samples.length },
    clipping: { count: clippingCount, ratio: clippingCount / input.samples.length },
    spectral: analyzeSpectrum(monoSamples, input.sampleRate, frameSize),
    privacy: { rawAudioRetained: false, rawAudioReturned: false, sourcePathAccepted: false },
    safety: { playbackStarted: false, projectMutated: false, destructiveActionRequired: false },
    performance: { bounded: true, maxSamples: MAX_ANALYSIS_SAMPLES, maxSeconds: MAX_ANALYSIS_SECONDS, maxSpectralFrames: MAX_SPECTRAL_FRAMES, maxFftSize: MAX_FFT_SIZE },
    remediation: [],
  };
  analysis.remediation = remediation(analysis);
  return analysis;
}

export function decodeFloat32Le(base64: string): Float32Array {
  const maxBase64Length = Math.ceil((MAX_ANALYSIS_SAMPLES * 4) / 3) * 4;
  if (typeof base64 !== "string" || base64.length > maxBase64Length) throw new RangeError("pcmBase64 is invalid or exceeds the analysis limit");
  if (base64.length === 0 || base64.length % 4 !== 0) throw new RangeError("pcmBase64 is invalid");
  let contentLength = base64.length;
  const paddingStart = base64.indexOf("=");
  if (paddingStart >= 0) {
    contentLength = paddingStart;
    const padding = base64.slice(paddingStart);
    if ((padding !== "=" && padding !== "==") || paddingStart < 2) throw new RangeError("pcmBase64 is invalid");
  }
  for (let i = 0; i < contentLength; i += 1) {
    const code = base64.charCodeAt(i);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!valid) throw new RangeError("pcmBase64 is invalid");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) throw new RangeError("non-canonical encoding");
  } catch { throw new RangeError("pcmBase64 is invalid"); }
  if (bytes.length === 0 || bytes.length % 4 !== 0 || bytes.length / 4 > MAX_ANALYSIS_SAMPLES) throw new RangeError("pcmBase64 must contain bounded float32 PCM");
  const result = new Float32Array(bytes.length / 4);
  for (let i = 0; i < result.length; i += 1) result[i] = bytes.readFloatLE(i * 4);
  return result;
}
