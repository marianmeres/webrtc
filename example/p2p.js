// https://jsr.io/@marianmeres/pubsub/2.2.0/src/pubsub.ts
var PubSub = class {
  #subs = /* @__PURE__ */ new Map();
  /** Publish an event with optional data to all subscribers of a topic */
  publish(topic, data) {
    this.#subs.get(topic)?.forEach((cb) => cb(data));
    if (topic !== "*") {
      this.#subs.get("*")?.forEach((cb) => cb(data));
    }
    return this.#subs.has(topic);
  }
  /** Subscribe to a topic */
  subscribe(topic, cb) {
    if (!this.#subs.has(topic)) {
      this.#subs.set(topic, /* @__PURE__ */ new Set());
    }
    this.#subs.get(topic).add(cb);
    return () => this.unsubscribe(topic, cb);
  }
  /** Unsubscribe given subscriber from a topic.
   * If not subscriber is given, unsubscribe all from given topic. */
  unsubscribe(topic, cb) {
    if (!this.#subs.has(topic))
      return false;
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
  /** Subscribe to a topic only for the first published topic */
  subscribeOnce(topic, cb) {
    const onceWrapper = (data) => {
      cb(data);
      this.unsubscribe(topic, onceWrapper);
    };
    return this.subscribe(topic, onceWrapper);
  }
  /** Unsubscribe all callbacks from a specific topic.
   * If no topic is provided, unsubscribe from all topics. */
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
  /** Will check if give topic+cb exists */
  isSubscribed(topic, cb, considerWildcard = true) {
    let has = !!this.#subs.get(topic)?.has(cb);
    if (considerWildcard) {
      has ||= !!this.#subs.get("*")?.has(cb);
    }
    return has;
  }
  /** For debugging */
  __dump() {
    return Object.fromEntries(this.#subs.entries());
  }
};
function createPubSub() {
  return new PubSub();
}

// https://jsr.io/@marianmeres/fsm/2.2.0/src/fsm.ts
var FSM = class {
  /** Creates the FSM instance */
  constructor(config) {
    this.config = config;
    this.#state = this.config.initial;
    this.context = this.#initContext();
  }
  /** FSM's previous state */
  #previous = null;
  /** FSM's current state */
  #state;
  /** A custom object accessible throughout the FSM's lifetime. */
  context;
  /** Internal pub sub */
  #pubsub = createPubSub();
  /** Non-reactive getter from the outside */
  get state() {
    return this.#state;
  }
  /** Helper to initialize context from object or factory function */
  #initContext() {
    if (typeof this.config.context === "function") {
      return this.config.context();
    }
    return { ...this.config.context ?? {} };
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
  /** Reactive subscription to FSM's state */
  subscribe(cb) {
    const unsub = this.#pubsub.subscribe("change", cb);
    cb(this.#getNotifyData());
    return unsub;
  }
  /**
   * "Requests" FSM to transition to target state providing payload and respecting
   * the configuration.
   *
   * Execution order during transition:
   * 1. onExit (OLD state)
   * 2. action (TRANSITION edge)
   * 3. state changes
   * 4. onEnter (NEW state)
   * 5. notify consumers
   */
  transition(event, payload, assert = true) {
    const currentStateConfig = this.config.states[this.#state];
    if (!currentStateConfig || !currentStateConfig.on) {
      throw new Error(`No transitions defined for state "${this.#state}"`);
    }
    const transitionDef = currentStateConfig.on[event];
    if (!transitionDef) {
      if (assert) {
        throw new Error(`Invalid transition "${event}" from state "${this.#state}"`);
      } else {
        return this.#state;
      }
    }
    const activeTransition = this.#resolveTransition(transitionDef, payload);
    if (!activeTransition) {
      if (assert) {
        throw new Error(`No valid transition found for event "${event}" in state "${this.#state}"`);
      } else {
        return this.#state;
      }
    }
    if (!activeTransition.target) {
      if (typeof activeTransition.action === "function") {
        activeTransition.action(this.context, payload);
      }
      this.#notify();
      return this.#state;
    }
    const nextState = activeTransition.target;
    if (typeof currentStateConfig.onExit === "function") {
      currentStateConfig.onExit(this.context, payload);
    }
    if (typeof activeTransition.action === "function") {
      activeTransition.action(this.context, payload);
    }
    this.#previous = this.#state;
    this.#state = nextState;
    const nextStateConfig = this.config.states[nextState];
    if (typeof nextStateConfig.onEnter === "function") {
      nextStateConfig.onEnter(this.context, payload);
    }
    this.#notify();
    return this.#state;
  }
  /** Resolves the transition definition into a normalized object */
  #resolveTransition(transition, payload) {
    if (typeof transition === "string") {
      return { target: transition };
    }
    if (Array.isArray(transition)) {
      for (const t of transition) {
        if (typeof t.guard === "function") {
          if (t.guard(this.context, payload))
            return t;
        } else {
          return t;
        }
      }
      return null;
    }
    if (typeof transition.guard === "function") {
      return transition.guard(this.context, payload) ? transition : null;
    }
    return transition;
  }
  /** Resets the FSM to initial state and re-initializes context */
  reset() {
    this.#state = this.config.initial;
    this.#previous = null;
    this.context = this.#initContext();
    this.#notify();
    return this;
  }
  /** Check whether the FSM is in the given state */
  is(state) {
    return this.#state === state;
  }
  /** Generates Mermaid state diagram notation from FSM config */
  toMermaid() {
    let mermaid = "stateDiagram-v2\n";
    mermaid += `    [*] --> ${this.config.initial}
`;
    for (const [stateName, stateConfig] of Object.entries(
      this.config.states
    )) {
      for (const [event, def] of Object.entries(stateConfig?.on ?? {})) {
        const formatLabel = (evt, guardIdx, hasAction, isInternal) => {
          let label = evt;
          if (guardIdx !== null)
            label += ` [guard ${guardIdx}]`;
          else if (guardIdx === -1)
            label += ` [guarded]`;
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
          mermaid += `    ${stateName} --> ${def}: ${event}
`;
        } else if (Array.isArray(def)) {
          def.forEach((t, idx) => {
            const target = t.target ?? stateName;
            const label = formatLabel(event, idx + 1, !!t.action, !t.target);
            mermaid += `    ${stateName} --> ${target}: ${label}
`;
          });
        } else {
          const target = def.target ?? stateName;
          const label = formatLabel(
            event,
            def.guard ? -1 : null,
            !!def.action,
            !def.target
          );
          mermaid += `    ${stateName} --> ${target}: ${label}
`;
        }
      }
    }
    return mermaid;
  }
};

// src/webrtc-manager.ts
var WebRtcManager = class {
  #fsm;
  #pubsub;
  #pc = null;
  #factory;
  #config;
  #localStream = null;
  #remoteStream = null;
  #dataChannels = /* @__PURE__ */ new Map();
  #reconnectAttempts = 0;
  #reconnectTimer = null;
  #deviceChangeHandler = null;
  constructor(factory2, config = {}) {
    this.#factory = factory2;
    this.#config = config;
    this.#pubsub = new PubSub();
    this.#fsm = new FSM({
      initial: "IDLE" /* IDLE */,
      states: {
        ["IDLE" /* IDLE */]: {
          on: { ["initialize" /* INIT */]: "INITIALIZING" /* INITIALIZING */ }
        },
        ["INITIALIZING" /* INITIALIZING */]: {
          on: {
            ["connect" /* CONNECT */]: "CONNECTING" /* CONNECTING */,
            ["error" /* ERROR */]: "ERROR" /* ERROR */
          }
        },
        ["CONNECTING" /* CONNECTING */]: {
          on: {
            ["connected" /* CONNECTED */]: "CONNECTED" /* CONNECTED */,
            ["disconnect" /* DISCONNECT */]: "DISCONNECTED" /* DISCONNECTED */,
            ["error" /* ERROR */]: "ERROR" /* ERROR */
          }
        },
        ["CONNECTED" /* CONNECTED */]: {
          on: {
            ["disconnect" /* DISCONNECT */]: "DISCONNECTED" /* DISCONNECTED */,
            ["error" /* ERROR */]: "ERROR" /* ERROR */
          }
        },
        ["RECONNECTING" /* RECONNECTING */]: {
          on: {
            ["connect" /* CONNECT */]: "CONNECTING" /* CONNECTING */,
            ["disconnect" /* DISCONNECT */]: "DISCONNECTED" /* DISCONNECTED */,
            ["reset" /* RESET */]: "IDLE" /* IDLE */
          }
        },
        ["DISCONNECTED" /* DISCONNECTED */]: {
          on: {
            ["connect" /* CONNECT */]: "CONNECTING" /* CONNECTING */,
            ["reconnecting" /* RECONNECTING */]: "RECONNECTING" /* RECONNECTING */,
            ["reset" /* RESET */]: "IDLE" /* IDLE */
          }
        },
        ["ERROR" /* ERROR */]: {
          on: { ["reset" /* RESET */]: "IDLE" /* IDLE */ }
        }
      }
    });
  }
  // --- Public API ---
  /** Returns the current state of the WebRTC connection. */
  get state() {
    return this.#fsm.state;
  }
  /** Returns a readonly map of all active data channels indexed by label. */
  get dataChannels() {
    return this.#dataChannels;
  }
  /** Returns the local media stream, or null if not initialized. */
  get localStream() {
    return this.#localStream;
  }
  /** Returns the remote media stream, or null if not connected. */
  get remoteStream() {
    return this.#remoteStream;
  }
  /** Returns the underlying RTCPeerConnection, or null if not initialized. */
  get peerConnection() {
    return this.#pc;
  }
  /** Returns a Mermaid diagram representation of the FSM state machine. */
  toMermaid() {
    return this.#fsm.toMermaid();
  }
  /**
   * Subscribe to a specific WebRTC event.
   * @returns Unsubscribe function to remove the event listener.
   */
  on(event, handler) {
    return this.#pubsub.subscribe(event, handler);
  }
  /**
   * Subscribe to all WebRTC events using a wildcard listener.
   * @returns Unsubscribe function to remove the event listener.
   */
  subscribe(handler) {
    return this.#pubsub.subscribe("*", handler);
  }
  /**
   * Retrieves all available audio input devices.
   * @returns Array of audio input devices, or empty array on error.
   */
  async getAudioInputDevices() {
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
  async switchMicrophone(deviceId) {
    if (!this.#pc || !this.#localStream) {
      console.error(
        "Cannot switch microphone: not initialized or no active stream"
      );
      return false;
    }
    try {
      const newStream = await this.#factory.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) {
        throw new Error("No audio track in new stream");
      }
      let sender = this.#pc.getSenders().find((s) => s.track?.kind === "audio");
      if (!sender) {
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
      await sender.replaceTrack(newTrack);
      this.#localStream.getAudioTracks().forEach((track) => track.stop());
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
  async initialize() {
    if (this.state !== "IDLE" /* IDLE */)
      return;
    this.#dispatch("initialize" /* INIT */);
    try {
      this.#pc = this.#factory.createPeerConnection(this.#config.peerConfig);
      this.#setupPcListeners();
      this.#setupDeviceChangeListener();
      if (this.#config.enableMicrophone) {
        const success = await this.enableMicrophone(true);
        if (!success) {
          this.#pubsub.publish("microphone_failed", {
            reason: "Failed to enable microphone during initialization"
          });
        }
      } else {
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
  async connect() {
    if (this.state === "IDLE" /* IDLE */) {
      await this.initialize();
    }
    if (this.state === "DISCONNECTED" /* DISCONNECTED */) {
      this.#cleanup();
      this.#fsm.transition("reset" /* RESET */);
      await this.initialize();
      return;
    }
    if (this.state === "CONNECTED" /* CONNECTED */ || this.state === "CONNECTING" /* CONNECTING */)
      return;
    this.#dispatch("connect" /* CONNECT */);
  }
  /**
   * Enables or disables the microphone and adds/removes audio tracks to the peer connection.
   * @param enable - True to enable microphone, false to disable.
   * @returns True if successful, false if failed to get user media.
   */
  async enableMicrophone(enable) {
    if (enable) {
      if (this.#localStream)
        return true;
      try {
        const stream = await this.#factory.getUserMedia({
          audio: true,
          video: false
        });
        this.#localStream = stream;
        this.#pubsub.publish("local_stream", stream);
        if (this.#pc) {
          const transceivers = this.#pc.getTransceivers();
          const audioTransceiver = transceivers.find(
            (t) => t.receiver.track.kind === "audio"
          );
          if (audioTransceiver && audioTransceiver.sender) {
            const track = stream.getAudioTracks()[0];
            await audioTransceiver.sender.replaceTrack(track);
            audioTransceiver.direction = "sendrecv";
          } else {
            stream.getTracks().forEach((track) => {
              this.#pc.addTrack(track, stream);
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
      if (!this.#localStream)
        return true;
      this.#localStream.getTracks().forEach((track) => {
        track.stop();
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
  disconnect() {
    this.#cleanup();
    this.#dispatch("disconnect" /* DISCONNECT */);
  }
  /**
   * Resets the manager to IDLE state from any state.
   * Cleans up all resources and allows reinitialization.
   */
  reset() {
    this.#cleanup();
    if (this.state !== "IDLE" /* IDLE */) {
      if (this.state === "ERROR" /* ERROR */ || this.state === "DISCONNECTED" /* DISCONNECTED */ || this.state === "RECONNECTING" /* RECONNECTING */) {
        this.#dispatch("reset" /* RESET */);
      } else {
        this.#dispatch("disconnect" /* DISCONNECT */);
        this.#dispatch("reset" /* RESET */);
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
  createDataChannel(label, options) {
    if (!this.#pc)
      return null;
    if (this.#dataChannels.has(label))
      return this.#dataChannels.get(label);
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
  getDataChannel(label) {
    return this.#dataChannels.get(label);
  }
  /**
   * Sends data through a data channel identified by label.
   * Checks that the channel exists and is in open state before sending.
   * @param label - The label of the data channel to send through.
   * @param data - The data to send (string, Blob, or ArrayBuffer).
   * @returns True if data was sent successfully, false otherwise.
   */
  sendData(label, data) {
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
      channel.send(data);
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
  async createOffer(options) {
    if (!this.#pc)
      return null;
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
  async createAnswer(options) {
    if (!this.#pc)
      return null;
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
  async setLocalDescription(description) {
    if (!this.#pc)
      return false;
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
  async setRemoteDescription(description) {
    if (!this.#pc)
      return false;
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
  async addIceCandidate(candidate) {
    if (!this.#pc)
      return false;
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
  async iceRestart() {
    if (!this.#pc)
      return false;
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
  getLocalDescription() {
    return this.#pc?.localDescription ?? null;
  }
  /**
   * Returns the current remote session description.
   * @returns The remote description, or null if not set.
   */
  getRemoteDescription() {
    return this.#pc?.remoteDescription ?? null;
  }
  /**
   * Retrieves WebRTC statistics for the peer connection.
   * @returns Stats report, or null if peer connection not initialized.
   */
  async getStats() {
    if (!this.#pc)
      return null;
    try {
      return await this.#pc.getStats();
    } catch (e) {
      this.#error(e);
      return null;
    }
  }
  // --- Private ---
  #dispatch(event) {
    const oldState = this.#fsm.state;
    this.#fsm.transition(event);
    const newState = this.#fsm.state;
    if (oldState !== newState) {
      this.#pubsub.publish("state_change", newState);
    }
  }
  #debug(...args) {
    if (this.#config.debug) {
      console.debug("[WebRtcManager]", ...args);
    }
  }
  #error(error) {
    console.error(error);
    this.#dispatch("error" /* ERROR */);
    this.#pubsub.publish("error", error);
  }
  #setupPcListeners() {
    if (!this.#pc)
      return;
    this.#pc.onconnectionstatechange = () => {
      const state = this.#pc.connectionState;
      if (state === "connected") {
        this.#reconnectAttempts = 0;
        this.#dispatch("connected" /* CONNECTED */);
      } else if (state === "failed") {
        this.#handleConnectionFailure();
      } else if (state === "disconnected" || state === "closed") {
        this.#dispatch("disconnect" /* DISCONNECT */);
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
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#deviceChangeHandler) {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        this.#deviceChangeHandler
      );
      this.#deviceChangeHandler = null;
    }
    this.#dataChannels.forEach((dc) => {
      if (dc.readyState !== "closed") {
        dc.close();
      }
    });
    this.#dataChannels.clear();
    if (this.#localStream) {
      this.#localStream.getTracks().forEach((track) => track.stop());
      this.#localStream = null;
    }
    if (this.#pc) {
      this.#pc.close();
      this.#pc = null;
    }
    this.#remoteStream = null;
  }
  #handleConnectionFailure() {
    this.#dispatch("disconnect" /* DISCONNECT */);
    if (!this.#config.autoReconnect) {
      return;
    }
    const maxAttempts = this.#config.maxReconnectAttempts ?? 5;
    if (this.#reconnectAttempts >= maxAttempts) {
      this.#pubsub.publish("reconnect_failed", {
        attempts: this.#reconnectAttempts
      });
      return;
    }
    this.#dispatch("reconnecting" /* RECONNECTING */);
    this.#attemptReconnect();
  }
  #attemptReconnect() {
    this.#reconnectAttempts++;
    const baseDelay = this.#config.reconnectDelay ?? 1e3;
    const delay = baseDelay * Math.pow(2, this.#reconnectAttempts - 1);
    const strategy = this.#reconnectAttempts <= 2 ? "ice-restart" : "full";
    this.#pubsub.publish("reconnecting", {
      attempt: this.#reconnectAttempts,
      strategy
    });
    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = null;
      if (strategy === "ice-restart" && this.#pc) {
        const success = await this.iceRestart();
        if (!success) {
          this.#handleConnectionFailure();
        }
      } else {
        try {
          await this.connect();
        } catch (e) {
          console.error("Reconnection failed:", e);
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
  #setupDataChannelListeners(dc) {
    dc.onopen = () => {
      this.#pubsub.publish("data_channel_open", dc);
    };
    dc.onmessage = (event) => {
      this.#pubsub.publish("data_channel_message", {
        channel: dc,
        data: event.data
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
};

// example/p2p.ts
var BrowserWebRtcFactory = class {
  createPeerConnection(config) {
    return new RTCPeerConnection(config);
  }
  getUserMedia(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  enumerateDevices() {
    return navigator.mediaDevices.enumerateDevices();
  }
};
var SIGNALING_KEY_OFFER = "webrtc_offer";
var SIGNALING_KEY_ANSWER = "webrtc_answer";
var SIGNALING_KEY_ICE_1 = "webrtc_ice_1";
var SIGNALING_KEY_ICE_2 = "webrtc_ice_2";
var factory = new BrowserWebRtcFactory();
var peer1 = new WebRtcManager(factory, {
  peerConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
  dataChannelLabel: "chat"
});
var peer2 = new WebRtcManager(factory, {
  peerConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }
});
var status1 = document.getElementById("status1");
var logs1 = document.getElementById("logs1");
var chat1 = document.getElementById("chat1");
var input1 = document.getElementById("input1");
var btnInit1 = document.getElementById("btn1-init");
var btnOffer1 = document.getElementById("btn1-offer");
var btnDisconnect1 = document.getElementById(
  "btn1-disconnect"
);
var btnSend1 = document.getElementById("btn1-send");
var status2 = document.getElementById("status2");
var logs2 = document.getElementById("logs2");
var chat2 = document.getElementById("chat2");
var input2 = document.getElementById("input2");
var btnInit2 = document.getElementById("btn2-init");
var btnAnswer2 = document.getElementById("btn2-answer");
var btnDisconnect2 = document.getElementById(
  "btn2-disconnect"
);
var btnSend2 = document.getElementById("btn2-send");
function log(peer, msg) {
  const logsEl = peer === 1 ? logs1 : logs2;
  const time = (/* @__PURE__ */ new Date()).toISOString().split("T")[1].split(".")[0];
  const div = document.createElement("div");
  div.textContent = `[${time}] ${msg}`;
  logsEl.prepend(div);
  console.log(`Peer ${peer}:`, msg);
}
function addChatMessage(peer, msg, sent) {
  const chatEl = peer === 1 ? chat1 : chat2;
  const div = document.createElement("div");
  div.className = `msg ${sent ? "msg-sent" : "msg-received"}`;
  div.textContent = `${sent ? "You" : "Peer"}: ${msg}`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function updateButtons(peer, state) {
  const statusEl = peer === 1 ? status1 : status2;
  const btnInit = peer === 1 ? btnInit1 : btnInit2;
  const btnAction = peer === 1 ? btnOffer1 : btnAnswer2;
  const btnDisconnect = peer === 1 ? btnDisconnect1 : btnDisconnect2;
  const inputEl = peer === 1 ? input1 : input2;
  const btnSend = peer === 1 ? btnSend1 : btnSend2;
  statusEl.textContent = `State: ${state}`;
  btnInit.disabled = state !== "IDLE" /* IDLE */;
  btnAction.disabled = state !== "INITIALIZING" /* INITIALIZING */;
  btnDisconnect.disabled = state !== "CONNECTED" /* CONNECTED */ && state !== "CONNECTING" /* CONNECTING */;
  const isConnected = state === "CONNECTED" /* CONNECTED */;
  inputEl.disabled = !isConnected;
  btnSend.disabled = !isConnected;
}
var dataChannel1 = null;
var dataChannel2 = null;
peer1.on("state_change", (state) => {
  log(1, `State: ${state}`);
  updateButtons(1, state);
});
peer1.on("data_channel_open", (dc) => {
  log(1, `Data channel "${dc.label}" opened`);
  dataChannel1 = dc;
});
peer1.on("data_channel_message", ({ data }) => {
  log(1, `Received: ${data}`);
  addChatMessage(1, data, false);
});
peer1.on("ice_candidate", (candidate) => {
  if (candidate) {
    log(1, "Got ICE candidate");
    const existing = JSON.parse(
      localStorage.getItem(SIGNALING_KEY_ICE_1) || "[]"
    );
    existing.push(candidate.toJSON());
    localStorage.setItem(SIGNALING_KEY_ICE_1, JSON.stringify(existing));
  }
});
peer2.on("state_change", (state) => {
  log(2, `State: ${state}`);
  updateButtons(2, state);
});
peer2.on("data_channel_open", (dc) => {
  log(2, `Data channel "${dc.label}" opened`);
  dataChannel2 = dc;
});
peer2.on("data_channel_message", ({ data }) => {
  log(2, `Received: ${data}`);
  addChatMessage(2, data, false);
});
peer2.on("ice_candidate", (candidate) => {
  if (candidate) {
    log(2, "Got ICE candidate");
    const existing = JSON.parse(
      localStorage.getItem(SIGNALING_KEY_ICE_2) || "[]"
    );
    existing.push(candidate.toJSON());
    localStorage.setItem(SIGNALING_KEY_ICE_2, JSON.stringify(existing));
  }
});
btnInit1.onclick = async () => {
  log(1, "Initializing...");
  await peer1.initialize();
};
btnOffer1.onclick = async () => {
  log(1, "Creating offer...");
  await peer1.connect();
  const offer = await peer1.createOffer();
  if (offer) {
    await peer1.setLocalDescription(offer);
    localStorage.setItem(SIGNALING_KEY_OFFER, JSON.stringify(offer));
    log(1, "Offer created and sent");
  }
};
btnDisconnect1.onclick = () => {
  log(1, "Disconnecting...");
  peer1.disconnect();
  dataChannel1 = null;
};
btnSend1.onclick = () => {
  const msg = input1.value.trim();
  if (msg && dataChannel1) {
    dataChannel1.send(msg);
    addChatMessage(1, msg, true);
    input1.value = "";
  }
};
input1.onkeypress = (e) => {
  if (e.key === "Enter")
    btnSend1.click();
};
btnInit2.onclick = async () => {
  log(2, "Initializing...");
  await peer2.initialize();
};
btnAnswer2.onclick = async () => {
  const offerStr = localStorage.getItem(SIGNALING_KEY_OFFER);
  if (!offerStr) {
    log(2, "No offer found!");
    return;
  }
  log(2, "Setting remote description (offer)...");
  const offer = JSON.parse(offerStr);
  await peer2.connect();
  await peer2.setRemoteDescription(offer);
  const ice1 = JSON.parse(localStorage.getItem(SIGNALING_KEY_ICE_1) || "[]");
  for (const candidate of ice1) {
    await peer2.addIceCandidate(candidate);
  }
  log(2, "Creating answer...");
  const answer = await peer2.createAnswer();
  if (answer) {
    await peer2.setLocalDescription(answer);
    localStorage.setItem(SIGNALING_KEY_ANSWER, JSON.stringify(answer));
    log(2, "Answer created and sent");
    setTimeout(async () => {
      const answerStr = localStorage.getItem(SIGNALING_KEY_ANSWER);
      if (answerStr) {
        log(1, "Setting remote description (answer)...");
        await peer1.setRemoteDescription(JSON.parse(answerStr));
        const ice2 = JSON.parse(
          localStorage.getItem(SIGNALING_KEY_ICE_2) || "[]"
        );
        for (const candidate of ice2) {
          await peer1.addIceCandidate(candidate);
        }
      }
    }, 500);
  }
};
btnDisconnect2.onclick = () => {
  log(2, "Disconnecting...");
  peer2.disconnect();
  dataChannel2 = null;
};
btnSend2.onclick = () => {
  const msg = input2.value.trim();
  if (msg && dataChannel2) {
    dataChannel2.send(msg);
    addChatMessage(2, msg, true);
    input2.value = "";
  }
};
input2.onkeypress = (e) => {
  if (e.key === "Enter")
    btnSend2.click();
};
localStorage.removeItem(SIGNALING_KEY_OFFER);
localStorage.removeItem(SIGNALING_KEY_ANSWER);
localStorage.removeItem(SIGNALING_KEY_ICE_1);
localStorage.removeItem(SIGNALING_KEY_ICE_2);
log(1, "Ready");
log(2, "Ready");
updateButtons(1, peer1.state);
updateButtons(2, peer2.state);
