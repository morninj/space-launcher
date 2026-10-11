// Loaded first, from the head, so the swap that fixes focus is asked for
// before anything else on the page is even parsed.
//
// The copy Chrome opens for a new tab is thrown away a moment later (see
// background.js), so it does none of the work: no art, no list, no storage
// read. Everything else here checks DOOMED before starting.
const DOOMED = !location.search;

if (DOOMED) chrome.runtime.sendMessage("refocus");

// If the swap never happens — no worker, an error, a reload of this URL by
// hand — the page has to come up anyway rather than sit there blank.
function unlessReplaced(begin) {
  if (DOOMED) setTimeout(begin, 600);
  else begin();
}
