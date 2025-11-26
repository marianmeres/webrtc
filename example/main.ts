import { WebRtcManager } from "../src/webrtc_manager.ts";
import { WebRtcFactory, WebRtcState } from "../src/types.ts";

// 1. Implement the Factory for the Browser
class BrowserWebRtcFactory implements WebRtcFactory {
    createPeerConnection(config?: RTCConfiguration): RTCPeerConnection {
        return new RTCPeerConnection(config);
    }

    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
        return navigator.mediaDevices.getUserMedia(constraints);
    }
}

// 2. Initialize Manager
const factory = new BrowserWebRtcFactory();
const manager = new WebRtcManager(factory, {
    peerConfig: {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    },
    debug: true
});

// 3. UI Binding
const statusEl = document.getElementById("status")!;
const logsEl = document.getElementById("logs")!;
const btnInit = document.getElementById("btn-init") as HTMLButtonElement;
const btnConnect = document.getElementById("btn-connect") as HTMLButtonElement;
const btnDisconnect = document.getElementById("btn-disconnect") as HTMLButtonElement;
const btnMicOn = document.getElementById("btn-mic-on") as HTMLButtonElement;
const btnMicOff = document.getElementById("btn-mic-off") as HTMLButtonElement;

function log(msg: string, data?: any) {
    const div = document.createElement("div");
    div.className = "log-entry";
    const time = new Date().toISOString().split("T")[1].split(".")[0];
    const text = data ? `${msg} ${JSON.stringify(data)}` : msg;
    div.innerHTML = `<span class="log-time">${time}</span> ${text}`;
    logsEl.prepend(div);
    console.log(msg, data || "");
}

function updateButtons(state: WebRtcState) {
    statusEl.textContent = `State: ${state}`;
    
    btnInit.disabled = state !== WebRtcState.IDLE;
    btnConnect.disabled = state !== WebRtcState.INITIALIZING && state !== WebRtcState.DISCONNECTED;
    btnDisconnect.disabled = state !== WebRtcState.CONNECTED && state !== WebRtcState.CONNECTING;
}

// 4. Subscribe to Events
manager.on("state_change", (state: WebRtcState) => {
    log("State changed:", state);
    updateButtons(state);
});

manager.on("local_stream", (stream: MediaStream | null) => {
    log("Local stream update:", stream ? `Active (${stream.id})` : "Inactive");
    btnMicOn.disabled = !!stream;
    btnMicOff.disabled = !stream;
});

manager.on("remote_stream", (stream: MediaStream | null) => {
    log("Remote stream received:", stream ? stream.id : "null");
    if (stream) {
        const audio = new Audio();
        audio.srcObject = stream;
        audio.play().catch(e => log("Auto-play failed", e));
    }
});

manager.on("error", (err: any) => {
    log("Error:", err);
});

// 5. Event Listeners
btnInit.onclick = async () => {
    log("Initializing...");
    await manager.initialize();
};

btnConnect.onclick = async () => {
    log("Connecting...");
    await manager.connect();
};

btnDisconnect.onclick = () => {
    log("Disconnecting...");
    manager.disconnect();
};

btnMicOn.onclick = async () => {
    log("Enabling mic...");
    await manager.enableMicrophone(true);
};

btnMicOff.onclick = async () => {
    log("Disabling mic...");
    await manager.enableMicrophone(false);
};

// Initial state check
updateButtons(manager.state);
log("Ready.");
