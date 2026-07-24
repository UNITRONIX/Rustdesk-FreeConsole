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
        document.body.classList.add('rd-phone-gated');
        return true;
    }

    function dismissPhoneGate() {
        var gate = document.getElementById('rd-phone-gate');
        if (gate) gate.hidden = true;
        document.body.classList.remove('rd-phone-gated');
    }

    function hidePhoneGateIfNeeded() {
        if (isPhone()) {
            showPhoneGate();
            return true;
        }
        dismissPhoneGate();
        return false;
    }

    function watchPhoneGate(onAllowed) {
        var allowedCalled = false;

        function evaluate() {
            if (isPhone()) {
                showPhoneGate();
                return;
            }
            dismissPhoneGate();
            if (!allowedCalled && typeof onAllowed === 'function') {
                allowedCalled = true;
                onAllowed();
            }
        }

        evaluate();
        global.addEventListener('resize', evaluate, { passive: true });
        if (global.visualViewport) {
            global.visualViewport.addEventListener('resize', evaluate, { passive: true });
        }
        global.addEventListener('betterdesk:posture-change', evaluate);
        global.addEventListener('orientationchange', function() {
            setTimeout(evaluate, 100);
        });
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
        dismissPhoneGate: dismissPhoneGate,
        hidePhoneGateIfNeeded: hidePhoneGateIfNeeded,
        watchPhoneGate: watchPhoneGate,
        showPhoneUnsupportedToast: showPhoneUnsupportedToast,
        initVisualViewport: initVisualViewport,
        focusKeyboardBridge: focusKeyboardBridge
    };
})(window);
