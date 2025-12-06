import { WebRtcManager } from "../../src/webrtc-manager.ts";
import { WebRtcState } from "../../src/types.ts";

// Browser WebRTC Factory - uses real browser APIs
class BrowserWebRtcFactory {
	createPeerConnection(config?: RTCConfiguration): RTCPeerConnection {
		return new RTCPeerConnection(config);
	}

	getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
		return navigator.mediaDevices.getUserMedia(constraints);
	}

	enumerateDevices(): Promise<MediaDeviceInfo[]> {
		return navigator.mediaDevices.enumerateDevices();
	}
}

// Test utilities
interface TestResult {
	name: string;
	status: "running" | "pass" | "fail";
	error?: string;
	duration?: number;
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
	if (actual !== expected) {
		throw new Error(message || `Expected ${expected}, but got ${actual}`);
	}
}

function assert(condition: boolean, message?: string) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function waitForState(
	manager: WebRtcManager,
	state: WebRtcState,
	timeout = 5000
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (manager.state === state) {
			resolve();
			return;
		}

		const timer = setTimeout(() => {
			unsub();
			reject(
				new Error(
					`Timeout waiting for state ${state}, current: ${manager.state}`
				)
			);
		}, timeout);

		const unsub = manager.on("state_change", (newState) => {
			if (newState === state) {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
	});
}

function waitForEvent(
	manager: WebRtcManager,
	event: string,
	timeout = 5000
): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`Timeout waiting for event ${event}`));
		}, timeout);

		const unsub = manager.on(event as any, (data) => {
			clearTimeout(timer);
			unsub();
			resolve(data);
		});
	});
}

async function setupPeerConnection(
	peer1: WebRtcManager,
	peer2: WebRtcManager
): Promise<void> {
	// Collect ICE candidates and exchange them immediately
	peer1.on("ice_candidate", async (candidate) => {
		if (candidate) {
			await peer2.addIceCandidate(candidate);
		}
	});

	peer2.on("ice_candidate", async (candidate) => {
		if (candidate) {
			await peer1.addIceCandidate(candidate);
		}
	});

	// Initialize both peers
	await peer1.initialize();
	await peer2.initialize();

	// Transition to connecting state
	await peer1.connect();
	await peer2.connect();

	// Create and exchange offer
	const offer = await peer1.createOffer();
	if (!offer) throw new Error("Failed to create offer");

	await peer1.setLocalDescription(offer);
	await peer2.setRemoteDescription(offer);

	// Create and exchange answer
	const answer = await peer2.createAnswer();
	if (!answer) throw new Error("Failed to create answer");

	await peer2.setLocalDescription(answer);
	await peer1.setRemoteDescription(answer);

	// Wait for both connections to establish
	await Promise.all([
		waitForState(peer1, WebRtcState.CONNECTED, 10000),
		waitForState(peer2, WebRtcState.CONNECTED, 10000),
	]);
}

