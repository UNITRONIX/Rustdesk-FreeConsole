#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'lang');

/** New keys per locale — English source + translations for all 26 locales. */
const PATCHES = {
    en: {
        remote: {
            remember_peer_password: 'Remember device password on this device',
            save_peer_password: 'Save password',
        },
        remote_dashboard: {
            open_settings: 'Settings',
        },
        rdclient_settings: {
            title: 'RdClient Settings',
            open: 'Settings',
            server_url: 'Panel URL',
            tls_strict: 'Strict TLS',
            sign_out: 'Sign out',
            reset_client: 'Reset client',
            discovery_refresh: 'Refresh',
            discovery_empty: 'No servers found on the local network',
        },
        generator: {
            rdclient_tab: 'RdClient desktop',
            rdclient_new_bundle: 'New RdClient bundle',
            rdclient_subtitle: 'Build branded RdClient desktop installers with embedded panel URL',
            rdclient_server_url_hint: 'Public URL where operators reach the BetterDesk console (/remote dashboard).',
        },
    },
    pl: {
        remote: { remember_peer_password: 'Zapamiętaj hasło urządzenia na tym komputerze', save_peer_password: 'Zapisz hasło' },
        remote_dashboard: { open_settings: 'Ustawienia' },
        rdclient_settings: { title: 'Ustawienia RdClient', open: 'Ustawienia', server_url: 'URL panelu', tls_strict: 'Ścisłe TLS', sign_out: 'Wyloguj', reset_client: 'Resetuj klienta', discovery_refresh: 'Odśwież', discovery_empty: 'Nie znaleziono serwerów w sieci lokalnej' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Nowy pakiet RdClient', rdclient_subtitle: 'Buduj instalatory RdClient z wbudowanym adresem panelu', rdclient_server_url_hint: 'Publiczny URL panelu BetterDesk (dashboard /remote).' },
    },
    de: {
        remote: { remember_peer_password: 'Gerätepasswort auf diesem Gerät merken', save_peer_password: 'Passwort speichern' },
        remote_dashboard: { open_settings: 'Einstellungen' },
        rdclient_settings: { title: 'RdClient-Einstellungen', open: 'Einstellungen', server_url: 'Panel-URL', tls_strict: 'Striktes TLS', sign_out: 'Abmelden', reset_client: 'Client zurücksetzen', discovery_refresh: 'Aktualisieren', discovery_empty: 'Keine Server im lokalen Netzwerk gefunden' },
        generator: { rdclient_tab: 'RdClient Desktop', rdclient_new_bundle: 'Neues RdClient-Paket', rdclient_subtitle: 'Branded RdClient-Installer mit eingebetteter Panel-URL erstellen', rdclient_server_url_hint: 'Öffentliche URL der BetterDesk-Konsole (/remote).' },
    },
    fr: {
        remote: { remember_peer_password: 'Mémoriser le mot de passe de l’appareil sur cet ordinateur', save_peer_password: 'Enregistrer le mot de passe' },
        remote_dashboard: { open_settings: 'Paramètres' },
        rdclient_settings: { title: 'Paramètres RdClient', open: 'Paramètres', server_url: 'URL du panel', tls_strict: 'TLS strict', sign_out: 'Se déconnecter', reset_client: 'Réinitialiser le client', discovery_refresh: 'Actualiser', discovery_empty: 'Aucun serveur trouvé sur le réseau local' },
        generator: { rdclient_tab: 'RdClient bureau', rdclient_new_bundle: 'Nouveau bundle RdClient', rdclient_subtitle: 'Créer des installateurs RdClient avec URL du panel intégrée', rdclient_server_url_hint: 'URL publique de la console BetterDesk (/remote).' },
    },
    es: {
        remote: { remember_peer_password: 'Recordar contraseña del dispositivo en este equipo', save_peer_password: 'Guardar contraseña' },
        remote_dashboard: { open_settings: 'Ajustes' },
        rdclient_settings: { title: 'Ajustes de RdClient', open: 'Ajustes', server_url: 'URL del panel', tls_strict: 'TLS estricto', sign_out: 'Cerrar sesión', reset_client: 'Restablecer cliente', discovery_refresh: 'Actualizar', discovery_empty: 'No se encontraron servidores en la red local' },
        generator: { rdclient_tab: 'RdClient escritorio', rdclient_new_bundle: 'Nuevo paquete RdClient', rdclient_subtitle: 'Generar instaladores RdClient con URL del panel integrada', rdclient_server_url_hint: 'URL pública de la consola BetterDesk (/remote).' },
    },
    it: {
        remote: { remember_peer_password: 'Ricorda password dispositivo su questo computer', save_peer_password: 'Salva password' },
        remote_dashboard: { open_settings: 'Impostazioni' },
        rdclient_settings: { title: 'Impostazioni RdClient', open: 'Impostazioni', server_url: 'URL pannello', tls_strict: 'TLS rigoroso', sign_out: 'Esci', reset_client: 'Reimposta client', discovery_refresh: 'Aggiorna', discovery_empty: 'Nessun server trovato nella rete locale' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Nuovo bundle RdClient', rdclient_subtitle: 'Crea installer RdClient con URL pannello incorporato', rdclient_server_url_hint: 'URL pubblica della console BetterDesk (/remote).' },
    },
    pt: {
        remote: { remember_peer_password: 'Lembrar senha do dispositivo neste computador', save_peer_password: 'Guardar senha' },
        remote_dashboard: { open_settings: 'Definições' },
        rdclient_settings: { title: 'Definições RdClient', open: 'Definições', server_url: 'URL do painel', tls_strict: 'TLS estrito', sign_out: 'Terminar sessão', reset_client: 'Repor cliente', discovery_refresh: 'Atualizar', discovery_empty: 'Nenhum servidor encontrado na rede local' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Novo pacote RdClient', rdclient_subtitle: 'Criar instaladores RdClient com URL do painel incorporado', rdclient_server_url_hint: 'URL pública da consola BetterDesk (/remote).' },
    },
    nl: {
        remote: { remember_peer_password: 'Apparaatwachtwoord onthouden op dit apparaat', save_peer_password: 'Wachtwoord opslaan' },
        remote_dashboard: { open_settings: 'Instellingen' },
        rdclient_settings: { title: 'RdClient-instellingen', open: 'Instellingen', server_url: 'Paneel-URL', tls_strict: 'Strikte TLS', sign_out: 'Afmelden', reset_client: 'Client resetten', discovery_refresh: 'Vernieuwen', discovery_empty: 'Geen servers gevonden op het lokale netwerk' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Nieuw RdClient-pakket', rdclient_subtitle: 'RdClient-installers bouwen met ingebedde paneel-URL', rdclient_server_url_hint: 'Publieke URL van het BetterDesk-paneel (/remote).' },
    },
    cs: {
        remote: { remember_peer_password: 'Zapamatovat heslo zařízení na tomto počítači', save_peer_password: 'Uložit heslo' },
        remote_dashboard: { open_settings: 'Nastavení' },
        rdclient_settings: { title: 'Nastavení RdClient', open: 'Nastavení', server_url: 'URL panelu', tls_strict: 'Přísné TLS', sign_out: 'Odhlásit', reset_client: 'Resetovat klienta', discovery_refresh: 'Obnovit', discovery_empty: 'V místní síti nebyly nalezeny žádné servery' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Nový balíček RdClient', rdclient_subtitle: 'Sestavit instalátory RdClient s vloženou URL panelu', rdclient_server_url_hint: 'Veřejná URL konzole BetterDesk (/remote).' },
    },
    da: {
        remote: { remember_peer_password: 'Husk enhedsadgangskode på denne computer', save_peer_password: 'Gem adgangskode' },
        remote_dashboard: { open_settings: 'Indstillinger' },
        rdclient_settings: { title: 'RdClient-indstillinger', open: 'Indstillinger', server_url: 'Panel-URL', tls_strict: 'Streng TLS', sign_out: 'Log ud', reset_client: 'Nulstil klient', discovery_refresh: 'Opdater', discovery_empty: 'Ingen servere fundet på det lokale netværk' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Ny RdClient-pakke', rdclient_subtitle: 'Byg RdClient-installere med indlejret panel-URL', rdclient_server_url_hint: 'Offentlig URL til BetterDesk-konsollen (/remote).' },
    },
    fi: {
        remote: { remember_peer_password: 'Muista laitteen salasana tällä tietokoneella', save_peer_password: 'Tallenna salasana' },
        remote_dashboard: { open_settings: 'Asetukset' },
        rdclient_settings: { title: 'RdClient-asetukset', open: 'Asetukset', server_url: 'Paneelin URL', tls_strict: 'Tiukka TLS', sign_out: 'Kirjaudu ulos', reset_client: 'Nollaa asiakas', discovery_refresh: 'Päivitä', discovery_empty: 'Paikallisesta verkosta ei löytynyt palvelimia' },
        generator: { rdclient_tab: 'RdClient-työpöytä', rdclient_new_bundle: 'Uusi RdClient-paketti', rdclient_subtitle: 'Rakenna RdClient-asentajat upotetulla paneelin URL:llä', rdclient_server_url_hint: 'BetterDesk-konsolin julkinen URL (/remote).' },
    },
    nb: {
        remote: { remember_peer_password: 'Husk enhetspassord på denne datamaskinen', save_peer_password: 'Lagre passord' },
        remote_dashboard: { open_settings: 'Innstillinger' },
        rdclient_settings: { title: 'RdClient-innstillinger', open: 'Innstillinger', server_url: 'Panel-URL', tls_strict: 'Streng TLS', sign_out: 'Logg ut', reset_client: 'Tilbakestill klient', discovery_refresh: 'Oppdater', discovery_empty: 'Ingen servere funnet på det lokale nettverket' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Nytt RdClient-pakke', rdclient_subtitle: 'Bygg RdClient-installere med innebygd panel-URL', rdclient_server_url_hint: 'Offentlig URL til BetterDesk-konsollen (/remote).' },
    },
    sv: {
        remote: { remember_peer_password: 'Kom ihåg enhetslösenord på den här datorn', save_peer_password: 'Spara lösenord' },
        remote_dashboard: { open_settings: 'Inställningar' },
        rdclient_settings: { title: 'RdClient-inställningar', open: 'Inställningar', server_url: 'Panel-URL', tls_strict: 'Strikt TLS', sign_out: 'Logga ut', reset_client: 'Återställ klient', discovery_refresh: 'Uppdatera', discovery_empty: 'Inga servrar hittades i det lokala nätverket' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Nytt RdClient-paket', rdclient_subtitle: 'Bygg RdClient-installerare med inbäddad panel-URL', rdclient_server_url_hint: 'Offentlig URL till BetterDesk-konsolen (/remote).' },
    },
    ro: {
        remote: { remember_peer_password: 'Memorează parola dispozitivului pe acest computer', save_peer_password: 'Salvează parola' },
        remote_dashboard: { open_settings: 'Setări' },
        rdclient_settings: { title: 'Setări RdClient', open: 'Setări', server_url: 'URL panou', tls_strict: 'TLS strict', sign_out: 'Deconectare', reset_client: 'Resetează clientul', discovery_refresh: 'Reîmprospătează', discovery_empty: 'Nu s-au găsit servere în rețeaua locală' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Pachet RdClient nou', rdclient_subtitle: 'Construiește instalatoare RdClient cu URL panou integrat', rdclient_server_url_hint: 'URL public al consolei BetterDesk (/remote).' },
    },
    hu: {
        remote: { remember_peer_password: 'Eszköz jelszó megjegyzése ezen a gépen', save_peer_password: 'Jelszó mentése' },
        remote_dashboard: { open_settings: 'Beállítások' },
        rdclient_settings: { title: 'RdClient beállítások', open: 'Beállítások', server_url: 'Panel URL', tls_strict: 'Szigorú TLS', sign_out: 'Kijelentkezés', reset_client: 'Kliens visszaállítása', discovery_refresh: 'Frissítés', discovery_empty: 'Nem található szerver a helyi hálózaton' },
        generator: { rdclient_tab: 'RdClient asztali', rdclient_new_bundle: 'Új RdClient csomag', rdclient_subtitle: 'RdClient telepítők készítése beágyazott panel URL-lel', rdclient_server_url_hint: 'A BetterDesk konzol nyilvános URL-je (/remote).' },
    },
    uk: {
        remote: { remember_peer_password: 'Запам’ятати пароль пристрою на цьому комп’ютері', save_peer_password: 'Зберегти пароль' },
        remote_dashboard: { open_settings: 'Налаштування' },
        rdclient_settings: { title: 'Налаштування RdClient', open: 'Налаштування', server_url: 'URL панелі', tls_strict: 'Суворий TLS', sign_out: 'Вийти', reset_client: 'Скинути клієнт', discovery_refresh: 'Оновити', discovery_empty: 'Серверів у локальній мережі не знайдено' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Новий пакет RdClient', rdclient_subtitle: 'Збирати інсталятори RdClient із вбудованою URL панелі', rdclient_server_url_hint: 'Публічна URL консолі BetterDesk (/remote).' },
    },
    tr: {
        remote: { remember_peer_password: 'Cihaz parolasını bu bilgisayarda hatırla', save_peer_password: 'Parolayı kaydet' },
        remote_dashboard: { open_settings: 'Ayarlar' },
        rdclient_settings: { title: 'RdClient ayarları', open: 'Ayarlar', server_url: 'Panel URL', tls_strict: 'Katı TLS', sign_out: 'Oturumu kapat', reset_client: 'İstemciyi sıfırla', discovery_refresh: 'Yenile', discovery_empty: 'Yerel ağda sunucu bulunamadı' },
        generator: { rdclient_tab: 'RdClient masaüstü', rdclient_new_bundle: 'Yeni RdClient paketi', rdclient_subtitle: 'Gömülü panel URL’li RdClient yükleyicileri oluştur', rdclient_server_url_hint: 'BetterDesk konsolunun genel URL’si (/remote).' },
    },
    ar: {
        remote: { remember_peer_password: 'تذكر كلمة مرور الجهاز على هذا الحاسوب', save_peer_password: 'حفظ كلمة المرور' },
        remote_dashboard: { open_settings: 'الإعدادات' },
        rdclient_settings: { title: 'إعدادات RdClient', open: 'الإعدادات', server_url: 'رابط اللوحة', tls_strict: 'TLS صارم', sign_out: 'تسجيل الخروج', reset_client: 'إعادة ضبط العميل', discovery_refresh: 'تحديث', discovery_empty: 'لم يتم العثور على خوادم في الشبكة المحلية' },
        generator: { rdclient_tab: 'RdClient سطح المكتب', rdclient_new_bundle: 'حزمة RdClient جديدة', rdclient_subtitle: 'إنشاء مثبتات RdClient مع رابط اللوحة المضمن', rdclient_server_url_hint: 'الرابط العام لوحة BetterDesk (/remote).' },
    },
    hi: {
        remote: { remember_peer_password: 'इस डिवाइस पर डिवाइस पासवर्ड याद रखें', save_peer_password: 'पासवर्ड सहेजें' },
        remote_dashboard: { open_settings: 'सेटिंग्स' },
        rdclient_settings: { title: 'RdClient सेटिंग्स', open: 'सेटिंग्स', server_url: 'पैनल URL', tls_strict: 'सख्त TLS', sign_out: 'साइन आउट', reset_client: 'क्लाइंट रीसेट करें', discovery_refresh: 'रीफ़्रेश', discovery_empty: 'स्थानीय नेटवर्क पर कोई सर्वर नहीं मिला' },
        generator: { rdclient_tab: 'RdClient डेस्कटॉप', rdclient_new_bundle: 'नया RdClient बंडल', rdclient_subtitle: 'एम्बेडेड पैनल URL के साथ RdClient इंस्टॉलर बनाएं', rdclient_server_url_hint: 'BetterDesk कंसोल का सार्वजनिक URL (/remote).' },
    },
    ja: {
        remote: { remember_peer_password: 'このデバイスでデバイスパスワードを記憶', save_peer_password: 'パスワードを保存' },
        remote_dashboard: { open_settings: '設定' },
        rdclient_settings: { title: 'RdClient 設定', open: '設定', server_url: 'パネル URL', tls_strict: '厳格 TLS', sign_out: 'サインアウト', reset_client: 'クライアントをリセット', discovery_refresh: '更新', discovery_empty: 'ローカルネットワークにサーバーが見つかりません' },
        generator: { rdclient_tab: 'RdClient デスクトップ', rdclient_new_bundle: '新規 RdClient バンドル', rdclient_subtitle: 'パネル URL を埋め込んだ RdClient インストーラーをビルド', rdclient_server_url_hint: 'BetterDesk コンソールの公開 URL (/remote)。' },
    },
    ko: {
        remote: { remember_peer_password: '이 기기에서 장치 비밀번호 기억', save_peer_password: '비밀번호 저장' },
        remote_dashboard: { open_settings: '설정' },
        rdclient_settings: { title: 'RdClient 설정', open: '설정', server_url: '패널 URL', tls_strict: '엄격 TLS', sign_out: '로그아웃', reset_client: '클라이언트 재설정', discovery_refresh: '새로고침', discovery_empty: '로컬 네트워크에서 서버를 찾을 수 없습니다' },
        generator: { rdclient_tab: 'RdClient 데스크톱', rdclient_new_bundle: '새 RdClient 번들', rdclient_subtitle: '패널 URL이 포함된 RdClient 설치 프로그램 빌드', rdclient_server_url_hint: 'BetterDesk 콘솔 공개 URL (/remote).' },
    },
    zh: {
        remote: { remember_peer_password: '在此设备上记住设备密码', save_peer_password: '保存密码' },
        remote_dashboard: { open_settings: '设置' },
        rdclient_settings: { title: 'RdClient 设置', open: '设置', server_url: '面板 URL', tls_strict: '严格 TLS', sign_out: '退出登录', reset_client: '重置客户端', discovery_refresh: '刷新', discovery_empty: '在本地网络中未找到服务器' },
        generator: { rdclient_tab: 'RdClient 桌面版', rdclient_new_bundle: '新建 RdClient 包', rdclient_subtitle: '构建嵌入面板 URL 的 RdClient 安装程序', rdclient_server_url_hint: 'BetterDesk 控制台的公开 URL (/remote)。' },
    },
    'zh-TW': {
        remote: { remember_peer_password: '在此裝置上記住裝置密碼', save_peer_password: '儲存密碼' },
        remote_dashboard: { open_settings: '設定' },
        rdclient_settings: { title: 'RdClient 設定', open: '設定', server_url: '面板 URL', tls_strict: '嚴格 TLS', sign_out: '登出', reset_client: '重設用戶端', discovery_refresh: '重新整理', discovery_empty: '區域網路中找不到伺服器' },
        generator: { rdclient_tab: 'RdClient 桌面版', rdclient_new_bundle: '新增 RdClient 套件', rdclient_subtitle: '建置內嵌面板 URL 的 RdClient 安裝程式', rdclient_server_url_hint: 'BetterDesk 主控台的公開 URL (/remote)。' },
    },
    vi: {
        remote: { remember_peer_password: 'Ghi nhớ mật khẩu thiết bị trên máy này', save_peer_password: 'Lưu mật khẩu' },
        remote_dashboard: { open_settings: 'Cài đặt' },
        rdclient_settings: { title: 'Cài đặt RdClient', open: 'Cài đặt', server_url: 'URL bảng điều khiển', tls_strict: 'TLS nghiêm ngặt', sign_out: 'Đăng xuất', reset_client: 'Đặt lại client', discovery_refresh: 'Làm mới', discovery_empty: 'Không tìm thấy máy chủ trên mạng cục bộ' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Gói RdClient mới', rdclient_subtitle: 'Tạo trình cài RdClient với URL bảng điều khiển nhúng', rdclient_server_url_hint: 'URL công khai của bảng điều khiển BetterDesk (/remote).' },
    },
    th: {
        remote: { remember_peer_password: 'จดจำรหัสผ่านอุปกรณ์บนคอมพิวเตอร์นี้', save_peer_password: 'บันทึกรหัสผ่าน' },
        remote_dashboard: { open_settings: 'การตั้งค่า' },
        rdclient_settings: { title: 'การตั้งค่า RdClient', open: 'การตั้งค่า', server_url: 'URL แผงควบคุม', tls_strict: 'TLS เข้มงวด', sign_out: 'ออกจากระบบ', reset_client: 'รีเซ็ตไคลเอนต์', discovery_refresh: 'รีเฟรช', discovery_empty: 'ไม่พบเซิร์ฟเวอร์ในเครือข่ายท้องถิ่น' },
        generator: { rdclient_tab: 'RdClient เดสก์ท็อป', rdclient_new_bundle: 'ชุด RdClient ใหม่', rdclient_subtitle: 'สร้างตัวติดตั้ง RdClient พร้อม URL แผงควบคุมฝังตัว', rdclient_server_url_hint: 'URL สาธารณะของคอนโซล BetterDesk (/remote)' },
    },
    id: {
        remote: { remember_peer_password: 'Ingat kata sandi perangkat di komputer ini', save_peer_password: 'Simpan kata sandi' },
        remote_dashboard: { open_settings: 'Pengaturan' },
        rdclient_settings: { title: 'Pengaturan RdClient', open: 'Pengaturan', server_url: 'URL panel', tls_strict: 'TLS ketat', sign_out: 'Keluar', reset_client: 'Reset klien', discovery_refresh: 'Segarkan', discovery_empty: 'Tidak ada server di jaringan lokal' },
        generator: { rdclient_tab: 'RdClient desktop', rdclient_new_bundle: 'Paket RdClient baru', rdclient_subtitle: 'Buat installer RdClient dengan URL panel tertanam', rdclient_server_url_hint: 'URL publik konsol BetterDesk (/remote).' },
    },
};

function isUnsafeObjectKey(key) {
    return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function deepMerge(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
        if (isUnsafeObjectKey(k)) continue;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (!target[k] || typeof target[k] !== 'object') target[k] = {};
            deepMerge(target[k], v);
        } else {
            target[k] = v;
        }
    }
}

const files = fs.readdirSync(LANG_DIR).filter((f) => f.endsWith('.json'));
for (const file of files) {
    const code = file.replace(/\.json$/, '');
    const patch = PATCHES[code] || PATCHES.en;
    const filePath = path.join(LANG_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    deepMerge(data, patch);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log('patched', file);
}
