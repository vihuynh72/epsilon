"use strict";
// Shared by / and /app. Every server string is untrusted: textContent only.
(() => {
  const $ = (id) => document.getElementById(id);
  const feed = $("feed"), latestText = $("latest-text"), form = $("config-form");
  let events = []; // newest first
  let config = null;
  // A hosted hub is opened as /app?k=KEY. Carry the key on every call and on links between our pages.
  const K = new URLSearchParams(location.search).get("k");
  const withKey = (url) => (K ? url + "?k=" + encodeURIComponent(K) : url);
  if (K) document.querySelectorAll('a[href="/"], a[href="/app"], a[href="/sounds"], a[href="/setup"]').forEach((a) => { a.href = withKey(a.getAttribute("href")); });

  // never show a whole phone number on screen: these pages get shared and filmed
  const who = (to) => (/^[+\d][\d ()-]{6,}$/.test(to) ? "the number ending " + to.replace(/\D/g, "").slice(-2) : to);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function when(t) {
    const d = new Date(t * 1000);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + time;
  }

  const cap1 = (g) => g.charAt(0).toUpperCase() + g.slice(1);

  /** The small line under a bubble: the time and, when it matters, what happened. [text, isProblem] */
  function statusOf(e) {
    if (e.action === "call") return [when(e.time) + " · Emergency, sent with a voice message", false];
    if (e.delivery === "sent") return [when(e.time) + " · Delivered", false];
    if (e.delivery === "failed") return [when(e.time) + " · Not delivered", true];
    return [when(e.time), false];
  }

  /** Everything else about a message, shown only when the small line is opened. */
  function detailOf(e) {
    const how = { gesture: "by gesture", taps: "by taps", sound: "by sound", button: "by a test button" }[e.via];
    const parts = [cap1(e.gesture) + (how ? " " + how : "")];
    if (typeof e.confidence === "number") parts.push(Math.round(e.confidence * 100) + "% match");
    if (e.delivery === "sent" && e.to) parts.push("texted to " + who(e.to));
    if (e.reason) parts.push(e.reason);
    if (e.by) parts.push((e.by === "model" ? "Decided by Gemini" : "Decided by the fixed rules") + (typeof e.ms === "number" ? " in " + (e.ms / 1000).toFixed(1) + " s" : ""));
    return parts.join(" · ");
  }

  // One message. A sent message is a bubble holding only the sentence. A held one is a quiet note, not a bubble.
  function row(e) {
    const held = e.action === "held";
    const li = el("li", "chat" + (e.action === "call" ? " is-urgent" : "") + (held ? " is-held" : ""));
    li.dataset.id = e.id;
    if (!held) li.append(el("p", "bubble", e.text));
    if (!held && typeof e.audio === "string" && e.audio.startsWith("/audio/")) {
      const a = el("audio");
      a.controls = true;
      a.preload = "none";
      a.src = e.audio;
      a.setAttribute("aria-label", "Voice message");
      li.append(a);
    }
    const [label, bad] = held ? ["Held back: " + cap1(e.gesture) + " · " + when(e.time), false] : statusOf(e);
    const more = el("details", "chat-more");
    more.append(el("summary", bad ? "warn" : "", label), el("p", null, detailOf(e)));
    li.append(more);
    return li;
  }

  function showLatest(animate) {
    if (!latestText) return;
    const e = events[0];
    latestText.textContent = e ? e.text : "No messages yet. Send a test from the messages page.";
    $("latest-meta").textContent = e ? when(e.time) + (e.to ? " · to " + who(e.to) : "") : "";
    if (animate) replay(latestText);
  }

  function replay(n) {
    n.classList.remove("is-new");
    void n.offsetWidth; // restart the entry animation
    n.classList.add("is-new");
  }

  function renderAll() {
    if (feed) {
      feed.replaceChildren(...events.slice().reverse().map(row)); // a chat reads downwards: newest last
      $("feed-empty").hidden = events.length > 0;
      feed.hidden = events.length === 0;
      requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; }); // after layout, or the height is stale
    }
    showLatest(false);
  }

  // Live event: new ids go on top with the entry motion; a known id (a later update) is replaced in place.
  function upsert(e) {
    if (!e || typeof e.id !== "number") return;
    const i = events.findIndex((x) => x.id === e.id);
    if (i >= 0) {
      events[i] = e;
      const old = feed && feed.querySelector('[data-id="' + e.id + '"]');
      if (old) old.replaceWith(row(e));
      showLatest(false);
      return;
    }
    events.unshift(e);
    events.sort((a, b) => b.id - a.id);
    events = events.slice(0, 100);
    if (feed && events[0] === e) {
      const n = row(e);
      n.classList.add("is-new");
      feed.append(n); // append, not re-render, so a playing message keeps playing
      while (feed.children.length > events.length) feed.firstElementChild.remove();
      $("feed-empty").hidden = true;
      feed.hidden = false;
      feed.scrollTop = feed.scrollHeight;
    } else if (feed) {
      renderAll();
    }
    showLatest(events[0] === e);
  }

  async function loadState(first) {
    try {
      const r = await fetch(withKey("/api/state"), { cache: "no-store" });
      const s = await r.json();
      const seen = new Map(events.map((e) => [e.id, e]));
      (s.events || []).forEach((e) => seen.set(e.id, e));
      events = [...seen.values()].sort((a, b) => b.id - a.id).slice(0, 100);
      renderAll();
      if (first && s.config) showConfig(Object.assign({ urgent: s.urgent || [] }, s.config));
    } catch (err) {
      /* the stream will retry; the page keeps what it has */
    }
  }

  function setLive(on) {
    const s = $("live-status");
    if (!s) return;
    s.dataset.live = on;
    $("live-label").textContent = on ? "Live" : "Reconnecting…";
  }

  function connect() {
    const es = new EventSource(withKey("/events"));
    let opened = false;
    es.onopen = () => {
      setLive(true);
      if (opened) loadState(false); // catch up on anything missed while away
      opened = true;
    };
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      try { upsert(JSON.parse(m.data)); } catch (err) { /* ignore a bad line */ }
    };
  }

  async function post(url, body) {
    try {
      const r = await fetch(withKey(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok !== false) return { data };
      return { error: data.error || "The hub said no (" + r.status + ")." };
    } catch (err) {
      return { error: "Could not reach the hub." };
    }
  }

  // Set up: one row per word, holding everything about it: the sentence the parent receives,
  // whether it is an emergency, and a button to try it.
  const cap = cap1;

  function addWord(g, sentence, urgent) {
    const li = el("li", "word");
    li.dataset.word = g;
    const box = el("input", "w-urgent");
    box.type = "checkbox";
    box.checked = urgent;
    const lab = el("label", "check");
    lab.append(box, el("span", null, "Emergency"));
    const head = el("div", "word-head");
    head.append(el("span", "word-name", cap(g)), lab);
    const input = el("input", "w-sentence");
    input.value = sentence;
    input.autocomplete = "off";
    input.placeholder = "The sentence you receive";
    input.setAttribute("aria-label", "Sentence you receive for " + g);
    const tryBtn = el("button", "btn", "Try it");
    tryBtn.type = "button";
    tryBtn.setAttribute("aria-label", "Try " + g);
    tryBtn.onclick = () => tryWord(tryBtn, g);
    const rm = el("button", "btn-quiet", "Remove");
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove " + g);
    rm.onclick = () => li.remove();
    const foot = el("div", "word-foot");
    foot.append(tryBtn, rm);
    li.append(head, input, foot);
    $("words").append(li);
    return li;
  }

  function showConfig(c) {
    config = c;
    if (!form) return;
    $("cfg-child").value = c.child || "";
    $("cfg-contact").value = c.contact || "";
    $("words").replaceChildren();
    const names = Object.keys(c.phrases || {});
    names.forEach((g) => addWord(g, c.phrases[g], (c.urgent || []).includes(g)));
    const d = $("test-doubtful");
    d.disabled = names.length === 0;
    d.onclick = () => sendTest(d, names[0], 0.4);
  }

  async function sendTest(btn, gesture, confidence) {
    btn.disabled = true;
    $("test-error").textContent = "";
    const res = await post("/gesture", { gesture, confidence, via: "button" });
    btn.disabled = false;
    if (res.error) { $("test-error").textContent = res.error; return; }
    const e = res.data.event;
    upsert(e); // on the Messages page this shows it even if the stream is down; dedupe by id
    if ($("try-status")) {
      $("try-status").textContent = e.action === "held" ? "Held back: " + (e.reason || "nothing was sent.")
        : (e.action === "call" ? "Sent as an emergency." : "Sent.") + " Open Messages to see it.";
    }
  }

  let saveTimer;
  /** Save everything in Set up. True when the hub accepted it. */
  async function saveConfig() {
    const save = $("save"), err = $("save-error");
    const phrases = {}, urgent = [];
    form.querySelectorAll(".word").forEach((li) => {
      phrases[li.dataset.word] = li.querySelector(".w-sentence").value.trim();
      if (li.querySelector(".w-urgent").checked) urgent.push(li.dataset.word);
    });
    clearTimeout(saveTimer);
    save.disabled = true;
    save.dataset.state = "loading";
    save.textContent = "Saving…";
    err.textContent = "";
    const res = await post("/api/config", {
      child: $("cfg-child").value.trim(), contact: $("cfg-contact").value.trim(), phrases, urgent,
    });
    save.disabled = false;
    if (res.error) {
      save.dataset.state = "error";
      save.textContent = "Save";
      err.textContent = res.error;
      return false;
    }
    showConfig(res.data);
    save.dataset.state = "saved";
    save.textContent = "Saved";
    saveTimer = setTimeout(() => { save.textContent = "Save"; delete save.dataset.state; }, 2000);
    return true;
  }

  /** Try a word exactly as it is on screen: save first, then act as if the band sent it. */
  async function tryWord(btn, g) {
    btn.disabled = true;
    if (await saveConfig()) await sendTest(btn, g, 0.95);
    btn.disabled = false;
  }

  if (form) {
    form.onsubmit = (ev) => { ev.preventDefault(); saveConfig(); };
    const add = () => {
      const box = $("new-word"), name = box.value.trim().toLowerCase();
      const taken = [...form.querySelectorAll(".word")].some((li) => li.dataset.word === name);
      $("save-error").textContent = !name || name.length > 40 ? "Type a word of 1 to 40 letters first."
        : taken ? "That word is already in the list." : "";
      if (!name || name.length > 40 || taken) return box.focus();
      box.value = "";
      addWord(name, "", false).querySelector(".w-sentence").focus();
    };
    $("add-row").onclick = add;
    $("new-word").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
  }

  // Set up: show which services this hub can really use, and let a person prove the decision model answers.
  function showHealth(h) {
    const box = $("health");
    if (!box || !h || !h.ok) return;
    const line = (on, yes, no) => {
      const p = el("p", "health-line");
      p.append(el("span", "health-dot" + (on ? " is-on" : ""), ""), el("span", null, on ? yes : no));
      return p;
    };
    box.replaceChildren(
      line(h.gemini, "Gemini is deciding (" + h.model + "). It decided " + h.by_model + " of the last " + h.decided + " messages.", "Gemini is off. The fixed rules decide."),
      line(h.voice, "ElevenLabs makes the voice message for emergencies.", "No ElevenLabs key. Emergencies have no voice message."),
      line(h.texting, "This computer sends the iMessage.", "This computer does not send texts itself. The relay laptop does."),
      line(h.deepgram, "Deepgram can write down what it hears on the Sounds page.", "No Deepgram key."),
      line(h.calls, "Phone calls are on.", "Phone calls are off (no phone service connected)."),
    );
    const c = h.check;
    if (c) $("health-result").textContent = c.ok
      ? "Gemini answered in " + (c.ms / 1000).toFixed(1) + " s: " + c.action + ". " + (c.reason || "")
      : "Gemini did not answer (" + (c.ms / 1000).toFixed(1) + " s). The fixed rules would decide instead.";
  }
  if ($("health")) {
    fetch(withKey("/api/health")).then((r) => r.json()).then(showHealth).catch(() => {});
    $("health-check").onclick = async () => {
      const b = $("health-check");
      b.disabled = true;
      $("health-result").textContent = "Asking Gemini…";
      const res = await post("/api/health", {});
      b.disabled = false;
      if (res.error) $("health-result").textContent = res.error; else showHealth(res.data);
    };
  }

  loadState(true).then(connect);
})();
