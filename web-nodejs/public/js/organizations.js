/**
 * BetterDesk Console — Organizations List Page JavaScript
 *
 * Handles organization CRUD operations on the /organizations page.
 */
'use strict';

(function () {
    const API_BASE = '/api/panel/org';

    // -----------------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------------
    let organizations = [];
    let editingId = null;

    // -----------------------------------------------------------------------
    //  DOM
    // -----------------------------------------------------------------------
    const orgList = document.getElementById('org-list');
    const orgCount = document.getElementById('org-count');
    const createBtn = document.getElementById('create-org-btn');
    const modal = document.getElementById('org-modal');
    const modalTitle = document.getElementById('org-modal-title');
    const modalClose = document.getElementById('org-modal-close');
    const modalCancel = document.getElementById('org-modal-cancel');
    const modalSave = document.getElementById('org-modal-save');
    const editIdInput = document.getElementById('org-edit-id');
    const nameInput = document.getElementById('org-name');
    const slugInput = document.getElementById('org-slug');
    const logoUrlInput = document.getElementById('org-logo-url');
    const loading = document.getElementById('org-loading');

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------
    async function api(method, path, body) {
        const csrfToken = window.BetterDesk?.csrfToken || '';
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (csrfToken) opts.headers['x-csrf-token'] = csrfToken;
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(API_BASE + path, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Request failed');
        }
        if (res.status === 204) return null;
        return res.json();
    }

    // i18n helper — falls back to key
    function t(key) {
        return (typeof _ === 'function') ? _(`organizations.${key}`) || key : key;
    }

    function showToast(msg, type = 'info') {
        if (typeof Notifications !== 'undefined' && Notifications[type]) Notifications[type](msg);
        else if (window.showToast) window.showToast(msg, type);
        else console.log(`[${type}]`, msg);
    }

    function formatDate(d) {
        if (!d) return '—';
        return new Date(d).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    }

    // -----------------------------------------------------------------------
    //  Render
    // -----------------------------------------------------------------------
    function renderOrganizations() {
        if (loading) loading.style.display = 'none';
        orgCount.textContent = organizations.length;

        if (organizations.length === 0) {
            orgList.innerHTML = `
                <div class="empty-state">
                    <span class="material-icons" style="font-size:48px;opacity:0.3;">business</span>
                    <p>${escHtml(t('no_orgs'))}</p>
                    <p class="text-muted">${escHtml(t('no_orgs_hint'))}</p>
                </div>`;
            return;
        }

        orgList.innerHTML = organizations.map(org => `
            <div class="org-card" data-id="${escHtml(org.id)}">
                <div class="org-card-info">
                    <div class="org-card-icon">
                        <span class="material-icons">business</span>
                    </div>
                    <div class="org-card-text">
                        <a href="/organizations/${encodeURIComponent(org.id)}" class="org-card-name">${escHtml(org.name)}</a>
                        <span class="org-card-slug">${escHtml(org.slug)}</span>
                    </div>
                </div>
                <div class="org-card-meta">
                    <span class="org-card-date">${formatDate(org.created_at)}</span>
                </div>
                <div class="org-card-actions">
                    <button class="btn btn-icon btn-sm org-edit-btn" data-id="${escHtml(org.id)}" title="Edit">
                        <span class="material-icons">edit</span>
                    </button>
                    <button class="btn btn-icon btn-sm btn-danger org-delete-btn" data-id="${escHtml(org.id)}" title="Delete">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            </div>
        `).join('');

        orgList.querySelectorAll('.org-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const org = organizations.find(o => o.id === btn.dataset.id);
                if (org) openModal(org);
            });
        });
        orgList.querySelectorAll('.org-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => removeOrg(btn.dataset.id));
        });
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // -----------------------------------------------------------------------
    //  Load
    // -----------------------------------------------------------------------
    async function loadOrganizations() {
        try {
            const data = await api('GET', '');
            organizations = data.organizations || [];
            renderOrganizations();
        } catch (err) {
            showToast(t('loading_failed') + ': ' + err.message, 'error');
            if (loading) loading.style.display = 'none';
        }
    }

    // -----------------------------------------------------------------------
    //  Modal
    // -----------------------------------------------------------------------
    function openModal(org) {
        editingId = org ? org.id : null;
        editIdInput.value = editingId || '';
        modalTitle.textContent = org ? t('edit') : t('create');
        nameInput.value = org ? org.name : '';
        slugInput.value = org ? org.slug : '';
        logoUrlInput.value = org ? org.logo_url || '' : '';
        modal.style.display = 'flex';
        nameInput.focus();
    }

    function closeModal() {
        modal.style.display = 'none';
        editingId = null;
    }

    // Auto-generate slug from name
    nameInput?.addEventListener('input', () => {
        if (!editingId) {
            slugInput.value = nameInput.value
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 64);
        }
    });

    async function saveOrg() {
        const body = {
            name: nameInput.value.trim(),
            slug: slugInput.value.trim().toLowerCase(),
            logo_url: logoUrlInput.value.trim(),
        };
        if (!body.name || !body.slug) {
            showToast(t('name_slug_required'), 'warning');
            return;
        }

        try {
            if (editingId) {
                await api('PUT', `/${editingId}`, body);
                showToast(t('org_updated'), 'success');
            } else {
                await api('POST', '', body);
                showToast(t('org_created'), 'success');
            }
            closeModal();
            loadOrganizations();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Delete
    // -----------------------------------------------------------------------
    async function removeOrg(id) {
        const confirmed = await Modal.confirm({
            title: _('common.delete') || 'Delete',
            message: t('confirm_delete_org'),
            danger: true,
            confirmIcon: 'delete'
        });
        if (!confirmed) return;
        try {
            await api('DELETE', `/${id}`);
            showToast(t('org_deleted'), 'success');
            loadOrganizations();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------------
    createBtn?.addEventListener('click', () => openModal(null));
    modalClose?.addEventListener('click', closeModal);
    modalCancel?.addEventListener('click', closeModal);
    modalSave?.addEventListener('click', saveOrg);

    modal?.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // -----------------------------------------------------------------------
    //  Init
    // -----------------------------------------------------------------------
    loadOrganizations();

})();
