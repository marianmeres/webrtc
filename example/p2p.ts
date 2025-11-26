import { WebRtcManager } from "../src/webrtc-manager.ts";
import { type WebRtcFactory, WebRtcState } from "../src/types.ts";

// Browser WebRTC Factory
class BrowserWebRtcFactory implements WebRtcFactory {
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

// Simple localStorage-based signaling
const SIGNALING_KEY_OFFER = "webrtc_offer";
const SIGNALING_KEY_ANSWER = "webrtc_answer";
const SIGNALING_KEY_ICE_1 = "webrtc_ice_1";
const SIGNALING_KEY_ICE_2 = "webrtc_ice_2";

// Create both peers
const factory = new BrowserWebRtcFactory();

const peer1 = new WebRtcManager(factory, {
	peerConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
	dataChannelLabel: "chat",
});

const peer2 = new WebRtcManager(factory, {
	peerConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
});

// UI Elements - Peer 1
const status1 = document.getElementById("status1")!;
const logs1 = document.getElementById("logs1")!;
const chat1 = document.getElementById("chat1")!;
const input1 = document.getElementById("input1") as HTMLInputElement;
const btnInit1 = document.getElementById("btn1-init") as HTMLButtonElement;
const btnOffer1 = document.getElementById("btn1-offer") as HTMLButtonElement;
const btnDisconnect1 = document.getElementById(
	"btn1-disconnect"
) as HTMLButtonElement;
const btnSend1 = document.getElementById("btn1-send") as HTMLButtonElement;

// UI Elements - Peer 2
const status2 = document.getElementById("status2")!;
const logs2 = document.getElementById("logs2")!;
const chat2 = document.getElementById("chat2")!;
const input2 = document.getElementById("input2") as HTMLInputElement;
const btnInit2 = document.getElementById("btn2-init") as HTMLButtonElement;
const btnAnswer2 = document.getElementById("btn2-answer") as HTMLButtonElement;
const btnDisconnect2 = document.getElementById(
	"btn2-disconnect"
) as HTMLButtonElement;
const btnSend2 = document.getElementById("btn2-send") as HTMLButtonElement;

// Logging
function log(peer: number, msg: string) {
	const logsEl = peer === 1 ? logs1 : logs2;
	const time = new Date().toISOString().split("T")[1].split(".")[0];
	const div = document.createElement("div");
	div.textContent = `[${time}] ${msg}`;
	logsEl.prepend(div);
	console.log(`Peer ${peer}:`, msg);
}

function addChatMessage(peer: number, msg: string, sent: boolean) {
	const chatEl = peer === 1 ? chat1 : chat2;
	const div = document.createElement("div");
	div.className = `msg ${sent ? "msg-sent" : "msg-received"}`;
	div.textContent = `${sent ? "You" : "Peer"}: ${msg}`;
	chatEl.appendChild(div);
	chatEl.scrollTop = chatEl.scrollHeight;
}

function updateButtons(peer: number, state: WebRtcState) {
	const statusEl = peer === 1 ? status1 : status2;
	const btnInit = peer === 1 ? btnInit1 : btnInit2;
	const btnAction = peer === 1 ? btnOffer1 : btnAnswer2;
	const btnDisconnect = peer === 1 ? btnDisconnect1 : btnDisconnect2;
	const inputEl = peer === 1 ? input1 : input2;
	const btnSend = peer === 1 ? btnSend1 : btnSend2;

	statusEl.textContent = `State: ${state}`;
	btnInit.disabled = state !== WebRtcState.IDLE;
	btnAction.disabled = state !== WebRtcState.INITIALIZING;
	btnDisconnect.disabled =
		state !== WebRtcState.CONNECTED && state !== WebRtcState.CONNECTING;

	const isConnected = state === WebRtcState.CONNECTED;
	inputEl.disabled = !isConnected;
	btnSend.disabled = !isConnected;
}

// Data channels
let dataChannel1: RTCDataChannel | null = null;
let dataChannel2: RTCDataChannel | null = null;

// --- Peer 1 Setup ---
peer1.on("state_change", (state) => {
	log(1, `State: ${state}`);
	updateButtons(1, state);
});

peer1.on("data_channel_open", (dc) => {
	log(1, `Data channel "${dc.label}" opened`);
	dataChannel1 = dc;
});

peer1.on("data_channel_message", ({ data }) => {
	log(1, `Received: ${data}`);
	addChatMessage(1, data, false);
});

peer1.on("ice_candidate", (candidate) => {
	if (candidate) {
		log(1, "Got ICE candidate");
		const existing = JSON.parse(
			localStorage.getItem(SIGNALING_KEY_ICE_1) || "[]"
		);
		existing.push(candidate.toJSON());
		localStorage.setItem(SIGNALING_KEY_ICE_1, JSON.stringify(existing));
	}
});

// --- Peer 2 Setup ---
peer2.on("state_change", (state) => {
	log(2, `State: ${state}`);
	updateButtons(2, state);
});

peer2.on("data_channel_open", (dc) => {
	log(2, `Data channel "${dc.label}" opened`);
	dataChannel2 = dc;
});

peer2.on("data_channel_message", ({ data }) => {
	log(2, `Received: ${data}`);
	addChatMessage(2, data, false);
});

peer2.on("ice_candidate", (candidate) => {
	if (candidate) {
		log(2, "Got ICE candidate");
		const existing = JSON.parse(
			localStorage.getItem(SIGNALING_KEY_ICE_2) || "[]"
		);
		existing.push(candidate.toJSON());
		localStorage.setItem(SIGNALING_KEY_ICE_2, JSON.stringify(existing));
	}
});

// --- Event Handlers ---
btnInit1.onclick = async () => {
	log(1, "Initializing...");
	await peer1.initialize();
};

btnOffer1.onclick = async () => {
	log(1, "Creating offer...");
	await peer1.connect();
	const offer = await peer1.createOffer();
	if (offer) {
		await peer1.setLocalDescription(offer);
		localStorage.setItem(SIGNALING_KEY_OFFER, JSON.stringify(offer));
		log(1, "Offer created and sent");
	}
};

btnDisconnect1.onclick = () => {
	log(1, "Disconnecting...");
	peer1.disconnect();
	dataChannel1 = null;
};

btnSend1.onclick = () => {
	const msg = input1.value.trim();
	if (msg && dataChannel1) {
		dataChannel1.send(msg);
		addChatMessage(1, msg, true);
		input1.value = "";
	}
};

input1.onkeypress = (e) => {
	if (e.key === "Enter") btnSend1.click();
};

btnInit2.onclick = async () => {
	log(2, "Initializing...");
	await peer2.initialize();
};

btnAnswer2.onclick = async () => {
	const offerStr = localStorage.getItem(SIGNALING_KEY_OFFER);
	if (!offerStr) {
		log(2, "No offer found!");
		return;
	}

	log(2, "Setting remote description (offer)...");
	const offer = JSON.parse(offerStr);
	await peer2.connect();
	await peer2.setRemoteDescription(offer);

	// Add peer 1's ICE candidates
	const ice1 = JSON.parse(localStorage.getItem(SIGNALING_KEY_ICE_1) || "[]");
	for (const candidate of ice1) {
		await peer2.addIceCandidate(candidate);
	}

	log(2, "Creating answer...");
	const answer = await peer2.createAnswer();
	if (answer) {
		await peer2.setLocalDescription(answer);
		localStorage.setItem(SIGNALING_KEY_ANSWER, JSON.stringify(answer));
		log(2, "Answer created and sent");

		// Now peer 1 needs to set remote description
		setTimeout(async () => {
			const answerStr = localStorage.getItem(SIGNALING_KEY_ANSWER);
			if (answerStr) {
				log(1, "Setting remote description (answer)...");
				await peer1.setRemoteDescription(JSON.parse(answerStr));

				// Add peer 2's ICE candidates to peer 1
				const ice2 = JSON.parse(
					localStorage.getItem(SIGNALING_KEY_ICE_2) || "[]"
				);
				for (const candidate of ice2) {
					await peer1.addIceCandidate(candidate);
				}
			}
		}, 500);
	}
};

btnDisconnect2.onclick = () => {
	log(2, "Disconnecting...");
	peer2.disconnect();
	dataChannel2 = null;
};

btnSend2.onclick = () => {
	const msg = input2.value.trim();
	if (msg && dataChannel2) {
		dataChannel2.send(msg);
		addChatMessage(2, msg, true);
		input2.value = "";
	}
};

input2.onkeypress = (e) => {
	if (e.key === "Enter") btnSend2.click();
};

// Clear signaling on load
localStorage.removeItem(SIGNALING_KEY_OFFER);
localStorage.removeItem(SIGNALING_KEY_ANSWER);
localStorage.removeItem(SIGNALING_KEY_ICE_1);
localStorage.removeItem(SIGNALING_KEY_ICE_2);

log(1, "Ready");
log(2, "Ready");
updateButtons(1, peer1.state);
updateButtons(2, peer2.state);
