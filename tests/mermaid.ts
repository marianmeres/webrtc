import { WebRTCManager } from "../src/webrtc-manager.ts";
import { MockWebRTCFactory } from "./mocks.ts";

const factory = new MockWebRTCFactory();
const manager = new WebRTCManager(factory);

console.log(manager.toMermaid());
