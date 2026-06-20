#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '../lang');

const mobileNav = {
    en: { label: 'Main navigation', home: 'Home', devices: 'Devices', remote: 'Remote', chat: 'Chat', more: 'More' },
    pl: { label: 'Nawigacja główna', home: 'Start', devices: 'Urządzenia', remote: 'Zdalny', chat: 'Czat', more: 'Więcej' },
    de: { label: 'Hauptnavigation', home: 'Start', devices: 'Geräte', remote: 'Remote', chat: 'Chat', more: 'Mehr' },
    fr: { label: 'Navigation principale', home: 'Accueil', devices: 'Appareils', remote: 'Remote', chat: 'Chat', more: 'Plus' },
    es: { label: 'Navegación principal', home: 'Inicio', devices: 'Dispositivos', remote: 'Remoto', chat: 'Chat', more: 'Más' },
    it: { label: 'Navigazione principale', home: 'Home', devices: 'Dispositivi', remote: 'Remoto', chat: 'Chat', more: 'Altro' },
    pt: { label: 'Navegação principal', home: 'Início', devices: 'Dispositivos', remote: 'Remoto', chat: 'Chat', more: 'Mais' },
    nl: { label: 'Hoofdnavigatie', home: 'Home', devices: 'Apparaten', remote: 'Remote', chat: 'Chat', more: 'Meer' },
    cs: { label: 'Hlavní navigace', home: 'Domů', devices: 'Zařízení', remote: 'Remote', chat: 'Chat', more: 'Více' },
    da: { label: 'Hovednavigation', home: 'Hjem', devices: 'Enheder', remote: 'Remote', chat: 'Chat', more: 'Mere' },
    fi: { label: 'Päänavigointi', home: 'Koti', devices: 'Laitteet', remote: 'Etä', chat: 'Chat', more: 'Lisää' },
    sv: { label: 'Huvudnavigering', home: 'Hem', devices: 'Enheter', remote: 'Remote', chat: 'Chatt', more: 'Mer' },
    nb: { label: 'Hovednavigasjon', home: 'Hjem', devices: 'Enheter', remote: 'Remote', chat: 'Chat', more: 'Mer' },
    ro: { label: 'Navigare principală', home: 'Acasă', devices: 'Dispozitive', remote: 'Remote', chat: 'Chat', more: 'Mai mult' },
    hu: { label: 'Fő navigáció', home: 'Kezdőlap', devices: 'Eszközök', remote: 'Távoli', chat: 'Chat', more: 'Több' },
    tr: { label: 'Ana gezinme', home: 'Ana sayfa', devices: 'Cihazlar', remote: 'Uzak', chat: 'Sohbet', more: 'Daha fazla' },
    uk: { label: 'Головна навігація', home: 'Головна', devices: 'Пристрої', remote: 'Віддалено', chat: 'Чат', more: 'Більше' },
    ru: { label: 'Главная навигация', home: 'Главная', devices: 'Устройства', remote: 'Удалённо', chat: 'Чат', more: 'Ещё' },
    ja: { label: 'メインナビゲーション', home: 'ホーム', devices: 'デバイス', remote: 'リモート', chat: 'チャット', more: 'その他' },
    ko: { label: '주요 탐색', home: '홈', devices: '장치', remote: '원격', chat: '채팅', more: '더보기' },
    zh: { label: '主导航', home: '首页', devices: '设备', remote: '远程', chat: '聊天', more: '更多' },
    'zh-TW': { label: '主導覽', home: '首頁', devices: '裝置', remote: '遠端', chat: '聊天', more: '更多' },
    ar: { label: 'التنقل الرئيسي', home: 'الرئيسية', devices: 'الأجهزة', remote: 'بعيد', chat: 'دردشة', more: 'المزيد' },
    hi: { label: 'मुख्य नेविगेशन', home: 'होम', devices: 'डिवाइस', remote: 'रिमोट', chat: 'चैट', more: 'अधिक' },
    id: { label: 'Navigasi utama', home: 'Beranda', devices: 'Perangkat', remote: 'Remote', chat: 'Obrolan', more: 'Lainnya' },
    th: { label: 'การนำทางหลัก', home: 'หน้าแรก', devices: 'อุปกรณ์', remote: 'รีโมต', chat: 'แชท', more: 'เพิ่มเติม' },
    vi: { label: 'Điều hướng chính', home: 'Trang chủ', devices: 'Thiết bị', remote: 'Từ xa', chat: 'Trò chuyện', more: 'Thêm' }
};

