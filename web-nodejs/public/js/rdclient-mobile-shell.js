/**
 * Shared rdclient mobile helpers — phone gate, visual viewport, mobile toolbar wiring.
 */
(function(global) {
    'use strict';

    function isPhone() {
        return global.DeviceCapabilities && global.DeviceCapabilities.isPhone();
    }

    function isMobileRdClient() {
        return global.DeviceCapabilities && global.DeviceCapabilities.isTouch()
            && !isPhone()
            && document.body.classList.contains('viewer-body');
    }

    function showPhoneGate() {
        var gate = document.getElementById('rd-phone-gate');
        if (!gate) return false;
        gate.hidden = false;
        document.querySelectorAll('.session-tab-bar, .viewer-container, .viewer-toolbar, .rd-mobile-toolbar, #rd-desk-app')
            .forEach(function(el) { if (el) el.style.display = 'none'; });
        return true;
    }

    function hidePhoneGateIfNeeded() {
        if (isPhone()) return showPhoneGate();
        var gate = document.getElementById('rd-phone-gate');
        if (gate) gate.hidden = true;
        return false;
    }

    function showPhoneUnsupportedToast() {
        var msg = typeof global.t === 'function'
            ? global.t('remote.phone_unsupported_title')
            : 'Remote desktop requires a larger screen';
        if (typeof global.Modal !== 'undefined' && global.Modal.alert) {
            global.Modal.alert({
                title: msg,
                message: typeof global.t === 'function' ? global.t('remote.phone_unsupported_body') : ''
            });
        } else {
            alert(msg);
        }
    }

    function initVisualViewport(onResize) {
        if (!global.visualViewport || typeof onResize !== 'function') return;
        var handler = function() { onResize(); };
        global.visualViewport.addEventListener('resize', handler, { passive: true });
        global.visualViewport.addEventListener('scroll', handler, { passive: true });
        global.addEventListener('betterdesk:visual-viewport-change', handler);
        handler();
    }

    function focusKeyboardBridge(inputEl) {
        if (!inputEl) return;
        inputEl.removeAttribute('readonly');
        inputEl.focus({ preventScroll: true });
        inputEl.click();
    }

    global.RdClientMobile = {
        isPhone: isPhone,
        isMobileRdClient: isMobileRdClient,
        showPhoneGate: showPhoneGate,
        hidePhoneGateIfNeeded: hidePhoneGateIfNeeded,
        showPhoneUnsupportedToast: showPhoneUnsupportedToast,
        initVisualViewport: initVisualViewport,
        focusKeyboardBridge: focusKeyboardBridge
    };
})(window);
