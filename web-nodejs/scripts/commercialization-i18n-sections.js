'use strict';

/** Shared UI sections for commercialization — merged into every non-en locale by patch-commercialization-i18n.js */
module.exports = {
    ar: {
        tabs: { overview: 'نظرة عامة', packages: 'الحزم والعقود', sessions: 'الجلسات', reports: 'التقارير', settings: 'إعدادات متقدمة' },
        clock: { title: 'وقت الخادم (NTP)', check_now: 'تحقق الآن', unsynced: 'ساعة الخادم غير متزامنة — قد تُحظر الجلسات القابلة للفوترة' },
        stats: { active_sessions: 'جلسات قابلة للفوترة نشطة' },
        packages: { new: 'حزمة جديدة', name: 'الاسم', included_minutes: 'الدقائق المضمنة', overage_rate: 'سعر التجاوز / س', currency: 'العملة', create_title: 'حزمة جديدة للمنظمة', create_submit: 'إنشاء حزمة', select_org: 'المنظمة', select_org_placeholder: 'اختر المنظمة…' },
        sessions: { device: 'الجهاز', operator: 'المشغّل', duration: 'المدة', phase: 'المرحلة', amount: 'المبلغ' },
        reports: { session: 'الجلسة', summary: 'الملخص', date: 'التاريخ' },
        empty: { packages: 'لا توجد حزم بعد. أنشئ واحدة بالزر أعلاه.', contracts: 'لا توجد عقود منظمات بعد. عيّن حزمة لمنظمة.', sessions: 'لم تُسجَّل جلسات قابلة للفوترة بعد.', reports: 'لم تُرسَل تقارير عمل بعد.' },
        assign: { title: 'تعيين حزمة موجودة', submit: 'تعيين' },
        form: { cancel: 'إلغاء' }
    },
    cs: {
        tabs: { overview: 'Přehled', packages: 'Balíčky a smlouvy', sessions: 'Relace', reports: 'Reporty', settings: 'Pokročilá nastavení' },
        clock: { title: 'Čas serveru (NTP)', check_now: 'Zkontrolovat', unsynced: 'Hodiny serveru nejsou synchronizovány — fakturovatelné relace mohou být blokovány' },
        stats: { active_sessions: 'Aktivní fakturovatelné relace' },
        packages: { new: 'Nový balíček', name: 'Název', included_minutes: 'Zahrnuté minuty', overage_rate: 'Sazba překročení / h', currency: 'Měna', create_title: 'Nový balíček pro organizaci', create_submit: 'Vytvořit balíček', select_org: 'Organizace', select_org_placeholder: 'Vyberte organizaci…' },
        sessions: { device: 'Zařízení', operator: 'Operátor', duration: 'Trvání', phase: 'Fáze', amount: 'Částka' },
        reports: { session: 'Relace', summary: 'Shrnutí', date: 'Datum' },
        empty: { packages: 'Zatím žádné balíčky. Vytvořte první tlačítkem výše.', contracts: 'Zatím žádné smlouvy organizací. Přiřaďte balíček organizaci.', sessions: 'Zatím nejsou zaznamenány fakturovatelné relace.', reports: 'Zatím nebyly odeslány pracovní zprávy.' },
        assign: { title: 'Přiřadit existující balíček', submit: 'Přiřadit' },
        form: { cancel: 'Zrušit' }
    },
    da: {
        tabs: { overview: 'Overblik', packages: 'Pakker og kontrakter', sessions: 'Sessioner', reports: 'Rapporter', settings: 'Avancerede indstillinger' },
        clock: { title: 'Servertid (NTP)', check_now: 'Tjek nu', unsynced: 'Serveruret er ikke synkroniseret — fakturerbare sessioner kan blive blokeret' },
        stats: { active_sessions: 'Aktive fakturerbare sessioner' },
        packages: { new: 'Ny pakke', name: 'Navn', included_minutes: 'Inkluderede minutter', overage_rate: 'Overforbrugssats / t', currency: 'Valuta', create_title: 'Ny pakke til organisation', create_submit: 'Opret pakke', select_org: 'Organisation', select_org_placeholder: 'Vælg organisation…' },
        sessions: { device: 'Enhed', operator: 'Operatør', duration: 'Varighed', phase: 'Fase', amount: 'Beløb' },
        reports: { session: 'Session', summary: 'Resumé', date: 'Dato' },
        empty: { packages: 'Ingen pakker endnu. Opret en med knappen ovenfor.', contracts: 'Ingen organisationskontrakter endnu. Tildel en pakke til en organisation.', sessions: 'Ingen fakturerbare sessioner registreret endnu.', reports: 'Ingen arbejdsrapporter indsendt endnu.' },
        assign: { title: 'Tildel eksisterende pakke', submit: 'Tildel' },
        form: { cancel: 'Annuller' }
    },
    de: {
        tabs: { overview: 'Übersicht', packages: 'Pakete & Verträge', sessions: 'Sitzungen', reports: 'Berichte', settings: 'Erweiterte Einstellungen' },
        clock: { title: 'Serverzeit (NTP)', check_now: 'Jetzt prüfen', unsynced: 'Serveruhr nicht synchronisiert — abrechenbare Sitzungen können blockiert werden' },
        stats: { active_sessions: 'Aktive abrechenbare Sitzungen' },
        packages: { new: 'Neues Paket', name: 'Name', included_minutes: 'Enthaltene Minuten', overage_rate: 'Überziehungssatz / h', currency: 'Währung', create_title: 'Neues Paket für Organisation', create_submit: 'Paket erstellen', select_org: 'Organisation', select_org_placeholder: 'Organisation wählen…' },
        sessions: { device: 'Gerät', operator: 'Operator', duration: 'Dauer', phase: 'Phase', amount: 'Betrag' },
        reports: { session: 'Sitzung', summary: 'Zusammenfassung', date: 'Datum' },
        empty: { packages: 'Noch keine Pakete. Erstellen Sie eines mit der Schaltfläche oben.', contracts: 'Noch keine Organisationsverträge. Weisen Sie einer Organisation ein Paket zu.', sessions: 'Noch keine abrechenbaren Sitzungen erfasst.', reports: 'Noch keine Arbeitsberichte eingereicht.' },
        assign: { title: 'Vorhandenes Paket zuweisen', submit: 'Zuweisen' },
        form: { cancel: 'Abbrechen' }
    },
    es: {
        tabs: { overview: 'Resumen', packages: 'Paquetes y contratos', sessions: 'Sesiones', reports: 'Informes', settings: 'Configuración avanzada' },
        clock: { title: 'Hora del servidor (NTP)', check_now: 'Comprobar ahora', unsynced: 'El reloj del servidor no está sincronizado — las sesiones facturables pueden bloquearse' },
        stats: { active_sessions: 'Sesiones facturables activas' },
        packages: { new: 'Nuevo paquete', name: 'Nombre', included_minutes: 'Minutos incluidos', overage_rate: 'Tarifa de exceso / h', currency: 'Moneda', create_title: 'Nuevo paquete para organización', create_submit: 'Crear paquete', select_org: 'Organización', select_org_placeholder: 'Seleccionar organización…' },
        sessions: { device: 'Dispositivo', operator: 'Operador', duration: 'Duración', phase: 'Fase', amount: 'Importe' },
        reports: { session: 'Sesión', summary: 'Resumen', date: 'Fecha' },
        empty: { packages: 'Aún no hay paquetes. Cree uno con el botón de arriba.', contracts: 'Aún no hay contratos de organización. Asigne un paquete a una organización.', sessions: 'Aún no hay sesiones facturables registradas.', reports: 'Aún no se han enviado informes de trabajo.' },
        assign: { title: 'Asignar paquete existente', submit: 'Asignar' },
        form: { cancel: 'Cancelar' }
    },
    fi: {
        tabs: { overview: 'Yleiskatsaus', packages: 'Paketit ja sopimukset', sessions: 'Istunnot', reports: 'Raportit', settings: 'Lisäasetukset' },
        clock: { title: 'Palvelinaika (NTP)', check_now: 'Tarkista nyt', unsynced: 'Palvelimen kello ei ole synkronoitu — laskutettavat istunnot voidaan estää' },
        stats: { active_sessions: 'Aktiiviset laskutettavat istunnot' },
        packages: { new: 'Uusi paketti', name: 'Nimi', included_minutes: 'Sisältyvät minuutit', overage_rate: 'Ylityshinta / h', currency: 'Valuutta', create_title: 'Uusi paketti organisaatiolle', create_submit: 'Luo paketti', select_org: 'Organisaatio', select_org_placeholder: 'Valitse organisaatio…' },
        sessions: { device: 'Laite', operator: 'Operaattori', duration: 'Kesto', phase: 'Vaihe', amount: 'Summa' },
        reports: { session: 'Istunto', summary: 'Yhteenveto', date: 'Päivämäärä' },
        empty: { packages: 'Ei paketteja vielä. Luo ensimmäinen yllä olevalla painikkeella.', contracts: 'Ei organisaatiosopimuksia vielä. Määritä paketti organisaatiolle.', sessions: 'Ei laskutettavia istuntoja vielä.', reports: 'Ei työraportteja vielä.' },
        assign: { title: 'Määritä olemassa oleva paketti', submit: 'Määritä' },
        form: { cancel: 'Peruuta' }
    },
    fr: {
        tabs: { overview: 'Aperçu', packages: 'Forfaits et contrats', sessions: 'Sessions', reports: 'Rapports', settings: 'Paramètres avancés' },
        clock: { title: 'Heure serveur (NTP)', check_now: 'Vérifier', unsynced: 'L\'horloge du serveur n\'est pas synchronisée — les sessions facturables peuvent être bloquées' },
        stats: { active_sessions: 'Sessions facturables actives' },
        packages: { new: 'Nouveau forfait', name: 'Nom', included_minutes: 'Minutes incluses', overage_rate: 'Tarif dépassement / h', currency: 'Devise', create_title: 'Nouveau forfait pour l\'organisation', create_submit: 'Créer le forfait', select_org: 'Organisation', select_org_placeholder: 'Sélectionner une organisation…' },
        sessions: { device: 'Appareil', operator: 'Opérateur', duration: 'Durée', phase: 'Phase', amount: 'Montant' },
        reports: { session: 'Session', summary: 'Résumé', date: 'Date' },
        empty: { packages: 'Aucun forfait pour l\'instant. Créez-en un avec le bouton ci-dessus.', contracts: 'Aucun contrat d\'organisation pour l\'instant. Assignez un forfait à une organisation.', sessions: 'Aucune session facturable enregistrée.', reports: 'Aucun rapport de travail soumis.' },
        assign: { title: 'Assigner un forfait existant', submit: 'Assigner' },
        form: { cancel: 'Annuler' }
    },
    hi: {
        tabs: { overview: 'अवलोकन', packages: 'पैकेज और अनुबंध', sessions: 'सत्र', reports: 'रिपोर्ट', settings: 'उन्नत सेटिंग्स' },
        clock: { title: 'सर्वर समय (NTP)', check_now: 'अभी जाँचें', unsynced: 'सर्वर घड़ी सिंक नहीं है — बिल योग्य सत्र अवरुद्ध हो सकते हैं' },
        stats: { active_sessions: 'सक्रिय बिल योग्य सत्र' },
        packages: { new: 'नया पैकेज', name: 'नाम', included_minutes: 'शामिल मिनट', overage_rate: 'अतिरिक्त दर / घं', currency: 'मुद्रा', create_title: 'संगठन के लिए नया पैकेज', create_submit: 'पैकेज बनाएं', select_org: 'संगठन', select_org_placeholder: 'संगठन चुनें…' },
        sessions: { device: 'डिवाइस', operator: 'ऑपरेटर', duration: 'अवधि', phase: 'चरण', amount: 'राशि' },
        reports: { session: 'सत्र', summary: 'सारांश', date: 'तारीख' },
        empty: { packages: 'अभी कोई पैकेज नहीं। ऊपर के बटन से एक बनाएं।', contracts: 'अभी कोई संगठन अनुबंध नहीं। किसी संगठन को पैकेज असाइन करें।', sessions: 'अभी कोई बिल योग्य सत्र दर्ज नहीं।', reports: 'अभी कोई कार्य रिपोर्ट नहीं।' },
        assign: { title: 'मौजूदा पैकेज असाइन करें', submit: 'असाइन करें' },
        form: { cancel: 'रद्द करें' }
    },
    hu: {
        tabs: { overview: 'Áttekintés', packages: 'Csomagok és szerződések', sessions: 'Munkamenetek', reports: 'Jelentések', settings: 'Speciális beállítások' },
        clock: { title: 'Szerveridő (NTP)', check_now: 'Ellenőrzés', unsynced: 'A szerver órája nincs szinkronban — a számlázható munkamenetek blokkolva lehetnek' },
        stats: { active_sessions: 'Aktív számlázható munkamenetek' },
        packages: { new: 'Új csomag', name: 'Név', included_minutes: 'Tartalmazott percek', overage_rate: 'Túllépési díj / ó', currency: 'Pénznem', create_title: 'Új csomag szervezetnek', create_submit: 'Csomag létrehozása', select_org: 'Szervezet', select_org_placeholder: 'Válasszon szervezetet…' },
        sessions: { device: 'Eszköz', operator: 'Operátor', duration: 'Időtartam', phase: 'Fázis', amount: 'Összeg' },
        reports: { session: 'Munkamenet', summary: 'Összefoglaló', date: 'Dátum' },
        empty: { packages: 'Még nincsenek csomagok. Hozzon létre egyet a fenti gombbal.', contracts: 'Még nincsenek szervezeti szerződések. Rendeljen csomagot szervezethez.', sessions: 'Még nincsenek rögzített számlázható munkamenetek.', reports: 'Még nincsenek beküldött munkajelentések.' },
        assign: { title: 'Meglévő csomag hozzárendelése', submit: 'Hozzárendelés' },
        form: { cancel: 'Mégse' }
    },
    id: {
        tabs: { overview: 'Ikhtisar', packages: 'Paket & kontrak', sessions: 'Sesi', reports: 'Laporan', settings: 'Pengaturan lanjutan' },
        clock: { title: 'Waktu server (NTP)', check_now: 'Periksa sekarang', unsynced: 'Jam server tidak tersinkron — sesi berbayar dapat diblokir' },
        stats: { active_sessions: 'Sesi berbayar aktif' },
        packages: { new: 'Paket baru', name: 'Nama', included_minutes: 'Menit termasuk', overage_rate: 'Tarif kelebihan / j', currency: 'Mata uang', create_title: 'Paket baru untuk organisasi', create_submit: 'Buat paket', select_org: 'Organisasi', select_org_placeholder: 'Pilih organisasi…' },
        sessions: { device: 'Perangkat', operator: 'Operator', duration: 'Durasi', phase: 'Fase', amount: 'Jumlah' },
        reports: { session: 'Sesi', summary: 'Ringkasan', date: 'Tanggal' },
        empty: { packages: 'Belum ada paket. Buat dengan tombol di atas.', contracts: 'Belum ada kontrak organisasi. Tetapkan paket ke organisasi.', sessions: 'Belum ada sesi berbayar tercatat.', reports: 'Belum ada laporan kerja.' },
        assign: { title: 'Tetapkan paket yang ada', submit: 'Tetapkan' },
        form: { cancel: 'Batal' }
    },
    it: {
        tabs: { overview: 'Panoramica', packages: 'Pacchetti e contratti', sessions: 'Sessioni', reports: 'Report', settings: 'Impostazioni avanzate' },
        clock: { title: 'Ora server (NTP)', check_now: 'Controlla ora', unsynced: 'L\'orologio del server non è sincronizzato — le sessioni fatturabili possono essere bloccate' },
        stats: { active_sessions: 'Sessioni fatturabili attive' },
        packages: { new: 'Nuovo pacchetto', name: 'Nome', included_minutes: 'Minuti inclusi', overage_rate: 'Tariffa extra / h', currency: 'Valuta', create_title: 'Nuovo pacchetto per organizzazione', create_submit: 'Crea pacchetto', select_org: 'Organizzazione', select_org_placeholder: 'Seleziona organizzazione…' },
        sessions: { device: 'Dispositivo', operator: 'Operatore', duration: 'Durata', phase: 'Fase', amount: 'Importo' },
        reports: { session: 'Sessione', summary: 'Riepilogo', date: 'Data' },
        empty: { packages: 'Nessun pacchetto ancora. Creane uno con il pulsante sopra.', contracts: 'Nessun contratto organizzazione ancora. Assegna un pacchetto a un\'organizzazione.', sessions: 'Nessuna sessione fatturabile registrata.', reports: 'Nessun report di lavoro inviato.' },
        assign: { title: 'Assegna pacchetto esistente', submit: 'Assegna' },
        form: { cancel: 'Annulla' }
    },
    ja: {
        tabs: { overview: '概要', packages: 'パッケージと契約', sessions: 'セッション', reports: 'レポート', settings: '詳細設定' },
        clock: { title: 'サーバー時刻 (NTP)', check_now: '今すぐ確認', unsynced: 'サーバー時計が同期されていません — 課金セッションがブロックされる場合があります' },
        stats: { active_sessions: 'アクティブな課金セッション' },
        packages: { new: '新規パッケージ', name: '名前', included_minutes: '含まれる分数', overage_rate: '超過料金 / 時間', currency: '通貨', create_title: '組織向け新規パッケージ', create_submit: 'パッケージを作成', select_org: '組織', select_org_placeholder: '組織を選択…' },
        sessions: { device: 'デバイス', operator: 'オペレーター', duration: '時間', phase: 'フェーズ', amount: '金額' },
        reports: { session: 'セッション', summary: '概要', date: '日付' },
        empty: { packages: 'パッケージがありません。上のボタンで作成してください。', contracts: '組織契約がありません。組織にパッケージを割り当ててください。', sessions: '課金セッションはまだ記録されていません。', reports: '作業レポートはまだ送信されていません。' },
        assign: { title: '既存パッケージを割り当て', submit: '割り当て' },
        form: { cancel: 'キャンセル' }
    },
    ko: {
        tabs: { overview: '개요', packages: '패키지 및 계약', sessions: '세션', reports: '보고서', settings: '고급 설정' },
        clock: { title: '서버 시간 (NTP)', check_now: '지금 확인', unsynced: '서버 시계가 동기화되지 않음 — 과금 세션이 차단될 수 있습니다' },
        stats: { active_sessions: '활성 과금 세션' },
        packages: { new: '새 패키지', name: '이름', included_minutes: '포함 분', overage_rate: '초과 요금 / 시간', currency: '통화', create_title: '조직용 새 패키지', create_submit: '패키지 만들기', select_org: '조직', select_org_placeholder: '조직 선택…' },
        sessions: { device: '장치', operator: '운영자', duration: '시간', phase: '단계', amount: '금액' },
        reports: { session: '세션', summary: '요약', date: '날짜' },
        empty: { packages: '아직 패키지가 없습니다. 위 버튼으로 만드세요.', contracts: '아직 조직 계약이 없습니다. 조직에 패키지를 할당하세요.', sessions: '아직 기록된 과금 세션이 없습니다.', reports: '아직 제출된 작업 보고서가 없습니다.' },
        assign: { title: '기존 패키지 할당', submit: '할당' },
        form: { cancel: '취소' }
    },
    nb: {
        tabs: { overview: 'Oversikt', packages: 'Pakker og kontrakter', sessions: 'Økter', reports: 'Rapporter', settings: 'Avanserte innstillinger' },
        clock: { title: 'Servertid (NTP)', check_now: 'Sjekk nå', unsynced: 'Serverklokken er ikke synkronisert — fakturerbare økter kan bli blokkert' },
        stats: { active_sessions: 'Aktive fakturerbare økter' },
        packages: { new: 'Ny pakke', name: 'Navn', included_minutes: 'Inkluderte minutter', overage_rate: 'Overforbrukssats / t', currency: 'Valuta', create_title: 'Ny pakke for organisasjon', create_submit: 'Opprett pakke', select_org: 'Organisasjon', select_org_placeholder: 'Velg organisasjon…' },
        sessions: { device: 'Enhet', operator: 'Operatør', duration: 'Varighet', phase: 'Fase', amount: 'Beløp' },
        reports: { session: 'Økt', summary: 'Sammendrag', date: 'Dato' },
        empty: { packages: 'Ingen pakker ennå. Opprett en med knappen over.', contracts: 'Ingen organisasjonskontrakter ennå. Tildel en pakke til en organisasjon.', sessions: 'Ingen fakturerbare økter registrert ennå.', reports: 'Ingen arbeidsrapporter sendt inn ennå.' },
        assign: { title: 'Tildel eksisterende pakke', submit: 'Tildel' },
        form: { cancel: 'Avbryt' }
    },
    nl: {
        tabs: { overview: 'Overzicht', packages: 'Pakketten & contracten', sessions: 'Sessies', reports: 'Rapporten', settings: 'Geavanceerde instellingen' },
        clock: { title: 'Servertijd (NTP)', check_now: 'Nu controleren', unsynced: 'Serverklok niet gesynchroniseerd — factureerbare sessies kunnen worden geblokkeerd' },
        stats: { active_sessions: 'Actieve factureerbare sessies' },
        packages: { new: 'Nieuw pakket', name: 'Naam', included_minutes: 'Inbegrepen minuten', overage_rate: 'Overage tarief / u', currency: 'Valuta', create_title: 'Nieuw pakket voor organisatie', create_submit: 'Pakket aanmaken', select_org: 'Organisatie', select_org_placeholder: 'Selecteer organisatie…' },
        sessions: { device: 'Apparaat', operator: 'Operator', duration: 'Duur', phase: 'Fase', amount: 'Bedrag' },
        reports: { session: 'Sessie', summary: 'Samenvatting', date: 'Datum' },
        empty: { packages: 'Nog geen pakketten. Maak er een met de knop hierboven.', contracts: 'Nog geen organisatiecontracten. Wijs een pakket toe aan een organisatie.', sessions: 'Nog geen factureerbare sessies geregistreerd.', reports: 'Nog geen werkrapporten ingediend.' },
        assign: { title: 'Bestaand pakket toewijzen', submit: 'Toewijzen' },
        form: { cancel: 'Annuleren' }
    },
    pt: {
        tabs: { overview: 'Visão geral', packages: 'Pacotes e contratos', sessions: 'Sessões', reports: 'Relatórios', settings: 'Definições avançadas' },
        clock: { title: 'Hora do servidor (NTP)', check_now: 'Verificar agora', unsynced: 'Relógio do servidor não sincronizado — sessões faturáveis podem ser bloqueadas' },
        stats: { active_sessions: 'Sessões faturáveis ativas' },
        packages: { new: 'Novo pacote', name: 'Nome', included_minutes: 'Minutos incluídos', overage_rate: 'Taxa de excedente / h', currency: 'Moeda', create_title: 'Novo pacote para organização', create_submit: 'Criar pacote', select_org: 'Organização', select_org_placeholder: 'Selecionar organização…' },
        sessions: { device: 'Dispositivo', operator: 'Operador', duration: 'Duração', phase: 'Fase', amount: 'Valor' },
        reports: { session: 'Sessão', summary: 'Resumo', date: 'Data' },
        empty: { packages: 'Ainda não há pacotes. Crie um com o botão acima.', contracts: 'Ainda não há contratos de organização. Atribua um pacote a uma organização.', sessions: 'Ainda não há sessões faturáveis registadas.', reports: 'Ainda não há relatórios de trabalho.' },
        assign: { title: 'Atribuir pacote existente', submit: 'Atribuir' },
        form: { cancel: 'Cancelar' }
    },
    ro: {
        tabs: { overview: 'Prezentare', packages: 'Pachete și contracte', sessions: 'Sesiuni', reports: 'Rapoarte', settings: 'Setări avansate' },
        clock: { title: 'Ora serverului (NTP)', check_now: 'Verifică acum', unsynced: 'Ceasul serverului nu este sincronizat — sesiunile facturabile pot fi blocate' },
        stats: { active_sessions: 'Sesiuni facturabile active' },
        packages: { new: 'Pachet nou', name: 'Nume', included_minutes: 'Minute incluse', overage_rate: 'Tarif depășire / h', currency: 'Monedă', create_title: 'Pachet nou pentru organizație', create_submit: 'Creează pachet', select_org: 'Organizație', select_org_placeholder: 'Selectează organizația…' },
        sessions: { device: 'Dispozitiv', operator: 'Operator', duration: 'Durată', phase: 'Fază', amount: 'Sumă' },
        reports: { session: 'Sesiune', summary: 'Rezumat', date: 'Dată' },
        empty: { packages: 'Nu există pachete încă. Creați unul cu butonul de mai sus.', contracts: 'Nu există contracte de organizație încă. Atribuiți un pachet unei organizații.', sessions: 'Nu există sesiuni facturabile înregistrate încă.', reports: 'Nu există rapoarte de lucru trimise încă.' },
        assign: { title: 'Atribuie pachet existent', submit: 'Atribuie' },
        form: { cancel: 'Anulează' }
    },
    sv: {
        tabs: { overview: 'Översikt', packages: 'Paket och avtal', sessions: 'Sessioner', reports: 'Rapporter', settings: 'Avancerade inställningar' },
        clock: { title: 'Servertid (NTP)', check_now: 'Kontrollera nu', unsynced: 'Serverklockan är inte synkroniserad — fakturerbara sessioner kan blockeras' },
        stats: { active_sessions: 'Aktiva fakturerbara sessioner' },
        packages: { new: 'Nytt paket', name: 'Namn', included_minutes: 'Inkluderade minuter', overage_rate: 'Överskottsavgift / h', currency: 'Valuta', create_title: 'Nytt paket för organisation', create_submit: 'Skapa paket', select_org: 'Organisation', select_org_placeholder: 'Välj organisation…' },
        sessions: { device: 'Enhet', operator: 'Operatör', duration: 'Varaktighet', phase: 'Fas', amount: 'Belopp' },
        reports: { session: 'Supportsession', summary: 'Sammanfattning', date: 'Datum' },
        empty: { packages: 'Inga paket ännu. Skapa ett med knappen ovan.', contracts: 'Inga organisationsavtal ännu. Tilldela ett paket till en organisation.', sessions: 'Inga fakturerbara sessioner registrerade ännu.', reports: 'Inga arbetsrapporter inskickade ännu.' },
        assign: { title: 'Tilldela befintligt paket', submit: 'Tilldela' },
        form: { cancel: 'Avbryt' }
    },
    th: {
        tabs: { overview: 'ภาพรวม', packages: 'แพ็กเกจและสัญญา', sessions: 'เซสชัน', reports: 'รายงาน', settings: 'การตั้งค่าขั้นสูง' },
        clock: { title: 'เวลาเซิร์ฟเวอร์ (NTP)', check_now: 'ตรวจสอบตอนนี้', unsynced: 'นาฬิกาเซิร์ฟเวอร์ไม่ซิงค์ — เซสชันที่เรียกเก็บเงินอาจถูกบล็อก' },
        stats: { active_sessions: 'เซสชันที่เรียกเก็บเงินที่ใช้งานอยู่' },
        packages: { new: 'แพ็กเกจใหม่', name: 'ชื่อ', included_minutes: 'นาทีที่รวม', overage_rate: 'อัตราเกิน / ชม.', currency: 'สกุลเงิน', create_title: 'แพ็กเกจใหม่สำหรับองค์กร', create_submit: 'สร้างแพ็กเกจ', select_org: 'องค์กร', select_org_placeholder: 'เลือกองค์กร…' },
        sessions: { device: 'อุปกรณ์', operator: 'ผู้ปฏิบัติการ', duration: 'ระยะเวลา', phase: 'ระยะ', amount: 'จำนวนเงิน' },
        reports: { session: 'เซสชัน', summary: 'สรุป', date: 'วันที่' },
        empty: { packages: 'ยังไม่มีแพ็กเกจ สร้างด้วยปุ่มด้านบน', contracts: 'ยังไม่มีสัญญาองค์กร กำหนดแพ็กเกจให้องค์กร', sessions: 'ยังไม่มีเซสชันที่เรียกเก็บเงิน', reports: 'ยังไม่มีรายงานการทำงาน' },
        assign: { title: 'กำหนดแพ็กเกจที่มีอยู่', submit: 'กำหนด' },
        form: { cancel: 'ยกเลิก' }
    },
    tr: {
        tabs: { overview: 'Genel bakış', packages: 'Paketler ve sözleşmeler', sessions: 'Oturumlar', reports: 'Raporlar', settings: 'Gelişmiş ayarlar' },
        clock: { title: 'Sunucu saati (NTP)', check_now: 'Şimdi kontrol et', unsynced: 'Sunucu saati senkronize değil — faturalandırılabilir oturumlar engellenebilir' },
        stats: { active_sessions: 'Aktif faturalandırılabilir oturumlar' },
        packages: { new: 'Yeni paket', name: 'Ad', included_minutes: 'Dahil edilen dakikalar', overage_rate: 'Aşım ücreti / s', currency: 'Para birimi', create_title: 'Kuruluş için yeni paket', create_submit: 'Paket oluştur', select_org: 'Kuruluş', select_org_placeholder: 'Kuruluş seçin…' },
        sessions: { device: 'Cihaz', operator: 'Operatör', duration: 'Süre', phase: 'Aşama', amount: 'Tutar' },
        reports: { session: 'Oturum', summary: 'Özet', date: 'Tarih' },
        empty: { packages: 'Henüz paket yok. Yukarıdaki düğmeyle oluşturun.', contracts: 'Henüz kuruluş sözleşmesi yok. Bir kuruluşa paket atayın.', sessions: 'Henüz faturalandırılabilir oturum kaydedilmedi.', reports: 'Henüz iş raporu gönderilmedi.' },
        assign: { title: 'Mevcut paketi ata', submit: 'Ata' },
        form: { cancel: 'İptal' }
    },
    uk: {
        tabs: { overview: 'Огляд', packages: 'Пакети та контракти', sessions: 'Сесії', reports: 'Звіти', settings: 'Розширені налаштування' },
        clock: { title: 'Час сервера (NTP)', check_now: 'Перевірити зараз', unsynced: 'Годинник сервера не синхронізовано — платні сесії можуть бути заблоковані' },
        stats: { active_sessions: 'Активні платні сесії' },
        packages: { new: 'Новий пакет', name: 'Назва', included_minutes: 'Включені хвилини', overage_rate: 'Ставка понад ліміт / год', currency: 'Валюта', create_title: 'Новий пакет для організації', create_submit: 'Створити пакет', select_org: 'Організація', select_org_placeholder: 'Оберіть організацію…' },
        sessions: { device: 'Пристрій', operator: 'Оператор', duration: 'Тривалість', phase: 'Фаза', amount: 'Сума' },
        reports: { session: 'Сесія', summary: 'Підсумок', date: 'Дата' },
        empty: { packages: 'Пакетів ще немає. Створіть перший кнопкою вище.', contracts: 'Контрактів організацій ще немає. Призначте пакет організації.', sessions: 'Платних сесій ще не зареєстровано.', reports: 'Звітів про роботу ще не надіслано.' },
        assign: { title: 'Призначити існуючий пакет', submit: 'Призначити' },
        form: { cancel: 'Скасувати' }
    },
    vi: {
        tabs: { overview: 'Tổng quan', packages: 'Gói & hợp đồng', sessions: 'Phiên', reports: 'Báo cáo', settings: 'Cài đặt nâng cao' },
        clock: { title: 'Giờ máy chủ (NTP)', check_now: 'Kiểm tra ngay', unsynced: 'Đồng hồ máy chủ chưa đồng bộ — phiên tính phí có thể bị chặn' },
        stats: { active_sessions: 'Phiên tính phí đang hoạt động' },
        packages: { new: 'Gói mới', name: 'Tên', included_minutes: 'Phút bao gồm', overage_rate: 'Giá vượt / giờ', currency: 'Tiền tệ', create_title: 'Gói mới cho tổ chức', create_submit: 'Tạo gói', select_org: 'Tổ chức', select_org_placeholder: 'Chọn tổ chức…' },
        sessions: { device: 'Thiết bị', operator: 'Người vận hành', duration: 'Thời lượng', phase: 'Giai đoạn', amount: 'Số tiền' },
        reports: { session: 'Phiên', summary: 'Tóm tắt', date: 'Ngày' },
        empty: { packages: 'Chưa có gói nào. Tạo gói bằng nút phía trên.', contracts: 'Chưa có hợp đồng tổ chức. Gán gói cho tổ chức.', sessions: 'Chưa có phiên tính phí nào.', reports: 'Chưa có báo cáo công việc.' },
        assign: { title: 'Gán gói hiện có', submit: 'Gán' },
        form: { cancel: 'Hủy' }
    },
    zh: {
        tabs: { overview: '概览', packages: '套餐与合同', sessions: '会话', reports: '报告', settings: '高级设置' },
        clock: { title: '服务器时间 (NTP)', check_now: '立即检查', unsynced: '服务器时钟未同步 — 可计费会话可能被阻止' },
        stats: { active_sessions: '活动可计费会话' },
        packages: { new: '新建套餐', name: '名称', included_minutes: '包含分钟', overage_rate: '超额费率 / 小时', currency: '货币', create_title: '为组织新建套餐', create_submit: '创建套餐', select_org: '组织', select_org_placeholder: '选择组织…' },
        sessions: { device: '设备', operator: '操作员', duration: '时长', phase: '阶段', amount: '金额' },
        reports: { session: '会话', summary: '摘要', date: '日期' },
        empty: { packages: '尚无套餐。请使用上方按钮创建。', contracts: '尚无组织合同。请为组织分配套餐。', sessions: '尚无已记录的可计费会话。', reports: '尚无已提交的工作报告。' },
        assign: { title: '分配现有套餐', submit: '分配' },
        form: { cancel: '取消' }
    },
    'zh-TW': {
        tabs: { overview: '概覽', packages: '套件與合約', sessions: '工作階段', reports: '報告', settings: '進階設定' },
        clock: { title: '伺服器時間 (NTP)', check_now: '立即檢查', unsynced: '伺服器時鐘未同步 — 可計費工作階段可能被封鎖' },
        stats: { active_sessions: '使用中可計費工作階段' },
        packages: { new: '新增套件', name: '名稱', included_minutes: '包含分鐘', overage_rate: '超額費率 / 小時', currency: '貨幣', create_title: '為組織新增套件', create_submit: '建立套件', select_org: '組織', select_org_placeholder: '選擇組織…' },
        sessions: { device: '裝置', operator: '操作員', duration: '時長', phase: '階段', amount: '金額' },
        reports: { session: '工作階段', summary: '摘要', date: '日期' },
        empty: { packages: '尚無套件。請使用上方按鈕建立。', contracts: '尚無組織合約。請為組織指派套件。', sessions: '尚無已記錄的可計費工作階段。', reports: '尚無已提交的工作報告。' },
        assign: { title: '指派現有套件', submit: '指派' },
        form: { cancel: '取消' }
    }
};
