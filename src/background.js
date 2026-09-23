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
    handOff({
      prompt: message.prompt,
      model: message.model ?? null,
      effort: message.effort ?? null,
    }).then(respond);
    return true;
  }
  // From claude.ai, once it has loaded: was this tab opened carrying one?
  if (message?.type === "claude-pending") {
    claim(sender.tab?.id).then((request) => respond({ request }));
    return true; // the answer comes back asynchronously
  }
});

// The prompt waits in session storage rather than a variable, because the
// worker may be stopped and restarted between opening the tab and claude.ai
// asking for it. Session storage is closed to content scripts, which is why
// the page has to ask us rather than reading it.
const CLAUDE = "https://claude.ai/new";

async function handOff(request) {
  try {
    // The request rides over in the fragment — never sent to any server, and
    // read at document_start before the app can rewrite the URL. Session
    // storage carries the same thing as a fallback, for a load that arrives
    // without it.
    const url = `${CLAUDE}#launcher=${encodeURIComponent(JSON.stringify(request))}`;
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ [`claude-${tab.id}`]: request });
    console.log(
      "[homepage-links] opened a chat for tab",
      tab.id,
      request.model ? `on ${request.model}` : "on whatever is selected",
    );
    return { ok: true };
  } catch (error) {
    console.error("[homepage-links] could not open Claude", error);
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
    console.error("[homepage-links] could not read the pending prompt", error);
    return null;
  }
}

async function replace(tab) {
  console.debug("[launcher] replacing new tab", tab.id);
  try {
    await chrome.tabs.create({
      url: REPLACEMENT,
      index: tab.index,
      windowId: tab.windowId,
      active: tab.active,
    });
    await chrome.tabs.remove(tab.id);
  } catch (error) {
    console.error("[launcher] could not replace new tab", error);
  }
}
