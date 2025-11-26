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

// Detect which peer we are based on the HTML filename
const isPeer1 = window.location.pathname.includes("peer1");
const peerNumber = isPeer1 ? 1 : 2;

// Signaling type
type SignalingMode = "localStorage" | "httpServer";
let signalingMode: SignalingMode = "localStorage";

// Simple localStorage-based signaling keys
const SIGNALING_KEY_OFFER = "webrtc_audio_offer";
const SIGNALING_KEY_ANSWER = "webrtc_audio_answer";
const SIGNALING_KEY_ICE_1 = "webrtc_audio_ice_1";
const SIGNALING_KEY_ICE_2 = "webrtc_audio_ice_2";

// HTTP server signaling config
const SESSION_ID = "audio-test-session";
const API_BASE = `${window.location.origin}/api/session/${SESSION_ID}`;

// Create peer (without enabling microphone initially - let user control it)
const factory = new BrowserWebRtcFactory();
const peer = new WebRtcManager(factory, {
	peerConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
	enableMicrophone: false,
	debug: true,
});

// UI Elements
const status = document.getElementById("status")!;
const logs = document.getElementById("logs")!;
const btnInit = document.getElementById("btn-init") as HTMLButtonElement;
const btnOffer = document.getElementById("btn-offer") as HTMLButtonElement;
const btnAnswer = document.getElementById("btn-answer") as HTMLButtonElement;
const btnDisconnect = document.getElementById("btn-disconnect") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnMicEnable = document.getElementById("btn-mic-enable") as HTMLButtonElement;
const btnMicDisable = document.getElementById("btn-mic-disable") as HTMLButtonElement;
const micSelect = document.getElementById("mic-select") as HTMLSelectElement;
const remoteAudio = document.getElementById("remote-audio") as HTMLAudioElement;
const localVizCanvas = document.getElementById("local-viz") as HTMLCanvasElement;
const remoteVizCanvas = document.getElementById("remote-viz") as HTMLCanvasElement;
const signalingModeSelect = document.getElementById("signaling-mode") as HTMLSelectElement;

// Stats elements
const statBytesSent = document.getElementById("stat-bytes-sent")!;
const statBytesReceived = document.getElementById("stat-bytes-received")!;
const statAudioLocal = document.getElementById("stat-audio-local")!;
const statAudioRemote = document.getElementById("stat-audio-remote")!;

// Audio visualization
let localAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
let localDataArray: Uint8Array | null = null;
let remoteDataArray: Uint8Array | null = null;
let audioContext: AudioContext | null = null;
let animationFrameId: number | null = null;

// Logging
function log(msg: string, type: "info" | "error" | "success" = "info") {
	const time = new Date().toISOString().split("T")[1].split(".")[0];
	const div = document.createElement("div");
	div.className = `log-entry log-${type}`;
	div.textContent = `[${time}] ${msg}`;
	logs.prepend(div);
	console.log(`Peer ${peerNumber}:`, msg);
}

function updateButtons(state: WebRtcState) {
	status.textContent = `State: ${state}`;
	btnInit.disabled = state !== WebRtcState.IDLE;

	if (isPeer1) {
		btnOffer.disabled = state !== WebRtcState.INITIALIZING;
	} else {
		btnAnswer.disabled = state !== WebRtcState.INITIALIZING;
	}

	btnDisconnect.disabled = state !== WebRtcState.CONNECTED && state !== WebRtcState.CONNECTING;
	btnReset.disabled = state === WebRtcState.IDLE;
}

async function loadMicrophoneDevices() {
	try {
		const devices = await peer.getAudioInputDevices();
		micSelect.innerHTML = "";

		if (devices.length === 0) {
			micSelect.innerHTML = "<option>No devices available</option>";
			micSelect.disabled = true;
			return;
		}

		devices.forEach((device) => {
			const option = document.createElement("option");
			option.value = device.deviceId;
			option.textContent = device.label || `Microphone ${device.deviceId.slice(0, 8)}`;
			micSelect.appendChild(option);
		});

		micSelect.disabled = false;
		log(`Found ${devices.length} audio input device(s)`, "success");
	} catch (e) {
		log(`Failed to load devices: ${e}`, "error");
	}
}

