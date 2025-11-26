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
	/** Debug mode for logging */
	debug?: boolean;
}

export interface WebRtcFactory {
	createPeerConnection(config?: RTCConfiguration): RTCPeerConnection;
	getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
	enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

export enum WebRtcState {
	IDLE = "IDLE",
	INITIALIZING = "INITIALIZING",
	CONNECTING = "CONNECTING",
	CONNECTED = "CONNECTED",
	RECONNECTING = "RECONNECTING",
	DISCONNECTED = "DISCONNECTED",
	ERROR = "ERROR",
}

export enum WebRtcFsmEvent {
	INIT = "initialize",
	CONNECT = "connect",
	CONNECTED = "connected",
	RECONNECTING = "reconnecting",
	DISCONNECT = "disconnect",
	ERROR = "error",
	RESET = "reset",
}

export interface WebRtcEvents {
	state_change: WebRtcState;
	local_stream: MediaStream | null;
	remote_stream: MediaStream | null;
	data_channel_open: RTCDataChannel;
	data_channel_message: { channel: RTCDataChannel; data: any };
	data_channel_close: RTCDataChannel;
	ice_candidate: RTCIceCandidate | null;
	/**
	 * Emitted when reconnection is being attempted.
	 * For 'full' strategy reconnections, consumers should listen for this event
	 * and re-establish signaling (create new offer/answer exchange).
	 * The manager will call connect() but cannot handle the signaling automatically.
	 */
	reconnecting: { attempt: number; strategy: "ice-restart" | "full" };
	reconnect_failed: { attempts: number };
	device_changed: MediaDeviceInfo[];
	microphone_failed: { error?: any; reason?: string };
	error: Error;
}
