# Confidant — AI Character Chat

A private, installable character-roleplay chat app powered entirely by *your own* AI API key. No backend, no account, no data leaving your device except the messages you send to whichever AI provider you configure.

## What's in this folder
- `index.html`, `styles.css`, `app.js` — the whole app (vanilla JS, no build step)
- `manifest.json`, `sw.js` — makes it an installable PWA (works offline for the UI shell)
- `icons/` — app icons

## Run it
PWAs must be served over HTTP(S) — opening `index.html` directly as a `file://` URL will break the service worker and manifest. Easiest options:

**Locally:**
```bash
cd charai-app
python3 -m http.server 8080
# then open http://localhost:8080 in a browser
```

**Free static hosting** (any of these work, just upload the folder):
- GitHub Pages
- Netlify / Vercel (drag-and-drop deploy)
- Cloudflare Pages

Once it's served over HTTPS, open it on your Android phone in Chrome and use **"Add to Home screen"** (or Chrome will show an install prompt automatically) — it installs like a native app, gets its own icon, and opens without browser chrome.

## About the "APK" requirement
A real signed `.apk` needs the Android SDK/build tooling, which isn't available in this environment. The practical, honest path that gets you the same result — an icon on the home screen, full-screen standalone window, offline-capable shell — is the installable PWA above. If you specifically want a distributable `.apk` file later, the folder as-is is exactly what a tool like [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) or [PWABuilder](https://www.pwabuilder.com/) needs as input to wrap it into one; you'd host this folder, point either tool at the URL, and it generates the APK for you.

## Setting up your API key
On first launch you'll choose a provider and paste in your key:
- **Anthropic** — works directly from the browser (the app sends the required `anthropic-dangerous-direct-browser-access` header).
- **OpenAI‑compatible** — works with OpenAI, OpenRouter, Groq, a local Ollama/LM Studio server, etc. Edit the base URL for whichever one you use.

Some providers block requests sent directly from a browser (CORS). If yours does, you'll need a tiny reverse-proxy in front of it — the app itself has no server component to do this for you.

The key is stored only in the browser's local storage on your device (`localStorage`) and is sent only to the base URL you configured.

## How memory works
- **Local memory** — the last ~24 messages of a conversation, sent verbatim as context on every reply.
- **User memory** — durable facts about you, shared across every character (e.g. "the user's name is X"). Built from quick pattern-matching plus periodic AI summarization, viewable and it grows automatically as you chat.
- **Character memory** — per-character relationship summary and key facts, updated by the AI every 8 messages so the story keeps continuity even after the local window scrolls past it.

All three layers are assembled into the system prompt on every single request — nothing is hidden from the model, and nothing is sent to any server other than your chosen AI provider.

## Formatting syntax
- `*text*` → physical action / stage direction
- `` `text` `` → emphasized statement
- `#text` → high priority / dramatic emphasis

The model is instructed to both use these conventions and interpret them the same way when you use them.
