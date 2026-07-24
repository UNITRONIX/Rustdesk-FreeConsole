import { Component, createSignal } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { t } from "../lib/i18n";

const Sidebar: Component = () => {
  const location = useLocation();
  const [collapsed, setCollapsed] = createSignal(false);

  const isActive = (path: string) => location.pathname === path;

  const navItems = [
    { path: "/", icon: "wifi", label: () => t("sidebar.status") },
    { path: "/chat", icon: "chat", label: () => t("sidebar.chat") },
    { path: "/help", icon: "support_agent", label: () => t("sidebar.help") },
    { path: "/settings", icon: "settings", label: () => t("sidebar.settings") },
  ];

  return (
    <nav class={`sidebar ${collapsed() ? "collapsed" : ""}`}>
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span class="material-symbols-rounded">devices</span>
          {!collapsed() && <span class="sidebar-title">BetterDesk Agent</span>}
        </div>
        <button
          class="sidebar-toggle"
          onClick={() => setCollapsed(!collapsed())}
          title={collapsed() ? "Expand" : "Collapse"}
        >
          <span class="material-symbols-rounded">
            {collapsed() ? "chevron_right" : "chevron_left"}
          </span>
        </button>
      </div>

      <div class="sidebar-nav">
        {navItems.map((item) => (
          <A
            href={item.path}
            class={`sidebar-item ${isActive(item.path) ? "active" : ""}`}
            title={collapsed() ? item.label() : undefined}
          >
            <span class="material-symbols-rounded">{item.icon}</span>
            {!collapsed() && <span class="sidebar-label">{item.label()}</span>}
          </A>
        ))}
      </div>

      <div class="sidebar-footer">
        {!collapsed() && <span class="sidebar-version">Agent v1.0.0</span>}
      </div>
    </nav>
  );
};

export default Sidebar;
