# AQA Fix Guide

Scanner-specific guidance for applying AI-generated fixes to AQA accessibility issues.

## Categories & Fix Patterns

### Missing Alt Text (`image-alt`)
- Examine the image context to determine its purpose
- If decorative: add `alt=""` and `role="presentation"`
- If informative: write descriptive alt text that conveys the image's meaning
- If functional (button/link): describe the action, not the image
- Keep alt text concise — under 125 characters

### Color Contrast (`color-contrast`)
- Adjust foreground or background color to meet WCAG AA ratio (4.5:1 normal text, 3:1 large text)
- Use colors from the existing design palette where possible
- Prefer darkening the foreground over lightening the background
- Verify the fix works for both light and dark themes if applicable

### Missing Labels (`label`)
- Associate a `<label>` element with the input using matching `for`/`id` attributes
- If a visible label exists but isn't associated: add the `for` attribute
- If no visible label is appropriate: add `aria-label` or `aria-labelledby`
- Ensure the label text clearly describes the input's purpose

### Heading Order (`heading-order`)
- Restructure heading levels to follow a logical hierarchy (h1 -> h2 -> h3, no skipping)
- Each page should have exactly one h1
- Use CSS to maintain visual styling if heading level changes affect appearance
- Preserve the semantic meaning of the content

### Language Attribute (`html-has-lang`)
- Add `lang` attribute to the `<html>` element
- Use the appropriate BCP 47 language tag (e.g., `lang="en"`)

### Tabindex (`tabindex`)
- Remove positive `tabindex` values (tabindex > 0) — they disrupt natural tab order
- Use `tabindex="0"` only for custom interactive elements that need keyboard focus
- Use `tabindex="-1"` for programmatically focusable elements not in tab order
- Ensure the DOM order matches the visual order for natural tab flow

### Keyboard / Focus (`keyboard`)
- Ensure the element is focusable via keyboard (Tab key)
- Add keyboard event handlers (Enter/Space for buttons, Enter for links)
- If using a custom interactive element: add appropriate `role` and `tabindex="0"`
- Ensure focus is visible with a focus indicator style

## Review Levels
- `quick`: Trivial fixes — `html-has-lang`, `tabindex` (no judgment calls)
- `careful`: Content-dependent fixes — alt text, contrast, labels, headings, ARIA, landmarks (need human judgment)

## General Rules
- Preserve visual appearance — accessibility fixes should not change how the page looks
- Follow existing component patterns and coding style
- Fix only the targeted issue — do not touch unrelated code
