# AQA Extension Integration for Local Development

## Overview
Integrate the main UsableNet AQA Chrome extension (`lcoodjnlebepmajggdbmapnofedgiloa`) with autofix-hub to provide real-time accessibility scanning during local development, enabling developers to get instant feedback without dashboard dependencies.

## Context & Current State
- **Current Working System**: Page Capture extension (`llaaiankjgnonjipogopofnpahaoccfo`) is fully functional
- **Current Command**: `node scripts/test-playwright-scan.js https://fr.filorga.com aqa` (1,463 issues found)
- **Current Files**: Working implementation in `packages/plugin-aqa/src/playwright/index.js`
- **Current Extension**: Located at `packages/plugin-aqa/extensions/aqa-page-capture/`
- **Issue**: Page Capture requires dashboard upload, users want direct extension evaluation

## Target Extension Details
- **Extension ID**: `lcoodjnlebepmajggdbmapnofedgiloa`
- **Extension Name**: "UsableNet AQA" 
- **Chrome Web Store**: https://chromewebstore.google.com/detail/usablenet-aqa/lcoodjnlebepmajggdbmapnofedgiloa
- **Purpose**: Direct accessibility evaluation in Chrome without dashboard upload
- **Key Difference**: Shows results in Chrome UI vs uploading to dashboard

## Objectives
- Enable AQA scans on any URL using the main AQA Chrome extension
- Capture results programmatically from the AQA extension
- Feed results into autofix-hub database for processing
- Simple URL-based scanning without dashboard dependencies

## Implementation Plan

### Phase 1: Extension Analysis & Setup

#### 1.1 Extension Acquisition
```bash
# Download main AQA extension
mkdir -p packages/plugin-aqa/extensions/usablenet-aqa
cd packages/plugin-aqa/extensions/usablenet-aqa

# Method 1: Chrome Web Store download (use extension downloader tools)
# Method 2: Get directly from UsableNet
# Method 3: Use existing Chrome profile with extension installed
```

#### 1.2 Communication Protocol Research
**Critical Analysis Points:**
- Analyze extension's `manifest.json` for permissions and structure
- Study background script messaging patterns (likely different from Page Capture)
- Identify content scripts and injection methods
- Document extension's internal API and message format
- Determine how extension triggers evaluations and stores results
- **Key Question**: Does this extension use `externally_connectable` like Page Capture?

**Reference Implementation**: Study the working Page Capture approach in:
- `packages/plugin-aqa/src/playwright/index.js` (lines 277-299 for extension loading)
- `packages/plugin-aqa/extensions/aqa-page-capture/` (working extension structure)
- Note: Page Capture uses `page.evaluate()` for `chrome.runtime.sendMessage()` calls

#### 1.3 Extension Loading Infrastructure
```javascript
// packages/plugin-aqa/src/playwright/aqa-extension.js
async function loadAQAExtension(browser) {
  const context = await browser.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${AQA_EXTENSION_DIR}`,
      `--load-extension=${AQA_EXTENSION_DIR}`,
    ],
  });
  return context;
}
```

### Phase 2: Basic URL Scanning Engine

#### 2.1 Core Scanner Implementation
```javascript
// packages/plugin-aqa/src/playwright/aqa-main-extension.js
async function _scanWithAQAExtension(urls, browser, config) {
  // Reference: Copy pattern from working _scanWithAQA in index.js (lines 198-525)
  const context = await loadAQAExtension(browser);
  const results = [];
  
  for (const url of urls) {
    const page = await context.newPage();
    await page.goto(url);
    
    // Wait for page to load (copy from index.js lines 340-345)
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    
    // Trigger AQA evaluation
    const issues = await triggerAQAEvaluation(page);
    results.push(...issues);
  }
  
  return results;
}
```

#### 2.2 Evaluation Trigger Mechanism
**Research Priority:**
- How does the main AQA extension start evaluation? (button click, API call, automatic?)
- Can we trigger it programmatically via Playwright?
- **Reference**: Page Capture uses specific message actions like `bg-ext-health-check`, `bg-ext-create-flow`

**Implementation Approach:**
```javascript
async function triggerAQAEvaluation(page) {
  // Method 1: Click extension icon programmatically
  await page.click('[aria-label*="AQA"], [title*="AQA"]');
  
  // Method 2: Send message to extension (if it supports external messaging)
  const results = await page.evaluate(() => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage('EXTENSION_ID', { action: 'evaluate' }, resolve);
    });
  });
  
  // Method 3: Intercept and trigger internal evaluation
  return await interceptEvaluation(page);
}
```

#### 2.3 Result Extraction & Database Integration
**Extraction Methods (in order of preference):**
```javascript
async function extractAQAResults(page) {
  // Method 1: Extract from extension popup UI
  const popupResults = await page.evaluate(() => {
    // Access extension popup content via DOM inspection
    const issuesPanel = document.querySelector('[data-testid="aqa-issues"]');
    return parseIssuesFromDOM(issuesPanel);
  });
  
  // Method 2: Extract from extension storage (like Page Capture)
  const storageResults = await page.evaluate(() => {
    return chrome.storage.local.get(['aqa_results', 'last_scan']);
  });
  
  // Method 3: Intercept network calls to AQA API (most reliable)
  const apiResults = await interceptAPICalls(page);
  
  // Normalize using existing pipeline (reference index.js lines 456-510)
  const normalizedResults = normalizeResults(popupResults || storageResults || apiResults);
  return feedIntoAutofixDB(normalizedResults);
}

