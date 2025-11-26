import { FSM } from "@marianmeres/fsm";
import { PubSub } from "@marianmeres/pubsub";
import {
	type WebRtcFactory,
	type WebRtcManagerConfig,
	WebRtcState,
	WebRtcFsmEvent,
	type WebRtcEvents,
} from "./types.ts";

export class WebRtcManager {
	#fsm: FSM<WebRtcState, WebRtcFsmEvent>;
	#pubsub: PubSub;
	#pc: RTCPeerConnection | null = null;
	#factory: WebRtcFactory;
	#config: WebRtcManagerConfig;
	#localStream: MediaStream | null = null;
	#remoteStream: MediaStream | null = null;
	#dataChannels: Map<string, RTCDataChannel> = new Map();
	#reconnectAttempts: number = 0;
	#reconnectTimer: number | null = null;
	#deviceChangeHandler: (() => void) | null = null;

	constructor(factory: WebRtcFactory, config: WebRtcManagerConfig = {}) {
		this.#factory = factory;
		this.#config = config;
		this.#pubsub = new PubSub();

		// Initialize FSM
		this.#fsm = new FSM({
			initial: WebRtcState.IDLE,
			states: {
				[WebRtcState.IDLE]: {
					on: { [WebRtcFsmEvent.INIT]: WebRtcState.INITIALIZING },
				},
				[WebRtcState.INITIALIZING]: {
					on: {
						[WebRtcFsmEvent.CONNECT]: WebRtcState.CONNECTING,
						[WebRtcFsmEvent.ERROR]: WebRtcState.ERROR,
					},
				},
				[WebRtcState.CONNECTING]: {
					on: {
						[WebRtcFsmEvent.CONNECTED]: WebRtcState.CONNECTED,
						[WebRtcFsmEvent.DISCONNECT]: WebRtcState.DISCONNECTED,
						[WebRtcFsmEvent.ERROR]: WebRtcState.ERROR,
					},
				},
				[WebRtcState.CONNECTED]: {
					on: {
						[WebRtcFsmEvent.DISCONNECT]: WebRtcState.DISCONNECTED,
						[WebRtcFsmEvent.ERROR]: WebRtcState.ERROR,
					},
				},
				[WebRtcState.RECONNECTING]: {
					on: {
						[WebRtcFsmEvent.CONNECT]: WebRtcState.CONNECTING,
						[WebRtcFsmEvent.DISCONNECT]: WebRtcState.DISCONNECTED,
						[WebRtcFsmEvent.RESET]: WebRtcState.IDLE,
					},
				},
				[WebRtcState.DISCONNECTED]: {
					on: {
						[WebRtcFsmEvent.CONNECT]: WebRtcState.CONNECTING,
						[WebRtcFsmEvent.RECONNECTING]: WebRtcState.RECONNECTING,
						[WebRtcFsmEvent.RESET]: WebRtcState.IDLE,
					},
				},
				[WebRtcState.ERROR]: {
					on: { [WebRtcFsmEvent.RESET]: WebRtcState.IDLE },
				},
			},
		});
	}

	// --- Public API ---

	/** Returns the current state of the WebRTC connection. */
	get state(): WebRtcState {
		return this.#fsm.state as WebRtcState;
	}

	/** Returns a readonly map of all active data channels indexed by label. */
	get dataChannels(): ReadonlyMap<string, RTCDataChannel> {
		return this.#dataChannels;
	}

	/** Returns the local media stream, or null if not initialized. */
	get localStream(): MediaStream | null {
		return this.#localStream;
	}

	/** Returns the remote media stream, or null if not connected. */
	get remoteStream(): MediaStream | null {
		return this.#remoteStream;
	}

	/** Returns the underlying RTCPeerConnection, or null if not initialized. */
	get peerConnection(): RTCPeerConnection | null {
		return this.#pc;
	}

	/** Returns a Mermaid diagram representation of the FSM state machine. */
	toMermaid(): string {
		return this.#fsm.toMermaid();
	}

	/**
	 * Subscribe to a specific WebRTC event.
	 * @returns Unsubscribe function to remove the event listener.
	 */
	on(event: keyof WebRtcEvents, handler: (data: any) => void): () => void {
		return this.#pubsub.subscribe(event, handler);
	}

	/**
	 * Subscribe to all WebRTC events using a wildcard listener.
	 * @returns Unsubscribe function to remove the event listener.
	 */
	subscribe(handler: (data: any) => void): () => void {
		return this.#pubsub.subscribe("*", handler);
	}

	/**
	 * Retrieves all available audio input devices.
	 * @returns Array of audio input devices, or empty array on error.
	 */
	async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
		try {
			const devices = await this.#factory.enumerateDevices();
			return devices.filter((d) => d.kind === "audioinput");
		} catch (e) {
			console.error("Failed to enumerate devices:", e);
			return [];
		}
	}

	/**
	 * Switches the active microphone to a different audio input device.
	 * @param deviceId - The device ID of the audio input to switch to.
	 * @returns True if the switch was successful, false otherwise.
	 */
	async switchMicrophone(deviceId: string): Promise<boolean> {
		if (!this.#pc || !this.#localStream) {
			console.error(
				"Cannot switch microphone: not initialized or no active stream"
			);
			return false;
		}

		try {
			// Get new stream from the specified device
			const newStream = await this.#factory.getUserMedia({
				audio: { deviceId: { exact: deviceId } },
				video: false,
			});

			const newTrack = newStream.getAudioTracks()[0];
			if (!newTrack) {
				throw new Error("No audio track in new stream");
			}

			// Find the sender for the audio track - check both senders and transceivers
			let sender = this.#pc.getSenders().find((s) => s.track?.kind === "audio");

			if (!sender) {
				// Try to find via transceiver
				const transceivers = this.#pc.getTransceivers();
				const audioTransceiver = transceivers.find(
					(t) => t.receiver.track.kind === "audio"
				);
				if (audioTransceiver) {
					sender = audioTransceiver.sender;
				}
			}

			if (!sender) {
				throw new Error("No audio sender found - enable microphone first");
			}

			// Replace the track
			await sender.replaceTrack(newTrack);

			// Stop old tracks
			this.#localStream.getAudioTracks().forEach((track) => track.stop());

			// Update local stream reference
			this.#localStream = newStream;
			this.#pubsub.publish("local_stream", newStream);

			return true;
		} catch (e) {
			console.error("Failed to switch microphone:", e);
			this.#error(e);
			return false;
		}
	}

	/**
	 * Initializes the WebRTC peer connection and sets up media tracks.
	 * Must be called before creating offers or answers. Can only be called from IDLE state.
	 */
	async initialize(): Promise<void> {
		if (this.state !== WebRtcState.IDLE) return;
		this.#dispatch(WebRtcFsmEvent.INIT);

		try {
			this.#pc = this.#factory.createPeerConnection(this.#config.peerConfig);
			this.#setupPcListeners();

			// Setup device change detection now that we have a connection
			this.#setupDeviceChangeListener();

			if (this.#config.enableMicrophone) {
				const success = await this.enableMicrophone(true);
				if (!success) {
					this.#pubsub.publish("microphone_failed", {
						reason: "Failed to enable microphone during initialization",
					});
				}
			} else {
				// Always setup to receive audio, even if we don't enable microphone
				// This ensures the SDP includes audio media line
				this.#pc.addTransceiver("audio", { direction: "recvonly" });
			}

			if (this.#config.dataChannelLabel) {
				this.createDataChannel(this.#config.dataChannelLabel);
			}
		} catch (e) {
			this.#error(e);
		}
	}

	/**
	 * Transitions to the CONNECTING state. Automatically initializes if needed.
	 * If disconnected, reinitializes the peer connection.
	 */
	async connect(): Promise<void> {
		// Initialize if needed
		if (this.state === WebRtcState.IDLE) {
			await this.initialize();
		}

		// Reinitialize if disconnected (PeerConnection was closed)
		if (this.state === WebRtcState.DISCONNECTED) {
			// Clean up old connection
			this.#cleanup();
			// Reset to IDLE and reinitialize
			this.#fsm.transition(WebRtcFsmEvent.RESET);
			await this.initialize();
			// Stay in INITIALIZING state - caller needs to create offer/answer
			return;
		}

		if (
			this.state === WebRtcState.CONNECTED ||
			this.state === WebRtcState.CONNECTING
		)
			return;

		this.#dispatch(WebRtcFsmEvent.CONNECT);
	}

	/**
	 * Enables or disables the microphone and adds/removes audio tracks to the peer connection.
	 * @param enable - True to enable microphone, false to disable.
	 * @returns True if successful, false if failed to get user media.
	 */
	async enableMicrophone(enable: boolean): Promise<boolean> {
		if (enable) {
			if (this.#localStream) return true; // Already enabled
			try {
				const stream = await this.#factory.getUserMedia({
					audio: true,
					video: false,
				});
				this.#localStream = stream;
				this.#pubsub.publish("local_stream", stream);

				if (this.#pc) {
					// Check if we have an existing audio transceiver
					const transceivers = this.#pc.getTransceivers();
					const audioTransceiver = transceivers.find(
						(t) => t.receiver.track.kind === "audio"
					);

					if (audioTransceiver && audioTransceiver.sender) {
						// Replace the track in existing transceiver
						const track = stream.getAudioTracks()[0];
						await audioTransceiver.sender.replaceTrack(track);
						// Update direction to sendrecv
						audioTransceiver.direction = "sendrecv";
					} else {
						// Add track normally
						stream.getTracks().forEach((track) => {
							this.#pc!.addTrack(track, stream);
						});
					}
				}
				return true;
			} catch (e) {
				console.error("Failed to get user media", e);
				this.#pubsub.publish("microphone_failed", { error: e });
				return false;
			}
		} else {
			if (!this.#localStream) return true;
			this.#localStream.getTracks().forEach((track) => {
				track.stop();
				// Remove from PC if needed, or just stop sending
				if (this.#pc) {
					const senders = this.#pc.getSenders();
					const sender = senders.find((s) => s.track === track);
					if (sender) {
						this.#pc.removeTrack(sender);
					}
				}
			});
			this.#localStream = null;
			this.#pubsub.publish("local_stream", null);
			return true;
		}
	}

	/**
	 * Disconnects the peer connection and cleans up all resources.
	 * Transitions to DISCONNECTED state.
	 */
	disconnect(): void {
		this.#cleanup();
		this.#dispatch(WebRtcFsmEvent.DISCONNECT);
	}

	/**
	 * Resets the manager to IDLE state from any state.
	 * Cleans up all resources and allows reinitialization.
	 */
	reset(): void {
		this.#cleanup();

		// Reset from any non-IDLE state
		if (this.state !== WebRtcState.IDLE) {
			// Force transition to DISCONNECTED first if needed, then to IDLE
			if (
				this.state === WebRtcState.ERROR ||
				this.state === WebRtcState.DISCONNECTED ||
				this.state === WebRtcState.RECONNECTING
			) {
				this.#dispatch(WebRtcFsmEvent.RESET);
			} else {
				// For other states, go through DISCONNECTED first
				this.#dispatch(WebRtcFsmEvent.DISCONNECT);
				this.#dispatch(WebRtcFsmEvent.RESET);
			}
		}
	}

	/**
	 * Creates a new data channel with the specified label.
	 * Returns existing channel if one with the same label already exists.
	 * @param label - The label for the data channel.
	 * @param options - Optional RTCDataChannelInit configuration.
	 * @returns The created data channel, or null if peer connection not initialized.
	 */
	createDataChannel(
		label: string,
		options?: RTCDataChannelInit
	): RTCDataChannel | null {
		if (!this.#pc) return null;
		if (this.#dataChannels.has(label)) return this.#dataChannels.get(label)!;

		try {
			const dc = this.#pc.createDataChannel(label, options);
			this.#setupDataChannelListeners(dc);
			this.#dataChannels.set(label, dc);
			return dc;
		} catch (e) {
			this.#error(e);
			return null;
		}
	}

	/**
	 * Retrieves an existing data channel by label.
	 * @param label - The label of the data channel to retrieve.
	 * @returns The data channel if found, undefined otherwise.
	 */
	getDataChannel(label: string): RTCDataChannel | undefined {
		return this.#dataChannels.get(label);
	}

	/**
	 * Sends data through a data channel identified by label.
	 * Checks that the channel exists and is in open state before sending.
	 * @param label - The label of the data channel to send through.
	 * @param data - The data to send (string, Blob, or ArrayBuffer).
	 * @returns True if data was sent successfully, false otherwise.
	 */
	sendData(
		label: string,
		data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>
	): boolean {
		const channel = this.#dataChannels.get(label);
		if (!channel) {
			this.#debug(`Data channel '${label}' not found`);
			return false;
		}
		if (channel.readyState !== "open") {
			this.#debug(
				`Data channel '${label}' is not open (state: ${channel.readyState})`
			);
			return false;
		}
		try {
			channel.send(data as any);
			return true;
		} catch (e) {
			this.#error(e);
			return false;
		}
	}

	// --- Signaling methods ---

	/**
	 * Creates an SDP offer for initiating a WebRTC connection.
	 * @param options - Optional offer configuration.
	 * @returns The offer SDP, or null if peer connection not initialized.
	 */
	async createOffer(
		options?: RTCOfferOptions
	): Promise<RTCSessionDescriptionInit | null> {
		if (!this.#pc) return null;
		try {
			const offer = await this.#pc.createOffer(options);
			return offer;
		} catch (e) {
			this.#error(e);
			return null;
		}
	}

	/**
	 * Creates an SDP answer in response to a received offer.
	 * @param options - Optional answer configuration.
	 * @returns The answer SDP, or null if peer connection not initialized.
	 */
	async createAnswer(
		options?: RTCAnswerOptions
	): Promise<RTCSessionDescriptionInit | null> {
		if (!this.#pc) return null;
		try {
			const answer = await this.#pc.createAnswer(options);
			return answer;
		} catch (e) {
			this.#error(e);
			return null;
		}
	}

	/**
	 * Sets the local description for the peer connection.
	 * @param description - The SDP description (offer or answer).
	 * @returns True if successful, false otherwise.
	 */
	async setLocalDescription(
		description: RTCSessionDescriptionInit
	): Promise<boolean> {
		if (!this.#pc) return false;
		try {
			await this.#pc.setLocalDescription(description);
			return true;
		} catch (e) {
			this.#error(e);
			return false;
		}
	}

	/**
	 * Sets the remote description received from the peer.
	 * @param description - The remote SDP description.
	 * @returns True if successful, false otherwise.
	 */
	async setRemoteDescription(
		description: RTCSessionDescriptionInit
	): Promise<boolean> {
		if (!this.#pc) return false;
		try {
			await this.#pc.setRemoteDescription(description);
			return true;
		} catch (e) {
			this.#error(e);
			return false;
		}
	}

	/**
	 * Adds an ICE candidate received from the remote peer.
	 * @param candidate - The ICE candidate to add, or null for end-of-candidates.
	 * @returns True if successful, false otherwise.
	 */
	async addIceCandidate(
		candidate: RTCIceCandidateInit | null
	): Promise<boolean> {
		if (!this.#pc) return false;
		try {
			if (candidate) {
				await this.#pc.addIceCandidate(candidate);
			}
			return true;
		} catch (e) {
			this.#error(e);
			return false;
		}
	}

	/**
	 * Performs an ICE restart to recover from connection issues.
	 * Creates a new offer with iceRestart flag and sets it as local description.
	 * @returns True if successful, false otherwise.
	 */
	async iceRestart(): Promise<boolean> {
		if (!this.#pc) return false;
		try {
			const offer = await this.#pc.createOffer({ iceRestart: true });
			await this.#pc.setLocalDescription(offer);
			return true;
		} catch (e) {
			this.#error(e);
			return false;
		}
	}

	/**
	 * Returns the current local session description.
	 * @returns The local description, or null if not set.
	 */
	getLocalDescription(): RTCSessionDescription | null {
		return this.#pc?.localDescription ?? null;
	}

	/**
	 * Returns the current remote session description.
	 * @returns The remote description, or null if not set.
	 */
	getRemoteDescription(): RTCSessionDescription | null {
		return this.#pc?.remoteDescription ?? null;
	}

	/**
	 * Retrieves WebRTC statistics for the peer connection.
	 * @returns Stats report, or null if peer connection not initialized.
	 */
	async getStats(): Promise<RTCStatsReport | null> {
		if (!this.#pc) return null;
		try {
			return await this.#pc.getStats();
		} catch (e) {
			this.#error(e);
			return null;
		}
	}

	// --- Private ---

	#dispatch(event: WebRtcFsmEvent) {
		const oldState = this.#fsm.state;
		this.#fsm.transition(event);
		const newState = this.#fsm.state;

		if (oldState !== newState) {
			this.#pubsub.publish("state_change", newState);
		}
	}

	#debug(...args: any[]) {
		if (this.#config.debug) {
			console.debug("[WebRtcManager]", ...args);
		}
	}

	#error(error: any) {
		console.error(error);
		this.#dispatch(WebRtcFsmEvent.ERROR);
		this.#pubsub.publish("error", error);
	}

	#setupPcListeners() {
		if (!this.#pc) return;

		this.#pc.onconnectionstatechange = () => {
			const state = this.#pc!.connectionState;
			if (state === "connected") {
				// Connection successful - reset reconnect attempts
				this.#reconnectAttempts = 0;
				this.#dispatch(WebRtcFsmEvent.CONNECTED);
			} else if (state === "failed") {
				// Connection failed - attempt reconnection if enabled
				this.#handleConnectionFailure();
			} else if (state === "disconnected" || state === "closed") {
				this.#dispatch(WebRtcFsmEvent.DISCONNECT);
			}
		};

		this.#pc.ontrack = (event) => {
			if (event.streams && event.streams[0]) {
				this.#remoteStream = event.streams[0];
				this.#pubsub.publish("remote_stream", this.#remoteStream);
			}
		};

		this.#pc.ondatachannel = (event) => {
			const dc = event.channel;
			this.#setupDataChannelListeners(dc);
			this.#dataChannels.set(dc.label, dc);
		};

		this.#pc.onicecandidate = (event) => {
			this.#pubsub.publish("ice_candidate", event.candidate);
		};
	}

	#cleanup() {
		// Clear any pending reconnect timers
		if (this.#reconnectTimer !== null) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}

		// Remove device change listener
		if (this.#deviceChangeHandler) {
			navigator.mediaDevices.removeEventListener(
				"devicechange",
				this.#deviceChangeHandler
			);
			this.#deviceChangeHandler = null;
		}

		// Close all data channels
		this.#dataChannels.forEach((dc) => {
			if (dc.readyState !== "closed") {
				dc.close();
			}
		});
		this.#dataChannels.clear();

		// Stop local stream tracks
		if (this.#localStream) {
			this.#localStream.getTracks().forEach((track) => track.stop());
			this.#localStream = null;
		}

		// Close peer connection
		if (this.#pc) {
			this.#pc.close();
			this.#pc = null;
		}

		this.#remoteStream = null;
	}

	#handleConnectionFailure() {
		this.#dispatch(WebRtcFsmEvent.DISCONNECT);

		// Check if auto-reconnect is enabled
		if (!this.#config.autoReconnect) {
			return;
		}

		const maxAttempts = this.#config.maxReconnectAttempts ?? 5;

		// Check if we've exceeded max attempts
		if (this.#reconnectAttempts >= maxAttempts) {
			this.#pubsub.publish("reconnect_failed", {
				attempts: this.#reconnectAttempts,
			});
			return;
		}

		// Transition to RECONNECTING state
		this.#dispatch(WebRtcFsmEvent.RECONNECTING);

		// Attempt reconnection with exponential backoff
		this.#attemptReconnect();
	}

	#attemptReconnect() {
		this.#reconnectAttempts++;
		const baseDelay = this.#config.reconnectDelay ?? 1000;
		const delay = baseDelay * Math.pow(2, this.#reconnectAttempts - 1);

		// Try ICE restart first (attempts 1-2), then full reconnect
		const strategy = this.#reconnectAttempts <= 2 ? "ice-restart" : "full";

		this.#pubsub.publish("reconnecting", {
			attempt: this.#reconnectAttempts,
			strategy,
		});

		this.#reconnectTimer = setTimeout(async () => {
			this.#reconnectTimer = null;

			if (strategy === "ice-restart" && this.#pc) {
				// Try ICE restart - keep existing connection
				const success = await this.iceRestart();
				if (!success) {
					// ICE restart failed, will try again or switch to full reconnect
					this.#handleConnectionFailure();
				}
				// If successful, onconnectionstatechange will reset attempts
			} else {
				// Full reconnection - create new connection
				// IMPORTANT: This will only initialize the connection. Consumers MUST
				// listen for the 'reconnecting' event with strategy='full' and manually
				// perform the signaling handshake (create offer/answer exchange) to
				// complete the reconnection.
				try {
					await this.connect();
					// If successful, onconnectionstatechange will reset attempts
				} catch (e) {
					console.error("Reconnection failed:", e);
					this.#handleConnectionFailure();
				}
			}
		}, delay) as unknown as number;
	}

	#setupDeviceChangeListener() {
		// Only setup in browser environment with navigator.mediaDevices
		if (typeof navigator === "undefined" || !navigator.mediaDevices) {
			return;
		}

		// Don't setup twice
		if (this.#deviceChangeHandler) {
			return;
		}

		this.#deviceChangeHandler = async () => {
			try {
				const devices = await this.getAudioInputDevices();
				this.#pubsub.publish("device_changed", devices);
			} catch (e) {
				console.error("Error handling device change:", e);
			}
		};

		navigator.mediaDevices.addEventListener(
			"devicechange",
			this.#deviceChangeHandler
		);
	}

	#setupDataChannelListeners(dc: RTCDataChannel) {
		dc.onopen = () => {
			this.#pubsub.publish("data_channel_open", dc);
		};
		dc.onmessage = (event) => {
			this.#pubsub.publish("data_channel_message", {
				channel: dc,
				data: event.data,
			});
		};
		dc.onclose = () => {
			this.#pubsub.publish("data_channel_close", dc);
			this.#dataChannels.delete(dc.label);
		};
		dc.onerror = (error) => {
			console.error("Data Channel Error:", error);
			this.#pubsub.publish("error", error);
		};
	}
}
