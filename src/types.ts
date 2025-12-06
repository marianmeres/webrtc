/**
 * Console-compatible logger interface (see @marianmeres/clog ).
 * Each method accepts variadic arguments and returns a string representation of the first argument.
 * This enables patterns like `throw new Error(logger.error("msg"))`.
 */
export interface Logger {
	// deno-lint-ignore no-explicit-any
	debug: (...args: any[]) => any;
	// deno-lint-ignore no-explicit-any
	log: (...args: any[]) => any;
	// deno-lint-ignore no-explicit-any
	warn: (...args: any[]) => any;
	// deno-lint-ignore no-explicit-any
	error: (...args: any[]) => any;
}

/**
 * Configuration options for WebRtcManager.
 * All options are optional with sensible defaults.
 */
export interface WebRtcManagerConfig {
	/** Initial peer configuration (ICE servers, etc.) */
	peerConfig?: RTCConfiguration;
	/** Whether to enable microphone initially. Defaults to false. */
	enableMicrophone?: boolean;
	/** Label for the default data channel. If provided, a data channel will be created on connect. */
	dataChannelLabel?: string;
	/** Enable automatic reconnection on connection failure. Defaults to false. */
	autoReconnect?: boolean;
	/** Maximum number of reconnection attempts. Defaults to 5. */
	maxReconnectAttempts?: number;
	/** Initial reconnection delay in ms. Doubles with each attempt. Defaults to 1000. */
	reconnectDelay?: number;
	/**
	 * Callback to determine whether reconnection should be attempted.
	 * Called before each reconnection attempt when autoReconnect is enabled.
	 * Return false to suppress reconnection (e.g., when peer disconnected intentionally).
	 * If not provided, reconnection proceeds automatically up to maxReconnectAttempts.
	 */
	shouldReconnect?: (context: {
		/** Current reconnection attempt number (1-based) */
		attempt: number;
		/** Maximum configured reconnection attempts */
		maxAttempts: number;
		/** Strategy that will be used: "ice-restart" for first attempts, "full" for later */
		strategy: "ice-restart" | "full";
	}) => boolean;
	/** Enable debug logging. Defaults to false. */
	debug?: boolean;
	/** Custom logger instance. If not provided, falls back to console. */
	logger?: Logger;
}

/**
 * Factory interface for creating WebRTC primitives.
 * Allows dependency injection of browser APIs for testing and flexibility.
 */
export interface WebRtcFactory {
	/**
	 * Creates a new RTCPeerConnection instance.
	 * @param config - Optional RTCConfiguration for ICE servers, certificates, etc.
	 * @returns A new RTCPeerConnection instance.
	 */
	createPeerConnection(config?: RTCConfiguration): RTCPeerConnection;
	/**
	 * Requests access to user media (microphone/camera).
	 * @param constraints - Media constraints specifying audio/video requirements.
	 * @returns Promise resolving to a MediaStream.
	 */
	getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
	/**
	 * Enumerates all available media input and output devices.
	 * @returns Promise resolving to an array of MediaDeviceInfo objects.
	 */
	enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

/**
 * Possible states of the WebRTC connection lifecycle.
 * The manager transitions between these states based on connection events.
 */
export enum WebRtcState {
	/** Initial state, no resources allocated. */
	IDLE = "IDLE",
	/** Creating peer connection and setting up media tracks. */
	INITIALIZING = "INITIALIZING",
	/** Performing SDP offer/answer exchange. */
	CONNECTING = "CONNECTING",
	/** Connection established, communication active. */
	CONNECTED = "CONNECTED",
	/** Automatic reconnection in progress. */
	RECONNECTING = "RECONNECTING",
	/** Connection closed, can be restarted. */
	DISCONNECTED = "DISCONNECTED",
	/** Error state, requires reset() to recover. */
	ERROR = "ERROR",
}

/**
 * Internal FSM events that trigger state transitions.
 * These events are dispatched internally by the manager methods.
 */
export enum WebRtcFsmEvent {
	/** Triggers transition from IDLE to INITIALIZING. */
	INIT = "initialize",
	/** Triggers transition to CONNECTING state. */
	CONNECT = "connect",
	/** Signals successful connection establishment. */
	CONNECTED = "connected",
	/** Triggers transition to RECONNECTING state. */
	RECONNECTING = "reconnecting",
	/** Triggers transition to DISCONNECTED state. */
	DISCONNECT = "disconnect",
	/** Triggers transition to ERROR state. */
	ERROR = "error",
	/** Resets the manager to IDLE state. */
	RESET = "reset",
}

/**
 * Type definitions for all WebRTC manager events and their payloads.
 * Use with the `on()` method to subscribe to specific events.
 */
export interface WebRtcEvents {
	/** Emitted when connection state changes. Payload: the new WebRtcState. */
	state_change: WebRtcState;
	/** Emitted when local media stream changes. Payload: MediaStream or null if disabled. */
	local_stream: MediaStream | null;
	/** Emitted when remote media stream is received. Payload: MediaStream or null. */
	remote_stream: MediaStream | null;
	/** Emitted when a data channel opens. Payload: the RTCDataChannel. */
	data_channel_open: RTCDataChannel;
	/** Emitted when a data channel receives a message. Payload: channel and data. */
	data_channel_message: { channel: RTCDataChannel; data: any };
	/** Emitted when a data channel closes. Payload: the RTCDataChannel. */
	data_channel_close: RTCDataChannel;
	/** Emitted when an ICE candidate is generated. Payload: RTCIceCandidate or null. */
	ice_candidate: RTCIceCandidate | null;
	/**
	 * Emitted when reconnection is being attempted.
	 * For 'full' strategy reconnections, consumers should listen for this event
	 * and re-establish signaling (create new offer/answer exchange).
	 * The manager will call connect() but cannot handle the signaling automatically.
	 */
	reconnecting: { attempt: number; strategy: "ice-restart" | "full" };
	/** Emitted when all reconnection attempts have failed. Payload: total attempts. */
	reconnect_failed: { attempts: number };
	/** Emitted when audio devices change. Payload: array of available audio inputs. */
	device_changed: MediaDeviceInfo[];
	/** Emitted when microphone access or switching fails. */
	// deno-lint-ignore no-explicit-any
	microphone_failed: { error?: any; reason?: string };
	/** Emitted when an error occurs. Payload: the Error object. */
	error: Error;
}
