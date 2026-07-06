"use strict";

/* =========================================================================
   STORAGE
   ========================================================================= */
const Storage = {
  prefix: "confidant.",
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn("Storage read failed for", key, e);
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("Storage write failed", e);
      toast("Couldn't save — your device storage may be full.", true);
      return false;
    }
  },
  remove(key) {
    localStorage.removeItem(this.prefix + key);
  },
  wipeAll() {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(this.prefix))
      .forEach((k) => localStorage.removeItem(k));
  }
};

/* =========================================================================
   TOASTS
   ========================================================================= */
function toast(message, isError = false) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

/* =========================================================================
   FORMATTING ENGINE
   ========================================================================= */
const Format = {
  escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },
  render(raw) {
    let text = this.escapeHtml(raw);
    text = text.replace(/`([^`\n]+)`/g, '<span class="fmt-emph">$1</span>');
    text = text.replace(/\*([^*\n]+)\*/g, '<span class="fmt-action">$1</span>');
    text = text.replace(/#([^#\n]+)#/g, '<span class="fmt-priority">$1</span>');
    text = text.replace(/(^|\n)#([^\n]+)/g, '$1<span class="fmt-priority">$2</span>');
    return text;
  }
};

/* =========================================================================
   AVATAR HELPERS
   ========================================================================= */
function hashString(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function colorForName(name) {
  const hue = hashString(name || "?") % 360;
  return `hsl(${hue}, 50%, 58%)`;
}
function initialForName(name) {
  return String(name || "?").trim().charAt(0).toUpperCase() || "?";
}
// Renders either an uploaded/generated portrait image or a colored-initial
// fallback into any avatar element, consistently across the whole app.
function renderAvatarInto(el, entity, isQuick) {
  el.innerHTML = "";
  if (isQuick) {
    el.style.background = "var(--plum)";
    el.textContent = "Q";
    return;
  }
  if (entity && entity.avatarImage) {
    el.style.background = "transparent";
    const img = document.createElement("img");
    img.src = entity.avatarImage;
    img.alt = entity.name || "";
    img.loading = "lazy";
    el.appendChild(img);
  } else {
    el.style.background = colorForName(entity?.name);
    el.textContent = initialForName(entity?.name);
  }
}

/* =========================================================================
   SSE STREAM READER — shared by both provider streaming paths
   ========================================================================= */
async function consumeSSE(response, onData, idleTimeoutMs, controller) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  try {
    while (true) {
      resetTimer();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          onData(JSON.parse(payload));
        } catch (e) {
          /* ignore malformed SSE fragments */
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================================
   API CLIENT — model-agnostic, with real token streaming
   ========================================================================= */
const API = {
  CONNECT_TIMEOUT_MS: 30000,
  IDLE_TIMEOUT_MS: 25000,
  MAX_RETRIES: 2,

  config() {
    return Storage.get("apiConfig", null);
  },

  _throwFromStatus(status, message) {
    const err = new Error(message || `Request failed (${status})`);
    err.retryable = status === 429 || status >= 500;
    throw err;
  },

  async _fetchWithTimeout(url, options, timeoutMs = this.CONNECT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("The request timed out. Check your connection and try again.");
      throw new Error("Network request failed — check the base URL and your connection.");
    } finally {
      clearTimeout(timer);
    }
  },

  /* ---------------- non-streaming (used for JSON generation tasks) ---------------- */
  async send({ system, messages, maxTokens = 1024 }) {
    const cfg = this.config();
    if (!cfg) throw new Error("No API configuration found. Set up your key in Settings.");
    if (!navigator.onLine) throw new Error("You're offline — reconnect and try again.");

    const attemptFn =
      cfg.provider === "anthropic"
        ? () => this._sendAnthropic(cfg, system, messages, maxTokens)
        : () => this._sendOpenAI(cfg, system, messages, maxTokens);

    let lastErr;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await attemptFn();
      } catch (err) {
        lastErr = err;
        if (!err.retryable || attempt === this.MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  },

  async _sendAnthropic(cfg, system, messages, maxTokens) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages";
    const res = await this._fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: messages.map((m) => ({ role: m.role, content: m.content })) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) this._throwFromStatus(res.status, data?.error?.message);
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) throw new Error("Empty response from provider.");
    return text;
  },

  async _sendOpenAI(cfg, system, messages, maxTokens) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const disablesReasoning = /generativelanguage\.googleapis\.com|api\.x\.ai/i.test(cfg.baseUrl);
    const body = {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: 0.95,
      messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))]
    };
    if (disablesReasoning) body.reasoning_effort = "none";

    const res = await this._fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) this._throwFromStatus(res.status, data?.error?.message);
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from provider.");
    return text;
  },

  async validate(cfg) {
    const prevConfig = this.config();
    Storage.set("apiConfig", cfg);
    try {
      await this.send({
        system: "Reply with exactly one word: OK",
        messages: [{ role: "user", content: "Connection test." }],
        maxTokens: 64
      });
      return { ok: true };
    } catch (err) {
      if (prevConfig) Storage.set("apiConfig", prevConfig);
      else Storage.remove("apiConfig");
      throw err;
    }
  },

  async requestJSON({ system, user, maxTokens = 1200 }) {
    const raw = await this.send({ system, messages: [{ role: "user", content: user }], maxTokens });
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const jsonSlice = start !== -1 && end !== -1 ? cleaned.slice(start, end + 1) : cleaned;
    try {
      return JSON.parse(jsonSlice);
    } catch (e) {
      throw new Error("The model didn't return valid data — try again.");
    }
  },

  /* ---------------- streaming (used for live chat replies) ---------------- */
  async stream({ system, messages, maxTokens = 900, onToken }) {
    const cfg = this.config();
    if (!cfg) throw new Error("No API configuration found. Set up your key in Settings.");
    if (!navigator.onLine) throw new Error("You're offline — reconnect and try again.");

    let full = "";
    let receivedAny = false;
    const wrappedOnToken = (t) => {
      if (!t) return;
      full += t;
      receivedAny = true;
      if (onToken) onToken(t, full);
    };

    const attempt = async () => {
      full = "";
      receivedAny = false;
      if (cfg.provider === "anthropic") await this._streamAnthropic(cfg, system, messages, maxTokens, wrappedOnToken);
      else await this._streamOpenAI(cfg, system, messages, maxTokens, wrappedOnToken);
      if (!full.trim()) throw new Error("Empty response from provider.");
      return full;
    };

    try {
      return await attempt();
    } catch (err) {
      if (!receivedAny && err.retryable) {
        try {
          return await attempt();
        } catch (err2) {
          err2.partialText = full;
          throw err2;
        }
      }
      err.partialText = full;
      throw err;
    }
  },

  async _streamAnthropic(cfg, system, messages, maxTokens, onToken) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages";
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), this.CONNECT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          system,
          stream: true,
          messages: messages.map((m) => ({ role: m.role, content: m.content }))
        })
      });
    } catch (err) {
      throw new Error(err.name === "AbortError" ? "Connection timed out." : "Network request failed — check the base URL and your connection.");
    } finally {
      clearTimeout(connectTimer);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      this._throwFromStatus(res.status, errBody?.error?.message);
    }

    await consumeSSE(
      res,
      (obj) => {
        if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") onToken(obj.delta.text);
      },
      this.IDLE_TIMEOUT_MS,
      controller
    ).catch((err) => {
      if (err.name === "AbortError") throw new Error("Connection stalled — try again.");
      throw err;
    });
  },

  async _streamOpenAI(cfg, system, messages, maxTokens, onToken) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const disablesReasoning = /generativelanguage\.googleapis\.com|api\.x\.ai/i.test(cfg.baseUrl);
    const body = {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: 0.95,
      stream: true,
      messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))]
    };
    if (disablesReasoning) body.reasoning_effort = "none";

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), this.CONNECT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new Error(err.name === "AbortError" ? "Connection timed out." : "Network request failed — check the base URL and your connection.");
    } finally {
      clearTimeout(connectTimer);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      this._throwFromStatus(res.status, errBody?.error?.message);
    }

    await consumeSSE(
      res,
      (obj) => {
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) onToken(delta);
      },
      this.IDLE_TIMEOUT_MS,
      controller
    ).catch((err) => {
      if (err.name === "AbortError") throw new Error("Connection stalled — try again.");
      throw err;
    });
  },

  /* ---------------- best-effort character portrait generation ---------------- */
  async generateImage(prompt) {
    const cfg = this.config();
    if (!cfg) throw new Error("No API configuration found.");
    if (cfg.provider === "anthropic") {
      throw new Error("Image generation isn't available with Anthropic's API.");
    }
    const isGemini = /generativelanguage\.googleapis\.com/i.test(cfg.baseUrl);
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/images/generations";
    const candidateModels = isGemini
      ? ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"]
      : ["gpt-image-1", "dall-e-3"];
    let lastErr;
    for (const model of candidateModels) {
      try {
        const res = await this._fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey },
            body: JSON.stringify({ model, prompt, size: "512x512", n: 1 })
          },
          45000
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = new Error(data?.error?.message || `Request failed (${res.status})`);
          continue;
        }
        const item = data?.data?.[0];
        if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
        if (item?.url) return item.url;
        lastErr = new Error("No image returned.");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Image generation isn't available for this provider.");
  }
};

/* =========================================================================
   MEMORY MANAGER — three layers
   ========================================================================= */
const Memory = {
  MAX_USER_FACTS: 40,
  MAX_CHAR_FACTS: 24,
  LOCAL_WINDOW: 24,
  CONSOLIDATE_EVERY: 8,

  getUserMemory() {
    return Storage.get("userMemory", []);
  },
  addUserFacts(facts) {
    if (!facts || !facts.length) return;
    let mem = this.getUserMemory();
    facts.forEach((f) => {
      const clean = String(f).trim();
      if (clean && !mem.includes(clean)) mem.push(clean);
    });
    if (mem.length > this.MAX_USER_FACTS) mem = mem.slice(mem.length - this.MAX_USER_FACTS);
    Storage.set("userMemory", mem);
  },

  buildUserMemoryBlock() {
    const mem = this.getUserMemory();
    if (!mem.length) return "Nothing known yet.";
    return mem.map((f) => "- " + f).join("\n");
  },

  buildCharacterMemoryBlock(memObj) {
    if (!memObj) return "Summary: This is your first conversation.\nKey facts: none yet.";
    const summary = memObj.summary || "This is your first conversation.";
    const facts = (memObj.facts || []).map((f) => "- " + f).join("\n") || "none yet.";
    return `Summary: ${summary}\nKey facts:\n${facts}`;
  },

  quickExtract(userText) {
    const facts = [];
    const patterns = [
      { re: /\bmy name is ([a-zA-Z' -]{2,30})/i, tmpl: (m) => `The user's name is ${m[1].trim()}.` },
      { re: /\bi'?m called ([a-zA-Z' -]{2,30})/i, tmpl: (m) => `The user goes by ${m[1].trim()}.` },
      { re: /\bi live in ([a-zA-Z' ,-]{2,40})/i, tmpl: (m) => `The user lives in ${m[1].trim()}.` },
      { re: /\bi work as (an?|a) ([a-zA-Z' -]{2,40})/i, tmpl: (m) => `The user works as ${m[1]} ${m[2].trim()}.` },
      { re: /\bi really like ([a-zA-Z' -]{2,40})/i, tmpl: (m) => `The user likes ${m[1].trim()}.` },
      { re: /\bi hate ([a-zA-Z' -]{2,40})/i, tmpl: (m) => `The user dislikes ${m[1].trim()}.` }
    ];
    patterns.forEach((p) => {
      const m = userText.match(p.re);
      if (m) facts.push(p.tmpl(m));
    });
    return facts;
  },

  async consolidate(recentMessages, existingCharMemory) {
    const transcript = recentMessages.map((m) => `${m.role === "user" ? "User" : "Character"}: ${m.content}`).join("\n");
    const system =
      "You extract durable memory from a roleplay conversation. Respond with ONLY minified JSON, no markdown, no commentary. " +
      'Shape: {"userFacts": string[], "relationshipSummary": string, "characterFacts": string[]}. ' +
      "userFacts: short standalone factual statements about the real human user worth remembering long-term (empty array if none new). " +
      "relationshipSummary: an updated 1-3 sentence summary of the narrative/relationship so far, written in third person. " +
      "characterFacts: short bullet facts about shared history or events in the story worth remembering (empty array if none new). " +
      "Only include genuinely new, durable information — skip small talk and anything already obvious.";
    const user =
      `EXISTING RELATIONSHIP SUMMARY:\n${existingCharMemory?.summary || "(none yet)"}\n\n` +
      `EXISTING KEY FACTS:\n${(existingCharMemory?.facts || []).join("; ") || "(none yet)"}\n\n` +
      `RECENT CONVERSATION:\n${transcript}`;
    return API.requestJSON({ system, user, maxTokens: 500 });
  }
};

/* =========================================================================
   CHARACTERS
   ========================================================================= */
const Characters = {
  all() {
    return Storage.get("characters", {});
  },
  get(id) {
    return this.all()[id];
  },
  save(character) {
    const all = this.all();
    all[character.id] = character;
    Storage.set("characters", all);
  },
  delete(id) {
    const all = this.all();
    delete all[id];
    Storage.set("characters", all);
  },
  list() {
    return Object.values(this.all()).sort((a, b) => b.createdAt - a.createdAt);
  },

  duplicate(id) {
    const original = this.get(id);
    if (!original) return null;
    const copy = JSON.parse(JSON.stringify(original));
    copy.id = "char_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    copy.name = original.name + " (copy)";
    copy.createdAt = Date.now();
    copy.messages = [];
    copy.turnCounter = 0;
    copy.memory = { summary: "", facts: [] };
    if (copy.greeting) copy.messages.push({ role: "assistant", content: copy.greeting, ts: Date.now() });
    this.save(copy);
    return copy;
  },

  async generate(description, { relationship, traits } = {}) {
    const relLine = relationship ? `Their relationship to the user is: ${relationship}.` : "";
    const traitsLine = traits && traits.length ? `Personality flavor to strongly incorporate: ${traits.join(", ")}.` : "";

    const system =
      "You are a character design assistant for a roleplay chat app. Given a short description (and optionally a relationship " +
      "to the user and personality flavor tags), invent a full, coherent character sheet that reflects all of it naturally. " +
      "Respond with ONLY valid minified JSON, no markdown fences, no commentary. Fields: " +
      'name (string), tagline (string, <=8 words), biography (2-4 sentences), personality (3-5 sentences describing traits, ' +
      "quirks, and emotional tendencies), speechStyle (how they talk: vocabulary, rhythm, verbal tics), background " +
      "(relevant life history that shapes how they act), rules (behavioral constraints and interaction boundaries — " +
      "things this character would never do or say, keeping interactions safe and consensual), greeting (a short, " +
      "in-character opening line the character would say first, fitting their relationship to the user, may use *action* formatting).";

    const userMsg = [description, relLine, traitsLine].filter(Boolean).join("\n");
    const parsed = await API.requestJSON({ system, user: userMsg, maxTokens: 1400 });

    const required = ["name", "tagline", "biography", "personality", "speechStyle", "background", "rules", "greeting"];
    required.forEach((k) => {
      if (!parsed[k]) parsed[k] = "";
    });
    parsed.relationship = relationship || "Stranger";
    parsed.traits = traits || [];
    return parsed;
  },

  createRecord(parsed, sourceDescription) {
    const id = "char_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    return {
      id,
      name: parsed.name || "Unnamed",
      tagline: parsed.tagline || "",
      biography: parsed.biography || "",
      personality: parsed.personality || "",
      speechStyle: parsed.speechStyle || "",
      background: parsed.background || "",
      rules: parsed.rules || "",
      greeting: parsed.greeting || "",
      relationship: parsed.relationship || "Stranger",
      traits: parsed.traits || [],
      sourceDescription: sourceDescription || "",
      color: colorForName(parsed.name || "?"),
      avatarImage: null,
      createdAt: Date.now(),
      messages: [],
      turnCounter: 0,
      memory: { summary: "", facts: [] }
    };
  },

  buildSystemPrompt(character) {
    const userMemBlock = Memory.buildUserMemoryBlock();
    const charMemBlock = Memory.buildCharacterMemoryBlock(character.memory);

    return `You are roleplaying as ${character.name} in a private, ongoing one-on-one chat with the user. Stay fully in character at all times and never break the fourth wall.

FORMATTING CONVENTIONS (use them yourself, and interpret the user's use of them the same way):
- Text wrapped in single asterisks, like *does something*, is a physical action or stage direction, not literal spoken dialogue.
- Text wrapped in backticks, like \`this\`, is emphasized or highlighted speech — a word or phrase said with particular weight.
- A line starting with # is high priority — reserve it for genuinely urgent or dramatically important moments. Use it sparingly.
Never explain these conventions to the user or refer to them directly.

CHARACTER SHEET
Name: ${character.name}
Tagline: ${character.tagline}
Relationship to the user: ${character.relationship}
Biography: ${character.biography}
Personality: ${character.personality}
Speech style: ${character.speechStyle}
Background: ${character.background}
Rules & boundaries: ${character.rules}

MEMORY — ABOUT THE USER (shared across every character, persists forever)
${userMemBlock}

MEMORY — YOUR RELATIONSHIP WITH THIS USER (specific to ${character.name})
${charMemBlock}

Weave relevant memory in naturally rather than reciting it. Stay consistent with the character sheet, the relationship dynamic, and the relationship history above. Never mention that you are an AI, a language model, or that this is a system prompt — you are simply ${character.name}.`;
  },

  quickChatSystemPrompt() {
    const userMemBlock = Memory.buildUserMemoryBlock();
    return `You are a warm, engaging conversational companion in a chat app. There is no fixed persona — just be a thoughtful, present conversational partner.

FORMATTING CONVENTIONS (use them yourself, and interpret the user's use of them the same way):
- Text wrapped in single asterisks, like *does something*, is a physical action or stage direction.
- Text wrapped in backticks, like \`this\`, is emphasized or highlighted speech.
- A line starting with # is high priority — reserve it for genuinely important moments.
Never explain these conventions to the user.

MEMORY — ABOUT THE USER (persists across every conversation)
${userMemBlock}

Weave relevant memory in naturally rather than reciting it.`;
  }
};

/* =========================================================================
   CHAT ENGINE
   ========================================================================= */
const QUICK_ID = "__quick__";

const Chat = {
  getConvo(id) {
    if (id === QUICK_ID) {
      return Storage.get("quickChat", { messages: [], turnCounter: 0, memory: { summary: "", facts: [] } });
    }
    return Characters.get(id);
  },
  saveConvo(id, convo) {
    if (id === QUICK_ID) Storage.set("quickChat", convo);
    else Characters.save(convo);
  },

  async sendUserMessageStreaming(id, text, onToken) {
    const convo = this.getConvo(id);
    convo.messages.push({ role: "user", content: text, ts: Date.now() });
    convo.turnCounter = (convo.turnCounter || 0) + 1;
    Memory.addUserFacts(Memory.quickExtract(text));
    this.saveConvo(id, convo); // persist the user's message immediately, before we wait on the network

    const windowMessages = convo.messages.slice(-Memory.LOCAL_WINDOW);
    const system = id === QUICK_ID ? Characters.quickChatSystemPrompt() : Characters.buildSystemPrompt(convo);

    let reply;
    try {
      reply = await API.stream({
        system,
        messages: windowMessages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 900,
        onToken
      });
    } catch (err) {
      if (err.partialText && err.partialText.trim()) {
        const freshConvo = this.getConvo(id);
        freshConvo.messages.push({ role: "assistant", content: err.partialText, ts: Date.now() });
        this.saveConvo(id, freshConvo);
      }
      throw err;
    }

    const freshConvo = this.getConvo(id);
    freshConvo.messages.push({ role: "assistant", content: reply, ts: Date.now() });
    freshConvo.turnCounter = convo.turnCounter;
    this.saveConvo(id, freshConvo);

    if (freshConvo.turnCounter % Memory.CONSOLIDATE_EVERY === 0) {
      this._consolidateInBackground(id);
    }

    return reply;
  },

  async _consolidateInBackground(id) {
    try {
      const convo = this.getConvo(id);
      const recent = convo.messages.slice(-Memory.LOCAL_WINDOW);
      const result = await Memory.consolidate(recent, convo.memory);

      if (Array.isArray(result.userFacts)) Memory.addUserFacts(result.userFacts);

      const freshConvo = this.getConvo(id);
      freshConvo.memory = freshConvo.memory || { summary: "", facts: [] };
      if (result.relationshipSummary) freshConvo.memory.summary = result.relationshipSummary;
      if (Array.isArray(result.characterFacts) && result.characterFacts.length) {
        let facts = freshConvo.memory.facts || [];
        result.characterFacts.forEach((f) => {
          if (f && !facts.includes(f)) facts.push(f);
        });
        if (facts.length > Memory.MAX_CHAR_FACTS) facts = facts.slice(facts.length - Memory.MAX_CHAR_FACTS);
        freshConvo.memory.facts = facts;
      }
      this.saveConvo(id, freshConvo);
    } catch (e) {
      console.warn("Memory consolidation skipped:", e.message);
    }
  },

  resetConvo(id) {
    const convo = this.getConvo(id);
    convo.messages = [];
    convo.turnCounter = 0;
    convo.memory = { summary: "", facts: [] };
    if (id !== QUICK_ID && convo.greeting) {
      convo.messages.push({ role: "assistant", content: convo.greeting, ts: Date.now() });
    }
    this.saveConvo(id, convo);
  }
};

/* =========================================================================
   BIOMETRIC (WEBAUTHN) LOCAL DEVICE LOCK
   This verifies against the device's own platform authenticator only —
   there is no server, so it's a local gate, not a remote account login.
   ========================================================================= */
const Biometric = {
  async isAvailable() {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  },
  isEnabled() {
    return Storage.get("biometricEnabled", false);
  },
  async enroll() {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "Confidant" },
        user: { id: userId, name: "confidant-user", displayName: "Confidant" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 }
        ],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        timeout: 60000,
        attestation: "none"
      }
    });
    if (!cred) throw new Error("No credential was created.");
    const credIdB64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
    Storage.set("biometricCredId", credIdB64);
    Storage.set("biometricEnabled", true);
  },
  disable() {
    Storage.set("biometricEnabled", false);
    Storage.remove("biometricCredId");
  },
  async verify() {
    const credIdB64 = Storage.get("biometricCredId", null);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const allowCredentials = credIdB64
      ? [{ id: Uint8Array.from(atob(credIdB64), (c) => c.charCodeAt(0)), type: "public-key" }]
      : [];
    const assertion = await navigator.credentials.get({
      publicKey: { challenge, allowCredentials, userVerification: "required", timeout: 60000 }
    });
    if (!assertion) throw new Error("Verification failed.");
    return true;
  }
};

/* =========================================================================
   LONG-PRESS HELPER
   ========================================================================= */
function addPressHandlers(el, { onTap, onLongPress, holdMs = 480 }) {
  let timer = null;
  let fired = false;
  let startX = 0;
  let startY = 0;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };

  el.addEventListener("pointerdown", (e) => {
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      onLongPress();
    }, holdMs);
  });
  el.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) clear();
  });
  el.addEventListener("pointerup", () => {
    const wasFired = fired;
    clear();
    if (!wasFired) onTap();
  });
  el.addEventListener("pointercancel", clear);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* =========================================================================
   UI CONTROLLER
   ========================================================================= */
