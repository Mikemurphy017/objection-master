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
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== "") node.append(c);
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    // Session ended (signed out elsewhere, disabled, or expired): back to sign-in.
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
    throw new Error("Please sign in again.");
  }
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
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
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

const parseDate = (s) => new Date(s.replace(" ", "T") + "Z");
function relTime(s) {
  if (!s) return "";
  const d = parseDate(s);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)}d ago`;
  return d.toLocaleDateString();
}
const fmtTime = (s) =>
  parseDate(s).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ================================================================ state

const state = {
  clients: [],
  conversations: [],
  route: { view: "new", clientId: null },
  turns: [],
  favorites: [],
  attachment: null, // { file, url }
  editing: null, // context carried over when re-sending an earlier objection
  busy: false,
  editingClientId: null,
};

const currentClient = () => state.clients.find((c) => c.id === state.route.clientId) ?? null;

async function loadClients() {
  [state.clients, state.conversations] = await Promise.all([api("/api/clients"), api("/api/conversations")]);
  renderSidebar();
  renderComposerClients();
  renderClientList();
}

// ================================================================ routing

function parseHash() {
  const [, view, id] = location.hash.match(/^#\/(\w+)(?:\/(\d+))?/) ?? [];
  if (view === "client" && id) return { view: "client", clientId: Number(id) };
  if (view === "clients" || view === "library") return { view, clientId: id ? Number(id) : null };
  return { view: "new", clientId: null };
}

async function route() {
  state.route = parseHash();
  const { view } = state.route;
  document.querySelector(".app").classList.remove("nav-open");
  $("#saved-drawer").hidden = true;

  const isChat = view === "new" || view === "client";
  $("#view-chat").classList.toggle("active", isChat);
  $("#view-clients").classList.toggle("active", view === "clients");
  $("#view-library").classList.toggle("active", view === "library");
  document.querySelectorAll(".side-link").forEach((a) => a.classList.toggle("active", a.dataset.route === view));

  if (view === "client" && !currentClient()) {
    location.hash = "#/new";
    return;
  }
  renderSidebar();
  renderHeader();

  if (view === "clients") editClient(state.route.clientId);
  if (view === "library") loadCorpus();
  if (isChat) {
    renderComposerClients();
    if (view === "client") await loadTurns();
    else {
      state.turns = [];
      state.favorites = [];
      renderThread();
    }
    $("#composer-text").focus();
  }
}
window.addEventListener("hashchange", route);

function renderHeader() {
  const { view } = state.route;
  const client = currentClient();
  const titles = { new: "New chat", clients: "Manage clients", library: "Klaff library" };
  $("#head-name").textContent = view === "client" ? client.name : titles[view];
  $("#head-sub").textContent =
    view === "client" ? [client.company, client.country, client.service_type].filter(Boolean).join(" · ") : "";
  $("#head-actions").hidden = view !== "client";
  $("#saved-count").textContent = state.favorites.length || "";
}

// ================================================================ sidebar

function renderSidebar() {
  const q = $("#convo-search").value.trim().toLowerCase();
  const list = $("#convo-list");
  const shown = state.conversations.filter((c) => `${c.name} ${c.company}`.toLowerCase().includes(q));
  list.replaceChildren(
    ...(shown.length
      ? shown.map((c) =>
          el(
            "li",
            {
              class: state.route.view === "client" && state.route.clientId === c.client_id ? "active" : "",
              onclick: () => (location.hash = `#/client/${c.client_id}`),
              title: c.name,
            },
            el("span", { class: "name" }, c.name),
            el(
              "span",
              { class: "sub" },
              c.turns ? `${c.turns} objection${c.turns === 1 ? "" : "s"} · ${relTime(c.last_at)}` : c.company || "No objections yet",
            ),
          ),
        )
      : [
          el(
            "li",
            { class: "empty-li" },
            state.conversations.length ? "No matches" : "No clients yet. Add one under Manage clients.",
          ),
        ]),
  );
}
$("#convo-search").addEventListener("input", renderSidebar);
$("#menu-btn").addEventListener("click", () => document.querySelector(".app").classList.add("nav-open"));
$("#scrim").addEventListener("click", () => document.querySelector(".app").classList.remove("nav-open"));
$("#edit-client-btn").addEventListener("click", () => (location.hash = `#/clients/${state.route.clientId}`));

