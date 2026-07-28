import { randomBytes } from "node:crypto";
import type { AsyncLiveAdapter, LiveAdapter, LiveRef, LiveSnapshot, Note, LiveStatus } from "../live.js";

export const SESSION_MIDI_TRANSACTION_TTL_MS = 30_000;
export const MAX_SESSION_MIDI_NOTES = 512;

export interface SessionMidiRequest { trackRef: LiveRef; sceneIndex: number; name: string; length: number; notes: Note[]; }
export interface SessionMidiPreview { transactionId: string; epoch: number; revision: string; target: { trackRef: LiveRef; sceneIndex: number; }; prior: { occupied: boolean; clipRef?: LiveRef }; proposed: SessionMidiRequest; impact: "creates-session-midi-clip"; confirmation: "apply"; expiresAt: number; }
export interface SessionMidiRecord extends SessionMidiPreview { state: "previewed" | "applied" | "undone" | "uncertain"; clipRef?: LiveRef; appliedNotes?: Note[]; applyKey?: string; undoKey?: string; }

function clone<T>(value: T): T { return structuredClone(value); }
function revision(snapshot: LiveSnapshot, trackRef: LiveRef, sceneIndex: number): string {
  const track = snapshot.tracks.find((item) => item.ref === trackRef);
  const clip = track?.clips.find((item) => item.start === sceneIndex * 4);
  return `${trackRef}:${sceneIndex}:${clip?.ref ?? "empty"}:${clip?.name ?? ""}:${clip?.notes.length ?? 0}`;
}
function validateNote(note: Note, length: number): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127 || !Number.isInteger(note.channel) || note.channel < 1 || note.channel > 16 || !Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0 || note.start + note.duration > length) throw new Error("invalid MIDI note");
}
function validateRequest(value: unknown): asserts value is SessionMidiRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid MIDI clip request");
  const request = value as Partial<SessionMidiRequest>;
  const sceneIndex = request.sceneIndex;
  if (typeof request.trackRef !== "string" || !Number.isInteger(sceneIndex) || (sceneIndex as number) < 0 || (sceneIndex as number) > 1023 || typeof request.name !== "string" || request.name.length < 1 || request.name.length > 256 || typeof request.length !== "number" || !Number.isFinite(request.length) || request.length <= 0 || request.length > 1024 || !Array.isArray(request.notes) || request.notes.length > MAX_SESSION_MIDI_NOTES) throw new Error("invalid MIDI clip request");
  request.notes.forEach((note) => validateNote(note, request.length as number));
}

export class SessionMidiTransactionManager {
  private readonly records = new Map<string, SessionMidiRecord>();
  private readonly idempotency = new Map<string, { transactionId: string; result: unknown }>();
  constructor(private readonly adapter: LiveAdapter) {}

  private asyncAdapter(): AsyncLiveAdapter {
    const value = this.adapter as Partial<AsyncLiveAdapter>;
    if (typeof value.snapshotAsync !== "function" || typeof value.getAsync !== "function" || typeof value.invokeAsync !== "function") throw new Error("live adapter does not support asynchronous operations");
    return this.adapter as AsyncLiveAdapter;
  }

