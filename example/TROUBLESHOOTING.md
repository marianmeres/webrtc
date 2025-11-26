# Audio Testing Troubleshooting Guide

## Issue: "No audio sender found" when switching microphones

### Cause
This happens when trying to switch microphones before properly enabling the microphone after initialization.

### Solution
**Correct order of operations:**

1. Click "Initialize" (sets up peer connection with receive-only audio transceiver)
2. Click "Enable Microphone" (this upgrades the transceiver to send+receive)
3. NOW you can switch microphones

**Why this happens:**
- When you initialize without microphone, a "recvonly" audio transceiver is created
- The microphone must be enabled first to set up the sender properly
- Then switching works by replacing the track in that sender

### Fixed in latest version
The code now properly handles:
- Finding the audio sender via transceivers if direct lookup fails
- Upgrading recvonly transceiver to sendrecv when enabling microphone
- Clear error message if microphone wasn't enabled first

## Issue: Remote visualization not showing

### Common Causes

1. **Remote peer hasn't enabled their microphone**
   - Both peers MUST enable microphone for two-way audio
   - Check event logs: should see "Local stream has 1 audio track(s)"

2. **Connection not established**
   - State should be "CONNECTED"
   - Check event logs for connection errors

3. **AudioContext suspended**
   - Some browsers suspend AudioContext until user interaction
   - Click any button to resume

4. **Remote stream has no audio tracks**
   - Check logs for "Remote stream has X audio tracks"
   - If 0 tracks, remote peer didn't enable microphone before connecting

### Debugging Steps

1. **Check Event Logs** - Look for these messages:
   ```
   [time] Remote stream received
   [time] Remote stream ID: ...
   [time] Remote audio tracks: 1
   [time] Remote stream has 1 audio track(s)
   [time] Remote audio visualization ready
   ```

2. **Verify Audio is Playing**
   - Can you hear the remote peer?
   - If yes but no visualization → visualization setup issue
   - If no → connection/transmission issue

3. **Check Browser Console**
   - Open DevTools (F12)
   - Look for errors in console
   - Check for AudioContext warnings

4. **Test Local First**
   - Your local visualization should work immediately
   - Speak and watch for green/yellow bars
   - If local doesn't work, microphone permission issue

## Correct Connection Flow

### Peer 1 (Caller)
1. Click "Enable Microphone" (grant permissions)
2. Click "Initialize"
3. Click "Create Offer"
4. Wait for Peer 2...

### Peer 2 (Answerer)
1. Click "Enable Microphone" (grant permissions)
2. Click "Initialize"
3. Click "Create Answer"
4. Connection established!

### Expected Results
- State: CONNECTED on both
- Local visualization: Shows YOUR voice
- Remote visualization: Shows OTHER peer's voice
- Audio element: Plays remote audio
- Stats: Shows bytes sent/received increasing

## Browser-Specific Issues

### Chrome/Edge
- Usually works best
- Requires HTTPS or localhost for getUserMedia

### Firefox
- May require manual AudioContext resume
- Check for "AudioContext was not allowed to start" in console

### Safari
- Strictest with permissions
- May need to click button twice to activate AudioContext
- Check Settings → Website → Microphone

## Network Issues

### Same Computer (Two Windows)
- Should work immediately via localhost
- Uses localStorage for signaling

### Different Devices (Local Network)
- Both must be on same WiFi network
- Find computer's local IP: `ipconfig` or `ifconfig`
- Access via `http://192.168.x.x:8000/audio-peer1.html`
- Firewall may block connections - check port 8000

### No Audio Received
1. Check ICE candidates are exchanging
   - Logs should show "ICE candidate generated"
2. Check connection state reaches "connected"
3. Verify STUN server is working
   - Using Google's: `stun:stun.l.google.com:19302`

## Still Not Working?

### Reset Everything
1. Click "Reset" on both peers
2. Clear browser localStorage:
   - Open DevTools → Application → Storage → Local Storage
   - Delete all keys starting with `webrtc_audio_`
3. Refresh both pages
4. Start over from step 1

### Check Microphone
1. Test in another app (e.g., sound recorder)
2. Check system microphone settings
3. Try different microphone from dropdown

### Enable Debug Mode
The manager is already running with `debug: true`, so check browser console for detailed logs from `[WebRtcManager]`.

## Quick Checklist

- [ ] Both peers opened in separate windows/devices
- [ ] Both peers granted microphone permissions
- [ ] Both peers clicked "Enable Microphone"
- [ ] Both peers clicked "Initialize"
- [ ] Peer 1 clicked "Create Offer"
- [ ] Peer 2 clicked "Create Answer"
- [ ] State shows "CONNECTED" on both
- [ ] Can hear audio from remote peer
- [ ] Local visualization shows green/yellow bars when speaking
- [ ] Remote visualization shows activity when remote speaks
- [ ] Stats show bytes increasing

If all checked and still not working, check the browser console for errors and the event logs for clues!
