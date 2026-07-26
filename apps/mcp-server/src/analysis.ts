/** Deterministic, local-only analysis of normalized PCM samples.
 *
 * This module deliberately accepts samples rather than paths or URLs. It never
 * retains or returns audio data; callers receive aggregate measurements only.
 */

export const ANALYSIS_VERSION = "pcm-analysis/v1";
export const MAX_ANALYSIS_SAMPLES = 10_000_000;
export const MAX_ANALYSIS_SECONDS = 600;
export const MAX_ANALYSIS_CHANNELS = 32;
export const MAX_SPECTRAL_FRAMES = 32;
export const MAX_FFT_SIZE = 4096;
export const MAX_WAVEFORM_BINS = 256;
export const MAX_TIME_FREQUENCY_FRAMES = 32;
export const MAX_TIME_FREQUENCY_BANDS = 24;

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

export interface WaveformEnvelope {
  startSeconds: number;
  endSeconds: number;
  channels: Array<{ min: number; max: number; rms: number }>;
}

export interface TimeFrequencyBand {
  lowHz: number;
  highHz: number;
  centerHz: number;
  energy: number;
  energyDb: number;
  channels: number[];
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
  channelsDetail: Array<{ channel: number; peak: number; peakDbfs: number; rms: number; rmsDbfs: number; dcOffset: number; clipping: { count: number; ratio: number } }>;
  stereo: { phaseCorrelation: number | null; reason?: string };
  loudness: { rmsLoudnessProxyDb: number; integratedLufsEstimate: number; method: "rms-derived-proxy"; standardsCompliant: false; deprecatedIntegratedLufsEstimate: true };
  dynamics: { crestFactorDb: number; dynamicRangeDb: number; silenceRatio: number };
  clipping: { count: number; ratio: number };
  spectral: { centroidHz: number; dominantFrequencyHz: number; analyzedFrames: number; fftSize: number };
  waveform: { bins: WaveformEnvelope[]; binCount: number; channelAggregation: "per-channel"; lossy: true };
  timeFrequency: {
    frames: Array<{ startSeconds: number; endSeconds: number; bands: TimeFrequencyBand[] }>;
    frameCount: number;
    bandCount: number;
    frequencyRangeHz: { min: number; max: number };
    method: "hann-windowed-fft";
    channelAggregation: "per-channel-and-aggregate";
    normalization: "mean-square-per-frame";
    lossy: true;
  };
  transients: { peakCount: number; densityPerSecond: number; threshold: number; strongest: { sampleIndex: number; timeSeconds: number; amplitude: number } | null };
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

function fftMagnitudes(samples: ArrayLike<number>, start: number, sampleRate: number, frameSize: number): { magnitudes: Float64Array; fftSize: number } {
  const fftSize = nextPowerOfTwo(Math.min(Math.max(frameSize, 256), MAX_FFT_SIZE));
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
      const realValue = real[i] ?? 0; real[i] = real[j] ?? 0; real[j] = realValue;
      const imaginaryValue = imaginary[i] ?? 0; imaginary[i] = imaginary[j] ?? 0; imaginary[j] = imaginaryValue;
    }
  }
  for (let width = 2; width <= fftSize; width *= 2) {
    const half = width / 2;
    const phase = (-2 * Math.PI) / width;
    for (let offset = 0; offset < fftSize; offset += width) {
      for (let i = 0; i < half; i += 1) {
        const angle = phase * i;
        const cosine = Math.cos(angle); const sine = Math.sin(angle);
        const even = offset + i; const odd = even + half;
        const evenReal = real[even] ?? 0; const evenImaginary = imaginary[even] ?? 0;
        const oddReal = (real[odd] ?? 0) * cosine - (imaginary[odd] ?? 0) * sine;
        const oddImaginary = (real[odd] ?? 0) * sine + (imaginary[odd] ?? 0) * cosine;
        real[odd] = evenReal - oddReal; imaginary[odd] = evenImaginary - oddImaginary;
        real[even] = evenReal + oddReal; imaginary[even] = evenImaginary + oddImaginary;
      }
    }
  }
  const magnitudes = new Float64Array(fftSize / 2);
  for (let bin = 1; bin <= fftSize / 2; bin += 1) magnitudes[bin - 1] = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0);
  return { magnitudes, fftSize };
}