function setupAudioVisualization(stream: MediaStream, isLocal: boolean) {
	try {
		if (!audioContext) {
			audioContext = new AudioContext();
			log(`AudioContext created, state: ${audioContext.state}`);
		}

		// Resume context if suspended (some browsers require user interaction)
		if (audioContext.state === "suspended") {
			audioContext.resume().then(() => {
				log(`AudioContext resumed, state: ${audioContext.state}`);
			});
		}

		// Check if stream has audio tracks
		const audioTracks = stream.getAudioTracks();
		if (audioTracks.length === 0) {
			log(`${isLocal ? "Local" : "Remote"} stream has no audio tracks`, "error");
			return;
		}

		log(`${isLocal ? "Local" : "Remote"} stream has ${audioTracks.length} audio track(s)`);

		// Log track details
		audioTracks.forEach((track, i) => {
			log(`  Track ${i}: ${track.kind}, enabled=${track.enabled}, readyState=${track.readyState}, muted=${track.muted}`);
		});

		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);

		const bufferLength = analyser.frequencyBinCount;
		const dataArray = new Uint8Array(bufferLength);

		if (isLocal) {
			localAnalyser = analyser;
			localDataArray = dataArray;
		} else {
			remoteAnalyser = analyser;
			remoteDataArray = dataArray;
		}

		// Start animation if not running
		if (!animationFrameId) {
			animate();
			log("Animation loop started");
		}

		log(`${isLocal ? "Local" : "Remote"} audio visualization ready`, "success");

		// Debug: check if we're getting any data
		setTimeout(() => {
			const testArray = new Uint8Array(bufferLength);
			analyser.getByteFrequencyData(testArray as Uint8Array<ArrayBuffer>);
			const hasData = Array.from(testArray).some(v => v > 0);
			log(`${isLocal ? "Local" : "Remote"} analyser has data: ${hasData}, max value: ${Math.max(...testArray)}`);
		}, 1000);
	} catch (e) {
		log(`Failed to setup ${isLocal ? "local" : "remote"} visualization: ${e}`, "error");
		console.error("Visualization setup error:", e);
	}
}

let debugCounter = 0;
function animate() {
	animationFrameId = requestAnimationFrame(animate);

	// Draw local visualization
	if (localAnalyser && localDataArray) {
		drawVisualization(localVizCanvas, localAnalyser, localDataArray);
		updateAudioLevel(localAnalyser, localDataArray, statAudioLocal);
	}

	// Draw remote visualization
	if (remoteAnalyser && remoteDataArray) {
		drawVisualization(remoteVizCanvas, remoteAnalyser, remoteDataArray);
		updateAudioLevel(remoteAnalyser, remoteDataArray, statAudioRemote);

		// Debug log every 60 frames (about once per second at 60fps)
		debugCounter++;
		if (debugCounter % 60 === 0) {
			const testArray = new Uint8Array(remoteDataArray.length);
			remoteAnalyser.getByteFrequencyData(testArray as Uint8Array<ArrayBuffer>);
			const max = Math.max(...testArray);
			if (max > 0) {
				console.log(`Remote visualization active, max frequency: ${max}`);
			} else {
				console.log("Remote visualization running but no audio data detected");
			}
		}
	}
}

