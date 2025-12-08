// Shared code for WebRTC peer examples

// WebRTC factory for browser environment
export const factory = {
	createPeerConnection: (config) => new RTCPeerConnection(config),
	getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
	enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
};

// Peer connection config with STUN server
export const peerConfig = {
	iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

/**
 * Create a beep sound as a MediaStream using Web Audio API.
 * This demonstrates audio capture for WebRTC transmission.
 *
 * @param {number} frequency - Frequency in Hz (default: 440 = A4 note)
 * @param {number} duration - Duration in milliseconds (default: 500)
 * @returns {{ stream: MediaStream, audioCtx: AudioContext, stop: () => void }}
 */
export function createBeepStream(frequency = 440, duration = 500) {
	const audioCtx = new AudioContext();
	const oscillator = audioCtx.createOscillator();
	const gainNode = audioCtx.createGain();

	// MediaStreamDestination captures audio as a MediaStream
	const destination = audioCtx.createMediaStreamDestination();

	// Configure oscillator
	oscillator.type = 'sine';
	oscillator.frequency.value = frequency;

	// Connect: oscillator -> gain -> destination
	oscillator.connect(gainNode);
	gainNode.connect(destination);

	// Fade out to avoid audio click at the end
	const durationSec = duration / 1000;
	gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
	gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + durationSec);

	// Start and schedule stop
	oscillator.start();
	oscillator.stop(audioCtx.currentTime + durationSec);

	return {
		stream: destination.stream,
		audioCtx,
		stop: () => {
			try {
				oscillator.stop();
			} catch (e) {
				// Already stopped
			}
			audioCtx.close();
		}
	};
}

/**
 * Create a logger function that appends timestamped messages to a DOM element.
 *
 * @param {HTMLElement} logEl - The container element for log messages
 * @returns {(msg: string) => void}
 */
export function createLogger(logEl) {
	return (msg) => {
		const line = document.createElement('div');
		line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
		logEl.appendChild(line);
		logEl.scrollTop = logEl.scrollHeight;
	};
}

/**
 * Setup bidirectional audio on peer connection before initial negotiation.
 * This ensures audio can be sent/received without mid-session renegotiation.
 *
 * @param {RTCPeerConnection} pc - The peer connection
 */
export function setupBidirectionalAudio(pc) {
	const transceivers = pc.getTransceivers();
	let foundAudio = false;

	// Set ALL audio transceivers to sendrecv
	for (const t of transceivers) {
		if (t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio') {
			foundAudio = true;
			if (t.direction === 'recvonly' || t.direction === 'sendonly') {
				t.direction = 'sendrecv';
			}
		}
	}

	// Only add new transceiver if no audio transceivers exist
	if (!foundAudio) {
		pc.addTransceiver('audio', { direction: 'sendrecv' });
	}
}

/**
 * Send a beep through WebRTC by replacing the audio track.
 * Assumes bidirectional audio was set up during initial negotiation.
 *
 * @param {RTCPeerConnection} pc - The peer connection
 * @param {number} frequency - Beep frequency in Hz
 * @param {number} duration - Beep duration in ms
 * @returns {{ stop: () => void }}
 */
export function sendBeep(pc, frequency = 440, duration = 500) {
	const { stream, stop } = createBeepStream(frequency, duration);
	const track = stream.getAudioTracks()[0];

	// Use the last audio transceiver (the one from negotiation)
	const audioTransceivers = pc.getTransceivers().filter(
		t => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
	);
	const transceiver = audioTransceivers[audioTransceivers.length - 1];

	if (transceiver) {
		transceiver.sender.replaceTrack(track);
	} else {
		pc.addTrack(track, stream);
	}

	// Schedule cleanup
	setTimeout(() => stop(), duration);

	return { stop };
}