// ================================================================ thread

async function loadTurns() {
  const clientId = state.route.clientId;
  const data = await api(`/api/clients/${clientId}/turns`);
  if (state.route.clientId !== clientId) return; // navigated away meanwhile
  state.turns = data.turns;
  state.favorites = data.favorites;
  renderThread();
  renderHeader();
  renderFavorites();
}

function renderThread() {
  const thread = $("#thread");
  const empty = state.turns.length === 0 && !thread.querySelector(".turn.live");
  const client = currentClient();
  $("#view-chat").classList.toggle("is-empty", empty);
  $("#hero").hidden = !empty;
  if (client) {
    $("#hero-title").textContent = `Handling an objection for ${client.name.split(" ")[0]}?`;
    $("#hero-sub").textContent = "Drop a screenshot or type what the prospect said. Replies are tuned to this client's voice.";
  } else {
    $("#hero-title").textContent = "What objection are we handling?";
    $("#hero-sub").textContent = "Open a client from the list (or choose one below), then drop a screenshot of their LinkedIn conversation. Replies use only that client's info.";
  }
  thread.replaceChildren(...state.turns.map(turnView));
  scrollToBottom();
}

function scrollToBottom() {
  const box = $("#chat-scroll");
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
}

function userBubble({ imageUrl, objection, prospect, guidance, time }) {
  return el(
    "div",
    { class: "user-msg" },
    el(
      "div",
      { class: "bubble" },
      imageUrl && el("img", { class: "shot", src: imageUrl, alt: "Screenshot", onclick: () => window.open(imageUrl, "_blank") }),
      objection && el("div", { class: "objection" }, objection),
      (prospect || time) && el("div", { class: "meta" }, [prospect, time].filter(Boolean).join(" · ")),
      guidance && el("span", { class: "chip" }, `Steer: ${guidance}`),
    ),
  );
}

function turnView(turn) {
  const r = turn.result;
  return el(
    "div",
    { class: "turn", "data-turn": turn.id },
    userBubble({
      imageUrl: turn.image ? `/api/images/${turn.image}` : null,
      objection: turn.objection_text,
      prospect: turn.prospect_name,
      guidance: turn.guidance,
      time: fmtTime(turn.created_at),
    }),
    el(
      "div",
      { class: "assistant" },
      r.read && el("p", { class: "read-line" }, el("strong", {}, "Read: "), r.read),
      el("div", { class: "options" }, ...Object.keys(GOALS).map((goal) => optionCard(turn, goal, r[goal], r.recommended === goal))),
      el(
        "div",
        { class: "turn-foot" },
        turn.sources?.length
          ? el(
              "details",
              { class: "sources" },
              el("summary", {}, "Klaff sources used"),
              el("div", {}, [...new Set(turn.sources.map((s) => s.section.replace(/^\d+\s+/, "")))].join(" · ")),
            )
          : el("span", { class: "sources" }),
        el("button", { class: "ghost", onclick: () => regenerate(turn) }, "↻ Regenerate"),
        el("button", { class: "ghost", onclick: () => editTurn(turn) }, "✎ Edit"),
        el("button", { class: "ghost", onclick: () => deleteTurn(turn) }, "Delete"),
      ),
    ),
  );
}

