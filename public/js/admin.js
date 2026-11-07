const $ = (id) => document.getElementById(id);

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) alert(d.error || "Error");
  return r.ok;
}

function btn(label, cls, fn) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = fn;
  return b;
}

async function load() {
  const r = await fetch("/api/admin/reports");
  if (r.status === 401 || r.status === 403) return location.replace("/chat.html");
  const { reports, banned } = await r.json();

  const box = $("reports");
  box.textContent = "";
  if (!reports.length) box.textContent = "Koi open report nahi hai. 🎉";
  for (const rep of reports) {
    const d = document.createElement("div");
    d.className = "rep";
    const h = document.createElement("div");
    h.textContent = `${rep.target} ← ${rep.reporter} · ${rep.reason} · ${rep.where} · ${new Date(rep.createdAt).toLocaleString()}`;
    h.style.fontWeight = "600";
    const pre = document.createElement("pre");
    pre.textContent = (rep.context || []).map((c) => `${c.from}: ${c.text}`).join("\n") || "(no context)";
    d.append(h, pre,
      btn("Ban user", "danger", async () => {
        const reason = prompt(`${rep.target} ko ban karne ka reason:`, rep.reason);
        if (reason !== null && (await post("/api/admin/ban", { username: rep.target, reason }))) load();
      }),
      btn("Dismiss", "", async () => { if (await post("/api/admin/dismiss", { id: rep._id })) load(); }));
    box.appendChild(d);
  }

  const bb = $("banned");
  bb.textContent = "";
  if (!banned.length) bb.textContent = "Koi banned user nahi.";
  for (const u of banned) {
    const d = document.createElement("div");
    d.className = "rep";
    d.append(`${u.username} ${u.banReason ? "· " + u.banReason : ""} `,
      btn("Unban", "", async () => { if (await post("/api/admin/unban", { username: u.username })) load(); }));
    bb.appendChild(d);
  }
}
load();
