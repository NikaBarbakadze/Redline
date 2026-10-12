# Redline privacy policy

Effective 13 October 2026.

Redline is a Chrome extension for reviewing web pages: you point at something on a page, write what should change, and copy your notes with their screenshots. It has no servers, no accounts and no analytics, and it makes no network requests. Nothing Redline handles is sent to the developer or to anyone else.

## What Redline handles, and where it stays

Everything below stays on your computer.

- **Your notes**: the text you type for each capture.
- **Screenshots**: when you capture an element, an area or the screen, Redline takes a screenshot of the visible part of the tab you're on. It never takes screenshots on its own.
- **Page details for each note**: the page's title and address, the viewport size, and for an element its location in the page (a CSS path) and a short excerpt of its text. If the element is inside an iframe, the iframe's address without its query string.
- **History**: your last 50 copied sessions, so you can copy them again or continue them.

Notes, page details and History are kept in the extension's own storage (`chrome.storage` and IndexedDB). When you copy your notes, the screenshots are saved as PNG files in `Downloads/Redline` and the prompt is copied to your clipboard. Where you paste it is up to you.

### Pastes

To attach the screenshots when you paste into a web chat, Redline listens for paste events on pages. It compares a fingerprint of the pasted text with the last text it copied for you, on your computer. Anything else you paste is left alone and isn't stored.

## Sharing

Redline doesn't sell, share or transfer any data. It doesn't use data for advertising, creditworthiness or anything unrelated to taking and copying your review notes.

## Deleting your data

**Start a new session** clears the current notes. Uninstalling Redline deletes everything in its storage, History included. Screenshots saved to `Downloads/Redline` are ordinary files that you can delete yourself.

## Permissions

The [README](README.md#privacy-and-permissions) explains why Redline needs each permission it asks for.

## Changes and contact

Changes to this policy are published in this file, and its history is in the repository. Questions: [open an issue](https://github.com/NikaBarbakadze/Redline/issues).
