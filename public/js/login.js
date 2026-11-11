(async () => {
  try { const r = await fetch("/api/me"); if (r.ok) location.replace("/chat.html"); } catch {}
})();

const form = document.getElementById("form");
const err = document.getElementById("err");
const btn = document.getElementById("btn");
const dob = document.getElementById("dob");
dob.max = new Date().toISOString().slice(0, 10);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value.trim(), dob: dob.value, agree: document.getElementById("agree").checked }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return location.replace("/chat.html");
    err.textContent = data.error || "Kuch galat ho gaya.";
    document.getElementById("appeal").hidden = !data.banned;   // ban hai to appeal ka option dikhao
  } catch {
    err.textContent = "Server se connect nahi ho paya.";
  }
  btn.disabled = false;
});

document.getElementById("appealBtn").addEventListener("click", async () => {
  const b = document.getElementById("appealBtn");
  b.disabled = true; err.textContent = "";
  try {
    const res = await fetch("/api/appeal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value.trim(), dob: dob.value, message: document.getElementById("appealMsg").value }),
    });
    const data = await res.json().catch(() => ({}));
    err.textContent = res.ok ? "✅ Appeal bhej di gayi. Admin dekhega." : (data.error || "Appeal nahi gayi.");
    if (res.ok) document.getElementById("appeal").hidden = true;
  } catch { err.textContent = "Server se connect nahi ho paya."; }
  b.disabled = false;
});
