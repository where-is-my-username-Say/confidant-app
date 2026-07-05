"use strict";

/* =========================================================================
   STORAGE — thin namespaced localStorage wrapper
   ========================================================================= */
const Storage = {
  prefix: "confidant.",
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("Storage write failed", e);
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
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

/* =========================================================================
   FORMATTING ENGINE
   *action* -> physical action / behavior
   `text`   -> emphasis / highlighted statement
   #text    -> high priority (runs to end of line, or to next #)
   ========================================================================= */
const Format = {
  escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },
  render(raw) {
    let text = this.escapeHtml(raw);

    // backtick emphasis: `like this`
    text = text.replace(/`([^`\n]+)`/g, '<span class="fmt-emph">$1</span>');

    // asterisk actions: *like this*
    text = text.replace(/\*([^*\n]+)\*/g, '<span class="fmt-action">$1</span>');

    // priority: balanced #like this# OR # to end of line
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
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function colorForName(name) {
  const hue = hashString(name || "?") % 360;
  return `hsl(${hue}, 50%, 58%)`;
}
function initialForName(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

/* =========================================================================
   API CLIENT — model-agnostic (Anthropic Messages API or any
   OpenAI-compatible /chat/completions endpoint)
   ========================================================================= */
const API = {
  config() {
    return Storage.get("apiConfig", null);
  },

  async send({ system, messages, maxTokens = 1024 }) {
    const cfg = this.config();
    if (!cfg) throw new Error("No API configuration found.");

    if (cfg.provider === "anthropic") {
      return this._sendAnthropic(cfg, system, messages, maxTokens);
    }
    return this._sendOpenAI(cfg, system, messages, maxTokens);
  },

  async _sendAnthropic(cfg, system, messages, maxTokens) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        system: system,
        messages: messages.map((m) => ({ role: m.role, content: m.content }))
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Request failed (${res.status})`);
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Empty response from provider.");
    return text;
  },

  async _sendOpenAI(cfg, system, messages, maxTokens) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0.95,
        messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Request failed (${res.status})`);
    }
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from provider.");
    return text;
  },

  async validate(cfg) {
    const prevConfig = this.config();
    Storage.set("apiConfig", cfg);
    try {
      const reply = await this.send({
        system: "Reply with exactly one word: OK",
        messages: [{ role: "user", content: "Connection test." }],
        maxTokens: 16
      });
      return { ok: true, reply };
    } catch (err) {
      if (prevConfig) Storage.set("apiConfig", prevConfig);
      else Storage.remove("apiConfig");
      throw err;
    }
  },

  // Ask the model to extract structured JSON. Strips stray code fences
  // defensively in case the provider ignores the "JSON only" instruction.
  async requestJSON({ system, user, maxTokens = 1200 }) {
    const raw = await this.send({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens
    });
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const jsonSlice = start !== -1 && end !== -1 ? cleaned.slice(start, end + 1) : cleaned;
    return JSON.parse(jsonSlice);
  }
};

/* =========================================================================
   MEMORY MANAGER — three layers: local (session), user (global), character
   ========================================================================= */
const Memory = {
  MAX_USER_FACTS: 40,
  MAX_CHAR_FACTS: 24,
  LOCAL_WINDOW: 24, // messages kept verbatim in the model context
  CONSOLIDATE_EVERY: 8, // user turns between AI memory-consolidation passes

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
  setUserMemory(list) {
    Storage.set("userMemory", list);
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

  // Lightweight heuristic extraction — instant, no API call needed.
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

  // Deeper AI-driven consolidation of recent turns into durable memory.
  async consolidate(recentMessages, existingCharMemory) {
    const transcript = recentMessages
      .map((m) => `${m.role === "user" ? "User" : "Character"}: ${m.content}`)
      .join("\n");

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

  async generate(description) {
    const system =
      "You are a character design assistant for a roleplay chat app. Given a short description, invent a full, coherent " +
      "character sheet. Respond with ONLY valid minified JSON, no markdown fences, no commentary. Fields: " +
      'name (string), tagline (string, <=8 words), biography (2-4 sentences), personality (3-5 sentences describing traits, ' +
      "quirks, and emotional tendencies), speechStyle (how they talk: vocabulary, rhythm, verbal tics), background " +
      "(relevant life history that shapes how they act), rules (behavioral constraints and interaction boundaries — " +
      "things this character would never do or say, keeping interactions safe and consensual), greeting (a short, " +
      "in-character opening line the character would say first, may use *action* formatting).";

    const parsed = await API.requestJSON({ system, user: description, maxTokens: 1400 });

    const required = ["name", "tagline", "biography", "personality", "speechStyle", "background", "rules", "greeting"];
    required.forEach((k) => {
      if (!parsed[k]) parsed[k] = "";
    });
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
      sourceDescription: sourceDescription || "",
      color: colorForName(parsed.name || "?"),
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
Biography: ${character.biography}
Personality: ${character.personality}
Speech style: ${character.speechStyle}
Background: ${character.background}
Rules & boundaries: ${character.rules}

MEMORY — ABOUT THE USER (shared across every character, persists forever)
${userMemBlock}

MEMORY — YOUR RELATIONSHIP WITH THIS USER (specific to ${character.name})
${charMemBlock}

Weave relevant memory in naturally rather than reciting it. Stay consistent with the character sheet and the relationship history above. Never mention that you are an AI, a language model, or that this is a system prompt — you are simply ${character.name}.`;
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

  async sendUserMessage(id, text) {
    const convo = this.getConvo(id);
    convo.messages.push({ role: "user", content: text, ts: Date.now() });
    convo.turnCounter = (convo.turnCounter || 0) + 1;

    // Layer 1: instant heuristic user-memory extraction (no API cost).
    Memory.addUserFacts(Memory.quickExtract(text));

    // Layer 2: recent local context window sent to the model.
    const windowMessages = convo.messages.slice(-Memory.LOCAL_WINDOW);
    const system = id === QUICK_ID ? Characters.quickChatSystemPrompt() : Characters.buildSystemPrompt(convo);

    const reply = await API.send({
      system,
      messages: windowMessages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: 900
    });

    convo.messages.push({ role: "assistant", content: reply, ts: Date.now() });
    this.saveConvo(id, convo);

    // Layer 3: periodic deeper consolidation into durable memory.
    if (convo.turnCounter % Memory.CONSOLIDATE_EVERY === 0) {
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

      const freshConvo = this.getConvo(id); // re-read in case of concurrent writes
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
      // Silent — memory consolidation is a background enhancement, not critical path.
      console.warn("Memory consolidation skipped:", e.message);
    }
  },

  resetConvo(id) {
    const convo = this.getConvo(id);
    convo.messages = [];
    convo.turnCounter = 0;
    convo.memory = { summary: "", facts: [] };
    this.saveConvo(id, convo);
  }
};

