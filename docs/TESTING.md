# Testing guide

## Local gates

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
cd ../..
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

Node tests compile into `dist/` and exercise MCP lifecycle, stdio framing,
remote response validation, delivery, async adapter paths, transactions,
analysis, properties, and package installation. Python tests exercise the
dependency-free bridge, canonical authentication, sequence/replay rejection,
main-thread queue, fake-Live mapper, locator/MIDI behavior, and cleanup.

## What passing means

Passing proves deterministic repository behavior and package contracts. It does
not prove a real Control Surface loaded in Ableton Live, a real Live API shape,
audible or realtime behavior, platform installer runtime, accessibility,
hardware, signing, or notarization.

## Change discipline

Add both success and fail-closed tests for new capabilities. Keep analysis
fixtures bounded and privacy-preserving. Test epoch changes, stale references,
timeouts, disconnects, lost acknowledgements, partial mutation, compensation,
and guarded undo. Do not use the protected SDK directory as a copied fixture or
package input.
