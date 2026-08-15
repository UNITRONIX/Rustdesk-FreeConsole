/* global window */
(function () {
  const go = () => window.go && window.go.main && window.go.main.AppService;
  let snap = null;
  let showPw = true;

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function applyI18n(strings) {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (strings && strings[k]) el.textContent = strings[k];
    });
  }

  function setLogo(dataUrl) {
    const top = $('logo-top');
    const topFb = $('logo-top-fallback');
    const hero = $('logo-hero');
    const art = $('hero-art');
    if (dataUrl) {
      top.src = dataUrl;
      top.hidden = false;
      topFb.hidden = true;
      hero.src = dataUrl;
      hero.hidden = false;
      art.hidden = true;
    } else {
      top.hidden = true;
      topFb.hidden = false;
      hero.hidden = true;
      art.hidden = false;
    }
  }

  function fillCredentials() {
    if (!snap) return;
    const id = snap.device_id_fmt || snap.device_id || '—';
    const pw = showPw ? (snap.password || '—') : (snap.password_masked || '—');
    $('device-id').textContent = id;
    $('password').textContent = pw;
    $('share-device-id').textContent = id;
    $('share-password').textContent = pw;
    const show = !!snap.show_password;
    $('password-card').hidden = !show;
    $('share-password-card').hidden = !show;
  }

  function setSessionView(active) {
    $('view-idle').hidden = !!active;
    $('view-session').hidden = !active;
    if (active) {
      const label = (snap.strings && snap.strings.ongoing_session) || 'Ongoing session';
      const withLabel = (snap.strings && snap.strings.session_with) || 'Session with';
      const op = snap.session_operator || '';
      $('session-detail').textContent = op
        ? (withLabel + ' ' + op)
        : ((snap.strings && snap.strings.session_active) || label);
    }
  }

  function applySnapshot(s) {
    snap = s;
    if (!s) return;
    document.documentElement.style.setProperty('--primary', s.primary_color || '#2563eb');
    document.documentElement.style.setProperty('--accent', s.accent_color || '#e0f2fe');
    document.documentElement.style.setProperty('--surface', s.surface_color || '#f3f4f6');
    document.documentElement.style.setProperty('--bg', s.background_color || '#ffffff');
    document.documentElement.style.setProperty('--text', s.text_color || '#1f2937');
    document.documentElement.style.setProperty('--muted', s.text_muted_color || '#6b7280');
    document.documentElement.style.setProperty('--header-text', s.header_text_color || '#1f2937');
    document.documentElement.style.setProperty('--ready', s.status_ready_color || '#22c55e');

    $('product').textContent = s.product_name || 'BetterDesk Support';
    $('tagline').textContent = s.tagline || '';
    document.title = (s.product_name || 'BetterDesk') + ' — ' + ((s.strings && s.strings.window_title) || 'Support');

    $('status-text').textContent = s.status_text || '';
    const dot = $('status-dot');
    dot.className = 'dot ' + (s.status_kind || 'ready');

    const contact = [s.support_email, s.support_phone, s.contact_url].filter(Boolean);
    const contactEl = $('contact');
    if (contact.length) {
      contactEl.hidden = false;
      contactEl.textContent = contact.join(' • ');
      contactEl.title = contactEl.textContent;
    } else {
      contactEl.hidden = true;
      contactEl.textContent = '';
    }

    setLogo(s.logo_data_url || '');
    fillCredentials();
    applyI18n(s.strings || {});
    setSessionView(!!s.session_active);
  }

  function closeModal() { $('modal').hidden = true; }

  function openModal(title, bodyEl, actions, opts) {
    opts = opts || {};
    $('modal-title').textContent = title;
    const body = $('modal-body');
    body.innerHTML = '';
    body.appendChild(bodyEl);
    const act = $('modal-actions');
    act.innerHTML = '';
    (actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.primary ? 'primary' : (a.danger ? 'danger' : 'secondary'));
      b.textContent = a.label;
      if (a.disabled) b.disabled = true;
      if (a.id) b.id = a.id;
      b.onclick = () => { a.onClick(b); };
      act.appendChild(b);
    });
    $('modal').hidden = false;
    if (opts.focusId) {
      const el = document.getElementById(opts.focusId);
      if (el) el.focus();
    }
  }

  function openShareModal() {
    fillCredentials();
    applyI18n((snap && snap.strings) || {});
    $('share-modal').hidden = false;
  }

  function closeShareModal() { $('share-modal').hidden = true; }

  async function copyCredentials() {
    if (!snap) return;
    const id = snap.device_id || '';
    const pw = snap.password || '';
    const text = snap.show_password ? (id + '\n' + pw) : id;
    await navigator.clipboard.writeText(text);
    toast((snap.strings && snap.strings.copied) || 'Copied');
  }

  async function regenPassword() {
    try {
      await go().RegeneratePassword();
      await refresh();
      toast((snap.strings && snap.strings.password_regenerated) || 'New password generated');
    } catch (e) {
      toast(String(e));
    }
  }

  async function refresh() {
    const api = go();
    if (!api) return;
    applySnapshot(await api.GetSnapshot());
  }

  function openConsent(payload) {
    const strings = (snap && snap.strings) || {};
    const wrap = document.createElement('div');
    const grid = document.createElement('div');
    grid.className = 'consent-grid';

    function row(label, value) {
      const r = document.createElement('div');
      r.className = 'consent-row';
      const l = document.createElement('div');
      l.className = 'consent-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'consent-value';
      v.textContent = value;
      r.appendChild(l);
      r.appendChild(v);
      grid.appendChild(r);
    }

    row(strings.consent_display_name || 'Display name', (payload && payload.operator) || '—');
    row(strings.consent_session || 'Session', (payload && payload.session_id) || '—');
    wrap.appendChild(grid);

    const prompt = document.createElement('p');
    prompt.className = 'section-hint';
    prompt.style.textAlign = 'left';
    prompt.textContent = (payload && payload.prompt) || strings.consent_prompt || 'Allow remote access?';
    wrap.appendChild(prompt);

    const checkLabel = document.createElement('label');
    checkLabel.className = 'consent-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = 'consent-ack';
    const checkText = document.createElement('span');
    checkText.textContent = strings.consent_ack || 'I have read the expert information.';
    checkLabel.appendChild(check);
    checkLabel.appendChild(checkText);
    wrap.appendChild(checkLabel);

    openModal(strings.consent_title || 'Remote access request', wrap, [
      {
        label: strings.consent_deny || 'Reject',
        onClick: () => { go().AnswerConsent(false); closeModal(); }
      },
      {
        id: 'consent-continue',
        label: strings.consent_accept || 'Approve',
        primary: true,
        disabled: true,
        onClick: () => { go().AnswerConsent(true); closeModal(); }
      }
    ]);

    check.addEventListener('change', () => {
      const btn = document.getElementById('consent-continue');
      if (btn) btn.disabled = !check.checked;
    });
  }

  function bind() {
    $('modal-close').onclick = closeModal;
    $('share-close').onclick = closeShareModal;
    $('copy-creds').onclick = copyCredentials;
    $('share-copy').onclick = copyCredentials;
    $('btn-regen').onclick = regenPassword;
    $('share-regen').onclick = regenPassword;
    $('btn-disconnect').onclick = () => go().DisconnectSession();
    $('btn-share-id').onclick = openShareModal;

    $('btn-help').onclick = () => {
      const ta = document.createElement('textarea');
      ta.rows = 4;
      ta.placeholder = (snap.strings && snap.strings.help_message) || '';
      openModal((snap.strings && snap.strings.request_help) || 'Help', ta, [
        { label: (snap.strings && snap.strings.cancel) || 'Cancel', onClick: closeModal },
        {
          label: (snap.strings && snap.strings.send) || 'Send', primary: true,
          onClick: async () => {
            try {
              await go().SendHelp(ta.value || '');
              closeModal();
              toast((snap.strings && snap.strings.help_sent) || 'Sent');
            } catch (e) {
              toast((snap.strings && snap.strings.help_failed) || String(e));
            }
          }
        }
      ]);
    };

    $('btn-chat').onclick = async () => {
      const wrap = document.createElement('div');
      const log = document.createElement('div');
      log.className = 'chat-log';
      const hist = await go().GetChatHistory();
      log.textContent = (hist || []).join('\n');
      const input = document.createElement('input');
      input.placeholder = (snap.strings && snap.strings.chat_placeholder) || '…';
      wrap.appendChild(log);
      wrap.appendChild(input);
      openModal((snap.strings && snap.strings.chat_with_support) || 'Chat', wrap, [
        { label: (snap.strings && snap.strings.close) || 'Close', onClick: closeModal },
        {
          label: (snap.strings && snap.strings.send) || 'Send', primary: true,
          onClick: async () => {
            await go().SendChat(input.value || '');
            input.value = '';
            const h = await go().GetChatHistory();
            log.textContent = (h || []).join('\n');
          }
        }
      ]);
    };

    $('btn-settings').onclick = () => {
      const wrap = document.createElement('div');
      wrap.style.display = 'grid';
      wrap.style.gap = '10px';
      const mode = document.createElement('select');
      (snap.mode_options || []).forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === (snap.strings && snap.strings['mode_' + snap.access_mode]) ||
            (snap.access_mode === 'supervised' && opt.indexOf('uperv') >= 0) ||
            (snap.access_mode === 'unattended' && opt.indexOf('nattend') >= 0) ||
            (snap.access_mode === 'disabled' && opt.indexOf('isabl') >= 0)) {
          o.selected = true;
        }
        mode.appendChild(o);
      });
      const custom = document.createElement('input');
      custom.type = 'password';
      custom.placeholder = (snap.strings && snap.strings.set_custom) || 'Custom password';
      wrap.appendChild(mode);
      wrap.appendChild(custom);
      openModal((snap.strings && snap.strings.settings) || 'Settings', wrap, [
        {
          label: (snap.strings && snap.strings.test_connection) || 'Test',
          onClick: async () => {
            const r = await go().TestConnection();
            alert([r.title, r.gateway, r.api, r.enrollment].join('\n'));
          }
        },
        {
          label: (snap.strings && snap.strings.regenerate) || 'Regenerate',
          onClick: async () => { await go().RegeneratePassword(); await refresh(); }
        },
        {
          label: (snap.strings && snap.strings.quit) || 'Quit',
          danger: true,
          onClick: () => go().Quit()
        },
        { label: (snap.strings && snap.strings.cancel) || 'Cancel', onClick: closeModal },
        {
          label: (snap.strings && snap.strings.save) || 'Save', primary: true,
          onClick: async () => {
            await go().SetAccessMode(mode.value);
            if (custom.value) await go().SetCustomPassword(custom.value);
            closeModal();
            await refresh();
          }
        }
      ]);
    };
  }

  function bindEvents() {
    if (!window.runtime || !window.runtime.EventsOn) {
      setTimeout(bindEvents, 50);
      return;
    }
    window.runtime.EventsOn('snapshot', applySnapshot);
    window.runtime.EventsOn('toast', toast);
    window.runtime.EventsOn('chat', () => { /* chat modal refreshes on send */ });
    window.runtime.EventsOn('open-help', () => { $('btn-help').click(); });
    window.runtime.EventsOn('consent', (payload) => { openConsent(payload || {}); });
    window.runtime.EventsOn('session', () => refresh());
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    bindEvents();
    for (let i = 0; i < 40 && !go(); i++) await new Promise((r) => setTimeout(r, 50));
    await refresh();
  });
})();
