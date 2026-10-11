// What a first-time install starts with: a few common places, and a folder to
// show that rows nest. Replaced wholesale by whatever is saved.
const DEFAULT_LINKS = [
  { id: "gmail", title: "Gmail", url: "https://mail.google.com/" },
  { id: "calendar", title: "Calendar", url: "https://calendar.google.com/" },
  { id: "github", title: "GitHub", url: "https://github.com/" },
  {
    id: "webb",
    title: "Webb",
    url: "",
    collapsed: true,
    children: [
      { id: "esawebb", title: "ESA/Webb pictures", url: "https://esawebb.org/images/" },
      { id: "nasawebb", title: "NASA Webb mission", url: "https://science.nasa.gov/mission/webb/" },
    ],
  },
];

const list = document.getElementById("links");
const search = document.getElementById("search");

let links = DEFAULT_LINKS;
let rows = []; // flattened visible rows; `selected` indexes into this
let selected = 0;
let editing = null; // {link} to edit, or {parent, index} to insert
let confirming = null; // id of the link awaiting delete confirmation
let query = ""; // search box contents, lowercased
// Nothing is chosen yet: the search box has focus and the box is empty, so no
// row is drawn as the active one. A search, or a step into the list, ends it.
let idle = true;

// Storage can be missing (extension not reloaded since the "storage" permission
// was added). Fall back to the defaults rather than leaving the page blank.
async function load() {
  try {
    const stored = await chrome.storage.sync.get({ links: DEFAULT_LINKS });
    links = stored.links;
  } catch (error) {
    console.error("[space-launcher] could not read storage", error);
  }
  collapseAll();
  render();
}

// Every folder in the tree, at whatever depth, parents before children.
function eachFolder(visit, siblings = links) {
  siblings.forEach((link) => {
    const children = childrenOf(link);
    if (!children.length) return;
    visit(link);
    eachFolder(visit, children);
  });
}

// Existing data may predate the rule that a folder is a heading.
function normalize() {
  eachFolder((link) => {
    link.url = "";
  });
}

function collapseAll() {
  eachFolder((link) => {
    link.collapsed = true;
  });
}

// Every save echoes back through the listener below as a change event. More
// than one can be in flight at a time — holding the reorder keys, or adding a
// link while the last write is still going — so each is remembered until its
// own echo returns, not just the latest. The timer is for the echo that never
// comes, when a write lands on an identical value.
const pending = new Set();

async function save() {
  const snapshot = JSON.stringify(links);
  pending.add(snapshot);
  setTimeout(() => pending.delete(snapshot), 5000);
  try {
    await chrome.storage.sync.set({ links });
  } catch (error) {
    console.error("[space-launcher] could not write storage", error);
  }
}

// Which folders are open, by id.
function folds() {
  const open = new Set();
  eachFolder((link) => {
    if (!link.collapsed) open.add(link.id);
  });
  return open;
}

// Folders this page had open stay open; ones it has not seen arrive folded.
function restoreFolds(open) {
  eachFolder((link) => {
    if (open.has(link.id)) delete link.collapsed;
    else link.collapsed = true;
  });
}

// Edits made on another computer (or in another open tab) arrive here. Skip the
// re-render mid-edit so the form under the cursor does not vanish.
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.links || editing !== null) return;
  // Our own save coming back around.
  if (pending.delete(JSON.stringify(changes.links.newValue))) return;
  // Someone else's edit, then. It carries their fold state, which is theirs,
  // not ours: what is open on this screen stays open.
  const open = folds();
  links = changes.links.newValue ?? DEFAULT_LINKS;
  normalize();
  restoreFolds(open);
  render();
});

// Accepts "asana.com" as readily as a full URL. Blank means this row is a
// folder heading rather than a link.
function normalizeUrl(value) {
  const url = value.trim();
  if (!url) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

// What's in the search box, if it reads as an address to go to rather than a
// label to look for. A scheme settles it outright; a bare "example.com/path"
// counts only when no label matched, so a search for "node.js" still finds it.
function typedUrl() {
  const text = search.value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text)) return text;
  if (!rows.length && /^[^\s/]+\.[a-z]{2,}(?::\d+)?(\/\S*)?$/i.test(text)) {
    return normalizeUrl(text);
  }
  return null;
}

