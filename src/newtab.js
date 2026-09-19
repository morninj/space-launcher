const DEFAULT_LINKS = [
  { id: "asana", title: "Asana", url: "https://app.asana.com/" },
  { id: "gmail", title: "Gmail", url: "https://mail.google.com/" },
  { id: "calendar", title: "Calendar", url: "https://calendar.google.com/" },
];

const list = document.getElementById("links");
const search = document.getElementById("search");
let links = DEFAULT_LINKS;
let rows = []; // flattened visible rows; `selected` indexes into this
let selected = 0;
let editing = null; // {link} to edit, or {parent, index} to insert
let confirming = null; // id of the link awaiting delete confirmation
let query = ""; // search box contents, lowercased

// Storage can be missing (extension not reloaded since the "storage" permission
// was added). Fall back to the defaults rather than leaving the page blank.
async function load() {
  try {
    const stored = await chrome.storage.sync.get({ links: DEFAULT_LINKS });
    links = stored.links;
  } catch (error) {
    console.error("[homepage-links] could not read storage", error);
  }
  collapseAll();
  render();
}

// Existing data may predate the rule that a folder is a heading.
function normalize() {
  links.forEach((link) => {
    if (childrenOf(link).length) link.url = "";
  });
}

function collapseAll() {
  links.forEach((link) => {
    if (childrenOf(link).length) link.collapsed = true;
  });
}

// Remembers what we wrote, so our own change events can be ignored below.
let lastWrite = null;

async function save() {
  try {
    lastWrite = JSON.stringify(links);
    await chrome.storage.sync.set({ links });
  } catch (error) {
    console.error("[homepage-links] could not write storage", error);
  }
}

// Edits made on another computer (or in another open tab) arrive here. Skip the
// re-render mid-edit so the form under the cursor does not vanish.
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.links || editing !== null) return;
  // Our own save echoes back here; re-collapsing on it would fold the folder
  // you just added to.
  if (JSON.stringify(changes.links.newValue) === lastWrite) return;
  links = changes.links.newValue ?? DEFAULT_LINKS;
  normalize();
  collapseAll();
  render();
});

