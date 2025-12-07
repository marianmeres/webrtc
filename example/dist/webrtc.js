var WebRtcState;
(function(WebRtcState) {
    WebRtcState["IDLE"] = "IDLE";
    WebRtcState["INITIALIZING"] = "INITIALIZING";
    WebRtcState["CONNECTING"] = "CONNECTING";
    WebRtcState["CONNECTED"] = "CONNECTED";
    WebRtcState["RECONNECTING"] = "RECONNECTING";
    WebRtcState["DISCONNECTED"] = "DISCONNECTED";
    WebRtcState["ERROR"] = "ERROR";
})(WebRtcState || (WebRtcState = {}));
var WebRtcFsmEvent;
(function(WebRtcFsmEvent) {
    WebRtcFsmEvent["INIT"] = "initialize";
    WebRtcFsmEvent["CONNECT"] = "connect";
    WebRtcFsmEvent["CONNECTED"] = "connected";
    WebRtcFsmEvent["RECONNECTING"] = "reconnecting";
    WebRtcFsmEvent["DISCONNECT"] = "disconnect";
    WebRtcFsmEvent["ERROR"] = "error";
    WebRtcFsmEvent["RESET"] = "reset";
})(WebRtcFsmEvent || (WebRtcFsmEvent = {}));
export { WebRtcState as WebRtcState };
export { WebRtcFsmEvent as WebRtcFsmEvent };
class PubSub {
    #subs = new Map();
    #onError;
    constructor(options){
        this.#onError = options?.onError ?? this.#defaultErrorHandler;
    }
    #defaultErrorHandler(error, topic, isWildcard) {
        const prefix = isWildcard ? "wildcard subscriber" : "subscriber";
        console.error(`Error in ${prefix} for topic "${topic}":`, error);
    }
    publish(topic, data) {
        this.#subs.get(topic)?.forEach((cb)=>{
            try {
                cb(data);
            } catch (error) {
                this.#onError(error, topic, false);
            }
        });
        if (topic !== "*") {
            this.#subs.get("*")?.forEach((cb)=>{
                try {
                    cb({
                        event: topic,
                        data
                    });
                } catch (error) {
                    this.#onError(error, topic, true);
                }
            });
        }
        return this.#subs.has(topic);
    }
    subscribe(topic, cb) {
        if (!this.#subs.has(topic)) {
            this.#subs.set(topic, new Set());
        }
        this.#subs.get(topic).add(cb);
        return ()=>this.unsubscribe(topic, cb);
    }
    unsubscribe(topic, cb) {
        if (!this.#subs.has(topic)) return false;
        const subscribers = this.#subs.get(topic);
        let removed = true;
        if (typeof cb === "function") {
            removed = subscribers.delete(cb);
            if (subscribers?.size === 0) {
                this.#subs.delete(topic);
            }
        } else {
            this.#subs.delete(topic);
        }
        return removed;
    }
    subscribeOnce(topic, cb) {
        const onceWrapper = (data)=>{
            try {
                cb(data);
            } finally{
                this.unsubscribe(topic, onceWrapper);
            }
        };
        return this.subscribe(topic, onceWrapper);
    }
    unsubscribeAll(topic) {
        if (topic) {
            if (!this.#subs.has(topic)) {
                return false;
            }
            this.#subs.delete(topic);
            return true;
        }
        this.#subs.clear();
        return true;
    }
    isSubscribed(topic, cb, considerWildcard = true) {
        let has = !!this.#subs.get(topic)?.has(cb);
        if (considerWildcard) {
            has ||= !!this.#subs.get("*")?.has(cb);
        }
        return has;
    }
    __dump() {
        return Object.fromEntries(this.#subs.entries());
    }
}
function createPubSub(options) {
    return new PubSub(options);
}
function createPlaceholderGuard(notation) {
    const guardFn = ()=>true;
    guardFn.toJSON = ()=>`[GUARD: ${notation ?? "guarded"}]`;
    return guardFn;
}
function createPlaceholderAction(notation) {
    const actionFn = ()=>{};
    actionFn.toJSON = ()=>`[ACTION: ${notation ?? "action"}]`;
    return actionFn;
}
function fromMermaid(mermaidDiagram) {
    const lines = mermaidDiagram.trim().split("\n");
    const startIndex = lines.findIndex((line)=>line.trim().startsWith("stateDiagram-v2"));
    if (startIndex === -1) {
        throw new Error('Invalid mermaid diagram: must contain "stateDiagram-v2"');
    }
    let initial = null;
    const statesMap = new Map();
    for(let i = startIndex + 1; i < lines.length; i++){
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith("%%")) continue;
        if (line.startsWith("direction ")) continue;
        if (/^(classDef|class|style)\s/.test(line)) continue;
        if (/^state\s+["']/.test(line)) continue;
        if (/^state\s+\w+\s*\{/.test(line) || line === "{" || line === "}") continue;
        if (/^note\s/.test(line)) continue;
        if (/-->\s*\[\*\]\s*$/.test(line)) continue;
        const initialMatch = line.match(/^\[\*\]\s*-->\s*(\w+)$/);
        if (initialMatch) {
            initial = initialMatch[1];
            continue;
        }
        const transitionMatch = line.match(/^(\w+)\s*-->\s*(\w+):\s*(.+)$/);
        if (transitionMatch) {
            const [, fromState, toState, label] = transitionMatch;
            const parsed = parseLabel(label.trim());
            const from = fromState;
            const to = toState;
            const event = parsed.event;
            if (!statesMap.has(from)) {
                statesMap.set(from, new Map());
            }
            const stateTransitions = statesMap.get(from);
            if (!stateTransitions.has(event)) {
                stateTransitions.set(event, []);
            }
            const transitionObj = {};
            if (from === to && parsed.isInternalAction) {
                if (parsed.hasAction) {
                    transitionObj.action = createPlaceholderAction(parsed.actionNotation);
                }
            } else {
                transitionObj.target = to;
                if (parsed.hasGuard) {
                    transitionObj.guard = createPlaceholderGuard(parsed.guardNotation);
                }
                if (parsed.hasAction) {
                    transitionObj.action = createPlaceholderAction(parsed.actionNotation);
                }
            }
            stateTransitions.get(event).push(transitionObj);
        }
    }
    if (!initial) {
        throw new Error("Invalid mermaid diagram: no initial state found ([*] --> State)");
    }
    const states = {};
    for (const [stateName, transitions] of statesMap.entries()){
        const on = {};
        for (const [event, transitionArray] of transitions.entries()){
            if (transitionArray.length === 1) {
                const t = transitionArray[0];
                const hasOnlyTarget = t.target && t.guard === undefined && t.action === undefined;
                if (hasOnlyTarget) {
                    on[event] = t.target;
                } else {
                    on[event] = t;
                }
            } else {
                on[event] = transitionArray;
            }
        }
        states[stateName] = {
            on
        };
    }
    return {
        initial,
        states
    };
}
function parseLabel(label) {
    let event = label;
    let hasGuard = false;
    let guardNotation = null;
    let hasAction = false;
    let isInternalAction = false;
    let actionNotation = null;
    const actionMatch = label.match(/\s*\/\s*\((action(?:\s+[^)]*)?)\)$/);
    if (actionMatch) {
        hasAction = true;
        const actionContent = actionMatch[1];
        isInternalAction = actionContent === "action internal";
        if (actionContent !== "action" && actionContent !== "action internal") {
            actionNotation = `(${actionContent})`;
        }
        event = label.substring(0, actionMatch.index).trim();
    }
    const guardMatch = event.match(/\s*\[(guard(?:\s+[^\]]+)?|guarded)\]$/);
    if (guardMatch) {
        hasGuard = true;
        guardNotation = guardMatch[0].trim();
        event = event.substring(0, guardMatch.index).trim();
    }
    if (event === "* (any)") {
        event = "*";
    }
    return {
        event,
        hasGuard,
        guardNotation,
        hasAction,
        isInternalAction,
        actionNotation
    };
}
const defaultLogger = {
    debug: (...args)=>{
        console.debug(...args);
        return String(args[0] ?? "");
    },
    log: (...args)=>{
        console.log(...args);
        return String(args[0] ?? "");
    },
    warn: (...args)=>{
        console.warn(...args);
        return String(args[0] ?? "");
    },
    error: (...args)=>{
        console.error(...args);
        return String(args[0] ?? "");
    }
};
class FSM {
    config;
    #previous;
    #state;
    context;
    #pubsub;
    #logger;
    #debug;
    constructor(config){
        this.config = config;
        this.#previous = null;
        this.#pubsub = createPubSub();
        this.#debug = config.debug ?? false;
        this.#logger = config.logger ?? defaultLogger;
        this.#state = this.config.initial;
        this.context = this.#initContext();
        this.#log(`FSM created with initial state "${this.#state}"`);
    }
    #log(...args) {
        if (this.#debug) {
            this.#logger.debug("[FSM]", ...args);
        }
    }
    get state() {
        return this.#state;
    }
    #initContext() {
        if (typeof this.config.context === "function") {
            return this.config.context();
        }
        return {
            ...this.config.context ?? {}
        };
    }
    #getNotifyData() {
        return {
            current: this.#state,
            previous: this.#previous,
            context: this.context
        };
    }
    #notify() {
        this.#pubsub.publish("change", this.#getNotifyData());
    }
    subscribe(cb) {
        this.#log("subscribe() called");
        const unsub = this.#pubsub.subscribe("change", cb);
        cb(this.#getNotifyData());
        return unsub;
    }
    transition(event, payload, assert = true) {
        this.#log(`transition("${event}") called from state "${this.#state}"`);
        const currentStateConfig = this.config.states[this.#state];
        if (!currentStateConfig || !currentStateConfig.on) {
            throw new Error(`No transitions defined for state "${this.#state}"`);
        }
        let transitionDef = currentStateConfig.on[event];
        let usedWildcard = false;
        if (!transitionDef) {
            transitionDef = currentStateConfig.on["*"];
            usedWildcard = !!transitionDef;
            if (!transitionDef) {
                this.#log(`transition("${event}") failed: no matching transition`);
                if (assert) {
                    throw new Error(`Invalid transition "${event}" from state "${this.#state}"`);
                } else {
                    return this.#state;
                }
            }
        }
        if (usedWildcard) {
            this.#log(`transition("${event}") using wildcard "*"`);
        }
        const activeTransition = this.#resolveTransition(transitionDef, payload);
        if (!activeTransition) {
            this.#log(`transition("${event}") failed: guard rejected`);
            if (assert) {
                throw new Error(`No valid transition found for event "${event}" in state "${this.#state}"`);
            } else {
                return this.#state;
            }
        }
        if (!activeTransition.target) {
            this.#log(`transition("${event}") internal (no state change)`);
            if (typeof activeTransition.action === "function") {
                this.#log(`transition("${event}") executing action`);
                activeTransition.action(this.context, payload);
            }
            this.#notify();
            return this.#state;
        }
        const nextState = activeTransition.target;
        this.#log(`transition("${event}"): "${this.#state}" -> "${nextState}"`);
        if (typeof currentStateConfig.onExit === "function") {
            this.#log(`transition("${event}") executing onExit for "${this.#state}"`);
            currentStateConfig.onExit(this.context, payload);
        }
        if (typeof activeTransition.action === "function") {
            this.#log(`transition("${event}") executing action`);
            activeTransition.action(this.context, payload);
        }
        this.#previous = this.#state;
        this.#state = nextState;
        const nextStateConfig = this.config.states[nextState];
        if (typeof nextStateConfig.onEnter === "function") {
            this.#log(`transition("${event}") executing onEnter for "${nextState}"`);
            nextStateConfig.onEnter(this.context, payload);
        }
        this.#notify();
        return this.#state;
    }
    #resolveTransition(transition, payload) {
        if (typeof transition === "string") {
            return {
                target: transition
            };
        }
        const clonedContext = structuredClone(this.context);
        if (Array.isArray(transition)) {
            for (const t of transition){
                if (typeof t.guard === "function") {
                    if (t.guard(clonedContext, payload)) return t;
                } else {
                    return t;
                }
            }
            return null;
        }
        if (typeof transition.guard === "function") {
            return transition.guard(clonedContext, payload) ? transition : null;
        }
        return transition;
    }
    reset() {
        this.#log(`reset() called, returning to "${this.config.initial}"`);
        this.#state = this.config.initial;
        this.#previous = null;
        this.context = this.#initContext();
        this.#notify();
        return this;
    }
    is(state) {
        return this.#state === state;
    }
    canTransition(event, payload) {
        this.#log(`canTransition("${event}") called from state "${this.#state}"`);
        const currentStateConfig = this.config.states[this.#state];
        if (!currentStateConfig || !currentStateConfig.on) {
            this.#log(`canTransition("${event}") -> false (no transitions defined)`);
            return false;
        }
        let transitionDef = currentStateConfig.on[event];
        if (!transitionDef) {
            transitionDef = currentStateConfig.on["*"];
            if (!transitionDef) {
                this.#log(`canTransition("${event}") -> false (no matching transition)`);
                return false;
            }
        }
        const activeTransition = this.#resolveTransition(transitionDef, payload);
        const result = activeTransition !== null;
        this.#log(`canTransition("${event}") -> ${result}`);
        return result;
    }
    static fromMermaid(mermaidDiagram) {
        const config = fromMermaid(mermaidDiagram);
        return new FSM(config);
    }
    toMermaid() {
        let mermaid = "stateDiagram-v2\n";
        mermaid += `    [*] --> ${this.config.initial}\n`;
        for (const [stateName, stateConfig] of Object.entries(this.config.states)){
            for (const [event, _def] of Object.entries(stateConfig?.on ?? {})){
                const def = _def;
                const formatLabel = (evt, guardIdx, hasAction, isInternal)=>{
                    let label = evt === "*" ? "* (any)" : evt;
                    if (guardIdx !== null) label += ` [guard ${guardIdx}]`;
                    else if (guardIdx === -1) label += ` [guarded]`;
                    if (hasAction) {
                        if (isInternal) {
                            label += ` / (action internal)`;
                        } else {
                            label += ` / (action)`;
                        }
                    }
                    return label;
                };
                if (typeof def === "string") {
                    const label = event === "*" ? "* (any)" : event;
                    mermaid += `    ${stateName} --> ${def}: ${label}\n`;
                } else if (Array.isArray(def)) {
                    def.forEach((t, idx)=>{
                        const target = t.target ?? stateName;
                        const label = formatLabel(event, idx + 1, !!t.action, !t.target);
                        mermaid += `    ${stateName} --> ${target}: ${label}\n`;
                    });
                } else {
                    const target = def.target ?? stateName;
                    const label = formatLabel(event, def.guard ? -1 : null, !!def.action, !def.target);
                    mermaid += `    ${stateName} --> ${target}: ${label}\n`;
                }
            }
        }
        return mermaid;
    }
}
const createDefaultLogger = ()=>({
        debug: (...args)=>{
            console.debug(...args);
            return String(args[0] ?? "");
        },
        log: (...args)=>{
            console.log(...args);
            return String(args[0] ?? "");
        },
        warn: (...args)=>{
            console.warn(...args);
            return String(args[0] ?? "");
        },
        error: (...args)=>{
            console.error(...args);
            return String(args[0] ?? "");
        }
    });
class WebRtcManager {
    static EVENT_STATE_CHANGE = "state_change";
    static EVENT_LOCAL_STREAM = "local_stream";
    static EVENT_REMOTE_STREAM = "remote_stream";
    static EVENT_DATA_CHANNEL_OPEN = "data_channel_open";
    static EVENT_DATA_CHANNEL_MESSAGE = "data_channel_message";
    static EVENT_DATA_CHANNEL_CLOSE = "data_channel_close";
    static EVENT_ICE_CANDIDATE = "ice_candidate";
    static EVENT_RECONNECTING = "reconnecting";
    static EVENT_RECONNECT_FAILED = "reconnect_failed";
    static EVENT_DEVICE_CHANGED = "device_changed";
    static EVENT_MICROPHONE_FAILED = "microphone_failed";
    static EVENT_ERROR = "error";
    #fsm;
    #pubsub;
    #pc = null;
    #factory;
    #config;
    #logger;
    #localStream = null;
    #remoteStream = null;
    #dataChannels = new Map();
    #reconnectAttempts = 0;
    context = null;
    #reconnectTimer = null;
    #fullReconnectTimeoutTimer = null;
    #deviceChangeHandler = null;
    constructor(factory, config = {}){
        this.#factory = factory;
        this.#config = config;
        this.#logger = config.logger ?? createDefaultLogger();
        this.#pubsub = new PubSub();
        this.#fsm = new FSM({
            initial: WebRtcState.IDLE,
            states: {
                [WebRtcState.IDLE]: {
                    on: {
                        [WebRtcFsmEvent.INIT]: WebRtcState.INITIALIZING
                    }
                },
                [WebRtcState.INITIALIZING]: {
                    on: {
                        [WebRtcFsmEvent.CONNECT]: WebRtcState.CONNECTING,
                        [WebRtcFsmEvent.ERROR]: WebRtcState.ERROR
                    }
                },
                [WebRtcState.CONNECTING]: {
                    on: {
                        [WebRtcFsmEvent.CONNECTED]: WebRtcState.CONNECTED,
                        [WebRtcFsmEvent.DISCONNECT]: WebRtcState.DISCONNECTED,
                        [WebRtcFsmEvent.ERROR]: WebRtcState.ERROR
                    }
                },
                [WebRtcState.CONNECTED]: {
                    on: {
                        [WebRtcFsmEvent.DISCONNECT]: WebRtcState.DISCONNECTED,
                        [WebRtcFsmEvent.ERROR]: WebRtcState.ERROR
                    }
                },
                [WebRtcState.RECONNECTING]: {
                    on: {
                        [WebRtcFsmEvent.CONNECT]: WebRtcState.CONNECTING,
                        [WebRtcFsmEvent.DISCONNECT]: WebRtcState.DISCONNECTED,
                        [WebRtcFsmEvent.RESET]: WebRtcState.IDLE
                    }
                },
                [WebRtcState.DISCONNECTED]: {
                    on: {
                        [WebRtcFsmEvent.CONNECT]: WebRtcState.CONNECTING,
                        [WebRtcFsmEvent.RECONNECTING]: WebRtcState.RECONNECTING,
                        [WebRtcFsmEvent.RESET]: WebRtcState.IDLE
                    }
                },
                [WebRtcState.ERROR]: {
                    on: {
                        [WebRtcFsmEvent.RESET]: WebRtcState.IDLE
                    }
                }
            }
        });
    }
    get state() {
        return this.#fsm.state;
    }
    get dataChannels() {
        return this.#dataChannels;
    }
    get localStream() {
        return this.#localStream;
    }
    get remoteStream() {
        return this.#remoteStream;
    }
    get peerConnection() {
        return this.#pc;
    }
    toMermaid() {
        return this.#fsm.toMermaid();
    }
    on(event, handler) {
        return this.#pubsub.subscribe(event, handler);
    }
    subscribe(handler) {
        const getCurrentState = ()=>({
                state: this.state,
                localStream: this.localStream,
                remoteStream: this.remoteStream,
                dataChannels: this.dataChannels,
                peerConnection: this.peerConnection
            });
        handler(getCurrentState());
        const unsubscribers = [
            this.#pubsub.subscribe(WebRtcManager.EVENT_STATE_CHANGE, ()=>handler(getCurrentState())),
            this.#pubsub.subscribe(WebRtcManager.EVENT_LOCAL_STREAM, ()=>handler(getCurrentState())),
            this.#pubsub.subscribe(WebRtcManager.EVENT_REMOTE_STREAM, ()=>handler(getCurrentState())),
            this.#pubsub.subscribe(WebRtcManager.EVENT_DATA_CHANNEL_OPEN, ()=>handler(getCurrentState())),
            this.#pubsub.subscribe(WebRtcManager.EVENT_DATA_CHANNEL_CLOSE, ()=>handler(getCurrentState()))
        ];
        return ()=>{
            unsubscribers.forEach((unsub)=>unsub());
        };
    }
    async getAudioInputDevices() {
        try {
            const devices = await this.#factory.enumerateDevices();
            return devices.filter((d)=>d.kind === "audioinput");
        } catch (e) {
            this.#logger.error("[WebRtcManager] Failed to enumerate devices:", e);
            return [];
        }
    }
    async switchMicrophone(deviceId) {
        if (!this.#pc || !this.#localStream) {
            this.#logger.error("[WebRtcManager] Cannot switch microphone: not initialized or no active stream");
            return false;
        }
        try {
            const newStream = await this.#factory.getUserMedia({
                audio: {
                    deviceId: {
                        exact: deviceId
                    }
                },
                video: false
            });
            const newTrack = newStream.getAudioTracks()[0];
            if (!newTrack) {
                throw new Error("No audio track in new stream");
            }
            let sender = this.#pc.getSenders().find((s)=>s.track?.kind === "audio");
            if (!sender) {
                const transceivers = this.#pc.getTransceivers();
                const audioTransceiver = transceivers.find((t)=>t.receiver.track.kind === "audio");
                if (audioTransceiver) {
                    sender = audioTransceiver.sender;
                }
            }
            if (!sender) {
                throw new Error("No audio sender found - enable microphone first");
            }
            await sender.replaceTrack(newTrack);
            this.#localStream.getAudioTracks().forEach((track)=>track.stop());
            this.#localStream = newStream;
            this.#pubsub.publish(WebRtcManager.EVENT_LOCAL_STREAM, newStream);
            return true;
        } catch (e) {
            this.#logger.error("[WebRtcManager] Failed to switch microphone:", e);
            this.#error(e);
            return false;
        }
    }
    async initialize() {
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
            this.#setupDeviceChangeListener();
            if (this.#config.enableMicrophone) {
                this.#debug("Enabling microphone (config enabled)");
                const success = await this.enableMicrophone(true);
                if (!success) {
                    this.#pubsub.publish(WebRtcManager.EVENT_MICROPHONE_FAILED, {
                        reason: "Failed to enable microphone during initialization"
                    });
                }
            } else {
                this.#pc.addTransceiver("audio", {
                    direction: "recvonly"
                });
                this.#debug("Added recvonly audio transceiver");
            }
            if (this.#config.dataChannelLabel) {
                this.#debug("Creating default data channel:", this.#config.dataChannelLabel);
                this.createDataChannel(this.#config.dataChannelLabel);
            }
            this.#debug("Initialization complete");
        } catch (e) {
            this.#error(e);
        }
    }
    async connect() {
        this.#debug("connect() called, current state:", this.state);
        if (this.state === WebRtcState.IDLE) {
            this.#debug("State is IDLE, initializing first");
            await this.initialize();
        }
        if (this.state === WebRtcState.DISCONNECTED) {
            this.#debug("State is DISCONNECTED, reinitializing");
            this.#cleanup();
            this.#fsm.transition(WebRtcFsmEvent.RESET);
            await this.initialize();
            return;
        }
        if (this.state === WebRtcState.CONNECTED || this.state === WebRtcState.CONNECTING) {
            this.#debug("Already connected or connecting, skipping");
            return;
        }
        this.#debug("Transitioning to CONNECTING");
        this.#dispatch(WebRtcFsmEvent.CONNECT);
    }
    async enableMicrophone(enable) {
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
                    video: false
                });
                this.#debug("User media obtained, tracks:", stream.getAudioTracks().length);
                this.#localStream = stream;
                this.#pubsub.publish(WebRtcManager.EVENT_LOCAL_STREAM, stream);
                if (this.#pc) {
                    const transceivers = this.#pc.getTransceivers();
                    const audioTransceiver = transceivers.find((t)=>t.receiver.track.kind === "audio");
                    if (audioTransceiver && audioTransceiver.sender) {
                        const track = stream.getAudioTracks()[0];
                        await audioTransceiver.sender.replaceTrack(track);
                        audioTransceiver.direction = "sendrecv";
                        this.#debug("Replaced track in existing transceiver");
                    } else {
                        stream.getTracks().forEach((track)=>{
                            this.#pc.addTrack(track, stream);
                        });
                        this.#debug("Added tracks to peer connection");
                    }
                }
                this.#debug("Microphone enabled successfully");
                return true;
            } catch (e) {
                this.#logger.error("[WebRtcManager] Failed to get user media:", e);
                this.#pubsub.publish(WebRtcManager.EVENT_MICROPHONE_FAILED, {
                    error: e
                });
                return false;
            }
        } else {
            if (!this.#localStream) {
                this.#debug("Microphone already disabled");
                return true;
            }
            this.#debug("Disabling microphone...");
            this.#localStream.getTracks().forEach((track)=>{
                track.stop();
                if (this.#pc) {
                    const senders = this.#pc.getSenders();
                    const sender = senders.find((s)=>s.track === track);
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
    disconnect() {
        this.#debug("disconnect() called");
        this.#cleanup();
        this.#dispatch(WebRtcFsmEvent.DISCONNECT);
    }
    reset() {
        this.#debug("reset() called, current state:", this.state);
        this.#cleanup();
        if (this.state !== WebRtcState.IDLE) {
            if (this.state === WebRtcState.ERROR || this.state === WebRtcState.DISCONNECTED || this.state === WebRtcState.RECONNECTING) {
                this.#dispatch(WebRtcFsmEvent.RESET);
            } else {
                this.#dispatch(WebRtcFsmEvent.DISCONNECT);
                this.#dispatch(WebRtcFsmEvent.RESET);
            }
        }
        this.#debug("Reset complete, state:", this.state);
    }
    createDataChannel(label, options) {
        this.#debug("createDataChannel() called:", label);
        if (!this.#pc) {
            this.#debug("Cannot create data channel: peer connection not initialized");
            return null;
        }
        if (this.#dataChannels.has(label)) {
            this.#debug("Returning existing data channel:", label);
            return this.#dataChannels.get(label);
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
    getDataChannel(label) {
        return this.#dataChannels.get(label);
    }
    sendData(label, data) {
        const channel = this.#dataChannels.get(label);
        if (!channel) {
            this.#debug(`Data channel '${label}' not found`);
            return false;
        }
        if (channel.readyState !== "open") {
            this.#debug(`Data channel '${label}' is not open (state: ${channel.readyState})`);
            return false;
        }
        try {
            channel.send(data);
            return true;
        } catch (e) {
            this.#error(e);
            return false;
        }
    }
    async createOffer(options) {
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
    async createAnswer(options) {
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
    async setLocalDescription(description) {
        this.#debug("setLocalDescription() called:", description.type);
        if (!this.#pc) {
            this.#debug("Cannot set local description: peer connection not initialized");
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
    async setRemoteDescription(description) {
        this.#debug("setRemoteDescription() called:", description.type);
        if (!this.#pc) {
            this.#debug("Cannot set remote description: peer connection not initialized");
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
    async addIceCandidate(candidate) {
        this.#debug("addIceCandidate() called:", candidate ? "candidate" : "null (end-of-candidates)");
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
    async iceRestart() {
        this.#debug("iceRestart() called");
        if (!this.#pc) {
            this.#debug("Cannot perform ICE restart: peer connection not initialized");
            return false;
        }
        try {
            const offer = await this.#pc.createOffer({
                iceRestart: true
            });
            await this.#pc.setLocalDescription(offer);
            this.#debug("ICE restart initiated");
            return true;
        } catch (e) {
            this.#error(e);
            return false;
        }
    }
    getLocalDescription() {
        return this.#pc?.localDescription ?? null;
    }
    getRemoteDescription() {
        return this.#pc?.remoteDescription ?? null;
    }
    async getStats() {
        if (!this.#pc) return null;
        try {
            return await this.#pc.getStats();
        } catch (e) {
            this.#error(e);
            return null;
        }
    }
    #dispatch(event) {
        const oldState = this.#fsm.state;
        this.#fsm.transition(event);
        const newState = this.#fsm.state;
        if (oldState !== newState) {
            this.#debug("State transition:", oldState, "->", newState, "(event:", event + ")");
            this.#pubsub.publish(WebRtcManager.EVENT_STATE_CHANGE, newState);
        }
    }
    #debug(...args) {
        if (this.#config.debug) {
            this.#logger.debug("[WebRtcManager]", ...args);
        }
    }
    #error(error) {
        this.#logger.error("[WebRtcManager]", error);
        this.#dispatch(WebRtcFsmEvent.ERROR);
        this.#pubsub.publish(WebRtcManager.EVENT_ERROR, error);
    }
    #setupPcListeners() {
        if (!this.#pc) return;
        this.#debug("Setting up peer connection listeners");
        this.#pc.onconnectionstatechange = ()=>{
            const state = this.#pc.connectionState;
            this.#debug("Connection state changed:", state);
            if (state === "connected") {
                this.#reconnectAttempts = 0;
                if (this.#fullReconnectTimeoutTimer !== null) {
                    clearTimeout(this.#fullReconnectTimeoutTimer);
                    this.#fullReconnectTimeoutTimer = null;
                }
                this.#dispatch(WebRtcFsmEvent.CONNECTED);
            } else if (state === "failed") {
                this.#handleConnectionFailure();
            } else if (state === "disconnected" || state === "closed") {
                if (this.state !== WebRtcState.DISCONNECTED && this.state !== WebRtcState.ERROR && this.state !== WebRtcState.IDLE) {
                    this.#dispatch(WebRtcFsmEvent.DISCONNECT);
                }
            }
        };
        this.#pc.ontrack = (event)=>{
            this.#debug("Remote track received:", event.track.kind);
            if (event.streams && event.streams[0]) {
                this.#remoteStream = event.streams[0];
                this.#pubsub.publish(WebRtcManager.EVENT_REMOTE_STREAM, this.#remoteStream);
            }
        };
        this.#pc.ondatachannel = (event)=>{
            const dc = event.channel;
            this.#debug("Remote data channel received:", dc.label);
            this.#setupDataChannelListeners(dc);
            this.#dataChannels.set(dc.label, dc);
        };
        this.#pc.onicecandidate = (event)=>{
            this.#debug("ICE candidate generated:", event.candidate ? "candidate" : "null (gathering complete)");
            this.#pubsub.publish(WebRtcManager.EVENT_ICE_CANDIDATE, event.candidate);
        };
    }
    #cleanup() {
        this.#debug("Cleanup started");
        if (this.#reconnectTimer !== null) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        if (this.#fullReconnectTimeoutTimer !== null) {
            clearTimeout(this.#fullReconnectTimeoutTimer);
            this.#fullReconnectTimeoutTimer = null;
        }
        if (this.#deviceChangeHandler) {
            navigator.mediaDevices.removeEventListener("devicechange", this.#deviceChangeHandler);
            this.#deviceChangeHandler = null;
        }
        const dcCount = this.#dataChannels.size;
        this.#dataChannels.forEach((dc)=>{
            if (dc.readyState !== "closed") {
                dc.close();
            }
        });
        this.#dataChannels.clear();
        if (dcCount > 0) {
            this.#debug("Closed", dcCount, "data channel(s)");
        }
        if (this.#localStream) {
            this.#localStream.getTracks().forEach((track)=>track.stop());
            this.#localStream = null;
            this.#debug("Local stream stopped");
        }
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
        if (this.state !== WebRtcState.DISCONNECTED && this.state !== WebRtcState.ERROR && this.state !== WebRtcState.IDLE) {
            this.#dispatch(WebRtcFsmEvent.DISCONNECT);
        }
        if (!this.#config.autoReconnect) {
            this.#debug("Auto-reconnect disabled, not attempting reconnection");
            return;
        }
        const maxAttempts = this.#config.maxReconnectAttempts ?? 5;
        if (this.#reconnectAttempts >= maxAttempts) {
            this.#debug("Max reconnection attempts reached:", maxAttempts);
            this.#pubsub.publish(WebRtcManager.EVENT_RECONNECT_FAILED, {
                attempts: this.#reconnectAttempts
            });
            return;
        }
        const nextAttempt = this.#reconnectAttempts + 1;
        const strategy = nextAttempt <= 2 ? "ice-restart" : "full";
        if (this.#config.shouldReconnect) {
            const shouldProceed = this.#config.shouldReconnect?.({
                attempt: nextAttempt,
                maxAttempts,
                strategy
            });
            if (!shouldProceed) {
                this.#debug("Reconnection suppressed by shouldReconnect callback");
                return;
            }
        }
        this.#dispatch(WebRtcFsmEvent.RECONNECTING);
        this.#attemptReconnect();
    }
    #attemptReconnect() {
        this.#reconnectAttempts++;
        const baseDelay = this.#config.reconnectDelay ?? 1000;
        const delay = baseDelay * Math.pow(2, this.#reconnectAttempts - 1);
        const strategy = this.#reconnectAttempts <= 2 ? "ice-restart" : "full";
        this.#debug("Attempting reconnection:", {
            attempt: this.#reconnectAttempts,
            strategy,
            delay: delay + "ms"
        });
        this.#pubsub.publish(WebRtcManager.EVENT_RECONNECTING, {
            attempt: this.#reconnectAttempts,
            strategy
        });
        this.#reconnectTimer = setTimeout(async ()=>{
            this.#reconnectTimer = null;
            if (strategy === "ice-restart" && this.#pc) {
                const success = await this.iceRestart();
                if (!success) {
                    this.#handleConnectionFailure();
                }
            } else {
                try {
                    this.#cleanup();
                    this.#dispatch(WebRtcFsmEvent.RESET);
                    await this.connect();
                    const timeout = this.#config.fullReconnectTimeout ?? 30000;
                    this.#fullReconnectTimeoutTimer = setTimeout(()=>{
                        this.#fullReconnectTimeoutTimer = null;
                        if (this.state !== WebRtcState.CONNECTED) {
                            this.#debug("Full reconnection timeout reached, connection not established");
                            this.#handleConnectionFailure();
                        }
                    }, timeout);
                } catch (e) {
                    this.#logger.error("[WebRtcManager] Reconnection failed:", e);
                    this.#handleConnectionFailure();
                }
            }
        }, delay);
    }
    #setupDeviceChangeListener() {
        if (typeof navigator === "undefined" || !navigator.mediaDevices) {
            return;
        }
        if (this.#deviceChangeHandler) {
            return;
        }
        this.#deviceChangeHandler = async ()=>{
            try {
                const devices = await this.getAudioInputDevices();
                this.#pubsub.publish(WebRtcManager.EVENT_DEVICE_CHANGED, devices);
            } catch (e) {
                this.#logger.error("[WebRtcManager] Error handling device change:", e);
            }
        };
        navigator.mediaDevices.addEventListener("devicechange", this.#deviceChangeHandler);
    }
    #setupDataChannelListeners(dc) {
        dc.onopen = ()=>{
            this.#pubsub.publish(WebRtcManager.EVENT_DATA_CHANNEL_OPEN, dc);
        };
        dc.onmessage = (event)=>{
            this.#pubsub.publish(WebRtcManager.EVENT_DATA_CHANNEL_MESSAGE, {
                channel: dc,
                data: event.data
            });
        };
        dc.onclose = ()=>{
            this.#pubsub.publish(WebRtcManager.EVENT_DATA_CHANNEL_CLOSE, dc);
            this.#dataChannels.delete(dc.label);
        };
        dc.onerror = (error)=>{
            const isUserAbort = error?.error?.message?.includes("User-Initiated Abort");
            if (!isUserAbort) {
                this.#logger.error("[WebRtcManager] Data channel error:", error);
                this.#pubsub.publish(WebRtcManager.EVENT_ERROR, error);
            }
        };
    }
}
export { WebRtcManager as WebRtcManager };
