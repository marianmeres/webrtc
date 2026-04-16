# AGENTS.md - Machine-Readable Package Documentation

## Package Metadata

```yaml
name: "@marianmeres/webrtc"
version: "2.0.0"
license: MIT
author: Marian Meres
repository: https://github.com/marianmeres/webrtc
runtime: Deno (source), Node.js/Browser (distribution)
type: WebRTC connection management library
```

## Purpose

A lightweight, framework-agnostic WebRTC manager providing:
- FSM-based connection lifecycle management
- Event-driven architecture with PubSub pattern
- Svelte store compatibility
- Audio device management (microphone switching)
- Data channel support
- Auto-reconnection with exponential backoff
- Full TypeScript type safety

## Dependencies

```yaml
production:
  - "@marianmeres/clog": "^3.15.2"
  - "@marianmeres/fsm": "^2.16.4"
  - "@marianmeres/pubsub": "^2.4.6"
development:
  - "@std/assert": "^1.0.18"
  - "@std/fs": "^1.0.22"
  - "@std/path": "^1.1.4"
```

## File Structure

```
src/
  mod.ts              # Entry point, re-exports all public APIs
  types.ts            # Type definitions (interfaces, enums)
  webrtc-manager.ts   # Main WebRTCManager class

tests/
  mocks.ts                    # Mock WebRTCFactory for testing
  webrtc-manager.test.ts      # Deno unit tests
  browser/
    p2p-tests.ts              # Browser integration tests

example/
  peer.ts             # Two-peer example with localStorage signaling
  p2p.ts              # Single-page P2P example
  audio-peer.ts       # Audio testing implementation
  main.ts             # Signaling server example

scripts/
  build-npm.ts        # npm distribution build
  build-example.ts    # Example bundling
  build-browser-tests.ts
  serve-browser-tests.ts
  signaling-server.ts
```

## State Machine

### States (WebRTCState)

| State | Description | Valid Outgoing Transitions |
|-------|-------------|---------------------------|
| IDLE | Initial state, no resources allocated | INITIALIZING |
| INITIALIZING | Creating peer connection and setting up | CONNECTING, ERROR |
| CONNECTING | Performing SDP offer/answer exchange | CONNECTED, DISCONNECTED, ERROR |
| CONNECTED | Connection established, communication active | DISCONNECTED, ERROR |
| RECONNECTING | Auto-reconnection in progress | CONNECTING, DISCONNECTED, IDLE |
| DISCONNECTED | Connection closed, resources may be cleaned up | CONNECTING, RECONNECTING, IDLE |
| ERROR | Error state, requires reset() to recover | IDLE |

### Events (WebRTCFsmEvent)

| Event | Value | Description |
|-------|-------|-------------|
| INIT | "initialize" | Start initialization |
| CONNECT | "connect" | Begin connection |
| CONNECTED | "connected" | Connection succeeded |
| RECONNECTING | "reconnecting" | Start reconnection |
| DISCONNECT | "disconnect" | Close connection |
| ERROR | "error" | Error occurred |
| RESET | "reset" | Return to IDLE |

### Transition Matrix

```
IDLE          --INIT-->        INITIALIZING
IDLE          --RESET-->       IDLE            (2.0)
INITIALIZING  --CONNECT-->     CONNECTING
INITIALIZING  --DISCONNECT-->  DISCONNECTED    (2.0, was silent no-op)
INITIALIZING  --ERROR-->       ERROR
INITIALIZING  --RESET-->       IDLE            (2.0, was silent no-op)
CONNECTING    --CONNECTED-->   CONNECTED
CONNECTING    --DISCONNECT-->  DISCONNECTED
CONNECTING    --ERROR-->       ERROR
CONNECTING    --RESET-->       IDLE            (2.0, was silent no-op)
CONNECTED     --DISCONNECT-->  DISCONNECTED
CONNECTED     --ERROR-->       ERROR
CONNECTED     --RESET-->       IDLE            (2.0, was silent no-op)
RECONNECTING  --CONNECT-->     CONNECTING
RECONNECTING  --CONNECTED-->   CONNECTED       (2.0, fixes ICE-restart stuck-state bug)
RECONNECTING  --DISCONNECT-->  DISCONNECTED
RECONNECTING  --ERROR-->       ERROR           (2.0)
RECONNECTING  --RESET-->       IDLE
DISCONNECTED  --CONNECT-->     CONNECTING
DISCONNECTED  --RECONNECTING-->RECONNECTING
DISCONNECTED  --RESET-->       IDLE
ERROR         --RESET-->       IDLE
```

## Public API Reference

### Constructor

```typescript
new WebRTCManager<TContext = unknown>(factory: WebRTCFactory, config?: WebRTCManagerConfig)
```

