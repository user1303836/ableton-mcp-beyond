/**
 * Deterministic musical key/scale estimation (read-only).
 *
 * Pitch-class profile: each note contributes `duration * (velocity / 127)`,
 * falling back to `duration` alone when velocity is absent. Durations use the
 * canonical beat units of the note schema; no time signature or tempo is
 * assumed.
 *
 * Correlation: Pearson product-moment correlation between the observed
 * pitch-class weight vector and the published Krumhansl-Schmuckler (1982)
 * major and minor key profiles. Modal candidates (dorian, phrygian, lydian,
 * mixolydian) use the documented approximation of rotating the major profile
 * to each mode's parent scale; locrian is excluded because the rotated
 * profile cannot distinguish it reliably.
 *
 * Relative modes share a diatonic collection, so pitch-class content alone
 * cannot separate them (C major vs A minor vs D dorian). Ranking therefore
 * adds a documented tonal-center tiebreak: the share of first/last note
 * weight (by start time, order-independent) that falls on the candidate's
 * tonic pitch class. Candidates whose scores are within the ambiguity margin
 * AND whose tonal-center evidence is indistinguishable are reported as
 * ambiguous alternatives, never a forced answer.
 *
 * Collections covering ten or more pitch classes are chromatic: no diatonic
 * candidate can explain them, so they report insufficient evidence.
 *
 * The estimate never forces a single answer: it reports ranked candidates
 * with scores, an explicit confidence classification, and an ambiguity flag
 * when the top candidates are statistically indistinguishable.
 */

export interface KeyEstimateNote {
  readonly pitch: number;
  readonly start: number;
  readonly duration: number;
  readonly velocity?: number;
}

export interface KeyCandidate {
  readonly key: string;
  readonly tonic: number;
  readonly mode: string;
  readonly score: number;
  readonly tonicEvidence: number;
}

export type KeyConfidence = "high" | "medium" | "low" | "insufficient-evidence";

export interface KeyEstimateEvidence {
  readonly noteCount: number;
  readonly pitchClassCount: number;
  readonly chromatic: boolean;
  readonly totalDurationBeats: number;
  readonly algorithm: string;
}

export interface KeyEstimate {
  readonly candidates: readonly KeyCandidate[];
  readonly confidence: KeyConfidence;
  readonly ambiguous: boolean;
  readonly alternatives: readonly KeyCandidate[];
  readonly evidence: KeyEstimateEvidence;
}

const MAJOR_PROFILE: readonly number[] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: readonly number[] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES: readonly string[] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Semitones from the mode's final up to its parent major scale's tonic. */
const MODE_PARENT_OFFSETS: ReadonlyArray<{ readonly mode: string; readonly offset: number }> = [
  { mode: "dorian", offset: 10 },
  { mode: "phrygian", offset: 8 },
  { mode: "lydian", offset: 7 },
  { mode: "mixolydian", offset: 5 },
];

const ALGORITHM_ID = "krumhansl-schmuckler-1982+modes(duration*velocity/127,tonal-center-tiebreak)";
/** Top candidates closer than this margin are statistically indistinguishable. */
const AMBIGUITY_MARGIN = 0.05;
/** Tonal-center evidence closer than this is indistinguishable. */
const TONIC_EVIDENCE_MARGIN = 0.01;
/** Below this best score no candidate explains the material. */
const EVIDENCE_FLOOR = 0.4;
const HIGH_CONFIDENCE = 0.75;
const MEDIUM_CONFIDENCE = 0.55;
const MAX_CANDIDATES = 5;

function pearson(observed: readonly number[], expected: readonly number[]): number {
  const n = observed.length;
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / n;
  const meanO = mean(observed);
  const meanE = mean(expected);
  let numerator = 0;
  let sumSqO = 0;
  let sumSqE = 0;
  for (let index = 0; index < n; index += 1) {
    const deltaO = observed[index]! - meanO;
    const deltaE = expected[index]! - meanE;
    numerator += deltaO * deltaE;
    sumSqO += deltaO * deltaO;
    sumSqE += deltaE * deltaE;
  }
  const denominator = Math.sqrt(sumSqO * sumSqE);
  return denominator === 0 ? 0 : numerator / denominator;
}

function profileFor(tonic: number, profile: readonly number[]): number[] {
  const vector: number[] = [];
  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) vector.push(profile[(pitchClass - tonic + 120) % 12]!);
  return vector;
}

