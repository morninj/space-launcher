const DEFAULT_LINKS = [
  { id: "asana", title: "Asana", url: "https://app.asana.com/" },
  { id: "gmail", title: "Gmail", url: "https://mail.google.com/" },
  { id: "calendar", title: "Calendar", url: "https://calendar.google.com/" },
];

const NEW = Symbol("new");

const list = document.getElementById("links");
let links = DEFAULT_LINKS;
let editing = null; // a link id, NEW, or null
let selected = 0; // index into links, for j/k navigation

// Storage can be missing (extension not reloaded since the "storage" permission
// was added). Fall back to the defaults rather than leaving the page blank.
async function load() {
  try {
    const stored = await chrome.storage.sync.get({ links: DEFAULT_LINKS });
    links = stored.links;
  } catch (error) {
    console.error("[homepage-links] could not read storage", error);
  }
  render();
}

async function save() {
  try {
    await chrome.storage.sync.set({ links });
  } catch (error) {
    console.error("[homepage-links] could not write storage", error);
  }
}

// Accepts "asana.com" as readily as a full URL.
function normalizeUrl(value) {
  const url = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function button(label, className, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function linkRow(link, index) {
  const li = document.createElement("li");
  if (index === selected) li.className = "selected";

  const a = document.createElement("a");
  a.href = link.url;
  a.textContent = link.title;
  a.addEventListener("focus", () => {
    if (index === selected) return;
    selected = index;
    render();
    focusSelected();
  });

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Edit", "icon", () => {
      editing = link.id;
      render();
    }),
    button("Delete", "icon", async () => {
      links = links.filter((l) => l.id !== link.id);
      await save();
      render();
    }),
  );

  li.append(a, actions);
  return li;
}

function editRow(link) {
  const li = document.createElement("li");
  li.className = "editing";

  const form = document.createElement("form");

  const title = document.createElement("input");
  title.type = "text";
  title.placeholder = "Name";
  title.value = link?.title ?? "";
  title.required = true;

  const url = document.createElement("input");
  url.type = "text";
  url.placeholder = "URL";
  url.value = link?.url ?? "";
  url.required = true;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "icon";
  submit.textContent = "Save";

  form.append(
    title,
    url,
    submit,
    button("Cancel", "icon", () => {
      editing = null;
      render();
    }),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const next = {
      id: link?.id ?? crypto.randomUUID(),
      title: title.value.trim(),
      url: normalizeUrl(url.value),
    };
    links = link
      ? links.map((l) => (l.id === link.id ? next : l))
      : [...links, next];
    editing = null;
    await save();
    render();
  });

  li.append(form);
  queueMicrotask(() => title.focus());
  return li;
}

function addRow() {
  const li = document.createElement("li");
  li.className = "add";
  li.append(
    button("+ Add link", "add-button", () => {
      editing = NEW;
      render();
    }),
  );
  return li;
}

function render() {
  selected = Math.max(0, Math.min(selected, links.length - 1));
  list.replaceChildren(
    ...links.map((link, i) =>
      editing === link.id ? editRow(link) : linkRow(link, i),
    ),
    editing === NEW ? editRow(null) : addRow(),
  );
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function move(delta) {
  selected = Math.max(0, Math.min(selected + delta, links.length - 1));
  render();
  focusSelected();
}

function focusSelected() {
  list.querySelector(".selected a")?.focus({ preventScroll: true });
}

function open(link, newTab) {
  if (newTab) window.open(link.url, "_blank");
  else location.assign(link.url);
}

document.addEventListener("keydown", (event) => {
  // While a form is open the keys belong to the inputs.
  if (editing !== null) {
    if (event.key === "Escape") {
      editing = null;
      render();
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // Let a focused button handle its own Enter.
  if (event.target.closest?.("button")) return;

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter" && links[selected]) {
    event.preventDefault();
    open(links[selected], event.shiftKey);
  }
});

render();
// Chrome reserves focus for the omnibox on new tabs and ignores focus() from an
// override page, so this only takes effect when the page is opened directly;
// otherwise the first click or Tab hands focus to the list.
focusSelected();
load();
