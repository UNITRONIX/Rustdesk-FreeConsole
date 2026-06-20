import { Component } from "solid-js";
import { t } from "../lib/i18n";

/// Shown when a non-admin user tries to access a privilege-gated route
/// (e.g. /settings). The tray menu already hides these items when the agent
/// runs unelevated, but this is a defense-in-depth fallback.
const AdminRequired: Component = () => {
  return (
    <div class="admin-required">
      <div class="admin-required-icon">
        <span class="material-symbols-rounded">admin_panel_settings</span>
      </div>
      <h2>{t("admin_required.title")}</h2>
      <p>{t("admin_required.message")}</p>
      <p class="admin-required-hint">{t("admin_required.hint")}</p>
    </div>
  );
};

export default AdminRequired;
