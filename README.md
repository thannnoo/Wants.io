# Wants.io

A personal wants CRM. Track what you want to buy, allocate savings toward goals, and watch your progress.

---

## Deploy (GitHub Pages — free, accessible from any device)

1. **Create a new GitHub repo** at github.com → New Repository
   - Name it `wants-io` (or anything you like)
   - Set it to **Public** (required for free GitHub Pages)

2. **Push this folder to GitHub:**
   ```bash
   cd "Wants.io"
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/wants-io.git
   git push -u origin main
   ```

3. **Enable GitHub Pages:**
   - Go to your repo → Settings → Pages
   - Source: **Deploy from a branch** → `main` / `/ (root)`
   - Save → your app will be live at `https://YOUR_USERNAME.github.io/wants-io/`

---

## Cross-Device Sync (Firebase — free)

By default the app stores data in your browser's localStorage (single device only).
To sync across all your devices, add a free Firebase Firestore database:

### Setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com/) and create a new project
2. Click **Firestore Database** → **Create database** → Start in **test mode** → Choose a region
3. Click ⚙️ **Project Settings** → **Your apps** → **Web** (</> icon)
4. Register the app, then copy the `firebaseConfig` object

### Connect in the App

1. Open Wants.io in your browser
2. Tap the **shield icon** (top right) to open Sync Settings
3. Choose a **Vault ID** (any unique phrase — use the same on all your devices)
4. Paste your Firebase config JSON
5. Tap **Save & Connect**

Now any device with the same Vault ID and Firebase config will see the same data in real time.

### Firebase Security Rules (recommended)

In the Firebase console → Firestore → Rules, replace the default with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /vaults/{vaultId}/{document=**} {
      allow read, write: if true; // personal use only — tighten if needed
    }
  }
}
```

---

## Features

- **Home tab** — savings overview, want count, funded count, progress bars
- **Bank tab** — set current total savings; see allocation breakdown per want; history log
- **Wants tab** — add via URL (auto-fetches title, image, description, price) or manually
- **Allocation system** — assign a % of savings to each want; progress auto-calculates
- **Light & Dark mode** — Apple Glass aesthetic with gradient accents
- **Cross-device sync** — Firebase Firestore with a simple Vault ID system (no login needed)
