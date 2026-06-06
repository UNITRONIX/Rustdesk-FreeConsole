'use strict';

/** Localized labels for keys that still matched EN after the main audit patches. */

const fileLabels = {
  ar: {
    systemdConsole: 'systemd: betterdesk-console (وحدة الخدمة)',
    systemdServer: 'systemd: betterdesk-server (وحدة الخدمة)',
    dockerSupervisord: 'Docker: supervisord.conf (إعداد المشرف)',
    dockerCompose: 'Docker: docker-compose.yml (التنسيق)'
  },
  de: {
    systemdConsole: 'systemd: betterdesk-console (Dienst-Unit)',
    systemdServer: 'systemd: betterdesk-server (Dienst-Unit)',
    dockerSupervisord: 'Docker: supervisord.conf (Supervisor-Konfiguration)',
    dockerCompose: 'Docker: docker-compose.yml (Orchestrierung)'
  },
  es: {
    systemdConsole: 'systemd: betterdesk-console (unidad de servicio)',
    systemdServer: 'systemd: betterdesk-server (unidad de servicio)',
    dockerSupervisord: 'Docker: supervisord.conf (configuración del supervisor)',
    dockerCompose: 'Docker: docker-compose.yml (orquestación)',
    bgSizeAuto: 'Automático (original)'
  },
  fr: {
    systemdConsole: 'systemd: betterdesk-console (unité de service)',
    systemdServer: 'systemd: betterdesk-server (unité de service)',
    dockerSupervisord: 'Docker: supervisord.conf (configuration supervisord)',
    dockerCompose: 'Docker: docker-compose.yml (orchestration)',
    bgSizeAuto: 'Automatique (original)'
  },
  hi: {
    systemdConsole: 'systemd: betterdesk-console (सेवा इकाई)',
    systemdServer: 'systemd: betterdesk-server (सेवा इकाई)',
    dockerSupervisord: 'Docker: supervisord.conf (सुपरवाइज़र कॉन्फ़िग)',
    dockerCompose: 'Docker: docker-compose.yml (ऑर्केस्ट्रेशन)'
  },
  ja: {
    systemdConsole: 'systemd: betterdesk-console（サービスユニット）',
    systemdServer: 'systemd: betterdesk-server（サービスユニット）',
    dockerSupervisord: 'Docker: supervisord.conf（supervisord 設定）',
    dockerCompose: 'Docker: docker-compose.yml（オーケストレーション）'
  },
  ko: {
    systemdConsole: 'systemd: betterdesk-console (서비스 유닛)',
    systemdServer: 'systemd: betterdesk-server (서비스 유닛)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisord 구성)',
    dockerCompose: 'Docker: docker-compose.yml (오케스트레이션)'
  },
  tr: {
    systemdConsole: 'systemd: betterdesk-console (servis birimi)',
    systemdServer: 'systemd: betterdesk-server (servis birimi)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisord yapılandırması)',
    dockerCompose: 'Docker: docker-compose.yml (orkestrasyon)'
  },
  zh: {
    systemdConsole: 'systemd: betterdesk-console（服务单元）',
    systemdServer: 'systemd: betterdesk-server（服务单元）',
    dockerSupervisord: 'Docker: supervisord.conf（supervisord 配置）',
    dockerCompose: 'Docker: docker-compose.yml（编排）'
  },
  'zh-TW': {
    systemdConsole: 'systemd: betterdesk-console（服務單元）',
    systemdServer: 'systemd: betterdesk-server（服務單元）',
    dockerSupervisord: 'Docker: supervisord.conf（supervisord 設定）',
    dockerCompose: 'Docker: docker-compose.yml（編排）'
  },
  nb: {
    systemdConsole: 'systemd: betterdesk-console (tjenesteenhet)',
    systemdServer: 'systemd: betterdesk-server (tjenesteenhet)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisor-konfigurasjon)',
    dockerCompose: 'Docker: docker-compose.yml (orkestrering)',
    bgSizeAuto: 'Automatisk (original)'
  },
  sv: {
    systemdConsole: 'systemd: betterdesk-console (tjänstenhet)',
    systemdServer: 'systemd: betterdesk-server (tjänstenhet)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisor-konfiguration)',
    dockerCompose: 'Docker: docker-compose.yml (orkestrering)',
    bgSizeAuto: 'Automatiskt (original)'
  },
  da: {
    systemdConsole: 'systemd: betterdesk-console (tjenesteenhed)',
    systemdServer: 'systemd: betterdesk-server (tjenesteenhed)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisor-konfiguration)',
    dockerCompose: 'Docker: docker-compose.yml (orkestrering)',
    bgSizeAuto: 'Automatisk (original)'
  },
  fi: {
    systemdConsole: 'systemd: betterdesk-console (palveluyksikkö)',
    systemdServer: 'systemd: betterdesk-server (palveluyksikkö)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisor-asetukset)',
    dockerCompose: 'Docker: docker-compose.yml (orkestrointi)'
  },
  hu: {
    systemdConsole: 'systemd: betterdesk-console (szolgáltatás-egység)',
    systemdServer: 'systemd: betterdesk-server (szolgáltatás-egység)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisor konfiguráció)',
    dockerCompose: 'Docker: docker-compose.yml (orchestráció)'
  },
  nl: {
    systemdConsole: 'systemd: betterdesk-console (service-unit)',
    systemdServer: 'systemd: betterdesk-server (service-unit)',
    dockerSupervisord: 'Docker: supervisord.conf (supervisor-configuratie)',
    dockerCompose: 'Docker: docker-compose.yml (orkestratie)'
  },
  pt: {
    systemdConsole: 'systemd: betterdesk-console (unidade de serviço)',
    systemdServer: 'systemd: betterdesk-server (unidade de serviço)',
    dockerSupervisord: 'Docker: supervisord.conf (configuração do supervisor)',
    dockerCompose: 'Docker: docker-compose.yml (orquestração)',
    bgSizeAuto: 'Automático (original)'
  },
  ro: {
    systemdConsole: 'systemd: betterdesk-console (unitate de serviciu)',
    systemdServer: 'systemd: betterdesk-server (unitate de serviciu)',
    dockerSupervisord: 'Docker: supervisord.conf (configurare supervisord)',
    dockerCompose: 'Docker: docker-compose.yml (orchestrare)'
  },
  uk: {
    systemdConsole: 'systemd: betterdesk-console (одиниця служби)',
    systemdServer: 'systemd: betterdesk-server (одиниця служби)',
    dockerSupervisord: 'Docker: supervisord.conf (конфігурація supervisord)',
    dockerCompose: 'Docker: docker-compose.yml (оркестрація)'
  }
};

