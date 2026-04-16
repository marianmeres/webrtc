import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { WebRTCManager } from "../src/webrtc-manager.ts";
import { WebRTCState, type Logger } from "../src/types.ts";
import { MockWebRTCFactory, type MockRTCPeerConnection } from "./mocks.ts";
import { createClog } from "@marianmeres/clog";

// do not debug
createClog.global.debug = false;

Deno.test("Initial State", () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);
	assertEquals(manager.state, WebRTCState.IDLE);
	// console.log(manager.toMermaid());
});

Deno.test("Initialize and Connect", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	let stateChangeCount = 0;
	manager.on("state_change", (state) => {
		stateChangeCount++;
		// console.log("State changed to:", state);
	});

	await manager.initialize();
	assertEquals(manager.state, WebRTCState.INITIALIZING);

	await manager.connect();
	assertEquals(manager.state, WebRTCState.CONNECTING);
});

Deno.test("Audio Handling", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	await manager.initialize();

	let localStream: MediaStream | null = null;
	manager.on("local_stream", (stream) => {
		localStream = stream;
	});

	// Enable microphone
	await manager.enableMicrophone(true);
	assertExists(localStream);
	// deno-lint-ignore no-explicit-any
	assertEquals((localStream as any).getAudioTracks().length, 1);

	// Disable microphone
	await manager.enableMicrophone(false);
	assertEquals(localStream, null);
});

Deno.test("PubSub Notifications", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	const events: string[] = [];
	manager.on("state_change", (state) => events.push(`state:${state}`));
	manager.on("local_stream", (stream) =>
		events.push(`stream:${stream ? "active" : "inactive"}`)
	);

	await manager.initialize();
	await manager.enableMicrophone(true);

	assertEquals(events.includes(`state:${WebRTCState.INITIALIZING}`), true);
	assertEquals(events.includes("stream:active"), true);
});

Deno.test("Data Channel", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory, {
		dataChannelLabel: "chat",
	});

	let dcOpen = false;
	let lastMessage = "";

	manager.on("data_channel_open", (dc) => {
		dcOpen = true;
		assertEquals(dc.label, "manual-chat");
	});

	manager.on("data_channel_message", ({ channel, data }) => {
		assertEquals(channel.label, "manual-chat");
		lastMessage = data;
	});

	await manager.initialize();
	// Data channel is created on initialize if configured
	// In mocks, it's synchronous, but events might be async or require manual trigger in real world.
	// Our mock DC fires events manually if we call them.
	// But wait, createDataChannel returns the DC.
	// The manager sets up listeners.

	// We need to trigger the open event on the DC created internally.
	// Since we don't have direct access to the DC instance from outside easily without peeking,
	// we can use the return value of createDataChannel if we called it manually,
	// OR we rely on the fact that we passed config.

	// Let's call createDataChannel manually to get the instance and trigger events
	const dc = manager.createDataChannel("manual-chat");
	assertExists(dc);

	// Trigger open
	// deno-lint-ignore no-explicit-any
	(dc as any).dispatchEvent(new Event("open")); // The mock extends EventTarget but we need to ensure onopen is called.
	// The mock implementation of EventTarget might not call the onopen property automatically unless we implement it.
	// Let's check our MockRTCDataChannel implementation.
	// It has onopen/onmessage properties but doesn't automatically trigger them on dispatchEvent unless we wire it up.
	// Actually, standard EventTarget doesn't call on<event> properties.
	// But our WebRTCManager sets dc.onopen = ...
	// So if we call dc.onopen(), it should work.

	// deno-lint-ignore no-explicit-any
	if (dc!.onopen) dc!.onopen(new Event("open") as any);
	assertEquals(dcOpen, true);

	if (dc!.onmessage) dc!.onmessage({ data: "hello" } as MessageEvent);
	assertEquals(lastMessage, "hello");
});