function drawVisualization(canvas: HTMLCanvasElement, analyser: AnalyserNode, dataArray: Uint8Array) {
	const ctx = canvas.getContext("2d")!;
	const width = canvas.width = canvas.offsetWidth;
	const height = canvas.height = canvas.offsetHeight;

	analyser.getByteFrequencyData(dataArray as Uint8Array<ArrayBuffer>);

	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, width, height);

	const barWidth = (width / dataArray.length) * 2.5;
	let x = 0;

	for (let i = 0; i < dataArray.length; i++) {
		const barHeight = (dataArray[i] / 255) * height;

		const r = barHeight + (25 * (i / dataArray.length));
		const g = 250 * (i / dataArray.length);
		const b = 50;

		ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
		ctx.fillRect(x, height - barHeight, barWidth, barHeight);

		x += barWidth + 1;
	}
}

function updateAudioLevel(analyser: AnalyserNode, dataArray: Uint8Array, element: HTMLElement) {
	analyser.getByteTimeDomainData(dataArray as Uint8Array<ArrayBuffer>);

	let sum = 0;
	for (let i = 0; i < dataArray.length; i++) {
		const normalized = (dataArray[i] - 128) / 128;
		sum += normalized * normalized;
	}

	const rms = Math.sqrt(sum / dataArray.length);
	const level = Math.min(100, Math.floor(rms * 200));
	element.textContent = `${level}%`;
}

// Update stats periodically
let statsInterval: number | null = null;

function startStatsUpdates() {
	if (statsInterval) return;

	statsInterval = setInterval(async () => {
		const stats = await peer.getStats();
		if (!stats) return;

		let bytesSent = 0;
		let bytesReceived = 0;

		stats.forEach((report) => {
			if (report.type === "outbound-rtp" && report.kind === "audio") {
				bytesSent += report.bytesSent || 0;
			}
			if (report.type === "inbound-rtp" && report.kind === "audio") {
				bytesReceived += report.bytesReceived || 0;
			}
		});

		statBytesSent.textContent = formatBytes(bytesSent);
		statBytesReceived.textContent = formatBytes(bytesReceived);
	}, 1000) as unknown as number;
}

function stopStatsUpdates() {
	if (statsInterval) {
		clearInterval(statsInterval);
		statsInterval = null;
	}
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

// Signaling abstraction layer
async function sendOffer(offer: RTCSessionDescriptionInit): Promise<void> {
	if (signalingMode === "localStorage") {
		localStorage.setItem(SIGNALING_KEY_OFFER, JSON.stringify(offer));
	} else {
		await fetch(`${API_BASE}/offer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(offer),
		});
	}
}

async function getOffer(): Promise<RTCSessionDescriptionInit | null> {
	if (signalingMode === "localStorage") {
		const offerStr = localStorage.getItem(SIGNALING_KEY_OFFER);
		return offerStr ? JSON.parse(offerStr) : null;
	} else {
		const response = await fetch(`${API_BASE}/offer`);
		return await response.json();
	}
}

async function sendAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
	if (signalingMode === "localStorage") {
		localStorage.setItem(SIGNALING_KEY_ANSWER, JSON.stringify(answer));
		localStorage.setItem("peer2_audio_answer_ready", Date.now().toString());
	} else {
		await fetch(`${API_BASE}/answer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(answer),
		});
	}
}

async function getAnswer(): Promise<RTCSessionDescriptionInit | null> {
	if (signalingMode === "localStorage") {
		const answerStr = localStorage.getItem(SIGNALING_KEY_ANSWER);
		return answerStr ? JSON.parse(answerStr) : null;
	} else {
		const response = await fetch(`${API_BASE}/answer`);
		return await response.json();
	}
}

