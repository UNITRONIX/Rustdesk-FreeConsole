/**
 * BetterDesk Console - Accessibility Preferences
 */

(function() {
    'use strict';

    const STORAGE_KEY = 'betterdesk_accessibility_v1';
    const DEFAULTS = Object.freeze({
        fontScale: 100,
        lineHeight: 1.5,
        letterSpacing: 0,
        wordSpacing: 0,
        saturation: 100,
        contrast: 'normal',
        colorFilter: 'none',
        activeProfile: '',
        readableFont: false,
        dyslexiaFont: false,
        underlineLinks: false,
        highlightLinks: false,
        highlightHeadings: false,
        strongFocus: false,
        largeCursor: false,
        reduceMotion: false,
        pauseAnimations: false,
        readingGuide: false,
        readingMask: false,
        hideMedia: false
    });

    const SELECT_VALUES = {
        contrast: ['normal', 'high-dark', 'high-light', 'yellow-black'],
        colorFilter: ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia']
    };

    let settings = loadSettings();
    let modalEl = null;
    let lastFocusedEl = null;
    let readingUiReady = false;
    let currentPointerY = Math.round(window.innerHeight / 2);

    function tr(key, fallback) {
        const value = typeof window._ === 'function' ? window._(`accessibility.${key}`) : `accessibility.${key}`;
        return value === `accessibility.${key}` ? fallback : value;
    }

    function esc(value) {
        return window.Utils?.escapeHtml ? Utils.escapeHtml(String(value)) : String(value);
    }

    function clampNumber(value, min, max, fallback) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(max, Math.max(min, numeric));
    }

    function sanitize(candidate) {
        const source = candidate && typeof candidate === 'object' ? candidate : {};
        const clean = { ...DEFAULTS };

        clean.fontScale = clampNumber(source.fontScale, 90, 160, DEFAULTS.fontScale);
        clean.lineHeight = clampNumber(source.lineHeight, 1.2, 2.1, DEFAULTS.lineHeight);
        clean.letterSpacing = clampNumber(source.letterSpacing, 0, 0.14, DEFAULTS.letterSpacing);
        clean.wordSpacing = clampNumber(source.wordSpacing, 0, 0.22, DEFAULTS.wordSpacing);
        clean.saturation = clampNumber(source.saturation, 0, 180, DEFAULTS.saturation);

        clean.contrast = SELECT_VALUES.contrast.includes(source.contrast) ? source.contrast : DEFAULTS.contrast;
        clean.colorFilter = SELECT_VALUES.colorFilter.includes(source.colorFilter) ? source.colorFilter : DEFAULTS.colorFilter;
        clean.activeProfile = ['lowVision', 'dyslexia', 'motionSafe', 'colorAssist'].includes(source.activeProfile) ? source.activeProfile : DEFAULTS.activeProfile;

        Object.keys(DEFAULTS).forEach(key => {
            if (typeof DEFAULTS[key] === 'boolean') clean[key] = source[key] === true;
        });

        return clean;
    }

    function loadSettings() {
        try {
            return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
        } catch (_) {
            return { ...DEFAULTS };
        }
    }

    function saveSettings(nextSettings) {
        settings = sanitize(nextSettings);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (_) { /* localStorage may be disabled */ }
        applySettings(settings);
        syncButtonState();
        return settings;
    }

    function resetSettings() {
        settings = { ...DEFAULTS };
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        applySettings(settings);
        syncButtonState();
        if (modalEl) syncModalControls();
    }

    function isDefault(current) {
        return Object.keys(DEFAULTS).every(key => current[key] === DEFAULTS[key]);
    }

    function applySettings(current) {
        const root = document.documentElement;

        root.style.setProperty('--bd-a11y-font-scale', String(current.fontScale / 100));
        root.style.setProperty('--bd-a11y-line-height', String(current.lineHeight));
        root.style.setProperty('--bd-a11y-letter-spacing', `${current.letterSpacing}em`);
        root.style.setProperty('--bd-a11y-word-spacing', `${current.wordSpacing}em`);

        root.dataset.a11yActive = isDefault(current) ? 'false' : 'true';
        root.dataset.a11yFontScaled = current.fontScale !== DEFAULTS.fontScale ? 'true' : 'false';
        root.dataset.a11yContrast = current.contrast;
        root.dataset.a11yReadableFont = String(current.readableFont);
        root.dataset.a11yDyslexia = String(current.dyslexiaFont);
        root.dataset.a11yUnderlineLinks = String(current.underlineLinks);
        root.dataset.a11yHighlightLinks = String(current.highlightLinks);
        root.dataset.a11yHighlightHeadings = String(current.highlightHeadings);
        root.dataset.a11yStrongFocus = String(current.strongFocus);
        root.dataset.a11yLargeCursor = String(current.largeCursor);
        root.dataset.a11yReduceMotion = String(current.reduceMotion);
        root.dataset.a11yPauseAnimations = String(current.pauseAnimations);
        root.dataset.a11yReadingGuide = String(current.readingGuide);
        root.dataset.a11yReadingMask = String(current.readingMask);
        root.dataset.a11yHideMedia = String(current.hideMedia);

        const filters = [];
        if (current.colorFilter !== 'none') filters.push(`url(#bd-a11y-${current.colorFilter})`);
        if (current.saturation !== 100) filters.push(`saturate(${current.saturation}%)`);
        root.dataset.a11yFiltered = filters.length > 0 ? 'true' : 'false';
        root.style.setProperty('--bd-a11y-visual-filter', filters.length > 0 ? filters.join(' ') : 'none');

        ensureFilterDefs();
        ensureReadingUi();
        updateReadingUi(currentPointerY);
    }

    function syncButtonState() {
        const btn = document.getElementById('accessibility-btn');
        if (!btn) return;
        const active = !isDefault(settings);
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
    }

    function ensureFilterDefs() {
        if (document.getElementById('bd-a11y-filter-defs')) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <svg id="bd-a11y-filter-defs" class="bd-a11y-filter-defs" aria-hidden="true" focusable="false">
                <filter id="bd-a11y-protanopia" color-interpolation-filters="sRGB">
                    <feColorMatrix type="matrix" values="0.567 0.433 0 0 0 0.558 0.442 0 0 0 0 0.242 0.758 0 0 0 0 0 1 0" />
                </filter>
                <filter id="bd-a11y-deuteranopia" color-interpolation-filters="sRGB">
                    <feColorMatrix type="matrix" values="0.625 0.375 0 0 0 0.7 0.3 0 0 0 0 0.3 0.7 0 0 0 0 0 1 0" />
                </filter>
                <filter id="bd-a11y-tritanopia" color-interpolation-filters="sRGB">
                    <feColorMatrix type="matrix" values="0.95 0.05 0 0 0 0 0.433 0.567 0 0 0 0.475 0.525 0 0 0 0 0 1 0" />
                </filter>
                <filter id="bd-a11y-achromatopsia" color-interpolation-filters="sRGB">
                    <feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0 0 0 1 0" />
                </filter>
            </svg>
        `;
        document.body.appendChild(wrapper.firstElementChild);
    }

    function ensureReadingUi() {
        if (readingUiReady) return;
        const guide = document.createElement('div');
        const maskTop = document.createElement('div');
        const maskBottom = document.createElement('div');
        guide.className = 'bd-a11y-reading-guide';
        maskTop.className = 'bd-a11y-reading-mask-top';
        maskBottom.className = 'bd-a11y-reading-mask-bottom';
        document.body.append(guide, maskTop, maskBottom);

        document.addEventListener('pointermove', event => {
            currentPointerY = event.clientY;
            updateReadingUi(currentPointerY);
        }, { passive: true });

        window.addEventListener('resize', () => updateReadingUi(currentPointerY), { passive: true });
        readingUiReady = true;
    }

    function updateReadingUi(y) {
        const guide = document.querySelector('.bd-a11y-reading-guide');
        const maskTop = document.querySelector('.bd-a11y-reading-mask-top');
        const maskBottom = document.querySelector('.bd-a11y-reading-mask-bottom');
        if (!guide || !maskTop || !maskBottom) return;

        const focusHeight = 150;
        const top = Math.max(0, y - focusHeight / 2);
        const bottom = Math.min(window.innerHeight, y + focusHeight / 2);

        guide.style.top = `${Math.max(0, y - 2)}px`;
        maskTop.style.top = '0';
        maskTop.style.height = `${top}px`;
        maskBottom.style.top = `${bottom}px`;
        maskBottom.style.height = `${Math.max(0, window.innerHeight - bottom)}px`;
    }

    function optionHtml(value, label, selected) {
        return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
    }

    function rangeField(key, label, min, max, step, suffix) {
        const value = settings[key];
        return `
            <div class="bd-a11y-field">
                <label for="bd-a11y-${key}">${esc(label)}</label>
                <input id="bd-a11y-${key}" type="range" min="${min}" max="${max}" step="${step}" value="${esc(value)}" data-a11y-field="${key}">
                <output data-a11y-output="${key}">${esc(formatValue(key, value, suffix))}</output>
            </div>
        `;
    }

    function selectField(key, label, options) {
        return `
            <div class="bd-a11y-field">
                <label for="bd-a11y-${key}">${esc(label)}</label>
                <select id="bd-a11y-${key}" data-a11y-field="${key}">
                    ${options.map(opt => optionHtml(opt.value, opt.label, settings[key] === opt.value)).join('')}
                </select>
            </div>
        `;
    }

    function toggleButton(key, icon, label, hint) {
        return `
            <button type="button" class="bd-a11y-toggle" data-a11y-toggle="${key}" aria-pressed="${settings[key] ? 'true' : 'false'}">
                <span class="material-icons">${esc(icon)}</span>
                <span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span>
            </button>
        `;
    }

    function profileButton(profile, icon, label, hint) {
        const active = settings.activeProfile === profile;
        return `
            <button type="button" class="bd-a11y-profile" data-a11y-profile="${profile}" aria-pressed="${active ? 'true' : 'false'}">
                <span class="material-icons">${esc(icon)}</span>
                <span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span>
            </button>
        `;
    }

    function formatValue(key, value, suffix) {
        if (key === 'fontScale' || key === 'saturation') return `${Math.round(value)}${suffix}`;
        if (key === 'lineHeight') return Number(value).toFixed(2);
        return `${Number(value).toFixed(3)}${suffix}`;
    }

    function buildModalHtml() {
        return `
            <div class="bd-a11y-modal" role="dialog" aria-modal="true" aria-labelledby="bd-a11y-title">
                <div class="bd-a11y-header">
                    <div class="bd-a11y-title">
                        <span class="material-icons">accessibility_new</span>
                        <div>
                            <h2 id="bd-a11y-title">${esc(tr('title', 'Accessibility'))}</h2>
                            <p>${esc(tr('subtitle', 'Adjust the console to your vision, motion and reading needs.'))}</p>
                        </div>
                    </div>
                    <button type="button" class="bd-a11y-close" aria-label="${esc(tr('close', 'Close'))}">
                        <span class="material-icons">close</span>
                    </button>
                </div>
                <div class="bd-a11y-body">
                    <div class="bd-a11y-controls">
                        <section class="bd-a11y-section">
                            <div class="bd-a11y-section-title"><span class="material-icons">auto_awesome</span>${esc(tr('profiles', 'Quick profiles'))}</div>
                            <div class="bd-a11y-profiles">
                                ${profileButton('lowVision', 'visibility', tr('profile_low_vision', 'Low vision'), tr('profile_low_vision_hint', 'Larger text, strong contrast and focus.'))}
                                ${profileButton('dyslexia', 'menu_book', tr('profile_dyslexia', 'Reading comfort'), tr('profile_dyslexia_hint', 'Readable font and wider spacing.'))}
                                ${profileButton('motionSafe', 'motion_photos_pause', tr('profile_motion_safe', 'Motion safe'), tr('profile_motion_safe_hint', 'Reduces transitions and pauses animation.'))}
                                ${profileButton('colorAssist', 'palette', tr('profile_color_assist', 'Color support'), tr('profile_color_assist_hint', 'Color filter, labels and highlighted links.'))}
                            </div>
                        </section>

                        <section class="bd-a11y-section">
                            <div class="bd-a11y-section-title"><span class="material-icons">text_fields</span>${esc(tr('reading', 'Reading'))}</div>
                            <div class="bd-a11y-grid">
                                ${rangeField('fontScale', tr('font_size', 'Font size'), 90, 160, 5, '%')}
                                ${rangeField('lineHeight', tr('line_height', 'Line height'), 1.2, 2.1, 0.05, '')}
                                ${rangeField('letterSpacing', tr('letter_spacing', 'Letter spacing'), 0, 0.14, 0.005, 'em')}
                                ${rangeField('wordSpacing', tr('word_spacing', 'Word spacing'), 0, 0.22, 0.01, 'em')}
                            </div>
                            <div class="bd-a11y-grid">
                                ${toggleButton('readableFont', 'font_download', tr('readable_font', 'Readable font'), tr('readable_font_hint', 'Uses broad, familiar letter shapes.'))}
                                ${toggleButton('dyslexiaFont', 'format_line_spacing', tr('dyslexia_spacing', 'Dyslexia spacing'), tr('dyslexia_spacing_hint', 'Adds extra spacing for long text.'))}
                            </div>
                        </section>

                        <section class="bd-a11y-section">
                            <div class="bd-a11y-section-title"><span class="material-icons">contrast</span>${esc(tr('visual', 'Visual'))}</div>
                            <div class="bd-a11y-grid">
                                ${selectField('contrast', tr('contrast', 'Contrast'), [
                                    { value: 'normal', label: tr('contrast_normal', 'Normal') },
                                    { value: 'high-dark', label: tr('contrast_high_dark', 'High contrast dark') },
                                    { value: 'high-light', label: tr('contrast_high_light', 'High contrast light') },
                                    { value: 'yellow-black', label: tr('contrast_yellow_black', 'Yellow on black') }
                                ])}
                                ${selectField('colorFilter', tr('color_filter', 'Color vision filter'), [
                                    { value: 'none', label: tr('filter_none', 'None') },
                                    { value: 'protanopia', label: tr('filter_protanopia', 'Protanopia') },
                                    { value: 'deuteranopia', label: tr('filter_deuteranopia', 'Deuteranopia') },
                                    { value: 'tritanopia', label: tr('filter_tritanopia', 'Tritanopia') },
                                    { value: 'achromatopsia', label: tr('filter_achromatopsia', 'Achromatopsia') }
                                ])}
                            </div>
                            ${rangeField('saturation', tr('saturation', 'Color saturation'), 0, 180, 5, '%')}
                            <div class="bd-a11y-grid">
                                ${toggleButton('underlineLinks', 'format_underlined', tr('underline_links', 'Underline links'), tr('underline_links_hint', 'Makes links visible without relying on color.'))}
                                ${toggleButton('highlightLinks', 'ads_click', tr('highlight_links', 'Highlight actions'), tr('highlight_links_hint', 'Outlines links and buttons.'))}
                                ${toggleButton('highlightHeadings', 'title', tr('highlight_headings', 'Highlight headings'), tr('highlight_headings_hint', 'Marks section titles with a color bar.'))}
                                ${toggleButton('hideMedia', 'image_not_supported', tr('hide_media', 'Dim media'), tr('hide_media_hint', 'Dims images, videos and canvases.'))}
                            </div>
                        </section>

                        <section class="bd-a11y-section">
                            <div class="bd-a11y-section-title"><span class="material-icons">touch_app</span>${esc(tr('interaction', 'Interaction'))}</div>
                            <div class="bd-a11y-grid">
                                ${toggleButton('strongFocus', 'center_focus_strong', tr('strong_focus', 'Strong focus'), tr('strong_focus_hint', 'Shows a large keyboard focus ring.'))}
                                ${toggleButton('largeCursor', 'near_me', tr('large_cursor', 'Large cursor'), tr('large_cursor_hint', 'Uses a larger high-contrast pointer.'))}
                                ${toggleButton('reduceMotion', 'speed', tr('reduce_motion', 'Reduce motion'), tr('reduce_motion_hint', 'Shortens transitions and smooth scrolling.'))}
                                ${toggleButton('pauseAnimations', 'pause_circle', tr('pause_animations', 'Pause animations'), tr('pause_animations_hint', 'Stops looping visual motion.'))}
                                ${toggleButton('readingGuide', 'horizontal_rule', tr('reading_guide', 'Reading guide'), tr('reading_guide_hint', 'Follows the pointer with a bright line.'))}
                                ${toggleButton('readingMask', 'visibility_off', tr('reading_mask', 'Reading mask'), tr('reading_mask_hint', 'Dims content above and below the pointer.'))}
                            </div>
                        </section>
                    </div>
                    <aside class="bd-a11y-preview-wrap" aria-live="polite">
                        <div class="bd-a11y-section-title"><span class="material-icons">preview</span>${esc(tr('preview', 'Preview'))}</div>
                        <div class="bd-a11y-preview">
                            <h3>${esc(tr('preview_title', 'Operator workspace preview'))}</h3>
                            <p>${esc(tr('preview_text', 'Check whether text, links, controls and status labels are comfortable to read before closing this menu.'))}</p>
                            <div class="bd-a11y-preview-row">
                                <a href="#" data-a11y-preview-link>${esc(tr('preview_link', 'Device details link'))}</a>
                                <span class="bd-a11y-preview-status"><span class="material-icons icon-sm">check_circle</span>${esc(tr('preview_status', 'Online'))}</span>
                            </div>
                            <div class="bd-a11y-preview-row">
                                <button type="button" class="btn btn-primary">${esc(tr('preview_button', 'Primary action'))}</button>
                                <button type="button" class="btn btn-secondary">${esc(tr('preview_secondary', 'Secondary'))}</button>
                            </div>
                        </div>
                    </aside>
                </div>
                <div class="bd-a11y-footer">
                    <button type="button" class="btn btn-secondary" data-a11y-reset>
                        <span class="material-icons">restart_alt</span>${esc(tr('reset', 'Reset'))}
                    </button>
                    <div class="bd-a11y-footer-actions">
                        <button type="button" class="btn btn-secondary" data-a11y-close>${esc(tr('done', 'Done'))}</button>
                    </div>
                </div>
            </div>
        `;
    }

    function openModal() {
        if (modalEl) return;
        lastFocusedEl = document.activeElement;

        modalEl = document.createElement('div');
        modalEl.className = 'bd-a11y-overlay';
        modalEl.innerHTML = buildModalHtml();
        document.body.appendChild(modalEl);
        document.body.classList.add('bd-a11y-modal-open');

        modalEl.addEventListener('click', event => {
            if (event.target === modalEl || event.target.closest('[data-a11y-close]') || event.target.closest('.bd-a11y-close')) closeModal();
        });

        modalEl.addEventListener('keydown', handleModalKeydown);
        modalEl.addEventListener('input', handleModalInput);
        modalEl.addEventListener('change', handleModalInput);
        modalEl.addEventListener('click', handleModalAction);

        const first = modalEl.querySelector('button, select, input, [tabindex]:not([tabindex="-1"])');
        if (first) first.focus();
    }

    function closeModal() {
        if (!modalEl) return;
        modalEl.remove();
        modalEl = null;
        document.body.classList.remove('bd-a11y-modal-open');
        if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') lastFocusedEl.focus();
    }

    function handleModalKeydown(event) {
        if (event.key === 'Escape') {
            closeModal();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = [...modalEl.querySelectorAll('button, select, input, a[href], [tabindex]:not([tabindex="-1"])')]
            .filter(el => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function handleModalInput(event) {
        const field = event.target.closest('[data-a11y-field]');
        if (!field) return;
        const key = field.dataset.a11yField;
        const value = field.type === 'range' ? Number(field.value) : field.value;
        saveSettings({ ...settings, activeProfile: '', [key]: value });
        updateOutput(key);
    }

    function handleModalAction(event) {
        const toggle = event.target.closest('[data-a11y-toggle]');
        if (toggle) {
            const key = toggle.dataset.a11yToggle;
            saveSettings({ ...settings, activeProfile: '', [key]: !settings[key] });
            syncModalControls();
            return;
        }

        const profile = event.target.closest('[data-a11y-profile]');
        if (profile) {
            applyProfile(profile.dataset.a11yProfile);
            return;
        }

        if (event.target.closest('[data-a11y-reset]')) {
            resetSettings();
            return;
        }

        if (event.target.closest('[data-a11y-preview-link]')) {
            event.preventDefault();
        }
    }

    function updateOutput(key) {
        if (!modalEl) return;
        const output = modalEl.querySelector(`[data-a11y-output="${key}"]`);
        if (!output) return;
        const suffix = key === 'fontScale' || key === 'saturation' ? '%' : key === 'lineHeight' ? '' : 'em';
        output.textContent = formatValue(key, settings[key], suffix);
    }

    function syncModalControls() {
        if (!modalEl) return;
        modalEl.querySelectorAll('[data-a11y-field]').forEach(field => {
            const key = field.dataset.a11yField;
            field.value = settings[key];
            updateOutput(key);
        });
        modalEl.querySelectorAll('[data-a11y-toggle]').forEach(toggle => {
            const key = toggle.dataset.a11yToggle;
            toggle.setAttribute('aria-pressed', String(settings[key]));
        });
        modalEl.querySelectorAll('[data-a11y-profile]').forEach(profile => {
            profile.setAttribute('aria-pressed', String(settings.activeProfile === profile.dataset.a11yProfile));
        });
    }

    function applyProfile(profile) {
        if (settings.activeProfile === profile) {
            resetSettings();
            return;
        }

        const next = { ...settings };
        next.activeProfile = profile;
        if (profile === 'lowVision') {
            Object.assign(next, {
                fontScale: 130,
                lineHeight: 1.75,
                contrast: 'high-dark',
                underlineLinks: true,
                highlightLinks: true,
                strongFocus: true,
                largeCursor: true
            });
        } else if (profile === 'dyslexia') {
            Object.assign(next, {
                fontScale: 112,
                lineHeight: 1.85,
                letterSpacing: 0.045,
                wordSpacing: 0.09,
                readableFont: true,
                dyslexiaFont: true,
                underlineLinks: true
            });
        } else if (profile === 'motionSafe') {
            Object.assign(next, {
                reduceMotion: true,
                pauseAnimations: true,
                readingGuide: true,
                strongFocus: true
            });
        } else if (profile === 'colorAssist') {
            Object.assign(next, {
                colorFilter: 'deuteranopia',
                saturation: 125,
                underlineLinks: true,
                highlightLinks: true,
                highlightHeadings: true
            });
        }
        saveSettings(next);
        syncModalControls();
    }

    function init() {
        applySettings(settings);
        syncButtonState();
        const button = document.getElementById('accessibility-btn');
        if (button) button.addEventListener('click', openModal);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AccessibilityPreferences = {
        open: openModal,
        apply: saveSettings,
        reset: resetSettings,
        get: () => ({ ...settings })
    };
})();