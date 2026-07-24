/**
 * BetterDesk — shared device capability detection (mobile, tablet, fold, touch).
 * Used by mobile shell, rdclient viewer, and desktop-mode fold hooks.
 */
(function(global) {
    'use strict';

    var BP_PHONE = 767;
    var BP_TABLET = 1024;
    var BP_FOLD_INNER = 720;

    var state = {
        isFoldable: false,
        devicePosture: 'unknown',
        isTouch: false,
        width: 0,
        height: 0
    };

    function hasTouch() {
        return 'ontouchstart' in global
            || (global.navigator && global.navigator.maxTouchPoints > 0);
    }

    function getWidth() {
        var iw = global.innerWidth || 0;
        var cw = document.documentElement ? document.documentElement.clientWidth : 0;
        var vv = global.visualViewport ? global.visualViewport.width : 0;
        var w = Math.max(iw, cw);
        if (w <= 0 && vv > 0) return vv;
        if (iw > 0 && iw < 100 && vv > iw) return vv;
        return w || vv || 0;
    }

    function isPhoneDevice() {
        refreshMetrics();
        if (state.width <= 0) return false;
        if (state.width > BP_PHONE) return false;
        if (global.matchMedia && global.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            return false;
        }
        return true;
    }

    function checkFoldableByMediaQuery() {
        if (!global.matchMedia) return false;
        return global.matchMedia('(horizontal-viewport-segments: 2)').matches
            || global.matchMedia('(vertical-viewport-segments: 2)').matches
            || global.matchMedia('(screen-spanning: single-fold-horizontal)').matches
            || global.matchMedia('(screen-spanning: single-fold-vertical)').matches;
    }

    function detectFoldableByAspectRatio() {
        var w = getWidth();
        var h = global.innerHeight || 1;
        var ratio = w / h;
        var nearlySquare = ratio >= 0.8 && ratio <= 1.4;
        var isLargeForPhone = w >= 700 && w <= 1400;
        return hasTouch() && isLargeForPhone && nearlySquare;
    }

    function isUnfolded() {
        if (state.devicePosture === 'continuous') return true;
        if (checkFoldableByMediaQuery()) return true;
        return detectFoldableByAspectRatio() && getWidth() >= BP_FOLD_INNER;
    }

    function refreshMetrics() {
        state.width = getWidth();
        state.height = global.innerHeight || 0;
        state.isTouch = hasTouch();
    }

    function applyBodyClasses() {
        var body = document.body;
        if (!body) return;

        refreshMetrics();
        var w = state.width;

        body.classList.toggle('is-touch', state.isTouch);
        body.classList.toggle('is-phone', w <= BP_PHONE);
        body.classList.toggle('is-tablet', w > BP_PHONE && w <= BP_TABLET);
        body.classList.toggle('is-mobile-shell', w <= BP_TABLET);
        body.classList.toggle('fold-unfolded', state.isFoldable && isUnfolded());
        body.classList.toggle('rdclient-mobile-mode',
            w > BP_PHONE && state.isTouch && body.classList.contains('viewer-body'));
    }

    function initFoldableDetection() {
        if ('devicePosture' in global.navigator) {
            state.isFoldable = true;
            state.devicePosture = global.navigator.devicePosture.type || 'unknown';
            global.navigator.devicePosture.addEventListener('change', function() {
                state.devicePosture = global.navigator.devicePosture.type;
                applyBodyClasses();
                global.dispatchEvent(new CustomEvent('betterdesk:posture-change', {
                    detail: { posture: state.devicePosture }
                }));
            });
        }

        if ('getScreenFold' in global) {
            state.isFoldable = true;
            global.getScreenFold().catch(function() { return null; }).then(function(fold) {
                if (fold && fold.addEventListener) {
                    fold.addEventListener('change', function() {
                        applyBodyClasses();
                    });
                }
            });
        }

        if (global.matchMedia) {
            var foldQuery = global.matchMedia('(screen-spanning: single-fold-vertical)');
            if (foldQuery.matches || foldQuery.media !== 'not all') {
                state.isFoldable = state.isFoldable || checkFoldableByMediaQuery();
            }
            foldQuery.addEventListener('change', function(e) {
                if (e.matches) state.isFoldable = true;
                applyBodyClasses();
            });
        }

        if (!state.isFoldable) {
            state.isFoldable = detectFoldableByAspectRatio();
        }
    }

    function init() {
        initFoldableDetection();
        applyBodyClasses();

        global.addEventListener('resize', function() {
            applyBodyClasses();
        }, { passive: true });

        if (global.visualViewport) {
            global.visualViewport.addEventListener('resize', function() {
                applyBodyClasses();
                global.dispatchEvent(new CustomEvent('betterdesk:visual-viewport-change'));
            }, { passive: true });
        }

        global.addEventListener('orientationchange', function() {
            setTimeout(applyBodyClasses, 100);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    var api = {
        BP_PHONE: BP_PHONE,
        BP_TABLET: BP_TABLET,
        BP_FOLD_INNER: BP_FOLD_INNER,
        isPhone: isPhoneDevice,
        isTablet: function() { refreshMetrics(); return state.width > BP_PHONE && state.width <= BP_TABLET; },
        isMobileShell: function() { refreshMetrics(); return state.width <= BP_TABLET; },
        isTouch: function() { return state.isTouch || hasTouch(); },
        isFoldable: function() { return state.isFoldable; },
        isUnfolded: isUnfolded,
        getDevicePosture: function() { return state.devicePosture; },
        getVisualViewportHeight: function() {
            return global.visualViewport ? global.visualViewport.height : global.innerHeight;
        },
        refresh: applyBodyClasses
    };

    global.DeviceCapabilities = api;
})(window);
