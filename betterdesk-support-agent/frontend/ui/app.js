/* global window */
(function () {
  const go = () => window.go && window.go.main && window.go.main.AppService;
  let snap = null;
  let showPw = false;

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

  function applySnapshot(s) {
    snap = s;
    if (!s) return;
    document.documentElement.style.setProperty('--primary', s.primary_color || '#2563eb');
    document.documentElement.style.setProperty('--surface', s.surface_color || '#1e293b');
    document.documentElement.style.setProperty('--bg', s.background_color || '#0f172a');
    document.documentElement.style.setProperty('--text', s.text_color || '#f8fafc');
    document.documentElement.style.setProperty('--muted', s.text_muted_color || '#94a3b8');
    $('product').textContent = s.product_name || 'BetterDesk Support';
    $('tagline').textContent = s.tagline || '';
    document.title = (s.product_name || 'BetterDesk') + ' — ' + ((s.strings && s.strings.window_title) || 'Support');
    $('device-id').textContent = s.device_id_fmt || s.device_id || '—';
    $('password').textContent = showPw ? (s.password || '—') : (s.password_masked || '—');
    $('password-card').hidden = !s.show_password;
    $('status-text').textContent = s.status_text || '';
    const dot = $('status-dot');
    dot.className = 'dot ' + (s.status_kind || 'ready');
    const contact = [s.support_email, s.support_phone, s.contact_url].filter(Boolean);
    $('contact').textContent = contact.length ? contact.join(' • ') : (s.version || '');
    $('contact').title = $('contact').textContent;
    if (s.logo_data_url) {
      $('logo').src = s.logo_data_url;
      $('logo').hidden = false;
      $('logo-fallback').hidden = true;
    } else {
      $('logo').hidden = true;
      $('logo-fallback').hidden = false;
    }
    applyI18n(s.strings || {});
    $('session-bar').hidden = !s.session_active;
    if (s.session_active) {
      const label = (s.strings && s.strings.session_active) || 'Session';
      $('session-text').textContent = label + ': ' + (s.session_operator || '');
    }
  }

  function closeModal() { $('modal').hidden = true; }

  function openModal(title, bodyEl, actions) {
    $('modal-title').textContent = title;
    const body = $('modal-body');
    body.innerHTML = '';
    body.appendChild(bodyEl);
    const act = $('modal-actions');
    act.innerHTML = '';
    (actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.primary ? 'primary' : 'secondary');
      b.textContent = a.label;
      b.onclick = () => { a.onClick(); };
      act.appendChild(b);
    });
    $('modal').hidden = false;
  }

  async function refresh() {
    const api = go();
    if (!api) return;
    applySnapshot(await api.GetSnapshot());
  }

  function bind() {
    $('copy-id').onclick = async () => {
      if (!snap) return;
      await navigator.clipboard.writeText(snap.device_id || '');
      toast((snap.strings && snap.strings.copied) || 'Copied');
    };
    $('copy-pw').onclick = async () => {
      if (!snap) return;
      await navigator.clipboard.writeText(snap.password || '');
      toast((snap.strings && snap.strings.copied) || 'Copied');
    };
    $('btn-quit').onclick = () => go().Quit();
    $('btn-disconnect').onclick = () => go().DisconnectSession();

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
      input.placeholder = '…';
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
    window.runtime.EventsOn('chat', (hist) => { /* open chat refreshes */ });
    window.runtime.EventsOn('open-help', () => { $('btn-help').click(); });
    window.runtime.EventsOn('consent', (payload) => {
      const p = document.createElement('p');
      p.textContent = (payload && payload.prompt) || 'Allow remote access?';
      openModal((snap && snap.strings && snap.strings.consent_title) || 'Consent', p, [
        { label: (snap && snap.strings && snap.strings.consent_deny) || 'Deny', onClick: () => { go().AnswerConsent(false); closeModal(); } },
        { label: (snap && snap.strings && snap.strings.consent_accept) || 'Accept', primary: true, onClick: () => { go().AnswerConsent(true); closeModal(); } }
      ]);
    });
    window.runtime.EventsOn('session', () => refresh());
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    bindEvents();
    // Wait for Wails bindings
    for (let i = 0; i < 40 && !go(); i++) await new Promise((r) => setTimeout(r, 50));
    await refresh();
  });
})();
