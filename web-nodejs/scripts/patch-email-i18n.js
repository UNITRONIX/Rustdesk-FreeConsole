'use strict';

const fs = require('fs');
const path = require('path');

const langDir = path.join(__dirname, '..', 'lang');

const translations = {
    en: {
        settings_tab_email: 'Email',
        settings_email: {
            title: 'Email notifications',
            desc: 'Configure SMTP delivery for operational notifications and system alert emails.',
            smtp_host: 'SMTP host',
            smtp_port: 'Port',
            smtp_secure: 'Use TLS/SSL',
            smtp_user: 'Username',
            smtp_pass: 'Password',
            smtp_from: 'From address',
            alert_email: 'Alert email',
            alert_email_hint: 'Fallback address when no operator email is available, and for system warnings.',
            smtp_test: 'Test connection',
            smtp_save: 'Save configuration',
            smtp_saved: 'Email settings saved',
            smtp_test_success: 'Connection successful',
            smtp_test_failed: 'Connection failed',
        },
        users_email: 'Email',
        users_email_placeholder: 'operator@example.com',
        users_email_hint: 'Used for help request notifications when the user is assigned to device folders or groups.',
        commercialization_notifications: {
            title: 'Email notifications',
            desc: 'Notify operators by email when devices in their folders or groups submit help requests.',
            smtp_status: 'SMTP status',
            smtp_configured: 'SMTP is configured',
            smtp_missing: 'SMTP is not configured — set it up in Settings → Email',
            smtp_link: 'Open SMTP settings',
            help_requests_enabled: 'Send email for new help requests',
            notify_assigned_operators: 'Notify operators assigned to the device folder or group',
            fallback_alert_email: 'Use alert email when no operator address is available',
            include_folder_in_subject: 'Include folder name in the email subject',
            save: 'Save notification settings',
            saved: 'Notification settings saved',
        },
    },
    pl: {
        settings_tab_email: 'E-mail',
        settings_email: {
            title: 'Powiadomienia e-mail',
            desc: 'Skonfiguruj SMTP dla powiadomień operacyjnych i adresu ostrzegawczego.',
            smtp_host: 'Host SMTP',
            smtp_port: 'Port',
            smtp_secure: 'Użyj TLS/SSL',
            smtp_user: 'Nazwa użytkownika',
            smtp_pass: 'Hasło',
            smtp_from: 'Adres nadawcy',
            alert_email: 'Adres ostrzegawczy',
            alert_email_hint: 'Adres zapasowy, gdy operator nie ma e-maila, oraz dla ostrzeżeń systemowych.',
            smtp_test: 'Test połączenia',
            smtp_save: 'Zapisz konfigurację',
            smtp_saved: 'Ustawienia e-mail zapisane',
            smtp_test_success: 'Połączenie udane',
            smtp_test_failed: 'Połączenie nieudane',
        },
        users_email: 'E-mail',
        users_email_placeholder: 'operator@example.com',
        users_email_hint: 'Używany do powiadomień o prośbach o pomoc, gdy użytkownik jest przypisany do folderów lub grup urządzeń.',
        commercialization_notifications: {
            title: 'Powiadomienia e-mail',
            desc: 'Powiadamiaj operatorów e-mailem, gdy urządzenia z ich folderów lub grup wysyłają prośby o pomoc.',
            smtp_status: 'Status SMTP',
            smtp_configured: 'SMTP jest skonfigurowany',
            smtp_missing: 'SMTP nie jest skonfigurowany — ustaw w Ustawienia → E-mail',
            smtp_link: 'Otwórz ustawienia SMTP',
            help_requests_enabled: 'Wysyłaj e-mail przy nowych prośbach o pomoc',
            notify_assigned_operators: 'Powiadamiaj operatorów przypisanych do folderu lub grupy urządzenia',
            fallback_alert_email: 'Użyj adresu ostrzegawczego, gdy brak e-maila operatora',
            include_folder_in_subject: 'Dołącz nazwę folderu w temacie wiadomości',
            save: 'Zapisz ustawienia powiadomień',
            saved: 'Ustawienia powiadomień zapisane',
        },
    },
    de: {
        settings_tab_email: 'E-Mail',
        settings_email: {
            title: 'E-Mail-Benachrichtigungen',
            desc: 'SMTP für Betriebsbenachrichtigungen und System-Warn-E-Mails konfigurieren.',
            smtp_host: 'SMTP-Host',
            smtp_port: 'Port',
            smtp_secure: 'TLS/SSL verwenden',
            smtp_user: 'Benutzername',
            smtp_pass: 'Passwort',
            smtp_from: 'Absenderadresse',
            alert_email: 'Warn-E-Mail',
            alert_email_hint: 'Fallback-Adresse, wenn kein Operator-E-Mail vorhanden ist, und für Systemwarnungen.',
            smtp_test: 'Verbindung testen',
            smtp_save: 'Konfiguration speichern',
            smtp_saved: 'E-Mail-Einstellungen gespeichert',
            smtp_test_success: 'Verbindung erfolgreich',
            smtp_test_failed: 'Verbindung fehlgeschlagen',
        },
        users_email: 'E-Mail',
        users_email_placeholder: 'operator@example.com',
        users_email_hint: 'Für Hilfeanfragen-Benachrichtigungen, wenn der Benutzer Geräteordnern oder -gruppen zugewiesen ist.',
        commercialization_notifications: {
            title: 'E-Mail-Benachrichtigungen',
            desc: 'Operatoren per E-Mail benachrichtigen, wenn Geräte in ihren Ordnern oder Gruppen Hilfe anfordern.',
            smtp_status: 'SMTP-Status',
            smtp_configured: 'SMTP ist konfiguriert',
            smtp_missing: 'SMTP ist nicht konfiguriert — einrichten unter Einstellungen → E-Mail',
            smtp_link: 'SMTP-Einstellungen öffnen',
            help_requests_enabled: 'E-Mail bei neuen Hilfeanfragen senden',
            notify_assigned_operators: 'Zugewiesene Operatoren des Geräteordners oder der Gruppe benachrichtigen',
            fallback_alert_email: 'Warn-E-Mail verwenden, wenn keine Operator-Adresse verfügbar ist',
            include_folder_in_subject: 'Ordnernamen in den E-Mail-Betreff aufnehmen',
            save: 'Benachrichtigungseinstellungen speichern',
            saved: 'Benachrichtigungseinstellungen gespeichert',
        },
    },
    fr: {
        settings_tab_email: 'E-mail',
        settings_email: {
            title: 'Notifications e-mail',
            desc: 'Configurez SMTP pour les notifications opérationnelles et les e-mails d\'alerte système.',
            smtp_host: 'Hôte SMTP',
            smtp_port: 'Port',
            smtp_secure: 'Utiliser TLS/SSL',
            smtp_user: 'Nom d\'utilisateur',
            smtp_pass: 'Mot de passe',
            smtp_from: 'Adresse d\'expéditeur',
            alert_email: 'E-mail d\'alerte',
            alert_email_hint: 'Adresse de secours lorsqu\'aucun e-mail opérateur n\'est disponible, et pour les avertissements système.',
            smtp_test: 'Tester la connexion',
            smtp_save: 'Enregistrer la configuration',
            smtp_saved: 'Paramètres e-mail enregistrés',
            smtp_test_success: 'Connexion réussie',
            smtp_test_failed: 'Échec de la connexion',
        },
        users_email: 'E-mail',
        users_email_placeholder: 'operator@example.com',
        users_email_hint: 'Utilisé pour les notifications de demande d\'aide lorsque l\'utilisateur est assigné à des dossiers ou groupes d\'appareils.',
        commercialization_notifications: {
            title: 'Notifications e-mail',
            desc: 'Notifier les opérateurs par e-mail lorsque des appareils de leurs dossiers ou groupes demandent de l\'aide.',
            smtp_status: 'État SMTP',
            smtp_configured: 'SMTP est configuré',
            smtp_missing: 'SMTP n\'est pas configuré — configurez-le dans Paramètres → E-mail',
            smtp_link: 'Ouvrir les paramètres SMTP',
            help_requests_enabled: 'Envoyer un e-mail pour les nouvelles demandes d\'aide',
            notify_assigned_operators: 'Notifier les opérateurs assignés au dossier ou groupe de l\'appareil',
            fallback_alert_email: 'Utiliser l\'e-mail d\'alerte si aucune adresse opérateur n\'est disponible',
            include_folder_in_subject: 'Inclure le nom du dossier dans l\'objet de l\'e-mail',
            save: 'Enregistrer les paramètres de notification',
            saved: 'Paramètres de notification enregistrés',
        },
    },
    es: {
        settings_tab_email: 'Correo',
        settings_email: {
            title: 'Notificaciones por correo',
            desc: 'Configure SMTP para notificaciones operativas y correos de alerta del sistema.',
            smtp_host: 'Servidor SMTP',
            smtp_port: 'Puerto',
            smtp_secure: 'Usar TLS/SSL',
            smtp_user: 'Usuario',
            smtp_pass: 'Contraseña',
            smtp_from: 'Dirección de remitente',
            alert_email: 'Correo de alerta',
            alert_email_hint: 'Dirección de respaldo cuando no hay correo del operador, y para avisos del sistema.',
            smtp_test: 'Probar conexión',
            smtp_save: 'Guardar configuración',
            smtp_saved: 'Ajustes de correo guardados',
            smtp_test_success: 'Conexión correcta',
            smtp_test_failed: 'Error de conexión',
        },
        users_email: 'Correo',
        users_email_placeholder: 'operator@example.com',
        users_email_hint: 'Se usa para notificaciones de solicitudes de ayuda cuando el usuario está asignado a carpetas o grupos de dispositivos.',
        commercialization_notifications: {
            title: 'Notificaciones por correo',
            desc: 'Notifique a los operadores por correo cuando dispositivos de sus carpetas o grupos soliciten ayuda.',
            smtp_status: 'Estado SMTP',
            smtp_configured: 'SMTP configurado',
            smtp_missing: 'SMTP no configurado — configúrelo en Ajustes → Correo',
            smtp_link: 'Abrir ajustes SMTP',
            help_requests_enabled: 'Enviar correo para nuevas solicitudes de ayuda',
            notify_assigned_operators: 'Notificar a operadores asignados a la carpeta o grupo del dispositivo',
            fallback_alert_email: 'Usar correo de alerta si no hay dirección del operador',
            include_folder_in_subject: 'Incluir nombre de carpeta en el asunto del correo',
            save: 'Guardar ajustes de notificación',
            saved: 'Ajustes de notificación guardados',
        },
    },
};

