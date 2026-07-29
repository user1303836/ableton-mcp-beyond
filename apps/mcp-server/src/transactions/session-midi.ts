import { createHash, randomBytes } from "node:crypto";
import type { AsyncLiveAdapter, LiveAdapter, LiveOperationContext, LiveRef, LiveSnapshot, Note, LiveStatus } from "../live.js";

export const SESSION_MIDI_TRANSACTION_TTL_MS = 30_000;
export const MAX_SESSION_MIDI_NOTES = 512;

export interface SessionMidiRequest { trackRef: LiveRef; sceneIndex: number; name: string; length: number; notes: Note[]; }
export interface SessionMidiPreview { transactionId: string; epoch: number; revision: string; target: { trackRef: LiveRef; trackIdentity: string; sceneIndex: number; slotRef: LiveRef; slotIdentity: string; sceneRef: LiveRef; sceneIdentity: string; }; prior: { occupied: boolean; clipRef?: LiveRef }; proposed: SessionMidiRequest; impact: "creates-session-midi-clip"; confirmation: "apply"; expiresAt: number; }
export interface SessionMidiRecord extends SessionMidiPreview { state: "previewed" | "applying" | "applied" | "undoing" | "undone" | "uncertain"; clipRef?: LiveRef; clipIdentity?: string; clipFingerprint?: string; clipBaseFingerprint?: string; appliedNotesRevision?: string; clipDeleteAuthority?: Record<string, unknown>; appliedNotes?: Note[]; createArgs?: Record<string, unknown>; noteArgs?: Record<string, unknown>; undoArgs?: Record<string, unknown>; compensationArgs?: Record<string, unknown>; compensationFingerprint?: string; recoveryMode?: "apply" | "compensate"; applyKey?: string; undoKey?: string; }

function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string { if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
function fingerprint(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function clipBaseFingerprint(value: unknown): string { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MIDI clip base state is unavailable"); const base = structuredClone(value) as Record<string, unknown>; delete base.notes; delete base.notesRevision; return fingerprint(base); }
function targetAuthority(snapshot: LiveSnapshot, trackRef: LiveRef, sceneIndex: number): SessionMidiPreview["target"] {
  const track = snapshot.tracks.find((item) => item.ref === trackRef);
  const slot = track?.clipSlots?.find((item) => item.sceneIndex === sceneIndex);
  const scene = snapshot.scenes.find((item) => item.index === sceneIndex);
  if (!track || typeof track.objectIdentity !== "string" || !slot || typeof slot.objectIdentity !== "string" || !scene || typeof scene.objectIdentity !== "string") throw new Error("MIDI target lacks exact track, slot, or scene identity");
  return { trackRef, trackIdentity: track.objectIdentity, sceneIndex, slotRef: slot.ref, slotIdentity: slot.objectIdentity, sceneRef: scene.ref, sceneIdentity: scene.objectIdentity };
}
function clipDeleteAuthority(snapshot: LiveSnapshot, clipRef: LiveRef): Record<string, unknown> {
  for (const track of snapshot.tracks) {
    const clip = track.clips.find((item) => item.ref === clipRef); const slot = track.clipSlots?.find((item) => item.clipRef === clipRef); const scene = slot && snapshot.scenes.find((item) => item.index === slot.sceneIndex);
    if (clip && typeof clip.objectIdentity === "string" && typeof track.objectIdentity === "string" && slot && typeof slot.objectIdentity === "string" && scene && typeof scene.objectIdentity === "string") return { expectedObjectIdentity: clip.objectIdentity, expectedTrackRef: track.ref, expectedTrackIdentity: track.objectIdentity, expectedSlotRef: slot.ref, expectedSlotIdentity: slot.objectIdentity, expectedSceneRef: scene.ref, expectedSceneIdentity: scene.objectIdentity };
  }
  throw new Error("MIDI clip lacks exact deletion authority");
}
function noteMutationAuthority(snapshot: LiveSnapshot, clipRef: LiveRef): { expectedClipAuthority: Record<string, unknown>; expectedNotesRevision: string } {
  const clip = snapshot.tracks.flatMap((track) => track.clips).find((candidate) => candidate.ref === clipRef);
  if (!clip || typeof clip.notesRevision !== "string") throw new Error("MIDI clip notes revision is unavailable");
  return { expectedClipAuthority: clipDeleteAuthority(snapshot, clipRef), expectedNotesRevision: clip.notesRevision };
}
function revision(snapshot: LiveSnapshot, target: SessionMidiPreview["target"]): string {
  const track = snapshot.tracks.find((item) => item.ref === target.trackRef);
  const clip = track?.clips.find((item) => item.start === target.sceneIndex * 4);
  return `${target.trackRef}:${target.trackIdentity}:${target.slotRef}:${target.slotIdentity}:${target.sceneRef}:${target.sceneIdentity}:${clip?.ref ?? "empty"}:${clip?.name ?? ""}:${clip?.notes.length ?? 0}`;
}
function validateNote(note: Note, length: number): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127 || !Number.isInteger(note.channel) || note.channel < 1 || note.channel > 16 || !Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0 || note.start + note.duration > length) throw new Error("invalid MIDI note");
  if (note.mute != null && typeof note.mute !== "boolean") throw new Error("invalid MIDI note mute");
  if (note.probability != null && (!Number.isFinite(note.probability) || note.probability < 0 || note.probability > 1)) throw new Error("invalid MIDI note probability");
  if (note.velocityDeviation != null && (!Number.isFinite(note.velocityDeviation) || note.velocityDeviation < -127 || note.velocityDeviation > 127)) throw new Error("invalid MIDI velocity deviation");
  if (note.releaseVelocity != null && (!Number.isFinite(note.releaseVelocity) || note.releaseVelocity < 0 || note.releaseVelocity > 127)) throw new Error("invalid MIDI release velocity");
}
function validateRequest(value: unknown): asserts value is SessionMidiRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid MIDI clip request");
  const request = value as Partial<SessionMidiRequest>;
  const sceneIndex = request.sceneIndex;
  if (typeof request.trackRef !== "string" || !Number.isInteger(sceneIndex) || (sceneIndex as number) < 0 || (sceneIndex as number) > 1023 || typeof request.name !== "string" || request.name.length < 1 || request.name.length > 256 || typeof request.length !== "number" || !Number.isFinite(request.length) || request.length <= 0 || request.length > 1024 || !Array.isArray(request.notes) || request.notes.length > MAX_SESSION_MIDI_NOTES) throw new Error("invalid MIDI clip request");
  request.notes.forEach((note) => validateNote(note, request.length as number));
}

