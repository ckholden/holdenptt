# Holden PTT - Push-to-Talk Web App

A web-based push-to-talk voice communication app with live chat, 4 channels, alert tones, and recording.

## Features

- **Push-to-Talk**: Hold SPACEBAR or click the PTT button to transmit
- **4 Channels**: Main + 3 additional channels
- **Live Chat**: Real-time text messaging per channel
- **Alert Tones**: EMS-style two-tone alerts
- **Recording**: Record and playback channel audio
- **User Presence**: See who's online and in each channel

---

## Quick Setup Guide

### Step 1: Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **"Create a project"** (or **"Add project"**)
3. Name it something like `holdenptt` or `holden-ptt`
4. Disable Google Analytics (optional, not needed)
5. Click **Create project**

### Step 2: Enable Firebase Services

#### Authentication
1. In your Firebase project, click **"Build"** → **"Authentication"**
2. Click **"Get started"**
3. Click **"Anonymous"** under Sign-in providers
4. Toggle **Enable** to ON
5. Click **Save**

#### Realtime Database
1. Click **"Build"** → **"Realtime Database"**
2. Click **"Create Database"**
3. Choose a location closest to you
4. Select **"Start in test mode"** (for now)
5. Click **Enable**

#### Storage
1. Click **"Build"** → **"Storage"**
2. Click **"Get started"**
3. Select **"Start in test mode"**
4. Click **Next**, then **Done**

### Step 3: Get Your Firebase Config

1. Click the **gear icon** (⚙️) next to "Project Overview"
2. Select **"Project settings"**
3. Scroll down to **"Your apps"**
4. Click the **web icon** (`</>`)
5. Enter an app nickname (e.g., "Holden PTT Web")
6. Click **"Register app"**
7. Copy the `firebaseConfig` object shown

### Step 4: Configure the App

1. Open `js/config.js`
2. Replace the placeholder values with your Firebase config:

```javascript
const firebaseConfig = {
    apiKey: "AIzaSy...",           // Your API key
    authDomain: "your-project.firebaseapp.com",
    databaseURL: "https://your-project-default-rtdb.firebaseio.com",
    projectId: "your-project",
    storageBucket: "your-project.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abc123..."
};
```

3. Set your room password:
```javascript
const ROOM_PASSWORD = "your-secret-password";
```

### Step 5: Deploy to GitHub Pages

1. Create a new GitHub repository
2. Push all these files to the repository
3. Go to **Settings** → **Pages**
4. Under "Source", select **"Deploy from a branch"**
5. Select **main** branch and **/ (root)** folder
6. Click **Save**
7. Wait 1-2 minutes for deployment
8. Your site will be at: `https://yourusername.github.io/repositoryname`

---

## Usage

1. Open the app in your browser
2. Enter your callsign (display name)
3. Enter the room password you set
4. Click **CONNECT**

### Controls

| Action | Method |
|--------|--------|
| Talk | Hold SPACEBAR or hold PTT button |
| Stop talking | Release SPACEBAR or button |
| Switch channel | Click channel buttons on left |
| Send chat | Type in chat box, press Enter |
| Send alert | Click "SEND ALERT" button |
| Record | Click record button, click again to stop |

---

## Firebase Security Rules (Production)

When you're ready to go live, update your security rules:

### Realtime Database Rules
```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": true,
        ".write": "$uid === auth.uid"
      }
    },
    "channels": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "recordings": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

### Storage Rules
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /recordings/{fileName} {
      allow read, write: if request.auth != null;
    }
  }
}
```

---

## Troubleshooting

### "Firebase is not configured"
- Make sure you copied the config to `js/config.js`
- Check that all values are filled in (no "YOUR_..." placeholders)

### Can't hear other users
- Check that microphone permissions are granted
- Both users must be in the same channel
- Check browser console for WebRTC errors

### Push-to-talk not working
- Make sure you're not focused on a text input when pressing SPACEBAR
- Check microphone permissions in browser

### Recording not saving
- Check Firebase Storage is enabled
- Check browser console for errors
- Verify storage rules allow writes

---

## Browser Support

- Chrome (recommended)
- Firefox
- Edge
- Safari (iOS 14.5+)

---

## License

MIT License - Use freely for personal or commercial projects.
