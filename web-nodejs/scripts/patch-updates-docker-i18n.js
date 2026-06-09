'use strict';

/**
 * Patch updates.docker_* and updates.channel_* keys missing from non-en locales.
 * Idempotent — safe to run before i18n:check.
 */

const fs = require('fs');
const path = require('path');

const langDir = path.join(__dirname, '..', 'lang');

const patches = {
    pl: {
        channel_stable: 'Stabilny (main)',
        channel_development: 'Rozwojowy (dev)'
    },
    de: {
        docker_title: 'Docker-Image-Bereitstellung',
        docker_desc: 'Diese Konsole läuft aus einem vorgefertigten Container-Image. Updates erfolgen durch Pull neuerer Images von GHCR, nicht über In-App-Installation oder Go-Neubau.',
        docker_install_note: 'In-App-Installation ist in Docker deaktiviert. Führen Sie die obigen Befehle auf dem Host aus und aktualisieren Sie dann diese Seite.',
        docker_update_available: 'Neue Container-Images verfügbar',
        docker_sha_unknown: 'Aktuell (Image-Commit unbekannt)',
        docker_images: 'Images',
        channel_stable: 'Stabil (main)',
        channel_development: 'Entwicklung (dev)'
    },
    fr: {
        docker_title: 'Déploiement d\'images Docker',
        docker_desc: 'Cette console s\'exécute à partir d\'une image conteneur préconstruite. Les mises à jour s\'appliquent en tirant de nouvelles images depuis GHCR, pas via l\'installation intégrée ni la recompilation Go.',
        docker_install_note: 'L\'installation intégrée est désactivée dans Docker. Exécutez les commandes ci-dessus sur l\'hôte, puis actualisez cette page.',
        docker_update_available: 'Nouvelles images conteneur disponibles',
        docker_sha_unknown: 'À jour (commit d\'image inconnu)',
        docker_images: 'Images',
        channel_stable: 'Version stable (main)',
        channel_development: 'Développement (dev)'
    },
    es: {
        docker_title: 'Despliegue de imágenes Docker',
        docker_desc: 'Esta consola se ejecuta desde una imagen de contenedor precompilada. Las actualizaciones se aplican descargando imágenes más recientes de GHCR, no mediante instalación en la app ni recompilación Go.',
        docker_install_note: 'La instalación en la app está deshabilitada en Docker. Ejecute los comandos anteriores en el host y actualice esta página.',
        docker_update_available: 'Nuevas imágenes de contenedor disponibles',
        docker_sha_unknown: 'Actualizado (commit de imagen desconocido)',
        docker_images: 'Imágenes',
        channel_stable: 'Estable (main)',
        channel_development: 'Desarrollo (dev)'
    },
    cs: {
        docker_title: 'Nasazení Docker image',
        docker_desc: 'Tato konzole běží z předpřipraveného kontejnerového image. Aktualizace se provádějí stažením novějších image z GHCR, ne instalací v aplikaci ani překompilací Go.',
        docker_install_note: 'Instalace v aplikaci je v Dockeru zakázána. Spusťte výše uvedené příkazy na hostiteli a poté obnovte stránku.',
        docker_update_available: 'K dispozici jsou nové kontejnerové image',
        docker_sha_unknown: 'Aktuální (commit image neznámý)',
        docker_images: 'Image',
        channel_stable: 'Stabilní (main)',
        channel_development: 'Vývoj (dev)'
    },
    da: {
        docker_title: 'Docker-image-udrulning',
        docker_desc: 'Denne konsol kører fra et færdigbygget containerimage. Opdateringer anvendes ved at hente nyere images fra GHCR, ikke via in-app-installation eller Go-genopbygning.',
        docker_install_note: 'In-app-installation er deaktiveret i Docker. Kør kommandoerne ovenfor på værten, og opdater derefter denne side.',
        docker_update_available: 'Nye containerimages tilgængelige',
        docker_sha_unknown: 'Opdateret (image-commit ukendt)',
        docker_images: 'Images',
        channel_stable: 'Stabil (main)',
        channel_development: 'Udvikling (dev)'
    },
    fi: {
        docker_title: 'Docker-kuvan käyttöönotto',
        docker_desc: 'Tämä konsoli toimii valmiista kontainerikuvasta. Päivitykset tehdään vetämällä uudempia kuvia GHCR:stä, ei sovelluksen asennuksella tai Go-uudelleenkäännöksellä.',
        docker_install_note: 'Sovelluksen sisäinen asennus on poissa käytöstä Dockerissa. Suorita yllä olevat komennot isännöintikoneella ja päivitä sitten tämä sivu.',
        docker_update_available: 'Uusia kontainerikuvia saatavilla',
        docker_sha_unknown: 'Ajan tasalla (kuvan commit tuntematon)',
        docker_images: 'Kuvat',
        channel_stable: 'Vakaa (main)',
        channel_development: 'Kehitys (dev)'
    },
    nb: {
        docker_title: 'Docker-image-utrulling',
        docker_desc: 'Denne konsollen kjører fra et ferdigbygd containerbilde. Oppdateringer brukes ved å hente nyere bilder fra GHCR, ikke via in-app-installasjon eller Go-ombygging.',
        docker_install_note: 'In-app-installasjon er deaktivert i Docker. Kjør kommandoene over på verten, og oppdater deretter denne siden.',
        docker_update_available: 'Nye containerbilder tilgjengelig',
        docker_sha_unknown: 'Oppdatert (image-commit ukjent)',
        docker_images: 'Bilder',
        channel_stable: 'Stabil (main)',
        channel_development: 'Utvikling (dev)'
    },
    sv: {
        docker_title: 'Docker-image-distribution',
        docker_desc: 'Denna konsol körs från en färdigbyggd containerimage. Uppdateringar tillämpas genom att hämta nyare images från GHCR, inte via in-app-installation eller Go-ombyggnad.',
        docker_install_note: 'In-app-installation är inaktiverad i Docker. Kör kommandona ovan på värden och uppdatera sedan sidan.',
        docker_update_available: 'Nya containerimages tillgängliga',
        docker_sha_unknown: 'Uppdaterad (image-commit okänd)',
        docker_images: 'Images',
        channel_stable: 'Stabil (main)',
        channel_development: 'Utveckling (dev)'
    },
    it: {
        docker_title: 'Distribuzione immagini Docker',
        docker_desc: 'Questa console gira da un\'immagine container precompilata. Gli aggiornamenti si applicano scaricando immagini più recenti da GHCR, non tramite installazione in-app o ricompilazione Go.',
        docker_install_note: 'L\'installazione in-app è disabilitata in Docker. Esegui i comandi sopra sull\'host, poi aggiorna questa pagina.',
        docker_update_available: 'Nuove immagini container disponibili',
        docker_sha_unknown: 'Aggiornato (commit immagine sconosciuto)',
        docker_images: 'Immagini',
        channel_stable: 'Stabile (main)',
        channel_development: 'Sviluppo (dev)'
    },
    pt: {
        docker_title: 'Implantação de imagens Docker',
        docker_desc: 'Este console executa a partir de uma imagem de contentor pré-construída. As atualizações aplicam-se ao obter imagens mais recentes do GHCR, não por instalação na app nem recompilação Go.',
        docker_install_note: 'A instalação na app está desativada no Docker. Execute os comandos acima no anfitrião e atualize esta página.',
        docker_update_available: 'Novas imagens de contentor disponíveis',
        docker_sha_unknown: 'Atualizado (commit da imagem desconhecido)',
        docker_images: 'Imagens',
        channel_stable: 'Estável (main)',
        channel_development: 'Desenvolvimento (dev)'
    },
    nl: {
        docker_title: 'Docker-image-implementatie',
        docker_desc: 'Deze console draait vanuit een voorgebouwd containerimage. Updates worden toegepast door nieuwere images van GHCR te pullen, niet via in-app-installatie of Go-herbouw.',
        docker_install_note: 'In-app-installatie is uitgeschakeld in Docker. Voer de bovenstaande commando\'s uit op de host en vernieuw daarna deze pagina.',
        docker_update_available: 'Nieuwe containerimages beschikbaar',
        docker_sha_unknown: 'Up-to-date (image-commit onbekend)',
        docker_images: 'Images',
        channel_stable: 'Stabiel (main)',
        channel_development: 'Ontwikkeling (dev)'
    },
    ro: {
        docker_title: 'Implementare imagini Docker',
        docker_desc: 'Această consolă rulează dintr-o imagine de container preconstruită. Actualizările se aplică prin descărcarea de imagini mai noi de la GHCR, nu prin instalare în aplicație sau recompilare Go.',
        docker_install_note: 'Instalarea din aplicație este dezactivată în Docker. Rulați comenzile de mai sus pe gazdă, apoi reîmprospătați pagina.',
        docker_update_available: 'Imagini container noi disponibile',
        docker_sha_unknown: 'Actualizat (commit imagine necunoscut)',
        docker_images: 'Imagini',
        channel_stable: 'Stabil (main)',
        channel_development: 'Dezvoltare (dev)'
    },
    hu: {
        docker_title: 'Docker image telepítés',
        docker_desc: 'Ez a konzol előre elkészített konténer image-ből fut. A frissítések GHCR-ből történő újabb image-ek letöltésével történnek, nem alkalmazáson belüli telepítéssel vagy Go újrafordítással.',
        docker_install_note: 'Az alkalmazáson belüli telepítés Dockerben le van tiltva. Futtassa a fenti parancsokat a gazdagépen, majd frissítse az oldalt.',
        docker_update_available: 'Új konténer image-ek érhetők el',
        docker_sha_unknown: 'Naprakész (image commit ismeretlen)',
        docker_images: 'Image-ek',
        channel_stable: 'Stabil (main)',
        channel_development: 'Fejlesztés (dev)'
    },
    tr: {
        docker_title: 'Docker image dağıtımı',
        docker_desc: 'Bu konsol önceden oluşturulmuş bir konteyner görüntüsünden çalışır. Güncellemeler uygulama içi kurulum veya Go yeniden derleme yerine GHCR\'den daha yeni görüntüler çekilerek uygulanır.',
        docker_install_note: 'Uygulama içi kurulum Docker\'da devre dışıdır. Yukarıdaki komutları ana makinede çalıştırın, ardından bu sayfayı yenileyin.',
        docker_update_available: 'Yeni konteyner görüntüleri mevcut',
        docker_sha_unknown: 'Güncel (görüntü commit bilinmiyor)',
        docker_images: 'Görüntüler',
        channel_stable: 'Kararlı (main)',
        channel_development: 'Geliştirme (dev)'
    },
    uk: {
        docker_title: 'Розгортання Docker-образів',
        docker_desc: 'Ця консоль працює з готового образу контейнера. Оновлення застосовуються шляхом завантаження новіших образів з GHCR, а не через встановлення в застосунку чи перезбірку Go.',
        docker_install_note: 'Встановлення з панелі вимкнено в Docker. Виконайте команди вище на хості, потім оновіть цю сторінку.',
        docker_update_available: 'Доступні нові образи контейнерів',
        docker_sha_unknown: 'Актуально (commit образу невідомий)',
        docker_images: 'Образи',
        channel_stable: 'Стабільний (main)',
        channel_development: 'Розробка (dev)'
    },
    ar: {
        docker_title: 'نشر صور Docker',
        docker_desc: 'تعمل هذه اللوحة من صورة حاوية مُسبقة البناء. تُطبَّق التحديثات بسحب صور أحدث من GHCR، وليس عبر التثبيت داخل التطبيق أو إعادة بناء Go.',
        docker_install_note: 'التثبيت داخل التطبيق معطّل في Docker. نفّذ الأوامر أعلاه على المضيف ثم حدّث هذه الصفحة.',
        docker_update_available: 'صور حاويات جديدة متاحة',
        docker_sha_unknown: 'محدّث (commit الصورة غير معروف)',
        docker_images: 'الصور',
        channel_desc: 'اختر مصدر التحديثات للوحة. يجب على خوادم الإنتاج استخدام Stable.',
        channel_pick_label: 'التبديل إلى',
        channel_apply_hint: 'يُحفظ التغيير فور التأكيد. ثم انقر «التحقق من التحديثات».',
        channel_confirm_switch: 'تبديل مصدر التحديث من {from} إلى {to}؟ يبقى commit المثبّت كما هو حتى تُشغّل «التحقق من التحديثات».'
    },
    hi: {
        docker_title: 'Docker इमेज परिनियोजन',
        docker_desc: 'यह कंसोल पूर्व-निर्मित कंटेनर इमेज से चलता है। अपडेट GHCR से नई इमेज खींचकर लागू होते हैं, इन-ऐप इंस्टॉल या Go रीबिल्ड से नहीं।',
        docker_install_note: 'Docker में इन-ऐप इंस्टॉल अक्षम है। होस्ट पर ऊपर दिए कमांड चलाएँ, फिर यह पृष्ठ रीफ़्रेश करें।',
        docker_update_available: 'नई कंटेनर इमेज उपलब्ध',
        docker_sha_unknown: 'अद्यतन (इमेज commit अज्ञात)',
        docker_images: 'इमेज',
        channel_desc: 'चुनें कि पैनल अपडेट कहाँ से जाँचे। प्रोडक्शन सर्वर Stable उपयोग करें।',
        channel_stable: 'स्थिर (main)',
        channel_development: 'विकास (dev)',
        channel_save: 'चैनल बदलें',
        channel_saved: 'अपडेट चैनल बदला। रीफ़्रेश के लिए «अपडेट जाँचें» पर क्लिक करें।',
        channel_pick_label: 'इस पर स्विच करें',
        channel_apply_hint: 'पुष्टि के तुरंत बाद परिवर्तन सहेजा जाता है। फिर «अपडेट जाँचें» पर क्लिक करें।',
        channel_confirm_switch: 'अपडेट स्रोत {from} से {to} पर बदलें? «अपडेट जाँचें» चलाने तक इंस्टॉल commit वही रहेगा।'
    },
    ja: {
        docker_title: 'Docker イメージのデプロイ',
        docker_desc: 'このコンソールは事前ビルド済みコンテナイメージから動作します。更新は GHCR から新しいイメージを pull して適用し、アプリ内インストールや Go 再ビルドでは行いません。',
        docker_install_note: 'Docker ではアプリ内インストールは無効です。上記コマンドをホストで実行し、このページを更新してください。',
        docker_update_available: '新しいコンテナイメージが利用可能',
        docker_sha_unknown: '最新（イメージ commit 不明）',
        docker_images: 'イメージ',
        channel_stable: '安定版 (main)',
        channel_development: '開発版 (dev)'
    },
    ko: {
        docker_title: 'Docker 이미지 배포',
        docker_desc: '이 콘솔은 사전 빌드된 컨테이너 이미지에서 실행됩니다. 업데이트는 GHCR에서 최신 이미지를 pull하여 적용하며, 앱 내 설치나 Go 재빌드가 아닙니다.',
        docker_install_note: 'Docker에서는 앱 내 설치가 비활성화되어 있습니다. 위 명령을 호스트에서 실행한 뒤 이 페이지를 새로고침하세요.',
        docker_update_available: '새 컨테이너 이미지 사용 가능',
        docker_sha_unknown: '최신 (이미지 commit 알 수 없음)',
        docker_images: '이미지',
        channel_stable: '안정 (main)',
        channel_development: '개발 (dev)'
    },
    zh: {
        docker_title: 'Docker 镜像部署',
        docker_desc: '本控制台运行于预构建容器镜像。更新通过从 GHCR 拉取较新镜像完成，而非应用内安装或 Go 重新编译。',
        docker_install_note: 'Docker 中已禁用应用内安装。请在主机上运行上述命令，然后刷新本页。',
        docker_update_available: '有新的容器镜像可用',
        docker_sha_unknown: '已是最新（镜像 commit 未知）',
        docker_images: '镜像',
        channel_stable: '稳定版 (main)',
        channel_development: '开发版 (dev)'
    },
    'zh-TW': {
        docker_title: 'Docker 映像部署',
        docker_desc: '此主控台以預先建置的容器映像執行。更新方式是從 GHCR 拉取較新映像，而非應用程式內安裝或 Go 重新編譯。',
        docker_install_note: 'Docker 中已停用應用程式內安裝。請在主機上執行上述指令，然後重新整理此頁面。',
        docker_update_available: '有新的容器映像可用',
        docker_sha_unknown: '已是最新（映像 commit 未知）',
        docker_images: '映像',
        channel_stable: '穩定版 (main)',
        channel_development: '開發版 (dev)'
    },
    th: {
        docker_title: 'การ deploy อิมเมจ Docker',
        docker_desc: 'คอนโซลนี้ทำงานจากอิมเมจคอนเทนเนอร์ที่สร้างไว้ล่วงหน้า อัปเดตโดยดึงอิมเมจใหม่จาก GHCR ไม่ใช่ติดตั้งในแอปหรือ build Go ใหม่',
        docker_install_note: 'การติดตั้งในแอปถูกปิดใช้งานใน Docker รันคำสั่งด้านบนบนโฮสต์ แล้วรีเฟรชหน้านี้',
        docker_update_available: 'มีอิมเมจคอนเทนเนอร์ใหม่',
        docker_sha_unknown: 'ล่าสุด (commit อิมเมจไม่ทราบ)',
        docker_images: 'อิมเมจ',
        channel_stable: 'เสถียร (main)',
        channel_development: 'พัฒนา (dev)',
        channel_save: 'สลับช่องทาง',
        channel_saved: 'สลับช่องทางอัปเดตแล้ว คลิกตรวจสอบอัปเดตเพื่อรีเฟรช',
        channel_pick_label: 'สลับเป็น',
        channel_apply_hint: 'การเปลี่ยนแปลงจะบันทึกทันทีหลังยืนยัน จากนั้นคลิกตรวจสอบอัปเดต',
        channel_confirm_switch: 'สลับแหล่งอัปเดตจาก {from} เป็น {to}? commit ที่ติดตั้งยังคงเดิมจนกว่าจะตรวจสอบอัปเดต'
    },
    vi: {
        docker_title: 'Triển khai image Docker',
        docker_desc: 'Bảng điều khiển chạy từ image container dựng sẵn. Cập nhật bằng cách kéo image mới từ GHCR, không qua cài đặt trong ứng dụng hay build lại Go.',
        docker_install_note: 'Cài đặt trong ứng dụng bị tắt trên Docker. Chạy các lệnh trên trên máy chủ, rồi làm mới trang này.',
        docker_update_available: 'Có image container mới',
        docker_sha_unknown: 'Đã cập nhật (commit image không rõ)',
        docker_images: 'Image',
        channel_stable: 'Ổn định (main)',
        channel_development: 'Phát triển (dev)'
    },
    id: {
        docker_title: 'Penyebaran image Docker',
        docker_desc: 'Konsol ini berjalan dari image kontainer yang sudah dibangun. Pembaruan diterapkan dengan menarik image lebih baru dari GHCR, bukan instalasi in-app atau build ulang Go.',
        docker_install_note: 'Instalasi in-app dinonaktifkan di Docker. Jalankan perintah di atas di host, lalu muat ulang halaman ini.',
        docker_update_available: 'Image kontainer baru tersedia',
        docker_sha_unknown: 'Terbaru (commit image tidak diketahui)',
        docker_images: 'Image',
        channel_stable: 'Stabil (main)',
        channel_development: 'Pengembangan (dev)'
    }
};

function patchFile(locale, patch) {
    const filePath = path.join(langDir, `${locale}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!data.updates) data.updates = {};
    let changed = 0;
    for (const [key, value] of Object.entries(patch)) {
        if (data.updates[key] !== value) {
            data.updates[key] = value;
            changed++;
        }
    }
    if (changed > 0) {
        fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        console.log(`patched ${locale}.json (${changed} keys)`);
    }
}

for (const [locale, patch] of Object.entries(patches)) {
    patchFile(locale, patch);
}