// A letter after the c picks the model, and one after that the effort. Without
// them, whatever claude.ai is already set to stands. Thinking is turned on
// either way — that is not a choice this makes, it is one it insists on.
const MODELS = {
  f: "Fable",
  o: "Opus",
  s: "Sonnet",
  h: "Haiku",
};

// Keyed by what the menu calls them, since that is what has to be clicked.
const EFFORTS = {
  l: { id: "low", label: "Low" },
  m: { id: "medium", label: "Medium" },
  h: { id: "high", label: "High" },
  e: { id: "xhigh", label: "Extra" },
  x: { id: "max", label: "Max" },
};

// "c something to ask" in the search box is Claude mode: the list stands aside
// and enter carries the prompt over to a new chat. The space is what arms it,
// so a lone "c" is still a search — and the mode announces itself the moment
// the space is typed, before there is any prompt to show.
function claudeAsk() {
  const m = search.value.match(/^c([fosh])?([lmhex])?\s([\s\S]*)$/i);
  if (!m) return null;
  // Position settles the letters that mean two things: the first is a model if
  // it can be one, so "ch" is Haiku and "chh" is Haiku at high effort.
  const model = m[1] ? MODELS[m[1].toLowerCase()] : null;
  const effort = m[2] ? EFFORTS[m[2].toLowerCase()] : null;
  return { prompt: m[3].trim(), model, effort };
}

function childrenOf(link) {
  return link.children ?? [];
}

// Headings are worth finding too: a folder's name is often the only place a
// word like "launch" is written down.
function matches(link) {
  return link.title.toLowerCase().includes(query);
}

// Results come out flat: the tree is a way to keep things, not a way to read
// them back, and a hit is worth the same however deep it sat.
function searchRows() {
  const out = [];
  // The folders a result sits in, gathered on the way down: flattened results
  // lose the indentation that would otherwise say where each one came from.
  const walk = (siblings, parent, trail) => {
    siblings.forEach((link, index) => {
      if (matches(link)) out.push({ link, parent, siblings, index, depth: 0, trail });
      walk(childrenOf(link), link, [...trail, link.title]);
    });
  };
  walk(links, null, []);
  return out;
}

// Enough of the path to place a result, from the nearest folder outwards. Deep
// ones are cut off at the far end, since the near end is what identifies it.
function pathLabel(trail) {
  if (!trail?.length) return "";
  const near = trail.slice(-2);
  return (trail.length > near.length ? "… / " : "") + near.join(" / ");
}

function visibleRows() {
  if (query) return searchRows();
  const out = [];
  const walk = (siblings, parent, depth) => {
    siblings.forEach((link, index) => {
      out.push({ link, parent, siblings, index, depth });
      if (!link.collapsed) walk(childrenOf(link), link, depth + 1);
    });
  };
  walk(links, null, 0);
  return out;
}

// A row's own children, their children, and so on — what a delete takes with
// it, and how far past a folder its subtree reaches in the list.
function descendants(link) {
  return childrenOf(link).reduce((n, child) => n + 1 + descendants(child), 0);
}