function optionCard(turn, goal, option, recommended) {
  const message = el("p", { class: "message", contenteditable: "true", spellcheck: "true" }, option.message);
  const savedAlready = state.favorites.some((f) => f.generation_id === turn.id && f.strategy === goal);
  const saveBtn = el("button", { class: `star${savedAlready ? " saved" : ""}`, disabled: savedAlready }, savedAlready ? "★ Saved" : "☆ Save");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const fav = await api(
        "/api/favorites",
        json("POST", {
          clientId: turn.client_id,
          strategy: goal,
          objection: turn.objection_text,
          response: message.innerText.trim(),
          prospectName: turn.prospect_name,
          turnId: turn.id,
        }),
      );
      state.favorites.unshift(fav);
      saveBtn.textContent = "★ Saved";
      saveBtn.classList.add("saved");
      renderFavorites();
      renderHeader();
      toast("Saved to this client's replies");
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
      el("span", { class: "badge" }, option.label),
      recommended && el("span", { class: "badge rec" }, "★ Send this"),
    ),
    message,
    el(
      "div",
      { class: "option-foot" },
      el("p", { class: "why" }, option.why),
      el(
        "div",
        { class: "option-actions" },
        el("button", { class: "primary", onclick: () => copyText(message.innerText.trim()) }, "Copy"),
        saveBtn,
      ),
    ),
  );
}

async function regenerate(turn) {
  await runTurn({
    clientId: turn.client_id,
    objection: turn.objection_text,
    threadContext: turn.thread_context,
    prospect: turn.prospect_name,
    imageId: turn.image || null,
    guidance: $("#composer-steer").value.trim() || turn.guidance,
  });
}

function editTurn(turn) {
  state.editing = { threadContext: turn.thread_context, prospect: turn.prospect_name, imageId: turn.image || null };
  clearAttachment();
  $("#composer-text").value = turn.objection_text;
  $("#composer-steer").value = turn.guidance || "";
  renderAttachments();
  autosize();
  $("#composer-text").focus();
}

async function deleteTurn(turn) {
  if (!confirm("Delete this objection and its replies from the chat? Saved replies are kept.")) return;
  await api(`/api/turns/${turn.id}`, { method: "DELETE" });
  state.turns = state.turns.filter((t) => t.id !== turn.id);
  renderThread();
  loadClients();
}

// ================================================================ composer

const textarea = $("#composer-text");
const fileInput = $("#file-input");

function autosize() {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}
textarea.addEventListener("input", autosize);
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

function renderComposerClients() {
  const select = $("#composer-client");
  const inClient = state.route.view === "client";
  select.hidden = inClient;
  if (inClient) return;
  const current = select.value;
  select.replaceChildren(
    el("option", { value: "" }, "Choose a client…"),
    ...state.clients.map((c) => el("option", { value: c.id }, c.name)),
  );
  select.value = state.clients.some((c) => String(c.id) === current) ? current : "";
}

/** Big retina screenshots get downscaled so uploads stay fast and under model image limits. */
async function prepareImage(file) {
  const MAX_SIDE = 2000;
  const MAX_BYTES = 3.5 * 1024 * 1024;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES && ["image/png", "image/jpeg", "image/webp"].includes(file.type)) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  return new File([blob], "screenshot.jpg", { type: "image/jpeg" });
}

async function attach(file) {
  if (!file || !file.type.startsWith("image/")) return toast("That isn't an image.");
  clearAttachment();
  state.editing = null;
  const prepared = await prepareImage(file);
  state.attachment = { file: prepared, url: URL.createObjectURL(prepared) };
  renderAttachments();
  textarea.focus();
}

/**
 * Drop, paste or pick screenshots and they go straight in: no extra click.
 * Several at once are handled one after another, each as its own turn.
 */
const sendQueue = [];
async function sendScreenshots(files) {
  const images = [...files].filter((f) => f && f.type.startsWith("image/"));
  if (!images.length) return toast("Drop a screenshot image (PNG, JPEG, GIF or WebP).");
  if (!$("#view-chat").classList.contains("active")) {
    location.hash = "#/new";
    await route();
  }
  // Screenshots are always answered for one client's chat; in New chat, ask which first.
  const chosen = state.route.view === "client" ? state.route.clientId : Number($("#composer-client").value) || null;
  if (!chosen) return askWhichClient(images);
  if (state.route.view !== "client") {
    location.hash = `#/client/${chosen}`;
    await route();
  }
  const draining = sendQueue.length > 0 || state.busy;
  sendQueue.push(...images);
  if (draining) return toast(`Queued ${images.length} screenshot${images.length === 1 ? "" : "s"}; they'll go once the current one is done.`);
  while (sendQueue.length) {
    while (state.busy) await new Promise((r) => setTimeout(r, 200));
    await attach(sendQueue.shift());
    await sendComposer();
  }
}

