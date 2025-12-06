import { FSM } from "@marianmeres/fsm";
import { PubSub } from "@marianmeres/pubsub";
import {
	type WebRtcFactory,
	type WebRtcManagerConfig,
	type Logger,
	WebRtcState,
	WebRtcFsmEvent,
	type WebRtcEvents,
} from "./types.ts";

/**
 * Default console-based logger that wraps console methods.
 * Returns string representation of the first argument for chaining.
 */
const createDefaultLogger = (): Logger => ({
	// deno-lint-ignore no-explicit-any
	debug: (...args: any[]) => {
		console.debug(...args);
		return String(args[0] ?? "");
	},
	// deno-lint-ignore no-explicit-any
	log: (...args: any[]) => {
		console.log(...args);
		return String(args[0] ?? "");
	},
	// deno-lint-ignore no-explicit-any
	warn: (...args: any[]) => {
		console.warn(...args);
		return String(args[0] ?? "");
	},
	// deno-lint-ignore no-explicit-any
	error: (...args: any[]) => {
		console.error(...args);
		return String(args[0] ?? "");
	},
});

/**
 * WebRTC connection manager with FSM-based lifecycle and event-driven architecture.
 *
 * Provides a high-level API for managing WebRTC peer connections, audio streams,
 * and data channels. The manager uses a finite state machine to handle connection
 * lifecycle and emits events for all state changes and important occurrences.
 *
 * @example
 * ```typescript
 * const factory = {
 *   createPeerConnection: (config) => new RTCPeerConnection(config),
 *   getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
 *   enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
 * };
 *
 * const manager = new WebRtcManager(factory, {
 *   peerConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
 *   enableMicrophone: true,
 * });
 *
 * await manager.initialize();
 * await manager.connect();
 * const offer = await manager.createOffer();
 * await manager.setLocalDescription(offer);
 * ```
 */
export class WebRtcManager {
	/** Event emitted when connection state changes. Payload: {@link WebRtcState} */
	static readonly EVENT_STATE_CHANGE = "state_change";
	/** Event emitted when local media stream changes. Payload: `MediaStream | null` */
	static readonly EVENT_LOCAL_STREAM = "local_stream";
	/** Event emitted when remote media stream is received. Payload: `MediaStream | null` */
	static readonly EVENT_REMOTE_STREAM = "remote_stream";
	/** Event emitted when a data channel opens. Payload: `RTCDataChannel` */
	static readonly EVENT_DATA_CHANNEL_OPEN = "data_channel_open";
	/** Event emitted when a data channel receives a message. Payload: `{ channel: RTCDataChannel; data: any }` */
	static readonly EVENT_DATA_CHANNEL_MESSAGE = "data_channel_message";
	/** Event emitted when a data channel closes. Payload: `RTCDataChannel` */
	static readonly EVENT_DATA_CHANNEL_CLOSE = "data_channel_close";
	/** Event emitted when an ICE candidate is generated. Payload: `RTCIceCandidate | null` */
	static readonly EVENT_ICE_CANDIDATE = "ice_candidate";
	/** Event emitted when reconnection is attempted. Payload: `{ attempt: number; strategy: "ice-restart" | "full" }` */
	static readonly EVENT_RECONNECTING = "reconnecting";
	/** Event emitted when all reconnection attempts fail. Payload: `{ attempts: number }` */
	static readonly EVENT_RECONNECT_FAILED = "reconnect_failed";
	/** Event emitted when audio devices change. Payload: `MediaDeviceInfo[]` */
	static readonly EVENT_DEVICE_CHANGED = "device_changed";
	/** Event emitted when microphone access fails. Payload: `{ error?: any; reason?: string }` */
	static readonly EVENT_MICROPHONE_FAILED = "microphone_failed";
	/** Event emitted when an error occurs. Payload: `Error` */
	static readonly EVENT_ERROR = "error";

	#fsm: FSM<WebRtcState, WebRtcFsmEvent>;
	#pubsub: PubSub;
	#pc: RTCPeerConnection | null = null;
	#factory: WebRtcFactory;
	#config: WebRtcManagerConfig;
	#logger: Logger;
	#localStream: MediaStream | null = null;
	#remoteStream: MediaStream | null = null;
	#dataChannels: Map<string, RTCDataChannel> = new Map();
	#reconnectAttempts: number = 0;
	#reconnectTimer: number | null = null;
	#fullReconnectTimeoutTimer: number | null = null;
	#deviceChangeHandler: (() => void) | null = null;

