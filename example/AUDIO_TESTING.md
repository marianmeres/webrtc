# WebRTC Audio Testing

Comprehensive audio testing interface for the WebRTC Manager.

## Files

- **audio-peer1.html** - Caller interface (blue theme)
- **audio-peer2.html** - Answerer interface (green theme)
- **audio-peer.ts** - Shared TypeScript implementation

## Features Tested

### Audio Management
- ✅ Enable/disable microphone
- ✅ List available audio input devices
- ✅ Hot-swap between microphones without dropping connection
- ✅ Real-time audio visualization (frequency bars)
- ✅ Audio level meters

### Connection Management
- ✅ Initialize peer connection
- ✅ Create offer/answer
- ✅ ICE candidate exchange
- ✅ Connection state tracking
- ✅ Disconnect and reset

### Real-time Statistics
- 📊 Bytes sent/received
- 📊 Audio levels (local and remote)
- 📊 Connection stats

### Event Monitoring
- 📝 All WebRTC events logged with timestamps
- 📝 Color-coded logs (info/success/error)

## Setup Instructions

### Option 1: Same Browser (Two Windows/Tabs) - LocalStorage Signaling

**⚠️ Important:** Only ONE browser tab can access the microphone at a time. You'll get audio from only one peer.

1. **Build the TypeScript:**
   ```bash
   deno task build:example
   ```

2. **Serve the files:**
   ```bash
   cd example
   python3 -m http.server 8000
   ```

3. **Open two browser windows:**
   - Window 1: `http://localhost:8000/audio-peer1.html`
   - Window 2: `http://localhost:8000/audio-peer2.html`

4. **In both windows:**
   - Signaling Mode: **LocalStorage** (default)
   - Click **"Enable Microphone"** and grant permissions
   - Click **"Initialize"**

5. **Test the flow:**
   - In Peer 1, click **"Create Offer"**
   - In Peer 2, click **"Create Answer"**
   - ✅ Connection established (but only one tab gets real microphone)

### Option 2: Different Browsers - HTTP Server Signaling (RECOMMENDED)

**✅ Best for testing on same computer with real audio from both sides!**

1. **Build the TypeScript:**
   ```bash
   deno task build:example
   ```

2. **Start the signaling server:**
   ```bash
   deno task serve:example
   ```

   The server will start on `http://localhost:8000` and serve both the HTML files and signaling API.

3. **Open in different browsers:**
   - Chrome: `http://localhost:8000/audio-peer1.html`
   - Firefox: `http://localhost:8000/audio-peer2.html`

4. **In both browsers:**
   - Signaling Mode: **HTTP Server**
   - Click **"Enable Microphone"** and grant permissions
   - Click **"Initialize"**

5. **Test the flow:**
   - In Peer 1 (Chrome), click **"Create Offer"**
   - In Peer 2 (Firefox), click **"Create Answer"**
   - ✅ You should now hear audio from both sides!

### Option 3: Two Devices on Same Network - HTTP Server Signaling

1. **Build and start signaling server** on host machine (same as Option 2)

2. **Find your local IP:**
   ```bash
   # macOS/Linux:
   ifconfig | grep inet
   # Look for something like: 192.168.1.x

   # Windows:
   ipconfig
   ```

3. **Open on devices:**
   - Device 1: `http://YOUR_IP:8000/audio-peer1.html`
   - Device 2: `http://YOUR_IP:8000/audio-peer2.html`

4. **In both devices:**
   - Signaling Mode: **HTTP Server**
   - Follow the same testing flow as Option 2

## Testing Checklist

### Basic Audio
- [ ] Enable microphone on both peers
- [ ] See local audio visualization (frequency bars)
- [ ] Establish connection
- [ ] Hear remote peer's audio
- [ ] See remote audio visualization

### Device Switching
- [ ] Switch between different microphones
- [ ] Verify audio continues without reconnection
- [ ] Check that device dropdown updates when devices change

### Mute/Unmute
- [ ] Disable microphone
- [ ] Verify remote peer stops hearing you
- [ ] Re-enable microphone
- [ ] Verify audio resumes

### Connection Lifecycle
- [ ] Initialize → Connect → Disconnect → Reset
- [ ] Verify all state transitions
- [ ] Check that resources are cleaned up

### Error Handling
- [ ] Try to enable microphone without permissions
- [ ] Try to create offer before initialization
- [ ] Disconnect during active call

## Signaling Modes

This demo supports **two signaling modes**:

### LocalStorage Mode (Default)
- ✅ Works for two tabs/windows in the **same browser**
- ❌ Does NOT work across different browsers (Chrome ↔ Firefox)
- ⚠️ Browser limitation: Only one tab can access microphone at a time

### HTTP Server Mode (Recommended for Testing)
- ✅ Works across **different browsers** on same computer
- ✅ Works across **different devices** on same network
- ✅ Both peers can use their microphone simultaneously
- 📦 Requires running the signaling server script

The signaling server ([scripts/signaling-server.ts](../scripts/signaling-server.ts)) is a simple HTTP server that stores signaling data (offers, answers, ICE candidates) in memory and serves it via REST API. For production, you would use a more robust signaling solution (WebSocket, Socket.io, etc.).

## Troubleshooting

### No audio heard
1. Check browser permissions for microphone
2. Verify both peers have enabled microphone
3. Check browser console for errors
4. Ensure connection state shows "CONNECTED"

### Microphone not listed
1. Grant browser microphone permissions
2. Check that physical microphone is connected
3. Try refreshing the page

### Connection fails
1. Clear localStorage and refresh both pages
2. Check browser console for errors
3. Verify both peers are on the same network (for cross-device testing)

## Browser Compatibility

Tested on:
- ✅ Chrome/Edge (recommended)
- ✅ Firefox
- ✅ Safari

**Note:** Microphone permissions must be granted on HTTPS or localhost.
