// ========================================
// ALERTS MODULE
// ========================================

const Alerts = {
    alertRef: null,
    alertSound: null,
    isAlertPlaying: false,
    alertTimeout: null,
    _pendingAlert: null,

    // Initialize alerts
    init() {
        console.log('[Alerts] Initializing...');

        // Create alert sound (two-tone EMS style)
        this.createAlertSound();

        // Setup alert button
        document.getElementById('alert-btn').addEventListener('click', () => {
            this.sendAlert();
        });

        // Play queued alert when user returns to app
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this._pendingAlert) {
                const alert = this._pendingAlert;
                this._pendingAlert = null;
                this.showAlert(alert);
            }
        });

        // Listen for ALERT_TAP from service worker (notification tap while app is open)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'ALERT_TAP') {
                    console.log('[Alerts] Notification tapped, playing tone');
                    this.playTwoToneAlert();
                }
            });
        }

        // Check for cold-start alert hash (opened from notification when app was closed)
        if (location.hash.startsWith('#alert=')) {
            const channel = location.hash.replace('#alert=', '');
            console.log('[Alerts] Cold start from notification, channel:', channel);
            // Clear hash so it doesn't re-trigger
            history.replaceState(null, '', location.pathname + location.search);
            // Play tone after a short delay to let audio context initialize
            setTimeout(() => this.playTwoToneAlert(), 1000);
        }
    },

    // Create the alert sound using Web Audio API
    createAlertSound() {
        // We'll create a two-tone alert programmatically
        this.audioContext = null;
    },

    // Generate realistic EMS/fire dispatch tone-out
    // Pattern: attention warble -> pause -> tone A -> tone B -> pause -> tone A -> tone B -> long tone
    playTwoToneAlert() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = this.audioContext;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;

        // Dispatch tone frequencies (Motorola two-tone sequential style)
        const toneA = 853.2;
        const toneB = 960.0;
        const warbleHi = 1050;
        const warbleLo = 750;
        const volume = 0.35;

        // --- Phase 1: Attention warble (0.6 second) ---
        const warbleRate = 10;
        const warbleDuration = 0.6;
        const warbleSteps = Math.floor(warbleRate * warbleDuration);
        const stepLen = warbleDuration / warbleSteps;

        for (let i = 0; i < warbleSteps; i++) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = (i % 2 === 0) ? warbleHi : warbleLo;
            osc.connect(gain);
            gain.connect(ctx.destination);
            const t0 = now + (i * stepLen);
            gain.gain.setValueAtTime(volume, t0);
            gain.gain.setValueAtTime(0.001, t0 + stepLen - 0.005);
            osc.start(t0);
            osc.stop(t0 + stepLen);
        }

        // --- Phase 2: Pause (0.15s) then Two-tone page (tone A 0.6s, tone B 0.6s) ---
        let t = now + warbleDuration + 0.15;

        // Tone A
        const oscA = ctx.createOscillator();
        const gainA = ctx.createGain();
        oscA.type = 'sine';
        oscA.frequency.value = toneA;
        oscA.connect(gainA);
        gainA.connect(ctx.destination);
        gainA.gain.setValueAtTime(volume, t);
        gainA.gain.setValueAtTime(volume, t + 0.55);
        gainA.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        oscA.start(t);
        oscA.stop(t + 0.6);
        t += 0.6;

        // Tone B
        const oscB = ctx.createOscillator();
        const gainB = ctx.createGain();
        oscB.type = 'sine';
        oscB.frequency.value = toneB;
        oscB.connect(gainB);
        gainB.connect(ctx.destination);
        gainB.gain.setValueAtTime(volume, t);
        gainB.gain.setValueAtTime(volume, t + 0.55);
        gainB.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        oscB.start(t);
        oscB.stop(t + 0.6);
        t += 0.6;

        // --- Phase 3: Short confirmation tone (0.3s) ---
        t += 0.15;
        const oscEnd = ctx.createOscillator();
        const gainEnd = ctx.createGain();
        oscEnd.type = 'sine';
        oscEnd.frequency.value = 1000;
        oscEnd.connect(gainEnd);
        gainEnd.connect(ctx.destination);
        gainEnd.gain.setValueAtTime(volume * 0.7, t);
        gainEnd.gain.setValueAtTime(volume * 0.7, t + 0.2);
        gainEnd.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        oscEnd.start(t);
        oscEnd.stop(t + 0.3);
    },

    // Start listening for alerts on a channel
    startListening(channel) {
        console.log('[Alerts] Listening for alerts on:', channel);

        this.alertRef = database.ref(`channels/${channel}/activeAlert`);

        this.alertRef.on('value', (snapshot) => {
            const alert = snapshot.val();
            if (alert && alert.active) {
                this.showAlert(alert);
            } else {
                this.hideAlert();
            }
        });
    },

    // Stop listening
    stopListening() {
        if (this.alertRef) {
            this.alertRef.off();
            this.alertRef = null;
        }
    },

    // Switch channels
    switchChannel(newChannel) {
        this.stopListening();
        this.startListening(newChannel);
    },

    // Send an alert to the current channel
    async sendAlert() {
        const channel = Channels.getCurrentChannel();
        const user = Auth.getUser();

        if (!user) return;

        console.log('[Alerts] Sending alert on:', channel);

        try {
            await database.ref(`channels/${channel}/activeAlert`).set({
                active: true,
                sender: user.displayName,
                senderId: Auth.getUserId(),
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });

            // Auto-clear after 5 seconds (matches tone-out duration)
            setTimeout(async () => {
                const currentAlert = await database.ref(`channels/${channel}/activeAlert`).once('value');
                const alertData = currentAlert.val();
                if (alertData && alertData.senderId === Auth.getUserId()) {
                    await database.ref(`channels/${channel}/activeAlert`).remove();
                }
            }, 5000);

        } catch (error) {
            console.error('[Alerts] Error sending alert:', error);
        }
    },

    // Show alert overlay and play sound
    showAlert(alert) {
        if (this.isAlertPlaying) return;

        // If app is backgrounded, send notification and queue for playback on return
        if (document.hidden) {
            console.log('[Alerts] App backgrounded, queuing alert from:', alert.sender);
            this._pendingAlert = alert;
            this.showAlertNotification(alert.sender);
            if (typeof Chat !== 'undefined') {
                Chat.addSystemMessage(`ALERT from ${alert.sender}`);
            }
            return;
        }

        console.log('[Alerts] Showing alert from:', alert.sender);
        this.isAlertPlaying = true;

        // Update overlay
        const overlay = document.getElementById('alert-overlay');
        const senderEl = document.getElementById('alert-sender');

        senderEl.textContent = `From: ${alert.sender}`;
        overlay.classList.remove('hidden');

        // Play sound
        this.playTwoToneAlert();

        // Add system message
        if (typeof Chat !== 'undefined') {
            Chat.addSystemMessage(`ALERT from ${alert.sender}`);
        }

        // Auto-hide after 5 seconds (tone-out runs ~4s)
        this.alertTimeout = setTimeout(() => {
            this.hideAlert();
        }, 5000);
    },

    // Send browser notification for alerts when app is backgrounded
    showAlertNotification(senderName) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const channelName = Channels.getChannelName(Channels.getCurrentChannel());
        const n = new Notification('ALERT - Holden PTT', {
            body: `Emergency alert from ${senderName} on ${channelName}`,
            tag: 'ptt-alert',
            requireInteraction: true
        });
        // Don't auto-close — requireInteraction keeps it visible until tapped
    },

    // Hide alert overlay
    hideAlert() {
        if (!this.isAlertPlaying) return;

        console.log('[Alerts] Hiding alert');
        this.isAlertPlaying = false;

        const overlay = document.getElementById('alert-overlay');
        overlay.classList.add('hidden');

        if (this.alertTimeout) {
            clearTimeout(this.alertTimeout);
            this.alertTimeout = null;
        }
    }
};