	/**
	 * Creates a new WebRtcManager instance.
	 * @param factory - Factory object providing WebRTC primitives (peer connection, media, devices).
	 * @param config - Optional configuration for the manager.
	 */
	constructor(factory: WebRtcFactory, config: WebRtcManagerConfig = {}) {
		this.#factory = factory;
		this.#config = config;
		this.#logger = config.logger ?? createDefaultLogger();
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
	 * @param event - The event name to subscribe to (e.g., "state_change", "ice_candidate").
	 * @param handler - Callback function that receives the event data.
	 * @returns Unsubscribe function to remove the event listener.
	 */
	// deno-lint-ignore no-explicit-any
	on(event: keyof WebRtcEvents, handler: (data: any) => void): () => void {
		return this.#pubsub.subscribe(event, handler);
	}

	/**
	 * Subscribe to the overall state of the WebRTC manager.
	 * Compatible with Svelte stores - immediately calls handler with current state,
	 * then notifies on any changes to state, streams, or data channels.
	 * @param handler - Callback that receives the overall state object
	 * @returns Unsubscribe function to remove the event listener.
	 */
	subscribe(
		handler: (state: {
			state: WebRtcState;
			localStream: MediaStream | null;
			remoteStream: MediaStream | null;
			dataChannels: ReadonlyMap<string, RTCDataChannel>;
			peerConnection: RTCPeerConnection | null;
		}) => void
	): () => void {
		// Helper to get current overall state
		const getCurrentState = () => ({
			state: this.state,
			localStream: this.localStream,
			remoteStream: this.remoteStream,
			dataChannels: this.dataChannels,
			peerConnection: this.peerConnection,
		});

		// Immediately call handler with current state (Svelte store compatibility)
		handler(getCurrentState());

		// Subscribe to relevant events that affect the overall state
		const unsubscribers = [
			this.#pubsub.subscribe(WebRtcManager.EVENT_STATE_CHANGE, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRtcManager.EVENT_LOCAL_STREAM, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRtcManager.EVENT_REMOTE_STREAM, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRtcManager.EVENT_DATA_CHANNEL_OPEN, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRtcManager.EVENT_DATA_CHANNEL_CLOSE, () =>
				handler(getCurrentState())
			),
		];

		// Return combined unsubscribe function
		return () => {
			unsubscribers.forEach((unsub) => unsub());
		};
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
			this.#logger.error("[WebRtcManager] Failed to enumerate devices:", e);
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
			this.#logger.error(
				"[WebRtcManager] Cannot switch microphone: not initialized or no active stream"
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
			this.#pubsub.publish(WebRtcManager.EVENT_LOCAL_STREAM, newStream);

			return true;
		} catch (e) {
			this.#logger.error("[WebRtcManager] Failed to switch microphone:", e);
			this.#error(e);
			return false;
		}
	}

	/**
	 * Initializes the WebRTC peer connection and sets up media tracks.
	 * Must be called before creating offers or answers. Can only be called from IDLE state.
	 */
	async initialize(): Promise<void> {
		if (this.state !== WebRtcState.IDLE) {
			this.#debug("initialize() called but state is not IDLE:", this.state);
			return;
		}
		this.#debug("Initializing...");
		this.#dispatch(WebRtcFsmEvent.INIT);

		try {
			this.#pc = this.#factory.createPeerConnection(this.#config.peerConfig);
			this.#debug("Peer connection created");
			this.#setupPcListeners();

			// Setup device change detection now that we have a connection
			this.#setupDeviceChangeListener();

			if (this.#config.enableMicrophone) {
				this.#debug("Enabling microphone (config enabled)");
				const success = await this.enableMicrophone(true);
				if (!success) {
					this.#pubsub.publish(WebRtcManager.EVENT_MICROPHONE_FAILED, {
						reason: "Failed to enable microphone during initialization",
					});
				}
			} else {
				// Always setup to receive audio, even if we don't enable microphone
				// This ensures the SDP includes audio media line
				this.#pc.addTransceiver("audio", { direction: "recvonly" });
				this.#debug("Added recvonly audio transceiver");
			}

			if (this.#config.dataChannelLabel) {
				this.#debug(
					"Creating default data channel:",
					this.#config.dataChannelLabel
				);
				this.createDataChannel(this.#config.dataChannelLabel);
			}
			this.#debug("Initialization complete");
		} catch (e) {
			this.#error(e);
		}
	}

	/**
	 * Transitions to the CONNECTING state. Automatically initializes if needed.
	 * If disconnected, reinitializes the peer connection.
	 */
	async connect(): Promise<void> {
		this.#debug("connect() called, current state:", this.state);

		// Initialize if needed
		if (this.state === WebRtcState.IDLE) {
			this.#debug("State is IDLE, initializing first");
			await this.initialize();
		}

		// Reinitialize if disconnected (PeerConnection was closed)
		if (this.state === WebRtcState.DISCONNECTED) {
			this.#debug("State is DISCONNECTED, reinitializing");
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
		) {
			this.#debug("Already connected or connecting, skipping");
			return;
		}

		this.#debug("Transitioning to CONNECTING");
		this.#dispatch(WebRtcFsmEvent.CONNECT);
	}

	/**
	 * Enables or disables the microphone and adds/removes audio tracks to the peer connection.
	 * @param enable - True to enable microphone, false to disable.
	 * @returns True if successful, false if failed to get user media.
	 */
	async enableMicrophone(enable: boolean): Promise<boolean> {
		this.#debug("enableMicrophone() called:", enable);

		if (enable) {
			if (this.#localStream) {
				this.#debug("Microphone already enabled");
				return true;
			}
			try {
				this.#debug("Requesting user media...");
				const stream = await this.#factory.getUserMedia({
					audio: true,
					video: false,
				});
				this.#debug(
					"User media obtained, tracks:",
					stream.getAudioTracks().length
				);
				this.#localStream = stream;
				this.#pubsub.publish(WebRtcManager.EVENT_LOCAL_STREAM, stream);

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
						this.#debug("Replaced track in existing transceiver");
					} else {
						// Add track normally
						stream.getTracks().forEach((track) => {
							this.#pc!.addTrack(track, stream);
						});
						this.#debug("Added tracks to peer connection");
					}
				}
				this.#debug("Microphone enabled successfully");
				return true;
			} catch (e) {
				this.#logger.error("[WebRtcManager] Failed to get user media:", e);
				this.#pubsub.publish(WebRtcManager.EVENT_MICROPHONE_FAILED, {
					error: e,
				});
				return false;
			}
		} else {
			if (!this.#localStream) {
				this.#debug("Microphone already disabled");
				return true;
			}
			this.#debug("Disabling microphone...");
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
			this.#pubsub.publish(WebRtcManager.EVENT_LOCAL_STREAM, null);
			this.#debug("Microphone disabled");
			return true;
		}
	}

	/**
	 * Disconnects the peer connection and cleans up all resources.
	 * Transitions to DISCONNECTED state.
	 */
	disconnect(): void {
		this.#debug("disconnect() called");
		this.#cleanup();
		this.#dispatch(WebRtcFsmEvent.DISCONNECT);
	}

	/**
	 * Resets the manager to IDLE state from any state.
	 * Cleans up all resources and allows reinitialization.
	 */
	reset(): void {
		this.#debug("reset() called, current state:", this.state);
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
		this.#debug("Reset complete, state:", this.state);
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
		this.#debug("createDataChannel() called:", label);

		if (!this.#pc) {
			this.#debug(
				"Cannot create data channel: peer connection not initialized"
			);
			return null;
		}
		if (this.#dataChannels.has(label)) {
			this.#debug("Returning existing data channel:", label);
			return this.#dataChannels.get(label)!;
		}

		try {
			const dc = this.#pc.createDataChannel(label, options);
			this.#setupDataChannelListeners(dc);
			this.#dataChannels.set(label, dc);
			this.#debug("Data channel created:", label);
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
		this.#debug("createOffer() called");
		if (!this.#pc) {
			this.#debug("Cannot create offer: peer connection not initialized");
			return null;
		}
		try {
			const offer = await this.#pc.createOffer(options);
			this.#debug("Offer created:", offer.type);
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
		this.#debug("createAnswer() called");
		if (!this.#pc) {
			this.#debug("Cannot create answer: peer connection not initialized");
			return null;
		}
		try {
			const answer = await this.#pc.createAnswer(options);
			this.#debug("Answer created:", answer.type);
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
		this.#debug("setLocalDescription() called:", description.type);
		if (!this.#pc) {
			this.#debug(
				"Cannot set local description: peer connection not initialized"
			);
			return false;
		}
		try {
			await this.#pc.setLocalDescription(description);
			this.#debug("Local description set successfully");
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
		this.#debug("setRemoteDescription() called:", description.type);
		if (!this.#pc) {
			this.#debug(
				"Cannot set remote description: peer connection not initialized"
			);
			return false;
		}
		try {
			await this.#pc.setRemoteDescription(description);
			this.#debug("Remote description set successfully");
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
		this.#debug(
			"addIceCandidate() called:",
			candidate ? "candidate" : "null (end-of-candidates)"
		);
		if (!this.#pc) {
			this.#debug("Cannot add ICE candidate: peer connection not initialized");
			return false;
		}
		try {
			if (candidate) {
				await this.#pc.addIceCandidate(candidate);
				this.#debug("ICE candidate added");
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
		this.#debug("iceRestart() called");
		if (!this.#pc) {
			this.#debug(
				"Cannot perform ICE restart: peer connection not initialized"
			);
			return false;
		}
		try {
			const offer = await this.#pc.createOffer({ iceRestart: true });
			await this.#pc.setLocalDescription(offer);
			this.#debug("ICE restart initiated");
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
			this.#debug(
				"State transition:",
				oldState,
				"->",
				newState,
				"(event:",
				event + ")"
			);
			this.#pubsub.publish(WebRtcManager.EVENT_STATE_CHANGE, newState);
		}
	}

	// deno-lint-ignore no-explicit-any
	#debug(...args: any[]) {
		if (this.#config.debug) {
			this.#logger.debug("[WebRtcManager]", ...args);
		}
	}

	// deno-lint-ignore no-explicit-any
	#error(error: any) {
		this.#logger.error("[WebRtcManager]", error);
		this.#dispatch(WebRtcFsmEvent.ERROR);
		this.#pubsub.publish(WebRtcManager.EVENT_ERROR, error);
	}

	#setupPcListeners() {
		if (!this.#pc) return;
		this.#debug("Setting up peer connection listeners");

		this.#pc.onconnectionstatechange = () => {
			const state = this.#pc!.connectionState;
			this.#debug("Connection state changed:", state);
			if (state === "connected") {
				// Connection successful - reset reconnect attempts and clear any pending timeout
				this.#reconnectAttempts = 0;
				if (this.#fullReconnectTimeoutTimer !== null) {
					clearTimeout(this.#fullReconnectTimeoutTimer);
					this.#fullReconnectTimeoutTimer = null;
				}
				this.#dispatch(WebRtcFsmEvent.CONNECTED);
			} else if (state === "failed") {
				// Connection failed - attempt reconnection if enabled
				this.#handleConnectionFailure();
			} else if (state === "disconnected" || state === "closed") {
				// Only dispatch if not already in a terminal state
				if (
					this.state !== WebRtcState.DISCONNECTED &&
					this.state !== WebRtcState.ERROR &&
					this.state !== WebRtcState.IDLE
				) {
					this.#dispatch(WebRtcFsmEvent.DISCONNECT);
				}
			}
		};

		this.#pc.ontrack = (event) => {
			this.#debug("Remote track received:", event.track.kind);
			if (event.streams && event.streams[0]) {
				this.#remoteStream = event.streams[0];
				this.#pubsub.publish(
					WebRtcManager.EVENT_REMOTE_STREAM,
					this.#remoteStream
				);
			}
		};

		this.#pc.ondatachannel = (event) => {
			const dc = event.channel;
			this.#debug("Remote data channel received:", dc.label);
			this.#setupDataChannelListeners(dc);
			this.#dataChannels.set(dc.label, dc);
		};

		this.#pc.onicecandidate = (event) => {
			this.#debug(
				"ICE candidate generated:",
				event.candidate ? "candidate" : "null (gathering complete)"
			);
			this.#pubsub.publish(WebRtcManager.EVENT_ICE_CANDIDATE, event.candidate);
		};
	}

	#cleanup() {
		this.#debug("Cleanup started");

		// Clear any pending reconnect timers
		if (this.#reconnectTimer !== null) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}

		// Clear any pending full reconnection timeout
		if (this.#fullReconnectTimeoutTimer !== null) {
			clearTimeout(this.#fullReconnectTimeoutTimer);
			this.#fullReconnectTimeoutTimer = null;
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
		const dcCount = this.#dataChannels.size;
		this.#dataChannels.forEach((dc) => {
			if (dc.readyState !== "closed") {
				dc.close();
			}
		});
		this.#dataChannels.clear();
		if (dcCount > 0) {
			this.#debug("Closed", dcCount, "data channel(s)");
		}

		// Stop local stream tracks
		if (this.#localStream) {
			this.#localStream.getTracks().forEach((track) => track.stop());
			this.#localStream = null;
			this.#debug("Local stream stopped");
		}

		// Close peer connection
		if (this.#pc) {
			this.#pc.close();
			this.#pc = null;
			this.#debug("Peer connection closed");
		}

		this.#remoteStream = null;
		this.#debug("Cleanup complete");
	}

	#handleConnectionFailure() {
		this.#debug("Handling connection failure");

		// Only dispatch DISCONNECT if not already in a terminal state
		if (
			this.state !== WebRtcState.DISCONNECTED &&
			this.state !== WebRtcState.ERROR &&
			this.state !== WebRtcState.IDLE
		) {
			this.#dispatch(WebRtcFsmEvent.DISCONNECT);
		}

		// Check if auto-reconnect is enabled
		if (!this.#config.autoReconnect) {
			this.#debug("Auto-reconnect disabled, not attempting reconnection");
			return;
		}

		const maxAttempts = this.#config.maxReconnectAttempts ?? 5;

		// Check if we've exceeded max attempts
		if (this.#reconnectAttempts >= maxAttempts) {
			this.#debug("Max reconnection attempts reached:", maxAttempts);
			this.#pubsub.publish(WebRtcManager.EVENT_RECONNECT_FAILED, {
				attempts: this.#reconnectAttempts,
			});
			return;
		}

		// Determine strategy for this attempt (next attempt number is current + 1)
		const nextAttempt = this.#reconnectAttempts + 1;
		const strategy = nextAttempt <= 2 ? "ice-restart" : "full";

		// Check shouldReconnect callback if provided
		if (this.#config.shouldReconnect) {
			const shouldProceed = this.#config.shouldReconnect?.({
				attempt: nextAttempt,
				maxAttempts,
				strategy,
			});
			if (!shouldProceed) {
				this.#debug("Reconnection suppressed by shouldReconnect callback");
				return;
			}
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

		this.#debug("Attempting reconnection:", {
			attempt: this.#reconnectAttempts,
			strategy,
			delay: delay + "ms",
		});

		this.#pubsub.publish(WebRtcManager.EVENT_RECONNECTING, {
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
					// Clean up old connection and reset to IDLE so connect() creates a new PC
					this.#cleanup();
					this.#dispatch(WebRtcFsmEvent.RESET);
					await this.connect();

					// Start timeout for full reconnection - if connection doesn't succeed
					// within the timeout, treat it as a failure
					const timeout = this.#config.fullReconnectTimeout ?? 30000;
					this.#fullReconnectTimeoutTimer = setTimeout(() => {
						this.#fullReconnectTimeoutTimer = null;
						// Only trigger failure if still not connected
						if (this.state !== WebRtcState.CONNECTED) {
							this.#debug(
								"Full reconnection timeout reached, connection not established"
							);
							this.#handleConnectionFailure();
						}
					}, timeout) as unknown as number;
				} catch (e) {
					this.#logger.error("[WebRtcManager] Reconnection failed:", e);
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
				this.#pubsub.publish(WebRtcManager.EVENT_DEVICE_CHANGED, devices);
			} catch (e) {
				this.#logger.error("[WebRtcManager] Error handling device change:", e);
			}
		};

		navigator.mediaDevices.addEventListener(
			"devicechange",
			this.#deviceChangeHandler
		);
	}

	#setupDataChannelListeners(dc: RTCDataChannel) {
		dc.onopen = () => {
			this.#pubsub.publish(WebRtcManager.EVENT_DATA_CHANNEL_OPEN, dc);
		};
		dc.onmessage = (event) => {
			this.#pubsub.publish(WebRtcManager.EVENT_DATA_CHANNEL_MESSAGE, {
				channel: dc,
				data: event.data,
			});
		};
		dc.onclose = () => {
			this.#pubsub.publish(WebRtcManager.EVENT_DATA_CHANNEL_CLOSE, dc);
			this.#dataChannels.delete(dc.label);
		};
		// deno-lint-ignore no-explicit-any
		dc.onerror = (error: any) => {
			// Ignore "User-Initiated Abort" errors which occur during intentional close()
			const isUserAbort = error?.error?.message?.includes(
				"User-Initiated Abort"
			);
			if (!isUserAbort) {
				this.#logger.error("[WebRtcManager] Data channel error:", error);
				this.#pubsub.publish(WebRtcManager.EVENT_ERROR, error);
			}
		};
	}
}
