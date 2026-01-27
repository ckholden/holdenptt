// ========================================
// PTT AUDIO MODULE (Firebase PCM Streaming)
// ========================================
// Streams raw PCM audio samples through Firebase.
// No WebRTC, no codec issues. Just raw audio data.

const PTTAudio = {
    localStream: null,
    isTransmitting: false,
    currentSpeaker: null,
    speakerRef: null,
    audioStreamRef: null,
    audioContext: null,
    audioUnlocked: false,
    rogerContext: null,
    lastSpeakerName: null,
    captureNode: null,
    captureSource: null,
    chunkBuffer: [],
    sendInterval: null,
    playQueue: [],
    isPlaying: false,
    pttLocked: false,

    // Audio settings
    SAMPLE_RATE: 8000,
    CHUNK_INTERVAL: 200, // ms between sends

    // Initialize audio system
    init() {
        console.log('[Audio] Initializing...');

        const pttBtn = document.getElementById('ptt-btn');

        // Mouse support
        pttBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.startTransmit();
        });
        pttBtn.addEventListener('mouseup', (e) => {
            e.preventDefault();
            this.stopTransmit();
        });
        pttBtn.addEventListener('mouseleave', () => {
            if (this.isTransmitting) this.stopTransmit();
        });

        // Touch support for mobile
        pttBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.startTransmit();
        });
        pttBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.stopTransmit();
        });
        pttBtn.addEventListener('touchcancel', (e) => {
            e.preventDefault();
            if (this.isTransmitting) this.stopTransmit();
        });

        // Keyboard support (spacebar)
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat && !this.isInputFocused()) {
                e.preventDefault();
                this.startTransmit();
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space' && !this.isInputFocused()) {
                e.preventDefault();
                this.stopTransmit();
            }
        });
    },

    isInputFocused() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    },

    // Unlock audio (call from user gesture)
    unlockAudio() {
        if (this.audioUnlocked) return;
        this.audioUnlocked = true;
        console.log('[Audio] Unlocking audio playback');

        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.SAMPLE_RATE
            });
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        // Play silence to unlock
        const buf = this.audioContext.createBuffer(1, 1, this.SAMPLE_RATE);
        const src = this.audioContext.createBufferSource();
        src.buffer = buf;
        src.connect(this.audioContext.destination);
        src.start(0);
    },

    // Request mic
    async requestMicrophone() {
        try {
            console.log('[Audio] Requesting microphone...');
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            console.log('[Audio] Microphone granted');
            return true;
        } catch (error) {
            console.error('[Audio] Mic denied:', error);
            if (typeof Chat !== 'undefined') {
                Chat.addSystemMessage('Microphone access denied. PTT will not work.');
            }
            return false;
        }
    },

    // Join channel audio
    async joinChannel(channel) {
        console.log('[Audio] Joining channel:', channel);

        if (!this.localStream) {
            await this.requestMicrophone();
        }

        this.speakerRef = database.ref(`channels/${channel}/activeSpeaker`);
        this.audioStreamRef = database.ref(`channels/${channel}/audioStream`);

        // Listen for speaker changes
        this.speakerRef.on('value', (snap) => {
            this.handleSpeakerChange(snap.val());
        });

        // Listen for audio chunks from others
        this.audioStreamRef.on('child_added', (snap) => {
            const data = snap.val();
            if (data && data.sid !== Auth.getUserId()) {
                this.receiveAudioChunk(data.pcm);
            }
            // Clean up
            snap.ref.remove();
        });

        if (typeof Chat !== 'undefined') {
            Chat.addSystemMessage('Audio system ready. Tap PTT once to enable sound.');
        }
    },

    // Leave channel
    async leaveChannel(channel) {
        if (this.isTransmitting) await this.stopTransmit();
        if (this.speakerRef) { this.speakerRef.off(); this.speakerRef = null; }
        if (this.audioStreamRef) { this.audioStreamRef.off(); this.audioStreamRef = null; }
    },

    // Switch channel
    async switchChannel(oldCh, newCh) {
        await this.leaveChannel(oldCh);
        await this.joinChannel(newCh);
    },

    // ==================
    // TRANSMIT
    // ==================
    async startTransmit() {
        if (this.isTransmitting || this.pttLocked) return;

        if (!this.localStream) {
            this.pttLocked = true;
            const ok = await this.requestMicrophone();
            this.pttLocked = false;
            if (!ok) return;
        }

        const user = Auth.getUser();
        if (!user) return;

        // Unlock audio on user gesture
        this.unlockAudio();

        // Check if channel is busy
        if (this.currentSpeaker && this.currentSpeaker.userId !== Auth.getUserId()) {
            console.log('[Audio] Channel busy');
            return;
        }

        // Claim speaker slot
        const channel = Channels.getCurrentChannel();
        const ref = database.ref(`channels/${channel}/activeSpeaker`);

        try {
            const result = await ref.transaction((current) => {
                if (!current || current.userId === Auth.getUserId()) {
                    return {
                        userId: Auth.getUserId(),
                        displayName: user.displayName,
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    };
                }
                return undefined; // abort
            });

            if (!result.committed) {
                console.log('[Audio] Could not claim speaker');
                return;
            }
        } catch (err) {
            console.error('[Audio] Transaction error:', err);
            return;
        }

        this.isTransmitting = true;
        ref.onDisconnect().remove();

        // Start capturing PCM audio
        this.startCapture(channel);

        // Update UI
        document.getElementById('ptt-btn').classList.add('active');

        if (typeof Recording !== 'undefined') Recording.onTransmitStart();
    },

    startCapture(channel) {
        const streamRef = database.ref(`channels/${channel}/audioStream`);
        const senderId = Auth.getUserId();

        // Create audio context for capture at low sample rate
        const captureCtx = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: this.SAMPLE_RATE
        });

        const source = captureCtx.createMediaStreamSource(this.localStream);

        // ScriptProcessor to capture raw PCM (4096 samples per buffer)
        const processor = captureCtx.createScriptProcessorNode(4096, 1, 1);

        this.chunkBuffer = [];

        processor.onaudioprocess = (e) => {
            if (!this.isTransmitting) return;

            const input = e.inputBuffer.getChannelData(0);

            // Convert Float32 to Int16 for compression
            const int16 = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Convert to base64
            const bytes = new Uint8Array(int16.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            this.chunkBuffer.push(btoa(binary));
        };

        source.connect(processor);
        processor.connect(captureCtx.destination);

        this.captureSource = source;
        this.captureNode = processor;
        this._captureCtx = captureCtx;

        // Send buffered chunks at regular intervals
        this.sendInterval = setInterval(() => {
            if (this.chunkBuffer.length > 0 && this.isTransmitting) {
                const chunks = this.chunkBuffer.splice(0);
                const combined = chunks.join('|');

                streamRef.push({
                    pcm: combined,
                    sid: senderId,
                    t: firebase.database.ServerValue.TIMESTAMP
                });
            }
        }, this.CHUNK_INTERVAL);
    },

    stopCapture() {
        if (this.sendInterval) {
            clearInterval(this.sendInterval);
            this.sendInterval = null;
        }
        if (this.captureNode) {
            this.captureNode.disconnect();
            this.captureNode = null;
        }
        if (this.captureSource) {
            this.captureSource.disconnect();
            this.captureSource = null;
        }
        if (this._captureCtx) {
            this._captureCtx.close().catch(() => {});
            this._captureCtx = null;
        }
        this.chunkBuffer = [];
    },

    async stopTransmit() {
        if (!this.isTransmitting) return;

        console.log('[Audio] Stopping transmission');
        this.isTransmitting = false;

        this.stopCapture();

        // Release speaker
        const channel = Channels.getCurrentChannel();
        const ref = database.ref(`channels/${channel}/activeSpeaker`);

        try {
            await ref.transaction((current) => {
                if (current && current.userId === Auth.getUserId()) return null;
                return current;
            });
            ref.onDisconnect().cancel();
        } catch (err) {
            console.error('[Audio] Error releasing speaker:', err);
        }

        document.getElementById('ptt-btn').classList.remove('active');

        if (typeof Recording !== 'undefined') Recording.onTransmitStop();
    },

    // ==================
    // RECEIVE & PLAYBACK
    // ==================
    receiveAudioChunk(pcmData) {
        if (!pcmData) return;

        // Ensure audio context
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.SAMPLE_RATE
            });
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        // Split combined chunks
        const chunks = pcmData.split('|');

        for (const chunk of chunks) {
            try {
                // Decode base64 to Int16 samples
                const binary = atob(chunk);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                const int16 = new Int16Array(bytes.buffer);

                // Convert Int16 to Float32
                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) {
                    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
                }

                // Queue for playback
                this.playQueue.push(float32);
            } catch (err) {
                console.error('[Audio] Decode error:', err);
            }
        }

        // Start playback if not already playing
        if (!this.isPlaying) {
            this.playNextChunk();
        }
    },

    playNextChunk() {
        if (this.playQueue.length === 0) {
            this.isPlaying = false;
            return;
        }

        this.isPlaying = true;
        const samples = this.playQueue.shift();

        const ctx = this.audioContext;
        const buffer = ctx.createBuffer(1, samples.length, this.SAMPLE_RATE);
        buffer.getChannelData(0).set(samples);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => this.playNextChunk();
        source.start(0);
    },

    // ==================
    // ROGER BEEP
    // ==================
    playRogerBeep() {
        if (!this.rogerContext) {
            this.rogerContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        const ctx = this.rogerContext;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const g1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1200, now);
        osc1.frequency.exponentialRampToValueAtTime(800, now + 0.08);
        osc1.connect(g1);
        g1.connect(ctx.destination);
        g1.gain.setValueAtTime(0.25, now);
        g1.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc1.start(now);
        osc1.stop(now + 0.12);

        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1400, now + 0.05);
        osc2.frequency.exponentialRampToValueAtTime(1000, now + 0.15);
        osc2.connect(g2);
        g2.connect(ctx.destination);
        g2.gain.setValueAtTime(0.2, now + 0.05);
        g2.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc2.start(now + 0.05);
        osc2.stop(now + 0.18);
    },

    // ==================
    // SPEAKER STATUS
    // ==================
    handleSpeakerChange(speaker) {
        const prev = this.currentSpeaker;
        this.currentSpeaker = speaker;
        const ind = document.getElementById('tx-indicator');
        const txt = ind.querySelector('.tx-text');
        const info = document.getElementById('speaker-info');

        if (speaker) {
            this.lastSpeakerName = speaker.displayName;
            if (speaker.userId === Auth.getUserId()) {
                ind.className = 'tx-indicator transmitting';
                txt.textContent = 'TRANSMITTING';
                info.textContent = '';
            } else {
                ind.className = 'tx-indicator receiving';
                txt.textContent = 'RECEIVING';
                info.textContent = `${speaker.displayName} is talking`;
                Channels.markSpeaking(speaker.userId, true);
            }
            if (typeof Chat !== 'undefined' && speaker.userId !== Auth.getUserId()) {
                Chat.addSystemMessage(`🎙 ${speaker.displayName} is transmitting`);
            }
        } else {
            if (prev && prev.userId !== Auth.getUserId()) {
                this.playRogerBeep();
            }
            ind.className = 'tx-indicator';
            txt.textContent = 'STANDBY';
            info.textContent = '';
            document.querySelectorAll('#member-list li.speaking').forEach(li => {
                li.classList.remove('speaking');
            });
        }
    },

    // ==================
    // CLEANUP
    // ==================
    async cleanup() {
        console.log('[Audio] Cleaning up...');
        if (this.isTransmitting) await this.stopTransmit();
        this.stopCapture();

        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }
        if (this.speakerRef) { this.speakerRef.off(); this.speakerRef = null; }
        if (this.audioStreamRef) { this.audioStreamRef.off(); this.audioStreamRef = null; }
        if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }

        this.playQueue = [];
        this.isPlaying = false;
    }
};
