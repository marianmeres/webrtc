# @marianmeres/webrtc

> **Full Disclosure:** This code was written by Claude (Anthropic's AI). The human (that is me, @marianmeres) just asked nicely, occasionally said "thanks", and went through about 47 iterations of "could you improve this", "what about that", and "make it more Svelte-friendly". To be fair, the prompt engineering was top-notch. So if you find bugs, we'll split the blame 50/50. If it works perfectly, Claude gets 95% of the credit and @marianmeres gets the remaining 5% for excellent taste in asking the right questions. 🤖

A lightweight, framework-agnostic WebRTC manager with state machine-based lifecycle management and event-driven architecture.

## Features

- **State Machine-based**: Clean state transitions (IDLE → INITIALIZING → CONNECTING → CONNECTED)
- **Event-driven**: Subscribe to specific events or overall state changes
- **Svelte Store Compatible**: Works seamlessly with Svelte's reactive `$` syntax
- **Audio Management**: Microphone enable/disable, device switching, device change detection
- **Data Channels**: Easy creation and management of RTCDataChannels
- **Auto-reconnection**: Optional automatic reconnection with exponential backoff
- **TypeScript**: Full type safety and excellent IDE support

## Installation

```bash
npm install @marianmeres/webrtc
```

## High-Level Overview

The `WebRtcManager` class handles the complete WebRTC connection lifecycle:

1. **Initialization**: Sets up RTCPeerConnection, media streams, and data channels
2. **Connection Management**: Handles state transitions, reconnection, and cleanup
3. **Signaling**: Provides methods for offer/answer exchange and ICE candidate handling
4. **Media Control**: Manages local/remote streams and microphone switching
5. **Events**: Emits events for all important state changes

The manager doesn't handle the signaling transport layer - you're responsible for sending/receiving offers, answers, and ICE candidates through your own signaling mechanism (WebSocket, HTTP, etc.).

## Core API

### Constructor

```typescript
const manager = new WebRtcManager(factory, config);
```

- `factory`: Object implementing `WebRtcFactory` interface (provides `createPeerConnection`, `getUserMedia`, `enumerateDevices`)
- `config`: Optional configuration object

**Configuration Options:**
- `peerConfig`: RTCConfiguration (ICE servers, etc.)
- `enableMicrophone`: Enable microphone on initialization (default: false)
- `dataChannelLabel`: Create a default data channel with this label
- `autoReconnect`: Enable automatic reconnection (default: false)
- `maxReconnectAttempts`: Max reconnection attempts (default: 5)
- `reconnectDelay`: Initial reconnection delay in ms (default: 1000)
- `debug`: Enable debug logging (default: false)

### State and Properties

```typescript
manager.state                 // Current WebRtcState
manager.localStream           // MediaStream | null
manager.remoteStream          // MediaStream | null
manager.dataChannels          // ReadonlyMap<string, RTCDataChannel>
manager.peerConnection        // RTCPeerConnection | null
```

### Lifecycle Methods

```typescript
await manager.initialize()    // Initialize peer connection
await manager.connect()       // Transition to CONNECTING state
manager.disconnect()          // Disconnect and cleanup
manager.reset()               // Reset to IDLE state
```

### Audio Methods

```typescript
await manager.enableMicrophone(true)           // Enable/disable microphone
await manager.switchMicrophone(deviceId)       // Switch to different audio input
await manager.getAudioInputDevices()           // Get available audio inputs
```

### Signaling Methods

```typescript
const offer = await manager.createOffer()
const answer = await manager.createAnswer()
await manager.setLocalDescription(offer)
await manager.setRemoteDescription(answer)
await manager.addIceCandidate(candidate)
await manager.iceRestart()                     // Trigger ICE restart
```

### Data Channel Methods

```typescript
const dc = manager.createDataChannel(label, options)
const dc = manager.getDataChannel(label)
manager.sendData(label, data)                  // Returns boolean
```

### Event Subscription

```typescript
// Subscribe to specific event
const unsub = manager.on(WebRtcManager.EVENT_STATE_CHANGE, (state) => {
  console.log('State changed:', state);
});

// Subscribe to overall state (Svelte store compatible)
const unsub = manager.subscribe((state) => {
  console.log('Overall state:', state);
  // state = { state, localStream, remoteStream, dataChannels, peerConnection }
});
```

**Available Event Constants:**
- `EVENT_STATE_CHANGE`
- `EVENT_LOCAL_STREAM`
- `EVENT_REMOTE_STREAM`
- `EVENT_DATA_CHANNEL_OPEN`
- `EVENT_DATA_CHANNEL_MESSAGE`
- `EVENT_DATA_CHANNEL_CLOSE`
- `EVENT_ICE_CANDIDATE`
- `EVENT_RECONNECTING`
- `EVENT_RECONNECT_FAILED`
- `EVENT_DEVICE_CHANGED`
- `EVENT_MICROPHONE_FAILED`
- `EVENT_ERROR`

## Examples

### Basic Usage (Vanilla JavaScript)

```typescript
import { WebRtcManager, WebRtcState } from '@marianmeres/webrtc';

// Create factory (browser implementation)
const factory = {
  createPeerConnection: (config) => new RTCPeerConnection(config),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
};

// Create manager
const manager = new WebRtcManager(factory, {
  peerConfig: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  },
  enableMicrophone: true,
  autoReconnect: true,
});

// Subscribe to events
manager.on(WebRtcManager.EVENT_ICE_CANDIDATE, (candidate) => {
  // Send candidate to remote peer via your signaling channel
  signalingChannel.send({ type: 'candidate', candidate });
});

manager.on(WebRtcManager.EVENT_REMOTE_STREAM, (stream) => {
  // Attach remote stream to audio element
  audioElement.srcObject = stream;
});

// Initialize and create offer
await manager.initialize();
await manager.connect();
const offer = await manager.createOffer();
await manager.setLocalDescription(offer);

// Send offer to remote peer via your signaling channel
signalingChannel.send({ type: 'offer', offer });

// Handle incoming signaling messages
signalingChannel.onmessage = async (msg) => {
  if (msg.type === 'answer') {
    await manager.setRemoteDescription(msg.answer);
  } else if (msg.type === 'candidate') {
    await manager.addIceCandidate(msg.candidate);
  }
};
```

### Svelte 5 Integration

```svelte
<script>
  import { WebRtcManager, WebRtcState } from '@marianmeres/webrtc';
  import { onMount } from 'svelte';

  const factory = {
    createPeerConnection: (config) => new RTCPeerConnection(config),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
  };

  const manager = new WebRtcManager(factory, {
    peerConfig: {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    },
    enableMicrophone: true,
  });

  // Subscribe to overall state (Svelte store compatible!)
  const managerState = $derived(manager.subscribe((state) => state));

  // Or use individual event subscriptions
  let devices = $state([]);

  onMount(() => {
    const unsubDevices = manager.on(
      WebRtcManager.EVENT_DEVICE_CHANGED,
      (devs) => devices = devs
    );

    return () => {
      unsubDevices();
      manager.disconnect();
    };
  });

  async function startCall() {
    await manager.initialize();
    await manager.connect();
    const offer = await manager.createOffer();
    await manager.setLocalDescription(offer);
    // Send offer via your signaling channel
  }

  async function switchMic(deviceId) {
    await manager.switchMicrophone(deviceId);
  }
</script>

<div>
  <p>State: {$managerState.state}</p>
  <p>Microphone: {$managerState.localStream ? 'Enabled' : 'Disabled'}</p>

  <button onclick={startCall}>Start Call</button>

  <select onchange={(e) => switchMic(e.target.value)}>
    {#each devices as device}
      <option value={device.deviceId}>{device.label}</option>
    {/each}
  </select>

  <audio bind:this={remoteAudio} autoplay></audio>
</div>
```

### Complete Peer-to-Peer Example

```typescript
import { WebRtcManager } from '@marianmores/webrtc';

class P2PConnection {
  manager: WebRtcManager;
  signalingChannel: WebSocket;

  constructor(signalingUrl: string) {
    this.manager = new WebRtcManager(
      {
        createPeerConnection: (config) => new RTCPeerConnection(config),
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      },
      {
        peerConfig: {
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        },
        enableMicrophone: true,
        dataChannelLabel: 'chat',
        autoReconnect: true,
      }
    );

    this.signalingChannel = new WebSocket(signalingUrl);
    this.setupSignaling();
    this.setupManagerEvents();
  }

  setupSignaling() {
    this.signalingChannel.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'offer':
          await this.handleOffer(msg.offer);
          break;
        case 'answer':
          await this.manager.setRemoteDescription(msg.answer);
          break;
        case 'candidate':
          await this.manager.addIceCandidate(msg.candidate);
          break;
      }
    };
  }

  setupManagerEvents() {
    // Send ICE candidates to remote peer
    this.manager.on(WebRtcManager.EVENT_ICE_CANDIDATE, (candidate) => {
      this.signalingChannel.send(JSON.stringify({
        type: 'candidate',
        candidate,
      }));
    });

    // Handle remote audio stream
    this.manager.on(WebRtcManager.EVENT_REMOTE_STREAM, (stream) => {
      const audio = document.getElementById('remote-audio') as HTMLAudioElement;
      audio.srcObject = stream;
    });

    // Handle data channel messages
    this.manager.on(WebRtcManager.EVENT_DATA_CHANNEL_MESSAGE, ({ data }) => {
      console.log('Received message:', data);
    });

    // Handle reconnection
    this.manager.on(WebRtcManager.EVENT_RECONNECTING, ({ attempt, strategy }) => {
      console.log(`Reconnecting (attempt ${attempt}, strategy: ${strategy})`);
      if (strategy === 'full') {
        // For full reconnection, we need to re-do the signaling handshake
        this.createOffer();
      }
    });
  }

  async createOffer() {
    await this.manager.initialize();
    await this.manager.connect();
    const offer = await this.manager.createOffer();
    await this.manager.setLocalDescription(offer);

    this.signalingChannel.send(JSON.stringify({
      type: 'offer',
      offer,
    }));
  }

  async handleOffer(offer: RTCSessionDescriptionInit) {
    await this.manager.initialize();
    await this.manager.setRemoteDescription(offer);
    const answer = await this.manager.createAnswer();
    await this.manager.setLocalDescription(answer);

    this.signalingChannel.send(JSON.stringify({
      type: 'answer',
      answer,
    }));
  }

  sendMessage(text: string) {
    this.manager.sendData('chat', text);
  }

  disconnect() {
    this.manager.disconnect();
    this.signalingChannel.close();
  }
}

// Usage
const connection = new P2PConnection('wss://your-signaling-server.com');
await connection.createOffer();
connection.sendMessage('Hello!');
```

## State Machine

The manager uses a finite state machine with the following states:

```
IDLE → INITIALIZING → CONNECTING → CONNECTED
  ↑         ↓            ↓            ↓
  └─────────────────────────────────────
                (RESET)

ERROR ──(RESET)──→ IDLE
DISCONNECTED ──(RESET)──→ IDLE
RECONNECTING ──(CONNECT)──→ CONNECTING
```

## License

MIT