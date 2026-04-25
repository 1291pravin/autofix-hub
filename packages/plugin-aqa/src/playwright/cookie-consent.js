'use strict';

// Cookie consent selectors (OneTrust, Didomi, TrustArc, Usercentrics, French)
const COOKIE_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.didomi-continue-without-agreeing',
  '#didomi-notice-agree-button',
  '[id*="truste-consent-button"]',
  'button[data-testid="uc-accept-all-button"]',
  'button.accept-all, button.accept_all',
  'button[id*="accept"], button[class*="accept"]',
  'button[id*="cookie"], button[class*="cookie"]',
  '.cookie-consent button, .consent-banner button',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Tout accepter")',
  'button:has-text("Accepter")',
  "button:has-text(\"J'accepte\")",
  'button:has-text("Continuer sans accepter")',
];

async function dismissCookieConsent(page) {
  for (const sel of COOKIE_CONSENT_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch (_) { /* ignore */ }
  }
}

module.exports = { COOKIE_CONSENT_SELECTORS, dismissCookieConsent };
