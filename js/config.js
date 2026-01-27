// ========================================
// FIREBASE CONFIGURATION
// ========================================
//
// INSTRUCTIONS:
// 1. Go to https://console.firebase.google.com/
// 2. Create a new project (or select existing)
// 3. Click the gear icon > Project settings
// 4. Scroll down to "Your apps" and click the web icon (</>)
// 5. Register your app and copy the config values below
// 6. Enable Authentication > Anonymous sign-in
// 7. Enable Realtime Database (start in test mode)
// 8. Enable Storage (start in test mode)
//
// ========================================

const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Room password - share this with your family/friends
// Anyone with this password can join the room
const ROOM_PASSWORD = "changeme";

// ========================================
// DO NOT EDIT BELOW THIS LINE
// ========================================

// Initialize Firebase
let app, auth, database, storage;

function initializeFirebase() {
    try {
        app = firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        database = firebase.database();
        storage = firebase.storage();
        console.log('[Config] Firebase initialized successfully');
        return true;
    } catch (error) {
        console.error('[Config] Firebase initialization failed:', error);
        return false;
    }
}

// Check if Firebase is configured
function isFirebaseConfigured() {
    return firebaseConfig.apiKey !== "YOUR_API_KEY" &&
           firebaseConfig.projectId !== "YOUR_PROJECT_ID";
}
