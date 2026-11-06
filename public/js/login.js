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
  } catch {
    err.textContent = "Server se connect nahi ho paya.";
  }
  btn.disabled = false;
});
