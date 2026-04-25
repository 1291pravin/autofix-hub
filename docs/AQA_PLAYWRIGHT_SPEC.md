# AQA Playwright Extension Integration - Technical Specification

## Overview

This specification outlines the enhancement of the existing AQA plugin to support real-time accessibility scanning using the UsableNet AQA Chrome extension with Playwright. This enables scanning of live web pages in real browser contexts, providing richer data and dynamic content handling that complements the existing API-based approach.

## Problem Statement

The current AQA plugin only supports fetching results from pre-completed test runs via the AQA cloud API. This has limitations:

- Cannot scan dynamically generated content
- No real-time scanning during development
- Limited element context (no screenshots, coordinates, or DOM snapshots)
- Cannot handle authentication-protected pages easily
- Results are dependent on pre-configured test runs

## Solution Overview

Extend the existing AQA plugin to support an alternative scanning method using Playwright to control a browser with the AQA Chrome extension installed. This provides:

- Real-time scanning of any URL
- Dynamic content handling (JavaScript-rendered pages)
- Enhanced element context (screenshots, coordinates, DOM snapshots)
- Authentication support
- Development-time scanning capabilities

## Architecture

### Current State (API Method)
```
AQA Cloud API (pre-completed runs) 
    |
    v
fetch() -> normalize() -> Database -> Fix Generation
```

### Enhanced State (Dual Method)
```
                    +---------------------+
                    |  Scanning Method    |
                    +---------------------+
                           |
            +-------------+-------------+
            |                           |
            v                           v
    AQA Cloud API              Playwright + AQA Extension
    (existing)                 (NEW)
            |                           |
            v                           v
    normalize()              Enhanced normalize()
            |                           |
            +-------------+-------------+
                          |
                          v
                 Database -> Fix Generation
```

## Technical Components

### 1. Extension Management System

**Purpose**: Download, install, and manage the AQA Chrome extension

**Extension Details**:
- **Chrome Web Store URL**: https://chromewebstore.google.com/detail/usablenet-aqa/lcoodjnlebepmajggdbmapnofedgiloa
- **Extension ID**: `lcoodjnlebepmajggdbmapnofedgiloa`
- **Current Version**: 3.3.15 (822KiB)
- **Download URL**: `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=98.0.4758.102&acceptformat=crx2&x=id%3Dlcoodjnlebepmajggdbmapnofedgiloa%26uc`

**Components**:
- `extension-downloader.js` - Downloads extension from Chrome Web Store
- `extension-loader.js` - Loads extension in Playwright context
- Extension storage directory: `packages/plugin-aqa/extensions/aqa-extension/`

**Implementation Details**:
```javascript
class ExtensionDownloader {
  async downloadExtension(extensionId) {
    // Use Playwright's built-in fetch or Node.js https module
    const downloadUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.version}&acceptformat=crx2&x=id%3D${extensionId}%26uc`;
    
    // Download CRX from Chrome Web Store
    // Extract to local directory
    // Analyze manifest.json for structure
  }
}