Deno.test("Custom Logger - debug logs are sent to logger", async () => {
	const factory = new MockWebRTCFactory();
	// deno-lint-ignore no-explicit-any
	const logs: { level: string; args: any[] }[] = [];

	const customLogger: Logger = {
		debug: (...args) => {
			logs.push({ level: "debug", args });
			return String(args[0] ?? "");
		},
		log: (...args) => {
			logs.push({ level: "log", args });
			return String(args[0] ?? "");
		},
		warn: (...args) => {
			logs.push({ level: "warn", args });
			return String(args[0] ?? "");
		},
		error: (...args) => {
			logs.push({ level: "error", args });
			return String(args[0] ?? "");
		},
	};

	const manager = new WebRTCManager(factory, {
		logger: customLogger,
	});

	await manager.initialize();

	// Should have debug logs from initialization
	const debugLogs = logs.filter((l) => l.level === "debug");
	assertEquals(debugLogs.length > 0, true);
	assertEquals(debugLogs[0].args[0], "[WebRTCManager]");
});

Deno.test("Custom Logger - errors are logged via logger", async () => {
	const factory = new MockWebRTCFactory();
	// deno-lint-ignore no-explicit-any
	const logs: { level: string; args: any[] }[] = [];

	const customLogger: Logger = {
		debug: (...args) => {
			logs.push({ level: "debug", args });
			return String(args[0] ?? "");
		},
		log: (...args) => {
			logs.push({ level: "log", args });
			return String(args[0] ?? "");
		},
		warn: (...args) => {
			logs.push({ level: "warn", args });
			return String(args[0] ?? "");
		},
		error: (...args) => {
			logs.push({ level: "error", args });
			return String(args[0] ?? "");
		},
	};

	const manager = new WebRTCManager(factory, {
		logger: customLogger,
	});

	// Try to switch microphone without initialization (should log error)
	await manager.switchMicrophone("test-device");

	// Should have error log
	const errorLogs = logs.filter((l) => l.level === "error");
	assertEquals(errorLogs.length > 0, true);
	// Error logs include the prefix in the message
	assertEquals(
		String(errorLogs[0].args[0]).startsWith("[WebRTCManager]"),
		true
	);
});

Deno.test(
	"Default Logger - falls back to console when no logger provided",
	() => {
		const factory = new MockWebRTCFactory();

		// Should not throw when no logger is provided
		const manager = new WebRTCManager(factory);

		assertEquals(manager.state, WebRTCState.IDLE);
	}
);

// --- gatherIceCandidates tests ---

Deno.test(
	"gatherIceCandidates - resolves when gathering complete",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory);

		await manager.initialize();

		// Get the mock peer connection
		const pc = manager.peerConnection as unknown as MockRTCPeerConnection;

		// Start gathering and simulate completion
		const gatherPromise = manager.gatherIceCandidates();

		// Simulate ICE gathering completion
		pc.simulateIceGathering();

		// Should resolve without error
		await gatherPromise;
	}
);

Deno.test(
	"gatherIceCandidates - calls onCandidate only for real candidates (not the null sentinel)",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory);

		await manager.initialize();

		const pc = manager.peerConnection as unknown as MockRTCPeerConnection;

		const candidates: RTCIceCandidate[] = [];
		const mockCandidate1 = { candidate: "candidate1" } as RTCIceCandidate;
		const mockCandidate2 = { candidate: "candidate2" } as RTCIceCandidate;

		const gatherPromise = manager.gatherIceCandidates({
			onCandidate: (candidate) => {
				candidates.push(candidate);
			},
		});

		pc.simulateIceGathering([mockCandidate1, mockCandidate2]);

		await gatherPromise;

		// End-of-gathering is signaled by the promise resolving; null is not forwarded.
		assertEquals(candidates.length, 2);
		assertEquals(candidates[0], mockCandidate1);
		assertEquals(candidates[1], mockCandidate2);
	}
);

Deno.test(
	"gatherIceCandidates - resolveOnTimeout resolves instead of rejecting",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory);
		await manager.initialize();

		// Don't simulate gathering completion; timeout should resolve.
		await manager.gatherIceCandidates({
			timeout: 30,
			resolveOnTimeout: true,
		});
	}
);