export class SessionMidiTransactionManager {
  private static readonly MAX_RECORDS = 64;
  private readonly records = new Map<string, SessionMidiRecord>();
  private readonly idempotency = new Map<string, { transactionId: string; result: unknown }>();
  constructor(private readonly adapter: LiveAdapter) {}

  private retain(record: SessionMidiRecord): void {
    const now = Date.now(); const protectedStates = new Set(["applying", "applied", "undoing", "uncertain"]);
    for (const [id, candidate] of this.records) if (candidate.expiresAt <= now && !protectedStates.has(candidate.state)) this.records.delete(id);
    for (const [key, candidate] of this.idempotency) if (!this.records.has(candidate.transactionId)) this.idempotency.delete(key);
    while (this.records.size >= SessionMidiTransactionManager.MAX_RECORDS) {
      const oldest = [...this.records].find(([, candidate]) => !protectedStates.has(candidate.state));
      if (!oldest) throw new Error("MIDI transaction capacity is exhausted by recovery-protected work");
      this.records.delete(oldest[0]);
    }
    this.records.set(record.transactionId, record);
  }

  private asyncAdapter(): AsyncLiveAdapter {
    const value = this.adapter as Partial<AsyncLiveAdapter>;
    if (typeof value.snapshotAsync !== "function" || typeof value.getAsync !== "function" || typeof value.invokeAsync !== "function") throw new Error("live adapter does not support asynchronous operations");
    return this.adapter as AsyncLiveAdapter;
  }