function button(label, className, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

// One step per level, set here rather than as a class per depth: the tree can
// run as deep as it likes.
const STEP = 1.25; // rem

function indent(el, depth) {
  if (depth) el.style.marginLeft = `${depth * STEP}rem`;
}

// The numeral column and tree gutter that a link row opens with. A form or a
// prompt standing in for a row gets the same two, so its text starts where the
// title it replaces would have — measuring that offset in padding instead
// means guessing at the width of the tree glyph.
function leader(depth) {
  const num = document.createElement("span");
  num.className = "num";

  const tree = document.createElement("span");
  tree.className = "tree";
  tree.textContent = depth ? "└" : "";
  indent(tree, depth);

  return [num, tree];
}

function linkRow(row, position) {
  const { link, depth } = row;
  const li = document.createElement("li");
  li.className = `depth-${depth}`;
  li.dataset.id = link.id;
  if (position === selected && showSelection()) li.classList.add("selected");

  const num = document.createElement("span");
  num.className = "num";
  num.textContent =
    row.number && row.number < 10 ? String(row.number).padStart(2, "0") : "";

  const tree = document.createElement("span");
  tree.className = "tree";
  tree.textContent = depth ? "└" : "";
  indent(tree, depth);

  const twist = document.createElement("span");
  twist.className = "twist";
  twist.textContent = childrenOf(link).length
    ? link.collapsed
      ? "▸"
      : "▾"
    : "";

  let label;
  if (link.url) {
    label = document.createElement("a");
    label.href = link.url;
    label.draggable = false; // the row is what gets dragged, not the URL
  } else {
    label = document.createElement("span");
    label.classList.add("heading");
    label.tabIndex = -1; // focusable by us, skipped by Tab
  }
  label.classList.add("label");
  label.textContent = link.title;
  if (link.url) {
    label.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.button) return;
      event.preventDefault();
      open(link, event.shiftKey);
    });
  } else if (query) {
    // A heading in the results stands for its place in the list.
    label.addEventListener("click", () => reveal(link));
  }
  label.addEventListener("focus", () => {
    if (position === selected) return;
    selected = position;
    render();
    focusSelected();
  });

  const path = document.createElement("span");
  path.className = "path";
  path.textContent = pathLabel(row.trail);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Edit", "icon", () => {
      editing = { link };
      render();
    }),
    button("Delete", "icon", () => {
      confirming = link.id;
      render();
    }),
  );

  li.append(num, tree, label, twist, path, actions);
  // Search results are a flat view of a tree, so there is no order in them to
  // rearrange; dragging is for the list as it is kept.
  if (!query) draggable(li, row);
  return li;
}

function editRow(target) {
  const link = target.link ?? null;
  const depth = link
    ? (rowFor(link)?.depth ?? 0)
    : target.parent
      ? (rowFor(target.parent)?.depth ?? 0) + 1
      : 0;
  const li = document.createElement("li");
  li.className = `editing depth-${depth}`;

  const form = document.createElement("form");

  const title = document.createElement("input");
  title.type = "text";
  title.placeholder = "Name";
  title.value = link?.title ?? "";
  title.required = true;

  const isFolder = link ? childrenOf(link).length > 0 : false;
  const url = document.createElement("input");
  url.type = "text";
  url.placeholder = isFolder ? "heading — holds links, not a URL" : "URL (blank = heading)";
  url.value = isFolder ? "" : (link?.url ?? "");
  url.disabled = isFolder;

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
      focusSelected();
    }),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {
      title: title.value.trim(),
      url: isFolder ? "" : normalizeUrl(url.value),
    };
    let added;
    if (link) {
      Object.assign(link, values); // keep children and collapsed state
    } else {
      const siblings = target.parent ? (target.parent.children ??= []) : links;
      added = { id: crypto.randomUUID(), ...values };
      siblings.splice(target.index, 0, added);
      if (target.parent) {
        target.parent.url = ""; // a folder is a heading, never a link
        delete target.parent.collapsed;
      }
    }
    editing = null;
    await save();
    render();
    if (added) {
      selectById(added.id);
      render();
    }
    focusSelected();
  });

  li.append(...leader(depth), form);
  queueMicrotask(() => title.focus());
  return li;
}

function confirmRow(row, position) {
  const { link, depth } = row;
  const li = document.createElement("li");
  li.className = `confirm depth-${depth}`;
  if (position === selected && showSelection()) li.classList.add("selected");

  const count = descendants(link);
  const text = document.createElement("span");
  text.className = "prompt";
  text.textContent = count
    ? `rm "${link.title}" + ${count} nested? [y/n]`
    : `rm "${link.title}"? [y/n]`;

  const yes = button("Delete", "icon", () => remove(link.id));
  li.append(
    ...leader(depth),
    text,
    yes,
    button("Cancel", "icon", () => {
      confirming = null;
      render();
      focusSelected();
    }),
  );
  queueMicrotask(() => yes.focus());
  return li;
}

function addRow() {
  const li = document.createElement("li");
  li.className = "add";
  if (selected === rows.length && showSelection()) li.classList.add("selected");
  li.append(
    button("+ Add", "add-button", () => {
      editing = { parent: null, index: links.length };
      render();
    }),
  );

  // Past the end of everything: a drop here sends the link to the bottom of
  // the top level, which is otherwise hard to aim at.
  const last = { link: null, siblings: links, index: links.length, depth: 0 };
  li.addEventListener("dragover", (event) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearMarkers();
    li.classList.add("drop-before");
  });
  li.addEventListener("drop", (event) => {
    if (!dragging) return;
    event.preventDefault();
    const link = dragging;
    dragging = null;
    clearMarkers();
    relocate(link, last, "before");
  });

  return li;
}

