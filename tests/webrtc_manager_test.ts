import { assertEquals, assertExists } from "@std/assert";
import { WebRtcManager } from "../src/webrtc_manager.ts";
import { WebRtcState } from "../src/types.ts";
import { MockWebRtcFactory } from "./mocks.ts";

Deno.test("WebRtcManager - Initial State", () => {
    const factory = new MockWebRtcFactory();
    const manager = new WebRtcManager(factory);
    assertEquals(manager.state, WebRtcState.IDLE);
});

Deno.test("WebRtcManager - Initialize and Connect", async () => {
    const factory = new MockWebRtcFactory();
    const manager = new WebRtcManager(factory);
    
    let stateChangeCount = 0;
    manager.on("state_change", (state) => {
        stateChangeCount++;
        // console.log("State changed to:", state);
    });

    await manager.initialize();
    assertEquals(manager.state, WebRtcState.INITIALIZING);

    await manager.connect();
    assertEquals(manager.state, WebRtcState.CONNECTING);
});

Deno.test("WebRtcManager - Audio Handling", async () => {
    const factory = new MockWebRtcFactory();
    const manager = new WebRtcManager(factory);
    
    await manager.initialize();
    
    let localStream: MediaStream | null = null;
    manager.on("local_stream", (stream) => {
        localStream = stream;
    });

    // Enable microphone
    await manager.enableMicrophone(true);
    assertExists(localStream);
    assertEquals((localStream as any).getAudioTracks().length, 1);

    // Disable microphone
    await manager.enableMicrophone(false);
    assertEquals(localStream, null);
});

Deno.test("WebRtcManager - PubSub Notifications", async () => {
    const factory = new MockWebRtcFactory();
    const manager = new WebRtcManager(factory);
    
    const events: string[] = [];
    manager.on("state_change", (state) => events.push(`state:${state}`));
    manager.on("local_stream", (stream) => events.push(`stream:${stream ? 'active' : 'inactive'}`));

    await manager.initialize();
    await manager.enableMicrophone(true);
    
    assertEquals(events.includes(`state:${WebRtcState.INITIALIZING}`), true);
    assertEquals(events.includes("stream:active"), true);
});

Deno.test("WebRtcManager - Data Channel", async () => {
    const factory = new MockWebRtcFactory();
    const manager = new WebRtcManager(factory, {
        dataChannelLabel: "chat"
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
    (dc as any).dispatchEvent(new Event("open")); // The mock extends EventTarget but we need to ensure onopen is called.
    // The mock implementation of EventTarget might not call the onopen property automatically unless we implement it.
    // Let's check our MockRTCDataChannel implementation.
    // It has onopen/onmessage properties but doesn't automatically trigger them on dispatchEvent unless we wire it up.
    // Actually, standard EventTarget doesn't call on<event> properties.
    // But our WebRtcManager sets dc.onopen = ...
    // So if we call dc.onopen(), it should work.
    
    if (dc!.onopen) dc!.onopen(new Event("open") as any);
    assertEquals(dcOpen, true);

    if (dc!.onmessage) dc!.onmessage({ data: "hello" } as MessageEvent);
    assertEquals(lastMessage, "hello");
});
