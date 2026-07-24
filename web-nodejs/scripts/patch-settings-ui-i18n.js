#!/usr/bin/env node
'use strict';

/**
 * One-shot patch: add settings.ui.* and settings.confirm.* to all locale files.
 * Run: node scripts/patch-settings-ui-i18n.js
 */

const fs = require('fs');
const path = require('path');

const langDir = path.join(__dirname, '..', 'lang');
const enPath = path.join(langDir, 'en.json');
const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

const ui = en.settings.ui;
const confirm = en.settings.confirm;

const translations = {
  pl: {
    ui: {
      search_placeholder: 'Szukaj w ustawieniach…',
      search_results: '{count} pasujących sekcji',
      auth_sub_enrollment: 'Rejestracja',
      auth_sub_ldap: 'LDAP / AD',
      auth_sub_oidc: 'OIDC / SSO',
      branding_rdclient: 'RdClient',
      connection_p2p_hint: 'Najpierw połączenie P2P; przełączenie na relay, gdy P2P nie działa.',
      connection_relay_hint: 'Cały ruch klientów przez serwer relay.'
    },
    confirm: {
      connection_mode_title: 'Zapisać strategię połączenia?',
      connection_mode: 'Zastosować nową strategię połączenia dla klientów RustDesk?',
      connection_restart_title: 'Zapisać i zrestartować serwer?',
      connection_restart: 'Zapisać ustawienia połączenia i zrestartować serwer BetterDesk? Aktywne sesje mogą się na chwilę rozłączyć.',
      enrollment_mode_title: 'Zmienić tryb rejestracji?',
      enrollment_mode: 'Przełączyć rejestrację na „{mode}”? Wpływa na sposób rejestracji nowych klientów RustDesk.',
      ldap_enable_title: 'Włączyć LDAP?',
      ldap_enable: 'Włączyć logowanie LDAP / Active Directory? Użytkownicy konsoli mogą uwierzytelniać się w katalogu.',
      ldap_save_title: 'Zapisać ustawienia LDAP?',
      ldap_save: 'Zapisać konfigurację LDAP? Błędne ustawienia mogą zablokować logowanie przez katalog.',
      oidc_enable_title: 'Włączyć SSO?',
      oidc_enable: 'Włączyć logowanie OIDC / SSO? Użytkownicy mogą logować się przez dostawcę tożsamości.',
      oidc_save_title: 'Zapisać ustawienia SSO?',
      oidc_save: 'Zapisać konfigurację OIDC / SSO? Błędne ustawienia mogą zablokować logowanie SSO.',
      smtp_save_title: 'Zapisać ustawienia SMTP?',
      smtp_save: 'Zapisać konfigurację SMTP? Alerty i powiadomienia będą wysyłane przez ten serwer poczty.',
      backup_restore_title: 'Przywrócić kopię zapasową?',
      backup_restore: 'Przywrócić z tego pliku kopii? Wybrane dane zostaną zastąpione.',
      tutorials_reset_title: 'Resetować samouczki?',
      tutorials_reset: 'Resetować postęp wszystkich samouczków? Wskazówki pojawią się ponownie na każdej stronie.',
      advanced_save_title: 'Zapisać plik konfiguracji?',
      advanced_restart_after_title: 'Zrestartować usługę?',
      advanced_restart_title: 'Zrestartować usługę?',
      advanced_discard_title: 'Odrzucić zmiany?'
    }
  },
  de: {
    ui: {
      search_placeholder: 'Einstellungen durchsuchen…',
      search_results: '{count} passende Bereiche',
      auth_sub_enrollment: 'Registrierung',
      auth_sub_ldap: 'LDAP / AD',
      auth_sub_oidc: 'OIDC / SSO',
      branding_rdclient: 'RdClient',
      connection_p2p_hint: 'Zuerst direkte P2P-Verbindung; Relay bei P2P-Fehler.',
      connection_relay_hint: 'Gesamten Client-Traffic über den Relay-Server leiten.'
    },
    confirm: {
      connection_mode_title: 'Verbindungsstrategie speichern?',
      connection_mode: 'Neue Verbindungsstrategie für RustDesk-Clients anwenden?',
      connection_restart_title: 'Speichern und Server neu starten?',
      connection_restart: 'Verbindungseinstellungen speichern und BetterDesk-Server neu starten? Aktive Sitzungen können kurz getrennt werden.',
      enrollment_mode_title: 'Registrierungsmodus ändern?',
      enrollment_mode: 'Registrierung auf „{mode}“ umschalten? Betrifft die Registrierung neuer RustDesk-Clients.',
      ldap_enable_title: 'LDAP aktivieren?',
      ldap_enable: 'LDAP-/Active-Directory-Anmeldung aktivieren?',
      ldap_save_title: 'LDAP-Einstellungen speichern?',
      ldap_save: 'LDAP-Konfiguration speichern? Falsche Einstellungen können die Anmeldung blockieren.',
      oidc_enable_title: 'SSO aktivieren?',
      oidc_enable: 'OIDC-/SSO-Anmeldung aktivieren?',
      oidc_save_title: 'SSO-Einstellungen speichern?',
      oidc_save: 'OIDC-/SSO-Konfiguration speichern?',
      smtp_save_title: 'SMTP-Einstellungen speichern?',
      smtp_save: 'SMTP-Konfiguration speichern? Warnungen nutzen diesen Mailserver.',
      backup_restore_title: 'Backup wiederherstellen?',
      backup_restore: 'Aus dieser Backup-Datei wiederherstellen? Ausgewählte Daten werden überschrieben.',
      tutorials_reset_title: 'Tutorials zurücksetzen?',
      tutorials_reset: 'Gesamten Tutorial-Fortschritt zurücksetzen?',
      advanced_save_title: 'Konfigurationsdatei speichern?',
      advanced_restart_after_title: 'Dienst neu starten?',
      advanced_restart_title: 'Dienst neu starten?',
      advanced_discard_title: 'Änderungen verwerfen?'
    }
  },
  fr: {
    ui: {
      search_placeholder: 'Rechercher dans les paramètres…',
      search_results: '{count} sections correspondantes',
      auth_sub_enrollment: 'Enregistrement',
      auth_sub_ldap: 'LDAP / AD',
      auth_sub_oidc: 'OIDC / SSO',
      branding_rdclient: 'RdClient',
      connection_p2p_hint: 'Connexion P2P directe en priorité ; relais si P2P échoue.',
      connection_relay_hint: 'Tout le trafic client via le serveur relais.'
    },
    confirm: {
      connection_mode_title: 'Enregistrer la stratégie de connexion ?',
      connection_mode: 'Appliquer la nouvelle stratégie pour les clients RustDesk ?',
      connection_restart_title: 'Enregistrer et redémarrer le serveur ?',
      connection_restart: 'Enregistrer et redémarrer le serveur BetterDesk ? Les sessions actives peuvent être coupées brièvement.',
      enrollment_mode_title: 'Changer le mode d’enregistrement ?',
      enrollment_mode: 'Passer l’enregistrement à « {mode} » ? Cela affecte l’inscription des nouveaux clients RustDesk.',
      ldap_enable_title: 'Activer LDAP ?',
      ldap_enable: 'Activer la connexion LDAP / Active Directory ?',
      ldap_save_title: 'Enregistrer les paramètres LDAP ?',
      ldap_save: 'Enregistrer la configuration LDAP ? Des erreurs peuvent bloquer la connexion.',
      oidc_enable_title: 'Activer le SSO ?',
      oidc_enable: 'Activer la connexion OIDC / SSO ?',
      oidc_save_title: 'Enregistrer les paramètres SSO ?',
      oidc_save: 'Enregistrer la configuration OIDC / SSO ?',
      smtp_save_title: 'Enregistrer les paramètres SMTP ?',
      smtp_save: 'Enregistrer la configuration SMTP ? Les alertes utiliseront ce serveur mail.',
      backup_restore_title: 'Restaurer la sauvegarde ?',
      backup_restore: 'Restaurer depuis ce fichier ? Les données sélectionnées seront remplacées.',
      tutorials_reset_title: 'Réinitialiser les tutoriels ?',
      tutorials_reset: 'Réinitialiser la progression de tous les tutoriels ?',
      advanced_save_title: 'Enregistrer le fichier de configuration ?',
      advanced_restart_after_title: 'Redémarrer le service ?',
      advanced_restart_title: 'Redémarrer le service ?',
      advanced_discard_title: 'Abandonner les modifications ?'
    }
  }
};

const files = fs.readdirSync(langDir).filter((f) => f.endsWith('.json') && f !== 'en.json');

for (const file of files) {
  const locale = file.replace('.json', '');
  const filePath = path.join(langDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data.settings) continue;

  const pack = translations[locale] || { ui: ui, confirm: confirm };
  data.settings.ui = { ...ui, ...(pack.ui || {}) };
  data.settings.confirm = { ...confirm, ...(pack.confirm || {}) };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('Patched', file);
}

console.log('Done.');