export function estimateKey(notes: readonly KeyEstimateNote[]): KeyEstimate {
  const weights = new Array<number>(12).fill(0);
  let noteCount = 0;
  let totalDurationBeats = 0;
  let firstNote: { readonly pitchClass: number; readonly weight: number; readonly start: number } | null = null;
  let lastNote: { readonly pitchClass: number; readonly weight: number; readonly end: number } | null = null;
  for (const note of notes) {
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) continue;
    if (typeof note.duration !== "number" || !Number.isFinite(note.duration) || note.duration <= 0) continue;
    const velocity = typeof note.velocity === "number" && Number.isFinite(note.velocity) ? Math.min(Math.max(note.velocity, 0), 127) / 127 : 1;
    const weight = note.duration * velocity;
    weights[note.pitch % 12]! += weight;
    noteCount += 1;
    totalDurationBeats += note.duration;
    const pitchClass = note.pitch % 12;
    if (firstNote === null || note.start < firstNote.start || (note.start === firstNote.start && pitchClass < firstNote.pitchClass)) firstNote = { pitchClass, weight, start: note.start };
    const end = note.start + note.duration;
    if (lastNote === null || end > lastNote.end || (end === lastNote.end && pitchClass > lastNote.pitchClass)) lastNote = { pitchClass, weight, end };
  }
  const pitchClasses = weights.map((weight, pitchClass) => (weight > 0 ? pitchClass : -1)).filter((pitchClass) => pitchClass >= 0);
  const pitchClassCount = pitchClasses.length;

  const boundaryWeight = (firstNote?.weight ?? 0) + (noteCount === 1 ? 0 : lastNote?.weight ?? 0);
  const tonalEvidence = (tonic: number): number => {
    if (firstNote === null || boundaryWeight <= 0) return 0;
    let evidence = firstNote.pitchClass === tonic ? firstNote.weight : 0;
    if (noteCount > 1 && lastNote !== null && lastNote.pitchClass === tonic) evidence += lastNote.weight;
    return evidence / boundaryWeight;
  };

  const scored: KeyCandidate[] = [];
  if (pitchClassCount > 0) {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      scored.push({ key: `${NOTE_NAMES[tonic]} major`, tonic, mode: "major", score: pearson(weights, profileFor(tonic, MAJOR_PROFILE)), tonicEvidence: tonalEvidence(tonic) });
      scored.push({ key: `${NOTE_NAMES[tonic]} minor`, tonic, mode: "minor", score: pearson(weights, profileFor(tonic, MINOR_PROFILE)), tonicEvidence: tonalEvidence(tonic) });
      for (const { mode, offset } of MODE_PARENT_OFFSETS) {
        const parent = (tonic + offset) % 12;
        scored.push({ key: `${NOTE_NAMES[tonic]} ${mode}`, tonic, mode, score: pearson(weights, profileFor(parent, MAJOR_PROFILE)), tonicEvidence: tonalEvidence(tonic) });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.tonicEvidence - a.tonicEvidence || a.key.localeCompare(b.key));
  }

  const candidates = scored.slice(0, MAX_CANDIDATES).map((candidate) => ({ ...candidate, score: Number(candidate.score.toFixed(6)), tonicEvidence: Number(candidate.tonicEvidence.toFixed(6)) }));
  const best = scored[0]?.score ?? 0;
  const second = scored[1]?.score ?? 0;
  const insufficient = noteCount < 3 || pitchClassCount < 3 || pitchClassCount >= 10 || best < EVIDENCE_FLOOR;
  const ambiguous = !insufficient && best - second < AMBIGUITY_MARGIN && Math.abs((scored[0]?.tonicEvidence ?? 0) - (scored[1]?.tonicEvidence ?? 0)) < TONIC_EVIDENCE_MARGIN;
  const confidence: KeyConfidence = insufficient ? "insufficient-evidence" : ambiguous ? (best >= HIGH_CONFIDENCE ? "medium" : "low") : best >= HIGH_CONFIDENCE ? "high" : best >= MEDIUM_CONFIDENCE ? "medium" : "low";
  const alternatives = ambiguous ? candidates.filter((candidate) => best - candidate.score < AMBIGUITY_MARGIN) : [];
  return {
    candidates,
    confidence,
    ambiguous,
    alternatives,
    evidence: { noteCount, pitchClassCount, chromatic: pitchClassCount >= 10, totalDurationBeats: Number(totalDurationBeats.toFixed(6)), algorithm: ALGORITHM_ID },
  };
}
