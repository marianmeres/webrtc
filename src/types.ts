export interface WebRtcManagerConfig {
    /** Initial peer configuration (ICE servers, etc.) */
    peerConfig?: RTCConfiguration;
    /** Whether to enable microphone initially. Defaults to false. */
    enableMicrophone?: boolean;
    /** Label for the default data channel. If provided, a data channel will be created on connect. */
    dataChannelLabel?: string;
    /** Debug mode for logging */
    debug?: boolean;
}

export interface WebRtcFactory {
    createPeerConnection(config?: RTCConfiguration): RTCPeerConnection;
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export enum WebRtcState {
    IDLE = "IDLE",
    INITIALIZING = "INITIALIZING",
    CONNECTING = "CONNECTING",
    CONNECTED = "CONNECTED",
    DISCONNECTED = "DISCONNECTED",
    ERROR = "ERROR",
}

export enum WebRtcFsmEvent {
    INIT = "INIT",
    CONNECT = "CONNECT",
    CONNECTED = "CONNECTED",
    DISCONNECT = "DISCONNECT",
    ERROR = "ERROR",
    RESET = "RESET",
}

export interface WebRtcEvents {
    "state_change": WebRtcState;
    "local_stream": MediaStream | null;
    "remote_stream": MediaStream | null;
    "data_channel_open": RTCDataChannel;
    "data_channel_message": { channel: RTCDataChannel; data: any };
    "data_channel_close": RTCDataChannel;
    "ice_candidate": RTCIceCandidate | null;
    "error": Error;
}
