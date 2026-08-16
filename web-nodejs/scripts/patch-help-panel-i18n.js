/**
 * One-shot: add help.panel.* and remove retired tutorial i18n keys across all locales.
 * Run from repo: node web-nodejs/scripts/patch-help-panel-i18n.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'lang');

const PANEL = {
    en: {
        title: 'Help & Supporters',
        thanks: 'BetterDesk is free and open source thanks to people and organizations who believe in self-hostable remote management. Thank you.',
        honorary: 'Honorary Supporters',
        backers: 'Individual Backers',
        sponsor_cta: 'Support the project',
        links: 'Useful links',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub repository',
        link_issues: 'Issues & feedback',
        link_sponsors_md: 'Full sponsors list',
        close: 'Close'
    },
    pl: {
        title: 'Pomoc i wspierający',
        thanks: 'BetterDesk jest darmowy i open source dzięki osobom i organizacjom, które wierzą w samodzielnie hostowane zarządzanie zdalne. Dziękujemy.',
        honorary: 'Wsparcie honorowe',
        backers: 'Indywidualni wspierający',
        sponsor_cta: 'Wesprzyj projekt',
        links: 'Przydatne linki',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repozytorium GitHub',
        link_issues: 'Issues i opinie',
        link_sponsors_md: 'Pełna lista sponsorów',
        close: 'Zamknij'
    },
    de: {
        title: 'Hilfe & Unterstützer',
        thanks: 'BetterDesk ist kostenlos und Open Source dank Menschen und Organisationen, die an selbst hostbare Fernverwaltung glauben. Danke.',
        honorary: 'Ehrenunterstützer',
        backers: 'Einzelne Unterstützer',
        sponsor_cta: 'Projekt unterstützen',
        links: 'Nützliche Links',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-Repository',
        link_issues: 'Issues & Feedback',
        link_sponsors_md: 'Vollständige Sponsorenliste',
        close: 'Schließen'
    },
    fr: {
        title: 'Aide et soutiens',
        thanks: 'BetterDesk est libre et open source grâce aux personnes et organisations qui croient en une gestion à distance auto-hébergée. Merci.',
        honorary: 'Soutiens honoraires',
        backers: 'Soutiens individuels',
        sponsor_cta: 'Soutenir le projet',
        links: 'Liens utiles',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Dépôt GitHub',
        link_issues: 'Issues et retours',
        link_sponsors_md: 'Liste complète des sponsors',
        close: 'Fermer'
    },
    es: {
        title: 'Ayuda y patrocinadores',
        thanks: 'BetterDesk es gratuito y de código abierto gracias a personas y organizaciones que creen en la gestión remota autoalojada. Gracias.',
        honorary: 'Patrocinadores honorarios',
        backers: 'Patrocinadores individuales',
        sponsor_cta: 'Apoyar el proyecto',
        links: 'Enlaces útiles',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repositorio de GitHub',
        link_issues: 'Issues y comentarios',
        link_sponsors_md: 'Lista completa de patrocinadores',
        close: 'Cerrar'
    },
    it: {
        title: 'Aiuto e sostenitori',
        thanks: 'BetterDesk è gratuito e open source grazie a persone e organizzazioni che credono nella gestione remota self-hosted. Grazie.',
        honorary: 'Sostenitori onorari',
        backers: 'Sostenitori individuali',
        sponsor_cta: 'Sostieni il progetto',
        links: 'Link utili',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repository GitHub',
        link_issues: 'Issue e feedback',
        link_sponsors_md: 'Elenco completo dei sponsor',
        close: 'Chiudi'
    },
    pt: {
        title: 'Ajuda e apoiadores',
        thanks: 'O BetterDesk é gratuito e open source graças a pessoas e organizações que acreditam em gestão remota auto-hospedada. Obrigado.',
        honorary: 'Apoiadores honorários',
        backers: 'Apoiadores individuais',
        sponsor_cta: 'Apoiar o projeto',
        links: 'Links úteis',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repositório GitHub',
        link_issues: 'Issues e feedback',
        link_sponsors_md: 'Lista completa de patrocinadores',
        close: 'Fechar'
    },
    nl: {
        title: 'Help & supporters',
        thanks: 'BetterDesk is gratis en open source dankzij mensen en organisaties die geloven in zelf-gehoste remote management. Dank je.',
        honorary: 'Ere-supporters',
        backers: 'Individuele supporters',
        sponsor_cta: 'Steun het project',
        links: 'Nuttige links',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-repository',
        link_issues: 'Issues & feedback',
        link_sponsors_md: 'Volledige sponsorslijst',
        close: 'Sluiten'
    },
    cs: {
        title: 'Nápověda a podporovatelé',
        thanks: 'BetterDesk je zdarma a open source díky lidem a organizacím, které věří v self-hostovanou vzdálenou správu. Děkujeme.',
        honorary: 'Čestní podporovatelé',
        backers: 'Individuální podporovatelé',
        sponsor_cta: 'Podpořit projekt',
        links: 'Užitečné odkazy',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repozitář GitHub',
        link_issues: 'Issues a zpětná vazba',
        link_sponsors_md: 'Úplný seznam sponzorů',
        close: 'Zavřít'
    },
    da: {
        title: 'Hjælp og støtter',
        thanks: 'BetterDesk er gratis og open source takket være mennesker og organisationer, der tror på selvhostet fjernstyring. Tak.',
        honorary: 'Æresstøtter',
        backers: 'Individuelle støtter',
        sponsor_cta: 'Støt projektet',
        links: 'Nyttige links',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-repository',
        link_issues: 'Issues og feedback',
        link_sponsors_md: 'Fuld sponsorliste',
        close: 'Luk'
    },
    fi: {
        title: 'Ohje ja tukijat',
        thanks: 'BetterDesk on ilmainen ja avointa lähdekoodia ihmisten ja organisaatioiden ansiosta, jotka uskovat itse isännöityyn etähallintaan. Kiitos.',
        honorary: 'Kunniatukijat',
        backers: 'Yksittäiset tukijat',
        sponsor_cta: 'Tue projektia',
        links: 'Hyödyllisiä linkkejä',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-repositorio',
        link_issues: 'Issues ja palaute',
        link_sponsors_md: 'Täydellinen sponsorilista',
        close: 'Sulje'
    },
    hu: {
        title: 'Súgó és támogatók',
        thanks: 'A BetterDesk ingyenes és nyílt forráskódú azoknak az embereknek és szervezeteknek köszönhetően, akik hisznek az önállóan üzemeltetett távoli kezelésben. Köszönjük.',
        honorary: 'Tiszteletbeli támogatók',
        backers: 'Egyéni támogatók',
        sponsor_cta: 'Támogasd a projektet',
        links: 'Hasznos hivatkozások',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-tárhely',
        link_issues: 'Issues és visszajelzés',
        link_sponsors_md: 'Teljes szponzorlista',
        close: 'Bezárás'
    },
    nb: {
        title: 'Hjelp og støttespillere',
        thanks: 'BetterDesk er gratis og åpen kildekode takket være mennesker og organisasjoner som tror på selvhostet fjernstyring. Takk.',
        honorary: 'Æresstøttespillere',
        backers: 'Individuelle støttespillere',
        sponsor_cta: 'Støtt prosjektet',
        links: 'Nyttige lenker',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-repositorium',
        link_issues: 'Issues og tilbakemeldinger',
        link_sponsors_md: 'Full sponsorliste',
        close: 'Lukk'
    },
    ro: {
        title: 'Ajutor și susținători',
        thanks: 'BetterDesk este gratuit și open source datorită oamenilor și organizațiilor care cred în managementul remote self-hosted. Mulțumim.',
        honorary: 'Susținători de onoare',
        backers: 'Susținători individuali',
        sponsor_cta: 'Susține proiectul',
        links: 'Linkuri utile',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repository GitHub',
        link_issues: 'Issues și feedback',
        link_sponsors_md: 'Lista completă de sponsori',
        close: 'Închide'
    },
    sv: {
        title: 'Hjälp och sponsorer',
        thanks: 'BetterDesk är gratis och öppen källkod tack vare människor och organisationer som tror på självhostad fjärrhantering. Tack.',
        honorary: 'Hederssponsorer',
        backers: 'Individuella sponsorer',
        sponsor_cta: 'Stöd projektet',
        links: 'Användbara länkar',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub-repository',
        link_issues: 'Issues och feedback',
        link_sponsors_md: 'Fullständig sponsorlista',
        close: 'Stäng'
    },
    tr: {
        title: 'Yardım ve destekçiler',
        thanks: 'BetterDesk, kendi barındırılan uzaktan yönetime inanan kişi ve kuruluşlar sayesinde ücretsiz ve açık kaynaktır. Teşekkürler.',
        honorary: 'Onur destekçileri',
        backers: 'Bireysel destekçiler',
        sponsor_cta: 'Projeyi destekle',
        links: 'Faydalı bağlantılar',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub deposu',
        link_issues: 'Issues ve geri bildirim',
        link_sponsors_md: 'Tam sponsor listesi',
        close: 'Kapat'
    },
    uk: {
        title: 'Довідка та спонсори',
        thanks: 'BetterDesk є безкоштовним і відкритим завдяки людям і організаціям, які вірять у самостійно розміщене віддалене керування. Дякуємо.',
        honorary: 'Почесні спонсори',
        backers: 'Індивідуальні спонсори',
        sponsor_cta: 'Підтримати проєкт',
        links: 'Корисні посилання',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Репозиторій GitHub',
        link_issues: 'Issues і відгуки',
        link_sponsors_md: 'Повний список спонсорів',
        close: 'Закрити'
    },
    ar: {
        title: 'المساعدة والداعمون',
        thanks: 'BetterDesk مجاني ومفتوح المصدر بفضل الأشخاص والمؤسسات الذين يؤمنون بالإدارة عن بُعد المستضافة ذاتيًا. شكرًا لكم.',
        honorary: 'داعمون فخريون',
        backers: 'داعمون أفراد',
        sponsor_cta: 'ادعم المشروع',
        links: 'روابط مفيدة',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'مستودع GitHub',
        link_issues: 'المشكلات والملاحظات',
        link_sponsors_md: 'قائمة الرعاة الكاملة',
        close: 'إغلاق'
    },
    hi: {
        title: 'सहायता और समर्थक',
        thanks: 'BetterDesk उन लोगों और संगठनों की बदौलत मुफ़्त और ओपन सोर्स है जो स्व-होस्टेड रिमोट प्रबंधन में विश्वास करते हैं। धन्यवाद।',
        honorary: 'मानद समर्थक',
        backers: 'व्यक्तिगत समर्थक',
        sponsor_cta: 'परियोजना का समर्थन करें',
        links: 'उपयोगी लिंक',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub रिपॉज़िटरी',
        link_issues: 'Issues और प्रतिक्रिया',
        link_sponsors_md: 'पूर्ण प्रायोजक सूची',
        close: 'बंद करें'
    },
    id: {
        title: 'Bantuan & pendukung',
        thanks: 'BetterDesk gratis dan open source berkat orang serta organisasi yang percaya pada manajemen jarak jauh yang dihosting sendiri. Terima kasih.',
        honorary: 'Pendukung kehormatan',
        backers: 'Pendukung individu',
        sponsor_cta: 'Dukung proyek',
        links: 'Tautan berguna',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Repositori GitHub',
        link_issues: 'Issues & masukan',
        link_sponsors_md: 'Daftar sponsor lengkap',
        close: 'Tutup'
    },
    ja: {
        title: 'ヘルプとサポーター',
        thanks: 'BetterDesk は、セルフホスト型のリモート管理を信じる人々と組織のおかげで無料のオープンソースです。ありがとうございます。',
        honorary: '名誉サポーター',
        backers: '個人サポーター',
        sponsor_cta: 'プロジェクトを支援',
        links: '便利なリンク',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub リポジトリ',
        link_issues: 'Issues とフィードバック',
        link_sponsors_md: 'スポンサー一覧',
        close: '閉じる'
    },
    ko: {
        title: '도움말 및 후원자',
        thanks: 'BetterDesk는 셀프호스팅 원격 관리를 믿는 사람들과 조직 덕분에 무료 오픈소스입니다. 감사합니다.',
        honorary: '명예 후원자',
        backers: '개인 후원자',
        sponsor_cta: '프로젝트 후원',
        links: '유용한 링크',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub 저장소',
        link_issues: 'Issues 및 피드백',
        link_sponsors_md: '전체 스폰서 목록',
        close: '닫기'
    },
    th: {
        title: 'ความช่วยเหลือและผู้สนับสนุน',
        thanks: 'BetterDesk เป็นซอฟต์แวร์ฟรีและโอเพนซอร์สด้วยผู้คนและองค์กรที่เชื่อในการจัดการระยะไกลแบบโฮสต์เอง ขอบคุณครับ',
        honorary: 'ผู้สนับสนุนกิตติมศักดิ์',
        backers: 'ผู้สนับสนุนรายบุคคล',
        sponsor_cta: 'สนับสนุนโครงการ',
        links: 'ลิงก์ที่เป็นประโยชน์',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'ที่เก็บ GitHub',
        link_issues: 'Issues และข้อเสนอแนะ',
        link_sponsors_md: 'รายชื่อสปอนเซอร์ทั้งหมด',
        close: 'ปิด'
    },
    vi: {
        title: 'Trợ giúp & nhà tài trợ',
        thanks: 'BetterDesk miễn phí và mã nguồn mở nhờ những người và tổ chức tin vào quản lý từ xa tự lưu trữ. Cảm ơn bạn.',
        honorary: 'Nhà tài trợ danh dự',
        backers: 'Nhà tài trợ cá nhân',
        sponsor_cta: 'Hỗ trợ dự án',
        links: 'Liên kết hữu ích',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'Kho GitHub',
        link_issues: 'Issues & phản hồi',
        link_sponsors_md: 'Danh sách nhà tài trợ đầy đủ',
        close: 'Đóng'
    },
    zh: {
        title: '帮助与支持者',
        thanks: 'BetterDesk 能保持免费开源，离不开相信自托管远程管理的个人与组织。感谢你们。',
        honorary: '荣誉支持者',
        backers: '个人支持者',
        sponsor_cta: '支持本项目',
        links: '实用链接',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub 仓库',
        link_issues: 'Issues 与反馈',
        link_sponsors_md: '完整赞助者列表',
        close: '关闭'
    },
    'zh-TW': {
        title: '說明與支持者',
        thanks: 'BetterDesk 能維持免費開源，多虧相信自行託管遠端管理的人們與組織。感謝你們。',
        honorary: '榮譽支持者',
        backers: '個人支持者',
        sponsor_cta: '支持本專案',
        links: '實用連結',
        link_sponsors: 'GitHub Sponsors',
        link_bmc: 'Buy Me a Coffee',
        link_repo: 'GitHub 儲存庫',
        link_issues: 'Issues 與回饋',
        link_sponsors_md: '完整贊助者清單',
        close: '關閉'
    }
};

const SETTINGS_TUTORIAL_KEYS = [
    'tutorials_title',
    'tutorials_desc',
    'tutorials_enabled',
    'tutorials_enabled_hint',
    'tutorials_reset_hint',
    'tutorials_enabled_toast',
    'tutorials_disabled_toast',
    'tutorials_reset_toast'
];

function patchFile(filePath) {
    const locale = path.basename(filePath, '.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (data.dashboard && Object.prototype.hasOwnProperty.call(data.dashboard, 'tip_tutorials')) {
        delete data.dashboard.tip_tutorials;
    }

    if (data.settings) {
        for (const k of SETTINGS_TUTORIAL_KEYS) {
            if (Object.prototype.hasOwnProperty.call(data.settings, k)) delete data.settings[k];
        }
        if (data.settings.confirm) {
            delete data.settings.confirm.tutorials_reset_title;
            delete data.settings.confirm.tutorials_reset;
        }
    }

    if (Object.prototype.hasOwnProperty.call(data, 'tutorial')) {
        delete data.tutorial;
    }

    if (!data.help) data.help = {};
    data.help.panel = PANEL[locale] || PANEL.en;

    fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + '\n', 'utf8');
    return locale;
}

const files = fs.readdirSync(LANG_DIR).filter((f) => f.endsWith('.json')).sort();
const done = [];
for (const f of files) {
    done.push(patchFile(path.join(LANG_DIR, f)));
}
console.log('Patched locales:', done.join(', '));
console.log('Count:', done.length);
