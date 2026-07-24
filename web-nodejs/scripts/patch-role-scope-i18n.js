#!/usr/bin/env node
/**
 * One-shot i18n patch for role/scope UX (#227). Run: node web-nodejs/scripts/patch-role-scope-i18n.js
 */
const fs = require('fs');
const path = require('path');

const langDir = path.join(__dirname, '..', 'lang');
const locales = fs.readdirSync(langDir).filter(f => f.endsWith('.json'));

const patches = {
    pl: {
        users: {
            role_operator: 'Operator zdalny',
            role_pro: 'Licencja Pro (tylko API klienta)',
            role_hint: 'Rola serwerowa. Operatorzy zdalni łączą się zdalnie i mogą zmieniać własne hasło. Viewer ma tylko odczyt (bez Web Client). Licencja Pro aktywuje RustDesk Pro przez API klienta — bez dostępu do panelu. Role organizacji konfigurujesz osobno.',
            scope_hint: 'Ogranicz widoczność urządzeń: przypisz grupy użytkowników, foldery i/lub urządzenia bezpośrednio. Bez ograniczeń operatorzy i viewerzy widzą wszystkie urządzenia (chyba że włączono tryb restricted w Ustawieniach).',
            role_desc_viewer: 'Tylko odczyt w panelu: lista urządzeń, audyt, metryki. Bez Web Remote Desktop.',
            role_desc_operator: 'Może łączyć się przez Web Client i klienta RustDesk, edytować urządzenia i zmieniać własne hasło w Ustawieniach.',
            role_desc_pro: 'Tylko API klienta RustDesk — aktywacja licencji Pro. Brak logowania do panelu.',
            role_desc_admin: 'Pełny dostęp (legacy alias Super Admin).',
            role_desc_super_admin: 'Pełny dostęp do serwera i panelu, w tym konfiguracja użytkowników i serwera.',
            role_desc_server_admin: 'Infrastruktura serwera, klucze, podgląd użytkowników. Bez łączenia z urządzeniami.',
            role_desc_global_admin: 'Zarządzanie użytkownikami, organizacjami i urządzeniami. Bez konfiguracji serwera.',
            user_folders: 'Dostęp do folderów',
            user_folders_hint: 'Urządzenia w wybranych folderach są widoczne, gdy skonfigurowano ACL folderu.',
            user_direct_devices: 'Urządzenia bezpośrednie',
            user_direct_devices_hint: 'Przyznaj dostęp do konkretnych urządzeń niezależnie od folderu lub grupy.',
            user_direct_devices_placeholder: 'ID urządzeń oddzielone przecinkami',
            effective_scope_count: '{count} widocznych urządzeń',
            loading_folders: 'Ładowanie folderów...',
            no_folders: 'Brak folderów',
            pro_strategy_label: 'Strategia RustDesk Pro',
            pro_strategy_hint: 'Opcjonalna strategia kontroli dostępu dla funkcji Pro w kliencie (osobno od roli panelu).',
            pro_strategy_none: 'Brak',
            column_scope: 'Zakres',
            tip_operator_role: 'Użyj Operatora zdalnego dla użytkowników z Web Client i samodzielną zmianą hasła',
            tip_viewer_role: 'Użyj Viewera do monitorowania tylko do odczytu; Operatora zdalnego do łączenia'
        },
        settings: {
            device_scope_title: 'Domyślna widoczność urządzeń',
            device_scope_desc: 'Określa, co widzą użytkownicy bez roli admin, gdy brak grantów folderów/grup/urządzeń.',
            device_scope_open: 'Otwarty (legacy) — pokaż wszystkie urządzenia do skonfigurowania ACL',
            device_scope_restricted: 'Restricted — pokaż tylko jawnie przyznane urządzenia',
            device_scope_save: 'Zapisz domyślną widoczność',
            device_scope_saved: 'Zapisano domyślną widoczność urządzeń',
            device_scope_invalid: 'Nieprawidłowy tryb widoczności',
            device_scope_restricted_warning: 'Tryb restricted jest aktywny. Upewnij się, że użytkownicy mają granty folderów, grup lub urządzeń — inaczej zobaczą pustą listę.'
        }
    }
};

const enFallback = JSON.parse(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8'));

for (const file of locales) {
    const locale = file.replace('.json', '');
    const filePath = path.join(langDir, file);
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);

    const userKeys = Object.keys(enFallback.users || {}).filter(k =>
        ['role_operator', 'role_pro', 'role_hint', 'scope_hint', 'role_desc_', 'user_folders', 'user_direct', 'effective_scope', 'loading_folders', 'no_folders', 'pro_strategy', 'column_scope', 'tip_operator', 'tip_viewer'].some(p => k.startsWith(p.replace('_', '')) || k.includes(p.split('_')[0]))
    );

    const keysToCopy = [
        'role_operator', 'role_pro', 'role_hint', 'scope_hint',
        'role_desc_viewer', 'role_desc_operator', 'role_desc_pro', 'role_desc_admin',
        'role_desc_super_admin', 'role_desc_server_admin', 'role_desc_global_admin',
        'user_folders', 'user_folders_hint', 'user_direct_devices', 'user_direct_devices_hint',
        'user_direct_devices_placeholder', 'effective_scope_count', 'loading_folders', 'no_folders',
        'pro_strategy_label', 'pro_strategy_hint', 'pro_strategy_none', 'column_scope',
        'tip_operator_role', 'tip_viewer_role'
    ];

    const settingKeys = [
        'device_scope_title', 'device_scope_desc', 'device_scope_open', 'device_scope_restricted',
        'device_scope_save', 'device_scope_saved', 'device_scope_invalid', 'device_scope_restricted_warning'
    ];

    for (const key of keysToCopy) {
        if (patches[locale]?.users?.[key]) {
            data.users[key] = patches[locale].users[key];
        } else if (enFallback.users[key]) {
            data.users[key] = enFallback.users[key];
        }
    }

    for (const key of settingKeys) {
        if (patches[locale]?.settings?.[key]) {
            data.settings[key] = patches[locale].settings[key];
        } else if (enFallback.settings[key]) {
            data.settings[key] = enFallback.settings[key];
        }
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log('Patched', file);
}