const UI = {
  activeChatId: null,
  _elCache: {},
  _sheetCharId: null,
  _selectedRelationship: "Stranger",
  _selectedTraits: [],
  _pendingPortrait: null,

  el(id) {
    if (!this._elCache[id]) this._elCache[id] = document.getElementById(id);
    return this._elCache[id];
  },

  showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    this.el(id).classList.add("active");
  },

  async init() {
    this.setupViewportUnit();
    this.wireSetupScreen();
    this.wireHomeScreen();
    this.wireCreateScreen();
    this.wireChatScreen();
    this.wireMemoryScreen();
    this.wireSettingsScreen();
    this.wireSheet();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    window.addEventListener("offline", () => toast("You're offline. Messages won't send until you're back online.", true));

    const biometricSupported = await Biometric.isAvailable();
    if (biometricSupported) {
      this.el("biometric-row").hidden = false;
      this.el("toggle-biometric-lock").checked = Biometric.isEnabled();
    }

    if (biometricSupported && Biometric.isEnabled()) {
      this.showScreen("screen-lock");
      this.tryUnlock();
    } else {
      this.afterUnlock();
    }
  },

  setupViewportUnit() {
    const setVH = () => {
      const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      document.documentElement.style.setProperty("--vh", h * 0.01 + "px");
    };
    setVH();
    window.addEventListener("resize", setVH);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", setVH);
  },

  afterUnlock() {
    if (API.config()) {
      this.showScreen("screen-home");
      this.renderCharacterList();
      this.refreshSettingsInfo();
    } else {
      this.showScreen("screen-setup");
    }
  },

  async tryUnlock() {
    const status = this.el("lock-status");
    status.textContent = "";
    try {
      await Biometric.verify();
      this.afterUnlock();
    } catch (e) {
      status.textContent = "Verification failed or cancelled — try again.";
    }
  },

  /* ---------------- SETUP ---------------- */
  wireSetupScreen() {
    const providerDefaults = {
      anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
      openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
    };
    const hints = {
      anthropic: "Works directly from the browser with your Anthropic API key.",
      openai: "Pick a preset below, or fill in the base URL and model for any other OpenAI‑compatible provider."
    };

    // Presets for the "OpenAI‑compatible" family — pick one, paste the matching
    // key, and the base URL + model are filled in automatically.
    const PRESETS = {
      gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-2.5-flash", note: "Google AI Studio has a genuine free tier — no card required." },
      openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", note: "Requires a prepaid balance — OpenAI has no free API tier." },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/auto", note: "Auto-picks a good model per message. Swap in a specific model id (or openrouter/free) any time." },
      groq: { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", note: "Free tier with generous rate limits; extremely fast responses." },
      mistral: { baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", note: "Has a free tier for lower request volumes." },
      deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", note: "Inexpensive pay-as-you-go pricing." },
      together: { baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", note: "Pay-as-you-go, some free trial credit for new accounts." },
      fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/llama-v3p1-70b-instruct", note: "Pay-as-you-go, fast open-weight model hosting." },
      xai: { baseUrl: "https://api.x.ai/v1", model: "grok-4.3", note: "Paid; xAI sometimes offers free developer credits." },
      custom: { baseUrl: "", model: "", note: "Enter any OpenAI-compatible base URL and model — a local Ollama/LM Studio server works too." }
    };

    let provider = "anthropic";
    const applyProvider = (p) => {
      provider = p;
      document.querySelectorAll("#provider-segmented .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.provider === p));
      this.el("provider-hint").textContent = hints[p];
      this.el("preset-group").hidden = p !== "openai";
      document.querySelectorAll("#preset-chips .chip").forEach((c) => c.classList.remove("active"));
      this.el("preset-note").textContent = "";
      if (p === "anthropic") {
        this.el("input-baseurl").value = providerDefaults.anthropic.baseUrl;
        this.el("input-model").value = providerDefaults.anthropic.model;
      } else {
        this.el("input-baseurl").value = providerDefaults.openai.baseUrl;
        this.el("input-model").value = providerDefaults.openai.model;
      }
    };
    applyProvider("anthropic");

    document.querySelectorAll("#provider-segmented .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyProvider(btn.dataset.provider));
    });

    document.querySelectorAll("#preset-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll("#preset-chips .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        const preset = PRESETS[chip.dataset.preset];
        this.el("input-baseurl").value = preset.baseUrl;
        this.el("input-model").value = preset.model;
        this.el("preset-note").textContent = preset.note;
        if (chip.dataset.preset === "custom") {
          this.el("input-baseurl").focus();
        }
      });
    });

    this.el("btn-toggle-key").addEventListener("click", () => {
      const input = this.el("input-apikey");
      input.type = input.type === "password" ? "text" : "password";
    });

    this.el("btn-validate").addEventListener("click", async () => {
      const apiKey = this.el("input-apikey").value.trim();
      const baseUrl = this.el("input-baseurl").value.trim();
      const model = this.el("input-model").value.trim();
      const status = this.el("setup-status");

      if (!apiKey || !baseUrl || !model) {
        status.textContent = "Fill in every field.";
        status.className = "field-hint setup-note error";
        return;
      }

      const btn = this.el("btn-validate");
      btn.disabled = true;
      btn.textContent = "Connecting…";
      status.textContent = "";
      status.className = "field-hint setup-note";

      try {
        await API.validate({ provider, baseUrl, model, apiKey });
        status.textContent = "Connected.";
        status.className = "field-hint setup-note success";
        setTimeout(() => {
          this.showScreen("screen-home");
          this.renderCharacterList();
          this.refreshSettingsInfo();
        }, 400);
      } catch (err) {
        status.textContent = err.message || "Couldn't connect. Check your key, URL, and model.";
        status.className = "field-hint setup-note error";
      } finally {
        btn.disabled = false;
        btn.textContent = "Connect";
      }
    });
  },

  /* ---------------- HOME ---------------- */
  wireHomeScreen() {
    this.el("btn-open-settings").addEventListener("click", () => {
      this.refreshSettingsInfo();
      this.showScreen("screen-settings");
    });
    this.el("btn-new-character").addEventListener("click", () => {
      this.el("input-char-desc").value = "";
      this.el("character-preview").hidden = true;
      this.el("create-loading").hidden = true;
      this._pendingPortrait = null;
      this.resetChips();
      this.showScreen("screen-create");
    });
    this.el("btn-quick-chat").addEventListener("click", () => this.openChat(QUICK_ID));
  },

  renderCharacterList() {
    const list = Characters.list();
    const container = this.el("character-list");
    const empty = this.el("empty-state");
    container.innerHTML = "";

    if (!list.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    list.forEach((c) => {
      const card = document.createElement("div");
      card.className = "character-card";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");

      const avatar = document.createElement("div");
      avatar.className = "char-avatar";
      renderAvatarInto(avatar, c, false);

      const textWrap = document.createElement("div");
      textWrap.className = "character-card-text";
      textWrap.innerHTML = `<strong>${Format.escapeHtml(c.name)}</strong><span>${Format.escapeHtml(c.tagline || "")}</span>`;

      card.appendChild(avatar);
      card.appendChild(textWrap);
      if (c.relationship && c.relationship !== "Stranger") {
        const badge = document.createElement("span");
        badge.className = "rel-badge";
        badge.textContent = c.relationship;
        card.appendChild(badge);
      }

      addPressHandlers(card, {
        onTap: () => this.openChat(c.id),
        onLongPress: () => this.openSheet(c.id)
      });

      container.appendChild(card);
    });
  },

  /* ---------------- CREATE CHARACTER ---------------- */
  resetChips() {
    this._selectedRelationship = "Stranger";
    this._selectedTraits = [];
    document.querySelectorAll("#relationship-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.rel === "Stranger"));
    document.querySelectorAll("#personality-chips .chip").forEach((c) => c.classList.remove("active"));
    this.el("input-relationship-custom").hidden = true;
    this.el("input-relationship-custom").value = "";
  },

  wireCreateScreen() {
    this.el("btn-create-back").addEventListener("click", () => this.showScreen("screen-home"));

    document.querySelectorAll("#relationship-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll("#relationship-chips .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        const customInput = this.el("input-relationship-custom");
        if (chip.dataset.rel === "__custom") {
          customInput.hidden = false;
          customInput.focus();
          this._selectedRelationship = customInput.value.trim() || "Custom";
        } else {
          customInput.hidden = true;
          this._selectedRelationship = chip.dataset.rel;
        }
      });
    });
    this.el("input-relationship-custom").addEventListener("input", (e) => {
      this._selectedRelationship = e.target.value.trim() || "Custom";
    });

    document.querySelectorAll("#personality-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const trait = chip.dataset.trait;
        const isActive = chip.classList.contains("active");
        if (isActive) {
          chip.classList.remove("active");
          this._selectedTraits = this._selectedTraits.filter((t) => t !== trait);
        } else {
          if (this._selectedTraits.length >= 3) {
            toast("Pick up to 3 traits.", true);
            return;
          }
          chip.classList.add("active");
          this._selectedTraits.push(trait);
        }
      });
    });

    let lastParsed = null;
    let lastDescription = "";

    const generate = async () => {
      const desc = this.el("input-char-desc").value.trim();
      if (!desc) {
        toast("Describe the character first.", true);
        return;
      }
      lastDescription = desc;
      this._pendingPortrait = null;
      this.el("character-preview").hidden = true;
      this.el("create-loading").hidden = false;
      this.el("btn-generate-character").disabled = true;

      try {
        lastParsed = await Characters.generate(desc, { relationship: this._selectedRelationship, traits: this._selectedTraits });
        this.renderCharacterPreview(lastParsed);
        this.el("character-preview").hidden = false;
      } catch (err) {
        toast(err.message || "Couldn't generate that character.", true);
      } finally {
        this.el("create-loading").hidden = true;
        this.el("btn-generate-character").disabled = false;
      }
    };

    this.el("btn-generate-character").addEventListener("click", generate);
    this.el("btn-regenerate-character").addEventListener("click", generate);

    this.el("btn-generate-portrait").addEventListener("click", async () => {
      if (!lastParsed) return;
      const btn = this.el("btn-generate-portrait");
      const loading = this.el("portrait-loading");
      btn.hidden = true;
      loading.hidden = false;
      try {
        const prompt = `Portrait of a character named ${lastParsed.name}. ${lastParsed.biography} Style: warm, painterly, single character portrait, plain background.`;
        const imageUrl = await API.generateImage(prompt);
        this._pendingPortrait = imageUrl;
        const avatarEl = this.el("preview-avatar");
        avatarEl.innerHTML = "";
        avatarEl.style.background = "transparent";
        const img = document.createElement("img");
        img.src = imageUrl;
        avatarEl.appendChild(img);
      } catch (err) {
        toast(err.message || "Couldn't generate a portrait for this provider.", true);
      } finally {
        loading.hidden = true;
        btn.hidden = false;
      }
    });

    this.el("btn-save-character").addEventListener("click", () => {
      if (!lastParsed) return;
      const record = Characters.createRecord(lastParsed, lastDescription);
      if (this._pendingPortrait) record.avatarImage = this._pendingPortrait;
      if (record.greeting) {
        record.messages.push({ role: "assistant", content: record.greeting, ts: Date.now() });
      }
      Characters.save(record);
      this.renderCharacterList();
      this.openChat(record.id);
    });
  },

  renderCharacterPreview(p) {
    const avatarEl = this.el("preview-avatar");
    avatarEl.innerHTML = "";
    avatarEl.style.background = colorForName(p.name);
    avatarEl.textContent = initialForName(p.name);
    this.el("preview-name").textContent = p.name;
    this.el("preview-tagline").textContent = p.tagline;
    this.el("preview-bio").textContent = p.biography;
    this.el("preview-personality").textContent = p.personality;
    this.el("preview-speech").textContent = p.speechStyle;
    this.el("preview-rules").textContent = p.rules;
    this.el("btn-generate-portrait").hidden = false;
    this.el("portrait-loading").hidden = true;
  },

  /* ---------------- CHAT ---------------- */
  wireChatScreen() {
    this.el("btn-chat-back").addEventListener("click", () => {
      this.el("chat-menu").hidden = true;
      this.showScreen("screen-home");
      this.renderCharacterList();
    });

    this.el("btn-chat-menu").addEventListener("click", () => {
      this.el("chat-menu").hidden = !this.el("chat-menu").hidden;
    });
    document.addEventListener("click", (e) => {
      const menu = this.el("chat-menu");
      if (!menu.hidden && !menu.contains(e.target) && e.target.id !== "btn-chat-menu") menu.hidden = true;
    });

    this.el("btn-open-char-info").addEventListener("click", () => this.openMemoryScreen());
    this.el("menu-view-memory").addEventListener("click", () => {
      this.el("chat-menu").hidden = true;
      this.openMemoryScreen();
    });

    this.el("menu-reset-convo").addEventListener("click", () => {
      this.el("chat-menu").hidden = true;
      if (!confirm("Clear this conversation and its memory? This can't be undone.")) return;
      Chat.resetConvo(this.activeChatId);
      this.renderMessages();
      toast("Conversation reset.");
    });

    this.el("menu-delete-character").addEventListener("click", () => {
      this.el("chat-menu").hidden = true;
      if (this.activeChatId === QUICK_ID) {
        toast("Quick Chat can't be deleted.", true);
        return;
      }
      if (!confirm("Delete this character and all memory of them? This can't be undone.")) return;
      Characters.delete(this.activeChatId);
      this.showScreen("screen-home");
      this.renderCharacterList();
    });

    const textarea = this.el("chat-input");
    const sendBtn = this.el("btn-send");

    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    });

    // Prevent the send button from ever taking focus away from the textarea —
    // this is what was closing the mobile keyboard on send.
    sendBtn.addEventListener("pointerdown", (e) => e.preventDefault());

    const submitMessage = async () => {
      const text = textarea.value.trim();
      if (!text || sendBtn.disabled) return;
      textarea.value = "";
      textarea.style.height = "auto";

      this.appendMessageBubble({ role: "user", content: text });
      this.setSending(true);
      this.showTypingDots();

      let bubbleEl = null;
      let latestFull = "";
      let rafPending = false;

      const flush = () => {
        if (bubbleEl) {
          bubbleEl.innerHTML = Format.render(latestFull) + '<span class="stream-cursor"></span>';
          this.scrollChatToBottom();
        }
        rafPending = false;
      };
      const onToken = (token, fullSoFar) => {
        if (!bubbleEl) {
          this.hideTypingDots();
          bubbleEl = this.startStreamingBubble();
        }
        latestFull = fullSoFar;
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(flush);
        }
      };

      try {
        const reply = await Chat.sendUserMessageStreaming(this.activeChatId, text, onToken);
        this.hideTypingDots();
        if (bubbleEl) bubbleEl.innerHTML = Format.render(reply);
        else this.appendMessageBubble({ role: "assistant", content: reply });
      } catch (err) {
        this.hideTypingDots();
        if (err.partialText && err.partialText.trim() && bubbleEl) {
          bubbleEl.innerHTML = Format.render(err.partialText);
          toast("Connection interrupted — response may be incomplete.", true);
        } else {
          if (bubbleEl) bubbleEl.closest(".msg-row")?.remove();
          toast(err.message || "Message failed to send.", true);
        }
      } finally {
        this.setSending(false);
        textarea.focus();
      }
    };

    this.el("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitMessage();
    });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitMessage();
      }
    });
  },

  setSending(isSending) {
    this.el("btn-send").disabled = isSending;
  },

  showTypingDots() {
    this.hideTypingDots();
    const row = document.createElement("div");
    row.className = "msg-row assistant typing-row";
    row.id = "active-typing-row";
    row.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    this.el("chat-messages").appendChild(row);
    this.scrollChatToBottom();
  },
  hideTypingDots() {
    const row = document.getElementById("active-typing-row");
    if (row) row.remove();
  },

  startStreamingBubble() {
    const container = this.el("chat-messages");
    const row = document.createElement("div");
    row.className = "msg-row assistant";

    const isQuick = this.activeChatId === QUICK_ID;
    const convo = isQuick ? null : Chat.getConvo(this.activeChatId);
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    renderAvatarInto(avatar, convo, isQuick);
    row.appendChild(avatar);

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = '<span class="stream-cursor"></span>';
    row.appendChild(bubble);

    container.appendChild(row);
    this.scrollChatToBottom();
    return bubble;
  },

  openChat(id) {
    this.activeChatId = id;
    const convo = Chat.getConvo(id);
    const isQuick = id === QUICK_ID;

    this.el("chat-char-name").textContent = isQuick ? "Quick Chat" : convo.name;
    renderAvatarInto(this.el("chat-avatar"), convo, isQuick);

    this.renderMessages();
    this.showScreen("screen-chat");
    this.scrollChatToBottom();
    setTimeout(() => this.scrollChatToBottom(), 50);
  },

  renderMessages() {
    const convo = Chat.getConvo(this.activeChatId);
    const container = this.el("chat-messages");
    container.innerHTML = "";
    const frag = document.createDocumentFragment();
    (convo.messages || []).forEach((m) => frag.appendChild(this.buildMessageRow(m)));
    container.appendChild(frag);
    this.scrollChatToBottom();
  },

  buildMessageRow(m) {
    const row = document.createElement("div");
    row.className = "msg-row " + m.role;

    if (m.role === "assistant") {
      const isQuick = this.activeChatId === QUICK_ID;
      const convo = isQuick ? null : Chat.getConvo(this.activeChatId);
      const avatar = document.createElement("div");
      avatar.className = "msg-avatar";
      renderAvatarInto(avatar, convo, isQuick);
      row.appendChild(avatar);
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = Format.render(m.content);
    row.appendChild(bubble);
    return row;
  },

  appendMessageBubble(m) {
    const container = this.el("chat-messages");
    container.appendChild(this.buildMessageRow(m));
    this.scrollChatToBottom();
  },

  scrollChatToBottom() {
    const container = this.el("chat-messages");
    container.scrollTop = container.scrollHeight;
  },

  /* ---------------- MEMORY VIEW ---------------- */
  wireMemoryScreen() {
    this.el("btn-memory-back").addEventListener("click", () => this.showScreen("screen-chat"));
  },

  openMemoryScreen() {
    const userList = this.el("memory-user-list");
    const userMem = Memory.getUserMemory();
    userList.innerHTML = "";
    userMem.forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      userList.appendChild(li);
    });
    this.el("memory-user-empty").hidden = userMem.length > 0;

    const convo = Chat.getConvo(this.activeChatId);
    const isQuick = this.activeChatId === QUICK_ID;
    this.el("memory-char-title").textContent = isQuick ? "This conversation" : `Relationship with ${convo.name}`;
    this.el("memory-char-summary").textContent = convo.memory?.summary || "Nothing recorded yet — keep talking and it'll fill in.";

    const factsList = this.el("memory-char-facts");
    factsList.innerHTML = "";
    (convo.memory?.facts || []).forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      factsList.appendChild(li);
    });

    this.showScreen("screen-memory");
  },

  /* ---------------- SETTINGS ---------------- */
  wireSettingsScreen() {
    this.el("btn-settings-back").addEventListener("click", () => this.showScreen("screen-home"));
    this.el("btn-change-key").addEventListener("click", () => this.showScreen("screen-setup"));

    this.el("toggle-biometric-lock").addEventListener("change", async (e) => {
      const checked = e.target.checked;
      if (checked) {
        try {
          await Biometric.enroll();
          toast("Biometric lock enabled.");
        } catch (err) {
          e.target.checked = false;
          toast("Couldn't set up biometrics — " + (err.message || "cancelled"), true);
        }
      } else {
        Biometric.disable();
        toast("Biometric lock disabled.");
      }
    });

    this.el("btn-wipe-all").addEventListener("click", () => {
      if (!confirm("Erase your API key, every character, and all memory from this device? This can't be undone.")) return;
      Storage.wipeAll();
      location.reload();
    });
  },

  refreshSettingsInfo() {
    const cfg = API.config();
    const info = this.el("settings-connection-info");
    if (!cfg) {
      info.textContent = "Not connected.";
      return;
    }
    const label = cfg.provider === "anthropic" ? "Anthropic" : "OpenAI‑compatible";
    info.textContent = `${label} · ${cfg.model} · ${cfg.baseUrl}`;
  },

  /* ---------------- BOTTOM SHEET (long-press character actions) ---------------- */
  wireSheet() {
    const overlay = this.el("sheet-overlay");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeSheet();
    });
    this.el("sheet-cancel").addEventListener("click", () => this.closeSheet());

    this.el("sheet-open").addEventListener("click", () => {
      const id = this._sheetCharId;
      this.closeSheet();
      this.openChat(id);
    });

    this.el("sheet-rename").addEventListener("click", () => {
      const character = Characters.get(this._sheetCharId);
      if (!character) return;
      const name = prompt("Rename character", character.name);
      if (name && name.trim()) {
        character.name = name.trim();
        Characters.save(character);
        this.renderCharacterList();
      }
      this.closeSheet();
    });

    this.el("sheet-portrait").addEventListener("click", async () => {
      const character = Characters.get(this._sheetCharId);
      if (!character) return;
      const btn = this.el("sheet-portrait");
      btn.textContent = "🎨 Painting…";
      btn.disabled = true;
      try {
        const prompt = `Portrait of a character named ${character.name}. ${character.biography} Style: warm, painterly, single character portrait, plain background.`;
        const imageUrl = await API.generateImage(prompt);
        character.avatarImage = imageUrl;
        Characters.save(character);
        this.renderCharacterList();
        toast("Portrait generated.");
      } catch (err) {
        toast(err.message || "Couldn't generate a portrait for this provider.", true);
      } finally {
        btn.textContent = "🎨 Generate portrait";
        btn.disabled = false;
        this.closeSheet();
      }
    });

    this.el("sheet-duplicate").addEventListener("click", () => {
      const copy = Characters.duplicate(this._sheetCharId);
      if (copy) {
        this.renderCharacterList();
        toast(`Duplicated as "${copy.name}".`);
      }
      this.closeSheet();
    });

    this.el("sheet-reset").addEventListener("click", () => {
      if (!confirm("Reset memory and conversation for this character?")) {
        this.closeSheet();
        return;
      }
      Chat.resetConvo(this._sheetCharId);
      toast("Memory reset.");
      this.closeSheet();
    });

    this.el("sheet-delete").addEventListener("click", () => {
      if (!confirm("Delete this character and all memory of them? This can't be undone.")) {
        this.closeSheet();
        return;
      }
      const wasOpen = this.activeChatId === this._sheetCharId;
      Characters.delete(this._sheetCharId);
      this.renderCharacterList();
      if (wasOpen) this.showScreen("screen-home");
      this.closeSheet();
    });
  },

  openSheet(characterId) {
    const character = Characters.get(characterId);
    if (!character) return;
    this._sheetCharId = characterId;
    renderAvatarInto(this.el("sheet-avatar"), character, false);
    this.el("sheet-name").textContent = character.name;
    this.el("sheet-overlay").hidden = false;
  },
  closeSheet() {
    this.el("sheet-overlay").hidden = true;
    this._sheetCharId = null;
  }
};

document.addEventListener("DOMContentLoaded", () => UI.init());
