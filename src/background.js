// Chrome hands focus to the omnibox on a new tab and ignores focus() from a new
// tab page override. Navigating that tab (chrome.tabs.update) does not move
// focus either — the tab is still the one Chrome opened as a new tab. A tab
// *created* with an explicit URL is not special-cased, so it starts with focus
// in the document. So: open a replacement tab in the same slot, close the
// original.
const PAGE = chrome.runtime.getURL("newtab.html");
const REPLACEMENT = `${PAGE}?focused`; // marks tabs we opened, so we never recurse

function isFreshNewTab(tab) {
  const url = tab.pendingUrl || tab.url || "";
  if (url.startsWith(REPLACEMENT)) return false;
  // With the override installed Chrome may report either URL here.
  return url === "chrome://newtab/" || url.startsWith(PAGE);
}

chrome.tabs.onCreated.addListener(async (tab) => {
  console.debug("[homepage-links] tab created", {
    pendingUrl: tab.pendingUrl,
    url: tab.url,
    match: isFreshNewTab(tab),
  });
  if (!isFreshNewTab(tab)) return;

  try {
    await chrome.tabs.create({
      url: REPLACEMENT,
      index: tab.index,
      windowId: tab.windowId,
      active: tab.active,
    });
    await chrome.tabs.remove(tab.id);
  } catch (error) {
    console.error("[homepage-links] could not replace new tab", error);
  }
});
