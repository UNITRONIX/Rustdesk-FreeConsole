/**
 * BetterDesk Console - Visual Tutorial System
 * Spotlight-based guided tour with i18n support.
 * 
 * Usage:
 *   Tutorial.start('console');        // Console panel tutorial
 *   Tutorial.start('desktop');        // Desktop mode tutorial
 *   Tutorial.start('devices');        // Devices page tutorial
 *   Tutorial.start('settings');       // Settings page tutorial
 *   Tutorial.skip();                  // Close tutorial
 *   Tutorial.autoStart('console');    // Auto-start on first visit
 */

(function() {
    'use strict';

    // ============ Constants ============

    var STORAGE_SEEN = 'betterdesk_tutorial_seen';
    var STORAGE_DISABLED = 'betterdesk_tutorial_disabled';
    
    // ============ State ============

    var _overlay = null;
    var _spotlight = null;
    var _tooltip = null;
    var _steps = [];
    var _currentStep = 0;
    var _isActive = false;
    var _onComplete = null;
    var _tutorialType = 'console';
    var _resizeHandler = null;

    // ============ i18n Helper ============

    function t(key, fallback) {
        if (typeof window._ === 'function') {
            var result = window._(key);
            return result !== key ? result : fallback;
        }
        if (window.BetterDesk && window.BetterDesk.translations) {
            var keys = key.split('.');
            var val = window.BetterDesk.translations;
            for (var i = 0; i < keys.length; i++) {
                if (val && typeof val === 'object' && keys[i] in val) {
                    val = val[keys[i]];
                } else {
                    return fallback;
                }
            }
            return val || fallback;
        }
        return fallback;
    }

    // ============ Tutorial Definitions ============

    function getConsoleTutorialSteps() {
        return [
            {
                selector: '.sidebar-rail',
                title: t('tutorial.console_sidebar_title', 'Navigation Sidebar'),
                text: t('tutorial.console_sidebar_text', 'Access all modules from here. Click any icon to navigate to that section. The sidebar adapts to your screen size.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.sidebar-rail-bottom .sidebar-rail-btn[title]',
                title: t('tutorial.console_expand_title', 'Expand Sidebar'),
                text: t('tutorial.console_expand_text', 'Click here to expand the sidebar and see full labels for all navigation items. Click again to collapse.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.navbar .search-box',
                title: t('tutorial.console_search_title', 'Quick Search'),
                text: t('tutorial.console_search_text', 'Search for devices, settings, or actions quickly. Press Ctrl+K for keyboard shortcut.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.content-wrapper',
                title: t('tutorial.console_dashboard_title', 'Dashboard'),
                text: t('tutorial.console_dashboard_text', 'Your central hub showing server status, online devices, and quick actions. Keep an eye on important metrics at a glance.'),
                position: 'center',
                highlight: false
            },
            {
                selector: null,
                title: t('tutorial.console_complete_title', 'You\'re Ready!'),
                text: t('tutorial.console_complete_text', 'Explore the sidebar categories to discover all features. Click the Help icon anytime to restart this guide.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getDesktopTutorialSteps() {
        return [
            {
                selector: '.desktop-topbar',
                title: t('tutorial.desktop_topbar_title', 'Top Bar'),
                text: t('tutorial.desktop_topbar_text', 'The top bar shows the clock, quick controls, and access to the app drawer. Click the grid icon to browse all apps.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.app-drawer-overlay .app-drawer',
                title: t('tutorial.desktop_drawer_title', 'App Drawer'),
                text: t('tutorial.desktop_drawer_text', 'Open the app drawer to search and launch any console function as a floating window. Apps are organized by category.'),
                position: 'bottom',
                highlight: true,
                beforeShow: function() {
                    var btn = document.querySelector('.topbar-app-drawer-btn');
                    if (btn) btn.click();
                },
                afterHide: function() {
                    var overlay = document.querySelector('.app-drawer-overlay');
                    if (overlay && overlay.classList.contains('open')) {
                        overlay.classList.remove('open');
                    }
                }
            },
            {
                selector: '.widget-canvas',
                title: t('tutorial.desktop_widgets_title', 'Widget Dashboard'),
                text: t('tutorial.desktop_widgets_text', 'Your customizable workspace. Widgets display live information and provide quick access to features. Drag to rearrange.'),
                position: 'center',
                highlight: false
            },
            {
                selector: '.desktop-taskbar',
                title: t('tutorial.desktop_taskbar_title', 'Taskbar'),
                text: t('tutorial.desktop_taskbar_text', 'Open apps appear here. Click to focus or minimize windows. The clock shows current time and wallpaper button changes the background.'),
                position: 'top',
                highlight: true
            },
            {
                selector: null,
                title: t('tutorial.desktop_snap_title', 'Snap Layouts'),
                text: t('tutorial.desktop_snap_text', 'Drag windows to screen edges to snap them into position, or hover the maximize button for layout presets. Try Aero Shake!'),
                position: 'center',
                highlight: false
            },
            {
                selector: null,
                title: t('tutorial.desktop_complete_title', 'Desktop Mode Ready!'),
                text: t('tutorial.desktop_complete_text', 'Try opening apps from the drawer and arranging windows side-by-side. Use widget presets for quick dashboard layouts.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getDevicesTutorialSteps() {
        return [
            {
                selector: '.folder-chips',
                title: t('tutorial.devices_folders_title', 'Device Folders'),
                text: t('tutorial.devices_folders_text', 'Organize devices into folders. Click a folder to filter the list. Right-click to rename or delete.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.search-devices',
                title: t('tutorial.devices_search_title', 'Search & Filter'),
                text: t('tutorial.devices_search_text', 'Search by ID, hostname, or platform. Use the status pills to show only online, offline, or all devices.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.devices-table',
                title: t('tutorial.devices_table_title', 'Device List'),
                text: t('tutorial.devices_table_text', 'Click any device row for details. Use the kebab menu on the right for quick actions like connect, edit tags, or delete.'),
                position: 'center',
                highlight: false
            },
            {
                selector: null,
                title: t('tutorial.devices_complete_title', 'Device Management Ready!'),
                text: t('tutorial.devices_complete_text', 'Drag devices between folders to organize them. Double-click a device to open its detail panel.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getSettingsTutorialSteps() {
        return [
            {
                selector: '.settings-tabs, .settings-nav',
                title: t('tutorial.settings_tabs_title', 'Settings Categories'),
                text: t('tutorial.settings_tabs_text', 'Navigate between General, Security, Appearance, and other configuration sections.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.settings-content, .settings-panel',
                title: t('tutorial.settings_content_title', 'Configuration'),
                text: t('tutorial.settings_content_text', 'Each section contains specific server and console settings. Changes are saved when you click Save.'),
                position: 'center',
                highlight: false
            },
            {
                selector: null,
                title: t('tutorial.settings_complete_title', 'Settings Overview'),
                text: t('tutorial.settings_complete_text', 'Check Security settings for 2FA, API keys and user management. Visit Appearance to customize the console look.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getStepsForType(type) {
        switch (type) {
            case 'desktop': return getDesktopTutorialSteps();
            case 'devices': return getDevicesTutorialSteps();
            case 'settings': return getSettingsTutorialSteps();
            case 'remote': return getRemoteTutorialSteps();
            case 'organization': return getOrganizationTutorialSteps();
            case 'cdap': return getCDAPTutorialSteps();
            case 'chat': return getChatTutorialSteps();
            default: return getConsoleTutorialSteps();
        }
    }

    function getRemoteTutorialSteps() {
        return [
            {
                selector: '.remote-toolbar, .toolbar',
                title: t('tutorial.remote_toolbar_title', 'Remote Toolbar'),
                text: t('tutorial.remote_toolbar_text', 'Access display controls, clipboard sync, special keys, and quality settings from the toolbar. Toggle fullscreen with F11.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '#remote-canvas, .remote-canvas',
                title: t('tutorial.remote_canvas_title', 'Remote Display'),
                text: t('tutorial.remote_canvas_text', 'This is the remote screen. Click inside to start controlling the remote device. Mouse and keyboard input are forwarded automatically.'),
                position: 'center',
                highlight: false
            },
            {
                selector: '.clipboard-btn, .toolbar-clipboard',
                title: t('tutorial.remote_clipboard_title', 'Clipboard Sync'),
                text: t('tutorial.remote_clipboard_text', 'Copy and paste text between your computer and the remote device. Use Ctrl+C / Ctrl+V as normal while focused on the remote display.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: null,
                title: t('tutorial.remote_complete_title', 'Remote Session Ready!'),
                text: t('tutorial.remote_complete_text', 'Use the toolbar buttons for special keys (Ctrl+Alt+Del, PrintScreen) and monitor switching. Press Escape or click Disconnect to end the session.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getOrganizationTutorialSteps() {
        return [
            {
                selector: '.org-header, .organizations-page h1',
                title: t('tutorial.org_overview_title', 'Organizations'),
                text: t('tutorial.org_overview_text', 'Organizations let you group users, devices, and policies. Each organization has its own admin, operators, and settings.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.org-create-btn, .btn-create-org',
                title: t('tutorial.org_create_title', 'Create Organization'),
                text: t('tutorial.org_create_text', 'Click here to create a new organization. Provide a name, slug, and optional description. You will be the owner of the new organization.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.org-members, .org-users-tab',
                title: t('tutorial.org_members_title', 'Manage Members'),
                text: t('tutorial.org_members_text', 'Invite users by email, assign roles (admin, operator, user), and manage access. Members can see devices assigned to their organization.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.org-devices, .org-devices-tab',
                title: t('tutorial.org_devices_title', 'Assign Devices'),
                text: t('tutorial.org_devices_text', 'Add devices to the organization. Devices assigned here will inherit the organization\'s policies and be visible to its members.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.org-policies, .org-settings-tab',
                title: t('tutorial.org_policies_title', 'Organization Policies'),
                text: t('tutorial.org_policies_text', 'Set security policies like password requirements, session timeouts, 2FA enforcement, and device enrollment rules for the organization.'),
                position: 'right',
                highlight: true
            },
            {
                selector: null,
                title: t('tutorial.org_complete_title', 'Organization Setup Complete!'),
                text: t('tutorial.org_complete_text', 'Invite your team and assign devices to start using organization-scoped management. Policies apply automatically to all members.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getCDAPTutorialSteps() {
        return [
            {
                selector: '.cdap-device-list, .cdap-devices',
                title: t('tutorial.cdap_devices_title', 'CDAP Devices'),
                text: t('tutorial.cdap_devices_text', 'View all connected CDAP devices — IoT sensors, PLCs, bridges, and custom agents. Green indicators show live connections.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.cdap-widget-grid, .cdap-widgets',
                title: t('tutorial.cdap_widgets_title', 'Widget Dashboard'),
                text: t('tutorial.cdap_widgets_text', 'Widgets display real-time data from devices. Gauges, toggles, LEDs, charts — each widget type visualizes a different kind of data.'),
                position: 'center',
                highlight: false
            },
            {
                selector: '.cdap-command-panel, .cdap-commands',
                title: t('tutorial.cdap_commands_title', 'Send Commands'),
                text: t('tutorial.cdap_commands_text', 'Interact with devices by sending commands. Some commands need confirmation. The command log keeps a history of all sent commands.'),
                position: 'left',
                highlight: true
            },
            {
                selector: '.cdap-terminal-btn, .cdap-terminal',
                title: t('tutorial.cdap_terminal_title', 'Device Terminal'),
                text: t('tutorial.cdap_terminal_text', 'Open a terminal session to CDAP agents for advanced diagnostics or manual configuration. Type commands directly.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: null,
                title: t('tutorial.cdap_complete_title', 'CDAP Overview Complete!'),
                text: t('tutorial.cdap_complete_text', 'Explore device widgets, send commands, and use the terminal or file browser for deeper management. CDAP agents report metrics automatically.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getChatTutorialSteps() {
        return [
            {
                selector: '.chat-contacts, .chat-sidebar',
                title: t('tutorial.chat_contacts_title', 'Contacts & Groups'),
                text: t('tutorial.chat_contacts_text', 'See your contacts and chat groups. Click any contact to open a conversation. Green dots indicate online users.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.chat-messages, .chat-area',
                title: t('tutorial.chat_send_title', 'Send Messages'),
                text: t('tutorial.chat_send_text', 'Type your message and press Enter to send. Messages are end-to-end encrypted when both parties support E2E.'),
                position: 'center',
                highlight: false
            },
            {
                selector: '.chat-file-btn, .chat-attach',
                title: t('tutorial.chat_file_title', 'Share Files'),
                text: t('tutorial.chat_file_text', 'Click the attachment icon to share files. Files are encrypted and can be up to 50 MB.'),
                position: 'top',
                highlight: true
            },
            {
                selector: null,
                title: t('tutorial.chat_complete_title', 'Chat Ready!'),
                text: t('tutorial.chat_complete_text', 'Chat with operators and end users in real time. Create groups for team communication. All messages support read receipts.'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    // ============ DOM Creation ============

    function createOverlay() {
        if (_overlay) return;
        
        _overlay = document.createElement('div');
        _overlay.className = 'tutorial-overlay';
        _overlay.id = 'tutorial-overlay';
        
        _spotlight = document.createElement('div');
        _spotlight.className = 'tutorial-spotlight';
        _overlay.appendChild(_spotlight);
        
        _tooltip = document.createElement('div');
        _tooltip.className = 'tutorial-tooltip';
        _tooltip.innerHTML = 
            '<div class="tutorial-tooltip-header">' +
                '<span class="tutorial-title"></span>' +
                '<button class="tutorial-close" title="' + t('tutorial.close', 'Close') + '">' +
                    '<span class="material-icons">close</span>' +
                '</button>' +
            '</div>' +
            '<div class="tutorial-tooltip-body"></div>' +
            '<div class="tutorial-tooltip-footer">' +
                '<span class="tutorial-progress"></span>' +
                '<div class="tutorial-actions">' +
                    '<button class="tutorial-btn tutorial-skip">' + t('tutorial.skip', 'Skip') + '</button>' +
                    '<button class="tutorial-btn tutorial-prev">' + t('tutorial.prev', 'Previous') + '</button>' +
                    '<button class="tutorial-btn tutorial-btn-primary tutorial-next">' + t('tutorial.next', 'Next') + '</button>' +
                '</div>' +
            '</div>';
        _overlay.appendChild(_tooltip);
        
        document.body.appendChild(_overlay);
        
        _tooltip.querySelector('.tutorial-close').addEventListener('click', skip);
        _tooltip.querySelector('.tutorial-skip').addEventListener('click', skip);
        _tooltip.querySelector('.tutorial-prev').addEventListener('click', prevStep);
        _tooltip.querySelector('.tutorial-next').addEventListener('click', nextStep);
        
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) skip();
        });
        
        document.addEventListener('keydown', handleKeyDown);
        
        _resizeHandler = function() {
            if (_isActive && _steps[_currentStep]) {
                positionElements(_steps[_currentStep]);
            }
        };
        window.addEventListener('resize', _resizeHandler);
    }

    function removeOverlay() {
        document.removeEventListener('keydown', handleKeyDown);
        if (_resizeHandler) {
            window.removeEventListener('resize', _resizeHandler);
            _resizeHandler = null;
        }
        if (_overlay) {
            _overlay.remove();
            _overlay = null;
            _spotlight = null;
            _tooltip = null;
        }
    }

    // ============ Step Navigation ============

    function showStep(index) {
        if (!_steps.length || index < 0 || index >= _steps.length) return;
        
        // Run afterHide for current step
        var prevStepObj = _steps[_currentStep];
        if (prevStepObj && prevStepObj.afterHide && index !== _currentStep) {
            prevStepObj.afterHide();
        }
        
        _currentStep = index;
        var step = _steps[index];
        
        // Run beforeShow for new step
        if (step.beforeShow) {
            step.beforeShow();
            // Small delay to let DOM update
            setTimeout(function() { renderStep(step, index); }, 200);
        } else {
            renderStep(step, index);
        }
    }
    
    function renderStep(step, index) {
        // Transition animation
        _tooltip.classList.add('step-transition');
        setTimeout(function() { _tooltip.classList.remove('step-transition'); }, 250);
        
        _tooltip.querySelector('.tutorial-title').textContent = step.title || '';
        _tooltip.querySelector('.tutorial-tooltip-body').textContent = step.text || '';
        _tooltip.querySelector('.tutorial-progress').innerHTML = 
            '<div class="tutorial-progress-dots">' +
            _steps.map(function(_, i) {
                var cls = i === index ? 'active' : (i < index ? 'seen' : '');
                return '<span class="tutorial-progress-dot ' + cls + '"></span>';
            }).join('') +
            '</div>';
        
        var prevBtn = _tooltip.querySelector('.tutorial-prev');
        var nextBtn = _tooltip.querySelector('.tutorial-next');
        var skipBtn = _tooltip.querySelector('.tutorial-skip');
        
        prevBtn.style.display = index > 0 ? '' : 'none';
        nextBtn.textContent = step.final ? t('tutorial.finish', 'Finish') : t('tutorial.next', 'Next');
        skipBtn.style.display = step.final ? 'none' : '';
        
        positionElements(step);
    }

    function positionElements(step) {
        var target = step.selector ? document.querySelector(step.selector) : null;
        
        if (target && step.highlight) {
            var rect = target.getBoundingClientRect();
            var padding = 8;
            
            _spotlight.style.display = 'block';
            _spotlight.style.left = (rect.left - padding) + 'px';
            _spotlight.style.top = (rect.top - padding) + 'px';
            _spotlight.style.width = (rect.width + padding * 2) + 'px';
            _spotlight.style.height = (rect.height + padding * 2) + 'px';
            
            positionTooltip(rect, step.position);
        } else {
            _spotlight.style.display = 'none';
            _tooltip.style.left = '50%';
            _tooltip.style.top = '50%';
            _tooltip.style.transform = 'translate(-50%, -50%)';
        }
    }

    function positionTooltip(targetRect, position) {
        var tooltipRect = _tooltip.getBoundingClientRect();
        var gap = 16;
        var left, top;
        
        switch (position) {
            case 'top':
                left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
                top = targetRect.top - tooltipRect.height - gap;
                break;
            case 'bottom':
                left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
                top = targetRect.bottom + gap;
                break;
            case 'left':
                left = targetRect.left - tooltipRect.width - gap;
                top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
                break;
            case 'right':
                left = targetRect.right + gap;
                top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
                break;
            default:
                left = window.innerWidth / 2 - tooltipRect.width / 2;
                top = window.innerHeight / 2 - tooltipRect.height / 2;
        }
        
        left = Math.max(16, Math.min(left, window.innerWidth - tooltipRect.width - 16));
        top = Math.max(16, Math.min(top, window.innerHeight - tooltipRect.height - 16));
        
        _tooltip.style.left = left + 'px';
        _tooltip.style.top = top + 'px';
        _tooltip.style.transform = 'none';
    }

    function nextStep() {
        if (_currentStep < _steps.length - 1) {
            showStep(_currentStep + 1);
        } else {
            complete();
        }
    }

    function prevStep() {
        if (_currentStep > 0) {
            showStep(_currentStep - 1);
        }
    }

    function handleKeyDown(e) {
        if (!_isActive) return;
        
        if (e.key === 'Escape') {
            skip();
        } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
            nextStep();
        } else if (e.key === 'ArrowLeft') {
            prevStep();
        }
    }

    // ============ Lifecycle ============

    function start(type, callback) {
        if (_isActive) return;
        
        _tutorialType = type || 'console';
        _steps = getStepsForType(_tutorialType);
        
        // Filter steps whose target elements don't exist (skip gracefully)
        _steps = _steps.filter(function(step) {
            if (!step.selector) return true;
            return document.querySelector(step.selector) !== null;
        });
        
        if (!_steps.length) return;
        
        _isActive = true;
        _currentStep = 0;
        _onComplete = callback;
        
        createOverlay();
        
        requestAnimationFrame(function() {
            _overlay.classList.add('active');
            showStep(0);
        });
    }

    function skip() {
        if (!_isActive) return;

        // Permanently mark this tutorial as dismissed so autoStart won't
        // show it again until the user explicitly resets via the Help menu.
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        seen[_tutorialType] = true;
        localStorage.setItem(STORAGE_SEEN, JSON.stringify(seen));

        // Run afterHide for current step
        var step = _steps[_currentStep];
        if (step && step.afterHide) step.afterHide();
        
        _isActive = false;
        _overlay.classList.remove('active');
        
        setTimeout(function() {
            removeOverlay();
            _steps = [];
            _currentStep = 0;
        }, 300);
    }

    function complete() {
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        seen[_tutorialType] = true;
        localStorage.setItem(STORAGE_SEEN, JSON.stringify(seen));
        
        // Run afterHide for current step
        var step = _steps[_currentStep];
        if (step && step.afterHide) step.afterHide();
        
        _isActive = false;
        _overlay.classList.remove('active');
        
        setTimeout(function() {
            removeOverlay();
            if (typeof _onComplete === 'function') _onComplete();
            _steps = [];
            _currentStep = 0;
            _onComplete = null;
        }, 300);
    }

    function hasSeenTutorial(type) {
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        return seen[type || 'console'] === true;
    }

    function resetTutorial(type) {
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        if (type) {
            delete seen[type];
        } else {
            seen = {};
        }
        localStorage.setItem(STORAGE_SEEN, JSON.stringify(seen));
    }

    function setDisabled(disabled) {
        localStorage.setItem(STORAGE_DISABLED, disabled ? 'true' : 'false');
    }

    function isDisabled() {
        return localStorage.getItem(STORAGE_DISABLED) === 'true';
    }

    function autoStart(type) {
        if (isDisabled()) return;
        if (hasSeenTutorial(type)) return;
        
        setTimeout(function() {
            start(type);
        }, 1500);
    }

    // ============ Export ============

    function toggleHelpMenu() {
        if (!_helpMenu) showHelpButton();
        if (_helpMenuOpen) closeHelpMenu(); else openHelpMenu();
    }

    window.Tutorial = {
        start: start,
        skip: skip,
        hasSeenTutorial: hasSeenTutorial,
        resetTutorial: resetTutorial,
        setDisabled: setDisabled,
        isDisabled: isDisabled,
        autoStart: autoStart,
        showHelpButton: showHelpButton,
        hideHelpButton: hideHelpButton,
        toggleHelpMenu: toggleHelpMenu
    };

    // Backward compatibility alias
    window.BetterDeskTutorial = window.Tutorial;

    // ============ Floating Help Button ============

    var _helpBtn = null;
    var _helpMenu = null;
    var _helpMenuOpen = false;

    function showHelpButton() {
        if (_helpBtn) { _helpBtn.classList.add('visible'); return; }

        _helpBtn = document.createElement('button');
        _helpBtn.className = 'tutorial-help-btn';
        _helpBtn.title = t('tutorial.help', 'Help & Tutorials');
        _helpBtn.innerHTML = '<span class="material-icons">help_outline</span>';
        document.body.appendChild(_helpBtn);

        _helpMenu = document.createElement('div');
        _helpMenu.className = 'tutorial-help-menu';

        var tutorials = [
            { type: 'console',      icon: 'dashboard',       label: t('tutorial.tour_console', 'Console Tour') },
            { type: 'desktop',      icon: 'desktop_windows',  label: t('tutorial.tour_desktop', 'Desktop Mode Tour') },
            { type: 'devices',      icon: 'devices',          label: t('tutorial.tour_devices', 'Devices Tour') },
            { type: 'remote',       icon: 'connected_tv',     label: t('tutorial.tour_remote', 'Remote Session Tour') },
            { type: 'organization', icon: 'corporate_fare',   label: t('tutorial.tour_organization', 'Organization Setup') },
            { type: 'cdap',         icon: 'sensors',          label: t('tutorial.tour_cdap', 'CDAP Overview') },
            { type: 'chat',         icon: 'chat',             label: t('tutorial.tour_chat', 'Chat Basics') },
            { type: 'settings',     icon: 'settings',         label: t('tutorial.tour_settings', 'Settings Tour') }
        ];

        tutorials.forEach(function(tut) {
            var btn = document.createElement('button');
            btn.className = 'tutorial-help-menu-item';
            btn.innerHTML = '<span class="material-icons">' + tut.icon + '</span>' + esc(tut.label);
            btn.addEventListener('click', function() {
                closeHelpMenu();
                start(tut.type);
            });
            _helpMenu.appendChild(btn);
        });

        // Divider + reset option
        var div = document.createElement('div');
        div.className = 'tutorial-help-menu-divider';
        _helpMenu.appendChild(div);

        var resetBtn = document.createElement('button');
        resetBtn.className = 'tutorial-help-menu-item';
        resetBtn.innerHTML = '<span class="material-icons">refresh</span>' + esc(t('tutorial.reset_all', 'Reset All Tutorials'));
        resetBtn.addEventListener('click', function() {
            closeHelpMenu();
            resetTutorial();
        });
        _helpMenu.appendChild(resetBtn);

        // Disable/Enable toggle
        var toggleDiv = document.createElement('div');
        toggleDiv.className = 'tutorial-help-menu-divider';
        _helpMenu.appendChild(toggleDiv);

        var disableBtn = document.createElement('button');
        disableBtn.className = 'tutorial-help-menu-item tutorial-toggle-btn';
        _updateToggleBtn(disableBtn);
        disableBtn.addEventListener('click', function() {
            var nowDisabled = !isDisabled();
            setDisabled(nowDisabled);
            _updateToggleBtn(disableBtn);
            closeHelpMenu();
            if (nowDisabled) {
                hideHelpButton();
            }
            // Notify settings page if open
            window.dispatchEvent(new CustomEvent('tutorial:stateChanged', { detail: { disabled: nowDisabled } }));
        });
        _helpMenu.appendChild(disableBtn);

        document.body.appendChild(_helpMenu);

        _helpBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            _helpMenuOpen ? closeHelpMenu() : openHelpMenu();
        });

        document.addEventListener('click', function() {
            if (_helpMenuOpen) closeHelpMenu();
        });

        requestAnimationFrame(function() {
            _helpBtn.classList.add('visible');
        });
    }

    function hideHelpButton() {
        if (_helpBtn) _helpBtn.classList.remove('visible');
        closeHelpMenu();
    }

    function openHelpMenu() {
        if (!_helpMenu) return;
        _helpMenuOpen = true;
        _helpMenu.classList.add('open');
    }

    function closeHelpMenu() {
        if (!_helpMenu) return;
        _helpMenuOpen = false;
        _helpMenu.classList.remove('open');
    }

    function esc(s) {
        var el = document.createElement('span');
        el.textContent = s || '';
        return el.innerHTML;
    }

    function _updateToggleBtn(btn) {
        if (!btn) return;
        if (isDisabled()) {
            btn.innerHTML = '<span class="material-icons">visibility</span>' + esc(t('tutorial.enable_tutorials', 'Enable Tutorials'));
        } else {
            btn.innerHTML = '<span class="material-icons">visibility_off</span>' + esc(t('tutorial.disable_tutorials', 'Disable Tutorials'));
        }
    }

    // Listen for settings page toggle
    window.addEventListener('tutorial:stateChanged', function(e) {
        if (e.detail && typeof e.detail.disabled === 'boolean') {
            setDisabled(e.detail.disabled);
            if (e.detail.disabled) {
                hideHelpButton();
            } else {
                showHelpButton();
            }
            // Update toggle button text if menu exists
            if (_helpMenu) {
                var tb = _helpMenu.querySelector('.tutorial-toggle-btn');
                _updateToggleBtn(tb);
            }
        }
    });

    // Auto-show help button after DOM ready (only if not disabled)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            if (!isDisabled()) showHelpButton();
        });
    } else {
        if (!isDisabled()) showHelpButton();
    }

})();