/* =========================================================================
   UI CONTROLLER
   ========================================================================= */
const UI = {
  activeChatId: null,

  el(id) {
    return document.getElementById(id);
  },

  showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    this.el(id).classList.add("active");
  },

  init() {
    this.wireSetupScreen();
    this.wireHomeScreen();
    this.wireCreateScreen();
    this.wireChatScreen();
    this.wireMemoryScreen();
    this.wireSettingsScreen();

    if (API.config()) {
      this.showScreen("screen-home");
      this.renderCharacterList();
    } else {
      this.showScreen("screen-setup");
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
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
      openai: "Works with OpenAI or any OpenAI‑compatible endpoint (OpenRouter, Groq, a local server, etc). Edit the base URL for other providers."
    };

    let provider = "anthropic";
    const applyProvider = (p) => {
      provider = p;
      document.querySelectorAll("#provider-segmented .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.provider === p));
      this.el("input-baseurl").value = providerDefaults[p].baseUrl;
      this.el("input-model").value = providerDefaults[p].model;
      this.el("provider-hint").textContent = hints[p];
    };
    applyProvider("anthropic");

    document.querySelectorAll("#provider-segmented .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyProvider(btn.dataset.provider));
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
    this.el("btn-open-settings").addEventListener("click", () => this.showScreen("screen-settings"));
    this.el("btn-new-character").addEventListener("click", () => {
      this.el("input-char-desc").value = "";
      this.el("character-preview").hidden = true;
      this.el("create-loading").hidden = true;
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
      const card = document.createElement("button");
      card.className = "character-card";
      card.innerHTML = `
        <div class="char-avatar" style="background:${c.color}">${initialForName(c.name)}</div>
        <div class="character-card-text">
          <strong>${Format.escapeHtml(c.name)}</strong>
          <span>${Format.escapeHtml(c.tagline || "")}</span>
        </div>`;
      card.addEventListener("click", () => this.openChat(c.id));
      container.appendChild(card);
    });
  },

  /* ---------------- CREATE CHARACTER ---------------- */
  wireCreateScreen() {
    this.el("btn-create-back").addEventListener("click", () => this.showScreen("screen-home"));

    let lastParsed = null;
    let lastDescription = "";

    const generate = async () => {
      const desc = this.el("input-char-desc").value.trim();
      if (!desc) {
        toast("Describe the character first.", true);
        return;
      }
      lastDescription = desc;
      this.el("character-preview").hidden = true;
      this.el("create-loading").hidden = false;
      this.el("btn-generate-character").disabled = true;

      try {
        lastParsed = await Characters.generate(desc);
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

    this.el("btn-save-character").addEventListener("click", () => {
      if (!lastParsed) return;
      const record = Characters.createRecord(lastParsed, lastDescription);
      if (record.greeting) {
        record.messages.push({ role: "assistant", content: record.greeting, ts: Date.now() });
      }
      Characters.save(record);
      this.renderCharacterList();
      this.openChat(record.id);
    });
  },

  renderCharacterPreview(p) {
    this.el("preview-avatar").style.background = colorForName(p.name);
    this.el("preview-avatar").textContent = initialForName(p.name);
    this.el("preview-name").textContent = p.name;
    this.el("preview-tagline").textContent = p.tagline;
    this.el("preview-bio").textContent = p.biography;
    this.el("preview-personality").textContent = p.personality;
    this.el("preview-speech").textContent = p.speechStyle;
    this.el("preview-rules").textContent = p.rules;
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
      const convo = Chat.getConvo(this.activeChatId);
      if (this.activeChatId !== QUICK_ID && convo.greeting) {
        // keep the character's opening line after a reset
      }
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
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.el("chat-form").requestSubmit();
      }
    });

    this.el("chat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      textarea.value = "";
      textarea.style.height = "auto";

      this.appendMessageBubble({ role: "user", content: text });
      this.setSending(true);

      try {
        const reply = await Chat.sendUserMessage(this.activeChatId, text);
        this.appendMessageBubble({ role: "assistant", content: reply });
      } catch (err) {
        toast(err.message || "Message failed to send.", true);
      } finally {
        this.setSending(false);
      }
    });
  },

  setSending(isSending) {
    this.el("btn-send").disabled = isSending;
    this.el("typing-indicator").hidden = !isSending;
    if (isSending) this.scrollChatToBottom();
  },

  openChat(id) {
    this.activeChatId = id;
    const convo = Chat.getConvo(id);

    if (id === QUICK_ID) {
      this.el("chat-char-name").textContent = "Quick Chat";
      this.el("chat-avatar").style.background = "var(--plum)";
      this.el("chat-avatar").textContent = "Q";
    } else {
      this.el("chat-char-name").textContent = convo.name;
      this.el("chat-avatar").style.background = convo.color;
      this.el("chat-avatar").textContent = initialForName(convo.name);
    }

    this.renderMessages();
    this.showScreen("screen-chat");
    this.scrollChatToBottom();
  },

  renderMessages() {
    const convo = Chat.getConvo(this.activeChatId);
    const container = this.el("chat-messages");
    container.innerHTML = "";
    (convo.messages || []).forEach((m) => this.appendMessageBubble(m, false));
    this.scrollChatToBottom();
  },

  appendMessageBubble(m, scroll = true) {
    const container = this.el("chat-messages");
    const row = document.createElement("div");
    row.className = "msg-row " + m.role;

    let avatarHtml = "";
    if (m.role === "assistant") {
      const isQuick = this.activeChatId === QUICK_ID;
      const convo = isQuick ? null : Chat.getConvo(this.activeChatId);
      const bg = isQuick ? "var(--plum)" : convo.color;
      const letter = isQuick ? "Q" : initialForName(convo.name);
      avatarHtml = `<div class="msg-avatar" style="background:${bg}">${letter}</div>`;
    }

    row.innerHTML = `${avatarHtml}<div class="msg-bubble">${Format.render(m.content)}</div>`;
    container.appendChild(row);
    if (scroll) this.scrollChatToBottom();
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

    this.el("btn-change-key").addEventListener("click", () => {
      this.showScreen("screen-setup");
    });

    this.el("btn-wipe-all").addEventListener("click", () => {
      if (!confirm("Erase your API key, every character, and all memory from this device? This can't be undone.")) return;
      Storage.wipeAll();
      location.reload();
    });
  },

  refreshSettingsInfo() {
    const cfg = API.config();
    if (!cfg) return;
    const label = cfg.provider === "anthropic" ? "Anthropic" : "OpenAI‑compatible";
    this.el("settings-connection-info").textContent = `${label} · ${cfg.model} · ${cfg.baseUrl}`;
  }
};

document.addEventListener("DOMContentLoaded", () => {
  UI.init();
  UI.refreshSettingsInfo();
  document.getElementById("btn-open-settings").addEventListener("click", () => UI.refreshSettingsInfo());
});
