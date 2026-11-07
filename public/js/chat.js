const $ = (id) => document.getElementById(id);
const msgs = $("msgs"), input = $("input"), send = $("send"), status = $("status");

const S = {
  me: "", rooms: [], blocked: new Set(), view: null, counts: {}, unread: {},
  dms: new Map(),                       // lowerName -> {username,last,at}
  rnd: "idle", rInfo: "", rLog: [],     // random chat state
  profile: { gender: "", country: "" },
  roomMs: 20 * 60000, clock: 0,         // room messages kitni der rehte hain / server-client time ka farak
};
let socket, first = true, typingTimer;

/* ───────── helpers ───────── */
function toast(t) {
  const d = $("toast");
  d.textContent = t; d.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (d.hidden = true), 2500);
}
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},60%,38%)`;
}
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const gIcon = (g) => (g === "male" ? "♂" : g === "female" ? "♀" : g === "other" ? "⚧" : "");
const infoText = (i) => [gIcon(i.gender), i.country].filter(Boolean).join(" ");

function scrollDown(force) {
  if (force || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
}
function setComposer(on, ph) {
  input.disabled = send.disabled = !on;
  input.placeholder = ph || "Message likho…";
  if (on && !matchMedia("(max-width:700px)").matches) input.focus();
}
function clearTyping() { $("typing").textContent = ""; clearTimeout(typingTimer); }
function showTyping(t) {
  $("typing").textContent = t;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(clearTyping, 2500);
}
function closeDrawers() { $("side").classList.remove("open"); $("usersPanel").classList.remove("open"); }

/* ───────── message rendering (textContent => XSS safe) ───────── */
function addSys(text) {
  const d = document.createElement("div");
  d.className = "sys";
  d.textContent = text;
  msgs.appendChild(d);
}
function addMsg({ username, text, createdAt, anon }) {
  const mine = username === S.me;
  const box = document.createElement("div");
  box.className = "msg" + (mine ? " mine" : "");
  const who = document.createElement("div");
  who.className = "who";
  who.style.color = anon ? "#6b7280" : colorFor(username);
  who.textContent = mine ? "You" : anon ? "Stranger" : username;
  if (!mine && !anon) {
    who.classList.add("click");
    who.onclick = (e) => openMenu(e, username, { where: S.view.type === "dm" ? "dm" : "room", text });
  }
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = text;
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = fmtTime(createdAt || Date.now());
  if (S.view?.type === "room") box.dataset.ts = new Date(createdAt || Date.now()).getTime(); // auto-clear ke liye
  box.append(who, t, time);
  msgs.appendChild(box);
}
const isBlocked = (name) => S.blocked.has(String(name).toLowerCase());

/* ───────── sidebar lists ───────── */
function renderRooms() {
  const ul = $("rooms");
  ul.textContent = "";
  for (const r of S.rooms) {
    const li = document.createElement("li");
    li.className = "item" + (S.view?.type === "room" && S.view.id === r.id ? " active" : "");
    const n = document.createElement("span");
    n.textContent = "# " + r.name;
    const c = document.createElement("small");
    c.textContent = S.counts[r.id] || 0;
    li.append(n, c);
    li.onclick = () => switchView({ type: "room", id: r.id, name: r.name });
    ul.appendChild(li);
  }
  $("randomBtn").classList.toggle("on", S.view?.type === "random");
}
function renderDms() {
  const ul = $("dms");
  ul.textContent = "";
  const list = [...S.dms.entries()].sort((a, b) => new Date(b[1].at) - new Date(a[1].at));
  if (!list.length) { const e = document.createElement("li"); e.className = "empty"; e.textContent = "Kisi user par click karke message karo."; ul.appendChild(e); }
  for (const [low, d] of list) {
    const li = document.createElement("li");
    li.className = "item" + (S.view?.type === "dm" && S.view.id === low ? " active" : "");
    const n = document.createElement("span");
    n.textContent = "@ " + d.username;
    li.appendChild(n);
    if (S.unread[low] > 0) { const b = document.createElement("span"); b.className = "badge"; b.textContent = S.unread[low]; li.appendChild(b); }
    li.onclick = () => openDm(d.username);
    ul.appendChild(li);
  }
}
function renderUsers(list) {
  $("ucount").textContent = list.length;
  const ul = $("users");
  ul.textContent = "";
  for (const u of list.sort((a, b) => a.username.localeCompare(b.username))) {
    const li = document.createElement("li");
    const n = document.createElement("span");
    const mine = u.username === S.me;
    n.textContent = mine ? `${u.username} (You)` : u.username;
    const s = document.createElement("small");
    s.textContent = infoText(u);
    li.append(n, s);
    if (mine) li.className = "me";
    else li.onclick = (e) => openMenu(e, u.username, { where: "room" });
    ul.appendChild(li);
  }
}

/* ───────── views ───────── */
function switchView(v) {
  S.view = v;
  closeDrawers();
  msgs.textContent = "";
  clearTyping();
  const isRoom = v.type === "room", isRandom = v.type === "random";
  $("usersPanel").hidden = !isRoom;
  $("usersToggle").hidden = !isRoom;
  $("randomBar").hidden = !isRandom;
  $("roomNote").hidden = !isRoom;
  $("randomIntro").hidden = true;
  msgs.hidden = false;
  $("composer").hidden = false;

  if (isRoom) {
    $("title").textContent = "# " + v.name;
    setComposer(false, "Joining…");
    socket.emit("join_room", v.id, (res) => {
      if (S.view !== v) return;
      if (!res || res.error) return toast(res?.error || "Room load nahi hua.");
      res.history.filter((m) => !isBlocked(m.username)).forEach(addMsg);
      scrollDown(true);
      setComposer(true);
    });
  } else if (v.type === "dm") {
    $("title").textContent = "@ " + v.username;
    S.unread[v.id] = 0;
    setComposer(false, "Loading…");
    socket.emit("dm_history", v.username, (res) => {
      if (S.view !== v) return;
      (res?.history || []).forEach((m) => addMsg({ username: m.from, text: m.text, createdAt: m.createdAt }));
      scrollDown(true);
      setComposer(true);
    });
  } else {
    $("title").textContent = "🎲 Random Chat";
    renderRandom();
  }
  renderRooms();
  renderDms();
}

function openDm(name) {
  const low = name.toLowerCase();
  if (!S.dms.has(low)) S.dms.set(low, { username: name, last: "", at: Date.now() });
  switchView({ type: "dm", id: low, username: name });
}

/* ───────── random chat ───────── */
function rAdd(e) {
  S.rLog.push(e);
  if (S.view?.type === "random") { drawR(e); scrollDown(true); }
}
function drawR(e) {
  if (e.sys) addSys(e.text);
  else addMsg({ username: e.mine ? S.me : "Stranger", text: e.text, createdAt: e.at, anon: !e.mine });
}
function renderRandom() {
  const st = S.rnd;
  $("randomIntro").hidden = st !== "idle";
  msgs.hidden = st === "idle";
  $("composer").hidden = st === "idle";
  $("randomBar").hidden = st === "idle";
  msgs.textContent = "";
  S.rLog.forEach(drawR);
  scrollDown(true);
  $("rStatus").textContent = { searching: "🔍 Stranger dhoondh rahe hain…", chatting: "✅ Connected " + S.rInfo, ended: "❌ Stranger chala gaya" }[st] || "";
  $("rReport").hidden = $("rBlock").hidden = !(st === "chatting" || st === "ended");
  setComposer(st === "chatting");
}
function startRandom(interest) {
  S.rLog = [];
  S.rnd = "searching";
  socket.emit(interest === undefined ? "random_next" : "random_start", interest);
  renderRandom();
}

/* ───────── menu / report / block ───────── */
function closeMenu() { $("menu").hidden = true; }
function openMenu(e, name, ctx) {
  e.stopPropagation();
  const m = $("menu");
  m.textContent = "";
  const add = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { closeMenu(); fn(); };
    m.appendChild(b);
  };
  add("💬 Message", () => openDm(name));
  add("🚩 Report", () => openReport({ where: ctx.where, target: name, text: ctx.text }));
  if (isBlocked(name)) add("✅ Unblock", () => unblock(name));
  else add("🚫 Block", () => { if (confirm(`${name} ko block karein?`)) block(name); });
  m.hidden = false;
  m.style.left = Math.max(8, Math.min(e.clientX, innerWidth - 170)) + "px";
  m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - 150)) + "px";
}
document.addEventListener("click", closeMenu);

function afterBlock(res, okMsg) {
  if (!res || res.error) return toast(res?.error || "Error");
  S.blocked = new Set(res.blocked);
  toast(okMsg);
  if (S.view?.type === "room") switchView(S.view);
  else if (S.view?.type === "dm" && isBlocked(S.view.username)) switchView({ type: "room", id: S.rooms[0].id, name: S.rooms[0].name });
  renderDms();
}
function block(name) { socket.emit("block", name, (r) => afterBlock(r, `${name} blocked.`)); }
function unblock(name) { socket.emit("unblock", name, (r) => afterBlock(r, `${name} unblocked.`)); }

let reportCtx = null;
function openReport(ctx) {
  reportCtx = ctx;
  $("rTarget").textContent = ctx.where === "random" ? "Stranger" : ctx.target;
  $("reportModal").hidden = false;
}
$("rCancel").onclick = () => ($("reportModal").hidden = true);
$("rSend").onclick = () => {
  socket.emit("report", { ...reportCtx, reason: $("rReason").value }, (res) => toast(res?.ok ? "Report bhej diya. Shukriya!" : res?.error || "Error"));
  $("reportModal").hidden = true;
};

/* ───────── profile ───────── */
$("profileBtn").onclick = () => {
  $("pGender").value = S.profile.gender;
  $("pCountry").value = S.profile.country;
  $("profileModal").hidden = false;
};
$("pCancel").onclick = () => ($("profileModal").hidden = true);
$("pSave").onclick = async () => {
  const r = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gender: $("pGender").value, country: $("pCountry").value }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { S.profile = { gender: d.gender, country: d.country }; $("profileModal").hidden = true; toast("Profile save ho gaya."); }
  else toast(d.error || "Error");
};

/* ───────── boot ───────── */
(async () => {
  const r = await fetch("/api/me").catch(() => null);
  if (!r || !r.ok) return location.replace("/");
  const me = await r.json();
  S.me = me.username; S.rooms = me.rooms; S.blocked = new Set(me.blocked);
  S.roomMs = me.roomClearMinutes * 60000;
  S.clock = me.serverTime - Date.now();
  $("roomNote").textContent = `🧹 Rooms ke messages har ${me.roomClearMinutes} minute baad apne aap delete ho jate hain. DM safe rehte hain.`;
  setInterval(() => {                       // purane room messages screen se hata do
    if (S.view?.type !== "room") return;
    const cutoff = Date.now() + S.clock - S.roomMs;
    msgs.querySelectorAll(".msg[data-ts]").forEach((el) => { if (Number(el.dataset.ts) < cutoff) el.remove(); });
  }, 15000);
  S.profile = { gender: me.gender, country: me.country };
  $("me").textContent = S.me;
  $("adminLink").hidden = !me.isAdmin;
  renderRooms(); renderDms();

  socket = io({ withCredentials: true });

  socket.on("connect", () => {
    status.textContent = "Online"; status.className = "status ok";
    socket.emit("dm_recent", (res) => {
      for (const d of res?.list || []) if (!S.dms.has(d.username.toLowerCase())) S.dms.set(d.username.toLowerCase(), d);
      renderDms();
    });
    if (first) { first = false; switchView({ type: "room", id: S.rooms[0].id, name: S.rooms[0].name }); }
    else if (S.view.type === "random") { S.rnd = "idle"; S.rLog = []; renderRandom(); }
    else switchView(S.view);
  });
  socket.on("disconnect", () => { status.textContent = "Reconnecting…"; status.className = "status"; setComposer(false, "Reconnecting…"); });
  socket.on("connect_error", (e) => {
    if (e.message === "unauthorized" || e.message === "forbidden") { socket.close(); location.replace("/"); }
  });
  socket.on("kicked", (reason) => { alert(reason); location.replace("/"); });

  /* rooms */
  socket.on("message", (m) => {
    if (S.view?.type !== "room" || m.room !== S.view.id || isBlocked(m.username)) return;
    addMsg(m);
    scrollDown(m.username === S.me);
    if (m.username === S.me) clearTyping();
  });
  socket.on("room_users", ({ room, users }) => { if (S.view?.type === "room" && S.view.id === room) renderUsers(users); });
  socket.on("room_counts", (c) => { S.counts = c; renderRooms(); });
  socket.on("typing", ({ room, username }) => {
    if (S.view?.type === "room" && S.view.id === room && !isBlocked(username)) showTyping(`${username} likh raha hai…`);
  });

  socket.on("announce", ({ text }) => {
    toast("📢 " + text);
    if (S.view && S.view.type !== "random") { addSys("📢 " + text); scrollDown(true); }
  });

  /* direct messages */
  socket.on("dm", (m) => {
    const other = m.from === S.me ? m.to : m.from;
    const low = other.toLowerCase();
    if (isBlocked(other)) return;
    S.dms.set(low, { username: other, last: m.text, at: m.createdAt });
    if (S.view?.type === "dm" && S.view.id === low) {
      addMsg({ username: m.from, text: m.text, createdAt: m.createdAt });
      scrollDown(m.from === S.me);
    } else if (m.from !== S.me) {
      S.unread[low] = (S.unread[low] || 0) + 1;
      toast(`💬 ${other}: ${m.text.slice(0, 40)}`);
    }
    renderDms();
  });

  /* random */
  socket.on("random_waiting", () => {});
  socket.on("random_matched", (info) => {
    S.rnd = "chatting"; S.rInfo = infoText(info) ? `(Stranger ${infoText(info)})` : "";
    S.rLog = [{ sys: true, text: "Stranger mil gaya! Hi bolo 👋" }];
    if (S.view?.type === "random") renderRandom();
  });
  socket.on("random_msg", ({ text }) => { rAdd({ text, at: Date.now() }); clearTyping(); });
  socket.on("random_typing", () => { if (S.view?.type === "random") showTyping("Stranger likh raha hai…"); });
  socket.on("random_ended", () => { S.rnd = "ended"; rAdd({ sys: true, text: "Stranger ne chat chhod di." }); if (S.view?.type === "random") renderRandom(); });

  $("randomBtn").onclick = () => switchView({ type: "random" });
  $("rStart").onclick = () => startRandom($("interest").value);
  $("rNext").onclick = () => startRandom();
  $("rStop").onclick = () => { socket.emit("random_stop"); S.rnd = "idle"; S.rLog = []; renderRandom(); };
  $("rReport").onclick = () => openReport({ where: "random" });
  $("rBlock").onclick = () => {
    if (!confirm("Is stranger ko block karein?")) return;
    socket.emit("random_block", (res) => { if (res?.ok) { S.blocked = new Set(res.blocked); toast("Blocked."); S.rnd = "ended"; renderRandom(); } else toast(res?.error || "Error"); });
  };

  /* composer */
  input.addEventListener("input", () => {
    if (Date.now() - (input.lastEmit || 0) < 1500) return;
    input.lastEmit = Date.now();
    if (S.view.type === "room") socket.emit("typing");
    else if (S.view.type === "random" && S.rnd === "chatting") socket.emit("random_typing");
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !socket.connected) return;
    const done = (res) => { send.disabled = false; if (res?.error) toast(res.error); else input.value = ""; input.focus(); };
    send.disabled = true;
    const t = S.view.type;
    if (t === "room") socket.emit("message", text, done);
    else if (t === "dm") socket.emit("dm_send", { to: S.view.username, text }, done);
    else socket.emit("random_msg", text, (res) => { if (res?.ok) rAdd({ mine: true, text: res.text, at: Date.now() }); done(res); });
  });

  $("logout").onclick = async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.replace("/"); };
  $("toggle").onclick = (e) => { e.stopPropagation(); $("usersPanel").classList.remove("open"); $("side").classList.toggle("open"); };
  $("usersToggle").onclick = (e) => { e.stopPropagation(); $("side").classList.remove("open"); $("usersPanel").classList.toggle("open"); };
  msgs.addEventListener("click", closeDrawers);
})();
