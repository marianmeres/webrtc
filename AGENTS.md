# AGENTS.md - Machine-Readable Package Documentation

## Package Metadata

```yaml
name: "@marianmeres/webrtc"
version: "0.0.2"
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
  - "@marianmeres/fsm": "^2.3.0"
  - "@marianmeres/pubsub": "^2.4.0"
development:
  - "@std/assert": testing
  - "@std/fs": file operations
  - "@std/path": path utilities
```

## File Structure

```
src/
  mod.ts              # Entry point, re-exports all public APIs
  types.ts            # Type definitions (interfaces, enums)
  webrtc-manager.ts   # Main WebRtcManager class

tests/
  mocks.ts                    # Mock WebRtcFactory for testing
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

### States (WebRtcState)

| State | Description | Valid Outgoing Transitions |
|-------|-------------|---------------------------|
| IDLE | Initial state, no resources allocated | INITIALIZING |
| INITIALIZING | Creating peer connection and setting up | CONNECTING, ERROR |
| CONNECTING | Performing SDP offer/answer exchange | CONNECTED, DISCONNECTED, ERROR |
| CONNECTED | Connection established, communication active | DISCONNECTED, ERROR |
| RECONNECTING | Auto-reconnection in progress | CONNECTING, DISCONNECTED, IDLE |
| DISCONNECTED | Connection closed, resources may be cleaned up | CONNECTING, RECONNECTING, IDLE |
| ERROR | Error state, requires reset() to recover | IDLE |

### Events (WebRtcFsmEvent)

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
INITIALIZING  --CONNECT-->     CONNECTING
INITIALIZING  --ERROR-->       ERROR
CONNECTING    --CONNECTED-->   CONNECTED
CONNECTING    --DISCONNECT-->  DISCONNECTED
CONNECTING    --ERROR-->       ERROR
CONNECTED     --DISCONNECT-->  DISCONNECTED
CONNECTED     --ERROR-->       ERROR
RECONNECTING  --CONNECT-->     CONNECTING
RECONNECTING  --DISCONNECT-->  DISCONNECTED
RECONNECTING  --RESET-->       IDLE
DISCONNECTED  --CONNECT-->     CONNECTING
DISCONNECTED  --RECONNECTING-->RECONNECTING
DISCONNECTED  --RESET-->       IDLE
ERROR         --RESET-->       IDLE
```

## Public API Reference

### Constructor

```typescript
new WebRtcManager(factory: WebRtcFactory, config?: WebRtcManagerConfig)
```

### Logger Interface

Console-compatible logger interface for custom logging implementations.

```typescript
interface Logger {
  debug: (...args: any[]) => string;
  log: (...args: any[]) => string;
  warn: (...args: any[]) => string;
  error: (...args: any[]) => string;
}
```

Each method returns a string representation of the first argument, enabling patterns like `throw new Error(logger.error("msg"))`.

### WebRtcFactory Interface

```typescript
interface WebRtcFactory {
  createPeerConnection(config?: RTCConfiguration): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}
```

### WebRtcManagerConfig Interface

```typescript
interface WebRtcManagerConfig {
  peerConfig?: RTCConfiguration;      // ICE servers, certificates
  enableMicrophone?: boolean;         // Default: false
  dataChannelLabel?: string;          // Auto-create data channel
  autoReconnect?: boolean;            // Default: false
  maxReconnectAttempts?: number;      // Default: 5
  reconnectDelay?: number;            // Default: 1000ms
  debug?: boolean;                    // Default: false
  logger?: Logger;                    // Custom logger, falls back to console
}
```

### Properties (Getters)

| Property | Type | Description |
|----------|------|-------------|
| state | WebRtcState | Current FSM state |
| localStream | MediaStream \| null | Local audio stream |
| remoteStream | MediaStream \| null | Remote audio stream |
| dataChannels | ReadonlyMap<string, RTCDataChannel> | Active data channels |
| peerConnection | RTCPeerConnection \| null | Underlying connection |

### Lifecycle Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| initialize | `(): Promise<void>` | Create peer connection, setup tracks |
| connect | `(): Promise<void>` | Transition to CONNECTING (auto-initializes if IDLE) |
| disconnect | `(): void` | Close connection, cleanup resources |
| reset | `(): void` | Reset to IDLE from any state |

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
| iceRestart | `(): Promise<boolean>` | Perform ICE restart |
| getLocalDescription | `(): RTCSessionDescription \| null` | Get local SDP |
| getRemoteDescription | `(): RTCSessionDescription \| null` | Get remote SDP |
| getStats | `(): Promise<RTCStatsReport \| null>` | Get connection statistics |

### Event Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| on | `(event: keyof WebRtcEvents, handler: (data: any) => void): () => void` | Subscribe to specific event |
| subscribe | `(handler: (state: OverallState) => void): () => void` | Subscribe to overall state (Svelte compatible) |

### Utility Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| toMermaid | `(): string` | Get FSM as Mermaid diagram |

## Event Constants

| Constant | Value | Payload Type |
|----------|-------|--------------|
| EVENT_STATE_CHANGE | "state_change" | WebRtcState |
| EVENT_LOCAL_STREAM | "local_stream" | MediaStream \| null |
| EVENT_REMOTE_STREAM | "remote_stream" | MediaStream \| null |
| EVENT_DATA_CHANNEL_OPEN | "data_channel_open" | RTCDataChannel |
| EVENT_DATA_CHANNEL_MESSAGE | "data_channel_message" | { channel: RTCDataChannel; data: any } |
| EVENT_DATA_CHANNEL_CLOSE | "data_channel_close" | RTCDataChannel |
| EVENT_ICE_CANDIDATE | "ice_candidate" | RTCIceCandidate \| null |
| EVENT_RECONNECTING | "reconnecting" | { attempt: number; strategy: "ice-restart" \| "full" } |
| EVENT_RECONNECT_FAILED | "reconnect_failed" | { attempts: number } |
| EVENT_DEVICE_CHANGED | "device_changed" | MediaDeviceInfo[] |
| EVENT_MICROPHONE_FAILED | "microphone_failed" | { error?: any; reason?: string } |
| EVENT_ERROR | "error" | Error |

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
5. `recvonly` transceiver added when microphone disabled (ensures audio SDP)
6. Private fields use `#` syntax (true ES2022 private fields)
7. Signaling transport NOT included - users implement their own

## Common Usage Patterns

### Minimal P2P Setup

```typescript
const manager = new WebRtcManager(factory, { enableMicrophone: true });
await manager.initialize();
await manager.connect();
const offer = await manager.createOffer();
await manager.setLocalDescription(offer);
// Send offer, receive answer, exchange ICE candidates...
```

### With Data Channel

```typescript
const manager = new WebRtcManager(factory, { dataChannelLabel: "chat" });
manager.on("data_channel_message", ({ data }) => console.log(data));
// After connection...
manager.sendData("chat", "Hello!");
```

### Svelte Integration

```svelte
<script>
const manager = new WebRtcManager(factory, config);
// $manager reactive access to state
</script>
{$manager.state}
```

### Auto-reconnection Handling

```typescript
const manager = new WebRtcManager(factory, {
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

manager.on("reconnect_failed", ({ attempts }) => {
  console.log(`Reconnection failed after ${attempts} attempts`);
});
```
