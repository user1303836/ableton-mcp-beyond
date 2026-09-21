# Extension surfaces: evaluation and dispositions

English · [简体中文](../zh-CN/EXTENSION_SURFACES.md) · [日本語](../ja/EXTENSION_SURFACES.md)

The Ableton surfaces that are not ordinary Remote Script members, and the
Live UI features the stable public LOM does not expose. Each item has an
explicit disposition: implemented elsewhere, feasible with a recorded design,
deferred with a recorded reason, or declined. None of these are bridge
defects; they are capability tiers with different authority requirements.

## Model-independent execution and verification toolkit

MCP remains a supported adapter, not a model dependency. The existing protocol
boundary, typed Live discovery, transactions and verification provide the
foundation; this is not a claim that a separate general-purpose executor SDK
or compact task API has shipped.

- **Observe:** return bounded structured state, negotiated capabilities,
  deployment policy and current references/identities/revisions. Compact,
  task-oriented discovery remains follow-up work in #55, not a larger raw tool list.
- **Select:** keep planning/inference in an optional client or harness. An LLM,
  human or structured selector proposes a permitted operation and target;
  deterministic validation must still check compatibility and fresh authority.
  Jev is a candidate for typed choices, **not screenshot interpretation**.
  Valid types, probabilities, model confidence and MCP client metadata prove
  neither semantic correctness nor consent. No Ableton-specific Jev latency,
  calibration or success rate has been measured here.
- **Execute:** preserve authenticated transport, policy, exact identities and
  revisions, preview, explicit approval, expiry and idempotency for every
  interface. Approval must come from the deployment's trusted client/operator
  boundary; a server boolean alone is not independent proof of human consent.
  Batches are sequential with guarded compensation, not atomic commits.
- **Verify/recover:** independently check postconditions and ownership. Lost
  acknowledgements require exact execution-ledger reconciliation; matching
  values alone are insufficient. Preserve uncertainty and owned recovery, not
  an automatic retry after cancellation or restart. Fresh audio measurements
  establish technical facts, not musical quality.

