# Desktop Dashboard

The Desktop Widget Dashboard transforms the web console into an OS-style desktop environment with draggable, resizable widgets.

---

## Activation

### Enable Desktop Mode

1. Open the web console
2. Click the **Desktop Mode** button (or append `?desktop=1` to the URL)
3. The dashboard switches to a full-screen desktop with widgets

### Disable Desktop Mode

- Click the sidebar **Exit** button
- Or remove the `betterdesk_desktop_mode` cookie

---

## Widget Catalog

### System Widgets

| Widget | Description |
|--------|-------------|
| **Server Info** | Hostname, uptime, Go/Node versions, server address, public key |
| **Device Status** | Online/offline/total counts with live WebSocket updates |
| **CPU Monitor** | Real-time CPU usage gauge with cores breakdown |

### Monitoring Widgets

| Widget | Description |
|--------|-------------|
| **Process Monitor** | Top 15 processes by CPU/memory, color-coded thresholds |
| **Disk Usage** | Segmented bar per partition, color-coded utilization |
| **Log Viewer** | Stream recent log lines, severity color coding, source selector |
| **Alert Feed** | Live security alerts from audit log with action colors |
| **Database Stats** | Table row counts, DB file size, last backup detection |
| **Docker Containers** | Container list with status icons, images, ports, uptime |

### Utility Widgets

| Widget | Description |
|--------|-------------|
| **Weather** | Temperature, humidity, wind from wttr.in API, configurable city |
| **Calendar** | Full month view, event creation, localStorage persistence |
| **World Clock** | Multiple time zones, second-precise display |
| **Bookmarks** | Grid of URL shortcuts with hover effects |
| **Speed Test** | Download speed measurement with SVG gauge, latency display |
| **User Sessions** | Logged-in operators/admins with role badges |

### Advanced Widgets

| Widget | Description |
|--------|-------------|
| **Shell Command** | Execute whitelisted commands (admin only), configurable refresh |
| **Device Map** | World map with geo-positioned device pins, online/offline colors |

---

## Widget Management

### Adding Widgets

1. Click **Add Widget** in the sidebar
2. Select a widget type from the catalog
3. The widget appears on the canvas at a default position

### Moving Widgets

- **Drag** the widget header to reposition
- Widgets snap to a 20px grid
- Edge-snap to other widgets and canvas borders (15px threshold)
- Visual grid overlay available (toggle in sidebar)

### Resizing Widgets

- **Drag** the bottom-right corner handle
- Minimum size enforced per widget type
- Adjacent widgets do not overlap (collision avoidance)

### Removing Widgets

- Click the kebab menu (⋮) on the widget header
- Select **Remove**
- Or use **Reset Layout** in the sidebar

---

## Snap Layouts

Windows 11-style snap layouts for organized widget positioning.

### Snap Layout Picker

1. Click **Snap Layouts** in the sidebar
2. Choose from 6 predefined layouts:
   - **2-Column** (50/50)
   - **2-Column** (60/40)
   - **3-Column** (33/33/33)
   - **2×2 Grid** (4 equal zones)
   - **1 + 2** (1 large left, 2 stacked right)
   - **1 + 3** (1 large left, 3 stacked right)
3. Widgets distribute across zones round-robin

### Edge Snap

Drag a widget to screen edges for automatic positioning:

| Edge | Result |
|------|--------|
| Left | Left half |
| Right | Right half |
| Top | Maximize |
| Corners | Quarter snap |

### Aero Shake

Rapidly shake a window (3+ direction changes in 500ms) to minimize all other widgets. Shake again to restore.

### Draggable Zone Borders

After applying a snap layout, drag the divider between zones to resize them. Adjacent zones adjust proportionally. Minimum zone size: 15%.

### Auto-Arrange

Click **Auto-Arrange** in the snap layout picker to automatically tile all widgets in a √n grid layout.

---

## Widget Groups

Combine multiple widgets into a tabbed container:

1. Select multiple widgets (Ctrl+click or selection box)
2. Right-click → **Group**
3. Widgets merge into a single container with tab bar
4. Click tabs to switch between widgets

### Ungroup

Right-click a group → **Ungroup** to restore individual widgets.

---

## Themes

### Dark Theme (Default)
- Dark backgrounds (`#0d1117`)
- Glassmorphism widget cards (`backdrop-filter: blur(28px)`)
- Blue accent colors

### Light Theme
- White backgrounds with subtle shadows
- Light glassmorphism
- Dark text, blue accents

### Auto Theme
- Follows system `prefers-color-scheme`
- Updates automatically when OS theme changes

### Cycling Themes

Click the theme button in the sidebar, or use:
```javascript
DesktopMode.cycleTheme(); // dark → light → auto → dark
```

---

## Presets

### Built-in Presets

| Preset | Widgets Included |
|--------|-----------------|
| **Monitoring** | Server Info, CPU Monitor, Process Monitor, Disk Usage, Log Viewer |
| **Helpdesk** | Device Status, Alert Feed, User Sessions, Chat |
| **Minimal** | Server Info, Device Status |
| **Developer** | Log Viewer, Docker Containers, Shell Command, Database Stats |

### Custom Presets

1. Arrange widgets as desired
2. Click **Save Preset** in the sidebar
3. Enter a preset name
4. The preset saves widget positions, sizes, and types to localStorage

### Loading a Preset

1. Click **Presets** in the sidebar
2. Select a preset
3. Current layout is replaced with the preset layout

---

## Wallpaper

1. Click **Wallpaper** in the sidebar
2. Choose from:
   - Built-in gradients
   - Solid colors (prefix with `solid:`)
   - Custom image URL
3. Wallpaper persists in localStorage

---

## Persistence

Widget layout (positions, sizes, types) persists to:
- **localStorage** for client-side persistence
- Restored on page load
- Separate per user (based on session)

Widget groups and presets also persist to localStorage.

---

## Responsive Behavior

On window resize, `autoReposition()` automatically:
- Clamps widgets within canvas bounds
- Shrinks oversized widgets
- Debounced at 300ms to prevent jitter

---

## See also

- [[Web Console|Web-Console]] — dashboard overview
- [[User Management|User-Management]] — desktop login and 2FA