// A row only looks chosen once something has chosen it.
function showSelection() {
  return Boolean(query) || !idle;
}

// The prefix without its space is someone halfway to a command, so the letters
// explain themselves. The search underneath carries on regardless — this only
// ever sits below it as a reminder.
const HELP = [
  ["c ␣", "ask Claude, then the prompt"],
  ["cf co cs ch", "fable · opus · sonnet · haiku"],
  ["+l +m +h +e +x", "low · medium · high · extra · max"],
];

function halfCommand() {
  return /^c[fosh]?[lmhex]?$/i.test(search.value.trim());
}

function helpRow() {
  const li = document.createElement("li");
  li.className = "help";
  HELP.forEach(([keys, what]) => {
    const line = document.createElement("div");
    const k = document.createElement("span");
    k.className = "keys";
    k.textContent = keys;
    line.append(k, document.createTextNode(what));
    li.append(line);
  });
  return li;
}

// One row, in place of the list: what will be asked, and of whom.
function askRow({ prompt, model, effort }) {
  const li = document.createElement("li");
  li.className = "ask selected";

  const mark = document.createElement("span");
  mark.className = "num";
  mark.textContent = "✳";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = prompt || "Ask Claude…";
  if (!prompt) label.classList.add("hint");

  const where = document.createElement("span");
  where.className = "actions";
  where.style.visibility = "visible";
  if (askTrouble) {
    where.textContent = askTrouble;
    where.classList.add("trouble");
  } else {
    const who = [model, effort?.label].filter(Boolean).join(" · ");
    where.textContent = prompt
      ? `${who || "New chat"} ↵`
      : `type a prompt${who ? ` for ${who}` : ""}`;
  }

  li.append(mark, label, where);
  return li;
}

function rowFor(link) {
  return rows.find((row) => row.link === link);
}

function selectById(id) {
  const at = rows.findIndex((row) => row.link.id === id);
  if (at !== -1) selected = at;
}

async function remove(id) {
  const row = rows.find((r) => r.link.id === id);
  if (row) row.siblings.splice(row.index, 1);
  confirming = null;
  await save();
  render();
  focusSelected();
}

// Dragging. The row being carried, and the marker showing where it would land,
// are kept on the DOM directly: a render mid-drag would replace the element
// under the cursor and the browser would lose the drag with it.
let dragging = null;

function clearMarkers() {
  list
    .querySelectorAll(".drop-before, .drop-after, .drop-into")
    .forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
}

// A heading takes children; a link is a place to land beside, not inside.
function accepts(link) {
  return !link.url;
}

function contains(folder, link) {
  return childrenOf(folder).some((child) => child === link || contains(child, link));
}

// Where the pointer sits in the row: its ends mean "beside", its middle means
// "inside", and only a heading offers a middle.
function dropPlan(row, li, event) {
  const rect = li.getBoundingClientRect();
  const at = (event.clientY - rect.top) / rect.height;
  if (accepts(row.link) && at > 0.28 && at < 0.72) return "into";
  return at < 0.5 ? "before" : "after";
}

// A folder cannot be dropped inside itself, or anywhere under itself.
function canDrop(link, row, plan) {
  if (row.link === link) return false;
  if (contains(link, row.link)) return false;
  return plan !== "into" || accepts(row.link);
}

async function relocate(link, row, plan) {
  const from = rowFor(link);
  if (!from) return;
  const into = plan === "into";
  const siblings = into ? (row.link.children ??= []) : row.siblings;
  let index = into ? siblings.length : row.index + (plan === "after" ? 1 : 0);

  from.siblings.splice(from.index, 1);
  // Lifting it out of the list it is going back into shifts what follows.
  if (siblings === from.siblings && from.index < index) index--;
  siblings.splice(index, 0, link);
  if (into) {
    row.link.url = ""; // it holds links now, so it is a heading
    delete row.link.collapsed;
  }

  render();
  selectById(link.id);
  render();
  focusSelected();
  await save();
}