// Accepts "asana.com" as readily as a full URL. Blank means this row is a
// folder heading rather than a link.
function normalizeUrl(value) {
  const url = value.trim();
  if (!url) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function childrenOf(link) {
  return link.children ?? [];
}

// Parents are always listed; their children only while expanded. Nesting stops
// at one level, so a row is either a parent or a child of one.
function matches(link) {
  return (
    link.url &&
    (link.title.toLowerCase().includes(query) ||
      link.url.toLowerCase().includes(query))
  );
}

function searchRows() {
  const out = [];
  links.forEach((link, index) => {
    if (matches(link)) {
      out.push({ link, parent: null, siblings: links, index, depth: 0 });
    }
    childrenOf(link).forEach((child, childIndex) => {
      if (matches(child)) {
        out.push({
          link: child,
          parent: link,
          siblings: link.children,
          index: childIndex,
          depth: 0,
        });
      }
    });
  });
  return out;
}

function visibleRows() {
  if (query) return searchRows();
  const out = [];
  links.forEach((link, index) => {
    out.push({ link, parent: null, siblings: links, index, depth: 0 });
    if (link.collapsed) return;
    childrenOf(link).forEach((child, childIndex) => {
      out.push({
        link: child,
        parent: link,
        siblings: link.children,
        index: childIndex,
        depth: 1,
      });
    });
  });
  return out;
}

function button(label, className, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function linkRow(row, position) {
  const { link, depth } = row;
  const li = document.createElement("li");
  li.className = `depth-${depth}`;
  li.dataset.id = link.id;
  if (position === selected) li.classList.add("selected");

  const num = document.createElement("span");
  num.className = "num";
  num.textContent =
    row.number && row.number < 10 ? String(row.number).padStart(2, "0") : "";

  const tree = document.createElement("span");
  tree.className = "tree";
  tree.textContent = depth ? "└" : "";

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
  }
  label.addEventListener("focus", () => {
    if (position === selected) return;
    selected = position;
    render();
    focusSelected();
  });

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

  li.append(num, tree, label, twist, actions);
  return li;
}

function editRow(target) {
  const link = target.link ?? null;
  const depth = link ? (rowFor(link)?.depth ?? 0) : target.parent ? 1 : 0;
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

  li.append(form);
  queueMicrotask(() => title.focus());
  return li;
}

function confirmRow(row, position) {
  const { link, depth } = row;
  const li = document.createElement("li");
  li.className = `confirm depth-${depth}`;
  if (position === selected) li.classList.add("selected");

  const count = childrenOf(link).length;
  const text = document.createElement("span");
  text.className = "prompt";
  text.textContent = count
    ? `rm "${link.title}" + ${count} nested? [y/n]`
    : `rm "${link.title}"? [y/n]`;

  const yes = button("Delete", "icon", () => remove(link.id));
  li.append(
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
  if (selected === rows.length) li.classList.add("selected");
  li.append(
    button("+ Add", "add-button", () => {
      editing = { parent: null, index: links.length };
      render();
    }),
  );
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

function render() {
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
  list.replaceChildren(...items);
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

// Where the "new link" form belongs among the visible rows.
function insertPosition() {
  const { parent, index } = editing;
  const at = rows.findIndex((row) => row.parent === parent && row.index === index);
  if (at !== -1) return at;
  if (parent === null) return rows.length;
  const lastChild = rows.map((row) => row.parent === parent).lastIndexOf(true);
  if (lastChild !== -1) return lastChild + 1;
  const parentAt = rows.findIndex((row) => row.link === parent);
  return parentAt === -1 ? rows.length : parentAt + 1;
}

// Escape anywhere: clear the search, fold everything, back to the box.
function reset() {
  search.value = "";
  query = "";
  collapseAll();
  selected = 0;
  render();
  search.focus();
}

function move(delta) {
  selected = Math.max(0, Math.min(selected + delta, rows.length));
  render();
  focusSelected();
}

function focusSelected() {
  if (query) return; // results are steered from the search box
  list
    .querySelector(".selected .label, .selected .add-button")
    ?.focus({ preventScroll: true });
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

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
    window.open(link.url, "_blank");
    // The page stays put, so wind the animation back down.
    setTimeout(() => {
      list.classList.remove("launching");
      list.querySelector(".launching")?.classList.remove("launching");
    }, delay + 260);
  } else {
    setTimeout(() => location.assign(link.url), delay);
  }
}

search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase();
  selected = 0;
  render();
});

document.addEventListener("keydown", (event) => {
  // In the search box: arrows walk the results, Enter opens the current one.
  if (event.target === search) {
    // A digit on an empty box is a jump, not the start of a query.
    if (!search.value && /^[1-9]$/.test(event.key)) {
      const target = rows.find((r) => r.number === Number(event.key));
      if (target) {
        event.preventDefault();
        if (target.link.url) open(target.link, event.shiftKey);
        else if (childrenOf(target.link).length)
          setCollapsed(target.link, !target.link.collapsed);
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
    } else if (event.key === "Enter" && rows[selected]) {
      event.preventDefault();
      open(rows[selected].link, event.shiftKey);
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
    // Collapse an open parent; from a child, step up to the parent.
    if (row.depth === 0 && childrenOf(row.link).length && !row.link.collapsed) {
      setCollapsed(row.link, true);
    } else if (row.depth === 1) {
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
    else if (childrenOf(target.link).length)
      setCollapsed(target.link, !target.link.collapsed);
  } else if (event.key === "a") {
    event.preventDefault();
    // A sibling of the selected row, directly beneath it.
    editing = row
      ? { parent: row.parent, index: row.index + 1 }
      : { parent: null, index: links.length };
    render();
  } else if (event.key === "A" && row) {
    event.preventDefault();
    // A child of the selected row; from a child, a sibling of it instead.
    editing =
      row.depth === 0
        ? { parent: row.link, index: childrenOf(row.link).length }
        : { parent: row.parent, index: row.index + 1 };
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

normalize();
collapseAll();
render();
// Works because background.js re-navigates new tabs here as an ordinary URL;
// Chrome ignores focus() on a new tab page override.
search.focus();
load();