**Type Parameter:** `TContext` - Optional type for the `context` property (default: `unknown`)

### Logger Interface

Console-compatible logger interface for custom logging implementations.

```typescript
interface Logger {
  debug: (...args: any[]) => any;
  log: (...args: any[]) => any;
  warn: (...args: any[]) => any;
  error: (...args: any[]) => any;
}
```

Each method returns a string representation of the first argument, enabling patterns like `throw new Error(logger.error("msg"))`.

### WebRTCFactory Interface

```typescript
interface WebRTCFactory {
  createPeerConnection(config?: RTCConfiguration): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}
```

### WebRTCManagerConfig Interface

```typescript
interface WebRTCManagerConfig {
  peerConfig?: RTCConfiguration;      // ICE servers, certificates
  enableMicrophone?: boolean;         // Default: false
  audioDirection?: RTCRtpTransceiverDirection; // Default: "recvonly" (2.0)
                                       // Direction for the audio transceiver added
                                       // when enableMicrophone is false. Use "sendrecv"
                                       // to avoid renegotiation when enabling mic later.
  dataChannelLabel?: string;          // Auto-create data channel
  autoReconnect?: boolean;            // Default: false
  maxReconnectAttempts?: number;      // Default: 5
  reconnectDelay?: number;            // Default: 1000ms
  fullReconnectTimeout?: number;      // Timeout for full reconnect strategy (default: 30000ms)
  shouldReconnect?: (context: {       // Callback to control reconnection
    attempt: number;
    maxAttempts: number;
    strategy: "ice-restart" | "full";
  }) => boolean;
  logger?: Logger;                    // Custom logger, falls back to console
}
```

### GatherIceCandidatesOptions Interface

```typescript
interface GatherIceCandidatesOptions {
  timeout?: number;                                    // Timeout in ms (default: 10000)
  onCandidate?: (candidate: RTCIceCandidate) => void;  // Called for each REAL candidate
                                                        // (2.0: null sentinel no longer forwarded)
  resolveOnTimeout?: boolean;                          // (2.0) Resolve instead of reject on timeout
}
```

### Properties (Getters)

| Property | Type | Description |
|----------|------|-------------|
| state | WebRTCState | Current FSM state |
| localStream | MediaStream \| null | Local audio stream |
| remoteStream | MediaStream \| null | First remote stream received (legacy single-stream accessor) |
| remoteStreams | ReadonlyMap<string, MediaStream> | (2.0) All remote streams keyed by `stream.id` |
| dataChannels | ReadonlyMap<string, RTCDataChannel> | Active data channels |
| peerConnection | RTCPeerConnection \| null | Underlying connection |
| context | TContext \| null | User-defined context for arbitrary data |