  async previewAsync(request: unknown): Promise<SessionMidiPreview> {
    validateRequest(request);
    const adapter = this.asyncAdapter();
    const status = this.require("session.read");
    const snapshot = await adapter.snapshotAsync();
    const track = snapshot.tracks.find((item) => item.ref === (request as SessionMidiRequest).trackRef);
    if (!track || (track.kind !== "midi" && (track as unknown as { mediaKind?: string }).mediaKind !== "midi")) throw new Error("MIDI track not found");
    const typed = request as SessionMidiRequest;
    const clip = track.clips.find((item) => item.start === typed.sceneIndex * 4);
    if (clip) throw new Error("Session slot is occupied");
    const result: SessionMidiPreview = { transactionId: `midi_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: revision(snapshot, typed.trackRef, typed.sceneIndex), target: { trackRef: typed.trackRef, sceneIndex: typed.sceneIndex }, prior: { occupied: false }, proposed: clone(typed), impact: "creates-session-midi-clip", confirmation: "apply", expiresAt: Date.now() + SESSION_MIDI_TRANSACTION_TTL_MS };
    this.records.set(result.transactionId, { ...result, state: "previewed" });
    return clone(result);
  }

  async applyAsync(transactionId: string, confirmation: unknown, idempotencyKey: string): Promise<unknown> {
    if (confirmation !== "apply") throw new Error("confirmation=apply is required");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) { if (existing.transactionId !== transactionId) throw new Error("idempotency key conflicts with another transaction"); return { ...clone(existing.result as object), idempotent: true }; }
    const record = this.records.get(transactionId);
    if (!record || record.expiresAt <= Date.now()) throw new Error("MIDI preview expired; preview again");
    if (record.state !== "previewed") throw new Error("MIDI transaction is no longer applicable");
    const adapter = this.asyncAdapter();
    const status = this.require("session.write");
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; preview again");
    const snapshot = await adapter.snapshotAsync();
    if (revision(snapshot, record.target.trackRef, record.target.sceneIndex) !== record.revision) throw new Error("Session slot changed since preview");
    let clipRef: LiveRef | undefined;
    try {
      const created = await adapter.invokeAsync({ operation: "clip.create", args: { trackRef: record.target.trackRef, kind: "midi", name: record.proposed.name, sceneIndex: record.target.sceneIndex, length: record.proposed.length } }) as { ref?: LiveRef };
      if (!created?.ref) throw new Error("Live did not return the created clip reference");
      clipRef = created.ref;
      for (const note of record.proposed.notes) await adapter.invokeAsync({ operation: "note.add", args: { ref: clipRef, note } });
      const verified = await adapter.getAsync(clipRef) as { name?: string; length?: number; notes?: Note[] } | undefined;
      if (!verified || verified.name !== record.proposed.name || verified.length !== record.proposed.length || !notesMatch(verified.notes ?? [], record.proposed.notes)) throw new Error("Live did not confirm MIDI clip contents");
      record.state = "applied"; record.clipRef = clipRef; record.appliedNotes = clone(verified.notes ?? []); record.applyKey = idempotencyKey;
      const result = { transactionId, state: "applied", clipRef, notes: record.appliedNotes, epoch: record.epoch, idempotent: false };
      this.idempotency.set(idempotencyKey, { transactionId, result: clone(result) });
      return result;
    } catch (cause) {
      if (clipRef) { try { await adapter.invokeAsync({ operation: "clip.delete", args: { ref: clipRef } }); } catch { record.state = "uncertain"; throw new Error("MIDI apply failed and compensation failed; read the target slot before retrying"); } }
      throw cause;
    }
  }

  async undoAsync(transactionId: string, confirmation: unknown, idempotencyKey: string): Promise<unknown> {
    if (confirmation !== "undo") throw new Error("confirmation=undo is required");
    const record = this.records.get(transactionId);
    if (record?.state === "undone" && record.undoKey === idempotencyKey) return { transactionId, state: "undone", idempotent: true };
    if (!record || record.state !== "applied" || !record.clipRef) throw new Error("Only an applied MIDI transaction can be undone");
    const adapter = this.asyncAdapter(); const status = this.require("session.write");
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; undo refused");
    const clip = await adapter.getAsync(record.clipRef) as { name?: string; length?: number; notes?: Note[] } | undefined;
    if (!clip || clip.name !== record.proposed.name || clip.length !== record.proposed.length || JSON.stringify(clip.notes ?? []) !== JSON.stringify(record.appliedNotes ?? [])) throw new Error("MIDI clip changed after apply; undo refused");
    await adapter.invokeAsync({ operation: "clip.delete", args: { ref: record.clipRef } });
    record.state = "undone"; record.undoKey = idempotencyKey;
    return { transactionId, state: "undone", deleted: record.clipRef, idempotent: false };
  }

  preview(request: unknown): SessionMidiPreview {
    validateRequest(request);
    const status = this.require("session.read");
    const snapshot = this.adapter.snapshot();
    const track = snapshot.tracks.find((item) => item.ref === request.trackRef);
    if (!track || (track.kind !== "midi" && (track as unknown as { mediaKind?: string }).mediaKind !== "midi")) throw new Error("MIDI track not found");
    const clip = track.clips.find((item) => item.start === request.sceneIndex * 4);
    if (clip) throw new Error("Session slot is occupied");
    const result: SessionMidiPreview = { transactionId: `midi_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: revision(snapshot, request.trackRef, request.sceneIndex), target: { trackRef: request.trackRef, sceneIndex: request.sceneIndex }, prior: { occupied: false }, proposed: clone(request), impact: "creates-session-midi-clip", confirmation: "apply", expiresAt: Date.now() + SESSION_MIDI_TRANSACTION_TTL_MS };
    this.records.set(result.transactionId, { ...result, state: "previewed" });
    return clone(result);
  }