function clearAttachment() {
  if (state.attachment) URL.revokeObjectURL(state.attachment.url);
  state.attachment = null;
}

function renderAttachments() {
  const box = $("#attachments");
  const items = [];
  if (state.attachment) {
    items.push(
      el(
        "div",
        { class: "attachment" },
        el("img", { src: state.attachment.url, alt: "Attached screenshot" }),
        el("button", { type: "button", "aria-label": "Remove", onclick: () => (clearAttachment(), renderAttachments()) }, "✕"),
      ),
    );
  }
  if (state.editing) {
    items.push(
      el(
        "span",
        { class: "chip" },
        "Editing an earlier objection ",
        el("a", { href: "#", onclick: (e) => (e.preventDefault(), (state.editing = null), renderAttachments()) }, "✕"),
      ),
    );
  }
  box.replaceChildren(...items);
  box.hidden = items.length === 0;
}

$("#attach-btn").addEventListener("click", () => fileInput.click());
$("#hero-drop").addEventListener("click", () => fileInput.click());
$("#hero-drop").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && fileInput.click());
fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  sendScreenshots(files);
});
document.addEventListener("paste", (e) => {
  if (!$("#view-chat").classList.contains("active")) return;
  const files = [...e.clipboardData.items].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile());
  if (files.length) {
    e.preventDefault();
    sendScreenshots(files);
  }
});

// Drag and drop works anywhere in the app (not just the chat), and never lets
// the browser navigate away to show the dropped image. The library page keeps
// its own document upload, so drops there are left alone.
const dropOverlay = $("#drop-overlay");
const draggingFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
const dropIgnored = () => $("#view-library").classList.contains("active") || $("#import-dialog").open;
const isCsv = (f) => /\.(csv|tsv|txt)$/i.test(f.name) || /csv|tab-separated/.test(f.type);
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e) || dropIgnored()) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!draggingFiles(e) || dropIgnored()) return;
  if (--dragDepth <= 0) (dropOverlay.hidden = true), (dragDepth = 0);
});
window.addEventListener("dragover", (e) => {
  if (!draggingFiles(e) || dropIgnored()) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", (e) => {
  if (!draggingFiles(e) || dropIgnored()) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const csv = [...e.dataTransfer.files].find(isCsv);
  if (csv) {
    if (!$("#view-clients").classList.contains("active")) location.hash = "#/clients";
    openImport(csv);
    return;
  }
  sendScreenshots(e.dataTransfer.files);
});

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendComposer();
});

async function sendComposer() {
  if (state.busy) return;
  const text = textarea.value.trim();
  const steer = $("#composer-steer").value.trim();
  const attachment = state.attachment;
  const editing = state.editing;
  if (!text && !attachment) return textarea.focus();

  const chosenClientId =
    state.route.view === "client" ? state.route.clientId : Number($("#composer-client").value) || null;

  textarea.value = "";
  autosize();
  state.attachment = null; // its preview URL stays alive until this turn finishes
  state.editing = null;
  renderAttachments();

  if (attachment) {
    // With a screenshot, anything typed alongside it is treated as a steer.
    if (!chosenClientId) {
      URL.revokeObjectURL(attachment.url);
      return askWhichClient([attachment.file]);
    }
    await runScreenshot(attachment, chosenClientId, [steer, text].filter(Boolean).join(". "));
    URL.revokeObjectURL(attachment.url);
  } else {
    if (!chosenClientId) {
      liveTurn({ objection: text }).fail("Choose the client first: open their chat from the list, or pick them in the selector next to ＋.");
      return;
    }
    await runTurn({
      clientId: chosenClientId,
      objection: text,
      threadContext: editing?.threadContext ?? "",
      prospect: editing?.prospect ?? "",
      imageId: editing?.imageId ?? null,
      guidance: steer,
    });
  }
}

// ================================================================ the pipeline, as a live chat turn

