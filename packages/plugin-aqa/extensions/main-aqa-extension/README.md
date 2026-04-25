# Main UsableNet AQA Extension

## Overview

This directory holds the unpacked **main UsableNet AQA Chrome extension** (ID: `lcoodjnlebepmajggdbmapnofedgiloa`) used for direct accessibility evaluation in the browser.

**This is different from the "AQA Page Capture" extension** used by the `aqa` engine. The main AQA extension performs evaluations locally without requiring dashboard upload.

## Setup

### Option 1: Copy from Chrome Profile (Recommended)

1. Install the "UsableNet AQA" extension from the Chrome Web Store:
   https://chromewebstore.google.com/detail/usablenet-aqa/lcoodjnlebepmajggdbmapnofedgiloa

2. Open `chrome://extensions/` and enable **Developer mode** (toggle in top-right)

3. Find "UsableNet AQA" and note the **Extension ID** and **source directory path**

4. Copy all extension files to this directory:
   ```bash
   cp -r /path/to/chrome/extensions/lcoodjnlebepmajggdbmapnofedgiloa/* \
     packages/plugin-aqa/extensions/main-aqa-extension/
   ```

5. Verify `manifest.json` exists in this directory

### Option 2: Unpack from CRX

If you have a `.crx` file (e.g., `main-aqa.crx` already in this directory):

1. Rename `main-aqa.crx` to `main-aqa.zip`
2. Extract the contents:
   ```bash
   cd packages/plugin-aqa/extensions/main-aqa-extension
   unzip main-aqa.zip -d .
   ```
3. Verify `manifest.json` exists

### Option 3: Get from UsableNet

Contact UsableNet support for the unpacked extension files and place them here.

## Usage

```bash
# Scan with the main AQA extension
node scripts/test-playwright-scan.js https://example.com aqa-main

# Multiple URLs
node scripts/test-playwright-scan.js https://example.com,https://other.com aqa-main

# With debug output
DEBUG=aqa-main node scripts/test-playwright-scan.js https://example.com aqa-main
```

## Required Environment Variables

No API keys are required for the main AQA extension — it evaluates locally.

However, these optional variables may enhance results:

```bash
# Optional: AQA API credentials (for enriched metadata)
AQA_API_KEY=your-aqa-cloud-api-key
AQA_TEAM_SLUG=your-team-slug
```

## File Structure

After setup, this directory should contain:

```
main-aqa-extension/
├── manifest.json          # Extension manifest (REQUIRED)
├── background.js          # Background/service worker script
├── content.js             # Content script(s)
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic
├── icons/                 # Extension icons
├── README.md              # This file
└── ...                    # Other extension files
```

## Notes

- The extension requires **headed mode** (not headless) — Playwright will launch a visible browser window
- Extension files are gitignored (binary/licensed content) — only this README and `.gitkeep` are committed
- If the extension fails to load, check `chrome://extensions/` for manifest errors
- The extension ID may differ when loaded unpacked vs from the Chrome Web Store

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Extension not found" | Ensure `manifest.json` exists in this directory |
| "Service worker not found" | Check manifest.json has valid `background.service_worker` |
| "Cannot trigger evaluation" | The extension may not support external messaging — check the Communication Protocol section below |
| "No results extracted" | Try running with `--debug` flag; check if the extension panel appears |

## Communication Protocol

The scanner attempts multiple methods to interact with the extension:

1. **Direct messaging** — `chrome.runtime.sendMessage()` from page context
2. **DOM interaction** — Click evaluation buttons injected by the extension
3. **Keyboard shortcuts** — Trigger extension via hotkeys (e.g., Alt+Shift+A)
4. **Network interception** — Capture API calls the extension makes during evaluation

Results are extracted via:

1. **Network interception** — Parse responses from AQA API endpoints
2. **Extension storage** — Read from `chrome.storage.local`
3. **DOM scraping** — Parse the extension's injected results panel
4. **Console logs** — Check for structured data output