const remoteKeys = {
    en: {
        input_mode_touch: 'Touch', input_mode_touchpad: 'Touchpad', show_keyboard: 'Keyboard',
        special_keys: 'Special keys', special_print_screen: 'Print Screen', mobile_toolbar: 'Remote controls',
        phone_unsupported_title: 'Remote desktop requires a larger screen',
        phone_unsupported_body: 'Use a tablet, unfolded foldable, or desktop to control devices remotely. You can still manage devices from the console.',
        phone_unsupported_back_devices: 'Back to devices', phone_unsupported_get_desktop: 'Get RdClient desktop'
    },
    pl: {
        input_mode_touch: 'Dotyk', input_mode_touchpad: 'Touchpad', show_keyboard: 'Klawiatura',
        special_keys: 'Klawisze specjalne', special_print_screen: 'Print Screen', mobile_toolbar: 'Sterowanie zdalne',
        phone_unsupported_title: 'Pulpit zdalny wymaga większego ekranu',
        phone_unsupported_body: 'Użyj tabletu, rozłożonego folda lub komputera, aby zdalnie sterować urządzeniami. Zarządzanie urządzeniami nadal działa w konsoli.',
        phone_unsupported_back_devices: 'Wróć do urządzeń', phone_unsupported_get_desktop: 'Pobierz RdClient desktop'
    },
    de: {
        input_mode_touch: 'Touch', input_mode_touchpad: 'Touchpad', show_keyboard: 'Tastatur',
        special_keys: 'Sondertasten', special_print_screen: 'Druck', mobile_toolbar: 'Remote-Steuerung',
        phone_unsupported_title: 'Remote-Desktop erfordert einen größeren Bildschirm',
        phone_unsupported_body: 'Verwenden Sie ein Tablet, aufgeklapptes Foldable oder Desktop. Geräteverwaltung bleibt in der Konsole verfügbar.',
        phone_unsupported_back_devices: 'Zurück zu Geräten', phone_unsupported_get_desktop: 'RdClient Desktop holen'
    },
    fr: {
        input_mode_touch: 'Toucher', input_mode_touchpad: 'Pavé tactile', show_keyboard: 'Clavier',
        special_keys: 'Touches spéciales', special_print_screen: 'Impr. écran', mobile_toolbar: 'Contrôles distants',
        phone_unsupported_title: 'Le bureau à distance nécessite un écran plus grand',
        phone_unsupported_body: 'Utilisez une tablette, un foldable déplié ou un ordinateur. La gestion des appareils reste disponible dans la console.',
        phone_unsupported_back_devices: 'Retour aux appareils', phone_unsupported_get_desktop: 'Obtenir RdClient desktop'
    },
    es: {
        input_mode_touch: 'Táctil', input_mode_touchpad: 'Touchpad', show_keyboard: 'Teclado',
        special_keys: 'Teclas especiales', special_print_screen: 'Impr Pant', mobile_toolbar: 'Controles remotos',
        phone_unsupported_title: 'El escritorio remoto requiere una pantalla más grande',
        phone_unsupported_body: 'Use una tablet, plegable desplegado o escritorio. La gestión de dispositivos sigue en la consola.',
        phone_unsupported_back_devices: 'Volver a dispositivos', phone_unsupported_get_desktop: 'Obtener RdClient desktop'
    },
    it: {
        input_mode_touch: 'Tocco', input_mode_touchpad: 'Touchpad', show_keyboard: 'Tastiera',
        special_keys: 'Tasti speciali', special_print_screen: 'Stamp', mobile_toolbar: 'Controlli remoti',
        phone_unsupported_title: 'Il desktop remoto richiede uno schermo più grande',
        phone_unsupported_body: 'Usa tablet, foldable aperto o desktop. La gestione dispositivi resta nella console.',
        phone_unsupported_back_devices: 'Torna ai dispositivi', phone_unsupported_get_desktop: 'Scarica RdClient desktop'
    },
    pt: {
        input_mode_touch: 'Toque', input_mode_touchpad: 'Touchpad', show_keyboard: 'Teclado',
        special_keys: 'Teclas especiais', special_print_screen: 'Print Screen', mobile_toolbar: 'Controles remotos',
        phone_unsupported_title: 'Área de trabalho remota requer ecrã maior',
        phone_unsupported_body: 'Use tablet, foldable aberto ou desktop. A gestão de dispositivos continua na consola.',
        phone_unsupported_back_devices: 'Voltar aos dispositivos', phone_unsupported_get_desktop: 'Obter RdClient desktop'
    },
    nl: {
        input_mode_touch: 'Aanraken', input_mode_touchpad: 'Touchpad', show_keyboard: 'Toetsenbord',
        special_keys: 'Speciale toetsen', special_print_screen: 'Print Screen', mobile_toolbar: 'Remote bediening',
        phone_unsupported_title: 'Remote desktop vereist een groter scherm',
        phone_unsupported_body: 'Gebruik tablet, opengeklapt foldable of desktop. Apparaatbeheer blijft in de console.',
        phone_unsupported_back_devices: 'Terug naar apparaten', phone_unsupported_get_desktop: 'RdClient desktop downloaden'
    },
    cs: {
        input_mode_touch: 'Dotyk', input_mode_touchpad: 'Touchpad', show_keyboard: 'Klávesnice',
        special_keys: 'Speciální klávesy', special_print_screen: 'Print Screen', mobile_toolbar: 'Vzdálené ovládání',
        phone_unsupported_title: 'Vzdálená plocha vyžaduje větší obrazovku',
        phone_unsupported_body: 'Použijte tablet, rozložený fold nebo desktop. Správa zařízení zůstává v konzoli.',
        phone_unsupported_back_devices: 'Zpět na zařízení', phone_unsupported_get_desktop: 'Stáhnout RdClient desktop'
    },
    da: {
        input_mode_touch: 'Berøring', input_mode_touchpad: 'Touchpad', show_keyboard: 'Tastatur',
        special_keys: 'Specialtaster', special_print_screen: 'Print Screen', mobile_toolbar: 'Fjernbetjening',
        phone_unsupported_title: 'Fjernskrivebord kræver en større skærm',
        phone_unsupported_body: 'Brug tablet, foldet foldbar eller desktop. Enhedsstyring er stadig i konsollen.',
        phone_unsupported_back_devices: 'Tilbage til enheder', phone_unsupported_get_desktop: 'Hent RdClient desktop'
    },
    fi: {
        input_mode_touch: 'Kosketus', input_mode_touchpad: 'Touchpad', show_keyboard: 'Näppäimistö',
        special_keys: 'Erityisnäppäimet', special_print_screen: 'Print Screen', mobile_toolbar: 'Etäohjaus',
        phone_unsupported_title: 'Etätyöpöytä vaatii suuremman näytön',
        phone_unsupported_body: 'Käytä tablettia, avattua taittopuhelinta tai työpöytää. Laitteiden hallinta toimii konsolissa.',
        phone_unsupported_back_devices: 'Takaisin laitteisiin', phone_unsupported_get_desktop: 'Hae RdClient desktop'
    },
    sv: {
        input_mode_touch: 'Pekning', input_mode_touchpad: 'Touchpad', show_keyboard: 'Tangentbord',
        special_keys: 'Specialtangenter', special_print_screen: 'Print Screen', mobile_toolbar: 'Fjärrstyrning',
        phone_unsupported_title: 'Fjärrskrivbord kräver större skärm',
        phone_unsupported_body: 'Använd surfplatta, uppfälld foldable eller desktop. Enhetshantering finns kvar i konsolen.',
        phone_unsupported_back_devices: 'Tillbaka till enheter', phone_unsupported_get_desktop: 'Hämta RdClient desktop'
    },
    nb: {
        input_mode_touch: 'Berøring', input_mode_touchpad: 'Touchpad', show_keyboard: 'Tastatur',
        special_keys: 'Spesialtaster', special_print_screen: 'Print Screen', mobile_toolbar: 'Fjernkontroll',
        phone_unsupported_title: 'Fjernskrivebord krever større skjerm',
        phone_unsupported_body: 'Bruk nettbrett, utfoldet foldbar eller desktop. Enhetsstyring er fortsatt i konsollen.',
        phone_unsupported_back_devices: 'Tilbake til enheter', phone_unsupported_get_desktop: 'Last ned RdClient desktop'
    },
    ro: {
        input_mode_touch: 'Atingere', input_mode_touchpad: 'Touchpad', show_keyboard: 'Tastatură',
        special_keys: 'Taste speciale', special_print_screen: 'Print Screen', mobile_toolbar: 'Control remote',
        phone_unsupported_title: 'Desktopul remote necesită un ecran mai mare',
        phone_unsupported_body: 'Folosiți tabletă, foldable desfăcut sau desktop. Gestionarea dispozitivelor rămâne în consolă.',
        phone_unsupported_back_devices: 'Înapoi la dispozitive', phone_unsupported_get_desktop: 'Obține RdClient desktop'
    },
    hu: {
        input_mode_touch: 'Érintés', input_mode_touchpad: 'Touchpad', show_keyboard: 'Billentyűzet',
        special_keys: 'Speciális billentyűk', special_print_screen: 'Print Screen', mobile_toolbar: 'Távoli vezérlés',
        phone_unsupported_title: 'A távoli asztal nagyobb képernyőt igényel',
        phone_unsupported_body: 'Használjon tabletet, kinyitott foldot vagy asztali gépet. Az eszközkezelés továbbra is elérhető a konzolon.',
        phone_unsupported_back_devices: 'Vissza az eszközökhöz', phone_unsupported_get_desktop: 'RdClient desktop letöltése'
    },
    tr: {
        input_mode_touch: 'Dokunma', input_mode_touchpad: 'Touchpad', show_keyboard: 'Klavye',
        special_keys: 'Özel tuşlar', special_print_screen: 'Print Screen', mobile_toolbar: 'Uzak kontrol',
        phone_unsupported_title: 'Uzak masaüstü daha büyük ekran gerektirir',
        phone_unsupported_body: 'Tablet, açık katlanabilir veya masaüstü kullanın. Cihaz yönetimi konsolda devam eder.',
        phone_unsupported_back_devices: 'Cihazlara dön', phone_unsupported_get_desktop: 'RdClient desktop indir'
    },
    uk: {
        input_mode_touch: 'Дотик', input_mode_touchpad: 'Touchpad', show_keyboard: 'Клавіатура',
        special_keys: 'Спеціальні клавіші', special_print_screen: 'Print Screen', mobile_toolbar: 'Віддалене керування',
        phone_unsupported_title: 'Віддалений робочий стіл потребує більшого екрана',
        phone_unsupported_body: 'Використовуйте планшет, розгорнутий fold або комп’ютер. Керування пристроями залишається в консолі.',
        phone_unsupported_back_devices: 'Назад до пристроїв', phone_unsupported_get_desktop: 'Завантажити RdClient desktop'
    },
    ja: {
        input_mode_touch: 'タッチ', input_mode_touchpad: 'タッチパッド', show_keyboard: 'キーボード',
        special_keys: '特殊キー', special_print_screen: 'Print Screen', mobile_toolbar: 'リモート操作',
        phone_unsupported_title: 'リモートデスクトップには大きな画面が必要です',
        phone_unsupported_body: 'タブレット、開いた折りたたみ端末、またはデスクトップをご利用ください。デバイス管理はコンソールで利用できます。',
        phone_unsupported_back_devices: 'デバイスに戻る', phone_unsupported_get_desktop: 'RdClient desktop を取得'
    },
    ko: {
        input_mode_touch: '터치', input_mode_touchpad: '터치패드', show_keyboard: '키보드',
        special_keys: '특수 키', special_print_screen: 'Print Screen', mobile_toolbar: '원격 제어',
        phone_unsupported_title: '원격 데스크톱은 더 큰 화면이 필요합니다',
        phone_unsupported_body: '태블릿, 펼친 폴더블 또는 데스크톱을 사용하세요. 장치 관리는 콘솔에서 계속 가능합니다.',
        phone_unsupported_back_devices: '장치로 돌아가기', phone_unsupported_get_desktop: 'RdClient desktop 받기'
    },
    zh: {
        input_mode_touch: '触控', input_mode_touchpad: '触控板', show_keyboard: '键盘',
        special_keys: '特殊键', special_print_screen: 'Print Screen', mobile_toolbar: '远程控制',
        phone_unsupported_title: '远程桌面需要更大的屏幕',
        phone_unsupported_body: '请使用平板、展开的折叠屏或桌面设备。仍可在控制台管理设备。',
        phone_unsupported_back_devices: '返回设备', phone_unsupported_get_desktop: '获取 RdClient 桌面版'
    },
    'zh-TW': {
        input_mode_touch: '觸控', input_mode_touchpad: '觸控板', show_keyboard: '鍵盤',
        special_keys: '特殊鍵', special_print_screen: 'Print Screen', mobile_toolbar: '遠端控制',
        phone_unsupported_title: '遠端桌面需要更大的螢幕',
        phone_unsupported_body: '請使用平板、展開的折疊裝置或桌面。仍可在主控台管理裝置。',
        phone_unsupported_back_devices: '返回裝置', phone_unsupported_get_desktop: '取得 RdClient 桌面版'
    },
    ar: {
        input_mode_touch: 'لمس', input_mode_touchpad: 'لوحة لمس', show_keyboard: 'لوحة مفاتيح',
        special_keys: 'مفاتيح خاصة', special_print_screen: 'Print Screen', mobile_toolbar: 'تحكم عن بُعد',
        phone_unsupported_title: 'سطح المكتب البعيد يتطلب شاشة أكبر',
        phone_unsupported_body: 'استخدم جهاز لوحي أو foldable مفتوح أو سطح مكتب. إدارة الأجهزة متاحة في وحدة التحكم.',
        phone_unsupported_back_devices: 'العودة إلى الأجهزة', phone_unsupported_get_desktop: 'احصل على RdClient desktop'
    },
    hi: {
        input_mode_touch: 'टच', input_mode_touchpad: 'टचपैड', show_keyboard: 'कीबोर्ड',
        special_keys: 'विशेष कुंजियाँ', special_print_screen: 'Print Screen', mobile_toolbar: 'रिमोट नियंत्रण',
        phone_unsupported_title: 'रिमोट डेस्कटॉप के लिए बड़ी स्क्रीन चाहिए',
        phone_unsupported_body: 'टैबलेट, खुला foldable या डेस्कटॉप उपयोग करें। डिवाइस प्रबंधन कंसोल में उपलब्ध है।',
        phone_unsupported_back_devices: 'डिवाइस पर वापस', phone_unsupported_get_desktop: 'RdClient desktop प्राप्त करें'
    },
    id: {
        input_mode_touch: 'Sentuh', input_mode_touchpad: 'Touchpad', show_keyboard: 'Keyboard',
        special_keys: 'Tombol khusus', special_print_screen: 'Print Screen', mobile_toolbar: 'Kontrol remote',
        phone_unsupported_title: 'Desktop jarak jauh memerlukan layar lebih besar',
        phone_unsupported_body: 'Gunakan tablet, foldable terbuka, atau desktop. Kelola perangkat tetap di konsol.',
        phone_unsupported_back_devices: 'Kembali ke perangkat', phone_unsupported_get_desktop: 'Dapatkan RdClient desktop'
    },
    th: {
        input_mode_touch: 'สัมผัส', input_mode_touchpad: 'ทัชแพด', show_keyboard: 'แป้นพิมพ์',
        special_keys: 'ปุ่มพิเศษ', special_print_screen: 'Print Screen', mobile_toolbar: 'ควบคุมระยะไกล',
        phone_unsupported_title: 'เดสก์ท็อpระยะไกลต้องใช้หน้าจอที่ใหญ่กว่า',
        phone_unsupported_body: 'ใช้แท็บเล็ต foldable ที่เปิด หรือเดสก์ท็อป จัดการอุปกรณ์ได้ใน console',
        phone_unsupported_back_devices: 'กลับไปยังอุปกรณ์', phone_unsupported_get_desktop: 'รับ RdClient desktop'
    },
    vi: {
        input_mode_touch: 'Chạm', input_mode_touchpad: 'Touchpad', show_keyboard: 'Bàn phím',
        special_keys: 'Phím đặc biệt', special_print_screen: 'Print Screen', mobile_toolbar: 'Điều khiển từ xa',
        phone_unsupported_title: 'Máy tính từ xa cần màn hình lớn hơn',
        phone_unsupported_body: 'Dùng máy tính bảng, foldable mở hoặc desktop. Quản lý thiết bị vẫn ở console.',
        phone_unsupported_back_devices: 'Quay lại thiết bị', phone_unsupported_get_desktop: 'Tải RdClient desktop'
    }
};

function localeCode(filename) {
    return filename.replace('.json', '');
}

for (const file of fs.readdirSync(LANG_DIR).filter(f => f.endsWith('.json'))) {
    const code = localeCode(file);
    const filePath = path.join(LANG_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const nav = mobileNav[code] || mobileNav.en;
    const remote = remoteKeys[code] || remoteKeys.en;

    data.mobile_nav = Object.assign({}, nav);
    data.remote = data.remote || {};
    Object.assign(data.remote, remote);

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    console.log('Updated', file);
}
