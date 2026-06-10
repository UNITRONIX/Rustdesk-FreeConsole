/**
 * West-European translation patches — de, fr, es
 *
 * These objects are PATCH objects: each key matches the corresponding
 * key in en.json. They cover only the sections / keys that were missing
 * from the target locales as of the June 2026 i18n audit.
 *
 * Rules applied:
 *  - BetterDesk, RustDesk, LDAP, OIDC, WebSocket, CDAP kept as-is.
 *  - Tier names BRONZE / IRON / TITANIUM / PLATINUM / OBSIDIAN kept as-is.
 *  - Placeholders {count}, {{ready}}, {{building}}, {{pending}}, {{failed}},
 *    {{provider}} preserved verbatim.
 *  - File-path keys (advanced_file_*) keep the English label unchanged
 *    because they reference fixed system paths/service names.
 */

// ---------------------------------------------------------------------------
// German (de)
// ---------------------------------------------------------------------------
const de = {
  common: {
    yes: "Ja",
    no: "Nein"
  },

  nav: {
    main: "Haupt",
    server_attestation: "Server-Attestierung"
  },

  devices: {
    restore_failed: "Gerät konnte nicht wiederhergestellt werden"
  },

  device_detail: {
    os: "Betriebssystem"
  },

  inventory: {
    os: "Betriebssystem"
  },

  remote: {
    use_cdap_fallback: "CDAP-Viewer verwenden",
    cdap_fallback_hint:
      "Öffnet den einfachen JPEG-Polling-Viewer, der bd-signal/CDAP statt des RustDesk-Relays verwendet. Nützlich, wenn der Peer auf dem Relay offline, aber über den Agent-Verwaltungskanal erreichbar ist."
  },

  backup: {
    opt_database: "Datenbank (alle Tabellen)",
    opt_database_hint:
      "Importiert alle Konsolendaten erneut. Wird sofort angewendet, kein Neustart erforderlich.",
    opt_env: "Umgebungsdatei (.env)",
    opt_env_warning:
      "Überschreibt SESSION_SECRET, API-Schlüssel, Datenbank-DSN, Ports und TLS-Einstellungen. Erfordert einen Dienstneustart.",
    opt_godb: "Go-Server-Datenbank",
    opt_godb_warning:
      "Überschreibt die SQLite-Datenbank des Go-Servers (nur SQLite-Backend). Erfordert einen Dienstneustart.",
    opt_secrets: "Serverschlüssel & Geheimnisse",
    opt_secrets_warning:
      "Überschreibt die Ed25519-Serveridentität, den API-Schlüssel und das Sitzungsgeheimnis. Erfordert einen Dienstneustart.",
    opt_uploads: "Branding-Dateien",
    opt_uploads_hint: "Logos und hochgeladene Bilder.",
    restart_required:
      "Einige wiederhergestellte Komponenten (Schlüssel / .env / Go-Datenbank) erfordern einen Dienstneustart, damit die Änderungen wirksam werden.",
    restore_warning:
      "Das Wiederherstellen von Geheimnissen, der Umgebungsdatei oder der Go-Server-Datenbank überschreibt die Serveridentität und erfordert danach einen Dienstneustart.",
    security_warning:
      "Dieses Backup enthält Geheimnisse (Serverschlüssel, Umgebungsdatei, Passwort-Hashes und 2FA-Geheimnisse). Sicher aufbewahren und niemals teilen.",
    stat_database: "Datenbank-Engine",
    stat_env: "Umgebungsdatei",
    stat_keys: "Serverschlüssel enthalten",
    stat_uploads: "Branding-Dateien"
  },

  branding: {
    agent_desc:
      "Das öffentliche Agent-Downloadportal für Endbenutzer anpassen.",
    agent_show_powered: "\"Powered by BetterDesk\" anzeigen",
    agent_show_powered_hint:
      "Die BetterDesk-Zuschreibung in der Fußzeile des Downloadportals anzeigen.",
    agent_title: "Agent-Downloadseite",
    background_desc:
      "Ein Konsolen-Hintergrundbild, Farbverlauf oder einfarbigen Hintergrund festlegen. Karten schweben darüber.",
    background_title: "Hintergrund & Erscheinungsbild",
    bg_blur: "Hintergrundunschärfe",
    bg_color: "Hintergrundfarbe",
    bg_gradient: "CSS-Farbverlauf",
    bg_gradient_hint:
      "Beliebiger gültiger CSS-Farbverlauf, z. B. linear-gradient(135deg, #1e293b, #0f172a)",
    bg_image_choose: "Bilddatei auswählen",
    bg_image_hint:
      "PNG, JPG, WebP oder GIF. Maximal 8 MB. Auf dem Server gespeichert.",
    bg_image_invalid_type:
      "Ungültiger Dateityp. Bitte PNG, JPG, WebP oder GIF verwenden.",
    bg_image_too_large:
      "Bild ist zu groß. Maximale Größe beträgt 8 MB.",
    bg_image_upload: "Hintergrundbild hochladen",
    bg_image_url: "Bildpfad / URL",
    bg_overlay: "Dunkle Überlagerung",
    bg_overlay_hint:
      "Verdunkelt den Hintergrund für bessere Lesbarkeit des Textes.",
    bg_size: "Bildgröße",
    bg_size_auto: "Auto (Original)",
    bg_size_contain: "Einpassen (Contain)",
    bg_size_cover: "Abdecken (Bildschirm füllen)",
    bg_type_color: "Einfarbig",
    bg_type_gradient: "Farbverlauf",
    bg_type_image: "Bild",
    bg_type_none: "Keiner",
    bg_upload_success: "Hintergrundbild erfolgreich hochgeladen.",
    custom_css_desc:
      "Erweitert: Benutzerdefiniertes CSS einfügen, das auf der gesamten Konsole und der Anmeldeseite angewendet wird.",
    custom_css_hint:
      "Mit Vorsicht verwenden. Ungültige oder unsichere Regeln werden bereinigt. Maximal 20.000 Zeichen.",
    custom_css_title: "Benutzerdefiniertes CSS",
    footer_desc:
      "Eine benutzerdefinierte Fußzeile hinzufügen, die auf dem Anmeldebildschirm und in der Konsolenseitenleiste angezeigt wird.",
    footer_text: "Fußzeilentext",
    footer_text_hint: "z. B. ein Urheberrechtshinweis oder Firmenname.",
    footer_title: "Fußzeile & Copyright",
    login_bg_inherit: "Wie die Konsole",
    login_desc:
      "Überschrift, Untertitel und Hintergrund des Anmeldebildschirms anpassen.",
    login_heading: "Anmeldeüberschrift",
    login_heading_placeholder: "Willkommen zurück",
    login_subheading: "Anmeldeuntertitel",
    login_subheading_placeholder: "Bei Ihrem Konto anmelden",
    login_title: "Anmeldeseite",
    powered_by: "Entwickelt von",
    show_powered: "BetterDesk-Zuschreibung anzeigen",
    show_powered_hint:
      "Den BetterDesk-Namen und die Version in der Anmeldefußzeile und Seitenleiste anzeigen."
  },

  cross_platform: {
    feat_multi_monitor: "Multi-Monitor",
    feat_session_recording: "Sitzungsaufzeichnung",
    feat_unattended_access: "Unbeaufsichtigter Zugriff",
    limit_linux_unprivileged:
      "Dienste laufen unter dem dedizierten unprivilegierten Konto 'betterdesk' mit systemd-Härtung (NoNewPrivileges, ProtectSystem=strict).",
    limit_win_virtual_account:
      "Dienste laufen unter isolierten virtuellen Konten anstelle von LocalSystem; benutzerdefinierte Protokollpfade müssen möglicherweise ACL-Anpassungen vorgenommen werden."
  },

  generator: {
    background_color: "Fensterhintergrund",
    build_error_hint: "Build-Fehler",
    build_status_building: "Wird erstellt",
    build_status_failed: "Fehlgeschlagen",
    build_status_pending: "In Warteschlange",
    build_status_ready: "Bereit",
    builds_empty:
      "Noch keine Builds in der Warteschlange — Paket speichern oder 'Alle neu erstellen' klicken.",
    builds_hint:
      "Auf diesem Server kompilierte Installationsprogramme für jede Plattform. Nach der Behebung von Toolchain-Fehlern oder der Aktualisierung der Agent-Quellen neu erstellen.",
    builds_loading: "Build-Status wird geladen…",
    builds_summary:
      "{{ready}} bereit · {{pending}} in Warteschlange · {{building}} wird erstellt · {{failed}} fehlgeschlagen",
    builds_title: "Client-Builds",
    connection_section: "Serververbindung",
    enrollment_per_device: "Pro Gerät — in Registrierungen genehmigen",
    enrollment_token: "Geräteregistrierung",
    enrollment_token_hint:
      "Jede Installation registriert sich selbst. Neue Geräte im Registrierungsbereich genehmigen; der Server stellt dann einen eindeutigen Zugriffsschlüssel pro Computer aus.",
    enrollment_token_pending: "Pro Gerät nach Genehmigung",
    enrollment_token_set: "Pro Gerät — in Registrierungen genehmigen",
    errors: {
      rebuild_revoked:
        "Ein widerrufenes Paket kann nicht neu erstellt werden — zuerst wieder aktivieren",
      server_host_invalid:
        "Gültigen Domainnamen oder IPv4-Adresse eingeben",
      server_host_required:
        "Öffentliche Serveradresse ist erforderlich",
      token_failed:
        "Registrierungstoken konnte nicht generiert werden — Serverkonnektivität prüfen"
    },
    header_text_color: "Kopfzeilentextfarbe",
    rebuild_all: "Alle neu erstellen",
    rebuild_confirm:
      "Alle Plattform-Installer für dieses Paket neu erstellen? Vorhandene fertige Artefakte werden ersetzt.",
    rebuild_queued: "Alle Plattform-Builds in der Warteschlange",
    rebuilding_all: "Neubuilds werden eingereiht…",
    server_host: "Öffentliche Serveradresse",
    server_host_hint:
      "Domainname oder öffentliche IP-Adresse, unter der Endbenutzer Ihren BetterDesk-Server erreichen. Port wird aus der Konsolenkonfiguration übernommen.",
    server_host_placeholder: "support.example.com oder 203.0.113.10",
    status_ready_color: "Farbe des Bereit-Indikators",
    surface_color: "Kartenhintergrund",
    text_color: "Textfarbe",
    text_muted_color: "Gedämpfte Textfarbe",
    use_https: "HTTPS / WSS verwenden (empfohlen)"
  },

  registrations: {
    approve_title: "Gerät genehmigen",
    banner_locked_mode:
      "Registrierung ist gesperrt — nur token-gebundene Geräte können sich registrieren. Der verwaltete Modus ist für die Genehmigung unbekannter Clients durch den Operator erforderlich.",
    banner_open_mode:
      "Registrierung ist offen — neue RustDesk-Clients registrieren sich ohne Genehmigung des Operators. Verwalteten Modus in den Einstellungen festlegen, um diese Warteschlange zu nutzen.",
    enrollment_settings_link: "Registrierungseinstellungen",
    field_folder: "Ordner",
    field_folder_none: "Kein Ordner",
    field_groups: "Gerätegruppen",
    field_name: "Gerätename",
    field_name_placeholder: "Name für dieses Gerät eingeben...",
    field_sync_mode: "Synchronisierungsmodus",
    field_tag_add_btn: "Hinzufügen",
    field_tag_add_placeholder: "Neues Tag hinzufügen...",
    field_tags: "Tags",
    field_tags_existing: "Vorhandene Tags",
    field_tags_placeholder:
      "Kommagetrennte Tags (z. B. Büro, Laptop)...",
    reject_ban_hint:
      "Das Gerät wird gesperrt und kann keine neuen Registrierungsanfragen senden.",
    reject_ban_option: "Dieses Gerät sperren",
    sync_silent: "Lautlos — minimale Telemetrie",
    sync_standard: "Standard — ausgewogene Synchronisierung",
    sync_turbo: "Turbo — aggressive Synchronisierung"
  },

  settings: {
    ldap_title: "LDAP / Active Directory",
    oidc_title: "OIDC / OAuth2 (SSO)",
    tab_advanced: "Erweitert",
    connection_mode_title: "Verbindungsstrategie",
    connection_mode_desc:
      "Steuern, wie RustDesk-Desktop-Clients verbinden: direktes P2P (Hole Punch) wenn möglich oder immer über Relay.",
    connection_mode_label: "Standard-Verbindungsmodus",
    connection_mode_p2p_first:
      "P2P zuerst (empfohlen) — direkte Verbindung versuchen, auf Relay zurückfallen",
    connection_mode_relay_only:
      "Nur Relay — alle Sitzungen verwenden den Relay-Server",
    connection_mode_advanced: "Erweiterte Optionen",
    connection_mode_fallback_ms: "P2P-Fallback-Timeout (ms)",
    connection_mode_same_nat_relay:
      "Relay erzwingen, wenn beide Peers dieselbe öffentliche IP teilen (NAT-Hairpin)",
    connection_mode_network_hint:
      "P2P erfordert, dass UDP-Port 21116 zwischen Clients erreichbar ist. Signal TCP 21116, Relay TCP 21117, NAT-Test 21115 müssen auf dem Server offen sein. Webbrowser-Clients verwenden immer Relay.",
    connection_mode_save: "Speichern",
    connection_mode_save_restart: "Speichern & Server neu starten",
    connection_mode_saved: "Verbindungsmodus gespeichert",
    connection_mode_restart_started: "Server-Neustart eingeleitet",
    connection_mode_restart_failed: "Server-Neustart fehlgeschlagen",
    connection_mode_not_configurable:
      "Verbindungsmodus kann auf diesem Deployment nicht geändert werden (keine systemd-Unit oder docker-compose gefunden)",
    connection_mode_compose_error:
      "Serverumgebungsabschnitt in docker-compose.yml nicht gefunden",
    connection_mode_source_saved: "Gespeichert in",
    connection_mode_source_defaults:
      "Server-Standardwerte verwenden (nicht über Panel beschreibbar)",
    connection_mode_runtime: "Aktiver Server",
    advanced_title: "Konfigurationsdateien",
    advanced_desc:
      "Serverkonfigurationsdateien direkt bearbeiten. Änderungen erfordern möglicherweise einen Dienstneustart. Vor jedem Speichern wird eine Sicherungskopie erstellt.",
    advanced_warning:
      "Diese Dateien enthalten Geheimnisse (API-Schlüssel, Datenbankpasswörter, Sitzungsgeheimnisse). Nur bearbeiten, wenn Sie wissen, was Sie tun. Falsche Syntax kann verhindern, dass der Server startet.",
    advanced_files_label: "Dateien",
    advanced_select_file:
      "Eine Datei aus der Liste auswählen, um deren Inhalt anzuzeigen oder zu bearbeiten.",
    advanced_reload: "Neu laden",
    advanced_save: "Datei speichern",
    advanced_apply_restart: "Anwenden (Dienst neu starten)",
    advanced_saved: "Konfigurationsdatei gespeichert",
    advanced_restart_after_save:
      "Konfiguration gespeichert. Den betroffenen Dienst jetzt neu starten, damit die Änderungen wirksam werden?",
    advanced_restart_confirm:
      "Die zugehörigen BetterDesk-Dienste neu starten? Aktive Verbindungen können kurz unterbrochen werden.",
    advanced_restart_console_confirm:
      "Den Webkonsolendienst neu starten? Ihre Browsersitzung wird kurz getrennt und die Seite wird neu geladen, wenn die Konsole wieder verfügbar ist.",
    advanced_restart_started: "Dienstneustart eingeleitet",
    advanced_restart_done: "Konsole neu gestartet — Seite wird neu geladen…",
    advanced_restart_polling:
      "Warten, bis die Konsole wieder online ist…",
    advanced_restart_timeout:
      "Neustart wurde gesendet, aber die Konsole hat nicht rechtzeitig geantwortet. Systemd/NSSM-Protokolle prüfen und manuell neu laden.",
    advanced_restart_failed:
      "Dienstneustart fehlgeschlagen (unzureichende Berechtigungen oder Dienst nicht installiert)",
    advanced_save_confirm:
      "Änderungen an dieser Datei speichern? Eine Sicherung der vorherigen Version wird erstellt.",
    advanced_unsaved_confirm:
      "Sie haben ungespeicherte Änderungen. Diese verwerfen?",
    advanced_no_files:
      "Keine Konfigurationsdateien auf diesem System verfügbar.",
    advanced_readonly: "schreibgeschützt",
    advanced_missing: "fehlend",
    advanced_new_file:
      "Neue Datei (wird erst beim Speichern erstellt)",
    advanced_new_file_hint:
      "Neue Datei — Inhalt hinzufügen und speichern",
    advanced_backup_created: "Sicherung erstellt",
    advanced_restart_console:
      "Den Webkonsolendienst neu starten (z. B. systemctl restart betterdesk-console), damit .env-Änderungen wirksam werden.",
    advanced_restart_goserver:
      "Den BetterDesk Go-Server neu starten, damit Blocklist-Änderungen geladen werden.",
    advanced_restart_systemd:
      "Nach dem Bearbeiten von systemd-Units ausführen: systemctl daemon-reload && systemctl restart <service>",
    advanced_restart_generic:
      "Den betroffenen Dienst neu starten, damit die Änderungen wirksam werden.",
    advanced_error_unknown: "Unbekannte Konfigurationsdatei",
    advanced_error_not_found: "Datei existiert nicht",
    advanced_error_not_file: "Pfad ist keine reguläre Datei",
    advanced_error_too_large:
      "Datei überschreitet die maximale bearbeitbare Größe (512 KB)",
    advanced_error_binary:
      "Binärdateien können nicht im Panel bearbeitet werden",
    advanced_error_invalid: "Ungültiger Dateiinhalt",
    advanced_error_not_writable:
      "Datei ist nicht vom Konsolenprozess beschreibbar",
    "advanced_file_console-env": "Konsolenumgebung (.env)",
    "advanced_file_console-env-local":
      "Konsolen-Überschreibungen (.env.local)",
    "advanced_file_go-blocklist":
      "Go-Server-Blocklist (blocklist.txt)",
    "advanced_file_systemd-console": "systemd: betterdesk-console",
    "advanced_file_systemd-server": "systemd: betterdesk-server",
    "advanced_file_console-session-secret":
      "Konsolensitzungsgeheimnis (.session_secret)",
    "advanced_file_go-audit-log":
      "Go-Server-Auditprotokoll (audit.jsonl)",
    "advanced_file_build-env":
      "Agent-Build-Umgebung (/etc/betterdesk/build.env)",
    "advanced_file_docker-supervisord": "Docker: supervisord.conf",
    "advanced_file_docker-compose": "Docker: docker-compose.yml",
    advanced_restart_none:
      "Für diese Datei ist kein Dienstneustart erforderlich.",
    enrollment_title: "Geräteregistrierung (RustDesk)",
    enrollment_desc:
      "Steuern, wie sich neue RustDesk-Clients registrieren und wie Operatoren sie auf der Seite mit den Registrierungsanfragen genehmigen.",
    enrollment_require_approval:
      "Genehmigung des Operators erforderlich (Verwalteter Modus)",
    enrollment_require_approval_hint:
      "Wenn aktiviert, werden unbekannte Clients in die Warteschlange eingereiht, bis ein Operator sie in den Registrierungsanfragen genehmigt.",
    enrollment_rich_approve:
      "Vollständiges Genehmigungsformular (Name, Ordner, Gruppen, Tags)",
    enrollment_rich_approve_hint:
      "Zeigt einen detaillierten Dialog bei der Genehmigung von Registrierungs- oder LAN-Registrierungsanfragen an.",
    enrollment_tag_picker:
      "Tags aus vorhandenen Geräte-Tags auswählen",
    enrollment_tag_picker_hint:
      "Ermöglicht Operatoren, Tags aus der auf der Geräteseite verwendeten Liste auszuwählen, anstatt nur zu tippen.",
    enrollment_open_requests: "Offene Registrierungsanfragen",
    enrollment_pending_count:
      "{count} ausstehende Registrierungsanfrage(n)"
  },

  server_attestation: {
    title: "Server-Attestierung",
    subtitle:
      "Leistungs-Benchmark zur Bestimmung der gleichzeitigen Fernverbindungskapazität bei einem 80%-CPU-, RAM- und Festplatten-Schwellenwert.",
    warning_title: "Lasttest",
    warning_body:
      "Der Benchmark simuliert parallele WebSocket-Verbindungen zu den Signal- und Relay-Servern. Außerhalb der Stoßzeiten ausführen — dieser Test belastet die Produktion.",
    run_benchmark: "Benchmark ausführen",
    abort: "Abbrechen",
    download_report: "JSON-Bericht herunterladen",
    last_test: "Letzter Test",
    no_test_yet: "Es wurde noch kein Benchmark ausgeführt",
    max_connections: "Maximale Verbindungen",
    threshold_80: "80%-Schwellenwert — endgültige Metriken",
    disk: "Festplatte",
    ramp_chart: "Last-Rampen-Diagramm",
    connections: "Verbindungen",
    connections_short: "Verb.",
    tier_guide_title: "Was bedeutet jede Stufe?",
    tier_bronze: "BRONZE",
    tier_iron: "IRON",
    tier_titanium: "TITANIUM",
    tier_platinum: "PLATINUM",
    tier_obsidian: "OBSIDIAN",
    tier_none: "UNBEWERTET",
    tier_bronze_desc:
      "1–25 gleichzeitige Verbindungen — kleiner VPS (1–2 vCPU, 2–4 GB RAM).",
    tier_iron_desc:
      "26–75 Verbindungen — mittlerer Server (2–4 vCPU, 4–8 GB RAM).",
    tier_platinum_desc:
      "76–200 Verbindungen — Hochleistungsserver (4–8 vCPU, 8–16 GB RAM).",
    tier_titanium_desc:
      "201–400 Verbindungen — Enterprise-Infrastruktur (8+ vCPU, 16–32 GB RAM).",
    tier_obsidian_desc:
      "401+ Verbindungen — Turbo-Klasse: dedizierte Hardware, 16+ vCPU, 32+ GB RAM, NVMe.",
    docker_note:
      "Hinweis: In Docker können CPU/RAM-Metriken Containergrenzen anstatt des physischen Hosts widerspiegeln.",
    badge_tooltip:
      "BetterDesk Server-Attestierung — Server-Leistungszertifizierung",
    confirm_run:
      "Dieser Benchmark führt einen Lasttest des Servers mit simulierten Verbindungen durch. Fortfahren?",
    starting: "Wird gestartet…",
    complete: "Benchmark abgeschlossen",
    signal_peers: "Signal-Peers",
    relay_sessions: "Relay-Sitzungen",
    page_error: "Fehler beim Laden der Server-Attestierungsseite",
    mode_estimated: "Geschätzt (WebSocket nicht erreichbar)",
    incomplete: "Benchmark abgeschlossen ohne gültige Einstufung"
  },

  users: {
    provider: "Anbieter",
    provider_local: "Lokal",
    provider_ldap: "LDAP/AD",
    provider_oidc: "SSO",
    password_managed_by_provider: "Vom Identitätsanbieter verwaltet",
    provider_managed_hint:
      "Dieses Konto wird von einem externen Identitätsanbieter (LDAP/AD oder SSO) verwaltet. Passwort und Rolle werden vom Anbieter gesteuert und können hier nicht geändert werden."
  },

  permissions: {
    perm_server_attestation: "Server-Leistungsattestierung"
  },

  policies: {
    block_direct_p2p_hint:
      "Gilt für Geräte in dieser Organisation. Der globale Standard wird unter Einstellungen → Verbindungsstrategie festgelegt."
  },

  cdap: {
    device_detail: "CDAP-Gerät",
    loading: "Wird geladen...",
    loading_widgets: "Geräte-Widgets werden geladen...",
    load_error: "Gerätedaten konnten nicht geladen werden",
    connected: "Verbunden",
    disconnected: "Getrennt",
    device_offline_msg:
      "Gerät ist derzeit offline. Widget-Werte können veraltet sein.",
    no_widgets: "Keine Widgets verfügbar",
    no_widgets_desc:
      "Dieses Gerät hat kein CDAP-Manifest mit Widget-Definitionen registriert.",
    command_log: "Befehlsprotokoll",
    clear_log: "Protokoll leeren",
    confirm_command: "Befehl bestätigen",
    select_option: "Auswählen",
    cdap_status: "CDAP-Status",
    cdap_enabled: "CDAP aktiviert",
    cdap_disabled: "CDAP deaktiviert",
    cdap_devices: "CDAP-Geräte",
    cdap_connections: "Aktive Verbindungen",
    send_command: "Befehl senden",
    command_sent: "Befehl erfolgreich gesendet",
    command_failed: "Befehl konnte nicht gesendet werden",
    devices_title: "CDAP-Geräte",
    devices_subtitle:
      "Verbundene Geräte über Custom Device Application Protocol",
    stat_connected: "Verbunden",
    stat_port: "Port",
    search_devices: "Geräte suchen...",
    no_devices: "Keine Geräte verbunden",
    no_devices_desc:
      "Derzeit sind keine CDAP-Geräte verbunden. Geräte erscheinen hier, sobald sie sich mit dem Gateway verbinden.",
    gateway_disabled: "CDAP-Gateway deaktiviert",
    gateway_disabled_desc:
      "CDAP-Gateway durch Setzen von CDAP_ENABLED=true in der Serverkonfiguration aktivieren.",
    gateway_active: "Aktiv",
    toggle_enable: "CDAP aktivieren",
    toggle_disable: "CDAP deaktivieren",
    enabled_restart:
      "CDAP aktiviert. Serverneustart erforderlich, um Änderungen anzuwenden.",
    disabled_restart:
      "CDAP deaktiviert. Serverneustart erforderlich, um Änderungen anzuwenden.",
    widgets: "Widgets",
    type_all: "Alle",
    type_iot: "IoT",
    type_scada: "SCADA",
    type_os_agent: "OS-Agent",
    type_network: "Netzwerk",
    type_camera: "Kamera",
    type_custom: "Benutzerdefiniert",
    active_alerts: "Aktive Warnungen",
    alert_fired: "Warnung ausgelöst",
    alert_cleared: "Warnung behoben",
    no_alerts: "Keine aktiven Warnungen",
    connect_terminal: "Terminal verbinden",
    table_search: "Suchen...",
    just_now: "Gerade eben",
    terminal_connecting: "Verbindung zum Gerät wird hergestellt...",
    terminal_disconnected: "Getrennt",
    terminal_error: "Terminal-Verbindung fehlgeschlagen",
    linked_devices: "Verknüpfte Geräte",
    link_device: "Gerät verknüpfen",
    unlink_device: "Verknüpfung aufheben",
    no_linked_devices: "Keine verknüpften Geräte",
    unlink_confirm:
      "Sind Sie sicher, dass Sie die Verknüpfung dieses Geräts aufheben möchten?",
    link_prompt: "Peer-ID eingeben, um sie mit diesem Gerät zu verknüpfen:"
  },

  tutorial: {
    cdap_devices_title: "CDAP-Geräte",
    cdap_devices_text:
      "Alle verbundenen CDAP-Geräte anzeigen — IoT-Sensoren, SPSen, Bridges und benutzerdefinierte Agents. Grüne Anzeigen zeigen Live-Verbindungen.",
    cdap_widgets_title: "Widget-Dashboard",
    cdap_widgets_text:
      "Widgets zeigen Echtzeitdaten von Geräten an. Messanzeigen, Schalter, LEDs, Diagramme — jeder Widget-Typ visualisiert eine andere Art von Daten.",
    cdap_commands_title: "Befehle senden",
    cdap_commands_text:
      "Mit Geräten durch das Senden von Befehlen interagieren. Einige Befehle erfordern eine Bestätigung. Das Befehlsprotokoll enthält den Verlauf aller gesendeten Befehle.",
    cdap_terminal_title: "Geräteterminal",
    cdap_terminal_text:
      "Eine Terminalsitzung mit CDAP-Agents für erweiterte Diagnosen oder manuelle Konfiguration öffnen. Befehle direkt eingeben.",
    cdap_complete_title: "CDAP-Übersicht abgeschlossen!",
    cdap_complete_text:
      "Geräte-Widgets erkunden, Befehle senden und das Terminal oder den Dateibrowser für eine tiefere Verwaltung nutzen. CDAP-Agents melden Metriken automatisch."
  }
};

