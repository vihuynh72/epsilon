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
  if (K) document.querySelectorAll('a[href="/"], a[href="/app"], a[href="/sounds"]').forEach((a) => { a.href = withKey(a.getAttribute("href")); });

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

  function statusOf(e) {
    if (e.action === "held") return ["Held back" + (e.reason ? ": " + e.reason : ""), false];
    // when the decision model chose, show its own one-line reason: this is the decision log
    const why = e.by === "model" && e.reason ? " · Why: " + e.reason : "";
    if (e.action === "call") return ["Urgent voice message" + why, false];
    if (e.delivery === "sent") return [(e.to ? "Texted to " + who(e.to) : "Texted") + why, false];
    if (e.delivery === "failed") return ["Could not send" + why, true];
    return ["Recorded here" + why, false];
  }

  function row(e) {
    const li = el("li", "msg" + (e.action === "call" ? " is-urgent" : ""));
    li.dataset.id = e.id;
    li.append(el("p", "msg-text", e.text));
    const meta = el("p", "msg-meta");
    const how = { gesture: "by gesture", taps: "by taps", sound: "by sound", button: "by button" }[e.via];
    const parts = [when(e.time), how ? e.gesture + " " + how : e.gesture];
    if (typeof e.confidence === "number") parts.push(Math.round(e.confidence * 100) + "%");
    const [label, bad] = statusOf(e);
    meta.append(parts.join(" · ") + " · ", el("span", bad ? "warn" : "", label));
    li.append(meta);
    if (typeof e.audio === "string" && e.audio.startsWith("/audio/")) {
      const a = el("audio");
      a.controls = true;
      a.preload = "none";
      a.src = e.audio;
      li.append(a);
    }
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
      feed.replaceChildren(...events.map(row));
      $("feed-empty").hidden = events.length > 0;
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
      feed.prepend(n); // prepend, not re-render, so a playing message keeps playing
      while (feed.children.length > events.length) feed.lastElementChild.remove();
      $("feed-empty").hidden = true;
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
      if (first && s.config) showConfig(s.config);
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

  // Settings
  function field(label, value, cls) {
    const l = el("label", "field", label);
    const i = el("input", cls);
    i.value = value;
    i.autocomplete = "off";
    l.append(i);
    return l;
  }

  function addRow(g, p) {
    const r = el("div", "phrase-row");
    r.append(field("Gesture", g, "p-gesture"), field("Sentence", p, "p-sentence"));
    $("phrase-rows").append(r);
    return r;
  }

  function showConfig(c) {
    config = c;
    if (form) {
      $("cfg-child").value = c.child || "";
      $("cfg-contact").value = c.contact || "";
      $("phrase-rows").replaceChildren();
      Object.entries(c.phrases || {}).forEach(([g, p]) => addRow(g, p));
      $("urgent-rows").replaceChildren();
      Object.keys(c.phrases || {}).forEach((g) => {
        const box = el("input");
        box.type = "checkbox";
        box.value = g;
        box.checked = (c.urgent || []).includes(g);
        const lab = el("label", "check");
        lab.append(box, el("span", null, g.charAt(0).toUpperCase() + g.slice(1)));
        $("urgent-rows").append(lab);
      });
    }
    showTests();
  }

  function showTests() {
    const box = $("tests");
    if (!box) return;
    const names = Object.keys((config && config.phrases) || {});
    box.replaceChildren(...names.map((g) => {
      const b = el("button", "btn", g);
      b.type = "button";
      b.onclick = () => sendTest(b, g, 0.95);
      return b;
    }));
    const d = $("test-doubtful");
    d.disabled = names.length === 0;
    d.onclick = () => sendTest(d, names[0], 0.4);
  }

  async function sendTest(btn, gesture, confidence) {
    btn.disabled = true;
    $("test-error").textContent = "";
    const res = await post("/gesture", { gesture, confidence });
    btn.disabled = false;
    if (res.error) $("test-error").textContent = res.error;
    else upsert(res.data.event); // shows it even if the stream is down; dedupe by id
  }

  if (form) {
    const save = $("save"), err = $("save-error");
    let timer;
    $("add-row").onclick = () => addRow("", "").querySelector("input").focus();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const phrases = {};
      form.querySelectorAll(".phrase-row").forEach((r) => {
        const g = r.querySelector(".p-gesture").value.trim();
        if (g) phrases[g] = r.querySelector(".p-sentence").value.trim();
      });
      clearTimeout(timer);
      save.disabled = true;
      save.dataset.state = "loading";
      save.textContent = "Saving…";
      err.textContent = "";
      const res = await post("/api/config", {
        child: $("cfg-child").value.trim(),
        contact: $("cfg-contact").value.trim(),
        phrases,
        urgent: [...$("urgent-rows").querySelectorAll("input:checked")].map((b) => b.value).filter((g) => g in phrases),
      });
      save.disabled = false;
      if (res.error) {
        save.dataset.state = "error";
        save.textContent = "Save";
        err.textContent = res.error;
        return;
      }
      showConfig(res.data);
      save.dataset.state = "saved";
      save.textContent = "Saved";
      timer = setTimeout(() => { save.textContent = "Save"; delete save.dataset.state; }, 2000);
    };
  }

  loadState(true).then(connect);
})();
