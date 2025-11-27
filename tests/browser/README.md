# Browser-Based WebRTC Tests

This directory contains integration tests that run in a real browser environment, testing actual peer-to-peer WebRTC connections.

## Why Browser Tests?

The standard unit tests in `tests/` use mocks to test the manager's logic and state transitions. These browser tests use real WebRTC APIs to verify:

- Actual P2P connections between peers
- Real data channel communication
- ICE candidate exchange
- Connection state transitions
- Resource cleanup

## Running the Tests

### Option 1: Using the Deno task (recommended)

```bash
deno task test:browser
```

This will:
1. Build the test bundle from TypeScript
2. Start a local server on http://localhost:8001
3. Open http://localhost:8001/tests/browser/test-runner.html in your browser

### Option 2: Manual steps

1. Build the tests:
```bash
deno run -A scripts/build-browser-tests.ts
```

2. Start the server:
```bash
deno run -A scripts/serve-browser-tests.ts
```

3. Open http://localhost:8001/tests/browser/test-runner.html in your browser

## Test Coverage

The current test suite includes:

1. **Data channel sends and receives messages** - Verifies bidirectional message exchange
2. **ICE candidates are properly exchanged** - Tests ICE candidate generation and properties
3. **Connection goes through proper state transitions** - Validates FSM state flow
4. **Full peer-to-peer connection is established** - Tests complete connection setup
5. **Data channel state is properly tracked** - Verifies channel lifecycle events
6. **Multiple messages can be exchanged rapidly** - Tests message ordering and throughput
7. **Disconnect cleans up resources properly** - Validates cleanup logic

## Writing New Tests

Tests are defined in `p2p-tests.ts`. Each test is an object with:

```typescript
{
  name: "Test description",
  run: async () => {
    // Test implementation
    const peer1 = new WebRtcManager(new BrowserWebRtcFactory());
    const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

    try {
      await setupPeerConnection(peer1, peer2);
      // Your test logic here
      assert(condition, "message");
    } finally {
      peer1.disconnect();
      peer2.disconnect();
    }
  }
}
```

### Utility Functions

- `setupPeerConnection(peer1, peer2)` - Establishes a full P2P connection
- `waitForState(manager, state, timeout)` - Waits for a specific state
- `waitForEvent(manager, event, timeout)` - Waits for a specific event
- `assertEquals(actual, expected, message)` - Assertion helper
- `assert(condition, message)` - Boolean assertion helper

## Limitations

- Tests run in a single browser window with two peer instances in the same process
- Uses loopback networking (not testing NAT traversal)
- No TURN server testing (uses local ICE candidates only)
- Tests are sequential, not parallel

## Browser Compatibility

Tests should work in any modern browser with WebRTC support:
- Chrome/Edge 80+
- Firefox 75+
- Safari 14+

## Troubleshooting

### Tests fail to connect

- Check browser console for errors
- Ensure no firewall is blocking WebRTC
- Try a different browser

### Build errors

- Ensure Deno is up to date: `deno upgrade`
- Clear esbuild cache if needed

### Port already in use

The test server uses port 8001. If it's in use, edit `scripts/serve-browser-tests.ts` to change the port.