async function sendIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
	if (signalingMode === "localStorage") {
		const key = isPeer1 ? SIGNALING_KEY_ICE_1 : SIGNALING_KEY_ICE_2;
		const existing = JSON.parse(localStorage.getItem(key) || "[]");
		existing.push(candidate);
		localStorage.setItem(key, JSON.stringify(existing));
	} else {
		const endpoint = isPeer1 ? "ice1" : "ice2";
		await fetch(`${API_BASE}/${endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(candidate),
		});
	}
}

async function getIceCandidates(forPeer: 1 | 2): Promise<RTCIceCandidateInit[]> {
	if (signalingMode === "localStorage") {
		const key = forPeer === 1 ? SIGNALING_KEY_ICE_1 : SIGNALING_KEY_ICE_2;
		return JSON.parse(localStorage.getItem(key) || "[]");
	} else {
		const endpoint = forPeer === 1 ? "ice1" : "ice2";
		const response = await fetch(`${API_BASE}/${endpoint}`);
		return await response.json();
	}
}

async function clearSignaling(): Promise<void> {
	if (signalingMode === "localStorage") {
		localStorage.removeItem(SIGNALING_KEY_OFFER);
		localStorage.removeItem(SIGNALING_KEY_ANSWER);
		localStorage.removeItem(SIGNALING_KEY_ICE_1);
		localStorage.removeItem(SIGNALING_KEY_ICE_2);
		localStorage.removeItem("peer2_audio_answer_ready");
	} else {
		await fetch(`${API_BASE}/reset`, { method: "DELETE" });
	}
}

// Polling for answer (HTTP mode only)
let answerPollingInterval: number | null = null;

function startAnswerPolling(): void {
	if (signalingMode !== "httpServer" || !isPeer1) return;
	if (answerPollingInterval) return;

	log("Polling for answer...");
	answerPollingInterval = setInterval(async () => {
		try {
			const answer = await getAnswer();
			if (answer) {
				clearInterval(answerPollingInterval!);
				answerPollingInterval = null;
				log("Answer received from polling", "success");
				await handleAnswerReceived();
			}
		} catch (e) {
			console.error("Error polling for answer:", e);
		}
	}, 500) as unknown as number;
}

function stopAnswerPolling(): void {
	if (answerPollingInterval) {
		clearInterval(answerPollingInterval);
		answerPollingInterval = null;
	}
}

async function handleAnswerReceived(): Promise<void> {
	const answer = await getAnswer();
	if (answer) {
		log("Setting remote description (answer)...");
		await peer.setRemoteDescription(answer);

		// Add peer 2's ICE candidates
		const ice2 = await getIceCandidates(2);
		for (const candidate of ice2) {
			await peer.addIceCandidate(candidate);
		}
		log("Connection established!", "success");
	}
}

// Peer event handlers
peer.on("state_change", (state) => {
	log(`State changed: ${state}`, "info");
	updateButtons(state);

	if (state === WebRtcState.CONNECTED) {
		startStatsUpdates();
	} else {
		stopStatsUpdates();
	}
});

peer.on("local_stream", (stream) => {
	if (stream) {
		log("Local stream active", "success");
		setupAudioVisualization(stream, true);
		btnMicEnable.disabled = true;
		btnMicDisable.disabled = false;
	} else {
		log("Local stream stopped", "info");
		localAnalyser = null;
		localDataArray = null;
		btnMicEnable.disabled = false;
		btnMicDisable.disabled = true;
	}
});

peer.on("remote_stream", (stream) => {
	if (stream) {
		log("Remote stream received", "success");
		log(`Remote stream ID: ${stream.id}`);
		log(`Remote audio tracks: ${stream.getAudioTracks().length}`);

		remoteAudio.srcObject = stream;

		// Setup visualization immediately - don't wait for metadata
		setupAudioVisualization(stream, false);

		// Also try again when metadata loads, in case it wasn't ready
		remoteAudio.onloadedmetadata = () => {
			log("Remote audio metadata loaded");
			// Ensure visualization is set up
			if (!remoteAnalyser) {
				setupAudioVisualization(stream, false);
			}
		};
	} else {
		log("Remote stream ended", "info");
		remoteAudio.srcObject = null;
		remoteAnalyser = null;
		remoteDataArray = null;
	}
});

peer.on("ice_candidate", (candidate) => {
	if (candidate) {
		log("ICE candidate generated");
		sendIceCandidate(candidate.toJSON()).catch((e) => {
			log(`Failed to send ICE candidate: ${e}`, "error");
		});
	}
});

peer.on("device_changed", async () => {
	log("Audio devices changed", "info");
	await loadMicrophoneDevices();
});

peer.on("microphone_failed", ({ error, reason }) => {
	log(`Microphone failed: ${reason || error}`, "error");
});

peer.on("error", (error) => {
	log(`Error: ${error}`, "error");
});

// Button handlers
btnInit.onclick = async () => {
	log("Initializing...");
	await peer.initialize();
	await loadMicrophoneDevices();
};

btnMicEnable.onclick = async () => {
	log("Enabling microphone...");
	const success = await peer.enableMicrophone(true);
	if (success) {
		log("Microphone enabled", "success");
	} else {
		log("Failed to enable microphone", "error");
	}
};

btnMicDisable.onclick = async () => {
	log("Disabling microphone...");
	await peer.enableMicrophone(false);
	log("Microphone disabled", "info");
};

micSelect.onchange = async () => {
	const deviceId = micSelect.value;
	if (!deviceId) return;

	log(`Switching to microphone: ${micSelect.options[micSelect.selectedIndex].text}`);
	const success = await peer.switchMicrophone(deviceId);
	if (success) {
		log("Microphone switched", "success");
	} else {
		log("Failed to switch microphone", "error");
	}
};

if (isPeer1) {
	btnOffer.onclick = async () => {
		log("Creating offer...");
		await peer.connect();
		const offer = await peer.createOffer();
		if (offer) {
			await peer.setLocalDescription(offer);
			await sendOffer(offer);
			log("Offer created and sent", "success");

			// Start polling for answer in HTTP mode
			startAnswerPolling();
		}
	};
} else {
	btnAnswer.onclick = async () => {
		const offer = await getOffer();
		if (!offer) {
			log("No offer found!", "error");
			return;
		}

		log("Setting remote description (offer)...");
		await peer.connect();
		await peer.setRemoteDescription(offer);

		// Add peer 1's ICE candidates
		const ice1 = await getIceCandidates(1);
		for (const candidate of ice1) {
			await peer.addIceCandidate(candidate);
		}

		log("Creating answer...");
		const answer = await peer.createAnswer();
		if (answer) {
			await peer.setLocalDescription(answer);
			await sendAnswer(answer);
			log("Answer created and sent", "success");
		}
	};
}

// Peer 1 listens for answer (localStorage mode only)
if (isPeer1) {
	window.addEventListener("storage", async (e) => {
		if (e.key === "peer2_audio_answer_ready" && signalingMode === "localStorage") {
			await handleAnswerReceived();
		}
	});
}

btnDisconnect.onclick = () => {
	log("Disconnecting...");
	peer.disconnect();
	stopAnswerPolling();
};

btnReset.onclick = () => {
	log("Resetting...");
	peer.reset();
	stopAnswerPolling();

	// Clear visualizations
	localAnalyser = null;
	remoteAnalyser = null;
	localDataArray = null;
	remoteDataArray = null;

	// Clear signaling data
	if (isPeer1) {
		clearSignaling().catch((e) => {
			log(`Failed to clear signaling: ${e}`, "error");
		});
	}
};

// Signaling mode selector
signalingModeSelect.onchange = () => {
	const newMode = signalingModeSelect.value as SignalingMode;
	signalingMode = newMode;
	log(`Signaling mode changed to: ${newMode}`, "info");

	// Clear signaling when switching modes
	if (isPeer1) {
		clearSignaling().catch((e) => {
			log(`Failed to clear signaling: ${e}`, "error");
		});
	}
};

// Initialize signaling mode from select
signalingMode = signalingModeSelect.value as SignalingMode;

// Clear signaling on load for peer 1
if (isPeer1) {
	clearSignaling().catch((e) => {
		console.error("Failed to clear signaling on load:", e);
	});
}

log("Audio test ready - click Initialize to start", "success");
updateButtons(peer.state);