/** A provisional turn at the bottom of the thread while work is in progress. */
function liveTurn(bubble) {
  $("#hero").hidden = true;
  $("#view-chat").classList.remove("is-empty");
  const steps = el("div", { class: "pending" });
  const node = el("div", { class: "turn live" }, userBubble(bubble), el("div", { class: "assistant" }, steps));
  $("#thread").append(node);
  scrollToBottom();
  return {
    node,
    steps(names) {
      steps.replaceChildren(...names.map((n) => el("div", { class: "step", "data-step": n }, n)));
    },
    set(name, status) {
      const s = steps.querySelector(`[data-step="${name}"]`);
      if (s) s.className = `step ${status}`;
    },
    fail(msg) {
      steps.replaceWith(el("div", { class: "notice error" }, msg));
      scrollToBottom();
    },
    replace(content) {
      steps.replaceWith(content);
      scrollToBottom();
    },
    remove() {
      node.remove();
    },
  };
}

async function runScreenshot(attachment, clientId, guidance) {
  state.busy = true;
  const live = liveTurn({ imageUrl: attachment.url, guidance });
  live.steps(["Reading screenshot", "Writing three replies"]);
  live.set("Reading screenshot", "active");
  try {
    const form = new FormData();
    form.append("screenshot", attachment.file);
    form.append("clientId", String(clientId));
    const { extraction, imageId } = await api("/api/analyze", { method: "POST", body: form });
    if (extraction.notes) toast(extraction.notes);
    live.remove();
    state.busy = false;
    await runTurn({
      clientId,
      objection: extraction.objection_text,
      threadContext: extraction.thread_context,
      prospect: [
        extraction.prospect_name,
        [extraction.prospect_headline, extraction.prospect_location && `based in ${extraction.prospect_location}`].filter(Boolean).join(", "),
      ].filter(Boolean).join(" - "),
      imageId,
      guidance,
      channel: extraction.channel,
    });
  } catch (err) {
    state.busy = false;
    live.fail(`${err.message} You can also type the objection instead.`);
  }
}

/** New chat with no client chosen: ask which client these screenshots belong to, then continue in that chat. */
function askWhichClient(files) {
  $("#hero").hidden = true;
  $("#view-chat").classList.remove("is-empty");
  const select = el(
    "select",
    {},
    el("option", { value: "" }, "Choose a client…"),
    ...state.clients.map((c) => el("option", { value: c.id }, c.company ? `${c.name} (${c.company})` : c.name)),
  );
  const notice = el(
    "div",
    { class: "turn live" },
    el(
      "div",
      { class: "notice" },
      el(
        "div",
        {},
        state.clients.length
          ? `Which client is ${files.length === 1 ? "this screenshot" : `are these ${files.length} screenshots`} for? Replies use only that client's info.`
          : "Add a client under Manage clients first, then drop the screenshot into their chat.",
      ),
      state.clients.length > 0 &&
        el(
          "div",
          { class: "row" },
          select,
          el(
            "button",
            {
              class: "primary",
              onclick: async () => {
                if (!select.value) return select.focus();
                notice.remove();
                $("#composer-client").value = select.value;
                await sendScreenshots(files);
              },
            },
            "Continue",
          ),
        ),
    ),
  );
  $("#thread").append(notice);
  scrollToBottom();
  select.focus();
}

async function runTurn(ctx) {
  state.busy = true;
  // Make sure we're looking at the right chat before the reply lands.
  if (state.route.view !== "client" || state.route.clientId !== ctx.clientId) {
    history.replaceState(null, "", `#/client/${ctx.clientId}`);
    await route();
  }
  const live = liveTurn({
    imageUrl: ctx.imageId ? `/api/images/${ctx.imageId}` : null,
    objection: ctx.objection,
    prospect: ctx.prospect,
    guidance: ctx.guidance,
  });
  live.steps(["Writing three replies"]);
  live.set("Writing three replies", "active");
  const [prospectName, ...headline] = (ctx.prospect || "").split(" - ");
  try {
    const turn = await api(
      "/api/generate",
      json("POST", {
        clientId: ctx.clientId,
        objection: ctx.objection,
        threadContext: ctx.threadContext || "",
        prospectName: prospectName?.trim() || null,
        prospectHeadline: headline.join(" - ").trim() || null,
        channel: ctx.channel,
        guidance: ctx.guidance || "",
        imageId: ctx.imageId || null,
      }),
    );
    live.remove();
    if (state.route.clientId === ctx.clientId) {
      state.turns.push(turn);
      $("#thread").append(turnView(turn));
      scrollToBottom();
    }
    loadClients();
  } catch (err) {
    live.fail(err.message);
  } finally {
    state.busy = false;
  }
}