function analyzeSpectrum(samples: ArrayLike<number>, sampleRate: number, frameSize: number): PcmAnalysis["spectral"] {
  const frameCount = Math.max(1, Math.ceil(samples.length / frameSize));
  const analyzedFrames = Math.min(frameCount, MAX_SPECTRAL_FRAMES);
  const fftSize = nextPowerOfTwo(Math.min(Math.max(frameSize, 256), MAX_FFT_SIZE));
  let centroidTotal = 0;
  let activeFrames = 0;
  let dominantFrequency = 0;
  let dominantMagnitude = -1;
  for (let frame = 0; frame < analyzedFrames; frame += 1) {
    const start = Math.floor((frame * Math.max(samples.length - frameSize, 0)) / Math.max(analyzedFrames - 1, 1));
    const { magnitudes } = fftMagnitudes(samples, start, sampleRate, frameSize);
    let totalMagnitude = 0;
    let weightedFrequency = 0;
    for (let bin = 1; bin <= fftSize / 2; bin += 1) {
      const magnitude = magnitudes[bin - 1] ?? 0;
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

function waveform(samples: Float64Array, channels: number, sampleRate: number): PcmAnalysis["waveform"] {
  const frames = samples.length / channels;
  const binCount = Math.min(MAX_WAVEFORM_BINS, Math.max(1, frames));
  const bins = Array.from({ length: binCount }, (_, bin) => {
    const start = Math.floor((bin * frames) / binCount);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * frames) / binCount));
    const details = Array.from({ length: channels }, (_, channel) => {
      let min = 1; let max = -1; let squares = 0; let count = 0;
      for (let frame = start; frame < Math.min(end, frames); frame += 1) {
        const value = samples[frame * channels + channel] ?? 0;
        min = Math.min(min, value); max = Math.max(max, value); squares += value * value; count += 1;
      }
      return { min, max, rms: Math.sqrt(squares / Math.max(count, 1)) };
    });
    return { startSeconds: start / sampleRate, endSeconds: Math.min(end, frames) / sampleRate, channels: details };
  });
  return { bins, binCount, channelAggregation: "per-channel", lossy: true };
}

function timeFrequency(samples: Float64Array, channels: number, sampleRate: number, frameSize: number): PcmAnalysis["timeFrequency"] {
  const frames = samples.length / channels;
  const frameCount = Math.min(MAX_TIME_FREQUENCY_FRAMES, Math.max(1, Math.ceil(frames / frameSize)));
  const fftSize = nextPowerOfTwo(Math.min(Math.max(frameSize, 256), MAX_FFT_SIZE));
  const nyquist = sampleRate / 2;
  const minFrequency = Math.min(20, nyquist / 2);
  const maxFrequency = nyquist;
  const bands = Array.from({ length: MAX_TIME_FREQUENCY_BANDS }, (_, index) => {
    const lowHz = minFrequency * Math.pow(maxFrequency / minFrequency, index / MAX_TIME_FREQUENCY_BANDS);
    const highHz = minFrequency * Math.pow(maxFrequency / minFrequency, (index + 1) / MAX_TIME_FREQUENCY_BANDS);
    return { lowHz, highHz, centerHz: Math.sqrt(lowHz * highHz) };
  });
  const output = Array.from({ length: frameCount }, (_, index) => {
    const start = Math.floor((index * Math.max(frames - frameSize, 0)) / Math.max(frameCount - 1, 1));
    const perChannel = Array.from({ length: channels }, (_, channel) => {
      const mono = new Float64Array(Math.ceil(frames));
      for (let frame = 0; frame < frames; frame += 1) mono[frame] = samples[frame * channels + channel] ?? 0;
      return fftMagnitudes(mono, start, sampleRate, frameSize).magnitudes;
    });
    const bandValues = bands.map((band) => {
      const channelEnergy = perChannel.map((magnitudes) => {
        let sum = 0; let count = 0;
        for (let bin = 1; bin <= magnitudes.length; bin += 1) {
          const frequency = (bin * sampleRate) / fftSize;
          if (frequency >= band.lowHz && frequency < band.highHz) { const magnitude = magnitudes[bin - 1] ?? 0; sum += magnitude * magnitude; count += 1; }
        }
        return sum / Math.max(count * fftSize * fftSize, 1);
      });
      const energy = channelEnergy.reduce((sum, value) => sum + value, 0) / channels;
      return { ...band, energy, energyDb: db(Math.sqrt(energy)), channels: channelEnergy.map((value) => Math.sqrt(value)) };
    });
    return { startSeconds: start / sampleRate, endSeconds: Math.min(start + frameSize, frames) / sampleRate, bands: bandValues };
  });
  return { frames: output, frameCount, bandCount: bands.length, frequencyRangeHz: { min: minFrequency, max: maxFrequency }, method: "hann-windowed-fft", channelAggregation: "per-channel-and-aggregate", normalization: "mean-square-per-frame", lossy: true };
}