const fallbackLocales = ['it', 'cs', 'da', 'fi', 'hu', 'nb', 'nl', 'pt', 'ro', 'sv', 'tr', 'uk', 'vi', 'ar', 'hi', 'id', 'ja', 'ko', 'th', 'zh', 'zh-TW'];
for (const code of fallbackLocales) {
    translations[code] = { ...translations.en };
}

function patchFile(code) {
    const filePath = path.join(langDir, `${code}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const t = translations[code] || translations.en;

    data.settings = data.settings || {};
    data.settings.tab_email = t.settings_tab_email;
    data.settings.email = { ...(data.settings.email || {}), ...t.settings_email };

    data.users = data.users || {};
    data.users.email = t.users_email;
    data.users.email_placeholder = t.users_email_placeholder;
    data.users.email_hint = t.users_email_hint;

    data.commercialization = data.commercialization || {};
    data.commercialization.notifications = { ...(data.commercialization.notifications || {}), ...t.commercialization_notifications };

    if (data.automation && data.automation.subtitle && data.automation.subtitle.includes('SMTP')) {
        data.automation.subtitle = data.automation.subtitle
            .replace(/,?\s*and SMTP configuration/i, '')
            .replace(/,\s*i konfiguracj[aą] SMTP/i, '')
            .trim();
    }

    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`Patched ${code}.json`);
}

for (const file of fs.readdirSync(langDir).filter(f => f.endsWith('.json'))) {
    patchFile(file.replace('.json', ''));
}
