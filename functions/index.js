const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();

/**
 * RTD trigger: when an alert becomes active on any channel,
 * send FCM data messages to all online users on that channel
 * (excluding the sender).
 */
exports.onAlert = functions.database
    .ref("channels/{channelId}/activeAlert")
    .onWrite(async (change, context) => {
        const after = change.after.val();

        // Only fire when alert becomes active
        if (!after || !after.active) return null;

        const channelId = context.params.channelId;
        const senderId = after.senderId || "";
        const senderName = after.sender || "Unknown";

        console.log(`[onAlert] Alert on ${channelId} from ${senderName}`);

        // Get all users on this channel
        const usersSnap = await db.ref("users").orderByChild("channel")
            .equalTo(channelId).once("value");

        if (!usersSnap.exists()) return null;

        const tokens = [];
        const staleTokenUids = [];

        usersSnap.forEach((child) => {
            const userData = child.val();
            // Skip sender and users without FCM tokens
            if (child.key === senderId) return;
            if (!userData.fcmToken) return;
            tokens.push({ uid: child.key, token: userData.fcmToken });
        });

        if (tokens.length === 0) {
            console.log("[onAlert] No FCM tokens to notify");
            return null;
        }

        console.log(`[onAlert] Sending to ${tokens.length} device(s)`);

        // Send data-only messages (no notification key — handled by SW)
        const message = {
            data: {
                type: "alert",
                channel: channelId,
                sender: senderName,
                senderId: senderId,
                timestamp: String(after.timestamp || Date.now()),
            },
            // Android high priority ensures delivery even when dozing
            android: { priority: "high" },
            // APNs content-available for iOS background delivery
            apns: {
                headers: { "apns-priority": "10" },
                payload: { aps: { "content-available": 1 } },
            },
        };

        // Send to each token individually to handle errors per-token
        const results = await Promise.allSettled(
            tokens.map(({ uid, token }) =>
                admin.messaging().send({ ...message, token })
                    .catch((err) => {
                        // Mark stale tokens for cleanup
                        if (
                            err.code === "messaging/invalid-registration-token" ||
                            err.code === "messaging/registration-token-not-registered"
                        ) {
                            staleTokenUids.push(uid);
                        }
                        throw err;
                    })
            )
        );

        const successCount = results.filter((r) => r.status === "fulfilled").length;
        console.log(`[onAlert] Sent: ${successCount}/${tokens.length}`);

        // Clean up stale tokens
        if (staleTokenUids.length > 0) {
            console.log(`[onAlert] Removing ${staleTokenUids.length} stale token(s)`);
            const updates = {};
            staleTokenUids.forEach((uid) => {
                updates[`users/${uid}/fcmToken`] = null;
            });
            await db.ref().update(updates);
        }

        return null;
    });
