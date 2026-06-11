/**
 * BetterDesk Console - Utility Functions
 */

const Utils = {
    /**
     * Format date to locale string
     */
    formatDate(dateStr, options = {}) {
        if (!dateStr) return '-';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '-';
        
        const defaultOptions = {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        };
        
        return date.toLocaleDateString(window.BetterDesk.lang, { ...defaultOptions, ...options });
    },
    
    /**
     * Format relative time (e.g., "5 minutes ago")
     */
    formatRelativeTime(dateStr) {
        if (!dateStr) return '-';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '-';
        
        const now = new Date();
        const diff = now - date;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (seconds < 60) return _('time.just_now');
        if (minutes < 60) return _('time.minutes_ago', { count: minutes });
        if (hours < 24) return _('time.hours_ago', { count: hours });
        if (days < 7) return _('time.days_ago', { count: days });
        
        return Utils.formatDate(dateStr);
    },
    
    /**
     * Debounce function
     */
    debounce(fn, delay = 300) {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), delay);
        };
    },
    
    /**
     * Throttle function
     */
    throttle(fn, limit = 300) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },
    
    /**
     * Copy text to clipboard
     */
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                return true;
            } finally {
                document.body.removeChild(textarea);
            }
        }
    },
    
    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    /**
     * Sanitize color value to prevent XSS
     * Only allows valid hex colors (#RGB, #RRGGBB) and named colors
     */
    sanitizeColor(color) {
        if (!color || typeof color !== 'string') return '#808080';
        // Allow hex colors
        if (/^#[0-9A-Fa-f]{3}$/.test(color) || /^#[0-9A-Fa-f]{6}$/.test(color)) {
            return color;
        }
        // Allow safe named colors
        const safeColors = ['red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 
                           'cyan', 'magenta', 'brown', 'gray', 'grey', 'black', 'white',
                           'lime', 'teal', 'navy', 'maroon', 'olive', 'aqua', 'silver'];
        if (safeColors.includes(color.toLowerCase())) {
            return color;
        }
        return '#808080'; // Default gray
    },
    
    /**
     * Parse URL query parameters
     */
    getQueryParams() {
        return Object.fromEntries(new URLSearchParams(window.location.search));
    },
    
    /**
     * Update URL query parameter without reload
     */
    setQueryParam(key, value) {
        const url = new URL(window.location);
        if (value === null || value === undefined) {
            url.searchParams.delete(key);
        } else {
            url.searchParams.set(key, value);
        }
        window.history.replaceState({}, '', url);
    },
    
    /**
     * Generate a simple unique ID (using crypto.randomUUID when available)
     */
    generateId() {
        if (window.crypto && window.crypto.randomUUID) {
            return 'id-' + crypto.randomUUID().split('-')[0];
        }
        // Fallback for older browsers
        return 'id-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    },
    
    /**
     * Check if element is in viewport
     */
    isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth
        );
    },
    
    /**
     * Sleep/delay function
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
    
    /**
     * Restrict client-side fetch targets to same-origin relative API paths.
     */
    resolveApiEndpoint(endpoint) {
        if (typeof endpoint !== 'string') {
            throw new Error('Invalid API endpoint');
        }
        const trimmed = endpoint.trim();
        if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
            throw new Error('Invalid API endpoint');
        }
        const parsed = new URL(trimmed, window.location.origin);
        if (parsed.origin !== window.location.origin) {
            throw new Error('Invalid API endpoint');
        }
        return parsed.pathname + parsed.search;
    },

    /**
     * API request helper with error handling
     */
    async api(endpoint, options = {}) {
        const safeEndpoint = Utils.resolveApiEndpoint(endpoint);
        const defaults = {
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin'
        };
        
        // Add CSRF token if available
        if (window.BetterDesk.csrfToken) {
            defaults.headers['X-CSRF-Token'] = window.BetterDesk.csrfToken;
        }
        
        const config = {
            ...defaults,
            ...options,
            headers: { ...defaults.headers, ...options.headers }
        };
        
        // Don't send body for GET/HEAD requests
        if (['GET', 'HEAD'].includes(config.method?.toUpperCase())) {
            delete config.body;
        } else if (config.body && typeof config.body === 'object') {
            config.body = JSON.stringify(config.body);
        }
        
        try {
            const response = await fetch(safeEndpoint, config);
            const contentType = response.headers.get('content-type');
            
            let data;
            if (contentType && contentType.includes('application/json')) {
                data = await response.json();
            } else {
                data = await response.text();
            }
            
            if (!response.ok) {
                const error = new Error(data.error || data.message || 'Request failed');
                error.status = response.status;
                error.data = data;
                throw error;
            }
            
            // Automatically extract data field from standard API responses
            // API format: { success: true, data: { ... } }
            if (data && typeof data === 'object' && data.success === true && data.data !== undefined) {
                return data.data;
            }
            
            return data;
        } catch (error) {
            if (error.status === 401) {
                // Redirect to login on auth error
                window.location.href = '/login';
            }
            throw error;
        }
    },
    
    /**
     * Get platform icon name based on platform string
     */
    getPlatformIcon(platform) {
        if (!platform) return 'devices';
        const p = platform.toLowerCase();
        if (p.includes('windows')) return 'desktop_windows';
        if (p.includes('mac') || p.includes('darwin')) return 'desktop_mac';
        if (p.includes('linux')) return 'computer';
        if (p.includes('android')) return 'smartphone';
        if (p.includes('ios') || p.includes('iphone')) return 'phone_iphone';
        return 'devices';
    }
};

// Export for modules or attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
} else {
    window.Utils = Utils;
}