  apply(transactionId: string, confirmation: unknown, idempotencyKey: string): unknown {
    if (confirmation !== "apply") throw new Error("confirmation=apply is required");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) { if (existing.transactionId !== transactionId) throw new Error("idempotency key conflicts with another transaction"); return { ...clone(existing.result as object), idempotent: true }; }
    const record = this.records.get(transactionId);
    if (!record || record.expiresAt <= Date.now()) throw new Error("MIDI preview expired; preview again");
    if (record.state === "applied" && record.applyKey === idempotencyKey) return { transactionId, state: "applied", clipRef: record.clipRef, notes: record.appliedNotes, idempotent: true };
    if (record.state !== "previewed") throw new Error("MIDI transaction is no longer applicable");
    const status = this.require("session.write");
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; preview again");
    const snapshot = this.adapter.snapshot();
    if (revision(snapshot, record.target.trackRef, record.target.sceneIndex) !== record.revision) throw new Error("Session slot changed since preview");
    let clipRef: LiveRef | undefined;
    try {
      const created = this.adapter.invoke({ operation: "clip.create", args: { trackRef: record.target.trackRef, kind: "midi", name: record.proposed.name, sceneIndex: record.target.sceneIndex, length: record.proposed.length } }) as { ref?: LiveRef };
      if (!created?.ref) throw new Error("Live did not return the created clip reference");
      clipRef = created.ref;
      for (const note of record.proposed.notes) this.adapter.invoke({ operation: "note.add", args: { ref: clipRef, note } });
      const verified = this.adapter.get(clipRef) as { name?: string; length?: number; notes?: Note[] } | undefined;
      if (!verified || verified.name !== record.proposed.name || verified.length !== record.proposed.length || !notesMatch(verified.notes ?? [], record.proposed.notes)) throw new Error("Live did not confirm MIDI clip contents");
      record.state = "applied"; record.clipRef = clipRef; record.appliedNotes = clone(verified.notes ?? []); record.applyKey = idempotencyKey;
      const result = { transactionId, state: "applied", clipRef, notes: record.appliedNotes, epoch: record.epoch, idempotent: false };
      this.idempotency.set(idempotencyKey, { transactionId, result: clone(result) });
      return result;
    } catch (cause) {
      if (clipRef) { try { this.adapter.invoke({ operation: "clip.delete", args: { ref: clipRef } }); } catch { record.state = "uncertain"; throw new Error("MIDI apply failed and compensation failed; read the target slot before retrying"); } }
      throw cause;
    }
  }

  undo(transactionId: string, confirmation: unknown, idempotencyKey: string): unknown {
    if (confirmation !== "undo") throw new Error("confirmation=undo is required");
    const record = this.records.get(transactionId);
    if (record?.state === "undone" && record.undoKey === idempotencyKey) return { transactionId, state: "undone", idempotent: true };
    if (!record || record.state !== "applied" || !record.clipRef) throw new Error("Only an applied MIDI transaction can be undone");
    const status = this.require("session.write");
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; undo refused");
    const clip = this.adapter.get(record.clipRef) as { name?: string; length?: number; notes?: Note[] } | undefined;
    if (!clip || clip.name !== record.proposed.name || clip.length !== record.proposed.length || JSON.stringify(clip.notes ?? []) !== JSON.stringify(record.appliedNotes ?? [])) throw new Error("MIDI clip changed after apply; undo refused");
    this.adapter.invoke({ operation: "clip.delete", args: { ref: record.clipRef } });
    record.state = "undone"; record.undoKey = idempotencyKey;
    return { transactionId, state: "undone", deleted: record.clipRef, idempotent: false };
  }

  private require(capability: "session.read" | "session.write"): LiveStatus { const status = this.adapter.status(); if (!status.connected || status.epoch === null || !status.capabilities.includes(capability)) throw new Error(`live-capability-unavailable:${capability}`); return status; }
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
 * server-assigned fields (id, mute, probability, deviations, release). */
function notesMatch(actual: Note[], proposed: Note[]): boolean {
  if (actual.length !== proposed.length) return false;
  return proposed.every((wanted, index) => {
    const found = actual[index]!;
    return found.pitch === wanted.pitch && found.start === wanted.start && found.duration === wanted.duration && found.velocity === wanted.velocity && found.channel === wanted.channel;
  });
}
