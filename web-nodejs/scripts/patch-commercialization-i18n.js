'use strict';

const fs = require('fs');
const path = require('path');
const sectionPatches = require('./commercialization-i18n-sections');

const langDir = path.join(__dirname, '..', 'lang');

const MERGE_SECTIONS = ['tabs', 'clock', 'stats', 'packages', 'sessions', 'reports', 'contracts', 'export', 'report', 'empty', 'assign', 'form'];

const patches = {
    en: {
        packages: { heading: 'Support packages' },
        contracts: {
            title: 'Organization contracts',
            new: 'Assign package',
            org: 'Organization',
            package: 'Package',
            remaining: 'Remaining minutes',
            status: 'Status',
            actions: 'Actions',
            suspend: 'Suspend',
            activate: 'Activate',
            select_org: 'Select organization',
            select_package: 'Select package',
            no_orgs: 'No organizations found',
            no_packages: 'Create a package first'
        },
        export: {
            csv: 'Export CSV',
            pdf: 'Export PDF',
            sessions_csv: 'Export sessions CSV'
        },
        report: {
            title: 'Work report',
            subtitle: 'Describe the work performed during this remote session.',
            category: 'Category',
            ticket_ref: 'Ticket reference',
            summary: 'Work performed',
            skip: 'Skip for now',
            submit: 'Submit report',
            summary_required: 'Summary is required',
            saved: 'Work report saved'
        },
        packages_extra: { prompt_name: 'Package name' }
    },
    pl: {
        packages: { heading: 'Pakiety wsparcia' },
        contracts: {
            title: 'Kontrakty organizacji',
            new: 'Przypisz pakiet',
            org: 'Organizacja',
            package: 'Pakiet',
            remaining: 'Pozostałe minuty',
            status: 'Status',
            actions: 'Akcje',
            suspend: 'Wstrzymaj',
            activate: 'Aktywuj',
            select_org: 'Wybierz organizację',
            select_package: 'Wybierz pakiet',
            no_orgs: 'Brak organizacji',
            no_packages: 'Najpierw utwórz pakiet'
        },
        export: {
            csv: 'Eksport CSV',
            pdf: 'Eksport PDF',
            sessions_csv: 'Eksport sesji CSV'
        },
        report: {
            title: 'Raport pracy',
            subtitle: 'Opisz wykonaną pracę podczas tej sesji zdalnej.',
            category: 'Kategoria',
            ticket_ref: 'Numer zgłoszenia',
            summary: 'Wykonana praca',
            skip: 'Pomiń na razie',
            submit: 'Wyślij raport',
            summary_required: 'Podsumowanie jest wymagane',
            saved: 'Raport pracy zapisany'
        },
        packages_extra: { prompt_name: 'Nazwa pakietu' }
    },
    de: {
        packages: { heading: 'Support-Pakete' },
        contracts: { title: 'Organisationsverträge', new: 'Paket zuweisen', org: 'Organisation', package: 'Paket', remaining: 'Verbleibende Minuten', status: 'Status', actions: 'Aktionen', suspend: 'Aussetzen', activate: 'Aktivieren', select_org: 'Organisation wählen', select_package: 'Paket wählen', no_orgs: 'Keine Organisationen gefunden', no_packages: 'Erstellen Sie zuerst ein Paket' },
        export: { csv: 'CSV exportieren', pdf: 'PDF exportieren', sessions_csv: 'Sitzungen als CSV exportieren' },
        report: { title: 'Arbeitsbericht', subtitle: 'Beschreiben Sie die während dieser Fernsitzung durchgeführte Arbeit.', category: 'Kategorie', ticket_ref: 'Ticket-Referenz', summary: 'Durchgeführte Arbeit', skip: 'Vorerst überspringen', submit: 'Bericht senden', summary_required: 'Zusammenfassung ist erforderlich', saved: 'Arbeitsbericht gespeichert' },
        packages_extra: { prompt_name: 'Paketname' }
    },
    fr: {
        packages: { heading: 'Forfaits de support' },
        contracts: { title: 'Contrats organisationnels', new: 'Assigner un forfait', org: 'Organisation', package: 'Forfait', remaining: 'Minutes restantes', status: 'Statut', actions: 'Actions', suspend: 'Suspendre', activate: 'Activer', select_org: 'Sélectionner une organisation', select_package: 'Sélectionner un forfait', no_orgs: 'Aucune organisation trouvée', no_packages: 'Créez d\'abord un forfait' },
        export: { csv: 'Exporter CSV', pdf: 'Exporter PDF', sessions_csv: 'Exporter les sessions CSV' },
        report: { title: 'Rapport de travail', subtitle: 'Décrivez le travail effectué pendant cette session à distance.', category: 'Catégorie', ticket_ref: 'Référence ticket', summary: 'Travail effectué', skip: 'Ignorer pour l\'instant', submit: 'Envoyer le rapport', summary_required: 'Le résumé est obligatoire', saved: 'Rapport de travail enregistré' },
        packages_extra: { prompt_name: 'Nom du forfait' }
    },
    es: {
        packages: { heading: 'Paquetes de soporte' },
        contracts: { title: 'Contratos de organización', new: 'Asignar paquete', org: 'Organización', package: 'Paquete', remaining: 'Minutos restantes', status: 'Estado', actions: 'Acciones', suspend: 'Suspender', activate: 'Activar', select_org: 'Seleccionar organización', select_package: 'Seleccionar paquete', no_orgs: 'No se encontraron organizaciones', no_packages: 'Cree un paquete primero' },
        export: { csv: 'Exportar CSV', pdf: 'Exportar PDF', sessions_csv: 'Exportar sesiones CSV' },
        report: { title: 'Informe de trabajo', subtitle: 'Describa el trabajo realizado durante esta sesión remota.', category: 'Categoría', ticket_ref: 'Referencia de ticket', summary: 'Trabajo realizado', skip: 'Omitir por ahora', submit: 'Enviar informe', summary_required: 'El resumen es obligatorio', saved: 'Informe de trabajo guardado' },
        packages_extra: { prompt_name: 'Nombre del paquete' }
    },
    cs: {
        packages: { heading: 'Balíčky podpory' },
        contracts: { title: 'Smlouvy organizací', new: 'Přiřadit balíček', org: 'Organizace', package: 'Balíček', remaining: 'Zbývající minuty', status: 'Stav', actions: 'Akce', suspend: 'Pozastavit', activate: 'Aktivovat', select_org: 'Vyberte organizaci', select_package: 'Vyberte balíček', no_orgs: 'Nebyly nalezeny žádné organizace', no_packages: 'Nejprve vytvořte balíček' },
        export: { csv: 'Exportovat CSV', pdf: 'Exportovat PDF', sessions_csv: 'Exportovat relace CSV' },
        report: { title: 'Pracovní zpráva', subtitle: 'Popište práci provedenou během této vzdálené relace.', category: 'Kategorie', ticket_ref: 'Reference ticketu', summary: 'Provedená práce', skip: 'Přeskočit nyní', submit: 'Odeslat zprávu', summary_required: 'Shrnutí je povinné', saved: 'Pracovní zpráva uložena' },
        packages_extra: { prompt_name: 'Název balíčku' }
    },
    da: {
        packages: { heading: 'Supportpakker' },
        contracts: { title: 'Organisationskontrakter', new: 'Tildel pakke', org: 'Organisation', package: 'Pakke', remaining: 'Resterende minutter', status: 'Status', actions: 'Handlinger', suspend: 'Suspender', activate: 'Aktiver', select_org: 'Vælg organisation', select_package: 'Vælg pakke', no_orgs: 'Ingen organisationer fundet', no_packages: 'Opret først en pakke' },
        export: { csv: 'Eksporter CSV', pdf: 'Eksporter PDF', sessions_csv: 'Eksporter sessioner CSV' },
        report: { title: 'Arbejdsrapport', subtitle: 'Beskriv arbejdet udført under denne fjernsession.', category: 'Kategori', ticket_ref: 'Ticketreference', summary: 'Udført arbejde', skip: 'Spring over for nu', submit: 'Send rapport', summary_required: 'Resumé er påkrævet', saved: 'Arbejdsrapport gemt' },
        packages_extra: { prompt_name: 'Pakkenavn' }
    },
    fi: {
        packages: { heading: 'Tukipaketit' },
        contracts: { title: 'Organisaatiosopimukset', new: 'Määritä paketti', org: 'Organisaatio', package: 'Paketti', remaining: 'Jäljellä olevat minuutit', status: 'Tila', actions: 'Toiminnot', suspend: 'Keskeytä', activate: 'Aktivoi', select_org: 'Valitse organisaatio', select_package: 'Valitse paketti', no_orgs: 'Organisaatioita ei löytynyt', no_packages: 'Luo ensin paketti' },
        export: { csv: 'Vie CSV', pdf: 'Vie PDF', sessions_csv: 'Vie istunnot CSV' },
        report: { title: 'Työraportti', subtitle: 'Kuvaile tämän etäistunnon aikana tehty työ.', category: 'Kategoria', ticket_ref: 'Tikettiviite', summary: 'Tehty työ', skip: 'Ohita toistaiseksi', submit: 'Lähetä raportti', summary_required: 'Yhteenveto vaaditaan', saved: 'Työraportti tallennettu' },
        packages_extra: { prompt_name: 'Paketin nimi' }
    },
    it: {
        packages: { heading: 'Pacchetti di supporto' },
        contracts: { title: 'Contratti organizzazione', new: 'Assegna pacchetto', org: 'Organizzazione', package: 'Pacchetto', remaining: 'Minuti rimanenti', status: 'Stato', actions: 'Azioni', suspend: 'Sospendi', activate: 'Attiva', select_org: 'Seleziona organizzazione', select_package: 'Seleziona pacchetto', no_orgs: 'Nessuna organizzazione trovata', no_packages: 'Crea prima un pacchetto' },
        export: { csv: 'Esporta CSV', pdf: 'Esporta PDF', sessions_csv: 'Esporta sessioni CSV' },
        report: { title: 'Report di lavoro', subtitle: 'Descrivi il lavoro svolto durante questa sessione remota.', category: 'Categoria', ticket_ref: 'Riferimento ticket', summary: 'Lavoro svolto', skip: 'Salta per ora', submit: 'Invia report', summary_required: 'Il riepilogo è obbligatorio', saved: 'Report di lavoro salvato' },
        packages_extra: { prompt_name: 'Nome pacchetto' }
    },
    nl: {
        packages: { heading: 'Supportpakketten' },
        contracts: { title: 'Organisatiecontracten', new: 'Pakket toewijzen', org: 'Organisatie', package: 'Pakket', remaining: 'Resterende minuten', status: 'Status', actions: 'Acties', suspend: 'Opschorten', activate: 'Activeren', select_org: 'Selecteer organisatie', select_package: 'Selecteer pakket', no_orgs: 'Geen organisaties gevonden', no_packages: 'Maak eerst een pakket aan' },
        export: { csv: 'Exporteer CSV', pdf: 'Exporteer PDF', sessions_csv: 'Exporteer sessies CSV' },
        report: { title: 'Werkrapport', subtitle: 'Beschrijf het uitgevoerde werk tijdens deze remote sessie.', category: 'Categorie', ticket_ref: 'Ticketreferentie', summary: 'Uitgevoerd werk', skip: 'Nu overslaan', submit: 'Rapport verzenden', summary_required: 'Samenvatting is verplicht', saved: 'Werkrapport opgeslagen' },
        packages_extra: { prompt_name: 'Pakketnaam' }
    },
    nb: {
        packages: { heading: 'Støttepakker' },
        contracts: { title: 'Organisasjonskontrakter', new: 'Tildel pakke', org: 'Organisasjon', package: 'Pakke', remaining: 'Gjenstående minutter', status: 'Status', actions: 'Handlinger', suspend: 'Suspender', activate: 'Aktiver', select_org: 'Velg organisasjon', select_package: 'Velg pakke', no_orgs: 'Ingen organisasjoner funnet', no_packages: 'Opprett en pakke først' },
        export: { csv: 'Eksporter CSV', pdf: 'Eksporter PDF', sessions_csv: 'Eksporter økter CSV' },
        report: { title: 'Arbeidsrapport', subtitle: 'Beskriv arbeidet utført under denne fjernøkten.', category: 'Kategori', ticket_ref: 'Saksreferanse', summary: 'Utført arbeid', skip: 'Hopp over nå', submit: 'Send rapport', summary_required: 'Sammendrag er påkrevd', saved: 'Arbeidsrapport lagret' },
        packages_extra: { prompt_name: 'Pakkenavn' }
    },
    sv: {
        packages: { heading: 'Supportpaket' },
        contracts: { title: 'Organisationsavtal', new: 'Tilldela paket', org: 'Organisation', package: 'Paket', remaining: 'Återstående minuter', status: 'Status', actions: 'Åtgärder', suspend: 'Suspendera', activate: 'Aktivera', select_org: 'Välj organisation', select_package: 'Välj paket', no_orgs: 'Inga organisationer hittades', no_packages: 'Skapa ett paket först' },
        export: { csv: 'Exportera CSV', pdf: 'Exportera PDF', sessions_csv: 'Exportera sessioner CSV' },
        report: { title: 'Arbetsrapport', subtitle: 'Beskriv arbetet som utfördes under denna fjärrsession.', category: 'Kategori', ticket_ref: 'Ärendereferens', summary: 'Utfört arbete', skip: 'Hoppa över nu', submit: 'Skicka rapport', summary_required: 'Sammanfattning krävs', saved: 'Arbetsrapport sparad' },
        packages_extra: { prompt_name: 'Paketnamn' }
    },
    pt: {
        packages: { heading: 'Pacotes de suporte' },
        contracts: { title: 'Contratos de organização', new: 'Atribuir pacote', org: 'Organização', package: 'Pacote', remaining: 'Minutos restantes', status: 'Estado', actions: 'Ações', suspend: 'Suspender', activate: 'Ativar', select_org: 'Selecionar organização', select_package: 'Selecionar pacote', no_orgs: 'Nenhuma organização encontrada', no_packages: 'Crie um pacote primeiro' },
        export: { csv: 'Exportar CSV', pdf: 'Exportar PDF', sessions_csv: 'Exportar sessões CSV' },
        report: { title: 'Relatório de trabalho', subtitle: 'Descreva o trabalho realizado durante esta sessão remota.', category: 'Categoria', ticket_ref: 'Referência do ticket', summary: 'Trabalho realizado', skip: 'Ignorar por agora', submit: 'Enviar relatório', summary_required: 'O resumo é obrigatório', saved: 'Relatório de trabalho guardado' },
        packages_extra: { prompt_name: 'Nome do pacote' }
    },
    ro: {
        packages: { heading: 'Pachete de suport' },
        contracts: { title: 'Contracte organizație', new: 'Atribuie pachet', org: 'Organizație', package: 'Pachet', remaining: 'Minute rămase', status: 'Stare', actions: 'Acțiuni', suspend: 'Suspendă', activate: 'Activează', select_org: 'Selectează organizația', select_package: 'Selectează pachetul', no_orgs: 'Nu s-au găsit organizații', no_packages: 'Creați mai întâi un pachet' },
        export: { csv: 'Export CSV', pdf: 'Export PDF', sessions_csv: 'Export sesiuni CSV' },
        report: { title: 'Raport de lucru', subtitle: 'Descrieți munca efectuată în timpul acestei sesiuni la distanță.', category: 'Categorie', ticket_ref: 'Referință tichet', summary: 'Lucru efectuat', skip: 'Omite deocamdată', submit: 'Trimite raport', summary_required: 'Rezumatul este obligatoriu', saved: 'Raport de lucru salvat' },
        packages_extra: { prompt_name: 'Nume pachet' }
    },
    hu: {
        packages: { heading: 'Támogatási csomagok' },
        contracts: { title: 'Szervezeti szerződések', new: 'Csomag hozzárendelése', org: 'Szervezet', package: 'Csomag', remaining: 'Hátralévő percek', status: 'Állapot', actions: 'Műveletek', suspend: 'Felfüggesztés', activate: 'Aktiválás', select_org: 'Válasszon szervezetet', select_package: 'Válasszon csomagot', no_orgs: 'Nem található szervezet', no_packages: 'Először hozzon létre csomagot' },
        export: { csv: 'CSV export', pdf: 'PDF export', sessions_csv: 'Munkamenetek CSV export' },
        report: { title: 'Munkajelentés', subtitle: 'Írja le a távoli munkamenet során elvégzett munkát.', category: 'Kategória', ticket_ref: 'Jegy hivatkozás', summary: 'Elvégzett munka', skip: 'Kihagyás most', submit: 'Jelentés küldése', summary_required: 'Az összefoglaló kötelező', saved: 'Munkajelentés mentve' },
        packages_extra: { prompt_name: 'Csomag neve' }
    },
    uk: {
        packages: { heading: 'Пакети підтримки' },
        contracts: { title: 'Контракти організацій', new: 'Призначити пакет', org: 'Організація', package: 'Пакет', remaining: 'Залишок хвилин', status: 'Статус', actions: 'Дії', suspend: 'Призупинити', activate: 'Активувати', select_org: 'Оберіть організацію', select_package: 'Оберіть пакет', no_orgs: 'Організації не знайдено', no_packages: 'Спочатку створіть пакет' },
        export: { csv: 'Експорт CSV', pdf: 'Експорт PDF', sessions_csv: 'Експорт сесій CSV' },
        report: { title: 'Звіт про роботу', subtitle: 'Опишіть роботу, виконану під час цієї віддаленої сесії.', category: 'Категорія', ticket_ref: 'Посилання на заявку', summary: 'Виконана робота', skip: 'Пропустити зараз', submit: 'Надіслати звіт', summary_required: 'Підсумок обов\'язковий', saved: 'Звіт про роботу збережено' },
        packages_extra: { prompt_name: 'Назва пакета' }
    },
    ru: {},
    tr: {
        packages: { heading: 'Destek paketleri' },
        contracts: { title: 'Kuruluş sözleşmeleri', new: 'Paket ata', org: 'Kuruluş', package: 'Paket', remaining: 'Kalan dakika', status: 'Durum', actions: 'İşlemler', suspend: 'Askıya al', activate: 'Etkinleştir', select_org: 'Kuruluş seçin', select_package: 'Paket seçin', no_orgs: 'Kuruluş bulunamadı', no_packages: 'Önce bir paket oluşturun' },
        export: { csv: 'CSV dışa aktar', pdf: 'PDF dışa aktar', sessions_csv: 'Oturumları CSV dışa aktar' },
        report: { title: 'İş raporu', subtitle: 'Bu uzaktan oturum sırasında yapılan işi açıklayın.', category: 'Kategori', ticket_ref: 'Bilet referansı', summary: 'Yapılan iş', skip: 'Şimdilik atla', submit: 'Rapor gönder', summary_required: 'Özet gerekli', saved: 'İş raporu kaydedildi' },
        packages_extra: { prompt_name: 'Paket adı' }
    },
    ja: {
        packages: { heading: 'サポートパッケージ' },
        contracts: { title: '組織契約', new: 'パッケージを割り当て', org: '組織', package: 'パッケージ', remaining: '残り分数', status: 'ステータス', actions: '操作', suspend: '一時停止', activate: '有効化', select_org: '組織を選択', select_package: 'パッケージを選択', no_orgs: '組織が見つかりません', no_packages: '先にパッケージを作成してください' },
        export: { csv: 'CSVエクスポート', pdf: 'PDFエクスポート', sessions_csv: 'セッションCSVエクスポート' },
        report: { title: '作業レポート', subtitle: 'このリモートセッション中に行った作業を説明してください。', category: 'カテゴリ', ticket_ref: 'チケット参照', summary: '実施した作業', skip: '今はスキップ', submit: 'レポートを送信', summary_required: '概要は必須です', saved: '作業レポートを保存しました' },
        packages_extra: { prompt_name: 'パッケージ名' }
    },
    ko: {
        packages: { heading: '지원 패키지' },
        contracts: { title: '조직 계약', new: '패키지 할당', org: '조직', package: '패키지', remaining: '남은 분', status: '상태', actions: '작업', suspend: '일시 중지', activate: '활성화', select_org: '조직 선택', select_package: '패키지 선택', no_orgs: '조직을 찾을 수 없습니다', no_packages: '먼저 패키지를 만드세요' },
        export: { csv: 'CSV 내보내기', pdf: 'PDF 내보내기', sessions_csv: '세션 CSV 내보내기' },
        report: { title: '작업 보고서', subtitle: '이 원격 세션 동안 수행한 작업을 설명하세요.', category: '카테고리', ticket_ref: '티켓 참조', summary: '수행한 작업', skip: '지금 건너뛰기', submit: '보고서 제출', summary_required: '요약은 필수입니다', saved: '작업 보고서가 저장되었습니다' },
        packages_extra: { prompt_name: '패키지 이름' }
    },
    zh: {
        packages: { heading: '支持套餐' },
        contracts: { title: '组织合同', new: '分配套餐', org: '组织', package: '套餐', remaining: '剩余分钟', status: '状态', actions: '操作', suspend: '暂停', activate: '激活', select_org: '选择组织', select_package: '选择套餐', no_orgs: '未找到组织', no_packages: '请先创建套餐' },
        export: { csv: '导出 CSV', pdf: '导出 PDF', sessions_csv: '导出会话 CSV' },
        report: { title: '工作报告', subtitle: '描述此远程会话期间执行的工作。', category: '类别', ticket_ref: '工单参考', summary: '执行的工作', skip: '暂时跳过', submit: '提交报告', summary_required: '摘要为必填项', saved: '工作报告已保存' },
        packages_extra: { prompt_name: '套餐名称' }
    },
    'zh-TW': {
        packages: { heading: '支援套件' },
        contracts: { title: '組織合約', new: '指派套件', org: '組織', package: '套件', remaining: '剩餘分鐘', status: '狀態', actions: '操作', suspend: '暫停', activate: '啟用', select_org: '選擇組織', select_package: '選擇套件', no_orgs: '找不到組織', no_packages: '請先建立套件' },
        export: { csv: '匯出 CSV', pdf: '匯出 PDF', sessions_csv: '匯出工作階段 CSV' },
        report: { title: '工作報告', subtitle: '描述此遠端工作階段期間執行的工作。', category: '類別', ticket_ref: '工單參考', summary: '執行的工作', skip: '暫時略過', submit: '提交報告', summary_required: '摘要為必填', saved: '工作報告已儲存' },
        packages_extra: { prompt_name: '套件名稱' }
    },
    ar: {
        packages: { heading: 'حزم الدعم' },
        contracts: { title: 'عقود المنظمات', new: 'تعيين حزمة', org: 'المنظمة', package: 'الحزمة', remaining: 'الدقائق المتبقية', status: 'الحالة', actions: 'الإجراءات', suspend: 'تعليق', activate: 'تفعيل', select_org: 'اختر المنظمة', select_package: 'اختر الحزمة', no_orgs: 'لم يتم العثور على منظمات', no_packages: 'أنشئ حزمة أولاً' },
        export: { csv: 'تصدير CSV', pdf: 'تصدير PDF', sessions_csv: 'تصدير الجلسات CSV' },
        report: { title: 'تقرير العمل', subtitle: 'صف العمل الذي تم خلال جلسة التحكم عن بُعد هذه.', category: 'الفئة', ticket_ref: 'مرجع التذكرة', summary: 'العمل المنجز', skip: 'تخطي الآن', submit: 'إرسال التقرير', summary_required: 'الملخص مطلوب', saved: 'تم حفظ تقرير العمل' },
        packages_extra: { prompt_name: 'اسم الحزمة' }
    },
    hi: {
        packages: { heading: 'सहायता पैकेज' },
        contracts: { title: 'संगठन अनुबंध', new: 'पैकेज असाइन करें', org: 'संगठन', package: 'पैकेज', remaining: 'शेष मिनट', status: 'स्थिति', actions: 'कार्रवाइयाँ', suspend: 'निलंबित', activate: 'सक्रिय', select_org: 'संगठन चुनें', select_package: 'पैकेज चुनें', no_orgs: 'कोई संगठन नहीं मिला', no_packages: 'पहले एक पैकेज बनाएं' },
        export: { csv: 'CSV निर्यात', pdf: 'PDF निर्यात', sessions_csv: 'सत्र CSV निर्यात' },
        report: { title: 'कार्य रिपोर्ट', subtitle: 'इस रिमोट सत्र के दौरान किए गए कार्य का वर्णन करें।', category: 'श्रेणी', ticket_ref: 'टिकट संदर्भ', summary: 'किया गया कार्य', skip: 'अभी छोड़ें', submit: 'रिपोर्ट भेजें', summary_required: 'सारांश आवश्यक है', saved: 'कार्य रिपोर्ट सहेजी गई' },
        packages_extra: { prompt_name: 'पैकेज का नाम' }
    },
    id: {
        packages: { heading: 'Paket dukungan' },
        contracts: { title: 'Kontrak organisasi', new: 'Tetapkan paket', org: 'Organisasi', package: 'Paket', remaining: 'Menit tersisa', status: 'Status', actions: 'Tindakan', suspend: 'Tangguhkan', activate: 'Aktifkan', select_org: 'Pilih organisasi', select_package: 'Pilih paket', no_orgs: 'Organisasi tidak ditemukan', no_packages: 'Buat paket terlebih dahulu' },
        export: { csv: 'Ekspor CSV', pdf: 'Ekspor PDF', sessions_csv: 'Ekspor sesi CSV' },
        report: { title: 'Laporan kerja', subtitle: 'Jelaskan pekerjaan yang dilakukan selama sesi jarak jauh ini.', category: 'Kategori', ticket_ref: 'Referensi tiket', summary: 'Pekerjaan yang dilakukan', skip: 'Lewati untuk sekarang', submit: 'Kirim laporan', summary_required: 'Ringkasan wajib diisi', saved: 'Laporan kerja disimpan' },
        packages_extra: { prompt_name: 'Nama paket' }
    },
    vi: {
        packages: { heading: 'Gói hỗ trợ' },
        contracts: { title: 'Hợp đồng tổ chức', new: 'Gán gói', org: 'Tổ chức', package: 'Gói', remaining: 'Phút còn lại', status: 'Trạng thái', actions: 'Thao tác', suspend: 'Tạm ngưng', activate: 'Kích hoạt', select_org: 'Chọn tổ chức', select_package: 'Chọn gói', no_orgs: 'Không tìm thấy tổ chức', no_packages: 'Hãy tạo gói trước' },
        export: { csv: 'Xuất CSV', pdf: 'Xuất PDF', sessions_csv: 'Xuất phiên CSV' },
        report: { title: 'Báo cáo công việc', subtitle: 'Mô tả công việc đã thực hiện trong phiên điều khiển từ xa này.', category: 'Danh mục', ticket_ref: 'Tham chiếu ticket', summary: 'Công việc đã thực hiện', skip: 'Bỏ qua bây giờ', submit: 'Gửi báo cáo', summary_required: 'Tóm tắt là bắt buộc', saved: 'Đã lưu báo cáo công việc' },
        packages_extra: { prompt_name: 'Tên gói' }
    },
    th: {
        packages: { heading: 'แพ็กเกจสนับสนุน' },
        contracts: { title: 'สัญญาองค์กร', new: 'กำหนดแพ็กเกจ', org: 'องค์กร', package: 'แพ็กเกจ', remaining: 'นาทีที่เหลือ', status: 'สถานะ', actions: 'การดำเนินการ', suspend: 'ระงับ', activate: 'เปิดใช้งาน', select_org: 'เลือกองค์กร', select_package: 'เลือกแพ็กเกจ', no_orgs: 'ไม่พบองค์กร', no_packages: 'สร้างแพ็กเกจก่อน' },
        export: { csv: 'ส่งออก CSV', pdf: 'ส่งออก PDF', sessions_csv: 'ส่งออกเซสชัน CSV' },
        report: { title: 'รายงานการทำงาน', subtitle: 'อธิบายงานที่ทำระหว่างเซสชันรีโมตนี้', category: 'หมวดหมู่', ticket_ref: 'อ้างอิงตั๋ว', summary: 'งานที่ทำ', skip: 'ข้ามไปก่อน', submit: 'ส่งรายงาน', summary_required: 'ต้องมีสรุป', saved: 'บันทึกรายงานการทำงานแล้ว' },
        packages_extra: { prompt_name: 'ชื่อแพ็กเกจ' }
    }
};