### Lifecycle Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| initialize | `(): Promise<void>` | Create peer connection, setup tracks |
| connect | `(): Promise<void>` | Transition to CONNECTING (auto-initializes if IDLE). (2.0) Resets `#reconnectAttempts` so a prior exhausted reconnect budget does not block new attempts. |
| disconnect | `(): void` | Close connection, cleanup resources. (2.0) Also resets `#reconnectAttempts` and publishes `local_stream:null` / `remote_stream:null`. |
| reset | `(): void` | Reset to IDLE from any state. (2.0) Now valid from every state (previously silently no-op'd from INITIALIZING/CONNECTING/CONNECTED). |
| dispose | `(): void` | (2.0) Fully dispose: unsubscribes every listener registered via `on()`/`subscribe()`, cleans up the PC, transitions to IDLE. Idempotent. Manager should not be reused after dispose. |

### Audio Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| enableMicrophone | `(enable: boolean): Promise<boolean>` | Enable/disable microphone |
| switchMicrophone | `(deviceId: string): Promise<boolean>` | Switch audio input device |
| getAudioInputDevices | `(): Promise<MediaDeviceInfo[]>` | List available audio inputs |

### Data Channel Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| createDataChannel | `(label: string, options?: RTCDataChannelInit): RTCDataChannel \| null` | Create/get data channel |
| getDataChannel | `(label: string): RTCDataChannel \| undefined` | Get existing channel |
| sendData | `(label: string, data: string \| Blob \| ArrayBuffer \| ArrayBufferView): boolean` | Send through channel |

### Signaling Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| createOffer | `(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit \| null>` | Create SDP offer |
| createAnswer | `(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit \| null>` | Create SDP answer |
| setLocalDescription | `(description: RTCSessionDescriptionInit): Promise<boolean>` | Set local SDP |
| setRemoteDescription | `(description: RTCSessionDescriptionInit): Promise<boolean>` | Set remote SDP |
| addIceCandidate | `(candidate: RTCIceCandidateInit \| null): Promise<boolean>` | Add ICE candidate |
| iceRestart | `(): Promise<boolean>` | Perform ICE restart. (2.0) Emits `ice_restart_offer` with the new local offer so the consumer can forward it via signaling. |
| gatherIceCandidates | `(options?: GatherIceCandidatesOptions): Promise<void>` | Wait for ICE gathering to complete |
| getLocalDescription | `(): RTCSessionDescription \| null` | Get local SDP |
| getRemoteDescription | `(): RTCSessionDescription \| null` | Get remote SDP |
| getStats | `(): Promise<RTCStatsReport \| null>` | Get connection statistics |

### Event Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| on | `(event: keyof WebRTCEvents, handler: (data: any) => void): () => void` | Subscribe to specific event |
| subscribe | `(handler: (state: OverallState) => void): () => void` | Subscribe to overall state (Svelte compatible) |

### Utility Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| toMermaid | `(): string` | Get FSM as Mermaid diagram |

## Event Constants

| Constant | Value | Payload Type | Notes |
|----------|-------|--------------|-------|
| EVENT_STATE_CHANGE | "state_change" | WebRTCState | |
| EVENT_LOCAL_STREAM | "local_stream" | MediaStream \| null | (2.0) Also published as `null` on `disconnect()` / `cleanup()` |
| EVENT_REMOTE_STREAM | "remote_stream" | MediaStream \| null | (2.0) Also published as `null` on `disconnect()` / `cleanup()` |
| EVENT_DATA_CHANNEL_OPEN | "data_channel_open" | RTCDataChannel | |
| EVENT_DATA_CHANNEL_MESSAGE | "data_channel_message" | { channel: RTCDataChannel; data: any } | |
| EVENT_DATA_CHANNEL_CLOSE | "data_channel_close" | RTCDataChannel | |
| EVENT_ICE_CANDIDATE | "ice_candidate" | RTCIceCandidate \| null | |
| EVENT_RECONNECTING | "reconnecting" | { attempt: number; strategy: "ice-restart" \| "full" } | |
| EVENT_RECONNECT_FAILED | "reconnect_failed" | { attempts: number } | |
| EVENT_DEVICE_CHANGED | "device_changed" | MediaDeviceInfo[] | |
| EVENT_MICROPHONE_FAILED | "microphone_failed" | { error?: any; reason?: string } | |
| EVENT_ERROR | "error" | Error | |
| EVENT_ICE_RESTART_OFFER | "ice_restart_offer" | RTCSessionDescriptionInit | (2.0) Emitted after `iceRestart()` creates and sets a new local offer. Consumers MUST forward it via signaling. |
| EVENT_NEGOTIATION_NEEDED | "negotiation_needed" | undefined | (2.0) Forwarded from `pc.onnegotiationneeded`. Fires when renegotiation is required (e.g. late data channel or track change). |

## Signaling Flow (User Responsibility)

The library does NOT handle signaling transport. Users must implement:

1. Create signaling channel (WebSocket, HTTP, localStorage, etc.)
2. Listen for `ice_candidate` events and send to remote peer
3. Send offers/answers through signaling channel
4. Receive remote offers/answers and call setRemoteDescription
5. Receive remote ICE candidates and call addIceCandidate

### Initiator Flow

```
1. initialize()
2. connect()
3. createOffer()
4. setLocalDescription(offer)
5. [send offer via signaling]
6. [receive answer]
7. setRemoteDescription(answer)
8. [exchange ICE candidates via addIceCandidate]
9. CONNECTED
```

### Responder Flow

```
1. initialize()
2. [receive offer]
3. setRemoteDescription(offer)
4. createAnswer()
5. setLocalDescription(answer)
6. [send answer via signaling]
7. [exchange ICE candidates via addIceCandidate]
8. CONNECTED
```

## Reconnection Strategy

When `autoReconnect: true`:

| Attempt | Strategy | Description |
|---------|----------|-------------|
| 1-2 | ice-restart | Quick recovery, preserves connection |
| 3+ | full | New peer connection required |

Backoff formula: `reconnectDelay * 2^(attempt-1)` milliseconds

For "full" strategy reconnections, consumers MUST:
1. Listen for `reconnecting` event with `strategy: "full"`
2. Re-perform signaling handshake (create new offer/answer)

## Error Handling

| Pattern | Description |
|---------|-------------|
| Boolean returns | Methods return `true` for success, `false` for failure |
| ERROR state | Critical errors transition to ERROR state |
| Recovery | ERROR state requires `reset()` to recover |
| Events | EVENT_ERROR emitted for all errors |
| Specific events | EVENT_MICROPHONE_FAILED, EVENT_RECONNECT_FAILED |

## Build Commands

```bash
deno task test          # Run unit tests
deno task test:browser  # Run browser integration tests
deno task npm:build     # Build npm distribution
deno task npm:publish   # Build and publish to npm
deno task build:example # Build examples
deno task serve:example # Run signaling server
```

## Implementation Notes

1. `subscribe()` is Svelte store compatible (immediate callback + updates)
2. Data channels auto-cleanup on close
3. Device change listener auto-setup on initialize
4. "User-Initiated Abort" errors from intentional `close()` are ignored
5. Audio transceiver added when microphone disabled (ensures audio SDP). Direction defaults to `recvonly`; override with `audioDirection` config (2.0).
6. Private fields use `#` syntax (true ES2022 private fields)
7. Signaling transport NOT included - users implement their own
8. (2.0) `#reconnectAttempts` is reset whenever the user explicitly calls `connect()` / `disconnect()` / `reset()` / `dispose()`, so a prior exhausted reconnect budget never blocks a fresh session.
9. (2.0) ICE-restart success transitions `RECONNECTING -> CONNECTED` directly via the new FSM edge. Previously the FSM stayed stuck in `RECONNECTING` because the transition did not exist.
10. (2.0) `switchMicrophone()` promotes `recvonly` / `inactive` transceivers to `sendrecv` so replacing the track actually transmits.

## Common Usage Patterns

### Minimal P2P Setup

```typescript
const manager = new WebRTCManager(factory, { enableMicrophone: true });
await manager.initialize();
await manager.connect();
const offer = await manager.createOffer();
await manager.setLocalDescription(offer);
// Send offer, receive answer, exchange ICE candidates...
```

### With Data Channel

```typescript
const manager = new WebRTCManager(factory, { dataChannelLabel: "chat" });
manager.on("data_channel_message", ({ data }) => console.log(data));
// After connection...
manager.sendData("chat", "Hello!");
```

### Svelte Integration

```svelte
<script>
const manager = new WebRTCManager(factory, config);
// $manager reactive access to state
</script>
{$manager.state}
```

### Auto-reconnection Handling

```typescript
const manager = new WebRTCManager(factory, {
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
});

manager.on("reconnecting", ({ attempt, strategy }) => {
  console.log(`Reconnecting: attempt ${attempt}, strategy ${strategy}`);
  if (strategy === "full") {
    // Re-do signaling handshake
  }
});

// (2.0) For strategy="ice-restart", forward the offer manually if desired.
// The library emits the local offer via EVENT_ICE_RESTART_OFFER — consumers
// must send it to the remote peer for the restart to actually succeed.
manager.on("ice_restart_offer", (offer) => {
  signalingChannel.send({ type: "offer", offer });
});

manager.on("reconnect_failed", ({ attempts }) => {
  console.log(`Reconnection failed after ${attempts} attempts`);
});
```

## Breaking Changes (2.0)

Migrating from 1.x → 2.x. Most changes are bug fixes that align with documented behavior; only one consumer-visible break.

### 1. `gatherIceCandidates` — `onCandidate` callback no longer receives the terminal `null`

1.x forwarded the end-of-gathering `null` sentinel to `onCandidate`. 2.x forwards only real candidates. End-of-gathering is signaled by the returned promise resolving.

```typescript
// 1.x
await manager.gatherIceCandidates({
  onCandidate: (c) => {
    if (c === null) handleEnd();
    else collect.push(c);
  },
});

// 2.x
await manager.gatherIceCandidates({
  onCandidate: (c) => collect.push(c),
});
handleEnd(); // promise resolution == end of gathering
```

### 2. Behavior changes (no API change, but observable)

- `local_stream` / `remote_stream` events are now emitted with `null` payload on `disconnect()` / `cleanup()`. Subscribers that only handled `MediaStream` payloads must also handle `null` (this matches how `enableMicrophone(false)` already behaved).
- `reset()` now works from every state, including `INITIALIZING` / `CONNECTING` / `CONNECTED`. Previously these silently no-op'd — consumers relying on `reset()` being a no-op in those states must now expect the FSM to land in IDLE.
- After a successful ICE-restart reconnect, the FSM now transitions `RECONNECTING -> CONNECTED`. In 1.x it remained stuck in `RECONNECTING`.
- `#reconnectAttempts` is reset on every explicit `connect()` / `disconnect()` / `reset()` / `dispose()`. A 1.x consumer that exhausted the reconnect budget and then called `connect()` again would see no further reconnect attempts — 2.x correctly resumes.

### 3. Additive (no code change required)

- New config: `audioDirection` (default `"recvonly"` — same effective behavior as 1.x).
- New getter: `remoteStreams: ReadonlyMap<string, MediaStream>`.
- New method: `dispose()`.
- New option: `gatherIceCandidates({ resolveOnTimeout: true })`.
- New events: `ice_restart_offer`, `negotiation_needed`.
- New static constants: `EVENT_ICE_RESTART_OFFER`, `EVENT_NEGOTIATION_NEEDED`.
