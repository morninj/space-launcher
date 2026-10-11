// Runs on claude.ai. Asks the service worker whether this tab was opened to
// carry a prompt over from the launcher; if it was, waits for the composer to
// exist, sets the model and effort that were asked for, types the prompt in
// and sends it. Anything that does not go to plan leaves the prompt sitting in
// the box unsent, with what went wrong shown in the corner — a chat started on
// the wrong model is worse than one that waits for a keystroke.

const EDITOR = '[data-testid="chat-input"], [contenteditable="true"].ProseMirror';
const PATIENCE = 20000; // claude.ai hydrates before the composer exists
const MARK = "#launcher="; // how the request rides over on the URL
const PICKER = '[data-testid="model-selector-dropdown"]';
const SEND = '[data-testid="chat-input-send"]';
const MENU_PATIENCE = 5000;

// Quiet on every claude.ai page: console.debug is hidden at Chrome's default
// log level. The attribute is the same fact in a form a console can be asked
// for after the event: document.documentElement.dataset.launcher.
console.debug("[space-launcher] claude.js running on", location.pathname);
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

    const done = (el) => {
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(el);
    };

    const look = () => {
      const el = find(selector);
      if (el) done(el);
    };

    const observer = new MutationObserver(look);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // A poll as well as the observer: an element can go from hidden to shown
    // without the document changing at all — a transition, a class on an
    // ancestor — and nothing would call the observer back for that.
    const poll = setInterval(look, 60);
    const timer = setTimeout(() => done(null), patience);
  });
}

