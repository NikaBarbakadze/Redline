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

- Hover states stay live while picking, so open menus, tooltips and modals (including native `<dialog>`s) can be captured.
- Red numbered pins mark what you've already covered. Hover one to read the note, click it to edit.
- The dock in the corner shows the count and has **Copy for Claude**. Click the count to review: edit notes inline, zoom screenshots, delete (with undo).
- A session spans tabs and pages until you start a new one.

Right-click the toolbar icon for Review / Copy / New session / Change shortcut. If <kbd>⌘</kbd><kbd>⇧</kbd><kbd>S</kbd> doesn't fire, another extension probably owns it; set one at `chrome://extensions/shortcuts`.

![Review sheet](docs/sheet.png)

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

## How it works

No build step and no dependencies.

- `src/content.js`: all in-page UI (picker, composer, pins, dock, review sheet) in a shadow root. The host is a manual popover so it sits in the top layer above the page's own modals. When a modal `<dialog>` is open, it moves inside the dialog so it isn't inert. Idle cost on a page is one storage read and a pointer listener.
- `src/background.js`: captures the tab, keeps screenshots in IndexedDB (session metadata lives in `chrome.storage`, so tabs don't sync megabytes of base64), writes the PNGs with the download bubble suppressed and history cleaned up, and builds the prompt.
- `src/offscreen.*`: clipboard fallback for when the page can't write it.

Nothing leaves your machine.