// Test definitions
const tests = [
	{
		name: "Data channel sends and receives messages",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				dataChannelLabel: "test-channel",
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				// Track received messages
				const peer2Messages: string[] = [];
				peer2.on("data_channel_message", ({ data }) => {
					peer2Messages.push(data);
				});

				// Setup connection
				await setupPeerConnection(peer1, peer2);

				// Wait for peer2's data channel to open
				await waitForEvent(peer2, "data_channel_open");

				// Send message from peer1
				const testMessage = "Hello from peer1!";
				const sent = peer1.sendData("test-channel", testMessage);
				assert(sent, "Failed to send message");

				// Wait a bit for message to arrive
				await new Promise((resolve) => setTimeout(resolve, 500));

				// Verify peer2 received the message
				assert(
					peer2Messages.length === 1,
					`Expected 1 message, got ${peer2Messages.length}`
				);
				assertEquals(peer2Messages[0], testMessage);

				// Send message back from peer2
				const dc2 = peer2.dataChannels.values().next().value;
				assert(!!dc2, "Peer2 should have a data channel");

				const peer1Messages: string[] = [];
				peer1.on("data_channel_message", ({ data }) => {
					peer1Messages.push(data);
				});

				const replyMessage = "Hello back from peer2!";
				dc2!.send(replyMessage);

				await new Promise((resolve) => setTimeout(resolve, 500));

				assert(
					peer1Messages.length === 1,
					`Expected 1 reply message, got ${peer1Messages.length}`
				);
				assertEquals(peer1Messages[0], replyMessage);
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "ICE candidates are properly exchanged",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory());
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				const peer1Candidates: RTCIceCandidate[] = [];
				const peer2Candidates: RTCIceCandidate[] = [];

				peer1.on("ice_candidate", (candidate) => {
					if (candidate) peer1Candidates.push(candidate);
				});

				peer2.on("ice_candidate", (candidate) => {
					if (candidate) peer2Candidates.push(candidate);
				});

				await peer1.initialize();
				await peer2.initialize();

				await peer1.connect();
				await peer2.connect();

				// Create offer/answer to trigger ICE gathering
				const offer = await peer1.createOffer();
				await peer1.setLocalDescription(offer!);
				await peer2.setRemoteDescription(offer!);

				const answer = await peer2.createAnswer();
				await peer2.setLocalDescription(answer!);
				await peer1.setRemoteDescription(answer!);

				// Wait for ICE candidates to be gathered
				await new Promise((resolve) => setTimeout(resolve, 1000));

				// Verify candidates were generated
				assert(
					peer1Candidates.length > 0,
					"Peer1 should generate ICE candidates"
				);
				assert(
					peer2Candidates.length > 0,
					"Peer2 should generate ICE candidates"
				);

				// Verify candidates have required properties
				const candidate = peer1Candidates[0];
				assert(!!candidate.candidate, "Candidate should have SDP string");
				assert(
					candidate.sdpMLineIndex !== null,
					"Candidate should have sdpMLineIndex"
				);
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "Connection goes through proper state transitions",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				const states: WebRtcState[] = [];
				peer1.on("state_change", (state) => {
					states.push(state);
				});

				// Initial state
				assertEquals(peer1.state, WebRtcState.IDLE);

				// Initialize
				await peer1.initialize();
				assertEquals(peer1.state, WebRtcState.INITIALIZING);

				// Connect (without completing the connection)
				await peer1.connect();
				assertEquals(peer1.state, WebRtcState.CONNECTING);

				// Verify state transition history
				assert(
					states.includes(WebRtcState.INITIALIZING),
					"Should transition through INITIALIZING"
				);
				assert(
					states.includes(WebRtcState.CONNECTING),
					"Should transition through CONNECTING"
				);

				// Disconnect
				peer1.disconnect();
				await waitForState(peer1, WebRtcState.DISCONNECTED);

				assert(
					states.includes(WebRtcState.DISCONNECTED),
					"Should transition to DISCONNECTED"
				);
			} finally {
				peer1.reset();
			}
		},
	},

	{
		name: "Full peer-to-peer connection is established",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory());
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				await setupPeerConnection(peer1, peer2);

				// Verify both peers reached CONNECTED state
				assertEquals(peer1.state, WebRtcState.CONNECTED);
				assertEquals(peer2.state, WebRtcState.CONNECTED);

				// Verify peer connections exist
				assert(peer1.peerConnection !== null, "Peer1 should have PC");
				assert(peer2.peerConnection !== null, "Peer2 should have PC");

				// Verify connection states
				assertEquals(peer1.peerConnection!.connectionState, "connected");
				assertEquals(peer2.peerConnection!.connectionState, "connected");
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "Data channel state is properly tracked",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				dataChannelLabel: "test",
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				let peer1ChannelOpen = false;
				let peer2ChannelOpen = false;
				let peer2ChannelClosed = false;

				peer1.on("data_channel_open", (dc) => {
					assertEquals(dc.label, "test");
					peer1ChannelOpen = true;
				});

				peer2.on("data_channel_open", (dc) => {
					assertEquals(dc.label, "test");
					peer2ChannelOpen = true;
				});

				peer2.on("data_channel_close", (dc) => {
					assertEquals(dc.label, "test");
					peer2ChannelClosed = true;
				});

				await setupPeerConnection(peer1, peer2);

				// Wait for channels to open
				await waitForEvent(peer1, "data_channel_open");
				await waitForEvent(peer2, "data_channel_open");

				assert(peer1ChannelOpen, "Peer1 channel should be open");
				assert(peer2ChannelOpen, "Peer2 channel should be open");

				// Verify data channels are in the map
				assertEquals(peer1.dataChannels.size, 1);
				assertEquals(peer2.dataChannels.size, 1);

				// Close peer1 data channel
				const dc1 = peer1.getDataChannel("test");
				assert(!!dc1, "Peer1 should have test channel");
				dc1!.close();

				// Wait for peer2 to detect closure
				await new Promise((resolve) => setTimeout(resolve, 500));

				assert(peer2ChannelClosed, "Peer2 should detect channel closure");
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "Multiple messages can be exchanged rapidly",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				dataChannelLabel: "chat",
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				const peer2Messages: string[] = [];
				peer2.on("data_channel_message", ({ data }) => {
					peer2Messages.push(data);
				});

				await setupPeerConnection(peer1, peer2);
				await waitForEvent(peer2, "data_channel_open");

				// Send multiple messages rapidly
				const messageCount = 10;
				for (let i = 0; i < messageCount; i++) {
					peer1.sendData("chat", `Message ${i}`);
				}

				// Wait for messages to arrive
				await new Promise((resolve) => setTimeout(resolve, 1000));

				// Verify all messages received
				assertEquals(
					peer2Messages.length,
					messageCount,
					`Should receive all ${messageCount} messages`
				);

				// Verify message order
				for (let i = 0; i < messageCount; i++) {
					assertEquals(peer2Messages[i], `Message ${i}`);
				}
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "Disconnect cleans up resources properly",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				dataChannelLabel: "test",
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				await setupPeerConnection(peer1, peer2);
				await waitForEvent(peer2, "data_channel_open");

				// Verify resources exist
				assert(peer1.peerConnection !== null);
				assert(peer1.dataChannels.size > 0);

				// Disconnect
				peer1.disconnect();
				await waitForState(peer1, WebRtcState.DISCONNECTED);

				// Verify cleanup
				assertEquals(peer1.state, WebRtcState.DISCONNECTED);
				assert(
					peer1.peerConnection === null ||
						peer1.peerConnection.connectionState === "closed",
					"PeerConnection should be closed"
				);
				assertEquals(
					peer1.dataChannels.size,
					0,
					"Data channels should be cleared"
				);
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "Reconnection configuration is accepted",
		run: () => {
			// Verify that reconnection configuration options are accepted
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				autoReconnect: true,
				reconnectDelay: 100,
				maxReconnectAttempts: 3,
			});

			try {
				// Register event handlers to verify they can be set up
				const unsubReconnecting = peer1.on("reconnecting", () => {
					// Event handler registered successfully
				});

				const unsubFailed = peer1.on("reconnect_failed", () => {
					// Event handler registered successfully
				});

				// Verify handlers return unsubscribe functions
				assert(
					typeof unsubReconnecting === "function",
					"Should return unsubscribe function"
				);
				assert(
					typeof unsubFailed === "function",
					"Should return unsubscribe function"
				);

				// Unsubscribe
				unsubReconnecting();
				unsubFailed();

				// Note: Actually triggering automatic reconnection in a browser test
				// requires real network failures which are difficult to simulate reliably.
				// This test verifies the configuration and event system are properly set up.
			} finally {
				peer1.reset();
			}
		},
	},

	{
		name: "Manual reconnection after disconnect",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				dataChannelLabel: "test",
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				// Initial connection
				await setupPeerConnection(peer1, peer2);
				assertEquals(peer1.state, WebRtcState.CONNECTED);

				// Disconnect
				peer1.disconnect();
				peer2.disconnect();
				await Promise.all([
					waitForState(peer1, WebRtcState.DISCONNECTED),
					waitForState(peer2, WebRtcState.DISCONNECTED),
				]);

				// Manual reconnection - reset and reinitialize
				peer1.reset();
				peer2.reset();

				// Re-setup connection with new ICE candidate handlers
				await setupPeerConnection(peer1, peer2);

				// Verify both are connected again
				assertEquals(peer1.state, WebRtcState.CONNECTED);
				assertEquals(peer2.state, WebRtcState.CONNECTED);
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "Reconnection preserves data channel functionality",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				dataChannelLabel: "persistent",
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				// Setup message tracking for peer2
				const messages: string[] = [];
				peer2.on("data_channel_message", ({ data }) => {
					messages.push(data);
				});

				// Setup initial connection
				await setupPeerConnection(peer1, peer2);
				// Wait for both peers' data channels to open
				await Promise.all([
					waitForEvent(peer1, "data_channel_open"),
					waitForEvent(peer2, "data_channel_open"),
				]);

				// Send initial message to verify channel works
				peer1.sendData("persistent", "Before reconnect");
				await new Promise((resolve) => setTimeout(resolve, 200));

				// Verify first message received
				assert(messages.length === 1, "Should receive first message");
				assertEquals(messages[0], "Before reconnect");

				// Disconnect and reset
				peer1.disconnect();
				peer2.disconnect();
				await Promise.all([
					waitForState(peer1, WebRtcState.DISCONNECTED),
					waitForState(peer2, WebRtcState.DISCONNECTED),
				]);

				peer1.reset();
				peer2.reset();
				messages.length = 0; // Clear messages

				// Re-setup message handler after reset
				peer2.on("data_channel_message", ({ data }) => {
					messages.push(data);
				});

				// Re-establish connection
				await setupPeerConnection(peer1, peer2);
				// Wait for both peers' data channels to open again
				await Promise.all([
					waitForEvent(peer1, "data_channel_open"),
					waitForEvent(peer2, "data_channel_open"),
				]);

				// Send message after reconnect
				const sent = peer1.sendData("persistent", "After reconnect");
				assert(sent, "Should successfully send message");

				await new Promise((resolve) => setTimeout(resolve, 300));

				// Verify message was received after reconnect
				assert(messages.length > 0, "Should receive message after reconnect");
				assertEquals(messages[0], "After reconnect");
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},

	{
		name: "No auto-reconnection when disabled",
		run: async () => {
			const peer1 = new WebRtcManager(new BrowserWebRtcFactory(), {
				autoReconnect: false, // Explicitly disabled
			});
			const peer2 = new WebRtcManager(new BrowserWebRtcFactory());

			try {
				let reconnectingEmitted = false;
				peer1.on("reconnecting", () => {
					reconnectingEmitted = true;
				});

				await setupPeerConnection(peer1, peer2);
				assertEquals(peer1.state, WebRtcState.CONNECTED);

				// Force connection failure by closing peer2
				peer2.peerConnection?.close();

				// Wait to see if reconnection happens (it shouldn't)
				await new Promise((resolve) => setTimeout(resolve, 1000));

				// Verify no reconnection was attempted
				assert(
					!reconnectingEmitted,
					"Should not emit reconnecting event when disabled"
				);
				assert(
					peer1.state !== WebRtcState.RECONNECTING,
					"Should not enter RECONNECTING state when disabled"
				);
			} finally {
				peer1.reset();
				peer2.reset();
			}
		},
	},
];

// Test runner
export async function runBrowserTests(
	onUpdate: (results: TestResult[]) => void
): Promise<void> {
	const results: TestResult[] = tests.map((t) => ({
		name: t.name,
		status: "running" as const,
	}));

	for (let i = 0; i < tests.length; i++) {
		const test = tests[i];
		const startTime = performance.now();

		try {
			await test.run();
			results[i].status = "pass";
			results[i].duration = Math.round(performance.now() - startTime);
		} catch (error) {
			results[i].status = "fail";
			results[i].error = error instanceof Error ? error.message : String(error);
			results[i].duration = Math.round(performance.now() - startTime);
		}

		onUpdate([...results]);
	}
}
