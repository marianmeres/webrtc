// Minimal mocks for testing WebRTC without a browser environment

export class MockMediaStreamTrack extends EventTarget {
	kind: string;
	enabled: boolean = true;
	id: string;
	label: string = "mock-track";

	constructor(kind: string) {
		super();
		this.kind = kind;
		this.id = Math.random().toString(36).slice(2, 9);
	}

	stop() {
		// no-op
	}
}

export class MockMediaStream extends EventTarget {
	id: string;
	active: boolean = true;
	#tracks: MockMediaStreamTrack[] = [];

	constructor(tracks: MockMediaStreamTrack[] = []) {
		super();
		this.id = Math.random().toString(36).slice(2, 9);
		this.#tracks = tracks;
	}

	getTracks() {
		return this.#tracks;
	}

	getAudioTracks() {
		return this.#tracks.filter((t) => t.kind === "audio");
	}

	getVideoTracks() {
		return this.#tracks.filter((t) => t.kind === "video");
	}

	addTrack(track: MockMediaStreamTrack) {
		if (!this.#tracks.includes(track)) {
			this.#tracks.push(track);
		}
	}

	removeTrack(track: MockMediaStreamTrack) {
		const idx = this.#tracks.indexOf(track);
		if (idx > -1) {
			this.#tracks.splice(idx, 1);
		}
	}
}

export class MockRTCDataChannel extends EventTarget {
	label: string;
	readyState: RTCDataChannelState = "open";
	id: number | null = null;

	constructor(label: string) {
		super();
		this.label = label;
	}

	send(data: any) {
		// no-op
	}

	close() {
		this.readyState = "closed";
		this.dispatchEvent(new Event("close"));
	}
}

export class MockRTCPeerConnection extends EventTarget {
	localDescription: RTCSessionDescription | null = null;
	remoteDescription: RTCSessionDescription | null = null;
	signalingState: RTCSignalingState = "stable";
	connectionState: RTCPeerConnectionState = "new";
	iceConnectionState: RTCIceConnectionState = "new";
	iceGatheringState: RTCIceGatheringState = "new";

	#senders: RTCRtpSender[] = [];
	#transceivers: RTCRtpTransceiver[] = [];
	#dataChannels: MockRTCDataChannel[] = [];

	constructor(config?: RTCConfiguration) {
		super();
	}

	addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
		const sender = { track } as RTCRtpSender;
		this.#senders.push(sender);
		return sender;
	}

	getSenders() {
		return this.#senders;
	}

	removeTrack(sender: RTCRtpSender) {
		const idx = this.#senders.indexOf(sender);
		if (idx > -1) {
			this.#senders.splice(idx, 1);
		}
	}

	createDataChannel(
		label: string,
		options?: RTCDataChannelInit
	): RTCDataChannel {
		const channel = new MockRTCDataChannel(label);
		this.#dataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	addTransceiver(
		trackOrKind: MediaStreamTrack | string,
		init?: RTCRtpTransceiverInit
	): RTCRtpTransceiver {
		// Mock implementation - create a basic transceiver and store it
		const kind =
			typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
		let currentTrack = typeof trackOrKind === "string" ? null : trackOrKind;

		const transceiver = {
			mid: null,
			sender: {
				get track() {
					return currentTrack;
				},
				replaceTrack: async (newTrack: MediaStreamTrack | null) => {
					currentTrack = newTrack;
				},
			} as unknown as RTCRtpSender,
			receiver: {
				track: new MockMediaStreamTrack(kind),
			} as unknown as RTCRtpReceiver,
			direction: init?.direction || "sendrecv",
		} as RTCRtpTransceiver;

		this.#transceivers.push(transceiver);
		return transceiver;
	}

	getTransceivers(): RTCRtpTransceiver[] {
		return this.#transceivers;
	}

	createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
		return Promise.resolve({ type: "offer", sdp: "mock-offer-sdp" });
	}

	createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
		return Promise.resolve({ type: "answer", sdp: "mock-answer-sdp" });
	}

	setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = description as RTCSessionDescription;
		return Promise.resolve();
	}

	setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = description as RTCSessionDescription;
		return Promise.resolve();
	}

	close() {
		this.connectionState = "closed";
		this.signalingState = "closed";
		this.#dataChannels.forEach((c) => c.close());
	}
}

export class MockWebRtcFactory {
	createPeerConnection(config?: RTCConfiguration): RTCPeerConnection {
		return new MockRTCPeerConnection(config) as unknown as RTCPeerConnection;
	}

	getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
		const tracks: MockMediaStreamTrack[] = [];
		if (constraints.audio) {
			tracks.push(new MockMediaStreamTrack("audio"));
		}
		if (constraints.video) {
			tracks.push(new MockMediaStreamTrack("video"));
		}
		return Promise.resolve(
			new MockMediaStream(tracks) as unknown as MediaStream
		);
	}

	enumerateDevices(): Promise<MediaDeviceInfo[]> {
		// Mock device list
		return Promise.resolve([
			{
				deviceId: "default",
				kind: "audioinput",
				label: "Default Microphone",
				groupId: "",
			} as MediaDeviceInfo,
			{
				deviceId: "mic1",
				kind: "audioinput",
				label: "Built-in Microphone",
				groupId: "",
			} as MediaDeviceInfo,
			{
				deviceId: "speaker1",
				kind: "audiooutput",
				label: "Built-in Speaker",
				groupId: "",
			} as MediaDeviceInfo,
		]);
	}
}
