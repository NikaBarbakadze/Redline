# Redline

A Chrome extension for QA passes with Claude. Point at something on the page, say what should change, move on. When you're done, one click copies the whole session as a single prompt that pairs every screenshot with its note.

![Composer](docs/composer.png)

## Why

The old loop was: screenshot → paste into Claude → type → back to the browser → repeat, with nothing tying each note to its image. Redline keeps you in the browser. Notes sit right next to what they're about, and the export is structured so Claude can't mix them up.

## Install

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Pin Redline from the puzzle-piece menu.

The welcome page that opens shows your shortcut and has a card to practice on.

## Use

| | |
|---|---|
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>S</kbd> or the toolbar icon | Start capturing |
| Click | Capture the highlighted element |
| Drag | Capture an area |
| <kbd>Space</kbd> | Capture the whole visible screen |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Select the parent / back to the child |
| <kbd>↵</kbd> | Save the note |
| <kbd>⌘</kbd><kbd>↵</kbd> | Save and capture the next one |
| <kbd>⇧</kbd><kbd>↵</kbd> | New line |
| <kbd>esc</kbd> | Cancel (twice if you've typed something) |
| <kbd>esc</kbd> with nothing open | Hide the dock until your next capture |

- Hover states stay live while picking, so open menus, tooltips and modals (including native `<dialog>`s) can be captured.
- Works inside iframes, including cross-origin ones like an embedded app in Shopify admin or the theme editor preview. The note records the iframe's URL (path only, so session tokens stay out) and the element path inside it.
- Nothing is drawn on the page between captures. While picking, an element you've already noted turns red and its label shows the note's number and text, so you don't capture it twice. The match is the element itself, not a saved position, so it never points at the wrong thing. To find a note's element again, click **This page** on its card in the panel.
- The dock in the corner shows the count and has **Copy notes**. Click the count to open the notes panel: edit notes inline, zoom screenshots, copy a single screenshot, delete (with undo). The panel is one panel across tabs: it follows you to the next tab, and closing it anywhere closes it everywhere. Copying closes it.
- A session spans tabs and pages. **Copying closes it**: it moves to History and your next note starts again at 1, so a forgotten "new session" can't mix batches. Copied too early? **Keep adding** in the toast reopens it.
- **History** (the second tab in the panel, or right-click the icon → History) keeps your last 50 sessions. Open one to see its notes and screenshots, copy it again (same file paths), or **Continue** it to add more notes. Anything in progress is set aside into History first, so nothing is lost.

Right-click the toolbar icon for Review / History / Copy / New session / Change shortcut. If <kbd>⌘</kbd><kbd>⇧</kbd><kbd>S</kbd> doesn't fire, another extension probably owns it; set one at `chrome://extensions/shortcuts`.

<p><img src="docs/sheet.png" alt="Notes panel" width="300"> <img src="docs/history.png" alt="History" width="300"></p>

## What gets copied

Screenshots are written to `~/Downloads/Redline/<session>/01.png, 02.png, …` and the clipboard gets:

```
# UI changes (2 notes)

I took these while reviewing the page in the browser. Each note pairs a screenshot with the change I want. …

Page: Two Tier Lander (https://hooksandneedles.com/pages/two-tier)
Viewport: 1440×900

## 1
Screenshot: /Users/you/Downloads/Redline/2026-10-12_14-32-05/01.png
Element: `section#shopify-section-template--1234__hero > div.hero__content > a#cta` "Get my free box"
Change: Make the button bigger and use our brand green.

## 2
Screenshot: /Users/you/Downloads/Redline/2026-10-12_14-32-05/02.png
Area: a dragged region centered on `section.grid > div.card.product-card`
Change: Cards feel cramped. Add more padding.
```

Element screenshots include some surrounding context with the target outlined in red. The element path stops at the nearest id, which on Shopify is usually the section, so Claude can find the right file.

The format is built for **Claude Code**, which opens the screenshots from those paths. Page, viewport and element details are only repeated per note when they differ.

### Where to paste

- **Claude Code, Codex (CLI or app), Cursor and other coding agents:** paste as is. They open the screenshots from the paths.
- **Any web chat** (claude.ai, including project chats and existing conversations, ChatGPT, Codex on the web…): <kbd>⌘</kbd><kbd>V</kbd> attaches every screenshot, numbered in its corner, and swaps the paths for "attached image N". Redline recognises its own text on the clipboard, so ordinary pastes are untouched. **Paste and Match Style** (<kbd>⌥</kbd><kbd>⇧</kbd><kbd>⌘</kbd><kbd>V</kbd>) pastes just the text, and so does any page that doesn't take images.
- **Desktop chat apps** (Claude, ChatGPT): **Show files** in the "Copied" toast opens the screenshots in Finder to drag in, or copy a single screenshot from its card in the panel.

## How it works

No build step and no dependencies.

- `src/content.js`: all in-page UI (picker, composer, dock, review sheet) in a shadow root. It runs in every frame. Child frames pick on their own and post the result to their parent, which offsets it by the `<iframe>`'s content box and passes it up until the top frame takes the screenshot and opens the composer. Keys follow the pointer between frames. The host is a manual popover so it sits in the top layer above the page's own modals. When a modal `<dialog>` is open, it moves inside the dialog so it isn't inert. Idle cost on a page is one storage read and a pointer listener.
- `src/background.js`: captures the tab, builds the numbered attachments for web-chat pastes, keeps screenshots, thumbnails and session History in IndexedDB (only the active session lives in `chrome.storage`, so tabs stay in sync without passing megabytes of base64 around), writes the PNGs with the download bubble suppressed and the downloads list cleaned up, and builds the prompt.
- `src/offscreen.*`: clipboard fallback for when the page can't write it.

Nothing leaves your machine.

## Development

Reload the extension at `chrome://extensions` after editing, then refresh open tabs.

End-to-end tests run a real Chromium with the extension loaded, driven by Playwright, against mock pages in `tests/site` (a store page, a Shopify-admin-like page with a cross-origin app iframe, mock chat boxes):

```sh
cd tests
npm install   # playwright-core; uses Playwright's Chromium (npx playwright-core install chromium if missing)
npm test      # all suites; or run one, e.g. node iframes.mjs
```

`npm run icons` (from `tests/`) re-renders the icons from `tools/make-icons.mjs`.
