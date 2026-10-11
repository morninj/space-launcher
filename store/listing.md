# Chrome Web Store listing

What to paste into the developer dashboard. Upload `dist/space-launcher-<version>.zip`,
built with `python3 scripts/build-store.py`.

## Store listing

**Name:** Space Launcher

**Summary** (the manifest description, 132 characters at most):
A keyboard-driven list of your links on every new tab, over a different James Webb Space Telescope photo each time.

**Category:** Productivity → Workflow & Planning

**Language:** English

**Description:**

> Every new tab opens on a photograph from the James Webb Space Telescope, a
> different one each time, with your own links laid over it and the cursor
> already in the search box.
>
> • Type to filter your links, then press Enter to go. Number keys jump
>   straight to a row.
> • Folders nest as deep as you like. Move around with j/k/h/l or the arrow
>   keys, add with a, edit with e, delete with d, and reorder with ⌘↑/⌘↓ or by
>   dragging.
> • Type or paste a web address and press Enter to go straight there.
> • Ctrl+L brings the list up in the current tab, from any page.
> • Type "c" and a space to ask Claude: the tab opens a new chat at claude.ai
>   and sends your prompt, on the model and effort you choose with a letter or
>   two.
>
> The photos come from ESA/Webb and NASA, and the corner of the screen says what
> each one shows, who to credit, and links to its page. They ship inside the
> extension, about eighty of them at 4K, so a new tab makes no network request.
>
> Your links are saved in Chrome's sync storage and go nowhere else. No account,
> no analytics, no server.
>
> Open source: https://github.com/morninj/space-launcher
>
> Space Launcher is not affiliated with or endorsed by NASA, ESA, CSA, STScI,
> or Anthropic.

**Graphics:**
- Icon: `src/icons/icon128.png`
- Screenshots (1280×800): `store/screenshots/`
- Small promo tile (440×280): `store/promo-small-440x280.png`

**Homepage URL:** https://github.com/morninj/space-launcher
**Support URL:** https://github.com/morninj/space-launcher/issues

## Privacy practices

**Single purpose:**
Replaces the new tab page with a keyboard-driven list of the user's links,
shown over a photograph from the James Webb Space Telescope.

**Permission justifications:**
- `storage`: Saves the user's list of links (chrome.storage.sync), and holds a
  prompt the user typed for the moment it takes claude.ai to load
  (chrome.storage.session; deleted once used).
- Host access, `https://claude.ai/*` (content script): When the user types a
  prompt on the new tab page and presses Enter, the tab opens claude.ai and the
  content script types that prompt into a new chat, sets the model the user
  chose, and sends it. It does nothing on claude.ai pages the user didn't open
  this way.

**Remote code:** No, I am not using remote code. All scripts are in the package.

**Data usage:** Collects none of the listed categories. (The links the user saves
are kept in their own Chrome sync storage, and the developer never receives
them. The Claude prompt is sent to claude.ai only at the user's explicit
request, as the feature's purpose.)

Certify all three: no selling of data, no use outside the single purpose, and no
use for creditworthiness or lending.

**Privacy policy URL:** https://github.com/morninj/space-launcher/blob/main/PRIVACY.md
