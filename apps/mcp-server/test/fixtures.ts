export function sineFixture(length: number, frequency: number, sampleRate: number, amplitude = 0.5): Float32Array {
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return result;
}

export function impulseFixture(length: number, amplitude = 1): Float32Array {
  const result = new Float32Array(length);
  result[0] = amplitude;
  return result;
}

export function dcFixture(length: number, value: number): Float32Array {
  return Float32Array.from({ length }, () => value);
}

export function silenceFixture(length: number): Float32Array {
  return new Float32Array(length);
}

export function sweepFixture(length: number, startHz: number, endHz: number, sampleRate: number, amplitude = 0.5): Float32Array {
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const progress = index / Math.max(length - 1, 1);
    const frequency = startHz + (endHz - startHz) * progress;
    result[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return result;
}

export function stereoFixture(length: number, left: (frame: number) => number, right: (frame: number) => number): Float32Array {
  const result = new Float32Array(length * 2);
  for (let frame = 0; frame < length; frame += 1) {
    result[frame * 2] = left(frame);
    result[frame * 2 + 1] = right(frame);
  }
  return result;
}
