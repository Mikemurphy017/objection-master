// Objection Master Pro front end. No build step: plain ES modules.

const GOALS = {
  intro_call: "Move to an intro call",
  leave_door_open: "Leave the door open",
  continue_conversation: "Continue the conversation",
};

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder that never interprets strings as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== "") node.append(c);
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", {}, text);
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied");
}

const fmtDate = (s) => new Date(s.replace(" ", "T") + "Z").toLocaleDateString();

// ---------------------------------------------------------------- state

const state = {
  clients: [],
  extraction: null,
  lastGeneration: null,
  editingClientId: null,
};

async function loadClients() {
  state.clients = await api("/api/clients");
  renderClientSelect();
  renderClientList();
}

// ---------------------------------------------------------------- tabs

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab.dataset.view}`));
    if (tab.dataset.view === "library") loadCorpus();
  }),
);

// ---------------------------------------------------------------- respond: upload

const dropzone = $("#dropzone");
const fileInput = $("#file-input");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => fileInput.files[0] && handleImage(fileInput.files[0]));
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (file) handleImage(file);
});
document.addEventListener("paste", (e) => {
  if (!$("#view-respond").classList.contains("active")) return;
  if (e.target.closest("input, textarea, [contenteditable='true']")) return;
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
  if (item) handleImage(item.getAsFile());
});

/** Big retina screenshots get downscaled so uploads stay fast and under Claude's image limits. */
async function prepareImage(file) {
  const MAX_SIDE = 2000;
  const MAX_BYTES = 3.5 * 1024 * 1024;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES && ["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  return new File([blob], "screenshot.jpg", { type: "image/jpeg" });
}

function setStep(name, status) {
  const node = document.querySelector(`.step[data-step="${name}"]`);
  node.classList.remove("active", "done", "skipped");
  if (status) node.classList.add(status);
}

function showError(msg) {
  const box = $("#respond-error");
  box.textContent = msg;
  box.hidden = !msg;
}

function resetResults() {
  $("#results").hidden = true;
  $("#options").replaceChildren();
  showError("");
}

async function handleImage(file) {
  resetResults();
  const prepared = await prepareImage(file);
  const preview = $("#preview");
  preview.src = URL.createObjectURL(prepared);
  preview.hidden = false;
  dropzone.classList.add("has-image");

  $("#steps").hidden = false;
  ["read", "match", "write"].forEach((s) => setStep(s, null));
  setStep("read", "active");

  const form = new FormData();
  form.append("screenshot", prepared);
  let analysis;
  try {
    analysis = await api("/api/analyze", { method: "POST", body: form });
  } catch (err) {
    setStep("read", null);
    showError(`${err.message} You can also type the objection in below.`);
    showContext({});
    return;
  }
  setStep("read", "done");
  setStep("match", "active");

  const { extraction, match } = analysis;
  state.extraction = extraction;
  showContext({
    clientId: match.clientId,
    prospect: [extraction.prospect_name, extraction.prospect_headline].filter(Boolean).join(" - "),
    objection: extraction.objection_text,
    thread: extraction.thread_context,
  });

  const note = $("#match-note");
  if (match.clientId) {
    setStep("match", "done");
    note.textContent = `Matched "${extraction.client_name || extraction.client_match}" from the screenshot`;
    await generate();
  } else {
    setStep("match", null);
    const seen = extraction.client_name ? `Saw "${extraction.client_name}" but it` : "The client's name";
    note.textContent = state.clients.length
      ? `${seen} didn't match a client on file. Pick one, then Write replies.`
      : "No clients on file yet. Add one on the Clients tab first.";
    $("#ctx-client").focus();
  }
  if (extraction.notes) toast(extraction.notes);
}

$("#type-instead").addEventListener("click", () => {
  resetResults();
  showContext({});
  $("#ctx-objection").focus();
});

// ---------------------------------------------------------------- respond: context + generation

function renderClientSelect() {
  const select = $("#ctx-client");
  const current = select.value;
  select.replaceChildren(
    el("option", { value: "" }, state.clients.length ? "Choose a client..." : "No clients yet"),
    ...state.clients.map((c) => el("option", { value: c.id }, c.company ? `${c.name} (${c.company})` : c.name)),
  );
  select.value = current;
}

function showContext({ clientId, prospect, objection, thread }) {
  $("#context").hidden = false;
  if (clientId !== undefined) $("#ctx-client").value = clientId ?? "";
  if (prospect !== undefined) $("#ctx-prospect").value = prospect || "";
  if (objection !== undefined) $("#ctx-objection").value = objection || "";
  if (thread !== undefined) {
    $("#ctx-thread").value = thread || "";
    $("#ctx-thread").closest("details").open = Boolean(thread);
  }
  $("#match-note").textContent = "";
  loadFavoritesPanel();
}

