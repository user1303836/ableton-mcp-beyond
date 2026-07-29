# Project Motivation and Reference Implementations

## Why build another Ableton MCP?

The existing Ableton MCP ecosystem contains several strong ideas, but no single
implementation provides comprehensive, polished control across Ableton Live.
This project aims to become a one-stop, fully featured Ableton MCP: broad Live
control combined with thoughtful high-performance and audio-analysis tooling.

Cross-platform support is a core requirement. In particular, the implementation
must support Windows as well as macOS rather than depending on one tested Live or
operating-system version.

## References

### [`bschoepke/ableton-live-mcp`](https://github.com/bschoepke/ableton-live-mcp)

**Notable strength**

- Includes an agent audio-tap Max for Live device and spectrogram capabilities.

**Limitations motivating this project**

- The audio tap has proven difficult to get working reliably in practice.
- It was built against Ableton Live 12.3.8.
- It was tested only on macOS Tahoe, while Windows support is required here.

### [`uisato/ableton-mcp-extended`](https://github.com/uisato/ableton-mcp-extended)

**Notable strengths**

- Well-implemented custom features and an extensible framework.
- High-performance UDP server mode.
- XY mouse-controller tooling, including experimental functionality.

**Limitations motivating this project**

- Arrangement View support is incomplete.
- Its documented “advanced AI” functionality is missing or unfinished.
- It lacks the spectrogram and related audio-analysis capabilities found in
  `bschoepke/ableton-live-mcp`.
- More generally, it does not yet provide complete Ableton Live coverage.

### [`Simon-Kansara/ableton-live-mcp-server`](https://github.com/Simon-Kansara/ableton-live-mcp-server)

**Notable strength**

- OSC-native architecture, which is attractive for music-tool interoperability.

**Limitation motivating this project**

- Its control and tooling surface is otherwise comparatively limited.

### Other prior implementations

- [`jasper-zheng/ableton-sdk-mcp`](https://github.com/jasper-zheng/ableton-sdk-mcp)
- [`ahujasid/ableton-mcp`](https://github.com/ahujasid/ableton-mcp)

These are useful prior art, but appear either less actively updated or not
feature-complete enough for the goals of this project.

## Direction for this project

The project should combine and improve upon the best ideas in this prior art:

- Comprehensive control across Session View, Arrangement View, devices,
  tracks, clips, transport, automation, mixing, routing, and other exposed Live
  domains.
- Reliable audio tapping and useful analysis tools such as spectrograms.
- A high-performance path such as UDP where latency or command volume requires it.
- Thoughtful interactive controls such as XY input.
- An extensible framework for adding capabilities without redesigning the server.
- First-class Windows and macOS support.
- Compatibility tested against current Ableton Live releases rather than tied to
  one older build.
- Reliability and straightforward setup suitable for real-world creative work.

The references above are starting points for research, not specifications to
copy wholesale. Their strengths should inform the design while their reliability,
coverage, and portability gaps define the baseline this project must exceed.
