// Sign-in and invite / password-reset pages. Loads without a session.

const msg = (text) => (document.querySelector("#msg").textContent = text);

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

/** Only follow same-site paths after sign-in, never another origin. */
function safeNext() {
  const next = new URLSearchParams(location.search).get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const loginForm = document.querySelector("#login-form");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = loginForm.querySelector("button");
    btn.disabled = true;
    msg("");
    try {
      await post("/api/auth/login", Object.fromEntries(new FormData(loginForm)));
      location.replace(safeNext());
    } catch (err) {
      msg(err.message);
      btn.disabled = false;
    }
  });
}

const inviteForm = document.querySelector("#invite-form");
if (inviteForm) {
  // The token travels in the URL fragment, so it never reaches server logs or Referer headers.
  const token = location.hash.slice(1);
  const sub = document.querySelector("#invite-sub");
  (async () => {
    if (!token) return (sub.textContent = "This link is incomplete. Ask Mike for a new one.");
    const res = await fetch(`/api/auth/link/${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return (sub.textContent = data.error || "This link has expired.");
    history.replaceState(null, "", location.pathname); // keep the token out of history
    document.querySelector("#invite-title").textContent = data.firstTime ? "Welcome aboard" : "Choose a new password";
    sub.textContent = data.firstTime
      ? `Set a password for ${data.email} to start using Objection Master Pro.`
      : `Set a new password for ${data.email}.`;
    inviteForm.elements.username.value = data.email;
    inviteForm.elements.name.value = data.name || "";
    document.querySelector("#name-label").hidden = !data.firstTime && !!data.name;
    inviteForm.hidden = false;
    inviteForm.elements[data.firstTime && !data.name ? "name" : "password"].focus();
  })();

  inviteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { name, password, confirm } = Object.fromEntries(new FormData(inviteForm));
    if (password !== confirm) return msg("The two passwords don't match.");
    const btn = inviteForm.querySelector("button");
    btn.disabled = true;
    msg("");
    try {
      await post("/api/auth/accept", { token, password, name: name || undefined });
      location.replace("/");
    } catch (err) {
      msg(err.message);
      btn.disabled = false;
    }
  });
}
