import { WebRtcManager } from "../src/webrtc_manager.ts";
import { WebRtcFactory, WebRtcState } from "../src/types.ts";

// Browser WebRTC Factory
class BrowserWebRtcFactory implements WebRtcFactory {
    createPeerConnection(config?: RTCConfiguration): RTCPeerConnection {
        return new RTCPeerConnection(config);
    }
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
        return navigator.mediaDevices.getUserMedia(constraints);
    }
}

// Detect which peer we are based on the HTML filename
const isPeer1 = window.location.pathname.includes('peer1');
const peerNumber = isPeer1 ? 1 : 2;

// Simple localStorage-based signaling
const SIGNALING_KEY_OFFER = "webrtc_offer";
const SIGNALING_KEY_ANSWER = "webrtc_answer";
const SIGNALING_KEY_ICE_1 = "webrtc_ice_1";
const SIGNALING_KEY_ICE_2 = "webrtc_ice_2";

// Create peer
const factory = new BrowserWebRtcFactory();
const peer = new WebRtcManager(factory, {
    peerConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
    dataChannelLabel: isPeer1 ? "chat" : undefined
});

// UI Elements
const status = document.getElementById("status")!;
const logs = document.getElementById("logs")!;
const chat = document.getElementById("chat")!;
const input = document.getElementById("input") as HTMLInputElement;
const btnInit = document.getElementById("btn-init") as HTMLButtonElement;
const btnOffer = document.getElementById("btn-offer") as HTMLButtonElement;
const btnAnswer = document.getElementById("btn-answer") as HTMLButtonElement;
const btnDisconnect = document.getElementById("btn-disconnect") as HTMLButtonElement;
const btnReconnect = document.getElementById("btn-reconnect") as HTMLButtonElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;

// Data channel
let dataChannel: RTCDataChannel | null = null;

// Logging
function log(msg: string) {
    const time = new Date().toISOString().split("T")[1].split(".")[0];
    const div = document.createElement("div");
    div.textContent = `[${time}] ${msg}`;
    logs.prepend(div);
    console.log(`Peer ${peerNumber}:`, msg);
}

function addChatMessage(msg: string, sent: boolean) {
    const div = document.createElement("div");
    div.className = `msg ${sent ? 'msg-sent' : 'msg-received'}`;
    div.textContent = `${sent ? 'You' : 'Peer'}: ${msg}`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function updateButtons(state: WebRtcState) {
    status.textContent = `State: ${state}`;
    btnInit.disabled = state !== WebRtcState.IDLE;
    
    if (isPeer1) {
        btnOffer.disabled = state !== WebRtcState.INITIALIZING;
        btnDisconnect.disabled = state !== WebRtcState.CONNECTED && state !== WebRtcState.CONNECTING;
    } else {
        btnAnswer.disabled = state !== WebRtcState.INITIALIZING;
        btnDisconnect.disabled = state !== WebRtcState.CONNECTED && state !== WebRtcState.CONNECTING;
    }
    
    btnReconnect.disabled = state !== WebRtcState.DISCONNECTED;
    
    const isConnected = state === WebRtcState.CONNECTED;
    input.disabled = !isConnected;
    btnSend.disabled = !isConnected;
}

// Peer event handlers
peer.on("state_change", (state) => {
    log(`State: ${state}`);
    updateButtons(state);
});

peer.on("data_channel_open", (dc) => {
    log(`Data channel "${dc.label}" opened`);
    dataChannel = dc;
});

peer.on("data_channel_message", ({ data }) => {
    log(`Received: ${data}`);
    addChatMessage(data, false);
});

peer.on("ice_candidate", (candidate) => {
    if (candidate) {
        log("Got ICE candidate");
        const key = isPeer1 ? SIGNALING_KEY_ICE_1 : SIGNALING_KEY_ICE_2;
        const existing = JSON.parse(localStorage.getItem(key) || "[]");
        existing.push(candidate.toJSON());
        localStorage.setItem(key, JSON.stringify(existing));
    }
});

// Button handlers
btnInit.onclick = async () => {
    log("Initializing...");
    await peer.initialize();
};

if (isPeer1) {
    btnOffer.onclick = async () => {
        log("Creating offer...");
        await peer.connect();
        const offer = await peer.createOffer();
        if (offer) {
            await peer.setLocalDescription(offer);
            localStorage.setItem(SIGNALING_KEY_OFFER, JSON.stringify(offer));
            log("Offer created and sent");
        }
    };
} else {
    btnAnswer.onclick = async () => {
        const offerStr = localStorage.getItem(SIGNALING_KEY_OFFER);
        if (!offerStr) {
            log("No offer found!");
            return;
        }
        
        log("Setting remote description (offer)...");
        const offer = JSON.parse(offerStr);
        await peer.connect();
        await peer.setRemoteDescription(offer);
        
        // Add peer 1's ICE candidates
        const ice1 = JSON.parse(localStorage.getItem(SIGNALING_KEY_ICE_1) || "[]");
        for (const candidate of ice1) {
            await peer.addIceCandidate(candidate);
        }
        
        log("Creating answer...");
        const answer = await peer.createAnswer();
        if (answer) {
            await peer.setLocalDescription(answer);
            localStorage.setItem(SIGNALING_KEY_ANSWER, JSON.stringify(answer));
            log("Answer created and sent");
            
            // Trigger event so peer 1 can pick up the answer
            localStorage.setItem("peer2_answer_ready", Date.now().toString());
        }
    };
}

// Peer 1 listens for answer
if (isPeer1) {
    window.addEventListener("storage", async (e) => {
        if (e.key === "peer2_answer_ready") {
            const answerStr = localStorage.getItem(SIGNALING_KEY_ANSWER);
            if (answerStr) {
                log("Setting remote description (answer)...");
                await peer.setRemoteDescription(JSON.parse(answerStr));
                
                // Add peer 2's ICE candidates
                const ice2 = JSON.parse(localStorage.getItem(SIGNALING_KEY_ICE_2) || "[]");
                for (const candidate of ice2) {
                    await peer.addIceCandidate(candidate);
                }
            }
        }
    });
}

btnDisconnect.onclick = () => {
    log("Disconnecting...");
    peer.disconnect();
    dataChannel = null;
};

btnReconnect.onclick = async () => {
    log("Reconnecting...");
    // Clear signaling data for fresh connection
    if (isPeer1) {
        localStorage.removeItem(SIGNALING_KEY_OFFER);
        localStorage.removeItem(SIGNALING_KEY_ANSWER);
        localStorage.removeItem(SIGNALING_KEY_ICE_1);
        localStorage.removeItem(SIGNALING_KEY_ICE_2);
        localStorage.removeItem("peer2_answer_ready");
    }
    await peer.connect();
};

btnSend.onclick = () => {
    const msg = input.value.trim();
    if (msg && dataChannel) {
        dataChannel.send(msg);
        addChatMessage(msg, true);
        input.value = "";
    }
};

input.onkeypress = (e) => {
    if (e.key === "Enter") btnSend.click();
};

// Clear signaling on load for peer 1
if (isPeer1) {
    localStorage.removeItem(SIGNALING_KEY_OFFER);
    localStorage.removeItem(SIGNALING_KEY_ANSWER);
    localStorage.removeItem(SIGNALING_KEY_ICE_1);
    localStorage.removeItem(SIGNALING_KEY_ICE_2);
    localStorage.removeItem("peer2_answer_ready");
}

log("Ready");
updateButtons(peer.state);
