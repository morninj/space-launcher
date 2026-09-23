// Runs on claude.ai. Asks the service worker whether this tab was opened to
// carry a prompt over from the launcher; if it was, waits for the composer to
// exist and types the prompt into it. Nothing is sent — the prompt is left in
// the box, with the cursor after it, for you to read before pressing enter.

const EDITOR = '[data-testid="chat-input"], [contenteditable="true"].ProseMirror';
const PATIENCE = 20000; // claude.ai hydrates before the composer exists
const MARK = "#launcher="; // how the request rides over on the URL
const PICKER = '[data-testid="model-selector-dropdown"]';
const MENU_PATIENCE = 5000;

// console.debug is hidden at Chrome's default log level, so this says its
// piece out loud. The attribute is the same fact in a form a console can be
// asked for after the event: document.documentElement.dataset.launcher.
console.log("[homepage-links] claude.js running on", location.pathname);
document.documentElement.dataset.launcher = "ready";

// The prompt arrives in the fragment, which never leaves the browser: no
// server sees it, and it does not depend on the worker being awake or on the
// tab being the one we think it is. It is read at document_start, before the
// app can rewrite the URL, and taken straight back out of the address bar.
function fromUrl() {
  const hash = location.hash;
  if (!hash.startsWith(MARK)) return null;
  const raw = decodeURIComponent(hash.slice(MARK.length));
  history.replaceState(null, "", location.pathname + location.search);
  try {
    return JSON.parse(raw);
  } catch {
    return { prompt: raw, model: null }; // plain text, from an older hand-off
  }
}

// The worker still knows, in case the fragment was lost on the way in.
async function fromWorker() {
  try {
    const answer = await Promise.race([
      chrome.runtime.sendMessage({ type: "claude-pending" }),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    return answer?.request ?? null;
  } catch {
    return null; // no worker listening; an ordinary visit to claude.ai
  }
}

// At document_start there may be no body to hang anything on yet.
function bodyReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

function overlay(model) {
  const box = document.createElement("div");
  box.style.cssText = `
    position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-radius: 8px;
    font: 13px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #cbcdcd; background: rgba(12, 13, 13, 0.92);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    opacity: 0; transition: opacity 140ms ease-out;
  `;

  const spinner = document.createElement("span");
  spinner.style.cssText = `
    width: 11px; height: 11px; border-radius: 50%; flex: none;
    border: 2px solid rgba(111, 207, 159, 0.25); border-top-color: #6fcf9f;
    animation: launcher-spin 640ms linear infinite;
  `;

  const label = document.createElement("span");
  label.textContent = model
    ? `Handing your prompt to ${model}`
    : "Handing your prompt to Claude";
  // `model` is whatever the row named — the model, the effort, or both.

  const style = document.createElement("style");
  style.textContent = "@keyframes launcher-spin { to { transform: rotate(360deg) } }";

  box.append(style, spinner, label);
  document.body.append(box);
  requestAnimationFrame(() => (box.style.opacity = "1"));

  return {
    done() {
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 200);
    },
    failed(message) {
      spinner.remove();
      label.textContent = message;
      box.style.maxWidth = "min(560px, 70vw)";
      setTimeout(() => {
        box.style.opacity = "0";
        setTimeout(() => box.remove(), 200);
      }, 12000);
    },
  };
}

// The composer arrives with the rest of the app, so watch for it rather than
// polling — and give up eventually rather than watching forever.
function waitFor(selector, patience = PATIENCE) {
  return new Promise((resolve) => {
    const found = find(selector);
    if (found) return resolve(found);

    const observer = new MutationObserver(() => {
      const el = find(selector);
      if (!el) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, patience);
  });
}

// A real mouse sends pointer and mouse events before the click; menus built on
// Base UI open on the first of those, so a bare .click() goes unnoticed.
function press(el) {
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
}

// Menus open on hover as readily as on a press, and Base UI watches for the
// pointer arriving before anything is clicked.
function hover(el) {
  const opts = { bubbles: true, composed: true, view: window, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", opts));
}

function settle(test, ms = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (test()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  });
}

// These menus stay mounted after they close, so the document can hold several
// copies of the same entry with only one of them on screen. Pressing a
// leftover does nothing and explains nothing, so nothing here is looked up
// without this filter.
function shown(el) {
  return Boolean(el) && el.getClientRects().length > 0;
}

function find(selector) {
  return [...document.querySelectorAll(selector)].find(shown) ?? null;
}

function byText(role, text) {
  return [...document.querySelectorAll(`[role="${role}"]`)].find(
    (el) => shown(el) && text.test(el.textContent ?? ""),
  );
}

// A press is how a mouse chooses; the keyboard is the second opinion.
async function choose(item, took) {
  press(item);
  if (await settle(took, 1200)) return true;
  item.focus?.();
  key(item, "Enter");
  return settle(took, 1200);
}

// Escape has to be aimed at the menu itself: these popups listen on their own
// element, and after a synthetic click the focus is usually on the body, where
// a keydown reaches nothing. Failing that, a press somewhere outside dismisses
// them the way a stray click would — the composer is the natural place to land,
// since that is where the cursor is wanted anyway.
async function dismiss(safe) {
  const open = () => find('[role="menu"]');
  if (!open()) return;

  for (const menu of document.querySelectorAll('[role="menu"]')) {
    if (shown(menu)) key(menu, "Escape");
  }
  if (await settle(() => !open(), 500)) return;

  press(safe ?? document.body);
  await settle(() => !open(), 500);
}

function key(el, name) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, composed: true }),
  );
}

