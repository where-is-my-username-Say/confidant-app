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
On first launch (or from Settings → "Change API key / provider") you pick a provider family, then a preset:

- **Anthropic** — works directly from the browser.
- **OpenAI‑compatible** — reveals a row of one-tap presets that fill in the base URL and model for you:
  - **Gemini** — genuinely free tier, no card needed
  - **OpenAI**
  - **OpenRouter** — defaults to `openrouter/auto`, which auto-picks a good model per message so it never goes stale; swap in `openrouter/free` or any specific model id if you'd rather pin one
  - **Groq** — free tier, very fast
  - **Mistral**, **DeepSeek**, **Together AI**, **Fireworks** — all pay-as-you-go
  - **xAI (Grok)**
  - **Custom / Other** — blank fields for anything else, including a local Ollama/LM Studio server

Whichever you pick, the base URL and model stay editable — the preset is just a starting point.

Some providers block requests sent directly from a browser (CORS). Anthropic, Gemini, OpenRouter, and Groq are known to allow it; if a preset fails immediately with what looks like a network error, that provider likely needs a small proxy in front of it.

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

## What's new in this version
- **Real streaming replies** — text now writes in live, token-by-token, the same way ChatGPT/Claude's own interfaces do (both Anthropic and OpenAI-compatible paths use server-sent events).
- **Relationship & personality at character creation** — pick how they relate to you (Stranger, Friend, Best Friend, Roommate, Sister, Mother, or a custom relationship) and up to 3 personality flavor tags; both are woven into the generated sheet and kept in the permanent system prompt.
- **Long-press a character card** for a quick-actions sheet: open, rename, generate a portrait, duplicate, reset memory, or delete.
- **Best-effort AI portraits** — "Generate a portrait" attempts an image via your provider's `/images/generations` endpoint (works with OpenAI-style image models). Anthropic and providers without an image endpoint fall back gracefully to the colored-initial avatar with a clear message — nothing breaks.
- **Optional biometric app lock** — if your browser/device supports it, Settings shows a toggle to gate opening the app behind your phone's fingerprint/face/PIN via WebAuthn. This is a local-only device check; there's no server, no account, nothing transmitted.
- **Mobile keyboard fixes** — the on-screen keyboard now stays open after you hit send, and the layout uses the visible-viewport height so the input bar doesn't get shoved off-screen when the keyboard opens.
- Chat history was already persisted per character (and for Quick Chat) in local storage — that hasn't changed, it's just more reliable now with the retry/timeout handling.
