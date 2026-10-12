# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Upload
`redline-<version>.zip` from `tools/package.sh`; images are in this folder
(re-render them with `node tools/store-shots.mjs`).

## Package

- File: `redline-1.5.1.zip` (`./tools/package.sh`)

## Store listing tab

**Description** (the summary line comes from `manifest.json`):

```
Redline is for reviewing a web page and handing the changes to a coding agent (Claude Code, Codex, Cursor) or a web chat.

Click an element, drag an area or press Space for the whole screen, then type what should change. Keep going through the page. When you're done, one click copies the whole session as one prompt: every note paired with its screenshot and where the element lives in the page.

It replaces the loop of screenshot → switch to the chat → paste → describe → switch back, where nothing ties a note to its image.

• Point and note: hover highlights elements the way DevTools does. The note opens right beside what you picked.
• Screenshots with context: element shots include some of the page around them, with the target outlined in red.
• Prompts agents can act on: every note carries the page, the viewport and a readable element path that stops at the nearest id. On Shopify, that's the theme section.
• Paste anywhere: coding agents get the screenshot file paths. In web chats, ⌘V attaches the screenshots themselves, numbered to match the notes.
• Hover states stay live: open menus, tooltips and modals can be captured while they're open.
• Works inside iframes, including cross-origin ones like apps embedded in an admin or a theme editor preview.
• No duplicates: while you pick, anything you've already noted turns red and shows its note.
• Sessions and History: a session can span tabs and pages, and your last 50 sessions stay in History.

Private by design: no accounts, no servers, no analytics. Notes and screenshots stay on your computer.

Shortcut: ⌘⇧S (Ctrl+Shift+S on Windows and Linux), or click the toolbar icon.

Open source (MIT): https://github.com/NikaBarbakadze/Redline
```

- **Category:** Developer Tools
- **Language:** English
- **Store icon:** `icons/128.png`
- **Screenshots** (1280×800): `1-pick.jpg`, `2-note.jpg`, `3-notes.jpg`, `4-iframe.jpg`, `5-prompt.jpg`
- **Small promo tile** (440×280): `promo-440x280.jpg`
- **Official URL:** none
- **Homepage URL:** https://github.com/NikaBarbakadze/Redline
- **Support URL:** https://github.com/NikaBarbakadze/Redline/issues

## Privacy tab

**Single purpose:**

```
Capture review notes on web pages: the user picks an element or area on the page, writes what should change, and copies all notes with their screenshots as one prompt for an AI coding assistant or chat.
```

**Permission justifications:**

| Field | Text |
|---|---|
| activeTab | Takes the screenshot of the visible tab when the user captures an element, an area or the screen. |
| scripting | Adds Redline's picker to tabs that were already open before Redline was installed or updated, when the user starts a capture there. |
| storage | Keeps the current review session (notes and their page details) and syncs it across the user's tabs. |
| unlimitedStorage | Screenshots and the History of past sessions are kept in the extension's IndexedDB; a session with many full-tab screenshots exceeds the default quota. |
| downloads | When the user copies their notes, saves each screenshot as a PNG in Downloads/Redline so a coding agent can open it from the path in the prompt. |
| downloads.ui | Hides the download bubble while those PNGs are saved, so copying notes doesn't flash a download for every screenshot. |
| clipboardWrite | Copies the notes prompt (and a single screenshot, on request) to the clipboard. |
| offscreen | Clipboard fallback: an offscreen document writes the prompt when the page the user is on can't. |
| contextMenus | The right-click menu on the toolbar icon: Review notes, History, Copy notes, Start a new session, Change keyboard shortcut. |
| Host permission (all sites) | Users review whatever site they're working on, so the picker has to run on any page and inside its iframes (for example apps embedded in an admin). It runs at document start in every frame so its keyboard shortcuts (Esc, Enter, arrows) work even on pages that handle those keys themselves. Nothing is read or sent anywhere unless the user captures something, and captures stay on the device. |

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Website content** (screenshots and element text of pages the user captures; stored on the device only). Tick all three certifications (not sold or transferred, not used for unrelated purposes, not used for creditworthiness or lending).

**Privacy policy URL:** https://github.com/NikaBarbakadze/Redline/blob/main/PRIVACY.md

## Distribution tab

- Free, Public, all regions.

## Test instructions (optional, for the reviewer)

```
No account or setup needed. On any web page press ⌘⇧S (Ctrl+Shift+S) or click the toolbar icon, click an element, type a note and press Enter. Click "Copy notes" in the dock at the bottom right, then paste into any text field.
```
