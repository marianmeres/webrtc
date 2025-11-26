import { FSM } from "@marianmeres/fsm";
import { PubSub } from "@marianmeres/pubsub";
import {
	WebRtcFactory,
	WebRtcManagerConfig,
	WebRtcState,
	WebRtcFsmEvent,
	WebRtcEvents,
} from "./types.ts";

export class WebRtcManager {
	fsm: FSM<any, any>;
	#pubsub: PubSub;
	#pc: RTCPeerConnection | null = null;
	#factory: WebRtcFactory;
	#config: WebRtcManagerConfig;
	#localStream: MediaStream | null = null;
	#remoteStream: MediaStream | null = null;
	#dataChannels: Map<string, RTCDataChannel> = new Map();
	#reconnectAttempts: number = 0;
	#reconnectTimer: number | null = null;

	constructor(factory: WebRtcFactory, config: WebRtcManagerConfig = {}) {
		this.#factory = factory;
		this.#config = config;
		this.#pubsub = new PubSub();

		// Initialize FSM
		this.fsm = new FSM({
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

	get state(): WebRtcState {
		return this.fsm.state as WebRtcState;
	}

	on(event: keyof WebRtcEvents, handler: (data: any) => void) {
		return this.#pubsub.subscribe(event, handler);
	}

	subscribe(handler: (data: any) => void) {
		return this.#pubsub.subscribe("change", handler);
	}

	async initialize() {
		if (this.state !== WebRtcState.IDLE) return;
		this.#dispatch(WebRtcFsmEvent.INIT);

		try {
			this.#pc = this.#factory.createPeerConnection(this.#config.peerConfig);
			this.#setupPcListeners();

			// Always setup to receive audio, even if we don't enable microphone
			// This ensures the SDP includes audio media line
			if (!this.#config.enableMicrophone) {
				this.#pc.addTransceiver('audio', { direction: 'recvonly' });
			}

			if (this.#config.enableMicrophone) {
				await this.enableMicrophone(true);
			}

			if (this.#config.dataChannelLabel) {
				this.createDataChannel(this.#config.dataChannelLabel);
			}
		} catch (e) {
			this.#error(e);
		}
	}

	async connect() {
		// Initialize if needed
		if (this.state === WebRtcState.IDLE) {
			await this.initialize();
		}

		// Reinitialize if disconnected (PeerConnection was closed)
		if (this.state === WebRtcState.DISCONNECTED) {
			// Clean up old connection
			this.#cleanup();
			// Reset to IDLE and reinitialize
			this.fsm.transition(WebRtcFsmEvent.RESET);
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

	async enableMicrophone(enable: boolean) {
		if (enable) {
			if (this.#localStream) return; // Already enabled
			try {
				const stream = await this.#factory.getUserMedia({
					audio: true,
					video: false,
				});
				this.#localStream = stream;
				this.#pubsub.publish("local_stream", stream);

				if (this.#pc) {
					stream.getTracks().forEach((track) => {
						this.#pc!.addTrack(track, stream);
					});
				}
			} catch (e) {
				console.error("Failed to get user media", e);
				// Don't necessarily fail the whole connection, just the audio
			}
		} else {
			if (!this.#localStream) return;
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
		}
	}

	disconnect() {
		this.#cleanup();
		this.#dispatch(WebRtcFsmEvent.DISCONNECT);
	}

	reset() {
		this.#cleanup();
		if (
			this.state === WebRtcState.DISCONNECTED ||
			this.state === WebRtcState.ERROR
		) {
			this.#dispatch(WebRtcFsmEvent.RESET);
		}
	}

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

	// --- Signaling methods ---

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

	// --- Private ---

	#dispatch(event: WebRtcFsmEvent) {
		const oldState = this.fsm.state;
		this.fsm.transition(event);
		const newState = this.fsm.state;

		if (oldState !== newState) {
			this.#pubsub.publish("state_change", newState);
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