// Rows carry their own drag handling; the marker classes are set here rather
// than through render() for the reason given above.
function draggable(li, row) {
  li.draggable = true;

  li.addEventListener("dragstart", (event) => {
    dragging = row.link;
    li.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.link.title);
  });

  li.addEventListener("dragend", () => {
    dragging = null;
    li.classList.remove("dragging");
    clearMarkers();
  });

  li.addEventListener("dragover", (event) => {
    if (!dragging) return;
    const plan = dropPlan(row, li, event);
    if (!canDrop(dragging, row, plan)) return;
    event.preventDefault(); // this is the sign that a drop is allowed here
    event.dataTransfer.dropEffect = "move";
    clearMarkers();
    li.classList.add(`drop-${plan}`);
  });

  li.addEventListener("drop", (event) => {
    if (!dragging) return;
    const plan = dropPlan(row, li, event);
    if (!canDrop(dragging, row, plan)) return;
    event.preventDefault();
    const link = dragging;
    dragging = null;
    clearMarkers();
    relocate(link, row, plan);
  });
}

// Reordering stays within a row's own siblings: a child moves among its
// siblings, a parent moves among top-level links, carrying its children.
async function reorder(delta) {
  const row = rows[selected];
  const target = row && row.index + delta;
  if (!row || target < 0 || target >= row.siblings.length) return;
  const [moved] = row.siblings.splice(row.index, 1);
  row.siblings.splice(target, 0, moved);
  render();
  selectById(moved.id);
  render();
  focusSelected();
  await save();
}

function setCollapsed(link, collapsed) {
  if (collapsed) link.collapsed = true;
  else delete link.collapsed;
  render();
  focusSelected();
}

// Opening a folder by number is a step into it, so the first child becomes the
// selection; the same key on an open folder just shuts it again.
// The folders between the top level and this link, outermost first, or null if
// the link is not in the tree at all.
function ancestorsOf(link, siblings = links, trail = []) {
  for (const candidate of siblings) {
    if (candidate === link) return trail;
    const found = ancestorsOf(link, childrenOf(candidate), [...trail, candidate]);
    if (found) return found;
  }
  return null;
}

// A heading found by searching is a place, not a thing to open: put the list
// back with the way down to it unfolded, and the heading itself selected and
// open, so what it holds is on screen.
function reveal(link) {
  search.value = "";
  query = "";
  collapseAll();
  (ancestorsOf(link) ?? []).forEach((folder) => delete folder.collapsed);
  if (childrenOf(link).length) delete link.collapsed;
  idle = false;
  render(); // the row exists once the folds are set, so now it can be found
  selected = Math.max(0, rows.findIndex((row) => row.link === link));
  render();
  focusSelected();
}

// Hand the prompt to the worker, which opens the chat and holds the text until
// claude.ai has loaded enough to take it.
// Whatever goes wrong goes on the row, where it will actually be read.
let askTrouble = null;

function trouble(what) {
  askTrouble = what;
  render();
}

async function askClaude({ prompt, model, effort }) {
  if (!prompt) return;
  // Reloading the extension leaves any page it had already opened holding a
  // dead runtime: the list still draws, but nothing it asks for arrives.
  if (!chrome.runtime?.id) {
    trouble("reload this tab — the extension was updated");
    return;
  }
  try {
    const answer = await chrome.runtime.sendMessage({
      type: "ask-claude",
      prompt,
      model,
      effort,
    });
    if (answer?.error) {
      trouble(answer.error);
      return;
    }
    if (!answer?.url) {
      trouble("the worker had nowhere to send it");
      return;
    }
    askTrouble = null;
    // This tab becomes the chat: asking is the last thing that happens on a
    // new tab page, so there is nothing here worth keeping behind it.
    location.assign(answer.url);
  } catch (error) {
    trouble(String(error?.message ?? error));
  }
}

// Enter on a result: links open, headings are revealed in the list.
function activate(link, newTab) {
  if (link.url) open(link, newTab);
  else reveal(link);
}

function enterFolder(link) {
  if (!link.collapsed) {
    setCollapsed(link, true);
    return;
  }
  delete link.collapsed;
  render(); // the children are rows now, so there is a first one to point at
  const first = rows.findIndex((row) => row.parent === link);
  if (first !== -1) selected = first;
  render();
  focusSelected();
}