function settingsFiles(labels) {
  return {
    'advanced_file_systemd-console': labels.systemdConsole,
    'advanced_file_systemd-server': labels.systemdServer,
    'advanced_file_docker-supervisord': labels.dockerSupervisord,
    'advanced_file_docker-compose': labels.dockerCompose
  };
}

function withBranding(labels) {
  const patch = { settings: settingsFiles(labels) };
  if (labels.bgSizeAuto) patch.branding = { bg_size_auto: labels.bgSizeAuto };
  return patch;
}

module.exports = {
  ar: { settings: settingsFiles(fileLabels.ar) },
  de: { settings: settingsFiles(fileLabels.de) },
  es: withBranding(fileLabels.es),
  fr: withBranding(fileLabels.fr),
  hi: { settings: settingsFiles(fileLabels.hi) },
  ja: { settings: settingsFiles(fileLabels.ja) },
  ko: { settings: settingsFiles(fileLabels.ko) },
  tr: { settings: settingsFiles(fileLabels.tr) },
  zh: { settings: settingsFiles(fileLabels.zh) },
  'zh-TW': { settings: settingsFiles(fileLabels['zh-TW']) },
  nb: withBranding(fileLabels.nb),
  sv: withBranding(fileLabels.sv),
  da: withBranding(fileLabels.da),
  fi: { settings: settingsFiles(fileLabels.fi) },
  hu: { settings: settingsFiles(fileLabels.hu) },
  nl: { settings: settingsFiles(fileLabels.nl) },
  pt: withBranding(fileLabels.pt),
  ro: { settings: settingsFiles(fileLabels.ro) },
  uk: { settings: settingsFiles(fileLabels.uk) },
  it: {
    settings: {
      advanced_files_label: 'File',
      ...settingsFiles({
        systemdConsole: 'systemd: betterdesk-console (unità di servizio)',
        systemdServer: 'systemd: betterdesk-server (unità di servizio)',
        dockerSupervisord: 'Docker: supervisord.conf (configurazione supervisord)',
        dockerCompose: 'Docker: docker-compose.yml (orchestrazione)'
      })
    },
    branding: { bg_size_auto: 'Automatico (originale)' }
  },
  id: {
    settings: {
      'advanced_file_go-blocklist': 'Daftar blokir server Go (blocklist.txt)',
      'advanced_file_systemd-console': 'systemd: betterdesk-console (unit layanan)',
      'advanced_file_systemd-server': 'systemd: betterdesk-server (unit layanan)',
      'advanced_file_console-session-secret': 'Rahasia sesi konsol (.session_secret)',
      'advanced_file_go-audit-log': 'Log audit server Go (audit.jsonl)',
      'advanced_file_build-env': 'Lingkungan build agen (/etc/betterdesk/build.env)',
      'advanced_file_docker-supervisord': 'Docker: supervisord.conf (konfigurasi supervisor)',
      'advanced_file_docker-compose': 'Docker: docker-compose.yml (orkestrasi)'
    },
    branding: { bg_gradient: 'Gradien CSS' },
    backup: { opt_secrets: 'Kunci & rahasia server' },
    server_attestation: {
      signal_peers: 'Peer sinyal',
      relay_sessions: 'Sesi relay'
    }
  },
  th: {
    settings: {
      'advanced_file_go-blocklist': 'บัญชีดำเซิร์ฟเวอร์ Go (blocklist.txt)',
      'advanced_file_systemd-console': 'systemd: betterdesk-console (หน่วยบริการ)',
      'advanced_file_systemd-server': 'systemd: betterdesk-server (หน่วยบริการ)',
      'advanced_file_console-session-secret': 'รหัสลับเซสชันคอนโซล (.session_secret)',
      'advanced_file_go-audit-log': 'บันทึกการตรวจสอบเซิร์ฟเวอร์ Go (audit.jsonl)',
      'advanced_file_build-env': 'สภาพแวดล้อมบิลด์ของเอเจนต์ (/etc/betterdesk/build.env)',
      'advanced_file_docker-supervisord': 'Docker: supervisord.conf (การตั้งค่า supervisord)',
      'advanced_file_docker-compose': 'Docker: docker-compose.yml (การ orchestration)'
    },
    branding: { bg_gradient: 'ไล่ระดับสี CSS' },
    backup: {
      opt_secrets: 'คีย์และความลับของเซิร์ฟเวอร์',
      opt_env: 'ไฟล์สภาพแวดล้อม (.env)',
      opt_godb: 'ฐานข้อมูลเซิร์ฟเวอร์ Go'
    },
    server_attestation: {
      signal_peers: 'เพียร์สัญญาณ',
      relay_sessions: 'เซสชันรีเลย์'
    }
  },
  vi: {
    settings: {
      'advanced_file_go-blocklist': 'Danh sách chặn máy chủ Go (blocklist.txt)',
      'advanced_file_systemd-console': 'systemd: betterdesk-console (đơn vị dịch vụ)',
      'advanced_file_systemd-server': 'systemd: betterdesk-server (đơn vị dịch vụ)',
      'advanced_file_console-session-secret': 'Bí mật phiên bảng điều khiển (.session_secret)',
      'advanced_file_go-audit-log': 'Nhật ký kiểm tra máy chủ Go (audit.jsonl)',
      'advanced_file_build-env': 'Môi trường build của tác nhân (/etc/betterdesk/build.env)',
      'advanced_file_docker-supervisord': 'Docker: supervisord.conf (cấu hình supervisord)',
      'advanced_file_docker-compose': 'Docker: docker-compose.yml (điều phối)'
    },
    branding: {
      bg_gradient: 'Gradient CSS',
      bg_size_auto: 'Tự động (gốc)'
    },
    backup: {
      opt_secrets: 'Khóa & bí mật máy chủ',
      opt_env: 'Tệp môi trường (.env)',
      opt_godb: 'Cơ sở dữ liệu máy chủ Go'
    },
    server_attestation: {
      signal_peers: 'Peer tín hiệu',
      relay_sessions: 'Phiên chuyển tiếp'
    }
  }
};
