const $ = (id) => document.getElementById(id);
const msgs = $("msgs"), input = $("input"), send = $("send"), status = $("status");
let me = "";

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},70%,70%)`;
}

function addSys(text) {
  const d = document.createElement("div");
  d.className = "sys";
  d.textContent = text; // textContent => XSS safe
  msgs.appendChild(d);
}

function addMsg(m) {
  const box = document.createElement("div");
  box.className = "msg" + (m.username === me ? " mine" : "");
  const who = document.createElement("div");
  who.className = "who";
  who.style.color = colorFor(m.username);
  who.textContent = m.username === me ? "You" : m.username;
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = m.text;
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  box.append(who, t, time);
  msgs.appendChild(box);
}

function scrollDown(force) {
  const near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150;
  if (force || near) msgs.scrollTop = msgs.scrollHeight;
}

function setConnected(ok, text) {
  status.textContent = text || (ok ? "Connected" : "Reconnecting…");
  status.className = "status" + (ok ? " ok" : "");
  input.disabled = send.disabled = !ok;
  if (ok) input.focus();
}

(async () => {
  const r = await fetch("/api/me").catch(() => null);
  if (!r || !r.ok) return location.replace("/");
  me = (await r.json()).username;
  $("me").textContent = me;

  const socket = io({ withCredentials: true });

  socket.on("connect", () => setConnected(true));
  socket.on("disconnect", () => setConnected(false));
  socket.on("connect_error", (e) => {
    if (e.message === "unauthorized" || e.message === "forbidden") { socket.close(); location.replace("/"); }
    else setConnected(false);
  });
  socket.on("kicked", (reason) => { alert(reason); location.replace("/"); });

  socket.on("history", (rows) => {
    msgs.textContent = "";
    rows.forEach(addMsg);
    scrollDown(true);
  });
  socket.on("message", (m) => {
    addMsg(m);
    scrollDown(m.username === me);
    if (m.username === me) clearTyping();
  });

  socket.on("online", (list) => {
    $("count").textContent = list.length;
    const ul = $("users");
    ul.textContent = "";
    list.forEach((u) => {
      const li = document.createElement("li");
      li.textContent = u === me ? `${u} (You)` : u;
      ul.appendChild(li);
    });
  });

  let typingTimer;
  function clearTyping() { $("typing").textContent = ""; clearTimeout(typingTimer); }
  socket.on("typing", (u) => {
    $("typing").textContent = `${u} likh raha hai…`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(clearTyping, 2500);
  });

  let lastEmit = 0;
  input.addEventListener("input", () => {
    if (Date.now() - lastEmit > 1500) { lastEmit = Date.now(); socket.emit("typing"); }
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !socket.connected) return;
    send.disabled = true;
    socket.emit("message", text, (res) => {
      send.disabled = false;
      if (res && res.error) { addSys(res.error); scrollDown(true); }
      else input.value = "";
      input.focus();
    });
  });

  $("logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    location.replace("/");
  });
  $("toggle").addEventListener("click", () => $("side").classList.toggle("open"));
  msgs.addEventListener("click", () => $("side").classList.remove("open"));
})();