// ================================================================ saved replies drawer

$("#saved-btn").addEventListener("click", () => {
  $("#saved-drawer").hidden = !$("#saved-drawer").hidden;
  renderFavorites();
});
$("#saved-close").addEventListener("click", () => ($("#saved-drawer").hidden = true));
$("#fav-filter").addEventListener("change", renderFavorites);

function renderFavorites() {
  const filter = $("#fav-filter").value;
  const shown = state.favorites.filter((f) => !filter || f.strategy === filter);
  $("#fav-list").replaceChildren(
    ...(shown.length
      ? shown.map(favoriteItem)
      : [el("p", { class: "empty" }, state.favorites.length ? "None saved for this goal yet." : "Nothing saved yet. Star a reply in the chat to keep it here.")]),
  );
}

function favoriteItem(fav) {
  return el(
    "div",
    { class: "fav" },
    el(
      "div",
      { class: "meta" },
      el("span", { class: "badge" }, GOALS[fav.strategy] || fav.strategy),
      fav.prospect_name && el("span", {}, `to ${fav.prospect_name.split(" - ")[0]}`),
      el("span", {}, relTime(fav.created_at)),
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
            state.favorites = state.favorites.filter((f) => f.id !== fav.id);
            renderFavorites();
            renderHeader();
            renderThread();
          },
        },
        "Remove",
      ),
    ),
  );
}

// ================================================================ manage clients

const clientForm = $("#client-form");

const FIELD_LABELS = {
  name: "Name",
  aliases: "Other names",
  company: "Company",
  service_type: "Service type",
  target_audience: "Who they target",
  tone: "Tone",
  formality: "Formality",
  style_notes: "Style notes",
  sample_messages: "Sample messages",
  booking_link: "Booking link",
  country: "Country",
};
/** The details that shape replies most; a client missing any of these is flagged for account managers. */
const KEY_FIELDS = ["country", "service_type", "target_audience", "tone", "style_notes"];
const missingKey = (c) => KEY_FIELDS.filter((f) => !String(c[f] ?? "").trim());

function renderClientList() {
  const q = $("#client-search").value.toLowerCase();
  const incomplete = state.clients.filter((c) => missingKey(c).length);
  const chip = $("#needs-filter");
  chip.hidden = incomplete.length === 0;
  if (!incomplete.length) state.needsFilter = false;
  chip.textContent = state.needsFilter ? `${incomplete.length} need details · Show all` : `${incomplete.length} need details`;
  chip.classList.toggle("on", !!state.needsFilter);

  const shown = state.clients.filter(
    (c) =>
      (!state.needsFilter || missingKey(c).length) &&
      [c.name, c.company, c.service_type, ...c.aliases].join(" ").toLowerCase().includes(q),
  );
  $("#client-list").replaceChildren(
    ...(shown.length
      ? shown.map((c) =>
          el(
            "li",
            { class: c.id === state.editingClientId ? "active" : "", onclick: () => (location.hash = `#/clients/${c.id}`) },
            el("span", {}, c.name),
            el("span", { class: "sub" }, [c.company, c.service_type].filter(Boolean).join(" · ") || "No details yet"),
            missingKey(c).length > 0 && el("span", { class: "needs" }, "Needs details"),
          ),
        )
      : [el("li", { class: "sub" }, state.clients.length ? "No matches" : "No clients yet")]),
  );
}
$("#needs-filter").addEventListener("click", () => {
  state.needsFilter = !state.needsFilter;
  renderClientList();
});
$("#client-search").addEventListener("input", renderClientList);