$("#ctx-client").addEventListener("change", () => {
  $("#match-note").textContent = "";
  loadFavoritesPanel();
});

$("#generate-btn").addEventListener("click", generate);

async function generate() {
  const clientId = Number($("#ctx-client").value);
  const objection = $("#ctx-objection").value.trim();
  if (!clientId) return showError("Pick which client this conversation belongs to.");
  if (!objection) return showError("There's no objection text to answer.");
  showError("");

  const [prospectName, ...headline] = $("#ctx-prospect").value.split(" - ");
  const btn = $("#generate-btn");
  btn.disabled = true;
  btn.textContent = "Writing...";
  $("#steps").hidden = false;
  setStep("write", "active");
  try {
    const data = await api(
      "/api/generate",
      json("POST", {
        clientId,
        objection,
        threadContext: $("#ctx-thread").value,
        prospectName: prospectName?.trim() || null,
        prospectHeadline: headline.join(" - ").trim() || null,
        channel: state.extraction?.channel,
        guidance: $("#ctx-guidance").value,
      }),
    );
    state.lastGeneration = { ...data, clientId, objection, prospectName: prospectName?.trim() || "" };
    setStep("write", "done");
    renderResults(data);
  } catch (err) {
    setStep("write", null);
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Regenerate";
  }
}

function renderResults({ result, sources }) {
  $("#results").hidden = false;
  $("#read-line").replaceChildren(el("strong", {}, "Read: "), result.read);
  $("#options").replaceChildren(
    ...Object.keys(GOALS).map((goal) => optionCard(goal, result[goal], result.recommended === goal)),
  );
  const uniq = [...new Set(sources.map((s) => s.section))];
  $("#sources").textContent = uniq.length ? `Drew on: ${uniq.join(" · ")}` : "";
}

function optionCard(goal, option, recommended) {
  const message = el("p", { class: "message", contenteditable: "true", spellcheck: "true" }, option.message);
  const saveBtn = el("button", { class: "star" }, "☆ Save");
  saveBtn.addEventListener("click", async () => {
    const g = state.lastGeneration;
    saveBtn.disabled = true;
    try {
      await api(
        "/api/favorites",
        json("POST", {
          clientId: g.clientId,
          strategy: goal,
          objection: g.objection,
          response: message.innerText.trim(),
          prospectName: g.prospectName,
        }),
      );
      saveBtn.textContent = "★ Saved";
      saveBtn.classList.add("saved");
      toast("Saved to this client's library");
      loadFavoritesPanel();
    } catch (err) {
      saveBtn.disabled = false;
      toast(err.message);
    }
  });
  return el(
    "article",
    { class: `option${recommended ? " recommended" : ""}` },
    el(
      "div",
      { class: "option-head" },
      el("span", { class: "goal" }, GOALS[goal]),
      el("span", { class: `badge${recommended ? " rec" : ""}` }, recommended ? "Send this" : option.label),
    ),
    message,
    el("p", { class: "why" }, option.why),
    el(
      "div",
      { class: "option-actions" },
      el("button", { class: "primary", onclick: () => copyText(message.innerText.trim()) }, "Copy"),
      saveBtn,
    ),
  );
}

// ---------------------------------------------------------------- favorites

function favoriteItem(fav, onDelete) {
  return el(
    "div",
    { class: "fav" },
    el(
      "div",
      { class: "meta" },
      el("span", { class: "badge" }, GOALS[fav.strategy] || fav.strategy),
      fav.prospect_name && el("span", {}, `to ${fav.prospect_name}`),
      el("span", {}, fmtDate(fav.created_at)),
    ),
    fav.objection_text && el("div", { class: "objection" }, `“${fav.objection_text}”`),
    el("div", { class: "text" }, fav.response_text),
    el(
      "div",
      { class: "row" },
      el("button", { onclick: () => copyText(fav.response_text) }, "Copy"),
      el(
        "button",
        {
          class: "danger",
          onclick: async () => {
            if (!confirm("Remove this saved reply?")) return;
            await api(`/api/favorites/${fav.id}`, { method: "DELETE" });
            onDelete();
          },
        },
        "Remove",
      ),
    ),
  );
}