// One visit to the menu does all three. The order is what keeps it to one: the
// effort levels and the thinking switch share a submenu and leave the parent
// menu standing, while choosing a model closes the whole tree behind it — so
// the model goes last, and its click doubles as the way out.
async function settings({ model, effort }, safe) {
  const picker = document.querySelector(PICKER);
  if (!picker) return ["no model picker on the page"];

  const reads = (text) =>
    new RegExp(text, "i").test(picker.getAttribute("aria-label") ?? picker.textContent ?? "");
  const problems = [];

  if (!(await openMenu(picker))) return ["the model menu would not open"];

  problems.push(...(await effortAndThinking(effort)));

  if (model && !reads(model)) {
    const wanted = `[role="menuitemradio"][data-model-id*="${model.toLowerCase()}" i]`;
    // The effort may have taken the menu down with it; if so, go back in.
    if (!find(wanted)) await openMenu(picker);
    const item = find(wanted);
    if (!item) {
      const offered = [...document.querySelectorAll("[role=menuitemradio][data-model-id]")]
        .filter(shown)
        .map((el) => el.dataset.modelId);
      problems.push(
        offered.length ? `no ${model}; menu offers ${offered.join(", ")}` : `no ${model} entry`,
      );
    } else if (
      !(await choose(
        item,
        // The entry marks itself chosen at once; the picker's label can take
        // its time catching up, and waiting on it wastes most of a second.
        () => item.getAttribute("aria-checked") === "true" || reads(model),
      ))
    ) {
      problems.push(`${model} would not stick`);
    }
  }

  // Not awaited: whether a menu has finished folding away is no business of
  // the prompt about to be typed. It is a no-op anyway when the model's own
  // click already closed the tree.
  void dismiss(safe);
  return problems;
}

async function openMenu(picker) {
  if (find("[role=menuitemradio][data-model-id]")) return true;
  picker.focus();
  press(picker);
  return Boolean(await waitFor("[role=menuitemradio][data-model-id]", MENU_PATIENCE));
}

// A submenu opens when the pointer arrives, so hovering is the whole of it.
// Pressing the trigger afterwards would only shut what the hover opened, which
// is why each way in is tried only while the way before it has left it closed.
async function openEffort() {
  const entry = byText("menuitem", /^\s*effort/i);
  if (!entry) return null;

  const ITEMS = "[role=menuitemradio][data-effort-id]";
  const open = () => entry.getAttribute("aria-expanded") === "true";

  if (!open()) {
    press(entry);
    if (await waitFor(ITEMS, 800)) return entry;
  }

  if (!open()) {
    hover(entry); // slower, since it waits out an intent delay, but surer
    if (await waitFor(ITEMS, 1500)) return entry;
  }

  if (!open()) {
    entry.focus?.();
    key(entry, "ArrowRight"); // the keyboard way into a submenu
    if (await waitFor(ITEMS, 1500)) return entry;
  }
  return null;
}