function editClient(id) {
  const client = state.clients.find((c) => c.id === id) ?? null;
  state.editingClientId = client?.id ?? null;
  for (const field of clientForm.elements) {
    if (!field.name) continue;
    const v = client?.[field.name];
    field.value = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }
  $("#client-form-title").textContent = client ? `Edit ${client.name}` : "Add a client";
  const missing = client ? missingKey(client) : [];
  $("#client-missing").hidden = missing.length === 0;
  $("#client-missing").textContent = `Still to fill in: ${missing.map((f) => FIELD_LABELS[f]).join(", ")}. These shape how replies sound for this client.`;
  $("#delete-client").hidden = !client;
  $("#open-chat").hidden = !client;
  $("#client-form-msg").textContent = "";
  renderClientList();
}

$("#new-client").addEventListener("click", () => {
  location.hash = "#/clients";
  editClient(null);
  clientForm.elements.name.focus();
});
$("#open-chat").addEventListener("click", () => (location.hash = `#/client/${state.editingClientId}`));

clientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(clientForm));
  const id = state.editingClientId;
  try {
    const saved = id ? await api(`/api/clients/${id}`, json("PUT", body)) : await api("/api/clients", json("POST", body));
    await loadClients();
    location.hash = `#/clients/${saved.id}`;
    editClient(saved.id);
    toast(id ? "Client updated" : "Client added");
  } catch (err) {
    $("#client-form-msg").textContent = err.message;
  }
});

$("#delete-client").addEventListener("click", async () => {
  const client = state.clients.find((c) => c.id === state.editingClientId);
  if (!client || !confirm(`Remove ${client.name}? Their chat history and saved replies will be deleted too.`)) return;
  await api(`/api/clients/${client.id}`, { method: "DELETE" });
  await loadClients();
  location.hash = "#/clients";
  editClient(null);
  toast("Client removed");
});

// ================================================================ CSV import

const importDialog = $("#import-dialog");
let importFile = null;

function showImportStep(step) {
  $("#import-step-file").hidden = step !== "file";
  $("#import-step-preview").hidden = step !== "preview";
}

function openImport(file) {
  importFile = null;
  $("#import-error").textContent = "";
  showImportStep("file");
  if (!importDialog.open) importDialog.showModal();
  if (file) previewImport(file);
}

async function postImport(file, extra = {}) {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return api("/api/clients/import", { method: "POST", body: form });
}

const STATUS_VIEW = {
  new: ["Will be added", "new"],
  existing: ["Already on file", "existing"],
  duplicate: ["Skipped: listed twice", "skip"],
  invalid: ["Skipped: no name", "skip"],
};

