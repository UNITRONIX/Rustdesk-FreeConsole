/**
 * BetterDesk Console - i18n Service
 * Translation manager with JSON-based language files
 */

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { resolveLangFilePath, readLangFileText, langFileExists } = require('../lib/safePath');

// Supported languages metadata
const LANGUAGE_META = {
    'en': { name: 'English', native: 'English', flag: '🇬🇧', rtl: false },
    'pl': { name: 'Polish', native: 'Polski', flag: '🇵🇱', rtl: false },
    'de': { name: 'German', native: 'Deutsch', flag: '🇩🇪', rtl: false },
    'fr': { name: 'French', native: 'Français', flag: '🇫🇷', rtl: false },
    'es': { name: 'Spanish', native: 'Español', flag: '🇪🇸', rtl: false },
    'it': { name: 'Italian', native: 'Italiano', flag: '🇮🇹', rtl: false },
    'pt': { name: 'Portuguese', native: 'Português', flag: '🇵🇹', rtl: false },
    'nl': { name: 'Dutch', native: 'Nederlands', flag: '🇳🇱', rtl: false },
    'zh': { name: 'Chinese', native: '中文', flag: '🇨🇳', rtl: false },
    'ja': { name: 'Japanese', native: '日本語', flag: '🇯🇵', rtl: false },
    'ko': { name: 'Korean', native: '한국어', flag: '🇰🇷', rtl: false },
    'ar': { name: 'Arabic', native: 'العربية', flag: '🇸🇦', rtl: true },
    'he': { name: 'Hebrew', native: 'עברית', flag: '🇮🇱', rtl: true },
    'uk': { name: 'Ukrainian', native: 'Українська', flag: '🇺🇦', rtl: false },
    'tr': { name: 'Turkish', native: 'Türkçe', flag: '🇹🇷', rtl: false },
    'hi': { name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳', rtl: false },
    'sv': { name: 'Swedish', native: 'Svenska', flag: '🇸🇪', rtl: false },
    'nb': { name: 'Norwegian', native: 'Norsk', flag: '🇳🇴', rtl: false },
    'da': { name: 'Danish', native: 'Dansk', flag: '🇩🇰', rtl: false },
    'fi': { name: 'Finnish', native: 'Suomi', flag: '🇫🇮', rtl: false },
    'cs': { name: 'Czech', native: 'Čeština', flag: '🇨🇿', rtl: false },
    'hu': { name: 'Hungarian', native: 'Magyar', flag: '🇭🇺', rtl: false },
    'ro': { name: 'Romanian', native: 'Română', flag: '🇷🇴', rtl: false },
    'th': { name: 'Thai', native: 'ไทย', flag: '🇹🇭', rtl: false },
    'vi': { name: 'Vietnamese', native: 'Tiếng Việt', flag: '🇻🇳', rtl: false },
    'ru': { name: 'Russian', native: 'Русский', flag: '🇷🇺', rtl: false },
    'id': { name: 'Indonesian', native: 'Bahasa Indonesia', flag: '🇮🇩', rtl: false },
    'zh-TW': { name: 'Chinese (Traditional)', native: '繁體中文', flag: '🇹🇼', rtl: false },
};

// ISO 639-1 base tag, optional BCP 47 region/script subtag (e.g. en, zh-TW).
const LANG_BASE = '[a-z]{2,8}';
const LANG_SUBTAG = '-[A-Z][a-zA-Z]{1,7}';
const VALID_LANG_CODE = new RegExp(`^${LANG_BASE}(${LANG_SUBTAG})?$`);

// Security: reject malformed codes before filesystem lookup (path traversal).
/**
 * Validate language code format to prevent path traversal attacks.
 * @param {string} code - Language code to validate
 * @returns {boolean} - True if valid
 */
function isValidLangCode(code) {
    return typeof code === 'string' && VALID_LANG_CODE.test(code);
}

function stripBom(content) {
    return typeof content === 'string' && content.charCodeAt(0) === 0xFEFF
        ? content.slice(1)
        : content;
}

function deepMerge(base, overlay) {
    if (!base || typeof base !== 'object') return overlay;
    if (!overlay || typeof overlay !== 'object') return base;
    const merged = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            merged[key] = deepMerge(base[key], value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

class TranslationManager {
    constructor() {
        this.translations = {};
        this.availableLanguages = {};
        this.defaultLang = config.defaultLanguage || 'en';
    }
    
    /**
     * Initialize - load all language files
     */
    init() {
        this.loadAll();
        console.log(`i18n: Loaded ${Object.keys(this.availableLanguages).length} languages`);
    }
    
    /**
     * Load all language files from lang directory
     */
    loadAll() {
        const langDir = config.langDir;
        
        if (!fs.existsSync(langDir)) {
            console.warn(`Language directory not found: ${langDir}`);
            return;
        }
        
        const files = fs.readdirSync(langDir).filter(f => f.endsWith('.json'));
        
        for (const file of files) {
            const code = path.basename(file, '.json');
            this.loadLanguage(code);
        }
    }
    
    /**
     * Load a single language file
     */
    loadLanguage(code) {
        // Security: Validate language code to prevent path traversal
        if (!isValidLangCode(code)) {
            console.warn(`i18n: Invalid language code rejected: ${code}`);
            return false;
        }
        
        try {
            if (!langFileExists(config.langDir, code)) {
                return false;
            }

            const content = stripBom(readLangFileText(config.langDir, code));
            const data = JSON.parse(content);
            
            this.translations[code] = data;
            
            // Get metadata from file or fallback
            const meta = data._meta || LANGUAGE_META[code] || {
                name: code.toUpperCase(),
                native: code.toUpperCase(),
                flag: '🌐',
                rtl: false
            };
            
            this.availableLanguages[code] = {
                code,
                name: meta.name,
                native: meta.native,
                flag: meta.flag,
                rtl: meta.rtl || false
            };
            
            return true;
        } catch (err) {
            console.warn(`Failed to load language ${code}:`, err.message);
            return false;
        }
    }
    
    /**
     * Get a translation value by dot-separated key
     */
    translate(lang, key, vars = {}) {
        // Try requested language
        let value = this._getNestedValue(this.translations[lang], key);
        
        // Fallback to default language
        if (value === undefined && lang !== this.defaultLang) {
            value = this._getNestedValue(this.translations[this.defaultLang], key);
        }
        
        // Fallback to key itself
        if (value === undefined) {
            return key;
        }
        
        // Interpolate variables {varName}
        if (typeof value === 'string' && Object.keys(vars).length > 0) {
            for (const [varName, varValue] of Object.entries(vars)) {
                value = value.replace(new RegExp(`\\{${varName}\\}`, 'g'), varValue);
            }
        }
        
        return value;
    }
    
    /**
     * Get nested value from object using dot notation
     */
    _getNestedValue(obj, key) {
        if (!obj || !key) return undefined;
        
        const parts = key.split('.');
        let current = obj;
        
        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            current = current[part];
        }
        
        return current;
    }
    
    /**
     * Get all available languages
     */
    getAvailable() {
        return this.availableLanguages;
    }

    /**
     * Get available languages as a sorted list for UI rendering.
     */
    getAvailableList() {
        return Object.values(this.availableLanguages)
            .sort((a, b) => (a.native || a.name || a.code).localeCompare(b.native || b.name || b.code, undefined, { sensitivity: 'base' }));
    }
    
    /**
     * Get all translations for a language
     */
    getTranslations(code) {
        return this.translations[code] || null;
    }

    /**
     * Get translations with default-language fallback merged in.
     * Useful for client-side i18n where missing keys should not surface as raw keys.
     */
    getMergedTranslations(code) {
        const requested = this.translations[code];
        const fallback = this.translations[this.defaultLang] || {};
        if (!requested) return fallback;
        if (code === this.defaultLang) return requested;
        return deepMerge(fallback, requested);
    }
    
    /**
     * Check if language exists
     */
    hasLanguage(code) {
        return code in this.translations;
    }
    
    /**
     * Get language metadata
     */
    getLanguageMeta(code) {
        return this.availableLanguages[code] || null;
    }
    
    /**
     * Validate language file (compare keys with default language)
     */
    validateLanguage(code) {
        if (!this.translations[code]) {
            return { valid: false, error: 'Language not found' };
        }
        
        if (code === this.defaultLang) {
            return { valid: true, missing: [], extra: [] };
        }
        
        const defaultKeys = this._getAllKeys(this.translations[this.defaultLang]);
        const langKeys = this._getAllKeys(this.translations[code]);
        
        const missing = defaultKeys.filter(k => !langKeys.includes(k));
        const extra = langKeys.filter(k => !defaultKeys.includes(k) && !k.startsWith('_'));
        
        return {
            valid: missing.length === 0,
            missing,
            extra,
            coverage: ((defaultKeys.length - missing.length) / defaultKeys.length * 100).toFixed(1)
        };
    }
    
    /**
     * Get all keys from an object (flattened)
     */
    _getAllKeys(obj, prefix = '') {
        const keys = [];
        
        for (const [key, value] of Object.entries(obj || {})) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                keys.push(...this._getAllKeys(value, fullKey));
            } else {
                keys.push(fullKey);
            }
        }
        
        return keys;
    }
    
    /**
     * Add or update a language
     */
    saveLanguage(code, translations) {
        // Security: Validate language code to prevent path traversal
        if (!isValidLangCode(code)) {
            return { success: false, error: 'Invalid language code format' };
        }
        
        let filePath;
        try {
            filePath = resolveLangFilePath(config.langDir, code);
        } catch (err) {
            return { success: false, error: err.message };
        }

        try {
            fs.writeFileSync(filePath, JSON.stringify(translations, null, 2), 'utf8');
            this.loadLanguage(code);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
    
    /**
     * Delete a language file
     */
    deleteLanguage(code) {
        // Security: Validate language code to prevent path traversal
        if (!isValidLangCode(code)) {
            return { success: false, error: 'Invalid language code format' };
        }
        
        // Don't allow deleting default or core languages
        if (code === 'en' || code === 'pl') {
            return { success: false, error: 'Cannot delete core language' };
        }
        
        let filePath;
        try {
            filePath = resolveLangFilePath(config.langDir, code);
        } catch (err) {
            return { success: false, error: err.message };
        }

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            
            delete this.translations[code];
            delete this.availableLanguages[code];
            
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
}

// Singleton instance
const manager = new TranslationManager();

module.exports = {
    manager,
    LANGUAGE_META,
    isValidLangCode
};
