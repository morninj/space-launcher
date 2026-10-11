// Chrome hands focus to the omnibox on a new tab and ignores focus() from a new
// tab page override. Navigating that tab (chrome.tabs.update) does not move
// focus either — the tab is still the one Chrome opened as a new tab. A tab
// *created* with an explicit URL is not special-cased, so it starts with focus
// in the document. So: open a replacement tab in the same slot, close the
// original.
const REPLACEMENT = `${chrome.runtime.getURL("newtab.html")}?focused`;

// The page asks for this itself rather than us watching tabs.onCreated: a tab
// Chrome has just opened reports no URL yet (neither url nor pendingUrl), so
// there is nothing there to recognize a new tab by. The override page only
// loads when Chrome actually opened a new tab, which is the signal we want.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message === "refocus" && sender.tab) {
    replace(sender.tab);
    return;
  }
  // From the list: open Claude carrying a prompt.
  if (message?.type === "ask-claude") {
    // Answered, rather than left to fail quietly: the list waits for this and
    // says so on the row if it comes back as trouble.
    handOff(
      {
        prompt: message.prompt,
        model: message.model ?? null,
        effort: message.effort ?? null,
      },
      sender.tab?.id,
    ).then(respond);
    return true;
  }
  // From claude.ai, once it has loaded: was this tab opened carrying one?
  if (message?.type === "claude-pending") {
    claim(sender.tab?.id).then((request) => respond({ request }));
    return true; // the answer comes back asynchronously
  }
});

// Ctrl+L (the real Control key on a Mac, not ⌘): bring the launcher up in the
// tab you are in, so the page you left stays one Back away. The URL carries
// ?focused so the page doesn't take itself for a fresh new tab and ask to be
// swapped out.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "go-home") return;
  try {
    if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { url: REPLACEMENT });
    else await chrome.tabs.create({ url: REPLACEMENT });
  } catch (error) {
    console.error("[space-launcher] could not go to the launcher", error);
  }
});

// The prompt waits in session storage rather than a variable, because the
// worker may be stopped and restarted between opening the tab and claude.ai
// asking for it. Session storage is closed to content scripts, which is why
// the page has to ask us rather than reading it.
const CLAUDE = "https://claude.ai/new";

// This only prepares the hand-off; the list then walks its own tab to the URL
// it gets back. Navigating from here would mean knowing which tab asked, and
// going through the tabs API to move a page that can move itself.
async function handOff(request, tabId) {
  try {
    // The request rides over in the fragment — never sent to any server, and
    // read at document_start before the app can rewrite the URL.
    const url = `${CLAUDE}#launcher=${encodeURIComponent(JSON.stringify(request))}`;

    // Session storage carries the same thing as a fallback, for a load that
    // arrives without the fragment. Written before the page starts loading,
    // and only when we know which tab to key it to.
    if (tabId) await chrome.storage.session.set({ [`claude-${tabId}`]: request });

    console.log(
      "[space-launcher] chat ready for tab",
      tabId ?? "(unknown)",
      request.model ? `on ${request.model}` : "on whatever is selected",
    );
    return { ok: true, url };
  } catch (error) {
    console.error("[space-launcher] could not prepare the chat", error);
    return { error: String(error?.message ?? error) };
  }
}

// Handed over once: a reload of claude.ai should not retype the prompt.
async function claim(tabId) {
  if (!tabId) return null;
  const key = `claude-${tabId}`;
  try {
    const stored = await chrome.storage.session.get(key);
    if (stored[key] === undefined) return null;
    await chrome.storage.session.remove(key);
    return stored[key];
  } catch (error) {
    console.error("[space-launcher] could not read the pending prompt", error);
    return null;
  }
}

async function replace(tab) {
  console.debug("[space-launcher] replacing new tab", tab.id);
  try {
    await chrome.tabs.create({
      url: REPLACEMENT,
      index: tab.index,
      windowId: tab.windowId,
      active: tab.active,
    });
    await chrome.tabs.remove(tab.id);
  } catch (error) {
    console.error("[space-launcher] could not replace new tab", error);
  }
}
