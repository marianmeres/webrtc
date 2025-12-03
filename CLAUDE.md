# CLAUDE.md

This file provides guidance for AI assistants working with the @marianmeres/webrtc codebase.

## Quick Reference

For comprehensive package documentation, see [llm.txt](llm.txt).

## Project Overview

A lightweight WebRTC manager with FSM-based lifecycle and event-driven architecture.

## Key Files

- `src/webrtc-manager.ts` - Main class (839 lines)
- `src/types.ts` - Type definitions
- `src/mod.ts` - Public exports

## Architecture

```
WebRtcManager uses:
- @marianmeres/fsm for state management
- @marianmeres/pubsub for events
- Dependency injection via WebRtcFactory interface
```

## States

IDLE → INITIALIZING → CONNECTING → CONNECTED → DISCONNECTED → IDLE
                                      ↓
                                    ERROR → IDLE (via reset)

## Common Tasks

### Running Tests
```bash
deno task test           # Unit tests
deno task test:browser   # Browser tests
```

### Building
```bash
deno task npm:build      # Build for npm
```

### Key APIs
- `initialize()` / `connect()` / `disconnect()` / `reset()` - Lifecycle
- `createOffer()` / `createAnswer()` / `setLocalDescription()` / `setRemoteDescription()` - Signaling
- `createDataChannel()` / `sendData()` - Data channels
- `on()` / `subscribe()` - Events

## Important Notes

1. Signaling transport is NOT included - users implement their own
2. `subscribe()` is Svelte store compatible
3. Auto-reconnect uses ICE restart first, then full reconnection
4. Private fields use `#` syntax (ES2022 true private)

## Code Style

- Deno with TypeScript
- Tabs, 90 char line width
- JSDoc comments on public methods