async function loadFavoritesPanel() {
  const clientId = Number($("#ctx-client").value);
  const panel = $("#favorites-panel");
  if (!clientId) {
    panel.hidden = true;
    return;
  }
  const client = state.clients.find((c) => c.id === clientId);
  const favs = await api(`/api/clients/${clientId}/favorites`);
  const filter = $("#fav-filter").value;
  const shown = favs.filter((f) => !filter || f.strategy === filter);
  $("#fav-client-name").textContent = client?.name ?? "";
  $("#fav-list").replaceChildren(
    ...(shown.length
      ? shown.map((f) => favoriteItem(f, loadFavoritesPanel))
      : [el("p", { class: "empty" }, favs.length ? "None saved for this goal yet." : "Nothing saved yet. Star a reply above to start this client's library.")]),
  );
  panel.hidden = false;
}
$("#fav-filter").addEventListener("change", loadFavoritesPanel);

// ---------------------------------------------------------------- clients view

const clientForm = $("#client-form");

function renderClientList() {
  const q = $("#client-search").value.toLowerCase();
  const list = $("#client-list");
  const shown = state.clients.filter((c) =>
    [c.name, c.company, c.service_type, ...c.aliases].join(" ").toLowerCase().includes(q),
  );
  list.replaceChildren(
    ...(shown.length
      ? shown.map((c) =>
          el(
            "li",
            { class: c.id === state.editingClientId ? "active" : "", onclick: () => editClient(c.id) },
            el("span", {}, c.name),
            el("span", { class: "sub" }, [c.company, c.service_type].filter(Boolean).join(" · ") || "No details yet"),
          ),
        )
      : [el("li", { class: "sub" }, state.clients.length ? "No matches" : "No clients yet")]),
  );
}
$("#client-search").addEventListener("input", renderClientList);

function fillClientForm(client) {
  for (const field of clientForm.elements) {
    if (!field.name) continue;
    const v = client?.[field.name];
    field.value = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }
}

async function editClient(id) {
  state.editingClientId = id;
  const client = state.clients.find((c) => c.id === id);
  fillClientForm(client);
  $("#client-form-title").textContent = client ? `Edit ${client.name}` : "Add a client";
  $("#delete-client").hidden = !client;
  $("#client-form-msg").textContent = "";
  renderClientList();
  const favBox = $("#client-favs");
  if (!client) {
    favBox.hidden = true;
    return;
  }
  const favs = await api(`/api/clients/${id}/favorites`);
  $("#client-fav-list").replaceChildren(
    ...(favs.length ? favs.map((f) => favoriteItem(f, () => editClient(id))) : [el("p", { class: "empty" }, "No saved replies yet.")]),
  );
  favBox.hidden = false;
}

$("#new-client").addEventListener("click", () => {
  editClient(null);
  clientForm.elements.name.focus();
});

clientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(clientForm));
  const id = state.editingClientId;
  try {
    const saved = id ? await api(`/api/clients/${id}`, json("PUT", body)) : await api("/api/clients", json("POST", body));
    await loadClients();
    await editClient(saved.id);
    toast(id ? "Client updated" : "Client added");
  } catch (err) {
    $("#client-form-msg").textContent = err.message;
  }
});

$("#delete-client").addEventListener("click", async () => {
  const client = state.clients.find((c) => c.id === state.editingClientId);
  if (!client || !confirm(`Remove ${client.name}? Their saved replies will be deleted too.`)) return;
  await api(`/api/clients/${client.id}`, { method: "DELETE" });
  await loadClients();
  editClient(null);
  toast("Client removed");
});

// ---------------------------------------------------------------- library view

async function loadCorpus() {
  const docs = await api("/api/corpus");
  $("#corpus-list").replaceChildren(
    ...docs.map((d) =>
      el(
        "tr",
        {},
        el("td", {}, d.title),
        el("td", {}, d.word_count.toLocaleString()),
        el("td", {}, d.pinned ? "Core playbook (always used)" : d.source === "repo" ? "Built-in source" : "Uploaded"),
        el(
          "td",
          {},
          d.source === "upload" &&
            el(
              "button",
              {
                class: "small danger",
                onclick: async () => {
                  if (!confirm(`Remove "${d.title}" from the library?`)) return;
                  await api(`/api/corpus/${d.id}`, { method: "DELETE" });
                  loadCorpus();
                },
              },
              "Remove",
            ),
        ),
      ),
    ),
  );
}

$("#corpus-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $("#corpus-msg");
  msg.textContent = "Uploading...";
  try {
    await api("/api/corpus", { method: "POST", body: new FormData(form) });
    form.reset();
    msg.textContent = "Added. New replies will draw on it right away.";
    loadCorpus();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---------------------------------------------------------------- boot

loadClients().catch((err) => showError(err.message));