Deno.test("gatherIceCandidates - throws on timeout", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	await manager.initialize();

	// Use a very short timeout and don't simulate gathering completion
	await assertRejects(
		() => manager.gatherIceCandidates({ timeout: 50 }),
		Error,
		"ICE gathering timeout"
	);
});

Deno.test(
	"gatherIceCandidates - resolves immediately if already complete",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory);

		await manager.initialize();

		const pc = manager.peerConnection as unknown as MockRTCPeerConnection;

		// Set state to complete before calling gatherIceCandidates
		pc.iceGatheringState = "complete";

		// Should resolve immediately
		await manager.gatherIceCandidates();
	}
);

Deno.test(
	"gatherIceCandidates - throws if peer connection not initialized",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory);

		// Don't initialize - peer connection is null

		await assertRejects(
			() => manager.gatherIceCandidates(),
			Error,
			"Peer connection not initialized"
		);
	}
);

// --- Bug fix regression tests ---

Deno.test("reset() works from INITIALIZING state", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	await manager.initialize();
	assertEquals(manager.state, WebRTCState.INITIALIZING);

	manager.reset();
	assertEquals(manager.state, WebRTCState.IDLE);
});

Deno.test("reset() works from CONNECTING state", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	await manager.connect();
	assertEquals(manager.state, WebRTCState.CONNECTING);

	manager.reset();
	assertEquals(manager.state, WebRTCState.IDLE);
});

Deno.test("reset() works from CONNECTED state", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	await manager.connect();
	const pc = manager.peerConnection as unknown as MockRTCPeerConnection;
	pc.simulateConnectionState("connected");
	assertEquals(manager.state, WebRTCState.CONNECTED);

	manager.reset();
	assertEquals(manager.state, WebRTCState.IDLE);
});

Deno.test(
	"onconnectionstatechange 'connected' transitions RECONNECTING -> CONNECTED",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory, {
			autoReconnect: true,
			reconnectDelay: 1,
		});

		await manager.connect();
		const pc = manager.peerConnection as unknown as MockRTCPeerConnection;
		pc.simulateConnectionState("connected");
		assertEquals(manager.state, WebRTCState.CONNECTED);

		// Drive into RECONNECTING via a failure.
		pc.simulateConnectionState("failed");
		// Wait one tick + the configured reconnectDelay to let the reconnect fire.
		await new Promise((r) => setTimeout(r, 20));
		assertEquals(manager.state, WebRTCState.RECONNECTING);

		// ICE restart succeeds: connectionState flips back to connected while the
		// FSM is still RECONNECTING. This used to be silently ignored.
		pc.simulateConnectionState("connected");
		assertEquals(manager.state, WebRTCState.CONNECTED);
	}
);

Deno.test("cleanup publishes null for local_stream and remote_stream", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	await manager.initialize();
	await manager.enableMicrophone(true);

	// Seed a remote stream via ontrack simulation.
	const pc = manager.peerConnection as unknown as MockRTCPeerConnection;
	const mockStream = { id: "remote-1", getTracks: () => [] } as unknown as MediaStream;
	pc.simulateTrack({ kind: "audio" } as MediaStreamTrack, mockStream);

	const localEvents: (MediaStream | null)[] = [];
	const remoteEvents: (MediaStream | null)[] = [];
	manager.on("local_stream", (s) => localEvents.push(s));
	manager.on("remote_stream", (s) => remoteEvents.push(s));

	manager.disconnect();

	assertEquals(localEvents.includes(null), true);
	assertEquals(remoteEvents.includes(null), true);
});

