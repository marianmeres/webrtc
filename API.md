# API Reference

Complete API documentation for `@marianmeres/webrtc`.

## Table of Contents

- [WebRTCManager](#webrtcmanager)
  - [Constructor](#constructor)
  - [Properties](#properties)
  - [Lifecycle Methods](#lifecycle-methods)
  - [Audio Methods](#audio-methods)
  - [Data Channel Methods](#data-channel-methods)
  - [Signaling Methods](#signaling-methods)
  - [Event Methods](#event-methods)
  - [Utility Methods](#utility-methods)
- [Types](#types)
  - [WebRTCFactory](#webrtcfactory)
  - [WebRTCManagerConfig](#webrtcmanagerconfig)
  - [WebRTCState](#webrtcstate)
  - [WebRTCFsmEvent](#webrtcfsmevent)
  - [WebRTCEvents](#webrtcevents)
- [Event Constants](#event-constants)
- [State Machine](#state-machine)

---

## WebRTCManager

The main class for managing WebRTC connections.

### Constructor

```typescript
new WebRTCManager<TContext = unknown>(factory: WebRTCFactory, config?: WebRTCManagerConfig)
```

**Type Parameters:**

| Name | Default | Description |
|------|---------|-------------|
| TContext | `unknown` | Type for the `context` property |

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| factory | `WebRTCFactory` | Yes | Factory for creating WebRTC primitives |
| config | `WebRTCManagerConfig` | No | Configuration options |

**Example:**

```typescript
import { WebRTCManager } from '@marianmeres/webrtc';

const factory = {
  createPeerConnection: (config) => new RTCPeerConnection(config),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
};

const manager = new WebRTCManager(factory, {
  peerConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  enableMicrophone: true,
  autoReconnect: true,
});
```

---

### Properties

#### state

```typescript
get state(): WebRTCState
```

Returns the current state of the WebRTC connection.

**Returns:** `WebRTCState` - One of: `IDLE`, `INITIALIZING`, `CONNECTING`, `CONNECTED`, `RECONNECTING`, `DISCONNECTED`, `ERROR`

---

#### localStream

```typescript
get localStream(): MediaStream | null
```

Returns the local media stream (microphone audio), or `null` if not initialized.

**Returns:** `MediaStream | null`

---

#### remoteStream

```typescript
get remoteStream(): MediaStream | null
```

Returns the remote media stream received from peer, or `null` if not connected.

**Returns:** `MediaStream | null`

---

#### dataChannels

```typescript
get dataChannels(): ReadonlyMap<string, RTCDataChannel>
```

Returns a readonly map of all active data channels, indexed by label.

**Returns:** `ReadonlyMap<string, RTCDataChannel>`

---

#### peerConnection

```typescript
get peerConnection(): RTCPeerConnection | null
```

Returns the underlying RTCPeerConnection, or `null` if not initialized.

**Returns:** `RTCPeerConnection | null`

---

#### context

```typescript
context: TContext | null
```

User-defined context object for storing arbitrary data associated with this manager. The class accepts an optional generic type parameter for type-safe context access.

**Type Parameter:** `TContext` - The type of the context object (default: `unknown`)

**Default:** `null`

**Example:**

```typescript
// With type parameter for full type safety:
const manager = new WebRTCManager<{ audioStream: MediaStream; sessionId: string }>(factory);
manager.context = { audioStream: myStream, sessionId: '123' };
manager.context.audioStream; // typed as MediaStream

// Without type parameter (backwards compatible):
const manager = new WebRTCManager(factory);
manager.context = { anything: 'goes' };
```

---

### Lifecycle Methods

#### initialize()

```typescript
async initialize(): Promise<void>
```

Initializes the WebRTC peer connection and sets up media tracks.

- Creates RTCPeerConnection using the factory
- Sets up connection state listeners
- Enables microphone if configured
- Creates default data channel if configured
- Sets up device change detection

**State Requirement:** Must be in `IDLE` state.

**Transitions:** `IDLE` → `INITIALIZING`

**Example:**

```typescript
await manager.initialize();
console.log(manager.state); // "INITIALIZING"
```

---

#### connect()

```typescript
async connect(): Promise<void>
```

Transitions to the `CONNECTING` state. Automatically calls `initialize()` if in `IDLE` state. If `DISCONNECTED`, reinitializes the peer connection.

**State Transitions:**
- From `IDLE`: Initializes first, then transitions to `CONNECTING`
- From `DISCONNECTED`: Cleans up, resets, and reinitializes
- From `INITIALIZING`: Transitions to `CONNECTING`
- From `CONNECTED` or `CONNECTING`: No-op

**Example:**

```typescript
await manager.connect();
// Now ready to create offer/answer
```

---

#### disconnect()

```typescript
disconnect(): void
```

Disconnects the peer connection and cleans up all resources:
- Closes all data channels
- Stops local media tracks
- Closes peer connection
- Clears reconnection timers

**Transitions:** Any state → `DISCONNECTED`

**Example:**

```typescript
manager.disconnect();
console.log(manager.state); // "DISCONNECTED"
```

---

#### reset()

```typescript
reset(): void
```

Resets the manager to `IDLE` state from any state. Performs full cleanup and allows reinitialization.

**Transitions:** Any state → `IDLE`

**Example:**

```typescript
manager.reset();
console.log(manager.state); // "IDLE"
// Can now call initialize() again
```

---

### Audio Methods

#### enableMicrophone()

```typescript
async enableMicrophone(enable: boolean): Promise<boolean>
```

Enables or disables the microphone.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| enable | `boolean` | `true` to enable, `false` to disable |

**Returns:** `boolean` - `true` if successful, `false` if failed

**Events Emitted:**
- `local_stream` - When stream changes
- `microphone_failed` - On failure

**Example:**

```typescript
const success = await manager.enableMicrophone(true);
if (success) {
  console.log('Microphone enabled');
}
```

---

#### switchMicrophone()

```typescript
async switchMicrophone(deviceId: string): Promise<boolean>
```

Switches the active microphone to a different audio input device.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| deviceId | `string` | Device ID from `getAudioInputDevices()` |

**Returns:** `boolean` - `true` if successful, `false` otherwise

**Requirements:** Peer connection must be initialized and microphone must be enabled.

**Example:**

```typescript
const devices = await manager.getAudioInputDevices();
const success = await manager.switchMicrophone(devices[1].deviceId);
```

---

#### getAudioInputDevices()

```typescript
async getAudioInputDevices(): Promise<MediaDeviceInfo[]>
```

Retrieves all available audio input devices.

**Returns:** `MediaDeviceInfo[]` - Array of audio input devices, empty array on error

**Example:**

```typescript
const devices = await manager.getAudioInputDevices();
devices.forEach(d => console.log(d.label, d.deviceId));
```

---

### Data Channel Methods

#### createDataChannel()

```typescript
createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel | null
```

Creates a new data channel with the specified label. Returns existing channel if one with the same label already exists.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| label | `string` | Yes | Unique identifier for the channel |
| options | `RTCDataChannelInit` | No | Channel configuration |

**Returns:** `RTCDataChannel | null` - The channel, or `null` if peer connection not initialized

**Example:**

```typescript
const chatChannel = manager.createDataChannel('chat');
const fileChannel = manager.createDataChannel('file-transfer', { ordered: true });
```

---

#### getDataChannel()

```typescript
getDataChannel(label: string): RTCDataChannel | undefined
```

Retrieves an existing data channel by label.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| label | `string` | The channel label |

**Returns:** `RTCDataChannel | undefined`

**Example:**

```typescript
const channel = manager.getDataChannel('chat');
if (channel?.readyState === 'open') {
  // Channel is ready
}
```

---

#### sendData()

```typescript
sendData(label: string, data: string | Blob | ArrayBuffer | ArrayBufferView): boolean
```

Sends data through a data channel. Verifies channel exists and is open before sending.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| label | `string` | The channel label |
| data | `string \| Blob \| ArrayBuffer \| ArrayBufferView` | Data to send |

**Returns:** `boolean` - `true` if sent, `false` otherwise

**Example:**

```typescript
// Send string
manager.sendData('chat', 'Hello!');

// Send binary
const buffer = new ArrayBuffer(8);
manager.sendData('binary', buffer);
```

---

### Signaling Methods

#### createOffer()

```typescript
async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit | null>
```

Creates an SDP offer for initiating a WebRTC connection.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| options | `RTCOfferOptions` | Optional offer configuration |

**Returns:** `RTCSessionDescriptionInit | null` - The offer, or `null` on error

**Example:**

```typescript
const offer = await manager.createOffer();
await manager.setLocalDescription(offer);
// Send offer to remote peer via signaling channel
```

---

#### createAnswer()

```typescript
async createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit | null>
```

Creates an SDP answer in response to a received offer.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| options | `RTCAnswerOptions` | Optional answer configuration |

**Returns:** `RTCSessionDescriptionInit | null` - The answer, or `null` on error

**Example:**

```typescript
// After receiving and setting remote offer
const answer = await manager.createAnswer();
await manager.setLocalDescription(answer);
// Send answer to remote peer
```

---

#### setLocalDescription()

```typescript
async setLocalDescription(description: RTCSessionDescriptionInit): Promise<boolean>
```

Sets the local SDP description (offer or answer).

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| description | `RTCSessionDescriptionInit` | The SDP description |

**Returns:** `boolean` - `true` if successful

**Example:**

```typescript
const offer = await manager.createOffer();
const success = await manager.setLocalDescription(offer);
```

---

#### setRemoteDescription()

```typescript
async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<boolean>
```

Sets the remote SDP description received from the peer.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| description | `RTCSessionDescriptionInit` | The remote SDP |

**Returns:** `boolean` - `true` if successful

**Example:**

```typescript
// Received from signaling channel
await manager.setRemoteDescription(remoteOffer);
```

---

#### addIceCandidate()

```typescript
async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<boolean>
```

Adds an ICE candidate received from the remote peer.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| candidate | `RTCIceCandidateInit \| null` | The ICE candidate, or `null` for end-of-candidates |

**Returns:** `boolean` - `true` if successful

**Example:**

```typescript
// From signaling channel
await manager.addIceCandidate(remoteCandidate);
```

---

#### iceRestart()

```typescript
async iceRestart(): Promise<boolean>
```

Performs an ICE restart to recover from connection issues. Creates a new offer with the `iceRestart` flag.

**Returns:** `boolean` - `true` if successful

**Example:**

```typescript
const success = await manager.iceRestart();
// New ICE candidates will be generated
```

---

#### getLocalDescription()

```typescript
getLocalDescription(): RTCSessionDescription | null
```

Returns the current local session description.

**Returns:** `RTCSessionDescription | null`

---

#### getRemoteDescription()

```typescript
getRemoteDescription(): RTCSessionDescription | null
```

Returns the current remote session description.

**Returns:** `RTCSessionDescription | null`

---

#### getStats()

```typescript
async getStats(): Promise<RTCStatsReport | null>
```

Retrieves WebRTC statistics for the peer connection.

**Returns:** `RTCStatsReport | null` - Statistics report, or `null` if not initialized

**Example:**

```typescript
const stats = await manager.getStats();
stats?.forEach(report => {
  console.log(report.type, report);
});
```

---

### Event Methods

#### on()

```typescript
on<K extends keyof WebRTCEvents>(
  event: K,
  handler: (data: WebRTCEvents[K]) => void
): () => void
```

Subscribe to a specific WebRTC event.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| event | `keyof WebRTCEvents` | Event name |
| handler | `function` | Callback receiving event data |

**Returns:** `() => void` - Unsubscribe function

**Example:**

```typescript
const unsub = manager.on('state_change', (state) => {
  console.log('New state:', state);
});

// Later: unsub();
```

---

#### subscribe()

```typescript
subscribe(handler: (state: OverallState) => void): () => void
```

Subscribe to the overall state of the manager. Svelte store compatible - immediately calls handler with current state, then on changes.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| handler | `function` | Callback receiving overall state |

**Overall State Object:**

```typescript
{
  state: WebRTCState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  dataChannels: ReadonlyMap<string, RTCDataChannel>;
  peerConnection: RTCPeerConnection | null;
}
```

**Returns:** `() => void` - Unsubscribe function

**Example (Svelte):**

```svelte
<script>
  const manager = new WebRTCManager(factory, config);
</script>

<p>State: {$manager.state}</p>
```

**Example (Vanilla):**

```typescript
const unsub = manager.subscribe((state) => {
  console.log('Overall state:', state);
});
```

---

### Utility Methods

#### toMermaid()

```typescript
toMermaid(): string
```

Returns a Mermaid diagram representation of the FSM state machine.

**Returns:** `string` - Mermaid diagram source

**Example:**

```typescript
console.log(manager.toMermaid());
// Outputs Mermaid state diagram
```

---

## Types

### Logger

Console-compatible logger interface for custom logging implementations.

```typescript
interface Logger {
  debug: (...args: any[]) => any;
  log: (...args: any[]) => any;
  warn: (...args: any[]) => any;
  error: (...args: any[]) => any;
}
```

Each method accepts variadic arguments and returns a string representation of the first argument. This enables patterns like `throw new Error(logger.error("msg"))`.

**Example Custom Logger:**

```typescript
import { clog } from '@marianmeres/clog';

const logger = clog('WebRTC');

const manager = new WebRTCManager(factory, {
  logger: logger,
});
```

---

### WebRTCFactory

Interface for dependency injection of WebRTC primitives.

```typescript
interface WebRTCFactory {
  createPeerConnection(config?: RTCConfiguration): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}
```

**Browser Implementation:**

```typescript
const factory: WebRTCFactory = {
  createPeerConnection: (config) => new RTCPeerConnection(config),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
};
```

---

### WebRTCManagerConfig

Configuration options for WebRTCManager.

```typescript
interface WebRTCManagerConfig {
  /** RTCConfiguration for ICE servers, certificates, etc. */
  peerConfig?: RTCConfiguration;

  /** Enable microphone on initialization. Default: false */
  enableMicrophone?: boolean;

  /** Create a data channel with this label on connect */
  dataChannelLabel?: string;

  /** Enable automatic reconnection on failure. Default: false */
  autoReconnect?: boolean;

  /** Maximum reconnection attempts. Default: 5 */
  maxReconnectAttempts?: number;

  /** Initial reconnection delay in ms (doubles each attempt). Default: 1000 */
  reconnectDelay?: number;

  /** Timeout in ms for full reconnection to reach connected state. Default: 30000 */
  fullReconnectTimeout?: number;

  /** Callback to control whether reconnection should proceed */
  shouldReconnect?: (context: {
    attempt: number;
    maxAttempts: number;
    strategy: "ice-restart" | "full";
  }) => boolean;

  /** Custom logger instance. If not provided, falls back to console. */
  logger?: Logger;
}
```

---

### WebRTCState

Enum of possible connection states.

```typescript
enum WebRTCState {
  IDLE = "IDLE",
  INITIALIZING = "INITIALIZING",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  RECONNECTING = "RECONNECTING",
  DISCONNECTED = "DISCONNECTED",
  ERROR = "ERROR"
}
```

| State | Description |
|-------|-------------|
| IDLE | Initial state, no resources allocated |
| INITIALIZING | Creating peer connection and setting up |
| CONNECTING | Performing offer/answer exchange |
| CONNECTED | Connection established, ready for communication |
| RECONNECTING | Attempting to restore failed connection |
| DISCONNECTED | Connection closed, can reconnect |
| ERROR | Error occurred, must call `reset()` |

---

### WebRTCFsmEvent

Internal FSM events (for reference).

```typescript
enum WebRTCFsmEvent {
  INIT = "initialize",
  CONNECT = "connect",
  CONNECTED = "connected",
  RECONNECTING = "reconnecting",
  DISCONNECT = "disconnect",
  ERROR = "error",
  RESET = "reset"
}
```

---

### WebRTCEvents

Type definition for all events and their payloads.

```typescript
interface WebRTCEvents {
  state_change: WebRTCState;
  local_stream: MediaStream | null;
  remote_stream: MediaStream | null;
  data_channel_open: RTCDataChannel;
  data_channel_message: { channel: RTCDataChannel; data: any };
  data_channel_close: RTCDataChannel;
  ice_candidate: RTCIceCandidate | null;
  reconnecting: { attempt: number; strategy: "ice-restart" | "full" };
  reconnect_failed: { attempts: number };
  device_changed: MediaDeviceInfo[];
  microphone_failed: { error?: any; reason?: string };
  error: Error;
}
```

---

## Event Constants

Static event name constants on `WebRTCManager`.

| Constant | Value | Payload |
|----------|-------|---------|
| `EVENT_STATE_CHANGE` | `"state_change"` | `WebRTCState` |
| `EVENT_LOCAL_STREAM` | `"local_stream"` | `MediaStream \| null` |
| `EVENT_REMOTE_STREAM` | `"remote_stream"` | `MediaStream \| null` |
| `EVENT_DATA_CHANNEL_OPEN` | `"data_channel_open"` | `RTCDataChannel` |
| `EVENT_DATA_CHANNEL_MESSAGE` | `"data_channel_message"` | `{ channel, data }` |
| `EVENT_DATA_CHANNEL_CLOSE` | `"data_channel_close"` | `RTCDataChannel` |
| `EVENT_ICE_CANDIDATE` | `"ice_candidate"` | `RTCIceCandidate \| null` |
| `EVENT_RECONNECTING` | `"reconnecting"` | `{ attempt, strategy }` |
| `EVENT_RECONNECT_FAILED` | `"reconnect_failed"` | `{ attempts }` |
| `EVENT_DEVICE_CHANGED` | `"device_changed"` | `MediaDeviceInfo[]` |
| `EVENT_MICROPHONE_FAILED` | `"microphone_failed"` | `{ error?, reason? }` |
| `EVENT_ERROR` | `"error"` | `Error` |

**Usage:**

```typescript
manager.on(WebRTCManager.EVENT_ICE_CANDIDATE, (candidate) => {
  // Send to remote peer
});
```

---

## State Machine

### State Transition Diagram

```
              ┌─────────────────────────────────────────────────────────┐
              │                                                         │
              ▼                                                         │
┌──────┐  INIT   ┌──────────────┐  CONNECT  ┌────────────┐  CONNECTED  │
│ IDLE │────────▶│ INITIALIZING │──────────▶│ CONNECTING │─────────────┤
└──────┘         └──────────────┘           └────────────┘             │
    ▲                   │                         │                    │
    │                   │ ERROR                   │ ERROR              │
    │                   ▼                         ▼                    ▼
    │              ┌─────────┐◀──────────────────────────────────┌───────────┐
    │              │  ERROR  │                                   │ CONNECTED │
    │              └─────────┘                                   └───────────┘
    │                   │                                              │
    │               RESET                                          DISCONNECT
    │                   │                                              │
    │                   ▼                                              ▼
    │              ┌──────┐◀─────────────────────────────────┌──────────────┐
    └──────────────│ IDLE │           RESET                  │ DISCONNECTED │
                   └──────┘◀────────────────────┬────────────└──────────────┘
                                                │                    │
                                                │              RECONNECTING
                                                │                    │
                                            RESET/                   ▼
                                           DISCONNECT         ┌──────────────┐
                                                │             │ RECONNECTING │
                                                └─────────────└──────────────┘
                                                                     │
                                                                  CONNECT
                                                                     │
                                                                     ▼
                                                              ┌────────────┐
                                                              │ CONNECTING │
                                                              └────────────┘
```

### Valid Transitions

| From State | Event | To State |
|------------|-------|----------|
| IDLE | INIT | INITIALIZING |
| INITIALIZING | CONNECT | CONNECTING |
| INITIALIZING | ERROR | ERROR |
| CONNECTING | CONNECTED | CONNECTED |
| CONNECTING | DISCONNECT | DISCONNECTED |
| CONNECTING | ERROR | ERROR |
| CONNECTED | DISCONNECT | DISCONNECTED |
| CONNECTED | ERROR | ERROR |
| RECONNECTING | CONNECT | CONNECTING |
| RECONNECTING | DISCONNECT | DISCONNECTED |
| RECONNECTING | RESET | IDLE |
| DISCONNECTED | CONNECT | CONNECTING |
| DISCONNECTED | RECONNECTING | RECONNECTING |
| DISCONNECTED | RESET | IDLE |
| ERROR | RESET | IDLE |

### Reconnection Strategy

When `autoReconnect: true`:

1. **Attempts 1-2:** ICE restart (quick, preserves connection)
2. **Attempts 3+:** Full reconnection (new peer connection)
3. **Backoff:** `reconnectDelay * 2^(attempt-1)` milliseconds

#### Full Reconnection and Signaling

**Important:** For "full" strategy reconnections, the manager creates a new peer connection but **cannot automatically complete the signaling handshake**. You must listen for the `reconnecting` event and re-perform signaling when `strategy === 'full'`:

```typescript
manager.on('reconnecting', async ({ attempt, strategy }) => {
  if (strategy === 'full') {
    // Re-do offer/answer exchange
    const offer = await manager.createOffer();
    await manager.setLocalDescription(offer);
    sendToRemote(offer);
  }
  // For 'ice-restart', the manager handles it automatically
});
```

If the connection doesn't reach `CONNECTED` state within `fullReconnectTimeout` (default: 30 seconds), it's treated as a failed attempt and the next reconnection attempt begins. When all attempts are exhausted, `EVENT_RECONNECT_FAILED` is emitted.

### Conditional Reconnection

Use the `shouldReconnect` callback to suppress reconnection when the peer disconnected intentionally:

```typescript
let peerLeftIntentionally = false;

const manager = new WebRTCManager(factory, {
  autoReconnect: true,
  shouldReconnect: ({ attempt, maxAttempts, strategy }) => {
    // Return false to suppress reconnection
    return !peerLeftIntentionally;
  },
});

// Track intentional disconnects via data channel
manager.on('data_channel_message', ({ data }) => {
  if (JSON.parse(data).type === 'bye') {
    peerLeftIntentionally = true;
  }
});
```

The callback receives:
- `attempt`: Current attempt number (1-based)
- `maxAttempts`: Configured maximum attempts
- `strategy`: `"ice-restart"` or `"full"`