// ---------------------------------------------------------------------------
// French (fr)
// ---------------------------------------------------------------------------
const fr = {
  common: {
    yes: "Oui",
    no: "Non"
  },

  nav: {
    main: "Principal",
    server_attestation: "Attestation du serveur"
  },

  devices: {
    restore_failed: "Échec de la restauration de l'appareil"
  },

  device_detail: {
    os: "Système d'exploitation"
  },

  inventory: {
    os: "Système d'exploitation"
  },

  remote: {
    use_cdap_fallback: "Utiliser le viewer CDAP",
    cdap_fallback_hint:
      "Ouvre le viewer JPEG léger qui utilise bd-signal/CDAP au lieu du relais RustDesk. Utile quand le pair est hors ligne sur le relais mais joignable via le canal de gestion de l'agent."
  },

  backup: {
    opt_database: "Base de données (toutes les tables)",
    opt_database_hint:
      "Réimporte toutes les données de la console. Appliqué en direct, aucun redémarrage nécessaire.",
    opt_env: "Fichier d'environnement (.env)",
    opt_env_warning:
      "Écrase SESSION_SECRET, la clé API, le DSN de la base de données, les ports et les paramètres TLS. Nécessite un redémarrage du service.",
    opt_godb: "Base de données du serveur Go",
    opt_godb_warning:
      "Écrase la base de données SQLite du serveur Go (backend SQLite uniquement). Nécessite un redémarrage du service.",
    opt_secrets: "Clés et secrets du serveur",
    opt_secrets_warning:
      "Écrase l'identité du serveur Ed25519, la clé API et le secret de session. Nécessite un redémarrage du service.",
    opt_uploads: "Fichiers de marque",
    opt_uploads_hint: "Logos et images téléchargées.",
    restart_required:
      "Certains composants restaurés (clés / .env / base de données Go) nécessitent un redémarrage du service pour prendre effet.",
    restore_warning:
      "La restauration des secrets, du fichier d'environnement ou de la base de données du serveur Go écrase l'identité du serveur et nécessite un redémarrage du service par la suite.",
    security_warning:
      "Cette sauvegarde contient des secrets (clés serveur, fichier d'environnement, hachages de mots de passe et secrets 2FA). Conservez-la en sécurité et ne la partagez jamais.",
    stat_database: "Moteur de base de données",
    stat_env: "Fichier d'environnement",
    stat_keys: "Clés serveur incluses",
    stat_uploads: "Fichiers de marque"
  },

  branding: {
    agent_desc:
      "Personnalisez le portail de téléchargement d'agent public affiché aux utilisateurs finaux.",
    agent_show_powered: "Afficher « Propulsé par BetterDesk »",
    agent_show_powered_hint:
      "Afficher l'attribution BetterDesk dans le pied de page du portail de téléchargement.",
    agent_title: "Page de téléchargement de l'agent",
    background_desc:
      "Définissez un fond d'écran, un dégradé ou un fond uni pour la console. Les cartes flottent au-dessus.",
    background_title: "Arrière-plan et apparence",
    bg_blur: "Flou d'arrière-plan",
    bg_color: "Couleur d'arrière-plan",
    bg_gradient: "Dégradé CSS",
    bg_gradient_hint:
      "Tout dégradé CSS valide, p. ex. linear-gradient(135deg, #1e293b, #0f172a)",
    bg_image_choose: "Choisir un fichier image",
    bg_image_hint:
      "PNG, JPG, WebP ou GIF. 8 Mo maximum. Stocké sur le serveur.",
    bg_image_invalid_type:
      "Type de fichier invalide. Utilisez PNG, JPG, WebP ou GIF.",
    bg_image_too_large:
      "L'image est trop grande. La taille maximale est de 8 Mo.",
    bg_image_upload: "Télécharger l'image d'arrière-plan",
    bg_image_url: "Chemin de l'image / URL",
    bg_overlay: "Superposition sombre",
    bg_overlay_hint:
      "Assombrit l'arrière-plan pour une meilleure lisibilité du texte.",
    bg_size: "Dimensionnement de l'image",
    bg_size_auto: "Auto (original)",
    bg_size_contain: "Contenu (ajuster)",
    bg_size_cover: "Couvrir (remplir l'écran)",
    bg_type_color: "Couleur unie",
    bg_type_gradient: "Dégradé",
    bg_type_image: "Image",
    bg_type_none: "Aucun",
    bg_upload_success: "Image d'arrière-plan téléchargée avec succès.",
    custom_css_desc:
      "Avancé : injectez du CSS personnalisé appliqué dans toute la console et la page de connexion.",
    custom_css_hint:
      "À utiliser avec précaution. Les règles invalides ou non sécurisées sont nettoyées. Maximum 20 000 caractères.",
    custom_css_title: "CSS personnalisé",
    footer_desc:
      "Ajoutez une ligne de pied de page personnalisée affichée sur l'écran de connexion et dans la barre latérale de la console.",
    footer_text: "Texte du pied de page",
    footer_text_hint:
      "p. ex. une mention de droit d'auteur ou le nom de l'entreprise.",
    footer_title: "Pied de page et droits d'auteur",
    login_bg_inherit: "Identique à la console",
    login_desc:
      "Personnalisez le titre, le sous-titre et l'arrière-plan de l'écran de connexion.",
    login_heading: "Titre de connexion",
    login_heading_placeholder: "Bon retour",
    login_subheading: "Sous-titre de connexion",
    login_subheading_placeholder: "Connectez-vous à votre compte",
    login_title: "Page de connexion",
    powered_by: "Propulsé par",
    show_powered: "Afficher l'attribution « BetterDesk »",
    show_powered_hint:
      "Afficher le nom et la version de BetterDesk dans le pied de page de connexion et la barre latérale."
  },

  cross_platform: {
    feat_multi_monitor: "Multi-écran",
    feat_session_recording: "Enregistrement de session",
    feat_unattended_access: "Accès sans surveillance",
    limit_linux_unprivileged:
      "Les services fonctionnent sous le compte non privilégié dédié « betterdesk » avec durcissement systemd (NoNewPrivileges, ProtectSystem=strict).",
    limit_win_virtual_account:
      "Les services fonctionnent sous des comptes virtuels isolés au lieu de LocalSystem ; les chemins de journaux personnalisés peuvent nécessiter des ajustements ACL."
  },

  generator: {
    background_color: "Arrière-plan de la fenêtre",
    build_error_hint: "Erreur de compilation",
    build_status_building: "En cours de compilation",
    build_status_failed: "Échoué",
    build_status_pending: "En file d'attente",
    build_status_ready: "Prêt",
    builds_empty:
      "Aucun build en file d'attente — enregistrez le paquet ou cliquez sur Reconstruire tout.",
    builds_hint:
      "Installateurs compilés sur ce serveur pour chaque plateforme. Reconstruire après avoir corrigé les erreurs de la chaîne d'outils ou mis à jour les sources de l'agent.",
    builds_loading: "Chargement de l'état de compilation…",
    builds_summary:
      "{{ready}} prêt · {{pending}} en file d'attente · {{building}} en compilation · {{failed}} échoué",
    builds_title: "Compilations client",
    connection_section: "Connexion au serveur",
    enrollment_per_device:
      "Par appareil — approuver dans Inscriptions",
    enrollment_token: "Enregistrement de l'appareil",
    enrollment_token_hint:
      "Chaque installation s'enregistre d'elle-même. Approuvez les nouveaux appareils dans le panneau Inscriptions ; le serveur délivre ensuite une clé d'accès unique par ordinateur.",
    enrollment_token_pending: "Par appareil après approbation",
    enrollment_token_set:
      "Par appareil — approuver dans Inscriptions",
    errors: {
      rebuild_revoked:
        "Impossible de reconstruire un paquet révoqué — réactivez-le d'abord",
      server_host_invalid:
        "Entrez un nom de domaine ou une adresse IPv4 valide",
      server_host_required:
        "L'adresse publique du serveur est requise",
      token_failed:
        "Impossible de générer le jeton d'inscription — vérifiez la connectivité du serveur"
    },
    header_text_color: "Couleur du texte d'en-tête",
    rebuild_all: "Reconstruire tout",
    rebuild_confirm:
      "Reconstruire tous les installateurs de plateforme pour ce paquet ? Les artefacts prêts existants seront remplacés.",
    rebuild_queued:
      "Toutes les compilations de plateformes mises en file d'attente",
    rebuilding_all: "Mise en file d'attente des reconstructions…",
    server_host: "Adresse publique du serveur",
    server_host_hint:
      "Nom de domaine ou IP publique où les utilisateurs finaux joignent votre serveur BetterDesk. Le port est pris dans la configuration de la console.",
    server_host_placeholder: "support.example.com ou 203.0.113.10",
    status_ready_color: "Couleur de l'indicateur prêt",
    surface_color: "Arrière-plan de la carte",
    text_color: "Couleur du texte",
    text_muted_color: "Couleur du texte atténué",
    use_https: "Utiliser HTTPS / WSS (recommandé)"
  },

  registrations: {
    approve_title: "Approuver l'appareil",
    banner_locked_mode:
      "L'inscription est verrouillée — seuls les appareils liés à un jeton peuvent s'inscrire. Le mode géré est requis pour l'approbation des clients inconnus par l'opérateur.",
    banner_open_mode:
      "L'inscription est ouverte — les nouveaux clients RustDesk s'inscrivent sans approbation de l'opérateur. Définissez le mode géré dans les paramètres pour utiliser cette file d'attente.",
    enrollment_settings_link: "Paramètres d'inscription",
    field_folder: "Dossier",
    field_folder_none: "Aucun dossier",
    field_groups: "Groupes d'appareils",
    field_name: "Nom de l'appareil",
    field_name_placeholder: "Entrez un nom pour cet appareil...",
    field_sync_mode: "Mode de synchronisation",
    field_tag_add_btn: "Ajouter",
    field_tag_add_placeholder: "Ajouter un nouveau tag...",
    field_tags: "Tags",
    field_tags_existing: "Tags existants",
    field_tags_placeholder:
      "Tags séparés par des virgules (p. ex. bureau, ordinateur portable)...",
    reject_ban_hint:
      "L'appareil sera bloqué et ne pourra plus envoyer de nouvelles demandes d'inscription.",
    reject_ban_option: "Bannir cet appareil",
    sync_silent: "Silencieux — télémétrie minimale",
    sync_standard: "Standard — synchronisation équilibrée",
    sync_turbo: "Turbo — synchronisation agressive"
  },

  settings: {
    ldap_title: "LDAP / Active Directory",
    oidc_title: "OIDC / OAuth2 (SSO)",
    tab_advanced: "Avancé",
    connection_mode_title: "Stratégie de connexion",
    connection_mode_desc:
      "Contrôlez comment les clients de bureau RustDesk se connectent : P2P direct (hole punch) si possible, ou toujours via relais.",
    connection_mode_label: "Mode de connexion par défaut",
    connection_mode_p2p_first:
      "P2P en premier (recommandé) — essayer la connexion directe, se rabattre sur le relais",
    connection_mode_relay_only:
      "Relais uniquement — toutes les sessions utilisent le serveur relais",
    connection_mode_advanced: "Options avancées",
    connection_mode_fallback_ms:
      "Délai d'expiration de basculement P2P (ms)",
    connection_mode_same_nat_relay:
      "Forcer le relais lorsque les deux pairs partagent la même IP publique (NAT hairpin)",
    connection_mode_network_hint:
      "P2P nécessite que le port UDP 21116 soit accessible entre les clients. Signal TCP 21116, relais TCP 21117, test NAT 21115 doivent être ouverts sur le serveur. Les navigateurs web utilisent toujours le relais.",
    connection_mode_save: "Enregistrer",
    connection_mode_save_restart:
      "Enregistrer et redémarrer le serveur",
    connection_mode_saved: "Mode de connexion enregistré",
    connection_mode_restart_started: "Redémarrage du serveur initié",
    connection_mode_restart_failed:
      "Échec du redémarrage du serveur",
    connection_mode_not_configurable:
      "Le mode de connexion ne peut pas être modifié sur ce déploiement (aucune unité systemd ou docker-compose trouvé)",
    connection_mode_compose_error:
      "Impossible de trouver la section d'environnement du serveur dans docker-compose.yml",
    connection_mode_source_saved: "Enregistré dans",
    connection_mode_source_defaults:
      "Utilisation des valeurs par défaut du serveur (non modifiables depuis le panneau)",
    connection_mode_runtime: "Serveur actif",
    advanced_title: "Fichiers de configuration",
    advanced_desc:
      "Modifiez directement les fichiers de configuration du serveur. Les modifications peuvent nécessiter un redémarrage des services. Une copie de sauvegarde est créée avant chaque enregistrement.",
    advanced_warning:
      "Ces fichiers contiennent des secrets (clés API, mots de passe de base de données, secrets de session). Ne modifiez que si vous savez ce que vous faites. Une syntaxe incorrecte peut empêcher le serveur de démarrer.",
    advanced_files_label: "Fichiers",
    advanced_select_file:
      "Sélectionnez un fichier dans la liste pour afficher ou modifier son contenu.",
    advanced_reload: "Recharger",
    advanced_save: "Enregistrer le fichier",
    advanced_apply_restart: "Appliquer (redémarrer le service)",
    advanced_saved: "Fichier de configuration enregistré",
    advanced_restart_after_save:
      "Configuration enregistrée. Redémarrer le service concerné maintenant pour que les modifications prennent effet ?",
    advanced_restart_confirm:
      "Redémarrer le(s) service(s) BetterDesk concerné(s) ? Les connexions actives peuvent être brièvement interrompues.",
    advanced_restart_console_confirm:
      "Redémarrer le service de console web ? Votre session de navigateur se déconnectera brièvement et la page se rechargera lorsque la console sera de retour.",
    advanced_restart_started: "Redémarrage du service initié",
    advanced_restart_done:
      "Console redémarrée — rechargement de la page…",
    advanced_restart_polling:
      "En attente du retour en ligne de la console…",
    advanced_restart_timeout:
      "Le redémarrage a été envoyé mais la console n'a pas répondu à temps. Vérifiez les journaux systemd/NSSM et rechargez manuellement.",
    advanced_restart_failed:
      "Échec du redémarrage du service (privilèges insuffisants ou service non installé)",
    advanced_save_confirm:
      "Enregistrer les modifications de ce fichier ? Une sauvegarde de la version précédente sera créée.",
    advanced_unsaved_confirm:
      "Vous avez des modifications non enregistrées. Les ignorer ?",
    advanced_no_files:
      "Aucun fichier de configuration disponible sur ce système.",
    advanced_readonly: "lecture seule",
    advanced_missing: "manquant",
    advanced_new_file:
      "Nouveau fichier (non créé jusqu'à l'enregistrement)",
    advanced_new_file_hint:
      "Nouveau fichier — ajoutez du contenu et enregistrez",
    advanced_backup_created: "sauvegarde créée",
    advanced_restart_console:
      "Redémarrez le service de console web (p. ex. systemctl restart betterdesk-console) pour que les modifications .env prennent effet.",
    advanced_restart_goserver:
      "Redémarrez le serveur Go BetterDesk pour que les modifications de la liste de blocage soient chargées.",
    advanced_restart_systemd:
      "Après avoir modifié des unités systemd, exécutez : systemctl daemon-reload && systemctl restart <service>",
    advanced_restart_generic:
      "Redémarrez le service concerné pour que les modifications prennent effet.",
    advanced_error_unknown: "Fichier de configuration inconnu",
    advanced_error_not_found: "Le fichier n'existe pas",
    advanced_error_not_file: "Le chemin n'est pas un fichier ordinaire",
    advanced_error_too_large:
      "Le fichier dépasse la taille maximale modifiable (512 Ko)",
    advanced_error_binary:
      "Les fichiers binaires ne peuvent pas être modifiés dans le panneau",
    advanced_error_invalid: "Contenu de fichier invalide",
    advanced_error_not_writable:
      "Le fichier n'est pas accessible en écriture par le processus de console",
    "advanced_file_console-env": "Environnement de la console (.env)",
    "advanced_file_console-env-local":
      "Substitutions de la console (.env.local)",
    "advanced_file_go-blocklist":
      "Liste de blocage du serveur Go (blocklist.txt)",
    "advanced_file_systemd-console": "systemd: betterdesk-console",
    "advanced_file_systemd-server": "systemd: betterdesk-server",
    "advanced_file_console-session-secret":
      "Secret de session de la console (.session_secret)",
    "advanced_file_go-audit-log":
      "Journal d'audit du serveur Go (audit.jsonl)",
    "advanced_file_build-env":
      "Environnement de compilation de l'agent (/etc/betterdesk/build.env)",
    "advanced_file_docker-supervisord": "Docker: supervisord.conf",
    "advanced_file_docker-compose": "Docker: docker-compose.yml",
    advanced_restart_none:
      "Aucun redémarrage de service n'est requis pour ce fichier.",
    enrollment_title: "Inscription de l'appareil (RustDesk)",
    enrollment_desc:
      "Contrôlez comment les nouveaux clients RustDesk s'inscrivent et comment les opérateurs les approuvent dans la page des demandes d'inscription.",
    enrollment_require_approval:
      "Approbation de l'opérateur requise (mode géré)",
    enrollment_require_approval_hint:
      "Lorsqu'activé, les clients inconnus sont mis en file d'attente jusqu'à ce qu'un opérateur les approuve dans les demandes d'inscription.",
    enrollment_rich_approve:
      "Formulaire d'approbation complet (nom, dossier, groupes, tags)",
    enrollment_rich_approve_hint:
      "Affiche un dialogue détaillé lors de l'approbation des demandes d'inscription ou d'enregistrement LAN.",
    enrollment_tag_picker:
      "Sélectionner des tags parmi les tags d'appareils existants",
    enrollment_tag_picker_hint:
      "Permet aux opérateurs de sélectionner des tags dans la liste utilisée sur la page Appareils plutôt que de les saisir uniquement.",
    enrollment_open_requests: "Demandes d'inscription ouvertes",
    enrollment_pending_count:
      "{count} demande(s) d'inscription en attente"
  },

  server_attestation: {
    title: "Attestation du serveur",
    subtitle:
      "Benchmark de performance qui détermine la capacité de connexions distantes simultanées à un seuil de 80% CPU, RAM et disque.",
    warning_title: "Test de charge",
    warning_body:
      "Le benchmark simule des connexions WebSocket parallèles aux serveurs de signal et de relais. Exécutez pendant les heures creuses — ce test charge la production.",
    run_benchmark: "Lancer le benchmark",
    abort: "Abandonner",
    download_report: "Télécharger le rapport JSON",
    last_test: "Dernier test",
    no_test_yet: "Aucun benchmark n'a encore été exécuté",
    max_connections: "Connexions maximales",
    threshold_80: "Seuil à 80% — métriques finales",
    disk: "Disque",
    ramp_chart: "Graphique de montée en charge",
    connections: "Connexions",
    connections_short: "conn.",
    tier_guide_title: "Que signifie chaque niveau ?",
    tier_bronze: "BRONZE",
    tier_iron: "IRON",
    tier_titanium: "TITANIUM",
    tier_platinum: "PLATINUM",
    tier_obsidian: "OBSIDIAN",
    tier_none: "NON ÉVALUÉ",
    tier_bronze_desc:
      "1–25 connexions simultanées — petit VPS (1–2 vCPU, 2–4 Go de RAM).",
    tier_iron_desc:
      "26–75 connexions — serveur milieu de gamme (2–4 vCPU, 4–8 Go de RAM).",
    tier_platinum_desc:
      "76–200 connexions — serveur haute performance (4–8 vCPU, 8–16 Go de RAM).",
    tier_titanium_desc:
      "201–400 connexions — infrastructure d'entreprise (8+ vCPU, 16–32 Go de RAM).",
    tier_obsidian_desc:
      "401+ connexions — classe turbo : matériel dédié, 16+ vCPU, 32+ Go de RAM, NVMe.",
    docker_note:
      "Remarque : dans Docker, les métriques CPU/RAM peuvent refléter les limites du conteneur plutôt que l'hôte physique.",
    badge_tooltip:
      "Attestation du serveur BetterDesk — certification de performance du serveur",
    confirm_run:
      "Ce benchmark effectuera un test de charge du serveur avec des connexions simulées. Continuer ?",
    starting: "Démarrage…",
    complete: "Benchmark terminé",
    signal_peers: "Pairs de signal",
    relay_sessions: "Sessions de relais",
    page_error:
      "Échec du chargement de la page d'attestation du serveur",
    mode_estimated: "Estimé (WebSocket inaccessible)",
    incomplete: "Benchmark terminé sans niveau valide"
  },

  users: {
    provider: "Fournisseur",
    provider_local: "Local",
    provider_ldap: "LDAP/AD",
    provider_oidc: "SSO",
    password_managed_by_provider:
      "Géré par le fournisseur d'identité",
    provider_managed_hint:
      "Ce compte est géré par un fournisseur d'identité externe (LDAP/AD ou SSO). Le mot de passe et le rôle sont contrôlés par le fournisseur et ne peuvent pas être modifiés ici."
  },

  permissions: {
    perm_server_attestation: "Attestation de performance du serveur"
  },

  policies: {
    block_direct_p2p_hint:
      "S'applique aux appareils de cette organisation. La valeur par défaut globale est sous Paramètres → Stratégie de connexion."
  },

  cdap: {
    device_detail: "Appareil CDAP",
    loading: "Chargement...",
    loading_widgets: "Chargement des widgets de l'appareil...",
    load_error:
      "Impossible de charger les données de l'appareil",
    connected: "Connecté",
    disconnected: "Déconnecté",
    device_offline_msg:
      "L'appareil est actuellement hors ligne. Les valeurs des widgets peuvent être obsolètes.",
    no_widgets: "Aucun widget disponible",
    no_widgets_desc:
      "Cet appareil n'a pas enregistré de manifeste CDAP avec des définitions de widgets.",
    command_log: "Journal des commandes",
    clear_log: "Effacer le journal",
    confirm_command: "Confirmer la commande",
    select_option: "Sélectionner",
    cdap_status: "Statut CDAP",
    cdap_enabled: "CDAP activé",
    cdap_disabled: "CDAP désactivé",
    cdap_devices: "Appareils CDAP",
    cdap_connections: "Connexions actives",
    send_command: "Envoyer une commande",
    command_sent: "Commande envoyée avec succès",
    command_failed: "Échec de l'envoi de la commande",
    devices_title: "Appareils CDAP",
    devices_subtitle:
      "Appareils connectés via le protocole d'application d'appareil personnalisé",
    stat_connected: "Connecté",
    stat_port: "Port",
    search_devices: "Rechercher des appareils...",
    no_devices: "Aucun appareil connecté",
    no_devices_desc:
      "Aucun appareil CDAP n'est actuellement connecté. Les appareils apparaîtront ici dès qu'ils se connecteront à la passerelle.",
    gateway_disabled: "Passerelle CDAP désactivée",
    gateway_disabled_desc:
      "Activez la passerelle CDAP en définissant CDAP_ENABLED=true dans la configuration du serveur.",
    gateway_active: "Active",
    toggle_enable: "Activer CDAP",
    toggle_disable: "Désactiver CDAP",
    enabled_restart:
      "CDAP activé. Redémarrage du serveur requis pour appliquer les modifications.",
    disabled_restart:
      "CDAP désactivé. Redémarrage du serveur requis pour appliquer les modifications.",
    widgets: "widgets",
    type_all: "Tous",
    type_iot: "IoT",
    type_scada: "SCADA",
    type_os_agent: "Agent OS",
    type_network: "Réseau",
    type_camera: "Caméra",
    type_custom: "Personnalisé",
    active_alerts: "Alertes actives",
    alert_fired: "Alerte déclenchée",
    alert_cleared: "Alerte résolue",
    no_alerts: "Aucune alerte active",
    connect_terminal: "Connecter le terminal",
    table_search: "Rechercher...",
    just_now: "À l'instant",
    terminal_connecting: "Connexion à l'appareil...",
    terminal_disconnected: "Déconnecté",
    terminal_error: "Échec de la connexion au terminal",
    linked_devices: "Appareils liés",
    link_device: "Lier un appareil",
    unlink_device: "Délier",
    no_linked_devices: "Aucun appareil lié",
    unlink_confirm:
      "Êtes-vous sûr de vouloir délier cet appareil ?",
    link_prompt:
      "Entrez l'ID du pair à lier à cet appareil :"
  },

  tutorial: {
    cdap_devices_title: "Appareils CDAP",
    cdap_devices_text:
      "Affichez tous les appareils CDAP connectés — capteurs IoT, automates, ponts et agents personnalisés. Les indicateurs verts signalent des connexions en direct.",
    cdap_widgets_title: "Tableau de bord des widgets",
    cdap_widgets_text:
      "Les widgets affichent des données en temps réel depuis les appareils. Jauges, interrupteurs, LEDs, graphiques — chaque type de widget visualise un type de données différent.",
    cdap_commands_title: "Envoyer des commandes",
    cdap_commands_text:
      "Interagissez avec les appareils en envoyant des commandes. Certaines commandes nécessitent une confirmation. Le journal des commandes conserve l'historique de toutes les commandes envoyées.",
    cdap_terminal_title: "Terminal de l'appareil",
    cdap_terminal_text:
      "Ouvrez une session de terminal vers les agents CDAP pour des diagnostics avancés ou une configuration manuelle. Saisissez les commandes directement.",
    cdap_complete_title: "Présentation CDAP terminée !",
    cdap_complete_text:
      "Explorez les widgets des appareils, envoyez des commandes et utilisez le terminal ou le navigateur de fichiers pour une gestion plus approfondie. Les agents CDAP rapportent automatiquement les métriques."
  }
};