Deno.test(
	"#reconnectAttempts resets when user calls connect() after exhausting attempts",
	async () => {
		const factory = new MockWebRTCFactory();
		const manager = new WebRTCManager(factory, {
			autoReconnect: true,
			maxReconnectAttempts: 1,
			reconnectDelay: 1,
		});

		let reconnectFailedCount = 0;
		manager.on("reconnect_failed", () => {
			reconnectFailedCount++;
		});

		await manager.connect();
		let pc = manager.peerConnection as unknown as MockRTCPeerConnection;
		pc.simulateConnectionState("connected");
		pc.simulateConnectionState("failed");
		// Wait for reconnect + failure.
		await new Promise((r) => setTimeout(r, 20));
		pc.simulateConnectionState("failed");
		await new Promise((r) => setTimeout(r, 20));
		assertEquals(reconnectFailedCount, 1);

		// User explicitly reconnects - counter should reset so the next failure
		// triggers another reconnection attempt, not an immediate reconnect_failed.
		manager.reset();
		await manager.connect();
		pc = manager.peerConnection as unknown as MockRTCPeerConnection;
		pc.simulateConnectionState("connected");
		pc.simulateConnectionState("failed");
		await new Promise((r) => setTimeout(r, 20));
		// Not exhausted yet — one more attempt was allowed.
		assertEquals(reconnectFailedCount, 1);
	}
);

Deno.test("dispose() unsubscribes all listeners", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);

	let stateEvents = 0;
	manager.on("state_change", () => {
		stateEvents++;
	});

	await manager.initialize();
	const beforeDispose = stateEvents;

	manager.dispose();

	// Post-dispose: trigger another pubsub publish directly via another init —
	// but manager is IDLE after dispose, so this would re-run the flow. Instead,
	// assert the subscriber no longer fires by making a fresh state change.
	await manager.initialize();
	assertEquals(stateEvents, beforeDispose);
});

Deno.test("switchMicrophone promotes recvonly transceiver to sendrecv", async () => {
	const factory = new MockWebRTCFactory();
	// Default: audioDirection is recvonly.
	const manager = new WebRTCManager(factory);
	await manager.initialize();
	await manager.enableMicrophone(true);

	const pc = manager.peerConnection as unknown as MockRTCPeerConnection;

	// Simulate a recvonly transceiver (as if enableMicrophone was off initially
	// and the transceiver was added recvonly). Force direction recvonly.
	const tx = pc.getTransceivers()[0];
	if (tx) {
		(tx as unknown as { direction: string }).direction = "recvonly";
	}

	const ok = await manager.switchMicrophone("mic1");
	assertEquals(ok, true);
	if (tx) {
		assertEquals(
			(tx as unknown as { direction: string }).direction,
			"sendrecv"
		);
	}
});

Deno.test("audioDirection config respected on initialize", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory, {
		audioDirection: "sendrecv",
	});
	await manager.initialize();

	const pc = manager.peerConnection as unknown as MockRTCPeerConnection;
	const tx = pc.getTransceivers()[0];
	assertEquals(
		(tx as unknown as { direction: string }).direction,
		"sendrecv"
	);
});

Deno.test("iceRestart emits ice_restart_offer event", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);
	await manager.initialize();

	// deno-lint-ignore no-explicit-any
	let forwardedOffer: any = null;
	manager.on("ice_restart_offer", (offer) => {
		forwardedOffer = offer;
	});

	const ok = await manager.iceRestart();
	assertEquals(ok, true);
	assertExists(forwardedOffer);
	assertEquals(forwardedOffer.type, "offer");
});

Deno.test("negotiation_needed event is forwarded", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);
	await manager.initialize();

	let fired = 0;
	manager.on("negotiation_needed", () => {
		fired++;
	});

	const pc = manager.peerConnection as unknown as MockRTCPeerConnection;
	pc.simulateNegotiationNeeded();
	assertEquals(fired, 1);
});

Deno.test("remoteStreams accumulates multiple remote streams", async () => {
	const factory = new MockWebRTCFactory();
	const manager = new WebRTCManager(factory);
	await manager.initialize();

	const pc = manager.peerConnection as unknown as MockRTCPeerConnection;
	const s1 = { id: "stream-1", getTracks: () => [] } as unknown as MediaStream;
	const s2 = { id: "stream-2", getTracks: () => [] } as unknown as MediaStream;

	pc.simulateTrack({ kind: "audio" } as MediaStreamTrack, s1);
	pc.simulateTrack({ kind: "video" } as MediaStreamTrack, s2);

	assertEquals(manager.remoteStreams.size, 2);
	// Legacy single-stream getter still points at the first.
	assertEquals(manager.remoteStream?.id, "stream-1");
});
