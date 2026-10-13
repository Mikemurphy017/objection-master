// Admin page: invite people, reissue links, disable or remove access. Owner only.

const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== "") node.append(c);
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) return location.replace("/login?next=/admin/");
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

const when = (s) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never");
const day = (s) => new Date(s.replace(" ", "T") + "Z").toLocaleDateString([], { dateStyle: "medium" });

function status(u) {
  if (u.isOwner) return ["Owner", "rec"];
  if (!u.active) return ["Disabled", "off"];
  if (!u.has_password) return ["Invite pending", "pending"];
  return ["Active", "ok"];
}

/** Show a freshly created link with copy + mailto helpers. */
function showLink(user, link, kind) {
  $("#link-box").hidden = false;
  $("#link-label").textContent =
    kind === "reset" ? `Password reset link for ${user.email} (valid 2 days, one use):` : `Invite link for ${user.email} (valid 7 days, one use):`;
  $("#link-value").value = link;
  const subject = kind === "reset" ? "Reset your Objection Master Pro password" : "You're invited to Objection Master Pro";
  const body = `Hi${user.name ? ` ${user.name.split(" ")[0]}` : ""},\n\n${
    kind === "reset" ? "Here's a link to set a new password" : "Here's your link to set up your Objection Master Pro account"
  } (it works once):\n\n${link}\n\nMike`;
  $("#mail-link").href = `mailto:${encodeURIComponent(user.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  $("#link-value").select();
  $("#link-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#link-value").value);
  } catch {
    $("#link-value").select();
    document.execCommand("copy");
  }
  toast("Link copied");
});

async function loadUsers() {
  const users = await api("/api/admin/users");
  if (!users) return;
  const active = users.filter((u) => u.active && u.has_password).length;
  $("#user-count").textContent = `${active} active · ${users.length} total`;
  $("#user-rows").replaceChildren(
    ...users.map((u) => {
      const [label, cls] = status(u);
      return el(
        "tr",
        { class: u.active ? "" : "row-off" },
        el("td", {}, el("div", { class: "person" }, u.name || u.email.split("@")[0]), el("div", { class: "muted small" }, u.email)),
        el("td", {}, el("span", { class: `badge status-${cls}` }, label)),
        el("td", { class: "small" }, when(u.last_login_at)),
        el("td", { class: "small" }, day(u.created_at)),
        el("td", {}, el("div", { class: "actions" }, u.isOwner ? el("span", { class: "muted small" }, "You") : actionsFor(u))),
      );
    }),
  );
}

function actionsFor(u) {
  return [
    u.active &&
      el(
        "button",
        {
          class: "small",
          title: u.has_password ? "Make a one-time link for them to set a new password" : "Make a fresh invite link",
          onclick: async () => {
            const { link, kind } = await api(`/api/admin/users/${u.id}/link`, { method: "POST" });
            showLink(u, link, kind);
            toast(kind === "reset" ? "Reset link created" : "New invite link created");
          },
        },
        u.has_password ? "Reset password" : "New invite link",
      ),
    el(
      "button",
      {
        class: "small",
        onclick: async () => {
          if (u.active && !confirm(`Disable ${u.email}? They're signed out straight away and can't sign in until you re-enable them.`)) return;
          await api(`/api/admin/users/${u.id}`, json("PATCH", { active: !u.active }));
          toast(u.active ? "Access disabled" : "Access restored");
          loadUsers();
        },
      },
      u.active ? "Disable" : "Enable",
    ),
    el(
      "button",
      {
        class: "small danger",
        onclick: async () => {
          if (!confirm(`Remove ${u.email} completely? Their chats and saved replies stay in the app.`)) return;
          await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
          toast("Removed");
          loadUsers();
        },
      },
      "Remove",
    ),
  ];
}

$("#invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  $("#invite-msg").textContent = "";
  try {
    const { user, link } = await api("/api/admin/users", json("POST", Object.fromEntries(new FormData(form))));
    form.reset();
    showLink(user, link, "invite");
    loadUsers();
  } catch (err) {
    $("#invite-msg").textContent = err.message;
  }
});

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const out = $("#password-msg");
  out.textContent = "";
  try {
    await api("/api/me/password", json("POST", { current: form.elements.current.value, password: form.elements.password.value }));
    form.reset();
    toast("Password updated. Other devices were signed out.");
  } catch (err) {
    out.textContent = err.message;
  }
});

(async () => {
  const me = await api("/api/me");
  if (!me) return;
  $("#whoami").textContent = `Signed in as ${me.email}`;
  document.querySelector("#password-form").elements.username.value = me.email;
  await loadUsers();
})().catch((err) => toast(err.message));
