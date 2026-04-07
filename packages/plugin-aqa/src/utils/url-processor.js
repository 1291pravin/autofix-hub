'use strict';

const fs = require('fs');

/**
 * Processes URL inputs for scanning.
 *
 * Accepts: array, comma-separated string, or path to a newline-delimited file.
 */
class URLProcessor {
  /**
   * Process URLs from various input formats.
   * @param {string|string[]} urlsInput
   * @returns {string[]} Valid HTTP(S) URLs
   */
  static processUrls(urlsInput) {
    if (!urlsInput) return [];

    // Array input
    if (Array.isArray(urlsInput)) {
      return urlsInput.map(u => u.trim()).filter(u => this.isValidURL(u));
    }

    // File input (only if the string is NOT a URL itself)
    if (typeof urlsInput === 'string' && !urlsInput.startsWith('http') && fs.existsSync(urlsInput)) {
      try {
        const urls = fs.readFileSync(urlsInput, 'utf8')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#') && this.isValidURL(l));
        console.log(`Loaded ${urls.length} URLs from file: ${urlsInput}`);
        return urls;
      } catch (err) {
        console.error(`Failed to read URLs from file ${urlsInput}:`, err.message);
        return [];
      }
    }

    // Comma-separated string
    if (typeof urlsInput === 'string') {
      const urls = urlsInput.split(',').map(u => u.trim()).filter(u => u && this.isValidURL(u));
      console.log(`Parsed ${urls.length} URLs from comma-separated input`);
      return urls;
    }

    return [];
  }

  /**
   * Validate that a string is an HTTP(S) URL.
   */
  static isValidURL(url) {
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch (_) {
      return false;
    }
  }
}

module.exports = URLProcessor;
