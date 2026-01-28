// ========================================
// FCM PUSH NOTIFICATIONS MODULE
// ========================================

const FCM = {
    messaging: null,
    _token: null,

    // Initialize FCM — call after Firebase is initialized
    init() {
        console.log('[FCM] Initializing...');

        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('[FCM] Push messaging not supported');
            return;
        }

        if (typeof firebase.messaging !== 'function') {
            console.warn('[FCM] Firebase Messaging SDK not loaded');
            return;
        }

        try {
            this.messaging = firebase.messaging();
            console.log('[FCM] Messaging instance created');
        } catch (err) {
            console.error('[FCM] Failed to create messaging instance:', err);
        }
    },

    // Register FCM token after login — stores token in RTD under users/{uid}/fcmToken
    async registerToken() {
        if (!this.messaging) return;

        const uid = Auth.getUserId();
        if (!uid) return;

        try {
            // Use the existing SW registration
            const swReg = await navigator.serviceWorker.ready;

            const token = await this.messaging.getToken({
                vapidKey: FCM_VAPID_KEY,
                serviceWorkerRegistration: swReg
            });

            if (token) {
                this._token = token;
                await database.ref(`users/${uid}/fcmToken`).set(token);
                console.log('[FCM] Token registered');
            } else {
                console.warn('[FCM] No token returned (notifications may be blocked)');
            }
        } catch (err) {
            console.error('[FCM] Token registration failed:', err);
        }
    },

    // Suppress duplicate notifications when app is in foreground
    setupForegroundHandler() {
        if (!this.messaging) return;

        this.messaging.onMessage((payload) => {
            console.log('[FCM] Foreground message received (suppressed):', payload.data?.type);
            // Do nothing — the RTD listener in Alerts already handles foreground alerts
        });
    },

    // Remove FCM token from RTD on logout
    async removeToken() {
        const uid = Auth.getUserId();
        if (!uid) return;

        try {
            await database.ref(`users/${uid}/fcmToken`).remove();
            console.log('[FCM] Token removed from RTD');
        } catch (err) {
            console.warn('[FCM] Failed to remove token:', err);
        }

        // Delete the token from FCM as well
        if (this.messaging && this._token) {
            try {
                await this.messaging.deleteToken();
                console.log('[FCM] Token deleted from FCM');
            } catch (err) {
                console.warn('[FCM] Failed to delete FCM token:', err);
            }
        }
        this._token = null;
    }
};
