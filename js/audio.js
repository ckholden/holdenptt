// ========================================
// PTT AUDIO MODULE (Firebase Audio Streaming)
// ========================================
// Uses Firebase Realtime Database to stream audio chunks
// instead of WebRTC. More reliable across all networks.

const PTTAudio = {
    localStream: null,
    mediaRecorder: null,
    isTransmitting: false,
    currentSpeaker: null,
    speakerRef: null,
    audioStreamRef: null,
    audioContext: null,
    audioUnlocked: false,
    rogerContext: null,
    lastSpeakerName: null,

    // Initialize audio system
    init() {
        console.log('[Audio] Initializing...');

        // Setup PTT button (mouse)
        const pttBtn = document.getElementById('ptt-btn');
        pttBtn.addEventListener('mousedown', () => this.startTransmit());
        pttBtn.addEventListener('mouseup', () => this.stopTransmit());
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

    // Check if user is typing in an input
    isInputFocused() {
        const active = document.activeElement;
        return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';
    },

    // Unlock audio playback (must be called from a user gesture)
    unlockAudio() {
        if (this.audioUnlocked) return;
        this.audioUnlocked = true;
        console.log('[Audio] Unlocking audio playback');

        // Create audio context (needed for playback)
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Resume if suspended (required on iOS/mobile)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        // Play silent buffer to fully unlock
        const buffer = this.audioContext.createBuffer(1, 1, 22050);
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);
        source.start(0);
    },

    // Request microphone access
    async requestMicrophone() {
        try {
            console.log('[Audio] Requesting microphone access...');
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 16000
                },
                video: false
            });
            console.log('[Audio] Microphone access granted');
            return true;
        } catch (error) {
            console.error('[Audio] Microphone access denied:', error);
            Chat.addSystemMessage('Microphone access denied. PTT will not work.');
            return false;
        }
    },

    // Join a channel's audio
    async joinChannel(channel) {
        console.log('[Audio] Joining channel audio:', channel);

        // Request mic if not already done
        if (!this.localStream) {
            await this.requestMicrophone();
        }

        // Setup Firebase refs
        this.speakerRef = database.ref(`channels/${channel}/activeSpeaker`);
        this.audioStreamRef = database.ref(`channels/${channel}/audioStream`);

        // Listen for active speaker changes
        this.speakerRef.on('value', (snapshot) => {
            const speaker = snapshot.val();
            this.handleSpeakerChange(speaker);
        });

        // Listen for incoming audio chunks from other users
        this.audioStreamRef.on('child_added', (snapshot) => {
            const data = snapshot.val();
            if (data && data.senderId !== Auth.getUserId()) {
                this.playAudioChunk(data.audio);
            }
            // Clean up old chunks
            snapshot.ref.remove();
        });

        Chat.addSystemMessage('Audio system ready.');
    },

    // Leave channel audio
    async leaveChannel(channel) {
        console.log('[Audio] Leaving channel audio:', channel);

        // Stop transmitting if we are
        if (this.isTransmitting) {
            await this.stopTransmit();
        }

        // Remove listeners
        if (this.speakerRef) {
            this.speakerRef.off();
        }
        if (this.audioStreamRef) {
            this.audioStreamRef.off();
        }

        this.speakerRef = null;
        this.audioStreamRef = null;
    },

    // Switch channels
    async switchChannel(oldChannel, newChannel) {
        await this.leaveChannel(oldChannel);
        await this.joinChannel(newChannel);
    },

    // Start transmitting
    async startTransmit() {
        if (this.isTransmitting) return;
        if (!this.localStream) {
            await this.requestMicrophone();
            if (!this.localStream) return;
        }

        const user = Auth.getUser();
        if (!user) return;

        // Unlock audio on first user gesture
        this.unlockAudio();

        // Check if someone else is speaking
        if (this.currentSpeaker && this.currentSpeaker.userId !== Auth.getUserId()) {
            console.log('[Audio] Channel busy');
            return;
        }

        console.log('[Audio] Starting transmission');
        this.isTransmitting = true;

        // Claim the speaker slot atomically
        const channel = Channels.getCurrentChannel();
        const speakerRef = database.ref(`channels/${channel}/activeSpeaker`);

        const result = await speakerRef.transaction((current) => {
            if (!current || current.userId === Auth.getUserId()) {
                return {
                    userId: Auth.getUserId(),
                    displayName: user.displayName,
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                };
            }
            return;
        });

        if (!result.committed) {
            console.log('[Audio] Could not claim speaker slot');
            this.isTransmitting = false;
            return;
        }

        // Auto-clear speaker on disconnect
        speakerRef.onDisconnect().remove();

        // Start recording and streaming audio chunks
        this.startAudioCapture(channel);

        // Update UI
        this.updateTransmitUI(true);

        // Notify recording module
        if (typeof Recording !== 'undefined') {
            Recording.onTransmitStart();
        }
    },

    // Start capturing audio and streaming to Firebase
    startAudioCapture(channel) {
        const streamRef = database.ref(`channels/${channel}/audioStream`);
        const senderId = Auth.getUserId();

        // Determine best supported format
        const mimeType = this.getSupportedMimeType();
        console.log('[Audio] Recording with:', mimeType);

        try {
            this.mediaRecorder = new MediaRecorder(this.localStream, {
                mimeType: mimeType,
                audioBitsPerSecond: 16000
            });
        } catch (e) {
            // Fallback without options
            this.mediaRecorder = new MediaRecorder(this.localStream);
        }

        this.mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && this.isTransmitting) {
                // Convert blob to base64
                const base64 = await this.blobToBase64(event.data);

                // Write audio chunk to Firebase
                streamRef.push({
                    audio: base64,
                    senderId: senderId,
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                });
            }
        };

        // Capture in 200ms chunks for low latency
        this.mediaRecorder.start(200);
    },

    // Get supported MIME type
    getSupportedMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return '';
    },

    // Convert blob to base64 string
    blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve(reader.result);
            };
            reader.readAsDataURL(blob);
        });
    },

    // Play an incoming audio chunk
    async playAudioChunk(base64Data) {
        if (!base64Data) return;

        // Make sure audio context exists
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Resume if suspended
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        try {
            // Convert base64 back to audio and play
            const response = await fetch(base64Data);
            const blob = await response.blob();

            // Use an audio element for playback (better codec support)
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = 1.0;

            audio.onended = () => {
                URL.revokeObjectURL(url);
            };

            audio.onerror = () => {
                URL.revokeObjectURL(url);
            };

            await audio.play();
        } catch (error) {
            console.error('[Audio] Error playing chunk:', error);
        }
    },

    // Stop transmitting
    async stopTransmit() {
        if (!this.isTransmitting) return;

        console.log('[Audio] Stopping transmission');
        this.isTransmitting = false;

        // Stop media recorder
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder = null;
        }

        // Clear active speaker atomically
        const channel = Channels.getCurrentChannel();
        const speakerRef = database.ref(`channels/${channel}/activeSpeaker`);

        await speakerRef.transaction((current) => {
            if (current && current.userId === Auth.getUserId()) {
                return null;
            }
            return current;
        });

        speakerRef.onDisconnect().cancel();

        // Update UI
        this.updateTransmitUI(false);

        // Notify recording module
        if (typeof Recording !== 'undefined') {
            Recording.onTransmitStop();
        }
    },

    // Play roger beep
    playRogerBeep() {
        if (!this.rogerContext) {
            this.rogerContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = this.rogerContext;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1200, now);
        osc1.frequency.exponentialRampToValueAtTime(800, now + 0.08);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        gain1.gain.setValueAtTime(0.25, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc1.start(now);
        osc1.stop(now + 0.12);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1400, now + 0.05);
        osc2.frequency.exponentialRampToValueAtTime(1000, now + 0.15);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        gain2.gain.setValueAtTime(0.2, now + 0.05);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc2.start(now + 0.05);
        osc2.stop(now + 0.18);
    },

    // Handle speaker change
    handleSpeakerChange(speaker) {
        const previousSpeaker = this.currentSpeaker;
        this.currentSpeaker = speaker;
        const txIndicator = document.getElementById('tx-indicator');
        const txText = txIndicator.querySelector('.tx-text');
        const speakerInfo = document.getElementById('speaker-info');

        if (speaker) {
            this.lastSpeakerName = speaker.displayName;

            if (speaker.userId === Auth.getUserId()) {
                txIndicator.className = 'tx-indicator transmitting';
                txText.textContent = 'TRANSMITTING';
                speakerInfo.textContent = '';
            } else {
                txIndicator.className = 'tx-indicator receiving';
                txText.textContent = 'RECEIVING';
                speakerInfo.textContent = `${speaker.displayName} is talking`;
                Channels.markSpeaking(speaker.userId, true);
            }

            if (typeof Chat !== 'undefined' && speaker.userId !== Auth.getUserId()) {
                Chat.addSystemMessage(`🎙 ${speaker.displayName} is transmitting`);
            }
        } else {
            // Someone released PTT — play roger beep
            if (previousSpeaker && previousSpeaker.userId !== Auth.getUserId()) {
                this.playRogerBeep();
            }

            txIndicator.className = 'tx-indicator';
            txText.textContent = 'STANDBY';
            speakerInfo.textContent = '';

            document.querySelectorAll('#member-list li.speaking').forEach(li => {
                li.classList.remove('speaking');
            });
        }
    },

    // Update transmit UI
    updateTransmitUI(transmitting) {
        const pttBtn = document.getElementById('ptt-btn');
        if (transmitting) {
            pttBtn.classList.add('active');
        } else {
            pttBtn.classList.remove('active');
        }
    },

    // Cleanup
    async cleanup() {
        console.log('[Audio] Cleaning up...');

        if (this.isTransmitting) {
            await this.stopTransmit();
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.speakerRef) {
            this.speakerRef.off();
        }
        if (this.audioStreamRef) {
            this.audioStreamRef.off();
        }

        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }

        this.speakerRef = null;
        this.audioStreamRef = null;
    }
};
