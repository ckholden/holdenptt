// ========================================
// PTT AUDIO MODULE (WebRTC)
// ========================================

const PTTAudio = {
    localStream: null,
    peerConnections: {},
    isTransmitting: false,
    currentSpeaker: null,
    signalingRef: null,
    speakerRef: null,
    signalingChildRef: null,
    iceCandidatesQueue: {},

    // WebRTC configuration
    rtcConfig: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    },

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

    // Request microphone access
    async requestMicrophone() {
        try {
            console.log('[Audio] Requesting microphone access...');
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            console.log('[Audio] Microphone access granted');

            // Mute local stream initially (only transmit when PTT pressed)
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });

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

        // Setup signaling listener
        this.signalingRef = database.ref(`channels/${channel}/signaling`);
        this.speakerRef = database.ref(`channels/${channel}/activeSpeaker`);

        // Listen for active speaker changes
        this.speakerRef.on('value', (snapshot) => {
            const speaker = snapshot.val();
            this.handleSpeakerChange(speaker);
        });

        // Listen for signaling messages directed at us
        const userId = Auth.getUserId();
        this.signalingChildRef = this.signalingRef.child(userId);
        this.signalingChildRef.on('child_added', (snapshot) => {
            const data = snapshot.val();
            this.handleSignaling(data);
            // Remove processed signal
            snapshot.ref.remove();
        });

        // Announce presence for WebRTC
        await this.announcePresence(channel);
    },

    // Leave channel audio
    async leaveChannel(channel) {
        console.log('[Audio] Leaving channel audio:', channel);

        // Stop transmitting if we are
        if (this.isTransmitting) {
            await this.stopTransmit();
        }

        // Close all peer connections
        Object.keys(this.peerConnections).forEach(peerId => {
            this.closePeerConnection(peerId);
        });

        // Remove listeners
        if (this.signalingChildRef) {
            this.signalingChildRef.off();
            this.signalingChildRef = null;
        }
        if (this.speakerRef) {
            this.speakerRef.off();
        }

        this.signalingRef = null;
        this.speakerRef = null;
    },

    // Switch channels
    async switchChannel(oldChannel, newChannel) {
        await this.leaveChannel(oldChannel);
        await this.joinChannel(newChannel);
    },

    // Announce presence to establish connections with peers
    async announcePresence(channel) {
        const usersRef = database.ref('users');
        const userId = Auth.getUserId();

        // Find other online users in this channel
        const snapshot = await usersRef
            .orderByChild('currentChannel')
            .equalTo(channel)
            .once('value');

        snapshot.forEach((child) => {
            const peerId = child.key;
            const user = child.val();

            if (peerId !== userId && user.online) {
                // Create connection to this peer
                this.createPeerConnection(peerId, true);
            }
        });
    },

    // Create a WebRTC peer connection
    async createPeerConnection(peerId, isInitiator) {
        if (this.peerConnections[peerId]) {
            console.log('[Audio] Connection already exists for:', peerId);
            return;
        }

        console.log('[Audio] Creating peer connection to:', peerId, 'initiator:', isInitiator);

        const pc = new RTCPeerConnection(this.rtcConfig);
        this.peerConnections[peerId] = pc;
        this.iceCandidatesQueue[peerId] = [];

        // Add local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });
        }

        // Handle incoming stream
        pc.ontrack = (event) => {
            console.log('[Audio] Received remote track from:', peerId);
            this.handleRemoteStream(peerId, event.streams[0]);
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignal(peerId, {
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    from: Auth.getUserId()
                });
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log('[Audio] Connection state:', peerId, pc.connectionState);
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                this.closePeerConnection(peerId);
            }
        };

        // If initiator, create offer
        if (isInitiator) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                this.sendSignal(peerId, {
                    type: 'offer',
                    sdp: pc.localDescription,
                    from: Auth.getUserId()
                });
            } catch (error) {
                console.error('[Audio] Error creating offer:', error);
            }
        }
    },

    // Handle incoming signaling messages
    async handleSignaling(data) {
        const { type, from } = data;
        console.log('[Audio] Received signal:', type, 'from:', from);

        if (type === 'offer') {
            // Create connection if doesn't exist
            if (!this.peerConnections[from]) {
                await this.createPeerConnection(from, false);
            }

            const pc = this.peerConnections[from];
            if (!pc) return;

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

                // Process queued ICE candidates
                while (this.iceCandidatesQueue[from]?.length > 0) {
                    const candidate = this.iceCandidatesQueue[from].shift();
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                this.sendSignal(from, {
                    type: 'answer',
                    sdp: pc.localDescription,
                    from: Auth.getUserId()
                });
            } catch (error) {
                console.error('[Audio] Error handling offer:', error);
            }

        } else if (type === 'answer') {
            const pc = this.peerConnections[from];
            if (!pc) return;

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

                // Process queued ICE candidates
                while (this.iceCandidatesQueue[from]?.length > 0) {
                    const candidate = this.iceCandidatesQueue[from].shift();
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
            } catch (error) {
                console.error('[Audio] Error handling answer:', error);
            }

        } else if (type === 'ice-candidate') {
            const pc = this.peerConnections[from];

            if (pc && pc.remoteDescription) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (error) {
                    console.error('[Audio] Error adding ICE candidate:', error);
                }
            } else {
                // Queue the candidate
                if (!this.iceCandidatesQueue[from]) {
                    this.iceCandidatesQueue[from] = [];
                }
                this.iceCandidatesQueue[from].push(data.candidate);
            }
        }
    },

    // Send signaling message to a peer
    sendSignal(peerId, data) {
        const channel = Channels.getCurrentChannel();
        database.ref(`channels/${channel}/signaling/${peerId}`).push(data);
    },

    // Handle remote audio stream
    handleRemoteStream(peerId, stream) {
        // Create audio element for this peer
        let audio = document.getElementById(`audio-${peerId}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${peerId}`;
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = stream;
    },

    // Close peer connection
    closePeerConnection(peerId) {
        const pc = this.peerConnections[peerId];
        if (pc) {
            pc.close();
            delete this.peerConnections[peerId];
        }

        // Remove audio element
        const audio = document.getElementById(`audio-${peerId}`);
        if (audio) {
            audio.remove();
        }

        delete this.iceCandidatesQueue[peerId];
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

        // Check if someone else is speaking
        if (this.currentSpeaker && this.currentSpeaker.userId !== Auth.getUserId()) {
            console.log('[Audio] Channel busy');
            return;
        }

        console.log('[Audio] Starting transmission');
        this.isTransmitting = true;

        // Enable audio track
        this.localStream.getAudioTracks().forEach(track => {
            track.enabled = true;
        });

        // Update active speaker in database using transaction to avoid race conditions
        const channel = Channels.getCurrentChannel();
        const speakerRef = database.ref(`channels/${channel}/activeSpeaker`);

        await speakerRef.transaction((current) => {
            // Only claim if nobody is speaking, or we already own it
            if (!current || current.userId === Auth.getUserId()) {
                return {
                    userId: Auth.getUserId(),
                    displayName: user.displayName,
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                };
            }
            // Someone else is speaking, abort
            return;
        });

        // Setup onDisconnect to clear speaker if we drop
        speakerRef.onDisconnect().remove();

        // Update UI
        this.updateTransmitUI(true);

        // Notify recording module
        if (typeof Recording !== 'undefined') {
            Recording.onTransmitStart();
        }
    },

    // Stop transmitting
    async stopTransmit() {
        if (!this.isTransmitting) return;

        console.log('[Audio] Stopping transmission');
        this.isTransmitting = false;

        // Disable audio track
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
        }

        // Clear active speaker using transaction (atomic check-and-clear)
        const channel = Channels.getCurrentChannel();
        const speakerRef = database.ref(`channels/${channel}/activeSpeaker`);

        await speakerRef.transaction((current) => {
            if (current && current.userId === Auth.getUserId()) {
                return null; // Clear it
            }
            return current; // Leave it (someone else took it)
        });

        // Cancel the onDisconnect since we cleaned up normally
        speakerRef.onDisconnect().cancel();

        // Update UI
        this.updateTransmitUI(false);

        // Notify recording module
        if (typeof Recording !== 'undefined') {
            Recording.onTransmitStop();
        }
    },

    // Handle speaker change
    handleSpeakerChange(speaker) {
        this.currentSpeaker = speaker;
        const txIndicator = document.getElementById('tx-indicator');
        const txText = txIndicator.querySelector('.tx-text');
        const speakerInfo = document.getElementById('speaker-info');

        if (speaker) {
            if (speaker.userId === Auth.getUserId()) {
                // We are transmitting
                txIndicator.className = 'tx-indicator transmitting';
                txText.textContent = 'TRANSMITTING';
                speakerInfo.textContent = '';
            } else {
                // Someone else is transmitting
                txIndicator.className = 'tx-indicator receiving';
                txText.textContent = 'RECEIVING';
                speakerInfo.textContent = `${speaker.displayName} is talking`;

                // Mark user as speaking in member list
                Channels.markSpeaking(speaker.userId, true);
            }

            // Show who is talking in chat
            if (typeof Chat !== 'undefined' && speaker.userId !== Auth.getUserId()) {
                Chat.addSystemMessage(`🎙 ${speaker.displayName} is transmitting`);
            }
        } else {
            // No one is speaking
            txIndicator.className = 'tx-indicator';
            txText.textContent = 'STANDBY';
            speakerInfo.textContent = '';

            // Clear all speaking indicators
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

        // Stop transmission
        if (this.isTransmitting) {
            await this.stopTransmit();
        }

        // Close all peer connections
        Object.keys(this.peerConnections).forEach(peerId => {
            this.closePeerConnection(peerId);
        });

        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        // Remove listeners
        if (this.signalingChildRef) {
            this.signalingChildRef.off();
            this.signalingChildRef = null;
        }
        if (this.speakerRef) {
            this.speakerRef.off();
        }

        this.signalingRef = null;
        this.speakerRef = null;
    }
};
