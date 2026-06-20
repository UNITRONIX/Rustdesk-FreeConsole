'use strict';
/** Settings v2 UI + confirm modal strings */
module.exports = {
  ar: {
    settings: {
      ui: {
        search_placeholder: 'البحث في الإعدادات…',
        search_results: '{count} أقسام مطابقة',
        auth_sub_enrollment: 'التسجيل',
        auth_sub_ldap: 'LDAP / AD',
        auth_sub_oidc: 'OIDC / SSO',
        branding_rdclient: 'عميل RdClient',
        connection_p2p_hint: 'محاولة P2P أولاً؛ التحويل إلى relay عند الفشل.',
        connection_relay_hint: 'توجيه كل حركة العملاء عبر خادم relay.'
      },
      confirm: {
        connection_mode_title: 'حفظ استراتيجية الاتصال؟',
        connection_mode: 'تطبيق استراتيجية الاتصال الجديدة لعملاء RustDesk؟',
        connection_restart_title: 'حفظ وإعادة تشغيل الخادم؟',
        connection_restart: 'حفظ إعدادات الاتصال وإعادة تشغيل خادم BetterDesk؟ قد تُقطع الجلسات النشطة مؤقتاً.',
        enrollment_mode_title: 'تغيير وضع التسجيل؟',
        enrollment_mode: 'التبديل إلى «{mode}»؟ يؤثر على تسجيل عملاء RustDesk الجدد.',
        ldap_enable_title: 'تفعيل LDAP؟',
        ldap_enable: 'تفعيل تسجيل الدخول عبر LDAP / Active Directory؟',
        ldap_save_title: 'حفظ إعدادات LDAP؟',
        ldap_save: 'حفظ تكوين LDAP؟ الإعدادات الخاطئة قد تعطل تسجيل الدخول.',
        oidc_enable_title: 'تفعيل SSO؟',
        oidc_enable: 'تفعيل تسجيل الدخول عبر OIDC / SSO؟',
        oidc_save_title: 'حفظ إعدادات SSO؟',
        oidc_save: 'حفظ تكوين OIDC / SSO؟',
        smtp_save_title: 'حفظ إعدادات SMTP؟',
        smtp_save: 'حفظ تكوين SMTP؟ ستستخدم التنبيهات هذا الخادم.',
        backup_restore_title: 'استعادة النسخة الاحتياطية؟',
        backup_restore: 'الاستعادة من هذا الملف؟ سيتم استبدال البيانات المحددة.',
        tutorials_reset_title: 'إعادة تعيين الدروس؟',
        tutorials_reset: 'إعادة تعيين تقدم جميع الدروس؟',
        advanced_save_title: 'حفظ ملف التكوين؟',
        advanced_restart_after_title: 'إعادة تشغيل الخدمة؟',
        advanced_restart_title: 'إعادة تشغيل الخدمة؟',
        advanced_discard_title: 'تجاهل التغييرات؟'
      }
    }
  },
  cs: {
    settings: {
      ui: {
        search_placeholder: 'Hledat v nastavení…',
        search_results: '{count} odpovídajících sekcí',
        auth_sub_enrollment: 'Registrace',
        auth_sub_ldap: 'LDAP / AD',
        auth_sub_oidc: 'OIDC / SSO',
        branding_rdclient: 'Klient RdClient',
        connection_p2p_hint: 'Nejprve P2P; při selhání přepnutí na relay.',
        connection_relay_hint: 'Veškerý provoz klientů přes relay server.'
      },
      confirm: {
        connection_mode_title: 'Uložit strategii připojení?',
        connection_mode: 'Použít novou strategii pro klienty RustDesk?',
        connection_restart_title: 'Uložit a restartovat server?',
        connection_restart: 'Uložit nastavení a restartovat server BetterDesk? Aktivní relace se mohou krátce odpojit.',
        enrollment_mode_title: 'Změnit režim registrace?',
        enrollment_mode: 'Přepnout registraci na „{mode}“? Ovlivní registraci nových klientů RustDesk.',
        ldap_enable_title: 'Povolit LDAP?',
        ldap_enable: 'Povolit přihlášení přes LDAP / Active Directory?',
        ldap_save_title: 'Uložit nastavení LDAP?',
        ldap_save: 'Uložit konfiguraci LDAP? Chybná nastavení mohou zablokovat přihlášení.',
        oidc_enable_title: 'Povolit SSO?',
        oidc_enable: 'Povolit přihlášení přes OIDC / SSO?',
        oidc_save_title: 'Uložit nastavení SSO?',
        oidc_save: 'Uložit konfiguraci OIDC / SSO?',
        smtp_save_title: 'Uložit nastavení SMTP?',
        smtp_save: 'Uložit konfiguraci SMTP? Upozornění budou používat tento server.',
        backup_restore_title: 'Obnovit zálohu?',
        backup_restore: 'Obnovit z tohoto souboru? Vybraná data budou nahrazena.',
        tutorials_reset_title: 'Resetovat návody?',
        tutorials_reset: 'Resetovat postup všech návodů?',
        advanced_save_title: 'Uložit konfigurační soubor?',
        advanced_restart_after_title: 'Restartovat službu?',
        advanced_restart_title: 'Restartovat službu?',
        advanced_discard_title: 'Zahodit změny?'
      }
    }
  },
  pl: {
    settings: {
      ui: {
        branding_rdclient: 'Klient RdClient',
        auth_sub_ldap: 'LDAP / Active Directory',
        auth_sub_oidc: 'OIDC / logowanie SSO'
      }
    }
  }
};