function render() {
  const ask = claudeAsk();
  if (ask) {
    // Nothing in the list is reachable from here, so nothing in it is drawn.
    rows = [];
    selected = 0;
    list.replaceChildren(askRow(ask));
    return;
  }

  rows = visibleRows();
  rows.forEach((row, position) => {
    row.number = position + 1;
  });
  // The add row is one past the end, and it is hidden while searching.
  selected = Math.max(0, Math.min(selected, query ? rows.length - 1 : rows.length));

  const items = rows.map((row, position) => {
    if (editing?.link === row.link) return editRow(editing);
    if (confirming === row.link.id) return confirmRow(row, position);
    return linkRow(row, position);
  });

  if (editing && !editing.link) items.splice(insertPosition(), 0, editRow(editing));
  if (!query) items.push(addRow());
  if (halfCommand()) items.push(helpRow());
  list.replaceChildren(...items);
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

// Where the "new link" form belongs among the visible rows.
function insertPosition() {
  const { parent, index } = editing;
  const at = rows.findIndex((row) => row.parent === parent && row.index === index);
  if (at !== -1) return at;
  if (parent === null) return rows.length;
  const parentAt = rows.findIndex((row) => row.link === parent);
  if (parentAt === -1) return rows.length;
  // Past the parent's whole subtree, not just its first generation.
  let end = parentAt + 1;
  while (end < rows.length && rows[end].depth > rows[parentAt].depth) end++;
  return end;
}

// Escape anywhere: clear the search, fold everything, back to the box.
function reset() {
  search.value = "";
  query = "";
  collapseAll();
  selected = 0;
  idle = true;
  render();
  search.focus();
}

function move(delta) {
  selected = Math.max(0, Math.min(selected + delta, rows.length));
  render();
  focusSelected();
}

function caretAtEnd() {
  return (
    search.selectionStart === search.selectionEnd &&
    search.selectionStart === search.value.length
  );
}

function focusSelected() {
  if (query) return; // results are steered from the search box
  if (idle) {
    idle = false;
    render(); // the row has to be marked before there is anything to focus
  }
  list
    .querySelector(".selected .label, .selected .add-button")
    ?.focus({ preventScroll: true });
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// The row lights up and the list recedes before the page goes.
const panel = document.querySelector("main");
// The row lights up and the list recedes before the page goes.
function launch(link) {
  const li = list.querySelector(`li[data-id="${CSS.escape(link.id)}"]`);
  if (!li || reducedMotion.matches) return 0;
  list.classList.add("launching");
  li.classList.add("launching");
  return 190;
}

function open(link, newTab) {
  const delay = launch(link);
  if (newTab) {
    // Through the extension rather than window.open, which the popup blocker
    // is free to refuse and which gives us no say over where the tab lands.
    if (chrome.tabs) chrome.tabs.create({ url: link.url, active: true });
    else window.open(link.url, "_blank");
    // This page is left behind rather than navigated away from, so wind the
    // animation back down for whenever it is looked at again.
    setTimeout(() => {
      list.classList.remove("launching");
      list.querySelector(".launching")?.classList.remove("launching");
    }, delay + 260);
  } else {
    setTimeout(() => location.assign(link.url), delay);
  }
}

list.addEventListener("dragleave", (event) => {
  if (!list.contains(event.relatedTarget)) clearMarkers();
});

search.addEventListener("focus", () => {
  if (idle || query) return;
  idle = true;
  render();
});

// A pasted address is somewhere to go, not something to search for — but only
// when it is all the box holds, not a piece spliced into a query.
let pasted = null;
search.addEventListener("paste", (event) => {
  pasted = event.clipboardData.getData("text").trim();
});

search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase();
  selected = 0;
  askTrouble = null; // a fresh keystroke is a fresh attempt
  idle = !query; // an empty box has chosen nothing
  render();
  const wasPaste = pasted !== null && search.value.trim() === pasted;
  pasted = null;
  const url = wasPaste && typedUrl();
  if (url) open({ id: "", url }, false);
});