async function previewImport(file) {
  $("#import-error").textContent = "";
  let plan;
  try {
    plan = await postImport(file);
  } catch (err) {
    $("#import-error").textContent = err.message;
    return;
  }
  importFile = file;
  const { counts } = plan;
  const skipped = counts.duplicate + counts.invalid;
  $("#import-summary").replaceChildren(
    el("strong", {}, file.name), ": ",
    `${counts.new} new client${counts.new === 1 ? "" : "s"}`,
    counts.existing ? `, ${counts.existing} already on file` : "",
    skipped ? `, ${skipped} skipped` : "",
    ".",
  );
  $("#import-columns").replaceChildren(
    el("span", { class: "muted small" }, "Columns: "),
    ...plan.columns.map((c) =>
      el(
        "span",
        { class: `chip ${c.field ? "mapped" : "ignored"}`, title: c.field ? `→ ${FIELD_LABELS[c.field]}` : "Not used" },
        c.field ? `${c.header} → ${FIELD_LABELS[c.field]}` : c.header,
      ),
    ),
  );
  $("#import-rows").replaceChildren(
    ...plan.rows.map((r) => {
      const [label, cls] = STATUS_VIEW[r.status];
      const detail =
        r.status === "existing"
          ? r.fillable.length
            ? `${r.reason}. Can fill: ${r.fillable.map((f) => FIELD_LABELS[f]).join(", ")}`
            : `${r.reason}. Nothing new to add`
          : r.reason;
      return el(
        "tr",
        {},
        el("td", { class: "small muted" }, String(r.line)),
        el("td", {}, el("div", {}, r.client.name || "—"), r.client.company && el("div", { class: "muted small" }, r.client.company)),
        el("td", {}, el("span", { class: `badge status-${cls}` }, label), detail && r.status !== "new" && el("div", { class: "muted small" }, detail)),
        el("td", { class: "blank-list" }, r.status === "new" ? r.missing.map((f) => FIELD_LABELS[f]).join(", ") || "Nothing, fully filled in" : ""),
      );
    }),
  );
  const fillable = plan.rows.filter((r) => r.status === "existing" && r.fillable.length).length;
  $("#fill-blanks-label").hidden = fillable === 0;
  $("#fill-blanks").checked = false;
  $("#fill-blanks-text").textContent = `Also fill in blank fields on ${fillable} client${fillable === 1 ? "" : "s"} already on file (nothing gets overwritten)`;
  const updateCommit = () => {
    const n = counts.new + ($("#fill-blanks").checked ? fillable : 0);
    $("#import-commit").disabled = n === 0;
    $("#import-commit").textContent = counts.new
      ? `Add ${counts.new} client${counts.new === 1 ? "" : "s"}${$("#fill-blanks").checked ? ` and update ${fillable}` : ""}`
      : $("#fill-blanks").checked ? `Update ${fillable} client${fillable === 1 ? "" : "s"}` : "Nothing to import";
  };
  $("#fill-blanks").onchange = updateCommit;
  updateCommit();
  showImportStep("preview");
}

$("#import-btn").addEventListener("click", () => openImport());
$("#import-close").addEventListener("click", () => importDialog.close());
$("#import-back").addEventListener("click", () => openImport());
$("#import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) previewImport(file);
});
const importDrop = $("#import-drop");
importDrop.addEventListener("dragover", (e) => (e.preventDefault(), importDrop.classList.add("over")));
importDrop.addEventListener("dragleave", () => importDrop.classList.remove("over"));
importDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  importDrop.classList.remove("over");
  const file = e.dataTransfer.files[0];
  if (file) previewImport(file);
});

$("#import-commit").addEventListener("click", async () => {
  const btn = $("#import-commit");
  btn.disabled = true;
  try {
    const result = await postImport(importFile, { commit: "true", fillBlanks: String($("#fill-blanks").checked) });
    importDialog.close();
    await loadClients();
    state.needsFilter = state.clients.some((c) => missingKey(c).length) && result.created > 0;
    renderClientList();
    const parts = [];
    if (result.created) parts.push(`Added ${result.created} client${result.created === 1 ? "" : "s"}`);
    if (result.updated) parts.push(`updated ${result.updated}`);
    toast(`${parts.join(", ") || "Nothing changed"}. Clients missing details are flagged for account managers.`);
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
});

// ================================================================ library

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

// ================================================================ account

async function loadMe() {
  const me = await api("/api/me");
  $("#who").textContent = me.name ? `${me.name} · ${me.email}` : me.email;
  $("#who").title = me.email;
  $("#admin-link").hidden = !me.isOwner;
  $("#password-form").elements.username.value = me.email;
}

$("#logout-btn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.replace("/login");
});

const pwDialog = $("#password-dialog");
$("#password-btn").addEventListener("click", () => {
  $("#password-form").reset();
  $("#password-msg").textContent = "";
  pwDialog.showModal();
});
$("#password-cancel").addEventListener("click", () => pwDialog.close());
$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api("/api/me/password", json("POST", { current: form.elements.current.value, password: form.elements.password.value }));
    pwDialog.close();
    toast("Password updated. Your other devices were signed out.");
  } catch (err) {
    $("#password-msg").textContent = err.message;
  }
});

// ================================================================ boot

Promise.all([loadMe(), loadClients()])
  .then(route)
  .catch((err) => toast(err.message));