function deepMerge(target, source) {
    for (const [k, v] of Object.entries(source)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            target[k] = target[k] || {};
            deepMerge(target[k], v);
        } else {
            target[k] = v;
        }
    }
}

function buildPatch(locale) {
    const base = patches[locale] || patches.en;
    const sections = sectionPatches[locale] || {};
    const merged = { ...base };
    for (const key of MERGE_SECTIONS) {
        if (sections[key]) {
            merged[key] = { ...(merged[key] || {}), ...sections[key] };
        }
    }
    return merged;
}

function applyCommercializationPatches() {
    let count = 0;
    for (const file of fs.readdirSync(langDir).filter((f) => f.endsWith('.json'))) {
        const locale = file.replace('.json', '');
        if (locale === 'en') continue;

        const filePath = path.join(langDir, file);
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!json.commercialization) continue;

        const patch = buildPatch(locale);
        for (const section of MERGE_SECTIONS) {
            if (!patch[section]) continue;
            json.commercialization[section] = { ...(json.commercialization[section] || {}), ...patch[section] };
        }
        if (patch.packages_extra) {
            deepMerge(json.commercialization.packages, patch.packages_extra);
        }

        fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
        console.log('patched', file);
        count++;
    }
    return count;
}

if (require.main === module) {
    const count = applyCommercializationPatches();
    if (count === 0) {
        console.error('No commercialization locale files patched.');
        process.exit(1);
    }
}

module.exports = { applyCommercializationPatches, buildPatch, deepMerge };
