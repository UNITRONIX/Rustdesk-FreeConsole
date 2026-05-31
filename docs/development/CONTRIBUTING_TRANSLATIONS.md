# Contributing Translations to BetterDesk Console

This guide explains how to add new language translations to the BetterDesk Console web interface.

## Overview

BetterDesk uses a JSON-based internationalization (i18n) system that allows community members to easily add support for new languages without modifying any code.

## Quick Start

1. Copy an existing language file (e.g., `en.json`)
2. Rename it to your language code (e.g., `de.json` for German)
3. Translate all string values
4. Submit a pull request

## File Location

Language files are stored in:
```
web/lang/
├── en.json    # English (default)
├── pl.json    # Polish
├── de.json    # German (you can add this)
└── ...        # Other languages
```

## Language File Structure

Each language file is a JSON object with nested categories:

```json
{
  "meta": {
    "language": "English",
    "code": "en",
    "direction": "ltr",
    "author": "BetterDesk Team",
    "version": "1.0.0"
  },
  "common": {
    "loading": "Loading...",
    "save": "Save",
    "cancel": "Cancel"
  },
  "sidebar": {
    "dashboard": "Dashboard",
    "settings": "Settings"
  }
}
```

### Meta Section (Required)

| Field | Description | Example |
|-------|-------------|---------|
| `language` | Full language name in that language | `"Deutsch"` |
| `code` | ISO 639-1 language code | `"de"` |
| `direction` | Text direction (`ltr` or `rtl`) | `"ltr"` |
| `author` | Translator name/handle | `"Your Name"` |
| `version` | Translation version | `"1.0.0"` |

### Translation Categories

| Category | Description |
|----------|-------------|
| `common` | Common UI elements (buttons, labels) |
| `auth` | Login/authentication page |
| `sidebar` | Navigation sidebar |
| `dashboard` | Main dashboard page |
| `devices` | Device management section |
| `public_key` | Public key display section |
| `settings` | Settings page |
| `users` | User management (admin) |
| `about` | About page |
| `client_generator` | Client generator page |
| `errors` | Error messages |
| `time` | Time-related strings |
| `notifications` | Toast notifications |

## Step-by-Step Translation Guide

### 1. Copy the English Template

```bash
cd web/lang
cp en.json de.json  # Replace 'de' with your language code
```

### 2. Update Metadata

Edit the `meta` section with your language info:

```json
{
  "meta": {
    "language": "Deutsch",
    "code": "de",
    "direction": "ltr",
    "author": "Your GitHub Username",
    "version": "1.0.0"
  }
}
```

### 3. Translate All Strings

Go through each category and translate the string values:

```json
// English
"common": {
  "loading": "Loading...",
  "save": "Save"
}

// German
"common": {
  "loading": "Laden...",
  "save": "Speichern"
}
```

### 4. Handle Placeholders

Some strings contain placeholders like `{count}` or `{name}`. Keep these exactly as they are:

```json
// English
"showing_results": "Showing {count} devices"

// German
"showing_results": "Zeige {count} Geräte"
```

### 5. Verify JSON Syntax

Ensure your JSON is valid:
- Use double quotes for strings
- No trailing commas
- Proper nesting with braces

You can validate at: https://jsonlint.com/

### 6. Test Locally (Optional)

1. Start the BetterDesk console
2. Open browser at `http://localhost:5000`
3. Your language should appear in the language selector

### 7. Submit Pull Request

1. Fork the repository
2. Add your language file
3. Create a pull request with title: `Add [Language] translation`

## RTL Languages

For right-to-left languages (Arabic, Hebrew, etc.):

1. Set `"direction": "rtl"` in meta
2. The UI will automatically adjust

## Translation Guidelines

## Required Audit

Before submitting translation changes, run the strict i18n audit from the repository root:

```bash
npm run i18n:check
```

The audit compares every active locale against the combined `en.json` + `pl.json` key baseline for each product surface:

- `web-nodejs/lang/` for the web console
- `betterdesk-agent-client/src/locales/` for the endpoint agent UI
- `betterdesk-mgmt/src/locales/` for the operator desktop app

Every active locale must have the same key set as the EN/PL baseline, no empty values, and no visible English fallback text. The old `i18n:fix` workflow is intentionally disabled because copying English values into another locale creates a false-complete translation.

### Do's

- ✅ Keep translations concise (UI space is limited)
- ✅ Use formal/informal tone consistently
- ✅ Preserve placeholders exactly
- ✅ Test in browser if possible
- ✅ Keep JSON structure identical to English
- ✅ Translate every value in the target language before enabling that locale

### Don'ts

- ❌ Don't translate placeholder names (`{count}` → `{nombre}`)
- ❌ Don't change JSON keys (left side of `:`)
- ❌ Don't add or remove entries
- ❌ Don't include HTML tags unless present in English
- ❌ Don't fill missing keys with English text as a temporary fallback

## Example: Adding German

```json
{
  "meta": {
    "language": "Deutsch",
    "code": "de",
    "direction": "ltr",
    "author": "contributor123",
    "version": "1.0.0"
  },
  "common": {
    "loading": "Laden...",
    "save": "Speichern",
    "cancel": "Abbrechen",
    "delete": "Löschen",
    "edit": "Bearbeiten",
    "close": "Schließen",
    "confirm": "Bestätigen",
    "search": "Suchen",
    "filter": "Filtern",
    "refresh": "Aktualisieren",
    "copy": "Kopieren",
    "copied": "Kopiert!",
    "yes": "Ja",
    "no": "Nein",
    "online": "Online",
    "offline": "Offline",
    "all": "Alle",
    "none": "Keine",
    "actions": "Aktionen",
    "status": "Status",
    "details": "Details",
    "error": "Fehler",
    "success": "Erfolg",
    "warning": "Warnung",
    "info": "Info"
  }
}
```

## Supported Language Codes

Common ISO 639-1 codes:

| Code | Language | Code | Language |
|------|----------|------|----------|
| `en` | English | `it` | Italian |
| `pl` | Polish | `pt` | Portuguese |
| `de` | German | `ru` | Russian |
| `fr` | French | `zh` | Chinese |
| `es` | Spanish | `ja` | Japanese |
| `nl` | Dutch | `ko` | Korean |
| `tr` | Turkish | `ar` | Arabic |
| `uk` | Ukrainian | `he` | Hebrew |

## API Endpoints

The i18n system provides these API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/i18n/languages` | GET | List available languages |
| `/api/i18n/translations/{code}` | GET | Get translations for language |
| `/api/i18n/set/{code}` | POST | Set user's language preference |

## Questions?

- Open an issue on GitHub
- Check existing translations for reference
- Join community discussions

Thank you for helping make BetterDesk accessible to more users! 🌍
