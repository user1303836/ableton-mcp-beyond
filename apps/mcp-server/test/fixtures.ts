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
