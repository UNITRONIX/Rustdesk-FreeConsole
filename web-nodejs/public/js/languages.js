(function () {
    'use strict';

    const _ = window._ || (k => k);

    let languages = [];
    let refKeyCount = 0;

    async function init() {
        await loadLanguages();
    }

    async function loadLanguages() {
        try {
            const resp = await fetch('/api/panel/languages');
            const data = await resp.json();
            languages = data.languages || [];
            refKeyCount = data.refKeyCount || 0;
            render();
        } catch (err) {
            console.error('Failed to load languages:', err);
        }
    }

    function render() {
        renderStats();
        renderGrid();
    }

    function renderStats() {
        const container = document.getElementById('lang-stats');
        if (!container) return;

        const total = languages.length;
        const complete = languages.filter(l => l.coverage === 100 && !l.needs_review).length;
        const reviewCount = languages.filter(l => l.needs_review).length;

        container.innerHTML = `
            <div class="lang-stat-card stat-ref">
                <div class="stat-value">${total}</div>
                <div class="stat-label">${_('languages.total_languages')}</div>
            </div>
            <div class="lang-stat-card stat-complete">
                <div class="stat-value">${complete}</div>
                <div class="stat-label">${_('languages.fully_translated')}</div>
            </div>
            <div class="lang-stat-card stat-review">
                <div class="stat-value">${reviewCount}</div>
                <div class="stat-label">${_('languages.needs_review')}</div>
            </div>
            <div class="lang-stat-card">
                <div class="stat-value">${refKeyCount}</div>
                <div class="stat-label">${_('languages.reference_keys')}</div>
            </div>
        `;
    }

    function renderGrid() {
        const container = document.getElementById('lang-grid');
        if (!container) return;

        if (languages.length === 0) {
            container.innerHTML = `<p style="color: var(--text-secondary); text-align: center; grid-column: 1/-1;">${_('languages.no_languages')}</p>`;
            return;
        }

        container.innerHTML = languages.map(lang => {
            const covClass = lang.coverage === 100 ? 'cov-100'
                : lang.coverage >= 90 ? 'cov-high'
                : lang.coverage >= 50 ? 'cov-medium'
                : 'cov-low';

            const badges = [];
            if (lang.is_reference) badges.push(`<span class="lang-badge badge-reference">${_('languages.badge_reference')}</span>`);
            if (lang.needs_review) badges.push(`<span class="lang-badge badge-review">${_('languages.badge_review')}</span>`);
            if (lang.rtl) badges.push(`<span class="lang-badge badge-rtl">RTL</span>`);
            if (lang.coverage === 100 && !lang.needs_review && !lang.is_reference) badges.push(`<span class="lang-badge badge-complete">${_('languages.badge_complete')}</span>`);

            const keyStats = [];
            if (lang.missing_keys > 0) keyStats.push(`<span class="missing">${lang.missing_keys} ${_('languages.missing')}</span>`);
            if (lang.extra_keys > 0) keyStats.push(`<span class="extra">${lang.extra_keys} ${_('languages.extra')}</span>`);

            return `
                <div class="lang-card ${lang.is_reference ? 'is-reference' : ''}" data-code="${lang.code}">
                    <div class="lang-card-header">
                        <span class="lang-flag">${lang.flag || '🏳️'}</span>
                        <div class="lang-info">
                            <div class="lang-name">${escHtml(lang.name)}</div>
                            <div class="lang-native">${escHtml(lang.native)}</div>
                        </div>
                        <span class="lang-code-badge">${lang.code}</span>
                    </div>
                    ${badges.length ? `<div class="lang-badges">${badges.join('')}</div>` : ''}
                    <div class="lang-coverage">
                        <div class="lang-coverage-bar">
                            <div class="lang-coverage-fill ${covClass}" style="width: ${lang.coverage}%"></div>
                        </div>
                        <div class="lang-coverage-text">
                            <span>${lang.coverage}% ${_('languages.coverage')}</span>
                            <span>${lang.total_keys} ${_('languages.keys')}</span>
                        </div>
                    </div>
                    ${keyStats.length ? `<div class="lang-key-stats">${keyStats.join('')}</div>` : ''}
                    ${!lang.is_reference ? `
                        <div class="lang-actions">
                            ${lang.missing_keys > 0 ? `<button onclick="Languages.viewMissing('${lang.code}')" title="${_('languages.view_missing')}">
                                <span class="material-icons-round">search</span> ${_('languages.view_missing')}
                            </button>` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    async function viewMissing(code) {
        try {
            const resp = await fetch(`/api/panel/languages/${encodeURIComponent(code)}/missing`);
            const data = await resp.json();

            const overlay = document.getElementById('lang-detail-overlay');
            const panel = document.getElementById('lang-detail-content');
            if (!overlay || !panel) return;

            const lang = languages.find(l => l.code === code);
            const title = lang ? `${lang.flag || ''} ${lang.name} (${code})` : code;

            let html = `<h3>${_('languages.missing_keys_for')} ${escHtml(title)}</h3>`;

            if (data.missing && data.missing.length > 0) {
                html += `<p style="font-size:12px;color:var(--text-secondary)">${data.missing.length} ${_('languages.missing_keys_count')}</p>`;
                html += '<ul class="lang-key-list">';
                for (const item of data.missing.slice(0, 100)) {
                    html += `<li>
                        <div class="lang-key-name">${escHtml(item.key)}</div>
                        <div class="lang-key-value">EN: ${escHtml(item.en_value || '')}</div>
                        <div class="lang-key-value">PL: ${escHtml(item.pl_value || '')}</div>
                    </li>`;
                }
                if (data.missing.length > 100) {
                    html += `<li style="color:var(--text-secondary);text-align:center;padding:12px;">... ${_('languages.and_more').replace('{n}', data.missing.length - 100)}</li>`;
                }
                html += '</ul>';
            } else {
                html += `<p style="color:#3fb950;text-align:center;padding:20px;">${_('languages.all_keys_present')}</p>`;
            }

            panel.innerHTML = html;
            overlay.classList.add('active');
        } catch (err) {
            console.error('Failed to load missing keys:', err);
        }
    }

    function closeDetail() {
        const overlay = document.getElementById('lang-detail-overlay');
        if (overlay) overlay.classList.remove('active');
    }

    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Public API
    window.Languages = { init, viewMissing, closeDetail };

    // Self-initialize (inline <script> blocked by CSP nonce policy)
    document.addEventListener('DOMContentLoaded', init);
})();
