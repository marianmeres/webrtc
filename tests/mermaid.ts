import { WebRtcManager } from "../src/webrtc-manager.ts";
import { MockWebRtcFactory } from "./mocks.ts";

const factory = new MockWebRtcFactory();
const manager = new WebRtcManager(factory);

console.log(manager.toMermaid());
