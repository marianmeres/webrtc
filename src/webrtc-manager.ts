import { FSM } from "@marianmeres/fsm";
import { PubSub } from "@marianmeres/pubsub";
import { createClog, withNamespace, type Logger } from "@marianmeres/clog";
import {
	type WebRTCFactory,
	type WebRTCManagerConfig,
	WebRTCState,
	WebRTCFsmEvent,
	type WebRTCEvents,
	type GatherIceCandidatesOptions,
} from "./types.ts";

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
 * const manager = new WebRTCManager(factory, {
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
export class WebRTCManager<TContext = unknown> {
	/** Event emitted when connection state changes. Payload: {@link WebRTCState} */
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

	#fsm: FSM<WebRTCState, WebRTCFsmEvent>;
	#pubsub: PubSub;
	#pc: RTCPeerConnection | null = null;
	#factory: WebRTCFactory;
	#config: WebRTCManagerConfig;
	#logger: Logger;
	#localStream: MediaStream | null = null;
	#remoteStream: MediaStream | null = null;
	#dataChannels: Map<string, RTCDataChannel> = new Map();
	#reconnectAttempts: number = 0;

	/**
	 * User-defined context object for storing arbitrary data associated with this manager.
	 * Useful for attaching application-specific state (e.g., audio streams, metadata)
	 * without modifying the manager internals.
	 *
	 * @example
	 * ```typescript
	 * // With type parameter for full type safety:
	 * const manager = new WebRTCManager<{ audioStream: MediaStream; sessionId: string }>(factory);
	 * manager.context = { audioStream: myStream, sessionId: '123' };
	 * manager.context.audioStream; // typed as MediaStream
	 *
	 * // Without type parameter (backwards compatible):
	 * const manager = new WebRTCManager(factory);
	 * manager.context = { anything: 'goes' };
	 * ```
	 */
	context: TContext | null = null;
	#reconnectTimer: number | null = null;
	#fullReconnectTimeoutTimer: number | null = null;
	#deviceChangeHandler: (() => void) | null = null;

	/**
	 * Creates a new WebRTCManager instance.
	 * @param factory - Factory object providing WebRTC primitives (peer connection, media, devices).
	 * @param config - Optional configuration for the manager.
	 */
	constructor(factory: WebRTCFactory, config: WebRTCManagerConfig = {}) {
		this.#factory = factory;
		this.#config = config;
		this.#logger = withNamespace(
			config.logger ?? createClog(),
			"WebRTCManager"
		);
		this.#pubsub = new PubSub();

		// Initialize FSM
		this.#fsm = new FSM({
			initial: WebRTCState.IDLE,
			logger: this.#logger,
			states: {
				[WebRTCState.IDLE]: {
					on: { [WebRTCFsmEvent.INIT]: WebRTCState.INITIALIZING },
				},
				[WebRTCState.INITIALIZING]: {
					on: {
						[WebRTCFsmEvent.CONNECT]: WebRTCState.CONNECTING,
						[WebRTCFsmEvent.ERROR]: WebRTCState.ERROR,
					},
				},
				[WebRTCState.CONNECTING]: {
					on: {
						[WebRTCFsmEvent.CONNECTED]: WebRTCState.CONNECTED,
						[WebRTCFsmEvent.DISCONNECT]: WebRTCState.DISCONNECTED,
						[WebRTCFsmEvent.ERROR]: WebRTCState.ERROR,
					},
				},
				[WebRTCState.CONNECTED]: {
					on: {
						[WebRTCFsmEvent.DISCONNECT]: WebRTCState.DISCONNECTED,
						[WebRTCFsmEvent.ERROR]: WebRTCState.ERROR,
					},
				},
				[WebRTCState.RECONNECTING]: {
					on: {
						[WebRTCFsmEvent.CONNECT]: WebRTCState.CONNECTING,
						[WebRTCFsmEvent.DISCONNECT]: WebRTCState.DISCONNECTED,
						[WebRTCFsmEvent.RESET]: WebRTCState.IDLE,
					},
				},
				[WebRTCState.DISCONNECTED]: {
					on: {
						[WebRTCFsmEvent.CONNECT]: WebRTCState.CONNECTING,
						[WebRTCFsmEvent.RECONNECTING]: WebRTCState.RECONNECTING,
						[WebRTCFsmEvent.RESET]: WebRTCState.IDLE,
					},
				},
				[WebRTCState.ERROR]: {
					on: { [WebRTCFsmEvent.RESET]: WebRTCState.IDLE },
				},
			},
		});
	}

	// --- Public API ---

	/** Returns the current state of the WebRTC connection. */
	get state(): WebRTCState {
		return this.#fsm.state as WebRTCState;
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
	on(event: keyof WebRTCEvents, handler: (data: any) => void): () => void {
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
			state: WebRTCState;
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
			this.#pubsub.subscribe(WebRTCManager.EVENT_STATE_CHANGE, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRTCManager.EVENT_LOCAL_STREAM, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRTCManager.EVENT_REMOTE_STREAM, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRTCManager.EVENT_DATA_CHANNEL_OPEN, () =>
				handler(getCurrentState())
			),
			this.#pubsub.subscribe(WebRTCManager.EVENT_DATA_CHANNEL_CLOSE, () =>
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
			this.#logError("Failed to enumerate devices.", e);
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
			this.#logError(
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
			this.#pubsub.publish(WebRTCManager.EVENT_LOCAL_STREAM, newStream);

			return true;
		} catch (e) {
			this.#logError("Failed to switch microphone.", e);
			this.#handleError(e);
			return false;
		}
	}

	/**
	 * Initializes the WebRTC peer connection and sets up media tracks.
	 * Must be called before creating offers or answers. Can only be called from IDLE state.
	 */
	async initialize(): Promise<void> {
		if (this.state !== WebRTCState.IDLE) {
			this.#logger.debug(
				`Initialization skipped because state is ${this.state}, not IDLE.`
			);
			return;
		}
		this.#logger.debug("Initializing peer connection.");
		this.#dispatch(WebRTCFsmEvent.INIT);

		try {
			this.#pc = this.#factory.createPeerConnection(this.#config.peerConfig);
			this.#logger.debug("Peer connection created.");
			this.#setupPcListeners();

			// Setup device change detection now that we have a connection
			this.#setupDeviceChangeListener();

			if (this.#config.enableMicrophone) {
				this.#logger.debug("Enabling microphone as per configuration.");
				const success = await this.enableMicrophone(true);
				if (!success) {
					this.#pubsub.publish(WebRTCManager.EVENT_MICROPHONE_FAILED, {
						reason: "Failed to enable microphone during initialization",
					});
				}
			} else {
				// Always setup to receive audio, even if we don't enable microphone
				// This ensures the SDP includes audio media line
				this.#pc.addTransceiver("audio", { direction: "recvonly" });
				this.#logger.debug("Added receive-only audio transceiver.");
			}

			if (this.#config.dataChannelLabel) {
				this.#logger.debug(
					`Creating default data channel '${this.#config.dataChannelLabel}'.`
				);
				this.createDataChannel(this.#config.dataChannelLabel);
			}
			this.#logger.debug("Initialization complete.");
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
		}
	}

	/**
	 * Transitions to the CONNECTING state. Automatically initializes if needed.
	 * If disconnected, reinitializes the peer connection.
	 */
	async connect(): Promise<void> {
		this.#logger.debug(`Connect called with current state ${this.state}.`);

		// Initialize if needed
		if (this.state === WebRTCState.IDLE) {
			this.#logger.debug("State is IDLE, initializing first.");
			await this.initialize();
		}

		// Reinitialize if disconnected (PeerConnection was closed)
		if (this.state === WebRTCState.DISCONNECTED) {
			this.#logger.debug("State is DISCONNECTED, reinitializing.");
			// Clean up old connection
			this.#cleanup();
			// Reset to IDLE and reinitialize
			this.#fsm.transition(WebRTCFsmEvent.RESET);
			await this.initialize();
			// Stay in INITIALIZING state - caller needs to create offer/answer
			return;
		}

		if (
			this.state === WebRTCState.CONNECTED ||
			this.state === WebRTCState.CONNECTING
		) {
			this.#logger.debug("Already connected or connecting, skipping.");
			return;
		}

		this.#logger.debug("Transitioning to CONNECTING state.");
		this.#dispatch(WebRTCFsmEvent.CONNECT);
	}

	/**
	 * Enables or disables the microphone and adds/removes audio tracks to the peer connection.
	 * @param enable - True to enable microphone, false to disable.
	 * @returns True if successful, false if failed to get user media.
	 */
	async enableMicrophone(enable: boolean): Promise<boolean> {
		this.#logger.debug(`Enable microphone called with value ${enable}.`);

		if (enable) {
			if (this.#localStream) {
				this.#logger.debug("Microphone is already enabled.");
				return true;
			}
			try {
				this.#logger.debug("Requesting user media.");
				const stream = await this.#factory.getUserMedia({
					audio: true,
					video: false,
				});
				this.#logger.debug(
					`User media obtained with ${stream.getAudioTracks().length} track(s).`
				);
				this.#localStream = stream;
				this.#pubsub.publish(WebRTCManager.EVENT_LOCAL_STREAM, stream);

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
						this.#logger.debug("Replaced track in existing transceiver.");
					} else {
						// Add track normally
						stream.getTracks().forEach((track) => {
							this.#pc!.addTrack(track, stream);
						});
						this.#logger.debug("Added tracks to peer connection.");
					}
				}
				this.#logger.debug("Microphone enabled successfully.");
				return true;
			} catch (e) {
				this.#logError("Failed to get user media.", e);
				this.#pubsub.publish(WebRTCManager.EVENT_MICROPHONE_FAILED, {
					error: e,
				});
				return false;
			}
		} else {
			if (!this.#localStream) {
				this.#logger.debug("Microphone is already disabled.");
				return true;
			}
			this.#logger.debug("Disabling microphone.");
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
			this.#pubsub.publish(WebRTCManager.EVENT_LOCAL_STREAM, null);
			this.#logger.debug("Microphone disabled.");
			return true;
		}
	}

	/**
	 * Disconnects the peer connection and cleans up all resources.
	 * Transitions to DISCONNECTED state.
	 */
	disconnect(): void {
		this.#logger.debug("Disconnect called.");
		this.#cleanup();
		this.#dispatch(WebRTCFsmEvent.DISCONNECT);
	}

	/**
	 * Resets the manager to IDLE state from any state.
	 * Cleans up all resources and allows reinitialization.
	 */
	reset(): void {
		this.#logger.debug(`Reset called with current state ${this.state}.`);
		this.#cleanup();

		// Reset from any non-IDLE state
		if (this.state !== WebRTCState.IDLE) {
			// Force transition to DISCONNECTED first if needed, then to IDLE
			if (
				this.state === WebRTCState.ERROR ||
				this.state === WebRTCState.DISCONNECTED ||
				this.state === WebRTCState.RECONNECTING
			) {
				this.#dispatch(WebRTCFsmEvent.RESET);
			} else {
				// For other states, go through DISCONNECTED first
				this.#dispatch(WebRTCFsmEvent.DISCONNECT);
				this.#dispatch(WebRTCFsmEvent.RESET);
			}
		}
		this.#logger.debug(`Reset complete, state is now ${this.state}.`);
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
		this.#logger.debug(`Create data channel called for '${label}'.`);

		if (!this.#pc) {
			this.#logger.debug(
				"Cannot create data channel because peer connection is not initialized."
			);
			return null;
		}
		if (this.#dataChannels.has(label)) {
			this.#logger.debug(`Returning existing data channel '${label}'.`);
			return this.#dataChannels.get(label)!;
		}

		try {
			const dc = this.#pc.createDataChannel(label, options);
			this.#setupDataChannelListeners(dc);
			this.#dataChannels.set(label, dc);
			this.#logger.debug(`Data channel '${label}' created.`);
			return dc;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
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
			this.#logger.debug(`Data channel '${label}' not found.`);
			return false;
		}
		if (channel.readyState !== "open") {
			this.#logger.debug(
				`Data channel '${label}' is not open, state is ${channel.readyState}.`
			);
			return false;
		}
		try {
			// deno-lint-ignore no-explicit-any
			channel.send(data as any);
			return true;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
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
		this.#logger.debug("Create offer called.");
		if (!this.#pc) {
			this.#logger.debug(
				"Cannot create offer because peer connection is not initialized."
			);
			return null;
		}
		try {
			const offer = await this.#pc.createOffer(options);
			this.#logger.debug(`Offer of type '${offer.type}' created.`);
			return offer;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
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
		this.#logger.debug("Create answer called.");
		if (!this.#pc) {
			this.#logger.debug(
				"Cannot create answer because peer connection is not initialized."
			);
			return null;
		}
		try {
			const answer = await this.#pc.createAnswer(options);
			this.#logger.debug(`Answer of type '${answer.type}' created.`);
			return answer;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
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
		this.#logger.debug(`Set local description called with type '${description.type}'.`);
		if (!this.#pc) {
			this.#logger.debug(
				"Cannot set local description because peer connection is not initialized."
			);
			return false;
		}
		try {
			await this.#pc.setLocalDescription(description);
			this.#logger.debug("Local description set successfully.");
			return true;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
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
		this.#logger.debug(`Set remote description called with type '${description.type}'.`);
		if (!this.#pc) {
			this.#logger.debug(
				"Cannot set remote description because peer connection is not initialized."
			);
			return false;
		}
		try {
			await this.#pc.setRemoteDescription(description);
			this.#logger.debug("Remote description set successfully.");
			return true;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
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
		this.#logger.debug(
			`Add ICE candidate called with ${candidate ? "a candidate" : "null (end of candidates)"}.`
		);
		if (!this.#pc) {
			this.#logger.debug(
				"Cannot add ICE candidate because peer connection is not initialized."
			);
			return false;
		}
		try {
			if (candidate) {
				await this.#pc.addIceCandidate(candidate);
				this.#logger.debug("ICE candidate added successfully.");
			}
			return true;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
			return false;
		}
	}

	/**
	 * Performs an ICE restart to recover from connection issues.
	 * Creates a new offer with iceRestart flag and sets it as local description.
	 * @returns True if successful, false otherwise.
	 */
	async iceRestart(): Promise<boolean> {
		this.#logger.debug("ICE restart called.");
		if (!this.#pc) {
			this.#logger.debug(
				"Cannot perform ICE restart because peer connection is not initialized."
			);
			return false;
		}
		try {
			const offer = await this.#pc.createOffer({ iceRestart: true });
			await this.#pc.setLocalDescription(offer);
			this.#logger.debug("ICE restart initiated.");
			return true;
		} catch (e) {
			this.#logError(e);
			this.#handleError(e);
			return false;
		}
	}

	/**
	 * Wait for ICE gathering to complete.
	 * Use this for HTTP POST signaling patterns where you need all ICE candidates
	 * bundled in the local description before sending to the server.
	 * @param options - Optional configuration for timeout and candidate callback.
	 */
	gatherIceCandidates(options: GatherIceCandidatesOptions = {}): Promise<void> {
		const { timeout = 10000, onCandidate } = options;

		if (!this.#pc) {
			return Promise.reject(new Error("Peer connection not initialized"));
		}

		const pc = this.#pc;

		if (pc.iceGatheringState === "complete") {
			this.#logger.debug("ICE gathering is already complete.");
			return Promise.resolve();
		}

		this.#logger.debug("Waiting for ICE gathering to complete.");

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("ICE gathering timeout"));
			}, timeout);

			const cleanup = () => {
				clearTimeout(timer);
				pc.removeEventListener("icegatheringstatechange", checkState);
				pc.removeEventListener("icecandidate", handleCandidate);
			};

			const checkState = () => {
				if (pc.iceGatheringState === "complete") {
					this.#logger.debug("ICE gathering complete via state change.");
					cleanup();
					resolve();
				}
			};

			const handleCandidate = (event: RTCPeerConnectionIceEvent) => {
				onCandidate?.(event.candidate);
				if (event.candidate === null) {
					this.#logger.debug("ICE gathering complete via null candidate.");
					cleanup();
					resolve();
				}
			};

			pc.addEventListener("icegatheringstatechange", checkState);
			pc.addEventListener("icecandidate", handleCandidate);
		});
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
			this.#logError(e);
			this.#handleError(e);
			return null;
		}
	}

	// --- Private ---

	#dispatch(event: WebRTCFsmEvent) {
		const oldState = this.#fsm.state;
		this.#fsm.transition(event);
		const newState = this.#fsm.state;

		if (oldState !== newState) {
			this.#logger.debug(
				`State transitioned from ${oldState} to ${newState} on event ${event}.`
			);
			this.#pubsub.publish(WebRTCManager.EVENT_STATE_CHANGE, newState);
		}
	}

	// deno-lint-ignore no-explicit-any
	#log(...args: any[]) {
		this.#logger.log(...args);
	}

	// deno-lint-ignore no-explicit-any
	#logWarn(...args: any[]) {
		this.#logger.warn(...args);
	}

	// deno-lint-ignore no-explicit-any
	#logError(...args: any[]) {
		this.#logger.error(...args);
	}

	// deno-lint-ignore no-explicit-any
	#handleError(error: any) {
		this.#dispatch(WebRTCFsmEvent.ERROR);
		this.#pubsub.publish(WebRTCManager.EVENT_ERROR, error);
	}

	#setupPcListeners() {
		if (!this.#pc) return;
		this.#logger.debug("Setting up peer connection listeners.");

		this.#pc.onconnectionstatechange = () => {
			const state = this.#pc!.connectionState;
			this.#logger.debug(`Connection state changed to ${state}.`);
			if (state === "connected") {
				// Only dispatch if in CONNECTING state (FSM can handle CONNECTED event)
				// This guards against late connection success after user has disconnected
				if (this.state === WebRTCState.CONNECTING) {
					// Connection successful - reset reconnect attempts and clear any pending timeout
					this.#reconnectAttempts = 0;
					if (this.#fullReconnectTimeoutTimer !== null) {
						clearTimeout(this.#fullReconnectTimeoutTimer);
						this.#fullReconnectTimeoutTimer = null;
					}
					this.#dispatch(WebRTCFsmEvent.CONNECTED);
				} else {
					this.#logger.debug(
						`Ignoring late connection success because current state is ${this.state}.`
					);
				}
			} else if (state === "failed") {
				// Connection failed - attempt reconnection if enabled
				this.#handleConnectionFailure();
			} else if (state === "disconnected" || state === "closed") {
				// Only dispatch if not already in a terminal state
				if (
					this.state !== WebRTCState.DISCONNECTED &&
					this.state !== WebRTCState.ERROR &&
					this.state !== WebRTCState.IDLE
				) {
					this.#dispatch(WebRTCFsmEvent.DISCONNECT);
				}
			}
		};

		this.#pc.ontrack = (event) => {
			this.#logger.debug(`Remote ${event.track.kind} track received.`);
			if (event.streams && event.streams[0]) {
				this.#remoteStream = event.streams[0];
				this.#pubsub.publish(
					WebRTCManager.EVENT_REMOTE_STREAM,
					this.#remoteStream
				);
			}
		};

		this.#pc.ondatachannel = (event) => {
			const dc = event.channel;
			this.#logger.debug(`Remote data channel '${dc.label}' received.`);
			this.#setupDataChannelListeners(dc);
			this.#dataChannels.set(dc.label, dc);
		};

		this.#pc.onicecandidate = (event) => {
			this.#logger.debug(
				`ICE candidate generated: ${event.candidate ? "candidate" : "null (gathering complete)"}.`
			);
			this.#pubsub.publish(WebRTCManager.EVENT_ICE_CANDIDATE, event.candidate);
		};
	}

	#cleanup() {
		this.#logger.debug("Cleanup started.");

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
			this.#logger.debug(`Closed ${dcCount} data channel(s).`);
		}

		// Stop local stream tracks
		if (this.#localStream) {
			this.#localStream.getTracks().forEach((track) => track.stop());
			this.#localStream = null;
			this.#logger.debug("Local stream stopped.");
		}

		// Close peer connection
		if (this.#pc) {
			this.#pc.close();
			this.#pc = null;
			this.#logger.debug("Peer connection closed.");
		}

		this.#remoteStream = null;
		this.#logger.debug("Cleanup complete.");
	}

	#handleConnectionFailure() {
		this.#logger.debug("Handling connection failure.");

		// Only dispatch DISCONNECT if not already in a terminal state
		if (
			this.state !== WebRTCState.DISCONNECTED &&
			this.state !== WebRTCState.ERROR &&
			this.state !== WebRTCState.IDLE
		) {
			this.#dispatch(WebRTCFsmEvent.DISCONNECT);
		}

		// Check if auto-reconnect is enabled
		if (!this.#config.autoReconnect) {
			this.#logger.debug(
				"Auto-reconnect is disabled, not attempting reconnection."
			);
			return;
		}

		const maxAttempts = this.#config.maxReconnectAttempts ?? 5;

		// Check if we've exceeded max attempts
		if (this.#reconnectAttempts >= maxAttempts) {
			this.#logger.debug(`Maximum reconnection attempts (${maxAttempts}) reached.`);
			this.#pubsub.publish(WebRTCManager.EVENT_RECONNECT_FAILED, {
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
				this.#logger.debug(
					"Reconnection suppressed by shouldReconnect callback."
				);
				return;
			}
		}

		// Transition to RECONNECTING state
		this.#dispatch(WebRTCFsmEvent.RECONNECTING);

		// Attempt reconnection with exponential backoff
		this.#attemptReconnect();
	}

	#attemptReconnect() {
		this.#reconnectAttempts++;
		const baseDelay = this.#config.reconnectDelay ?? 1000;
		const delay = baseDelay * Math.pow(2, this.#reconnectAttempts - 1);

		// Try ICE restart first (attempts 1-2), then full reconnect
		const strategy = this.#reconnectAttempts <= 2 ? "ice-restart" : "full";

		this.#logger.debug(
			`Attempting reconnection (attempt ${this.#reconnectAttempts}, strategy: ${strategy}, delay: ${delay}ms).`
		);

		this.#pubsub.publish(WebRTCManager.EVENT_RECONNECTING, {
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
					this.#dispatch(WebRTCFsmEvent.RESET);
					await this.connect();

					// Start timeout for full reconnection - if connection doesn't succeed
					// within the timeout, treat it as a failure
					const timeout = this.#config.fullReconnectTimeout ?? 30000;
					this.#fullReconnectTimeoutTimer = setTimeout(() => {
						this.#fullReconnectTimeoutTimer = null;
						// Only trigger failure if still not connected
						if (this.state !== WebRTCState.CONNECTED) {
							this.#logger.debug(
								"Full reconnection timeout reached, connection was not established."
							);
							this.#handleConnectionFailure();
						}
					}, timeout) as unknown as number;
				} catch (e) {
					this.#logError("Reconnection failed.", e);
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
				this.#pubsub.publish(WebRTCManager.EVENT_DEVICE_CHANGED, devices);
			} catch (e) {
				this.#logError("Error handling device change.", e);
			}
		};

		navigator.mediaDevices.addEventListener(
			"devicechange",
			this.#deviceChangeHandler
		);
	}

	#setupDataChannelListeners(dc: RTCDataChannel) {
		dc.onopen = () => {
			this.#pubsub.publish(WebRTCManager.EVENT_DATA_CHANNEL_OPEN, dc);
		};
		dc.onmessage = (event) => {
			this.#pubsub.publish(WebRTCManager.EVENT_DATA_CHANNEL_MESSAGE, {
				channel: dc,
				data: event.data,
			});
		};
		dc.onclose = () => {
			this.#pubsub.publish(WebRTCManager.EVENT_DATA_CHANNEL_CLOSE, dc);
			this.#dataChannels.delete(dc.label);
		};
		// deno-lint-ignore no-explicit-any
		dc.onerror = (error: any) => {
			// Ignore "User-Initiated Abort" errors which occur during intentional close()
			const isUserAbort = error?.error?.message?.includes(
				"User-Initiated Abort"
			);
			if (!isUserAbort) {
				this.#logError("Data channel error occurred.", error);
				this.#pubsub.publish(WebRTCManager.EVENT_ERROR, error);
			}
		};
	}
}
