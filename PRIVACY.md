# Privacy

Space Launcher collects nothing. It has no server, no analytics, and no
account, and the developer never receives anything you do with it.

**Your links** are kept in `chrome.storage.sync`. If you have Chrome sync on,
Google carries them between your own browsers, the same way it carries your
bookmarks. Nothing else reads them.

**The photos** come inside the extension. Showing one makes no network
request. The only thing the page remembers about them is which photo it showed
last, so the next tab shows a different one, and it keeps that in the page's
local storage. A photo's "more" link opens the page it came from, on ESA's or
NASA's site, and only when you click it.

**Asking Claude.** If you type `c ` and a prompt, then press Enter, the tab goes
to claude.ai and the extension types your prompt into a new chat and sends it.
The prompt travels in the URL fragment, which browsers never send to a server.
A copy waits in Chrome's session storage until claude.ai has loaded, and is
deleted as soon as it is used. Once it is sent, it is a message to Claude like
any other, covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
On claude.ai the extension does only this: it picks up its own hand-off, sets
the model and effort you asked for, types the prompt in and sends it. It looks
at the page only to find the chat box and the menus, and nothing it sees there
leaves the page.

## Permissions

- **storage**: to save your links, and to hold a prompt for the moment it
  takes claude.ai to load.
- **Access to claude.ai**: for the hand-off described above. It does nothing
  unless you started a chat from the new tab page.
- **Replacing the new tab page**: that's what the extension is for.

## Contact

Questions go to [the issue tracker](https://github.com/morninj/space-launcher/issues).