// Network interception (reference existing API patterns)
async function interceptAPICalls(page) {
  const apiCalls = [];
  page.on('response', async (response) => {
    if (response.url().includes('api-aqa.usablenet.com')) {
      const data = await response.json();
      apiCalls.push(data);
    }
  });
  return apiCalls;
}
```

#### 2.4 Usage Example
```bash
# Simple URL scanning
node scripts/test-playwright-scan.js https://fr.filorga.com aqa-main

# Multiple URLs
node scripts/test-playwright-scan.js https://fr.filorga.com,https://example.com aqa-main
```

## Technical Specifications

### File Structure
```
packages/plugin-aqa/
|-- extensions/
|   |-- aqa-page-capture/       # Current Page Capture extension
|   |-- usablenet-aqa/          # Main AQA extension (NEW)
|-- src/
|   |-- playwright/
|   |   |-- index.js            # Current orchestrator
|   |   |-- aqa-extension.js    # Extension loading & communication (NEW)
|   |   |-- aqa-main-extension.js # Main extension scanner (NEW)
|   |   -- result-extractor.js  # Result extraction methods (NEW)
```

### API Design
```javascript
// Main API surface
const aqaMainExtension = {
  scan: async (urls, options) => { /* ... */ },
  extractResults: async (page) => { /* ... */ },
  feedIntoDatabase: async (results) => { /* ... */ }
};
```

### Configuration Schema
```typescript
interface AQAExtensionConfig {
  extensionType: 'page-capture' | 'main';
  urls: string[];
  apiKey: string;
  teamSlug: string;
}
```

## Success Metrics
- **Scan Time**: < 10 seconds for typical pages
- **Accuracy**: Match AQA dashboard results within 95%
- **Simplicity**: Single command execution for any URL
- **Integration**: Seamless feeding into autofix-hub database

## Risks & Mitigations

### Risk 1: Extension Communication Complexity
- **Mitigation**: Start with UI scraping, fallback to network interception
- **Alternative**: Use Chrome DevTools Protocol if direct extension access fails

### Risk 2: Extension Updates Breaking Integration
- **Mitigation**: Version pinning and automated testing with extension updates
- **Fallback**: Graceful degradation to Page Capture method

## Implementation Timeline

### Week 1: Research & Setup
- Download and analyze AQA extension
- Document communication protocol
- Set up basic extension loading

### Week 2: Core Scanning
- Implement evaluation trigger
- Build result extraction
- Create basic scanner
- Integrate with autofix-hub database

## Deliverables

### 1. Extension Analysis Report
- Communication protocol documentation
- Extension structure and messaging format
- Trigger mechanism identification

### 2. Main Extension Scanner
- **File**: `packages/plugin-aqa/src/playwright/aqa-main-extension.js`
- **Function**: `_scanWithAQAExtension(urls, browser, config)`
- **Pattern**: Copy from working `_scanWithAQA` in `index.js`

### 3. Database Integration
- **Reference**: Use existing normalization pipeline in `packages/plugin-aqa/src/index.js`
- **Function**: `normalize()` and `fetch()` methods
- **Format**: Match existing AQA issue structure

### 4. CLI Integration
- **File**: `scripts/test-playwright-scan.js` (modify existing)
- **Add**: Support for `aqa-main` engine option
- **Pattern**: Follow existing `aqa` and `axe` engine pattern

### 5. Documentation & Setup
- Extension installation guide
- Configuration instructions
- Usage examples

### 6. Test Suite
- Unit tests for extraction methods
- Integration tests for full scan flow

## Integration with Current System

### Backward Compatibility
- **Existing Page Capture**: `node scripts/test-playwright-scan.js https://fr.filorga.com aqa` (unchanged)
- **New Main Extension**: `node scripts/test-playwright-scan.js https://fr.filorga.com aqa-main`
- **Configuration**: Engine selection via command line argument