// ---------------------------------------------------------------------------
// Spanish (es)
// ---------------------------------------------------------------------------
const es = {
  common: {
    yes: "Sí",
    no: "No"
  },

  nav: {
    main: "Principal",
    server_attestation: "Certificación del servidor"
  },

  devices: {
    restore_failed: "Error al restaurar el dispositivo"
  },

  device_detail: {
    os: "Sistema operativo"
  },

  inventory: {
    os: "Sistema operativo"
  },

  remote: {
    use_cdap_fallback: "Usar el visor CDAP",
    cdap_fallback_hint:
      "Abre el visor JPEG ligero que usa bd-signal/CDAP en lugar del relay de RustDesk. Útil cuando el par está desconectado del relay pero es accesible a través del canal de gestión del agente."
  },

  backup: {
    opt_database: "Base de datos (todas las tablas)",
    opt_database_hint:
      "Reimporta todos los datos de la consola. Se aplica en vivo, no se requiere reinicio.",
    opt_env: "Archivo de entorno (.env)",
    opt_env_warning:
      "Sobreescribe SESSION_SECRET, clave API, DSN de la base de datos, puertos y configuración TLS. Requiere reinicio del servicio.",
    opt_godb: "Base de datos del servidor Go",
    opt_godb_warning:
      "Sobreescribe la base de datos SQLite del servidor Go (solo backend SQLite). Requiere reinicio del servicio.",
    opt_secrets: "Claves y secretos del servidor",
    opt_secrets_warning:
      "Sobreescribe la identidad del servidor Ed25519, la clave API y el secreto de sesión. Requiere reinicio del servicio.",
    opt_uploads: "Archivos de marca",
    opt_uploads_hint: "Logos e imágenes subidas.",
    restart_required:
      "Algunos componentes restaurados (claves / .env / base de datos Go) requieren un reinicio del servicio para tomar efecto.",
    restore_warning:
      "Restaurar los secretos, el archivo de entorno o la base de datos del servidor Go sobrescribe la identidad del servidor y requiere un reinicio del servicio después.",
    security_warning:
      "Esta copia de seguridad contiene secretos (claves del servidor, archivo de entorno, hashes de contraseñas y secretos 2FA). Guárdela de forma segura y nunca la comparta.",
    stat_database: "Motor de base de datos",
    stat_env: "Archivo de entorno",
    stat_keys: "Claves del servidor incluidas",
    stat_uploads: "Archivos de marca"
  },

  branding: {
    agent_desc:
      "Personaliza el portal de descarga de agentes público que se muestra a los usuarios finales.",
    agent_show_powered: "Mostrar «Desarrollado por BetterDesk»",
    agent_show_powered_hint:
      "Mostrar la atribución de BetterDesk en el pie de página del portal de descargas.",
    agent_title: "Página de descarga del agente",
    background_desc:
      "Establece un fondo de pantalla, degradado o color sólido para la consola. Las tarjetas flotan sobre él.",
    background_title: "Fondo y apariencia",
    bg_blur: "Desenfoque de fondo",
    bg_color: "Color de fondo",
    bg_gradient: "Degradado CSS",
    bg_gradient_hint:
      "Cualquier degradado CSS válido, p. ej. linear-gradient(135deg, #1e293b, #0f172a)",
    bg_image_choose: "Elegir archivo de imagen",
    bg_image_hint:
      "PNG, JPG, WebP o GIF. Máx. 8 MB. Almacenado en el servidor.",
    bg_image_invalid_type:
      "Tipo de archivo no válido. Use PNG, JPG, WebP o GIF.",
    bg_image_too_large:
      "La imagen es demasiado grande. El tamaño máximo es 8 MB.",
    bg_image_upload: "Subir imagen de fondo",
    bg_image_url: "Ruta de imagen / URL",
    bg_overlay: "Superposición oscura",
    bg_overlay_hint:
      "Oscurece el fondo para mejorar la legibilidad del texto.",
    bg_size: "Tamaño de imagen",
    bg_size_auto: "Auto (original)",
    bg_size_contain: "Contener (ajustar)",
    bg_size_cover: "Cubrir (llenar pantalla)",
    bg_type_color: "Color sólido",
    bg_type_gradient: "Degradado",
    bg_type_image: "Imagen",
    bg_type_none: "Ninguno",
    bg_upload_success: "Imagen de fondo subida correctamente.",
    custom_css_desc:
      "Avanzado: inserta CSS personalizado aplicado en toda la consola y la página de inicio de sesión.",
    custom_css_hint:
      "Úsalo con cuidado. Las reglas inválidas o no seguras se eliminan. Máximo 20.000 caracteres.",
    custom_css_title: "CSS personalizado",
    footer_desc:
      "Agrega una línea de pie de página personalizada que se muestra en la pantalla de inicio de sesión y en la barra lateral de la consola.",
    footer_text: "Texto del pie de página",
    footer_text_hint:
      "p. ej. un aviso de copyright o el nombre de la empresa.",
    footer_title: "Pie de página y derechos de autor",
    login_bg_inherit: "Igual que la consola",
    login_desc:
      "Personaliza el título, subtítulo y fondo de la pantalla de inicio de sesión.",
    login_heading: "Encabezado de inicio de sesión",
    login_heading_placeholder: "Bienvenido de nuevo",
    login_subheading: "Subtítulo de inicio de sesión",
    login_subheading_placeholder: "Iniciar sesión en su cuenta",
    login_title: "Página de inicio de sesión",
    powered_by: "Desarrollado por",
    show_powered: "Mostrar atribución «BetterDesk»",
    show_powered_hint:
      "Mostrar el nombre y la versión de BetterDesk en el pie de página de inicio de sesión y en la barra lateral."
  },

  cross_platform: {
    feat_multi_monitor: "Múltiples monitores",
    feat_session_recording: "Grabación de sesión",
    feat_unattended_access: "Acceso desatendido",
    limit_linux_unprivileged:
      "Los servicios se ejecutan bajo la cuenta sin privilegios dedicada «betterdesk» con endurecimiento de systemd (NoNewPrivileges, ProtectSystem=strict).",
    limit_win_virtual_account:
      "Los servicios se ejecutan bajo cuentas virtuales aisladas en lugar de LocalSystem; las rutas de registro personalizadas pueden necesitar ajuste de ACL."
  },

  generator: {
    background_color: "Fondo de ventana",
    build_error_hint: "Error de compilación",
    build_status_building: "Compilando",
    build_status_failed: "Fallido",
    build_status_pending: "En cola",
    build_status_ready: "Listo",
    builds_empty:
      "Aún no hay compilaciones en cola — guarda el paquete o haz clic en Reconstruir todo.",
    builds_hint:
      "Instaladores compilados en este servidor para cada plataforma. Reconstruir después de corregir errores de la cadena de herramientas o actualizar el código fuente del agente.",
    builds_loading: "Cargando estado de compilación…",
    builds_summary:
      "{{ready}} listo · {{pending}} en cola · {{building}} compilando · {{failed}} fallido",
    builds_title: "Compilaciones de cliente",
    connection_section: "Conexión al servidor",
    enrollment_per_device:
      "Por dispositivo — aprobar en Registros",
    enrollment_token: "Registro de dispositivo",
    enrollment_token_hint:
      "Cada instalación se registra por sí sola. Aprueba nuevos dispositivos en el panel de Registros; el servidor emite entonces una clave de acceso única por ordenador.",
    enrollment_token_pending: "Por dispositivo tras aprobación",
    enrollment_token_set: "Por dispositivo — aprobar en Registros",
    errors: {
      rebuild_revoked:
        "No se puede reconstruir un paquete revocado — vuelva a habilitarlo primero",
      server_host_invalid:
        "Ingrese un nombre de dominio o dirección IPv4 válido",
      server_host_required:
        "La dirección pública del servidor es obligatoria",
      token_failed:
        "No se pudo generar el token de inscripción — compruebe la conectividad del servidor"
    },
    header_text_color: "Color del texto de encabezado",
    rebuild_all: "Reconstruir todo",
    rebuild_confirm:
      "¿Reconstruir todos los instaladores de plataforma para este paquete? Los artefactos listos existentes serán reemplazados.",
    rebuild_queued:
      "Todas las compilaciones de plataforma en cola",
    rebuilding_all: "Poniendo en cola las reconstrucciones…",
    server_host: "Dirección pública del servidor",
    server_host_hint:
      "Nombre de dominio o IP pública donde los usuarios finales acceden a su servidor BetterDesk. El puerto se toma de la configuración de la consola.",
    server_host_placeholder:
      "support.example.com o 203.0.113.10",
    status_ready_color: "Color del indicador de listo",
    surface_color: "Fondo de tarjeta",
    text_color: "Color del texto",
    text_muted_color: "Color de texto atenuado",
    use_https: "Usar HTTPS / WSS (recomendado)"
  },

  registrations: {
    approve_title: "Aprobar dispositivo",
    banner_locked_mode:
      "La inscripción está bloqueada — solo los dispositivos vinculados a un token pueden registrarse. El modo administrado es necesario para que el operador apruebe clientes desconocidos.",
    banner_open_mode:
      "La inscripción está abierta — los nuevos clientes RustDesk se registran sin aprobación del operador. Establece el modo administrado en Configuración para usar esta cola.",
    enrollment_settings_link: "Configuración de inscripción",
    field_folder: "Carpeta",
    field_folder_none: "Sin carpeta",
    field_groups: "Grupos de dispositivos",
    field_name: "Nombre del dispositivo",
    field_name_placeholder:
      "Ingresa un nombre para este dispositivo...",
    field_sync_mode: "Modo de sincronización",
    field_tag_add_btn: "Agregar",
    field_tag_add_placeholder: "Agregar nueva etiqueta...",
    field_tags: "Etiquetas",
    field_tags_existing: "Etiquetas existentes",
    field_tags_placeholder:
      "Etiquetas separadas por comas (p. ej. oficina, portátil)...",
    reject_ban_hint:
      "El dispositivo será bloqueado y no podrá enviar nuevas solicitudes de registro.",
    reject_ban_option: "Prohibir este dispositivo",
    sync_silent: "Silencioso — telemetría mínima",
    sync_standard: "Estándar — sincronización equilibrada",
    sync_turbo: "Turbo — sincronización agresiva"
  },

  settings: {
    ldap_title: "LDAP / Active Directory",
    oidc_title: "OIDC / OAuth2 (SSO)",
    tab_advanced: "Avanzado",
    connection_mode_title: "Estrategia de conexión",
    connection_mode_desc:
      "Controla cómo se conectan los clientes de escritorio RustDesk: P2P directo (hole punch) cuando sea posible, o siempre a través de retransmisión.",
    connection_mode_label: "Modo de conexión predeterminado",
    connection_mode_p2p_first:
      "P2P primero (recomendado) — intentar conexión directa, usar retransmisión como alternativa",
    connection_mode_relay_only:
      "Solo retransmisión — todas las sesiones usan el servidor de retransmisión",
    connection_mode_advanced: "Opciones avanzadas",
    connection_mode_fallback_ms:
      "Tiempo de espera de fallback P2P (ms)",
    connection_mode_same_nat_relay:
      "Forzar retransmisión cuando ambos pares comparten la misma IP pública (NAT hairpin)",
    connection_mode_network_hint:
      "P2P requiere que el puerto UDP 21116 sea accesible entre los clientes. Signal TCP 21116, relay TCP 21117, NAT test 21115 deben estar abiertos en el servidor. Los clientes de navegador web siempre usan retransmisión.",
    connection_mode_save: "Guardar",
    connection_mode_save_restart: "Guardar y reiniciar servidor",
    connection_mode_saved: "Modo de conexión guardado",
    connection_mode_restart_started:
      "Reinicio del servidor iniciado",
    connection_mode_restart_failed:
      "Error al reiniciar el servidor",
    connection_mode_not_configurable:
      "El modo de conexión no se puede cambiar en este despliegue (no se encontró unidad systemd ni docker-compose)",
    connection_mode_compose_error:
      "No se pudo encontrar la sección de entorno del servidor en docker-compose.yml",
    connection_mode_source_saved: "Guardado en",
    connection_mode_source_defaults:
      "Usando valores predeterminados del servidor (no modificables desde el panel)",
    connection_mode_runtime: "Servidor activo",
    advanced_title: "Archivos de configuración",
    advanced_desc:
      "Edita los archivos de configuración del servidor directamente. Los cambios pueden requerir reiniciar los servicios. Se crea una copia de seguridad antes de cada guardado.",
    advanced_warning:
      "Estos archivos contienen secretos (claves API, contraseñas de base de datos, secretos de sesión). Edita solo si sabes lo que estás haciendo. Una sintaxis incorrecta puede impedir que el servidor arranque.",
    advanced_files_label: "Archivos",
    advanced_select_file:
      "Selecciona un archivo de la lista para ver o editar su contenido.",
    advanced_reload: "Recargar",
    advanced_save: "Guardar archivo",
    advanced_apply_restart: "Aplicar (reiniciar servicio)",
    advanced_saved: "Archivo de configuración guardado",
    advanced_restart_after_save:
      "Configuración guardada. ¿Reiniciar el servicio afectado ahora para que los cambios surtan efecto?",
    advanced_restart_confirm:
      "¿Reiniciar el(los) servicio(s) BetterDesk relacionado(s)? Las conexiones activas pueden interrumpirse brevemente.",
    advanced_restart_console_confirm:
      "¿Reiniciar el servicio de consola web? La sesión del navegador se desconectará brevemente y la página se recargará cuando la consola vuelva.",
    advanced_restart_started: "Reinicio del servicio iniciado",
    advanced_restart_done:
      "Consola reiniciada — recargando página…",
    advanced_restart_polling:
      "Esperando que la consola vuelva a estar en línea…",
    advanced_restart_timeout:
      "Se envió el reinicio pero la consola no respondió a tiempo. Revisa los registros de systemd/NSSM y recarga manualmente.",
    advanced_restart_failed:
      "Error al reiniciar el servicio (privilegios insuficientes o servicio no instalado)",
    advanced_save_confirm:
      "¿Guardar cambios en este archivo? Se creará una copia de seguridad de la versión anterior.",
    advanced_unsaved_confirm:
      "Tienes cambios sin guardar. ¿Descartarlos?",
    advanced_no_files:
      "No hay archivos de configuración disponibles en este sistema.",
    advanced_readonly: "solo lectura",
    advanced_missing: "faltante",
    advanced_new_file:
      "Nuevo archivo (no se crea hasta que guardes)",
    advanced_new_file_hint:
      "Nuevo archivo — agrega contenido y guarda",
    advanced_backup_created: "copia de seguridad creada",
    advanced_restart_console:
      "Reinicia el servicio de consola web (p. ej. systemctl restart betterdesk-console) para que los cambios en .env surtan efecto.",
    advanced_restart_goserver:
      "Reinicia el servidor Go de BetterDesk para que se carguen los cambios en la lista de bloqueo.",
    advanced_restart_systemd:
      "Después de editar las unidades de systemd, ejecuta: systemctl daemon-reload && systemctl restart <service>",
    advanced_restart_generic:
      "Reinicia el servicio afectado para que los cambios surtan efecto.",
    advanced_error_unknown: "Archivo de configuración desconocido",
    advanced_error_not_found: "El archivo no existe",
    advanced_error_not_file: "La ruta no es un archivo regular",
    advanced_error_too_large:
      "El archivo excede el tamaño máximo editable (512 KB)",
    advanced_error_binary:
      "Los archivos binarios no se pueden editar en el panel",
    advanced_error_invalid: "Contenido de archivo no válido",
    advanced_error_not_writable:
      "El archivo no es escribible por el proceso de consola",
    "advanced_file_console-env": "Entorno de la consola (.env)",
    "advanced_file_console-env-local":
      "Anulaciones de la consola (.env.local)",
    "advanced_file_go-blocklist":
      "Lista de bloqueo del servidor Go (blocklist.txt)",
    "advanced_file_systemd-console": "systemd: betterdesk-console",
    "advanced_file_systemd-server": "systemd: betterdesk-server",
    "advanced_file_console-session-secret":
      "Secreto de sesión de la consola (.session_secret)",
    "advanced_file_go-audit-log":
      "Registro de auditoría del servidor Go (audit.jsonl)",
    "advanced_file_build-env":
      "Entorno de compilación del agente (/etc/betterdesk/build.env)",
    "advanced_file_docker-supervisord": "Docker: supervisord.conf",
    "advanced_file_docker-compose": "Docker: docker-compose.yml",
    advanced_restart_none:
      "No se requiere reinicio del servicio para este archivo.",
    enrollment_title: "Inscripción de dispositivo (RustDesk)",
    enrollment_desc:
      "Controla cómo se registran los nuevos clientes RustDesk y cómo los operadores los aprueban en la página de solicitudes de inscripción.",
    enrollment_require_approval:
      "Requiere aprobación del operador (modo administrado)",
    enrollment_require_approval_hint:
      "Cuando está habilitado, los clientes desconocidos se ponen en cola hasta que un operador los aprueba en Solicitudes de inscripción.",
    enrollment_rich_approve:
      "Formulario de aprobación completo (nombre, carpeta, grupos, etiquetas)",
    enrollment_rich_approve_hint:
      "Muestra un diálogo detallado al aprobar solicitudes de inscripción o registro LAN.",
    enrollment_tag_picker:
      "Elegir etiquetas de las etiquetas de dispositivos existentes",
    enrollment_tag_picker_hint:
      "Permite a los operadores seleccionar etiquetas de la lista usada en la página de Dispositivos en lugar de solo escribirlas.",
    enrollment_open_requests: "Solicitudes de inscripción abiertas",
    enrollment_pending_count:
      "{count} solicitud(es) de inscripción pendiente(s)"
  },

  server_attestation: {
    title: "Certificación del servidor",
    subtitle:
      "Benchmark de rendimiento que determina la capacidad de conexiones remotas simultáneas en un umbral del 80% de CPU, RAM y disco.",
    warning_title: "Prueba de carga",
    warning_body:
      "El benchmark simula conexiones WebSocket paralelas a los servidores de señal y retransmisión. Ejecutar en horas de baja actividad — esta prueba carga producción.",
    run_benchmark: "Ejecutar benchmark",
    abort: "Cancelar",
    download_report: "Descargar informe JSON",
    last_test: "Última prueba",
    no_test_yet: "Aún no se ha ejecutado ningún benchmark",
    max_connections: "Conexiones máximas",
    threshold_80: "Umbral del 80% — métricas finales",
    disk: "Disco",
    ramp_chart: "Gráfico de rampa de carga",
    connections: "Conexiones",
    connections_short: "con.",
    tier_guide_title: "¿Qué significa cada nivel?",
    tier_bronze: "BRONZE",
    tier_iron: "IRON",
    tier_titanium: "TITANIUM",
    tier_platinum: "PLATINUM",
    tier_obsidian: "OBSIDIAN",
    tier_none: "SIN CALIFICAR",
    tier_bronze_desc:
      "1–25 conexiones simultáneas — VPS pequeño (1–2 vCPU, 2–4 GB RAM).",
    tier_iron_desc:
      "26–75 conexiones — servidor de gama media (2–4 vCPU, 4–8 GB RAM).",
    tier_platinum_desc:
      "76–200 conexiones — servidor de alto rendimiento (4–8 vCPU, 8–16 GB RAM).",
    tier_titanium_desc:
      "201–400 conexiones — infraestructura empresarial (8+ vCPU, 16–32 GB RAM).",
    tier_obsidian_desc:
      "401+ conexiones — clase turbo: hardware dedicado, 16+ vCPU, 32+ GB RAM, NVMe.",
    docker_note:
      "Nota: en Docker, las métricas de CPU/RAM pueden reflejar los límites del contenedor en lugar del host físico.",
    badge_tooltip:
      "Certificación del servidor BetterDesk — certificación de rendimiento del servidor",
    confirm_run:
      "Este benchmark realizará una prueba de carga del servidor con conexiones simuladas. ¿Continuar?",
    starting: "Iniciando…",
    complete: "Benchmark completado",
    signal_peers: "Pares de señal",
    relay_sessions: "Sesiones de retransmisión",
    page_error:
      "Error al cargar la página de certificación del servidor",
    mode_estimated: "Estimado (WebSocket inaccesible)",
    incomplete: "Benchmark completado sin nivel válido"
  },

  users: {
    provider: "Proveedor",
    provider_local: "Local",
    provider_ldap: "LDAP/AD",
    provider_oidc: "SSO",
    password_managed_by_provider:
      "Gestionado por el proveedor de identidad",
    provider_managed_hint:
      "Esta cuenta está gestionada por un proveedor de identidad externo (LDAP/AD o SSO). La contraseña y el rol son controlados por el proveedor y no se pueden cambiar aquí."
  },

  permissions: {
    perm_server_attestation:
      "Certificación de rendimiento del servidor"
  },

  policies: {
    block_direct_p2p_hint:
      "Se aplica a los dispositivos de esta organización. El valor predeterminado global está en Configuración → Estrategia de conexión."
  },

  cdap: {
    device_detail: "Dispositivo CDAP",
    loading: "Cargando...",
    loading_widgets: "Cargando widgets del dispositivo...",
    load_error: "Error al cargar los datos del dispositivo",
    connected: "Conectado",
    disconnected: "Desconectado",
    device_offline_msg:
      "El dispositivo está actualmente fuera de línea. Los valores de los widgets pueden estar desactualizados.",
    no_widgets: "No hay widgets disponibles",
    no_widgets_desc:
      "Este dispositivo no ha registrado un manifiesto CDAP con definiciones de widgets.",
    command_log: "Registro de comandos",
    clear_log: "Limpiar registro",
    confirm_command: "Confirmar comando",
    select_option: "Seleccionar",
    cdap_status: "Estado CDAP",
    cdap_enabled: "CDAP habilitado",
    cdap_disabled: "CDAP deshabilitado",
    cdap_devices: "Dispositivos CDAP",
    cdap_connections: "Conexiones activas",
    send_command: "Enviar comando",
    command_sent: "Comando enviado correctamente",
    command_failed: "Error al enviar el comando",
    devices_title: "Dispositivos CDAP",
    devices_subtitle:
      "Dispositivos conectados mediante el protocolo de aplicación de dispositivo personalizado",
    stat_connected: "Conectado",
    stat_port: "Puerto",
    search_devices: "Buscar dispositivos...",
    no_devices: "No hay dispositivos conectados",
    no_devices_desc:
      "Actualmente no hay dispositivos CDAP conectados. Los dispositivos aparecerán aquí cuando se conecten a la puerta de enlace.",
    gateway_disabled: "Puerta de enlace CDAP deshabilitada",
    gateway_disabled_desc:
      "Habilita la puerta de enlace CDAP estableciendo CDAP_ENABLED=true en la configuración del servidor.",
    gateway_active: "Activa",
    toggle_enable: "Habilitar CDAP",
    toggle_disable: "Deshabilitar CDAP",
    enabled_restart:
      "CDAP habilitado. Se requiere reinicio del servidor para aplicar los cambios.",
    disabled_restart:
      "CDAP deshabilitado. Se requiere reinicio del servidor para aplicar los cambios.",
    widgets: "widgets",
    type_all: "Todos",
    type_iot: "IoT",
    type_scada: "SCADA",
    type_os_agent: "Agente OS",
    type_network: "Red",
    type_camera: "Cámara",
    type_custom: "Personalizado",
    active_alerts: "Alertas activas",
    alert_fired: "Alerta activada",
    alert_cleared: "Alerta resuelta",
    no_alerts: "No hay alertas activas",
    connect_terminal: "Conectar terminal",
    table_search: "Buscar...",
    just_now: "Ahora mismo",
    terminal_connecting: "Conectando al dispositivo...",
    terminal_disconnected: "Desconectado",
    terminal_error: "Error de conexión al terminal",
    linked_devices: "Dispositivos vinculados",
    link_device: "Vincular dispositivo",
    unlink_device: "Desvincular",
    no_linked_devices: "No hay dispositivos vinculados",
    unlink_confirm:
      "¿Estás seguro de que quieres desvincular este dispositivo?",
    link_prompt:
      "Ingresa el ID del par para vincularlo a este dispositivo:"
  },

  tutorial: {
    cdap_devices_title: "Dispositivos CDAP",
    cdap_devices_text:
      "Ver todos los dispositivos CDAP conectados — sensores IoT, PLCs, puentes y agentes personalizados. Los indicadores verdes muestran conexiones en vivo.",
    cdap_widgets_title: "Panel de widgets",
    cdap_widgets_text:
      "Los widgets muestran datos en tiempo real de los dispositivos. Medidores, interruptores, LEDs, gráficos — cada tipo de widget visualiza un tipo de dato diferente.",
    cdap_commands_title: "Enviar comandos",
    cdap_commands_text:
      "Interactúa con los dispositivos enviando comandos. Algunos comandos requieren confirmación. El registro de comandos guarda el historial de todos los comandos enviados.",
    cdap_terminal_title: "Terminal del dispositivo",
    cdap_terminal_text:
      "Abre una sesión de terminal hacia los agentes CDAP para diagnósticos avanzados o configuración manual. Escribe los comandos directamente.",
    cdap_complete_title: "¡Resumen de CDAP completado!",
    cdap_complete_text:
      "Explora los widgets de dispositivos, envía comandos y usa el terminal o el explorador de archivos para una gestión más profunda. Los agentes CDAP reportan métricas automáticamente."
  }
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
module.exports = { de, fr, es };