function transients(samples: Float64Array, sampleRate: number): PcmAnalysis["transients"] {
  let peakCount = 0; let strongestIndex = -1; let strongestAmplitude = 0; let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, sample);
  const threshold = Math.max(0.25, Math.min(0.9, maximum * 0.5));
  const refractory = Math.max(1, Math.floor(sampleRate * 0.01)); let lastPeak = -refractory;
  for (let index = 0; index < samples.length; index += 1) { const amplitude = Math.abs(samples[index] ?? 0); const previous = Math.abs(samples[index - 1] ?? 0); const next = Math.abs(samples[index + 1] ?? 0); if (amplitude >= threshold && amplitude >= previous && amplitude > next && index - lastPeak >= refractory) { peakCount += 1; lastPeak = index; if (amplitude > strongestAmplitude) { strongestAmplitude = amplitude; strongestIndex = index; } } }
  return { peakCount, densityPerSecond: peakCount / (samples.length / sampleRate), threshold, strongest: strongestIndex < 0 ? null : { sampleIndex: strongestIndex, timeSeconds: strongestIndex / sampleRate, amplitude: strongestAmplitude } };
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
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_ANALYSIS_CHANNELS) throw new RangeError(`channels must be an integer from 1 to ${MAX_ANALYSIS_CHANNELS}`);
  if (!Number.isInteger(frameSize) || frameSize < 256 || frameSize > 4096) throw new RangeError("frameSize must be an integer from 256 to 4096");
  const sampleCount = input.samples.length;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > MAX_ANALYSIS_SAMPLES) throw new RangeError(`samples must contain 1-${MAX_ANALYSIS_SAMPLES} values`);
  if (sampleCount % channels !== 0) throw new RangeError("samples must contain complete channel frames");
  if (sampleCount / channels / input.sampleRate > MAX_ANALYSIS_SECONDS) throw new RangeError(`analysis duration exceeds ${MAX_ANALYSIS_SECONDS} seconds`);

  let sumSquares = 0;
  let peak = 0;
  let clippingCount = 0;
  let silenceCount = 0;
  const histogram = new Uint32Array(2048);
  // Copy caller-owned storage once. This both bounds the trust boundary and
  // ensures all aggregate, channel, stereo, and spectral fields describe the
  // same immutable snapshot when an ArrayLike has observable getters.
  const normalizedSamples = new Float64Array(sampleCount);
  const monoSamples = new Float64Array(sampleCount / channels);
  const channelSquares = new Float64Array(channels);
  const channelSums = new Float64Array(channels);
  const channelPeaks = new Float64Array(channels);
  const channelClips = new Uint32Array(channels);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = input.samples[i] ?? 0;
    finite(sample, `samples[${i}]`);
    if (sample < -1 || sample > 1) throw new RangeError(`samples[${i}] must be normalized between -1 and 1`);
    normalizedSamples[i] = sample;
    const magnitude = Math.abs(sample);
    const channel = i % channels;
    const bucket = Math.min(histogram.length - 1, Math.floor(magnitude * histogram.length));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    sumSquares += sample * sample;
    channelSquares[channel] = (channelSquares[channel] ?? 0) + sample * sample;
    channelSums[channel] = (channelSums[channel] ?? 0) + sample;
    channelPeaks[channel] = Math.max(channelPeaks[channel] ?? 0, magnitude);
    if (magnitude >= 0.999999) channelClips[channel] = (channelClips[channel] ?? 0) + 1;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 0.999999) clippingCount += 1;
    if (magnitude < 0.0001) silenceCount += 1;
    if (i % channels === 0) monoSamples[i / channels] = sample;
    else if (magnitude > Math.abs(monoSamples[Math.floor(i / channels)] ?? 0)) monoSamples[Math.floor(i / channels)] = sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  const frames = sampleCount / channels;
  const channelsDetail = Array.from({ length: channels }, (_, channel) => {
    const channelRms = Math.sqrt((channelSquares[channel] ?? 0) / frames);
    const channelPeak = channelPeaks[channel] ?? 0;
    const clipCount = channelClips[channel] ?? 0;
    return { channel, peak: channelPeak, peakDbfs: db(channelPeak), rms: channelRms, rmsDbfs: db(channelRms), dcOffset: (channelSums[channel] ?? 0) / frames, clipping: { count: clipCount, ratio: clipCount / frames } };
  });
  let phaseCorrelation: number | null = null;
  let correlationReason: string | undefined;
  if (channels === 2) {
    let leftSquares = 0; let rightSquares = 0; let product = 0;
    for (let frame = 0; frame < frames; frame += 1) { const left = normalizedSamples[frame * 2] ?? 0; const right = normalizedSamples[frame * 2 + 1] ?? 0; leftSquares += left * left; rightSquares += right * right; product += left * right; }
    phaseCorrelation = leftSquares === 0 || rightSquares === 0 ? 0 : Math.max(-1, Math.min(1, product / Math.sqrt(leftSquares * rightSquares)));
  } else { correlationReason = "phase correlation is applicable only to stereo input"; }
  const quantile = (fraction: number): number => {
    const target = Math.floor(sampleCount * fraction);
    let seen = 0;
    for (let bucket = 0; bucket < histogram.length; bucket += 1) {
      seen += histogram[bucket] ?? 0;
      if (seen > target) return bucket / histogram.length;
    }
    return 1;
  };
  const p10 = quantile(0.1);
  const p95 = quantile(0.95);
  const dynamicRangeDb = db(p95) - db(Math.max(p10, EPSILON));
  const analysis: PcmAnalysis = {
    version: ANALYSIS_VERSION,
    sampleRate: input.sampleRate,
    channels,
    durationSeconds: sampleCount / channels / input.sampleRate,
    sampleCount,
    peak,
    peakDbfs: db(peak),
    rms,
    rmsDbfs: db(rms),
    channelsDetail,
    stereo: { phaseCorrelation, ...(correlationReason ? { reason: correlationReason } : {}) },
    loudness: { rmsLoudnessProxyDb: db(rms), integratedLufsEstimate: db(rms), method: "rms-derived-proxy", standardsCompliant: false, deprecatedIntegratedLufsEstimate: true },
    dynamics: { crestFactorDb: db(peak / Math.max(rms, EPSILON)), dynamicRangeDb, silenceRatio: silenceCount / sampleCount },
    clipping: { count: clippingCount, ratio: clippingCount / sampleCount },
    spectral: analyzeSpectrum(monoSamples, input.sampleRate, frameSize),
    waveform: waveform(normalizedSamples, channels, input.sampleRate),
    timeFrequency: timeFrequency(normalizedSamples, channels, input.sampleRate, frameSize),
    transients: transients(monoSamples, input.sampleRate),
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
  for (let i = 0; i < result.length; i += 1) {
    const sample = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) throw new RangeError("pcmBase64 must contain finite normalized float32 PCM");
    result[i] = sample;
  }
  return result;
}