  async previewAsync(request: unknown): Promise<SessionMidiPreview> {
    validateRequest(request);
    const adapter = this.asyncAdapter();
    const status = this.require(["session.read", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.write"], ["clip.create", "clip.delete", "note.add-batch"]);
    const snapshot = await adapter.snapshotAsync();
    const track = snapshot.tracks.find((item) => item.ref === (request as SessionMidiRequest).trackRef);
    if (!track || (track.kind !== "midi" && (track as unknown as { mediaKind?: string }).mediaKind !== "midi")) throw new Error("MIDI track not found");
    const typed = request as SessionMidiRequest;
    const clip = track.clips.find((item) => item.start === typed.sceneIndex * 4);
    if (clip) throw new Error("Session slot is occupied");
    const target = targetAuthority(snapshot, typed.trackRef, typed.sceneIndex);
    const result: SessionMidiPreview = { transactionId: `midi_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: revision(snapshot, target), target, prior: { occupied: false }, proposed: clone(typed), impact: "creates-session-midi-clip", confirmation: "apply", expiresAt: Date.now() + SESSION_MIDI_TRANSACTION_TTL_MS };
    this.retain({ ...result, state: "previewed" });
    return clone(result);
  }

  private async getOrAbsent(adapter: AsyncLiveAdapter, reference: LiveRef, context?: LiveOperationContext): Promise<unknown> {
    const snapshot = await adapter.snapshotAsync(context);
    return snapshot.tracks.flatMap((track) => track.clips).find((clip) => clip.ref === reference);
  }

  private async compensateApplyAsync(record: SessionMidiRecord, adapter: AsyncLiveAdapter, context?: LiveOperationContext): Promise<void> {
    if (!record.clipRef && !record.compensationArgs) return; const clipRef = record.clipRef ?? record.compensationArgs?.ref as LiveRef;
    if (!record.compensationArgs) { const observed = await adapter.getAsync(clipRef, context) as { objectIdentity?: unknown; notesRevision?: unknown } | undefined; if (record.clipIdentity && observed?.objectIdentity !== record.clipIdentity) throw new Error("transaction-owned MIDI clip identity changed before compensation"); const observedFingerprint = fingerprint(observed); const exactCreationState = observedFingerprint === record.clipFingerprint; const exactWrittenState = typeof record.appliedNotesRevision === "string" && observed?.notesRevision === record.appliedNotesRevision && typeof record.clipBaseFingerprint === "string" && clipBaseFingerprint(observed) === record.clipBaseFingerprint; if (!exactCreationState && !exactWrittenState) throw new Error("transaction-owned MIDI clip changed before compensation"); record.compensationFingerprint = observedFingerprint; record.compensationArgs = { ref: clipRef, ...clipDeleteAuthority(await adapter.snapshotAsync(context), clipRef) }; }
    else { const observed = await this.getOrAbsent(adapter, clipRef, context); if (observed === undefined || observed === null) return; if (!record.compensationFingerprint || fingerprint(observed) !== record.compensationFingerprint) throw new Error("transaction-owned MIDI clip changed before compensation replay"); }
    await adapter.invokeAsync({ operation: "clip.delete", args: record.compensationArgs }, { signal: context?.signal, deadlineMs: context?.deadlineMs ?? Date.now() + 5_000, transactionId: record.transactionId, idempotencyKey: record.applyKey });
    const remaining = await this.getOrAbsent(adapter, clipRef, context); if (remaining !== undefined && remaining !== null) throw new Error("MIDI compensation deletion was not confirmed");
  }

  async applyAsync(transactionId: string, confirmation: unknown, idempotencyKey: string, context?: LiveOperationContext): Promise<unknown> {
    if (confirmation !== "apply") throw new Error("confirmation=apply is required");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) { if (existing.transactionId !== transactionId) throw new Error("idempotency key conflicts with another transaction"); return { ...clone(existing.result as object), idempotent: true }; }
    const record = this.records.get(transactionId);
    if (!record || (record.state === "previewed" && record.expiresAt <= Date.now())) throw new Error("MIDI preview expired; preview again");
    const reconciliation = record.state === "uncertain" && record.applyKey === idempotencyKey;
    if (record.state !== "previewed" && !reconciliation) throw new Error("MIDI transaction is no longer applicable");
    const adapter = this.asyncAdapter();
    if (reconciliation) await adapter.snapshotAsync(context);
    const status = this.require(["session.read", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.write"], ["clip.create", "clip.delete", "note.add-batch"]);
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; preview again");
    if (reconciliation && record.recoveryMode === "compensate") { try { await this.compensateApplyAsync(record, adapter, context); record.state = "undone"; return { transactionId, state: "compensated", residuals: [], idempotent: false }; } catch (cause) { record.state = "uncertain"; throw cause; } }
    record.state = "applying"; record.recoveryMode = "apply"; record.applyKey = idempotencyKey;
    let clipRef: LiveRef | undefined;
    try {
      const snapshot = await adapter.snapshotAsync(context);
      if (!reconciliation && revision(snapshot, targetAuthority(snapshot, record.target.trackRef, record.target.sceneIndex)) !== record.revision) throw new Error("Session target identity or slot state changed since preview");
      record.createArgs ??= { trackRef: record.target.trackRef, kind: "midi", name: record.proposed.name, sceneIndex: record.target.sceneIndex, length: record.proposed.length, expectedTrackIdentity: record.target.trackIdentity, expectedSlotRef: record.target.slotRef, expectedSlotIdentity: record.target.slotIdentity, expectedSceneRef: record.target.sceneRef, expectedSceneIdentity: record.target.sceneIdentity };
      const created = await adapter.invokeAsync({ operation: "clip.create", args: record.createArgs }, context) as { ref?: LiveRef; objectIdentity?: string; createdFingerprint?: string };
      if (!created?.ref || typeof created.objectIdentity !== "string" || typeof created.createdFingerprint !== "string") throw new Error("Live did not return the exact created clip identity and fingerprint");
      clipRef = created.ref; record.clipRef = clipRef; record.clipIdentity = created.objectIdentity; record.clipFingerprint = created.createdFingerprint;
      if (!record.noteArgs) { const creation = await adapter.getAsync(clipRef, context) as { notesRevision?: unknown }; if (fingerprint(creation) !== record.clipFingerprint) throw new Error("Live did not confirm the exact created clip fingerprint"); record.clipBaseFingerprint = clipBaseFingerprint(creation); if (record.proposed.notes.length === 0) { if (typeof creation.notesRevision !== "string" || !/^[a-f0-9]{64}$/.test(creation.notesRevision)) throw new Error("Live did not return the empty MIDI note revision"); record.appliedNotesRevision = creation.notesRevision; } }
      if (record.proposed.notes.length > 0) {
        if (!record.noteArgs) { const noteAuthority = noteMutationAuthority(await adapter.snapshotAsync(context), clipRef); record.noteArgs = { ref: clipRef, notes: record.proposed.notes, ...noteAuthority }; }
        const added = await adapter.invokeAsync({ operation: "note.add-batch", args: record.noteArgs }, context) as { added?: unknown; notesRevision?: unknown };
        if (typeof added.notesRevision !== "string" || !/^[a-f0-9]{64}$/.test(added.notesRevision)) throw new Error("Live did not return the fingerprinted MIDI note state");
        record.appliedNotesRevision = added.notesRevision;
        if (added.added !== record.proposed.notes.length) throw new Error("Live did not add the complete MIDI note batch");
      }
      const verified = await adapter.getAsync(clipRef, context) as { objectIdentity?: string; name?: string; length?: number; notes?: Note[]; notesRevision?: string } | undefined;
      if (!verified || verified.objectIdentity !== record.clipIdentity || verified.name !== record.proposed.name || verified.length !== record.proposed.length || verified.notesRevision !== record.appliedNotesRevision || !notesMatch(verified.notes ?? [], record.proposed.notes)) throw new Error("Live did not confirm exact MIDI clip contents");
      record.clipDeleteAuthority = clipDeleteAuthority(await adapter.snapshotAsync(context), clipRef);
      record.state = "applied"; record.clipRef = clipRef; record.appliedNotes = clone(verified.notes ?? []); record.applyKey = idempotencyKey;
      const result = { transactionId, state: "applied", clipRef, notes: record.appliedNotes, epoch: record.epoch, idempotent: false };
      this.idempotency.set(idempotencyKey, { transactionId, result: clone(result) });
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/uncertain|disconnect|timeout|cancellation/i.test(message)) { record.state = "uncertain"; record.recoveryMode = "apply"; throw cause; }
      if (clipRef) { try { record.clipRef = clipRef; record.recoveryMode = "compensate"; await this.compensateApplyAsync(record, adapter, context); record.state = "undone"; } catch { record.state = "uncertain"; record.recoveryMode = "compensate"; throw new Error("MIDI apply failed and compensation failed; retry the exact key to reconcile cleanup"); } }
      else record.state = "undone";
      throw cause;
    }
  }

  async undoAsync(transactionId: string, confirmation: unknown, idempotencyKey: string, context?: LiveOperationContext): Promise<unknown> {
    if (confirmation !== "undo") throw new Error("confirmation=undo is required");
    const record = this.records.get(transactionId);
    if (record?.state === "undone" && record.undoKey === idempotencyKey) return { transactionId, state: "undone", idempotent: true };
    const reconciliation = record?.state === "uncertain" && record.undoKey === idempotencyKey;
    if (!record || (!reconciliation && record.state !== "applied") || !record.clipRef) throw new Error("Only an applied or exact-key uncertain MIDI transaction can be undone");
    const adapter = this.asyncAdapter(); const status = this.require(["session.read", "session.midi_clip.delete"], ["clip.delete"]);
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; undo refused");
    record.state = "undoing"; record.undoKey = idempotencyKey;
    try {
      if (!reconciliation) {
        const clip = await adapter.getAsync(record.clipRef, context) as { objectIdentity?: string; name?: string; length?: number; notes?: Note[] } | undefined;
        if (!clip || clip.objectIdentity !== record.clipIdentity || clip.name !== record.proposed.name || clip.length !== record.proposed.length || JSON.stringify(clip.notes ?? []) !== JSON.stringify(record.appliedNotes ?? [])) throw new Error("MIDI clip identity or content changed after apply; undo refused");
        if (!record.clipDeleteAuthority) throw new Error("MIDI clip deletion authority is unavailable");
        record.undoArgs = { ref: record.clipRef, ...record.clipDeleteAuthority };
      }
      if (!record.undoArgs) throw new Error("MIDI clip deletion replay authority is unavailable");
      await adapter.invokeAsync({ operation: "clip.delete", args: record.undoArgs }, context);
      const remaining = await this.getOrAbsent(adapter, record.clipRef, context);
      if (remaining !== undefined && remaining !== null) throw new Error("MIDI clip deletion was not authoritatively confirmed");
      record.state = "undone";
      return { transactionId, state: "undone", deleted: record.clipRef, idempotent: false };
    } catch (cause) { record.state = "uncertain"; throw cause; }
  }

  preview(request: unknown): SessionMidiPreview {
    validateRequest(request);
    const status = this.require(["session.read", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.write"], ["clip.create", "clip.delete", "note.add-batch"]);
    const snapshot = this.adapter.snapshot();
    const track = snapshot.tracks.find((item) => item.ref === request.trackRef);
    if (!track || (track.kind !== "midi" && (track as unknown as { mediaKind?: string }).mediaKind !== "midi")) throw new Error("MIDI track not found");
    const clip = track.clips.find((item) => item.start === request.sceneIndex * 4);
    if (clip) throw new Error("Session slot is occupied");
    const target = targetAuthority(snapshot, request.trackRef, request.sceneIndex);
    const result: SessionMidiPreview = { transactionId: `midi_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: revision(snapshot, target), target, prior: { occupied: false }, proposed: clone(request), impact: "creates-session-midi-clip", confirmation: "apply", expiresAt: Date.now() + SESSION_MIDI_TRANSACTION_TTL_MS };
    this.retain({ ...result, state: "previewed" });
    return clone(result);
  }

  apply(transactionId: string, confirmation: unknown, idempotencyKey: string): unknown {
    if (confirmation !== "apply") throw new Error("confirmation=apply is required");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) { if (existing.transactionId !== transactionId) throw new Error("idempotency key conflicts with another transaction"); return { ...clone(existing.result as object), idempotent: true }; }
    const record = this.records.get(transactionId);
    if (!record || (record.state === "previewed" && record.expiresAt <= Date.now())) throw new Error("MIDI preview expired; preview again");
    if (record.state === "applied" && record.applyKey === idempotencyKey) return { transactionId, state: "applied", clipRef: record.clipRef, notes: record.appliedNotes, idempotent: true };
    if (record.state !== "previewed") throw new Error("MIDI transaction is no longer applicable");
    const status = this.require(["session.read", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.write"], ["clip.create", "clip.delete", "note.add-batch"]);
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; preview again");
    record.state = "applying"; record.applyKey = idempotencyKey;
    let clipRef: LiveRef | undefined;
    try {
      const snapshot = this.adapter.snapshot();
      if (revision(snapshot, targetAuthority(snapshot, record.target.trackRef, record.target.sceneIndex)) !== record.revision) throw new Error("Session target identity or slot state changed since preview");
      const created = this.adapter.invoke({ operation: "clip.create", args: { trackRef: record.target.trackRef, kind: "midi", name: record.proposed.name, sceneIndex: record.target.sceneIndex, length: record.proposed.length, expectedTrackIdentity: record.target.trackIdentity, expectedSlotRef: record.target.slotRef, expectedSlotIdentity: record.target.slotIdentity, expectedSceneRef: record.target.sceneRef, expectedSceneIdentity: record.target.sceneIdentity } }) as { ref?: LiveRef; objectIdentity?: string; createdFingerprint?: string };
      if (!created?.ref || typeof created.objectIdentity !== "string" || typeof created.createdFingerprint !== "string") throw new Error("Live did not return the exact created clip identity and fingerprint");
      clipRef = created.ref; record.clipIdentity = created.objectIdentity; record.clipFingerprint = created.createdFingerprint; if (fingerprint(this.adapter.get(clipRef)) !== record.clipFingerprint) throw new Error("Live did not confirm the exact created clip fingerprint");
      if (record.proposed.notes.length > 0) {
        const noteAuthority = noteMutationAuthority(this.adapter.snapshot(), clipRef);
        const added = this.adapter.invoke({ operation: "note.add-batch", args: { ref: clipRef, notes: record.proposed.notes, ...noteAuthority } }) as { added?: unknown };
        if (added.added !== record.proposed.notes.length) throw new Error("Live did not add the complete MIDI note batch");
      }
      const verified = this.adapter.get(clipRef) as { objectIdentity?: string; name?: string; length?: number; notes?: Note[] } | undefined;
      if (!verified || verified.objectIdentity !== record.clipIdentity || verified.name !== record.proposed.name || verified.length !== record.proposed.length || !notesMatch(verified.notes ?? [], record.proposed.notes)) throw new Error("Live did not confirm exact MIDI clip contents");
      record.clipDeleteAuthority = clipDeleteAuthority(this.adapter.snapshot(), clipRef);
      record.state = "applied"; record.clipRef = clipRef; record.appliedNotes = clone(verified.notes ?? []); record.applyKey = idempotencyKey;
      const result = { transactionId, state: "applied", clipRef, notes: record.appliedNotes, epoch: record.epoch, idempotent: false };
      this.idempotency.set(idempotencyKey, { transactionId, result: clone(result) });
      return result;
    } catch (cause) {
      if (clipRef) { try { const authority = record.clipDeleteAuthority ?? clipDeleteAuthority(this.adapter.snapshot(), clipRef); this.adapter.invoke({ operation: "clip.delete", args: { ref: clipRef, ...authority } }); } catch { record.state = "uncertain"; throw new Error("MIDI apply failed and compensation failed; read the target slot before retrying"); } }
      record.state = "previewed"; delete record.applyKey;
      throw cause;
    }
  }

  undo(transactionId: string, confirmation: unknown, idempotencyKey: string): unknown {
    if (confirmation !== "undo") throw new Error("confirmation=undo is required");
    const record = this.records.get(transactionId);
    if (record?.state === "undone" && record.undoKey === idempotencyKey) return { transactionId, state: "undone", idempotent: true };
    if (!record || record.state !== "applied" || !record.clipRef) throw new Error("Only an applied MIDI transaction can be undone");
    const status = this.require(["session.read", "session.midi_clip.delete"], ["clip.delete"]);
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; undo refused");
    record.state = "undoing"; record.undoKey = idempotencyKey;
    try {
      const clip = this.adapter.get(record.clipRef) as { objectIdentity?: string; name?: string; length?: number; notes?: Note[] } | undefined;
      if (!clip || clip.objectIdentity !== record.clipIdentity || clip.name !== record.proposed.name || clip.length !== record.proposed.length || JSON.stringify(clip.notes ?? []) !== JSON.stringify(record.appliedNotes ?? [])) throw new Error("MIDI clip identity or content changed after apply; undo refused");
      if (!record.clipDeleteAuthority) throw new Error("MIDI clip deletion authority is unavailable");
      this.adapter.invoke({ operation: "clip.delete", args: { ref: record.clipRef, ...record.clipDeleteAuthority } });
      record.state = "undone";
      return { transactionId, state: "undone", deleted: record.clipRef, idempotent: false };
    } catch (cause) { record.state = "uncertain"; throw cause; }
  }

  isFinalizable(transactionId: string): boolean { const record = this.records.get(transactionId); return !!record && ["uncertain", "applied", "undone"].includes(record.state); }

  finalize(transactionId: string): { transactionId: string; finalized: true; priorState: string } {
    const record = this.records.get(transactionId); if (!record || !["uncertain", "applied", "undone"].includes(record.state)) throw new Error("MIDI recovery record is not finalizable");
    const priorState = record.state; this.records.delete(transactionId); for (const [key, value] of this.idempotency) if (value.transactionId === transactionId) this.idempotency.delete(key);
    return { transactionId, finalized: true, priorState };
  }

  private require(capabilities: string[], operations: string[]): LiveStatus {
    const status = this.adapter.status();
    if (!status.connected || status.epoch === null) throw new Error("live-capability-unavailable:connection");
    for (const capability of capabilities) if (!status.capabilities.includes(capability as never)) throw new Error(`live-capability-unavailable:${capability}`);
    for (const operation of operations) if (!status.operations?.includes(operation)) throw new Error(`live-operation-unavailable:${operation}`);
    return status;
  }
}

export function discoverSession(adapter: LiveAdapter, kind: "track" | "scene" | "clip" | "note", limit: number, cursor?: string): { epoch: number; revision: string; items: unknown[]; nextCursor?: string; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be from 1 to 100");
  const status = adapter.status(); if (!status.connected || status.epoch === null || !status.capabilities.includes("session.read")) throw new Error("live-capability-unavailable:session.read");
  const snapshot = adapter.snapshot(); let items: unknown[];
  if (kind === "track") items = [...snapshot.tracks];
  else if (kind === "scene") items = [...snapshot.scenes];
  else if (kind === "clip") items = snapshot.tracks.flatMap((track) => track.clips) as unknown[];
  else items = snapshot.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.notes.map((note, index) => ({ ...note, ref: `note:${clip.ref}:${index}` }))));
  const offset = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0; if (!Number.isInteger(offset) || offset < 0 || offset > items.length) throw new Error("invalid cursor");
  const page = items.slice(offset, offset + limit); const next = offset + page.length < items.length ? Buffer.from(String(offset + page.length)).toString("base64url") : undefined;
  return { epoch: status.epoch, revision: `${status.epoch}:${items.length}`, items: clone(page as unknown[]), ...(next ? { nextCursor: next } : {}), truncated: next !== undefined };
}

export async function discoverSessionAsync(adapter: AsyncLiveAdapter, kind: "track" | "scene" | "clip" | "note", limit: number, cursor?: string): Promise<{ epoch: number; revision: string; items: unknown[]; nextCursor?: string; truncated: boolean }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be from 1 to 100");
  const status = adapter.status(); if (!status.connected || status.epoch === null || !status.capabilities.includes("session.read")) throw new Error("live-capability-unavailable:session.read");
  const snapshot = await adapter.snapshotAsync(); let items: unknown[];
  if (kind === "track") items = [...snapshot.tracks];
  else if (kind === "scene") items = [...snapshot.scenes];
  else if (kind === "clip") items = snapshot.tracks.flatMap((track) => track.clips);
  else items = snapshot.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.notes.map((note, index) => ({ ...note, ref: `note:${clip.ref}:${index}` }))));
  const offset = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > items.length) throw new Error("invalid cursor");
  const page = items.slice(offset, offset + limit); const next = offset + page.length < items.length ? Buffer.from(String(offset + page.length)).toString("base64url") : undefined;
  return { epoch: status.epoch, revision: `${status.epoch}:${items.length}`, items: clone(page), ...(next ? { nextCursor: next } : {}), truncated: next !== undefined };
}

/** Compare requested note content against authoritative notes enriched with
 * server-assigned fields (id and defaults), without relying on Live's ordering. */
function notesMatch(actual: Note[], proposed: Note[]): boolean {
  if (actual.length !== proposed.length) return false;
  const remaining = [...actual];
  for (const wanted of proposed) {
    const index = remaining.findIndex((found) => found.pitch === wanted.pitch
      && Math.abs(found.start - wanted.start) < 1e-6
      && Math.abs(found.duration - wanted.duration) < 1e-6
      && found.velocity === wanted.velocity
      && found.channel === wanted.channel
      && (wanted.mute == null || found.mute === wanted.mute)
      && (wanted.probability == null || (typeof found.probability === "number" && Math.abs(found.probability - wanted.probability) <= 0.01))
      && (wanted.velocityDeviation == null || (typeof found.velocityDeviation === "number" && Math.abs(found.velocityDeviation - wanted.velocityDeviation) <= 0.51))
      && (wanted.releaseVelocity == null || (typeof found.releaseVelocity === "number" && Math.abs(found.releaseVelocity - wanted.releaseVelocity) <= 0.51)));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}