### CLI Integration Steps
```javascript
// In scripts/test-playwright-scan.js (modify existing)
const engine = process.argv[3] || 'axe'; // Current: axe, aqa, both
// Add: aqa-main as new option

if (engine === 'aqa-main') {
  // Call new main extension scanner
  result = await require('../packages/plugin-aqa/src/playwright/aqa-main-extension.js')
    .scanWithAQAExtension(urls, browser, config);
}
```

### File Structure Integration
```
packages/plugin-aqa/src/playwright/
|-- index.js                    # Current orchestrator (DO NOT MODIFY)
|-- aqa-main-extension.js      # NEW: Main extension scanner
|-- aqa-extension.js           # NEW: Extension loading utilities
```

### Database Integration Pattern
```javascript
// Use existing normalization pipeline
const normalizedIssues = await require('../index.js').normalize({
  source: 'aqa-main-extension',
  issues: rawResults,
  metadata: { url, timestamp, engine: 'aqa-main' }
});
```

## Credentials & Configuration

### Required Environment Variables
```bash
# Main AQA Extension Credentials (REQUIRED)
AQA_API_KEY=your-aqa-cloud-api-key          # From AQA Profile settings
AQA_TEAM_SLUG=your-team-slug                # Your team name in AQA

# Optional: Extension-specific fallback
AQA_EXTENSION_API_KEY=your-extension-key     # Optional fallback
```

### Credential Sources

#### AQA Cloud API Key (`AQA_API_KEY`)
- **Source**: AQA Dashboard (https://aqa.usablenet.com/) 
- **Path**: Profile Settings > API Keys
- **Purpose**: Direct API calls to AQA cloud services
- **Format**: Long alphanumeric string

#### Team Slug (`AQA_TEAM_SLUG`)
- **Source**: Your AQA team URL or dashboard
- **Example**: `colgate`, `your-team-name`
- **Purpose**: Identifies your team in AQA API calls

### Configuration Flow
```bash
# Current: Page Capture for automated scans
node scripts/test-playwright-scan.js https://fr.filorga.com aqa

# New: Main AQA extension for direct scanning
node scripts/test-playwright-scan.js https://fr.filorga.com aqa-main
```

### Result Handling
- Both approaches feed into same normalization pipeline
- Consistent issue format across both methods
- Unified reporting and autofix capabilities

## Testing & Debugging Guide

### Development Testing Steps
1. **Extension Loading Test**
   ```bash
   # Test if extension loads correctly
   node -e "
   const { chromium } = require('playwright');
   chromium.launchPersistentContext('./test-profile', {
     headless: false,
     args: ['--load-extension=./packages/plugin-aqa/extensions/usablenet-aqa']
   }).then(ctx => console.log('Extension loaded'));
   "
   ```

2. **Communication Test**
   ```bash
   # Test extension communication (after implementing)
   node scripts/test-playwright-scan.js https://example.com aqa-main --debug
   ```

3. **Result Extraction Test**
   ```bash
   # Test different extraction methods
   DEBUG=aqa-main node scripts/test-playwright-scan.js https://example.com aqa-main
   ```

### Debugging Tools
- **Chrome DevTools**: Inspect extension background scripts
- **Playwright Inspector**: `DEBUG=pw:api node scripts/test-playwright-scan.js`
- **Extension Logs**: Check chrome://extensions/ for extension errors

### Common Issues & Solutions
- **Extension not loading**: Check manifest.json syntax and permissions
- **Communication failed**: Verify `externally_connectable` configuration
- **No results found**: Check evaluation trigger mechanism
- **Results format mismatch**: Compare with Page Capture result structure

### Success Criteria
- [ ] Extension loads without errors
- [ ] Can trigger evaluation programmatically
- [ ] Results extracted in expected format
- [ ] Results feed into autofix-hub database
- [ ] CLI command works: `node scripts/test-playwright-scan.js https://example.com aqa-main`

This plan provides a complete implementation guide with all necessary context, references to working code, and step-by-step instructions for integrating the main AQA extension while maintaining compatibility with existing Page Capture workflows.