document.addEventListener("keydown", (event) => {
  // In the search box: arrows walk the results, Enter opens the current one.
  if (event.target === search) {
    // Claude mode owns enter while it is on; the rest of the box still works.
    const ask = claudeAsk();
    if (ask && event.key === "Enter") {
      event.preventDefault();
      askClaude(ask);
      return;
    }
    // A digit on an empty box is a jump, not the start of a query.
    if (!search.value && /^[1-9]$/.test(event.key)) {
      const target = rows.find((r) => r.number === Number(event.key));
      if (target) {
        event.preventDefault();
        if (target.link.url) open(target.link, event.shiftKey);
        else if (childrenOf(target.link).length) enterFolder(target.link);
        return;
      }
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (query) move(1);
      else focusSelected(); // step from the box into the list
    } else if (event.key === "ArrowUp" && query) {
      event.preventDefault();
      move(-1); // walks the results; focus stays in the box
    } else if (event.key === "ArrowRight" && query && caretAtEnd()) {
      // A folder among the results opens where it belongs, with the way down
      // to it unfolded. Only from the end of the box, so arrowing back through
      // what you typed still works.
      const row = rows[selected];
      if (row && childrenOf(row.link).length) {
        event.preventDefault();
        reveal(row.link);
      }
    } else if (event.key === "Enter" && typedUrl()) {
      event.preventDefault();
      open({ id: "", url: typedUrl() }, event.shiftKey);
    } else if (event.key === "Enter" && rows[selected] && showSelection()) {
      event.preventDefault();
      activate(rows[selected].link, event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      reset();
    }
    return;
  }

  // While a form is open the keys belong to the inputs.
  if (editing !== null) {
    if (event.key === "Escape") {
      editing = null;
      render();
      focusSelected();
    }
    return;
  }
  // y / n (or Enter / Escape) answer a pending delete.
  if (confirming !== null) {
    if (event.key === "y" || event.key === "Enter") {
      event.preventDefault();
      remove(confirming);
    } else if (event.key === "n" || event.key === "Escape") {
      event.preventDefault();
      confirming = null;
      render();
      focusSelected();
    }
    return;
  }

  if (
    (event.metaKey || event.ctrlKey) &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  ) {
    event.preventDefault();
    reorder(event.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // Let a focused button handle its own Enter or Space.
  if (event.target.closest?.("button") && (event.key === "Enter" || event.key === " ")) {
    return;
  }

  const row = rows[selected];

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    // Past the first row, step back up into the search box.
    if (selected === 0) search.focus();
    else move(-1);
  } else if (event.key === "h" || event.key === "ArrowLeft") {
    event.preventDefault();
    if (!row) return;
    // Collapse an open folder; otherwise climb to the one holding this row.
    if (childrenOf(row.link).length && !row.link.collapsed) {
      setCollapsed(row.link, true);
    } else if (row.parent) {
      selected = rows.findIndex((r) => r.link === row.parent);
      render();
      focusSelected();
    }
  } else if (event.key === "l" || event.key === "ArrowRight") {
    event.preventDefault();
    if (!row || !childrenOf(row.link).length) return;
    if (row.link.collapsed) setCollapsed(row.link, false);
    else move(1); // first child
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (row?.link.url) {
      open(row.link, event.shiftKey);
    } else if (row) {
      if (childrenOf(row.link).length) setCollapsed(row.link, !row.link.collapsed);
    } else {
      // On the add row.
      editing = { parent: null, index: links.length };
      render();
    }
  } else if (/^[1-9]$/.test(event.key)) {
    const target = rows.find((r) => r.number === Number(event.key));
    if (!target) return;
    event.preventDefault();
    if (target.link.url) open(target.link, false);
    else if (childrenOf(target.link).length) enterFolder(target.link);
  } else if (event.key === "a") {
    event.preventDefault();
    // A sibling of the selected row, directly beneath it.
    editing = row
      ? { parent: row.parent, index: row.index + 1 }
      : { parent: null, index: links.length };
    render();
  } else if (event.key === "A" && row) {
    event.preventDefault();
    // A child of the selected row, at the end of whatever it already holds.
    editing = { parent: row.link, index: childrenOf(row.link).length };
    render();
  } else if (event.key === "e" && row) {
    event.preventDefault();
    editing = { link: row.link };
    render();
  } else if (event.key === "d" && row) {
    event.preventDefault();
    confirming = row.link.id;
    render();
  } else if (event.key === "Escape") {
    event.preventDefault();
    reset();
  }
});

// The copy Chrome opened is about to be replaced, so it builds nothing: see
// refocus.js, which also brings the page up anyway if the swap never comes.
unlessReplaced(() => {
  normalize();
  collapseAll();
  render();
  // Takes hold in the replacement tab; in the tab Chrome opened the focus the
  // omnibox has is not ours to take.
  search.focus();
  load();
});