Jev context: [TypeSafe introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[typed decisions](https://docs.typesafe.ai/),
[confidence](https://docs.typesafe.ai/confidence). Vendor performance claims are
not project evidence. Hosted inference is optional, requires explicit data
sharing, and is not an audio-thread/sample-accurate controller.

## Guarded GUI pilot (design only, not implemented)

Keep deterministic API execution for exact MIDI, routing and parameters. A
first GUI experiment should fill one valuable gap: export an explicitly
selected range to a **new, approved WAV path**, then inspect the actual file.
Do not introduce an unrestricted click/type/shell tool or promise broad
plug-in, comp-editing, freeze/flatten or Save As automation.

The pilot must share the API's approval/policy and execution boundary, bind the
Live app/window and Set identity, serialize cooperating writers, and detect
human/controller interference. This is not exclusive control of the desktop.
Prefer measured accessibility support; re-observe after focus/layout/dialog
changes, stop on unknown dialogs, retain emergency stop, and never auto-retry
an uncertain file write. Verify file identity, format and duration plus relevant
LOM state; a model's DONE response or file existence alone is insufficient.
Treat screen/file/track text as untrusted data and minimize remote exposure.

An **independent unrestricted desktop agent can bypass MCP safeguards**. The
backend's safety claims do not cover that arrangement. A GUI design must not
silently inherit those claims or turn a model's confidence into authority.
Retained real-time bounce (#52) is a separate routing/recording/file-ownership
workflow; today's analysis capture deletes its temporary audio and is not a
retained bounce or offline export.

Evaluate MCP-only, GUI-only and hybrid execution on shared producer tasks with
matched planners, budgets, starting Sets and success predicates; report added
capability coverage separately. Repeat runs and measure verified completion,
unintended changes, p50/p95 latency, actual model cost, approvals/rescues, stale
state, lost replies, focus/dialog interruptions and recovery. Keep selector
comparisons on the same executor/action space. Report human musical-quality
preference separately. No such model or GUI evaluation is certified today.

## Public Ableton Extensions research (deferred)

The [public announcement](https://www.ableton.com/en/blog/introducing-extensions-sdk/)
and [public documentation](https://ableton.github.io/extensions-sdk/) justify a
bounded API-gap study, not a backend replacement. As assessed September 21,
2026, the described Suite-beta, one-shot context-menu workflow does not prove
persistent MCP transport, Standard/Intro/Lite support, full LOM parity or
export/comp APIs. Recheck public version/edition limits before implementation.
Keep the Remote Script backend and the protected local
`extensions-sdk-1.0.0-beta.0` exclusion: do not open, copy or cite that material.
No SDK integration or GUI implementation is part of this maintenance work.

Priorities: use the shipped batch foundation; improve task discovery (#55) and
guided onboarding (#66); validate one guarded export pilot; then evaluate
retained bounce/audio feedback (#52). Simulator, packaged fake-Live and host
CI evidence remain distinct from exact-candidate real-Live, third-party-client,
GUI, model and listening validation. See [DELIVERY.md](DELIVERY.md) and
[TESTING.md](TESTING.md).

## Max for Live

The shipped Remote Script coverage is recorded in
[CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md); this is not a claim of exhaustive
coverage of every current or beta Live API. The remaining Max-only surfaces
and their dispositions:

| Surface | Disposition |
|---|---|
| `live.path`, `live.object`, `live.observer` inside a companion `.amxd` | Feasible, deferred. Design: a versioned companion device that speaks the existing bounded `max`-label packet contract over the authenticated realtime channel (token/TTL/generation fences), adding no second authority plane. Ship only when a surface genuinely unavailable to the Remote Script is required — today none is |
| `live.remote~` (signal-rate parameter control) | Deferred. The current 64-packet/s UDP channel is deliberately not equivalent; signal-rate control is not a product requirement today. If adopted: dedicated companion device with explicit operator authority and latency measurement, never presented as the existing channel |
| `live.modulate~` (additive modulation) | Deferred with the same design; additive modulation never replaces base parameter values |
| `live.map` (operator-driven mappings) | Deferred. Mapping is an operator UI workflow; candidates are generated by discovery rows and applied through the parameter transaction when a design ships |
| `live.banks` / MaxDevice bank APIs | Implemented where public: Max device audio/MIDI I/O descriptors and parameter banks are exposed on device rows (P1.11/P1.13) |
| `live.routing` (Max-device routing UI) | Feasible via the companion design above; currently unneeded because track/chain/device routing is typed through the Remote Script |
| `live.push` (Push pad layout/color) | Deferred. See the Push section below |
| `live.miditool.in` / `live.miditool.out` (MIDI Generator/Transformation tools) | Deferred. Native MIDI tool development belongs to the companion design, not the Remote Script; no claim is made today |
| `live.thisdevice`, `live.param~`, DSP and device lifecycle | Explicitly distinct from the MCP Remote Script and out of its scope permanently |

The truthful `ableton://max-extension` resource remains the versioned
packet-level extension point. Runtime advertises OSC/realtime, never a `max`
capability: no bundled `.amxd`, handshake, or arbitrary packet authority is
claimed.

## Ableton Link and Link Audio

| Surface | Disposition |
|---|---|
| LOM Link controls | Implemented: `is_ableton_link_enabled`, `is_ableton_link_start_stop_sync_enabled`, and `force_link_beat_time` with explicit timing and audible-authority fencing (P1.6) |
| External Link SDK peer (beat, tempo, phase, quantum, start/stop, peer discovery) | Deferred, design recorded. An external Link peer is a separate process with its own network authority: it must be an explicit operator choice with its own discovery, latency, and privacy review, not something the loopback bridge silently becomes. Tracked as a separate feasibility/design issue |
| Link Audio send/receive | Deferred. Requires the same external-peer design plus audio privacy and routing analysis; track routing to a Link Audio peer must be typed and operator-authorized like any other routing change |

## Push and hardware control surfaces

| Surface | Disposition |
|---|---|
| Official Push 2 hardware interface | Deferred. It is a separate hardware surface from Live's ControlSurface LOM; no support is claimed from generic MIDI note transmission |
| ControlSurface MIDI/SysEx grabbing, feedback, parameter banks, custom modes | Deferred. The bridge is a Control Surface but deliberately uses only the documented LOM; grabbing raw MIDI streams for hardware feedback would duplicate Live's own control-surface layer and is out of scope today |

## Connection Kit-style integrations (OSC/JSON/web/serial/Arduino)

Declined as out of product scope for now. The current boundary is a
loopback-only, primarily inbound, short-lived realtime authorization plane.
General outbound/inbound OSC, web APIs, serial, and sensor integrations would
each be separate authority planes with their own review; they are not
silently added. This decision is revisited only with an explicit product
requirement.

## Live UI features not exposed by the stable public LOM

Each has an explicit disposition. None are bridge defects; where Ableton
supplies no stable public API, the reserved protocol operation fails closed
and reports the actual limitation.

| Feature | Disposition |
|---|---|
| Arrangement automation envelope/point authoring | Unsupported today. `arrangement.automation.*` stays reserved and fail-closed; Session clip envelopes are implemented |
| Full comp-region selection and comp editing | Unsupported by the public LOM; existing take-lane discovery/rename and file-backed audio import are exposed, while mapper-only lane creation/MIDI lane-clip paths are not advertised by the public MCP schemas |
| Take-lane deletion/audition/comp semantics | Unsupported by the public LOM; no public MCP capability is claimed for them |
| Freeze and flatten | No public API; no UI automation |
| Offline bounce, stems, export audio/video, render status | No public Remote Script API; `project.bounce/export/collect` stay reserved and fail-closed |
| Project new/open/save/save-as/close and Collect All and Save | No public API; the capability resource reports these limitations and no callable placeholder tools exist |
| Stem separation | No public API |
| Full Arrangement split/consolidate/cut/copy/paste-time | No public API |
| Follow Action authoring | Not exposed by the Live API |
| Crossfade/fade-curve editing | No public API |
| Full MPE per-note expression document editing | No authoritative API; never claimed (probability/velocity/deviation/release-velocity/mute remain the negotiated note fields) |
| RoarDevice, ShifterDevice, SpectralResonatorDevice, WavetableDevice semantic surfaces | Deferred, not claimed. Generic DeviceParameter control remains available; a specialized family ships only with exact captured Live shapes |
| Sample surface (slice/warp/sample metadata beyond clip rows) | Deferred, not claimed |
| Remaining Simpler surface (envelopes, filter, LFO, playback modes) | Deferred, not claimed; capability-gated `Simpler.replace_sample` is the only shipped Simpler semantic |
| Browser tags, similarity search, Pack install/update, Cloud/Splice management | No public API; `live_browser_search` is explicitly a bounded name match, and `live_browser_roots` reports binding tiers instead of pretending these exist |
| Preferences, audio driver/buffer configuration, MIDI-port preferences | No public API; application-level configuration stays operator-owned |
| Licensing/account/authorization | Out of scope permanently |
| Arbitrary plug-in opaque state or GUI controls beyond exposed parameters, presets, and editor visibility | No public API; plug-in parameters, presets, and `is_editor_open` are the typed boundary |
| Video track import/export control | No public API |
| Stable object identifiers across Set loads | The bridge binds identity to the live session via epochs; cross-load persistence is not claimed |
| Arbitrary raw track audio through the LOM | No public API; an authorized Max device or Link Audio is the documented alternative if ever required, and the consent-bound Session Resampling capture remains the only capture path today |