// A real mouse sends pointer and mouse events before the click; menus built on
// Base UI open on the first of those, so a bare .click() goes unnoticed.
function press(el) {
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;

  // A real click lands on whatever is topmost at that point, which in these
  // layouts is usually a span painted over the button. Handlers that read
  // coordinates, or that watch the element the pointer is actually over, see
  // nothing at all from an event aimed at the wrapper with no position on it.
  const under = box.width ? document.elementFromPoint(x, y) : null;
  const aim = under && el.contains(under) ? under : el;

  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    detail: 1,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  const up = { ...opts, buttons: 0 };

  aim.dispatchEvent(new PointerEvent("pointerover", opts));
  aim.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
  aim.dispatchEvent(new PointerEvent("pointermove", opts));
  aim.dispatchEvent(new PointerEvent("pointerdown", opts));
  aim.dispatchEvent(new MouseEvent("mousedown", opts));
  aim.dispatchEvent(new PointerEvent("pointerup", up));
  aim.dispatchEvent(new MouseEvent("mouseup", up));
  aim.dispatchEvent(new MouseEvent("click", up));
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
  if (!el || el.getClientRects().length === 0) return false;
  // A box in the layout is not the same as being on screen: these pages keep
  // a second, hidden copy of the composer's buttons, and pressing that one
  // does nothing at all. Both of those copies are marked inert and hidden,
  // which is what this catches.
  //
  // Opacity is deliberately not part of it. These menus fade in, so a popup
  // is transparent for the first frames of its life — judging it on opacity
  // means calling a menu that is opening "not open".
  if (el.closest("[inert]")) return false;
  return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
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

const CODES = { Enter: 13, Escape: 27, ArrowRight: 39 };

function key(el, name) {
  const code = CODES[name] ?? 0;
  const opts = {
    key: name,
    code: name,
    keyCode: code, // deprecated, and still what some editors read
    which: code,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  // Some handlers hang off keypress or keyup rather than keydown, and one
  // extra event costs nothing.
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (name === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// One visit to the menu does all three. The order is what keeps it to one: the
// effort levels and the thinking switch share a submenu and leave the parent
// menu standing, while choosing a model closes the whole tree behind it — so
// the model goes last, and its click doubles as the way out.
// Two kinds of trouble: what the chat is answered with, which is worth
// stopping for, and the thinking switch, which is not — a chat on the right
// model at the right effort is the chat that was asked for either way.
async function settings({ model, effort }, safe) {
  const asked = Boolean(model || effort);
  const picker = document.querySelector(PICKER);
  if (!picker) return { blocking: asked ? ["no model picker on the page"] : [], noted: [] };

  const reads = (text) =>
    new RegExp(text, "i").test(picker.getAttribute("aria-label") ?? picker.textContent ?? "");
  const blocking = [];
  const noted = [];

  if (!(await openMenu(picker))) {
    const why = "the model menu would not open";
    return asked ? { blocking: [why], noted: [] } : { blocking: [], noted: [why] };
  }

  const inner = await effortAndThinking(effort);
  blocking.push(...inner.blocking);
  noted.push(...inner.noted);

  if (model && !reads(model)) {
    const wanted = `[role="menuitemradio"][data-model-id*="${model.toLowerCase()}" i]`;
    // The effort may have taken the menu down with it; if so, go back in.
    if (!find(wanted)) await openMenu(picker);
    const item = find(wanted);
    if (!item) {
      const offered = [...document.querySelectorAll("[role=menuitemradio][data-model-id]")]
        .filter(shown)
        .map((el) => el.dataset.modelId);
      blocking.push(
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
      blocking.push(`${model} would not stick`);
    }
  }

  // Not awaited: whether a menu has finished folding away is no business of
  // the prompt about to be typed. It is a no-op anyway when the model's own
  // click already closed the tree.
  void dismiss(safe);
  return { blocking, noted };
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
  const blocking = [];
  const noted = [];
  if (!(await openEffort())) {
    const why = "the effort submenu would not open";
    return effort ? { blocking: [why], noted: [] } : { blocking: [], noted: [why] };
  }

  const thinking = byText("menuitemcheckbox", /thinking/i);
  if (!thinking) {
    noted.push("no thinking switch found");
  } else if (thinking.getAttribute("aria-checked") !== "true") {
    const on = await choose(thinking, () => thinking.getAttribute("aria-checked") === "true");
    if (!on) noted.push("thinking stayed off");
  }

  if (!effort) return { blocking, noted };

  const pick = `[role=menuitemradio][data-effort-id="${effort.id}"]`;
  if (!find(pick) && !(await openEffort())) {
    blocking.push(`could not get back to the effort menu for ${effort.label}`);
    return { blocking, noted };
  }

  const item = find(pick);
  if (!item) {
    const offered = [...document.querySelectorAll("[role=menuitemradio][data-effort-id]")]
      .filter(shown)
      .map((el) => el.dataset.effortId);
    blocking.push(
      offered.length
        ? `no ${effort.label}; menu offers ${offered.join(", ")}`
        : `no ${effort.label} entry`,
    );
    return { blocking, noted };
  }

  const took = await choose(
    item,
    () =>
      item.getAttribute("aria-checked") === "true" ||
      new RegExp(effort.label, "i").test(document.querySelector(PICKER)?.textContent ?? ""),
  );
  if (!took) blocking.push(`${effort.label} would not stick`);
  return { blocking, noted };
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

// The button is the same one a person would reach for; the composer also sends
// on enter, which is the fallback. Either way the proof is the box going empty.
function caretToEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function submit(editor) {
  // Sending is proved three ways, because the composer this started in may be
  // replaced wholesale by the chat it turns into: the box goes empty, or the
  // element is no longer in the document, or the address is a chat.
  const sent = () =>
    !editor.isConnected ||
    !editor.textContent.trim() ||
    /\/chat\//.test(location.pathname);

  const enabled = () => {
    const el = find(SEND);
    return el && !el.disabled && el.getAttribute("aria-disabled") !== "true" ? el : null;
  };

  // The send button stays disabled until the app has registered the text, and
  // that is also the app saying it is ready to be asked.
  await settle(() => Boolean(enabled()), 2500);

  // Three ways to ask, each tried on its own and checked before the next, so
  // that a send which did work is never asked for twice in a row.
  const ways = [
    () => {
      const button = enabled();
      if (button) press(button);
    },
    () => {
      // The element's own click, which is the path the app's own code uses.
      enabled()?.click();
    },
    () => {
      // The composer sends on enter like any other — but only with the caret
      // in it, which a trip through the menus may have taken.
      editor.focus();
      caretToEnd(editor);
      key(editor, "Enter");
    },
  ];

  for (let round = 0; round < 2; round++) {
    for (const ask of ways) {
      if (sent()) return null;
      ask();
      if (await settle(sent, 1500)) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return enabled()
    ? "asked six ways and nothing went"
    : find(SEND)
      ? "the send button stayed disabled"
      : "no send button found";
}

// What claude.ai itself keeps about these settings. If the app remembers them
// client-side, writing them before it starts would set the model and effort
// outright and none of the menu driving above would be needed — so a failure
// says what is there, which is the one thing that could retire all of it.
function remembered() {
  try {
    const keys = Object.keys(localStorage).filter((k) => /model|effort|think/i.test(k));
    return keys.length ? ` · it remembers: ${keys.slice(0, 6).join(", ")}` : " · it remembers nothing";
  } catch {
    return "";
  }
}

(async () => {
  const request = fromUrl() ?? (await fromWorker());
  const prompt = request?.prompt;
  const model = request?.model;
  const effort = request?.effort;
  console.log(
    "[space-launcher] prompt to hand over:",
    prompt ? `${prompt.length} chars` : "none — nothing in the fragment or the worker",
    model ? `on ${model}` : "",
  );
  if (!prompt) return;

  await bodyReady();
  const status = overlay([model, effort?.label].filter(Boolean).join(" · "));

  const editor = await waitFor(EDITOR);
  if (!editor) {
    status.failed("Could not find Claude's prompt box — your text is on the clipboard");
    navigator.clipboard?.writeText(prompt).catch(() => {});
    return;
  }

  // One frame for the editor to finish mounting before touching anything.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  // Menus are driven only once the page has finished loading and the picker
  // is there. Starting earlier, in parallel with the wait above, was quicker
  // and much less reliable: a button that exists is not yet a button whose
  // handlers are attached, and a press that lands before they are does
  // nothing and says nothing.
  const settled = (async () => {
    if (document.readyState !== "complete") {
      await Promise.race([
        new Promise((resolve) => addEventListener("load", resolve, { once: true })),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    }
    if (!(await waitFor(PICKER, 8000))) {
      const why = "no model picker on the page";
      return model || effort ? { blocking: [why], noted: [] } : { blocking: [], noted: [why] };
    }
    return settings({ model, effort }, null);
  })();

  // The settings first, so that typing the prompt is the last thing that
  // happens and the cursor is left where it belongs. The model has to be
  // chosen before the effort: picking one closes the menu.
  // Thinking is set even when no model or effort was asked for, but it never
  // stands in the way of sending.
  const { blocking, noted } = await settled;
  if (blocking.length || noted.length) {
    console.log("[space-launcher] settings:", [...blocking, ...noted].join("; "));
  }

  if (fill(editor, prompt)) {
    // Only the model and the effort hold a send back: a chat answered by the
    // wrong one cannot be taken back, while an unsent prompt costs a keystroke.
    if (blocking.length) {
      status.failed(`Prompt ready, unsent. ${blocking.join("; ")}${remembered()}`);
      return;
    }
    const unsent = await submit(editor);
    if (unsent) status.failed(`Prompt ready — ${unsent}`);
    else if (noted.length) status.failed(`Sent. ${noted.join("; ")}`);
    else status.done();
  } else {
    status.failed("Could not fill the prompt box — your text is on the clipboard");
    navigator.clipboard?.writeText(prompt).catch(() => {});
  }
})();