class ExtensionLoader {
  async loadExtension(browserContext, extensionPath) {
    // Load extension with Playwright
    // Wait for service worker initialization
    // Return extension ID and handles
  }
}
```

### 2. API Key Management System

**Purpose**: Inject and manage AQA API credentials in extension storage

**Components**:
- `api-key-manager.js` - Handles API key injection and validation

**Implementation Details**:
```javascript
class APIKeyManager {
  async injectCredentials(context, apiKey, teamSlug) {
    // Method 1: Direct storage injection
    await context.addInitScript(() => {
      chrome.storage.local.set({
        'aqa-api-key': apiKey,
        'aqa-team-slug': teamSlug
      });
    });
    
    // Method 2: Background script communication
    const serviceWorker = await this.getServiceWorker(context);
    await serviceWorker.evaluate((creds) => {
      chrome.runtime.sendMessage({ 
        type: 'SET_CREDENTIALS', 
        ...creds 
      });
    });
  }
}
```

### 3. Scan Controller

**Purpose**: Control the extension scanning workflow

**Components**:
- `scan-controller.js` - Manages page navigation and scan triggering

**Implementation Details**:
```javascript
class ScanController {
  async scanPage(page, options = {}) {
    // Navigate to target URL
    await page.goto(options.url, { waitUntil: 'networkidle' });
    
    // Handle authentication if needed
    if (options.auth) {
      await this.handleAuthentication(page, options.auth);
    }
    
    // Trigger extension scan
    await this.triggerScan(page);
    
    // Monitor scan progress
    const results = await this.waitForResults(page);
    
    return results;
  }
}
```

### 4. Result Extraction System

**Purpose**: Extract and normalize scan results from extension

**Components**:
- `result-extractor.js` - Extracts results from extension storage/DOM

**Implementation Details**:
```javascript
class ResultExtractor {
  async extractResults(serviceWorker, page) {
    // Get results from extension storage
    const scanResults = await serviceWorker.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.get(['scanResults'], resolve);
      });
    });
    
    // Extract enhanced metadata
    const screenshots = await this.captureScreenshots(page, scanResults);
    const domSnapshots = await this.captureDOMSnapshots(page, scanResults);
    
    // Normalize to existing format
    return this.normalizeResults(scanResults, {
      screenshots,
      domSnapshots,
      pageUrl: page.url(),
      timestamp: new Date().toISOString()
    });
  }
}
```

## Data Flow

### Playwright Scanning Flow

1. **Initialization**
   ```
   Extension Download -> Extension Load -> API Key Injection
   ```

2. **Page Scanning**
   ```
   URL Navigation -> Page Load -> Authentication (if needed) -> 
   Extension Trigger -> Scan Execution -> Result Extraction
   ```

3. **Result Processing**
   ```
   Raw Extension Results -> Normalization -> Database Storage -> 
   Scoring/Clustering -> Fix Generation
   ```

### Enhanced Data Model

**Existing Fields** (preserved):
- `id`, `rule_id`, `severity`, `category`, `description`
- `selector`, `tag_name`, `html_snippet`
- `wcag_criteria`, `solutions`, `metadata`

**New Enhanced Fields**:
```javascript
{
  // Enhanced element context
  element_coordinates: { x: number, y: number, width: number, height: number },
  element_screenshot: 'data:image/png;base64,...',
  dom_snapshot: { html: string, computedStyles: object },
  
  // Page context
  page_screenshot: 'data:image/png;base64,...',
  viewport_size: { width: number, height: number },
  user_agent: string,
  
  // Scan metadata
  scan_method: 'playwright',
  scan_timestamp: string,
  scan_duration: number,
  extension_version: string
}
```

## Configuration System

### Configuration Sources (Priority Order)

1. **Command Line Arguments**
   ```bash
   autofix-hub aqa fetch --method playwright --url https://example.com
   ```

2. **Environment Variables**
   ```bash
   AQA_METHOD=playwright
   AQA_URLS=https://example.com,https://example.com/checkout
   AQA_API_KEY=your-key
   AQA_TEAM_SLUG=your-team
   ```

3. **Configuration File**
   ```json
   // ~/.autofix-hub/credentials.json
   {
     "aqa": {
       "method": "playwright",
       "urls": ["https://example.com", "https://example.com/checkout"],
       "api_key": "your-key",
       "team_slug": "your-team",
       "extension_options": {
         "include_screenshots": true,
         "wait_time": 5000,
         "selector": "#main-content"
       }
     }
   }
   ```

4. **Interactive Setup**
   ```bash
   autofix-hub setup
   # Prompts for method selection, URLs, credentials
   ```

### URL Processing

```javascript
function processUrls(urlsInput) {
  if (!urlsInput) return [];
  
  // File input
  if (fs.existsSync(urlsInput)) {
    return fs.readFileSync(urlsInput, 'utf8')
      .split('\n')
      .filter(line => line.trim());
  }
  
  // Comma-separated URLs
  return urlsInput.split(',')
    .map(url => url.trim())
    .filter(url => url);
}
```

## Integration Points

### 1. Plugin Extension

**File**: `packages/plugin-aqa/src/index.js`

**Enhanced Methods**:
```javascript
module.exports = {
  // Existing methods (unchanged)
  name: 'aqa',
  fetch: existingFetchMethod,  // Will be enhanced
  normalize: existingNormalizeMethod,
  // ... other existing methods
  
  // NEW: Playwright scanning
  scanWithPlaywright: async (config, urls) => {
    // Implementation of Playwright scanning
  },
  
  // Enhanced setup prompts
  setupPrompts: enhancedSetupPrompts,
  
  // Enhanced fetch method with routing
  fetch: async (config) => {
    const method = config.method || 'api';
    
    if (method === 'playwright') {
      const urls = processUrls(config.urls || process.env.AQA_URLS);
      if (urls.length === 0) {
        throw new Error('Playwright method requires URLs');
      }
      return module.exports.scanWithPlaywright(config, urls);
    }
    
    // Existing API method
    return existingFetchMethod(config);
  }
};
```

### 2. Dependencies

**Package**: `packages/plugin-aqa/package.json`

```json
{
  "dependencies": {
    "@autofix-hub/core": "workspace:*",
    "playwright": "^1.40.0"
  }
}
```

**Note**: Playwright includes built-in fetch capabilities, so no additional HTTP client dependencies are needed.

### 3. File Structure

```
packages/plugin-aqa/
|
|-- src/
|   |-- index.js                    # Enhanced main plugin
|   |-- playwright/                 # NEW
|   |   |-- extension-loader.js
|   |   |-- scan-controller.js
|   |   |-- result-extractor.js
|   |   |-- api-key-manager.js
|   |   -- extension-downloader.js
|   |-- utils/                      # NEW
|   |   -- url-processor.js
|   |   -- result-normalizer.js
|   -- config/                      # NEW
|       -- playwright-config.js
|
|-- extensions/                     # NEW
|   -- aqa-extension/               # Downloaded extension
|       -- manifest.json
|       -- background.js
|       -- popup.html
|       -- content.js
|       -- icons/
|
|-- package.json                    # Enhanced with new deps
```

## Error Handling & Edge Cases

### 1. Extension Issues

**Scenario**: Extension fails to load or crashes
```javascript
try {
  await loader.loadExtension(context, extensionPath);
} catch (error) {
  if (error.message.includes('extension')) {
    console.warn('Extension failed, falling back to API method');
    return existingFetchMethod(config);
  }
  throw error;
}
```

### 2. Network Issues

**Scenario**: Page fails to load or timeout
```javascript
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
} catch (error) {
  if (error.name === 'TimeoutError') {
    console.warn(`Page load timeout for ${url}, skipping`);
    return null; // Skip this URL but continue others
  }
  throw error;
}
```

### 3. Authentication Failures

**Scenario**: Login fails or session expires
```javascript
if (options.auth) {
  try {
    await this.handleAuthentication(page, options.auth);
  } catch (authError) {
    console.warn(`Authentication failed for ${url}, skipping`);
    return null;
  }
}
```

### 4. Extension Communication

**Scenario**: Extension doesn't respond to messages
```javascript
const results = await Promise.race([
  this.waitForResults(page),
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Extension timeout')), 60000)
  )
]);
```

## Performance Considerations

### 1. Parallel Scanning

```javascript
// Scan multiple URLs concurrently
const results = await Promise.allSettled(
  urls.map(url => this.scanPage(context, url, options))
);
```

### 2. Resource Management

```javascript
// Clean up browser resources
async cleanup() {
  if (this.browser) {
    await this.browser.close();
  }
  if (this.userDataDir) {
    await fs.rm(this.userDataDir, { recursive: true });
  }
}
```

### 3. Caching

```javascript
// Cache extension download
if (!fs.existsSync(extensionPath)) {
  await this.downloadExtension();
}
```

## Testing Strategy

### 1. Unit Tests

- Extension downloader functionality
- URL processing utilities
- Result normalization
- Configuration parsing

### 2. Integration Tests

- Extension loading and communication
- API key injection
- Basic scan workflow
- Error handling scenarios

### 3. End-to-End Tests

- Complete scan workflow
- Multiple URL scanning
- Authentication handling
- Result database integration

### 4. Test Fixtures

```javascript
// tests/fixtures/sample-extension/
// Mock extension for testing
// tests/fixtures/sample-pages/
// Local HTML files for testing
```

## Security Considerations

### 1. API Key Protection

- Store API keys in secure storage (chrome.storage.local)
- Never log API keys
- Use environment variables or credential files

### 2. Extension Security

- Verify extension checksum before loading
- Use official Chrome Web Store extension
- Regularly update to latest version

### 3. Network Security

- Validate URLs before navigation
- Handle malicious content safely
- Respect robots.txt and security policies

## Deployment & Distribution

### 1. Package Size

- Extension will increase plugin size significantly (~822KB)
- Consider optional installation: `npm install @autofix-hub/plugin-aqa-playwright`

### 2. Browser Requirements

- Requires Chromium-based browser
- Playwright downloads browser automatically
- Document system requirements

### 3. Extension Updates

- Implement extension version checking
- Auto-update mechanism for extension
- Compatibility matrix with Playwright versions

## Migration Strategy

### Phase 1: Foundation (Week 1-2)
- Set up Playwright infrastructure
- Implement extension download and loading
- Basic API key injection
- Simple scan triggering

### Phase 2: Core Functionality (Week 3-4)
- Result extraction and normalization
- URL processing and configuration
- Error handling and edge cases
- Integration with existing plugin

### Phase 3: Enhanced Features (Week 5-6)
- Screenshots and DOM snapshots
- Authentication support
- Parallel scanning
- Performance optimization

### Phase 4: Polish & Testing (Week 7-8)
- Comprehensive testing
- Documentation and examples
- Error handling refinement
- Performance tuning

## Success Metrics

### 1. Functional Metrics
- Successfully scan test URLs
- Extract accessibility issues
- Integration with existing database
- Backward compatibility maintained

### 2. Performance Metrics
- Scan time per page < 30 seconds
- Memory usage < 500MB per scan
- Extension load time < 5 seconds
- Parallel scanning efficiency

### 3. Reliability Metrics
- 95%+ scan success rate
- Graceful error handling
- Extension communication reliability
- Resource cleanup verification

## Future Enhancements

### 1. Advanced Features
- Visual regression testing
- Comparative analysis (before/after)
- Real-time development monitoring
- CI/CD integration patterns

### 2. Multi-Extension Support
- Support for other accessibility extensions
- Extension marketplace concept
- Plugin system for extensions

### 3. Cloud Integration
- Hybrid cloud/local scanning
- Distributed scanning network
- Result sharing and collaboration

## Conclusion

This specification outlines a comprehensive enhancement to the AQA plugin that adds real-time scanning capabilities while maintaining full backward compatibility. The modular design ensures that existing users are unaffected while providing powerful new capabilities for development-time accessibility testing.

The implementation leverages Playwright's robust browser automation capabilities and the existing AQA extension, creating a seamless integration that enhances the autofix-hub ecosystem without disrupting current workflows.