// Thinking first: choosing an effort closes the submenu behind it, while a
// switch leaves everything standing.
async function effortAndThinking(effort) {
  const problems = [];
  if (!(await openEffort())) return ["the effort submenu would not open"];

  const thinking = byText("menuitemcheckbox", /thinking/i);
  if (!thinking) {
    problems.push("no thinking switch found");
  } else if (thinking.getAttribute("aria-checked") !== "true") {
    const on = await choose(thinking, () => thinking.getAttribute("aria-checked") === "true");
    if (!on) problems.push("thinking would not turn on");
  }

  if (!effort) return problems;

  const pick = `[role=menuitemradio][data-effort-id="${effort.id}"]`;
  if (!find(pick) && !(await openEffort())) {
    problems.push(`could not get back to the effort menu for ${effort.label}`);
    return problems;
  }

  const item = find(pick);
  if (!item) {
    const offered = [...document.querySelectorAll("[role=menuitemradio][data-effort-id]")]
      .filter(shown)
      .map((el) => el.dataset.effortId);
    problems.push(
      offered.length
        ? `no ${effort.label}; menu offers ${offered.join(", ")}`
        : `no ${effort.label} entry`,
    );
    return problems;
  }

  const took = await choose(
    item,
    () =>
      item.getAttribute("aria-checked") === "true" ||
      new RegExp(effort.label, "i").test(document.querySelector(PICKER)?.textContent ?? ""),
  );
  if (!took) problems.push(`${effort.label} would not stick`);
  return problems;
}

// The composer is a ProseMirror document, not a textarea: assigning its text
// would leave the editor's own state untouched and the placeholder showing. So
// type into it the way a person would, and fall back to a paste event, which
// ProseMirror also handles, if the browser refuses the first.
function fill(editor, text) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  document.execCommand("insertText", false, text);
  if (editor.textContent.trim()) return true;

  const data = new DataTransfer();
  data.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
  return Boolean(editor.textContent.trim());
}

(async () => {
  const request = fromUrl() ?? (await fromWorker());
  const prompt = request?.prompt;
  const model = request?.model;
  const effort = request?.effort;
  console.log(
    "[homepage-links] prompt to hand over:",
    prompt ? `${prompt.length} chars` : "none — nothing in the fragment or the worker",
    model ? `on ${model}` : "",
  );
  if (!prompt) return;

  await bodyReady();
  const status = overlay([model, effort?.label].filter(Boolean).join(" · "));

  // The picker and the composer arrive together, so the menus are driven while
  // the composer is still being waited for rather than after it.
  const settled = (async () => {
    if (!(await waitFor(PICKER, PATIENCE))) return ["no model picker on the page"];
    return settings({ model, effort }, null);
  })();

  const editor = await waitFor(EDITOR);
  if (!editor) {
    status.failed("Could not find Claude's prompt box — your text is on the clipboard");
    navigator.clipboard?.writeText(prompt).catch(() => {});
    return;
  }

  // One frame for the editor to finish mounting before touching anything.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  // The settings first, so that typing the prompt is the last thing that
  // happens and the cursor is left where it belongs. The model has to be
  // chosen before the effort: picking one closes the menu.
  // Thinking is checked even when no model or effort was asked for.
  const trouble = await settled;
  if (trouble.length) console.log("[homepage-links] settings:", trouble.join("; "));

  if (fill(editor, prompt)) {
    if (trouble.length) status.failed(`Prompt ready. ${trouble.join("; ")}`);
    else status.done();
  } else {
    status.failed("Could not fill the prompt box — your text is on the clipboard");
    navigator.clipboard?.writeText(prompt).catch(() => {});
  }
})();
