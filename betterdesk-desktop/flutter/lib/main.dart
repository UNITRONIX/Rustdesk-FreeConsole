import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart' hide MenuItem;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'native_core.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  final controller = AppController(NativeCore.tryLoad());
  await controller.loadPersistentSettings();
  windowManager.addListener(controller);
  trayManager.addListener(controller);
  await controller.initializeTray();

  const windowOptions = WindowOptions(
    size: Size(1180, 760),
    minimumSize: Size(920, 620),
    center: true,
    title: 'BetterDesk Desktop',
    skipTaskbar: false,
  );
  windowManager.waitUntilReadyToShow(windowOptions, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  runApp(BetterDeskApp(controller: controller));
}

enum ClientPage { peers, settings, session }

class PeerHistoryEntry {
  const PeerHistoryEntry({required this.id, required this.lastConnected});

  final String id;
  final DateTime lastConnected;

  Map<String, dynamic> toJson() => {
        'id': id,
        'lastConnected': lastConnected.toIso8601String(),
      };

  static PeerHistoryEntry fromJson(Map<String, dynamic> json) {
    return PeerHistoryEntry(
      id: json['id'] as String? ?? '',
      lastConnected:
          DateTime.tryParse(json['lastConnected'] as String? ?? '') ??
              DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }
}

class AppController extends ChangeNotifier with TrayListener, WindowListener {
  AppController(this.nativeCore);

  final NativeCore? nativeCore;
  ClientPage page = ClientPage.peers;
  String idServer = '';
  String relayServer = '';
  String apiUrl = '';
  String serverKey = '';
  String peerId = '';
  String status = 'idle';
  String statusMessage =
      'Dodaj konfigurację serwera BetterDesk, aby rozpocząć.';
  bool darkMode = false;
  bool autostart = false;
  bool settingsUnlocked = false;
  String deviceId = '';
  String rotatingPassword = '';
  String identityPrivateKey = '';
  String identityPublicKey = '';
  String registrationStatus = 'unavailable';
  DateTime? passwordRotatedAt;
  final List<PeerHistoryEntry> recentPeers = [];
  bool _allowClose = false;
  bool _registrationWatcherActive = false;
  static const _storage = FlutterSecureStorage();
  static const passwordRotationPeriod = Duration(minutes: 15);

  String get serverUrl => apiUrl;
  bool get configured => idServer.trim().isNotEmpty || apiUrl.trim().isNotEmpty;
  bool get isBusy => status == 'connecting' || status == 'saving';

  Future<void> loadPersistentSettings() async {
    try {
      final values = await _storage.readAll();
      idServer = values['connection.id_server'] ?? '';
      relayServer = values['connection.relay_server'] ?? '';
      apiUrl = values['connection.api_url'] ?? '';
      serverKey = values['connection.server_key'] ?? '';
      darkMode = values['ui.dark_mode'] == 'true';
      deviceId = values['identity.device_id'] ?? '';
      rotatingPassword = values['identity.rotating_password'] ?? '';
      identityPrivateKey = values['identity.private_key'] ?? '';
      identityPublicKey = values['identity.public_key'] ?? '';
      passwordRotatedAt =
          DateTime.tryParse(values['identity.rotated_at'] ?? '');
      final history = values['peers.history'];
      if (history != null) {
        try {
          recentPeers
            ..clear()
            ..addAll(
              (jsonDecode(history) as List<dynamic>)
                  .whereType<Map<String, dynamic>>()
                  .map(PeerHistoryEntry.fromJson),
            );
        } catch (_) {
          recentPeers.clear();
        }
      }
      await _migrateLegacySettings();
      if (configured) {
        await _ensureIdentity();
      }
    } catch (error) {
      status = 'failed';
      statusMessage = 'Nie można odczytać bezpiecznej konfiguracji klienta.';
    }
  }

  Future<void> _migrateLegacySettings() async {
    if (configured) return;
    try {
      final directory = await getApplicationSupportDirectory();
      for (final name in const ['settings.json', 'betterdesk-settings.json']) {
        final legacy = File('${directory.path}${Platform.pathSeparator}$name');
        if (!await legacy.exists()) continue;
        final decoded = jsonDecode(await legacy.readAsString());
        if (decoded is! Map<String, dynamic>) continue;
        idServer = decoded['idServer'] as String? ?? '';
        relayServer = decoded['relayServer'] as String? ?? '';
        apiUrl = decoded['apiUrl'] as String? ?? '';
        serverKey = decoded['serverKey'] as String? ?? '';
        if (!configured) continue;
        await _persistSettings();
        await legacy.rename('${legacy.path}.migrated');
        break;
      }
    } catch (_) {
      // A malformed legacy file must not prevent the normal locked UI from
      // starting. It is left untouched for a later, explicit migration.
    }
  }

  Future<void> _persistSettings() async {
    try {
      await _storage.write(key: 'connection.id_server', value: idServer);
      await _storage.write(key: 'connection.relay_server', value: relayServer);
      await _storage.write(key: 'connection.api_url', value: apiUrl);
      await _storage.write(key: 'connection.server_key', value: serverKey);
    } catch (_) {
      status = 'failed';
      statusMessage =
          'Konfiguracja nie została zapisana w magazynie systemowym.';
      notifyListeners();
    }
  }

  Future<void> _ensureIdentity() async {
    final now = DateTime.now().toUtc();
    final needsPassword = rotatingPassword.isEmpty ||
        passwordRotatedAt == null ||
        now.difference(passwordRotatedAt!) >= passwordRotationPeriod;
    if (deviceId.isEmpty) {
      deviceId = nativeCore?.generateDeviceId() ?? _fallbackDeviceId();
    }
    if (identityPrivateKey.isEmpty || identityPublicKey.isEmpty) {
      try {
        final raw = nativeCore?.generateIdentityKeypair();
        final keypair = raw == null ? null : jsonDecode(raw);
        identityPrivateKey = keypair?['private'] as String? ?? '';
        identityPublicKey = keypair?['public'] as String? ?? '';
      } catch (_) {
        identityPrivateKey = '';
        identityPublicKey = '';
      }
      if (identityPrivateKey.isEmpty || identityPublicKey.isEmpty) {
        final random = math.Random.secure();
        final privateBytes = List<int>.generate(32, (_) => random.nextInt(256));
        final publicBytes = List<int>.generate(32, (_) => random.nextInt(256));
        identityPrivateKey = base64Url.encode(privateBytes);
        identityPublicKey = base64Url.encode(publicBytes);
      }
    }
    if (needsPassword) {
      rotatingPassword =
          nativeCore?.generateRotatingPassword() ?? _fallbackPassword();
      passwordRotatedAt = now;
    }
    await _storage.write(key: 'identity.device_id', value: deviceId);
    await _storage.write(
      key: 'identity.rotating_password',
      value: rotatingPassword,
    );
    await _storage.write(
      key: 'identity.rotated_at',
      value: passwordRotatedAt!.toIso8601String(),
    );
    await _storage.write(
      key: 'identity.private_key',
      value: identityPrivateKey,
    );
    await _storage.write(
      key: 'identity.public_key',
      value: identityPublicKey,
    );
    notifyListeners();
  }

  bool _startRegistration() {
    if (nativeCore == null ||
        idServer.trim().isEmpty ||
        deviceId.trim().isEmpty ||
        identityPublicKey.trim().isEmpty) {
      registrationStatus = 'unavailable';
      return false;
    }
    final started = nativeCore!.startRegistration(
      config: {
        'id_server': idServer,
        'relay_server': relayServer,
        'api_url': apiUrl,
        'server_key': serverKey,
      },
      deviceId: deviceId,
      publicKey: identityPublicKey,
    );
    registrationStatus = nativeCore!.registrationStatus();
    _watchRegistration();
    return started;
  }

  void _watchRegistration() {
    if (_registrationWatcherActive || nativeCore == null) return;
    _registrationWatcherActive = true;
    unawaited(() async {
      try {
        for (var attempt = 0; attempt < 40; attempt++) {
          await Future<void>.delayed(const Duration(milliseconds: 500));
          final next = nativeCore!.registrationStatus();
          registrationStatus = next;
          notifyListeners();
          if (!next.startsWith('registering')) break;
        }
      } finally {
        _registrationWatcherActive = false;
      }
    }());
  }

  bool unlockConnectionSettings() {
    status = 'connecting';
    statusMessage = 'Oczekiwanie na potwierdzenie administratora…';
    notifyListeners();
    final authorized =
        nativeCore?.requestAdmin('change_server_endpoint') ?? false;
    if (authorized) {
      settingsUnlocked = true;
      status = 'idle';
      statusMessage = 'Ustawienia połączenia odblokowane przez UAC.';
    } else {
      status = 'admin_required';
      statusMessage =
          'Formularz wymaga potwierdzenia administratora przez UAC.';
    }
    notifyListeners();
    return authorized;
  }

  Future<void> initializeTray() async {
    await trayManager.setToolTip('BetterDesk Desktop');
    await trayManager.setContextMenu(Menu(items: [
      MenuItem(key: 'show', label: 'Otwórz BetterDesk'),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: 'Zakończ'),
    ]));
  }

  void selectPage(ClientPage next) {
    page = next;
    notifyListeners();
  }

  bool saveConnection({
    required String idServerValue,
    required String relayServerValue,
    required String apiUrlValue,
    required String serverKeyValue,
  }) {
    if (!settingsUnlocked) {
      status = 'admin_required';
      statusMessage =
          'Konfiguracja połączenia wymaga potwierdzenia administratora przez UAC.';
      notifyListeners();
      return false;
    }
    final validationError = _validateConnection(
      idServerValue,
      relayServerValue,
      apiUrlValue,
      serverKeyValue,
    );
    if (validationError != null) {
      status = 'failed';
      statusMessage = validationError;
      notifyListeners();
      return false;
    }

    idServer = idServerValue.trim();
    relayServer = relayServerValue.trim();
    apiUrl = apiUrlValue.trim();
    serverKey = serverKeyValue.trim();
    status = 'idle';
    statusMessage = 'Konfiguracja została zapisana lokalnie.';
    notifyListeners();
    if (Platform.environment['FLUTTER_TEST'] != 'true') {
      unawaited(_persistSettings());
      unawaited(_ensureIdentity());
    }
    return true;
  }

  void setServer(String value) {
    saveConnection(
      idServerValue: idServer,
      relayServerValue: relayServer,
      apiUrlValue: value,
      serverKeyValue: serverKey,
    );
  }

  Future<void> probeServer() async {
    if (!configured || isBusy) return;
    status = 'connecting';
    statusMessage = 'Testowanie ID servera, relay i API…';
    notifyListeners();

    try {
      final checks = <String>[];
      if (idServer.trim().isEmpty) {
        throw const FormatException('Podaj adres Serwer ID.');
      }
      await _testTcpEndpoint(idServer, 21116, 'Serwer ID');
      checks.add('ID server OK');

      if (relayServer.trim().isNotEmpty) {
        await _testTcpEndpoint(relayServer, 21117, 'Serwer pośredniczący');
        checks.add('relay OK');
      }

      if (apiUrl.trim().isNotEmpty) {
        checks.add(await _testApiEndpoint());
      }
      if (_startRegistration()) {
        checks.add('RegisterPk wysłany do kolejki rejestracji');
      }
      status = 'online';
      statusMessage = 'Połączenie poprawne: ${checks.join(', ')}.';
      _recordPeer(peerId);
    } catch (error) {
      status = 'failed';
      statusMessage = 'Test połączenia nieudany: ${_safeError(error)}';
    }
    notifyListeners();
  }

  Future<void> testConnection({
    required String idServerValue,
    required String relayServerValue,
    required String apiUrlValue,
    required String serverKeyValue,
  }) async {
    if (!saveConnection(
      idServerValue: idServerValue,
      relayServerValue: relayServerValue,
      apiUrlValue: apiUrlValue,
      serverKeyValue: serverKeyValue,
    )) {
      return;
    }
    await probeServer();
  }

  Future<void> _testTcpEndpoint(
      String value, int defaultPort, String label) async {
    final endpoint = _parseHostEndpoint(value, defaultPort);
    try {
      final socket = await Socket.connect(
        endpoint.$1,
        endpoint.$2,
        timeout: const Duration(seconds: 8),
      );
      await socket.close();
    } on SocketException catch (error) {
      throw SocketException(
          '$label (${endpoint.$1}:${endpoint.$2}): ${error.message}');
    }
  }

  Future<String> _testApiEndpoint() async {
    final raw = apiUrl.trim();
    final hasExplicitScheme = raw.contains('://');
    final uri = Uri.tryParse(hasExplicitScheme ? raw : 'https://$raw');
    if (uri == null || uri.host.isEmpty) {
      throw const FormatException('Adres API jest nieprawidłowy.');
    }
    final basePath = uri.path.replaceFirst(RegExp(r'/$'), '');
    final apiPaths = basePath.endsWith('/api')
        ? [
            '$basePath/health',
            '$basePath/server/pubkey',
            '$basePath/server-key',
            '${basePath.substring(0, basePath.length - 4)}/health',
          ]
        : [
            '$basePath/api/health',
            '$basePath/api/server/pubkey',
            '$basePath/api/server-key',
            '$basePath/health',
          ];
    final schemes = hasExplicitScheme ? [uri.scheme] : ['https', 'http'];
    final apiUris = <Uri>[];
    for (final scheme in schemes) {
      if (!const {'https', 'http'}.contains(scheme)) {
        throw const FormatException('API musi używać HTTP lub HTTPS.');
      }
      final ports = uri.hasPort
          ? [uri.port]
          : scheme == 'http'
              ? [80, 21114, 21121]
              : [443];
      for (final port in ports) {
        for (final path in apiPaths) {
          apiUris.add(
            uri.replace(
              scheme: scheme,
              port: port,
              path: path,
              query: '',
              fragment: '',
            ),
          );
        }
      }
    }
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      var lastStatusCode = 0;
      Object? lastError;
      Uri? lastUri;
      for (final apiUri in apiUris) {
        try {
          lastUri = apiUri;
          if (apiUri.scheme == 'https' &&
              nativeCore != null &&
              !nativeCore!.validateServerUrl(apiUri.toString())) {
            throw const FormatException(
                'Certyfikat lub adres TLS został odrzucony.');
          }
          final request = await client.getUrl(apiUri);
          final response = await request.close();
          lastStatusCode = response.statusCode;
          await response.drain<void>();
          if (response.statusCode >= 200 && response.statusCode < 300) {
            final kind = apiUri.path.endsWith('/pubkey') ||
                    apiUri.path.endsWith('/server-key')
                ? 'klucz serwera'
                : 'health';
            return '${apiUri.scheme.toUpperCase()} API OK ($kind: ${apiUri.origin}${apiUri.path})';
          }
          if (response.statusCode == 401 || response.statusCode == 403) {
            return '${apiUri.scheme.toUpperCase()} API dostępne (${apiUri.origin}${apiUri.path}), wymaga logowania';
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (lastStatusCode == 0 && lastError != null) {
        throw HttpException('Brak odpowiedzi API: ${_safeError(lastError)}');
      }
      throw HttpException(
        'BetterDesk API nie odpowiada (ostatni kod $lastStatusCode'
        '${lastUri == null ? '' : ' dla ${lastUri.origin}${lastUri.path}'}). '
        'Dla bezpośredniego Go API użyj http://host:21114; port 21121 '
        'jest tylko zgodnością klienta.',
      );
    } finally {
      client.close(force: true);
    }
  }

  static (String, int) _parseHostEndpoint(String value, int defaultPort) {
    final raw = value.trim();
    final uri = Uri.tryParse(raw.contains('://') ? raw : 'https://$raw');
    if (uri == null ||
        uri.host.isEmpty ||
        uri.path != '/' && uri.path.isNotEmpty) {
      throw const FormatException(
          'Adres endpointu musi mieć format host[:port].');
    }
    return (uri.host, uri.hasPort ? uri.port : defaultPort);
  }

  static String? _validateConnection(
    String idServerValue,
    String relayServerValue,
    String apiUrlValue,
    String serverKeyValue,
  ) {
    try {
      if (idServerValue.trim().isEmpty) {
        return 'Serwer ID jest wymagany.';
      }
      _parseHostEndpoint(idServerValue, 21116);
      if (relayServerValue.trim().isNotEmpty) {
        _parseHostEndpoint(relayServerValue, 21117);
      }
      if (apiUrlValue.trim().isNotEmpty) {
        final raw = apiUrlValue.trim();
        final uri = Uri.tryParse(raw.contains('://') ? raw : 'https://$raw');
        if (uri == null ||
            uri.host.isEmpty ||
            !const {'https', 'http'}.contains(uri.scheme)) {
          return 'API musi używać HTTP lub HTTPS.';
        }
        if (uri.userInfo.isNotEmpty) {
          return 'Adres API nie może zawierać danych logowania.';
        }
      }
      if (serverKeyValue.trim().isNotEmpty &&
          !_validPublicKey(serverKeyValue)) {
        return 'Klucz serwera musi mieć 32 bajty w formacie Base64 lub 64 znaki HEX.';
      }
    } on FormatException catch (error) {
      return error.message;
    }
    return null;
  }

  static bool _validPublicKey(String value) {
    final normalized = value.trim();
    final hexValue = normalized.toLowerCase().startsWith('0x')
        ? normalized.substring(2)
        : normalized;
    if (hexValue.length == 64 &&
        hexValue.runes.every((rune) =>
            RegExp(r'[0-9a-fA-F]').hasMatch(String.fromCharCode(rune)))) {
      return true;
    }
    try {
      return base64.decode(normalized).length == 32 ||
          base64Url.decode(base64Url.normalize(normalized)).length == 32;
    } on FormatException {
      return false;
    }
  }

  void setPeer(String value) {
    peerId = value.trim();
    notifyListeners();
  }

  void connectToPeer(String value) {
    setPeer(value);
    startSession();
  }

  void startSession() {
    if (peerId.trim().isEmpty) return;
    page = ClientPage.session;
    status = 'connecting';
    statusMessage = 'Uruchamianie dwustronnego kanału pulpitu…';
    notifyListeners();
    unawaited(probeServer());
  }

  void closeSession() {
    page = ClientPage.peers;
    status = 'idle';
    statusMessage = 'Sesja pulpitu została zakończona.';
    notifyListeners();
  }

  Uint8List? captureScreenJpeg() {
    return nativeCore?.captureScreenJpeg();
  }

  bool sendInput(Map<String, dynamic> input) {
    return nativeCore?.injectInput(input) ?? false;
  }

  void _recordPeer(String value) {
    final id = value.trim();
    if (id.isEmpty) return;
    recentPeers.removeWhere((peer) => peer.id == id);
    recentPeers.insert(
      0,
      PeerHistoryEntry(id: id, lastConnected: DateTime.now().toUtc()),
    );
    if (recentPeers.length > 20) {
      recentPeers.removeRange(20, recentPeers.length);
    }
    if (Platform.environment['FLUTTER_TEST'] != 'true') {
      unawaited(
        _storage.write(
          key: 'peers.history',
          value: jsonEncode(recentPeers.map((peer) => peer.toJson()).toList()),
        ),
      );
    }
    notifyListeners();
  }

  void requestAdminSetting(String setting) {
    status = 'admin_required';
    statusMessage =
        'Zmiana „$setting” wymaga potwierdzenia administratora przez UAC/polkit.';
    notifyListeners();
  }

  void toggleTheme(bool value) {
    darkMode = value;
    if (Platform.environment['FLUTTER_TEST'] != 'true') {
      unawaited(_storage.write(key: 'ui.dark_mode', value: value.toString()));
    }
    notifyListeners();
  }

  Future<void> showWindow() async {
    await windowManager.show();
    await windowManager.focus();
  }

  Future<void> quit() async {
    _allowClose = true;
    await trayManager.destroy();
    await windowManager.close();
  }

  @override
  void onWindowClose() async {
    if (_allowClose) return;
    await windowManager.hide();
  }

  @override
  void onTrayIconMouseDown() => showWindow();

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'show':
        showWindow();
      case 'quit':
        quit();
    }
  }

  static bool _isLoopback(String host) =>
      host == 'localhost' || host == '127.0.0.1' || host == '::1';

  String _fallbackDeviceId() {
    final random = math.Random.secure();
    return (100000000 + random.nextInt(900000000)).toString();
  }

  String _fallbackPassword() {
    const alphabet =
        'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@\$%';
    final random = math.Random.secure();
    return List.generate(
      20,
      (_) => alphabet[random.nextInt(alphabet.length)],
    ).join();
  }

  static String _safeError(Object error) {
    final message = error.toString().replaceAll(RegExp(r'[\r\n]+'), ' ').trim();
    if (message.length > 180) return '${message.substring(0, 177)}…';
    return message;
  }
}

class BetterDeskApp extends StatelessWidget {
  const BetterDeskApp({required this.controller, super.key});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final seed = controller.darkMode
            ? const Color(0xff67e8d0)
            : const Color(0xff087f70);
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: 'BetterDesk Desktop',
          themeMode: controller.darkMode ? ThemeMode.dark : ThemeMode.light,
          theme: _theme(seed, Brightness.light),
          darkTheme: _theme(seed, Brightness.dark),
          home: DesktopShell(controller: controller),
        );
      },
    );
  }

  ThemeData _theme(Color seed, Brightness brightness) {
    final scheme =
        ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: brightness == Brightness.dark
          ? const Color(0xff101817)
          : const Color(0xfff5f8f7),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }
}

class DesktopShell extends StatelessWidget {
  const DesktopShell({required this.controller, super.key});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final compact = MediaQuery.sizeOf(context).width < 1050;
    return Scaffold(
      body: Row(
        children: [
          NavigationRail(
            extended: !compact,
            selectedIndex: controller.page == ClientPage.settings ? 1 : 0,
            onDestinationSelected: (index) =>
                controller.selectPage(ClientPage.values[index]),
            leading: Padding(
              padding: const EdgeInsets.fromLTRB(12, 24, 12, 28),
              child: _Brand(compact: compact),
            ),
            destinations: const [
              NavigationRailDestination(
                icon: Icon(Icons.devices_other_outlined),
                selectedIcon: Icon(Icons.devices_other),
                label: Text('Urządzenia'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.tune_outlined),
                selectedIcon: Icon(Icons.tune),
                label: Text('Ustawienia'),
              ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: Column(
              children: [
                _TopBar(controller: controller),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 180),
                    child: _page(context),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _page(BuildContext context) {
    switch (controller.page) {
      case ClientPage.peers:
        return PeersPage(controller: controller, key: const ValueKey('peers'));
      case ClientPage.settings:
        return SettingsPage(
            controller: controller, key: const ValueKey('settings'));
      case ClientPage.session:
        return RemoteSessionPage(
            controller: controller, key: const ValueKey('session'));
    }
  }
}

class _Brand extends StatelessWidget {
  const _Brand({required this.compact});
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final mark = Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primary,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Icon(Icons.hub_outlined,
          color: Theme.of(context).colorScheme.onPrimary),
    );
    if (compact) return mark;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        mark,
        const SizedBox(width: 10),
        Text('BetterDesk', style: Theme.of(context).textTheme.titleMedium),
      ],
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 22, 28, 10),
      child: Row(
        children: [
          Expanded(
            child: Text(
              _title,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
            ),
          ),
          IconButton(
            tooltip: 'Ustawienia',
            onPressed: () => controller.selectPage(ClientPage.settings),
            icon: const Icon(Icons.settings_outlined),
          ),
          const SizedBox(width: 6),
          _TrayHint(onPressed: controller.showWindow),
        ],
      ),
    );
  }

  String get _title {
    switch (controller.page) {
      case ClientPage.peers:
        return 'Urządzenia';
      case ClientPage.settings:
        return 'Ustawienia';
      case ClientPage.session:
        return 'Sesja pulpitu';
    }
  }
}

class _TrayHint extends StatelessWidget {
  const _TrayHint({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Klient działa w zasobniku systemowym',
      child: IconButton(
        onPressed: onPressed,
        icon: const Icon(Icons.notifications_none_outlined),
      ),
    );
  }
}

class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final peerController = TextEditingController(text: controller.peerId);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Szybkie połączenie',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    )),
            const SizedBox(height: 6),
            Text('Wpisz ID urządzenia lub alias zapisany na serwerze.'),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: peerController,
                    onChanged: controller.setPeer,
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.computer_outlined),
                      hintText: 'ID urządzenia, np. BD-1234',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: controller.configured &&
                          peerController.text.trim().isNotEmpty
                      ? controller.startSession
                      : null,
                  icon: controller.isBusy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.arrow_forward),
                  label: const Text('Połącz'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _StatusLine(controller: controller),
          ],
        ),
      ),
    );
  }
}

class RemoteSessionPage extends StatelessWidget {
  const RemoteSessionPage({required this.controller, super.key});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final controller = this.controller;
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 16, 28, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Row(
                children: [
                  const Icon(Icons.screen_share_outlined),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Sesja z ${controller.peerId}',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(controller.statusMessage),
                      ],
                    ),
                  ),
                  OutlinedButton.icon(
                    onPressed: controller.closeSession,
                    icon: const Icon(Icons.stop_circle_outlined),
                    label: const Text('Zakończ'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          Expanded(
            child: Card(
              clipBehavior: Clip.antiAlias,
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.screen_search_desktop_outlined,
                      size: 58,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      'Oczekiwanie na negocjację kanału zdalnego pulpitu…',
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Obraz, input, schowek, pliki i audio zostaną obsłużone przez szyfrowany rdzeń sesji.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final (icon, color) = switch (controller.status) {
      'online' => (Icons.check_circle_outline, Colors.green),
      'failed' => (Icons.error_outline, Colors.red),
      'connecting' => (Icons.sync, Colors.orange),
      _ => (Icons.info_outline, Theme.of(context).colorScheme.primary),
    };
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(controller.statusMessage)),
      ],
    );
  }
}

class PeersPage extends StatelessWidget {
  const PeersPage({required this.controller, super.key});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return ListView(
      key: const ValueKey('peers-scroll'),
      padding: const EdgeInsets.fromLTRB(28, 16, 28, 32),
      children: [
        const _PageIntro(
          title: 'Połącz z urządzeniem',
          subtitle:
              'Szybkie połączenie i ostatnio używane urządzenia są zawsze pod ręką.',
        ),
        const SizedBox(height: 14),
        _ConnectionCard(controller: controller),
        const SizedBox(height: 16),
        _IdentityCard(controller: controller),
        const SizedBox(height: 16),
        _RecentPeersCard(controller: controller),
      ],
    );
  }
}

class _PageIntro extends StatelessWidget {
  const _PageIntro({required this.title, required this.subtitle});
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
        ),
        const SizedBox(height: 4),
        Text(subtitle),
      ],
    );
  }
}

class _IdentityCard extends StatelessWidget {
  const _IdentityCard({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Twoje urządzenie',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
            ),
            const SizedBox(height: 12),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.perm_device_information_outlined),
              title: const Text('Twój ID'),
              subtitle: Text(
                controller.deviceId.isEmpty
                    ? 'ID zostanie wygenerowane po poprawnej konfiguracji.'
                    : controller.deviceId,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.password_outlined),
              title: const Text('Hasło sesyjne'),
              subtitle: Text(
                controller.rotatingPassword.isEmpty
                    ? 'Oczekiwanie na konfigurację.'
                    : controller.rotatingPassword,
                style: const TextStyle(fontFamily: 'monospace'),
              ),
              trailing: Text(
                'rotacja co 15 min',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.cloud_done_outlined),
              title: const Text('Rejestracja w serwerze'),
              subtitle: Text(controller.registrationStatus),
            ),
          ],
        ),
      ),
    );
  }
}

class _RecentPeersCard extends StatelessWidget {
  const _RecentPeersCard({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Ostatnie połączenia',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
            ),
            const SizedBox(height: 8),
            if (controller.recentPeers.isEmpty)
              const ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.history),
                title: Text('Brak zapisanej historii urządzeń.'),
              )
            else
              ...controller.recentPeers.map(
                (peer) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.computer_outlined),
                  title: Text(peer.id),
                  subtitle: Text(_historyLabel(peer.lastConnected)),
                  trailing: IconButton(
                    tooltip: 'Połącz ponownie',
                    onPressed: controller.isBusy
                        ? null
                        : () => controller.connectToPeer(peer.id),
                    icon: const Icon(Icons.arrow_forward),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _historyLabel(DateTime value) {
    final local = value.toLocal();
    return 'Ostatnio: ${local.day.toString().padLeft(2, '0')}.${local.month.toString().padLeft(2, '0')}.${local.year} ${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }
}

class SettingsPage extends StatelessWidget {
  const SettingsPage({required this.controller, super.key});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final idServerController = TextEditingController(text: controller.idServer);
    final relayServerController =
        TextEditingController(text: controller.relayServer);
    final apiController = TextEditingController(text: controller.apiUrl);
    final keyController = TextEditingController(text: controller.serverKey);

    void save() {
      controller.saveConnection(
        idServerValue: idServerController.text,
        relayServerValue: relayServerController.text,
        apiUrlValue: apiController.text,
        serverKeyValue: keyController.text,
      );
    }

    void test() {
      controller.testConnection(
        idServerValue: idServerController.text,
        relayServerValue: relayServerController.text,
        apiUrlValue: apiController.text,
        serverKeyValue: keyController.text,
      );
    }

    return ListView(
      key: const ValueKey('settings-scroll'),
      padding: const EdgeInsets.fromLTRB(28, 16, 28, 32),
      children: [
        if (!controller.settingsUnlocked)
          _SettingsUnlockCard(controller: controller)
        else
          _SettingsSection(
            title: 'Serwer ID/Pośredniczący',
            description:
                'Pełna konfiguracja połączenia BetterDesk/RustDesk. Porty domyślne: ID 21116, relay 21117.',
            children: [
              TextField(
                controller: idServerController,
                decoration: const InputDecoration(
                  labelText: 'Serwer ID',
                  hintText: 'host lub host:21116',
                  prefixIcon: Icon(Icons.dns_outlined),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: relayServerController,
                decoration: const InputDecoration(
                  labelText: 'Serwer pośredniczący',
                  hintText: 'host lub host:21117',
                  prefixIcon: Icon(Icons.alt_route_outlined),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: apiController,
                decoration: const InputDecoration(
                  labelText: 'Serwer API',
                  hintText: 'https://desk.example.com',
                  prefixIcon: Icon(Icons.language),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: keyController,
                decoration: const InputDecoration(
                  labelText: 'Klucz publiczny serwera',
                  hintText: 'Base64 lub 64 znaki HEX',
                  prefixIcon: Icon(Icons.key_outlined),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Transport zostanie wykryty automatycznie. TLS jest preferowany; jawne HTTP pozostanie trybem nieszyfrowanym. Klucz służy do weryfikacji serwera.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilledButton.icon(
                    onPressed: controller.isBusy ? null : save,
                    icon: const Icon(Icons.save_outlined),
                    label: const Text('Zapisz konfigurację'),
                  ),
                  OutlinedButton.icon(
                    onPressed: controller.isBusy ? null : test,
                    icon: controller.isBusy
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.network_check),
                    label: const Text('Testuj połączenie'),
                  ),
                  OutlinedButton.icon(
                    onPressed: controller.isBusy
                        ? null
                        : () => controller.requestAdminSetting('klucz serwera'),
                    icon: const Icon(Icons.file_open_outlined),
                    label: const Text('Importuj konfigurację'),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              _StatusLine(controller: controller),
            ],
          ),
        const SizedBox(height: 16),
        _SettingsSection(
          title: 'Wygląd i wygoda',
          description: 'Ustawienia użytkownika nie wymagają administratora.',
          children: [
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Ciemny motyw'),
              subtitle: const Text('Dopasuj interfejs do warunków pracy.'),
              value: controller.darkMode,
              onChanged: controller.toggleTheme,
            ),
          ],
        ),
        const SizedBox(height: 16),
        _SettingsSection(
          title: 'Ustawienia systemowe',
          description: 'Zmiany dotyczące całego komputera wymagają UAC/polkit.',
          children: [
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.power_settings_new),
              title: const Text('Uruchamiaj przy starcie systemu'),
              subtitle: const Text('Opcjonalny autostart klienta w zasobniku.'),
              trailing: Switch.adaptive(
                value: controller.autostart,
                onChanged: (_) => controller.requestAdminSetting('autostart'),
              ),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.admin_panel_settings_outlined),
              title: const Text('Usługa i dostęp unattended'),
              subtitle:
                  const Text('Instalacja wymaga uprawnień administratora.'),
              trailing: OutlinedButton(
                onPressed: () =>
                    controller.requestAdminSetting('usługa unattended'),
                child: const Text('Zarządzaj'),
              ),
            ),
            if (controller.status == 'admin_required')
              _StatusLine(controller: controller),
          ],
        ),
      ],
    );
  }
}

class _SettingsUnlockCard extends StatelessWidget {
  const _SettingsUnlockCard({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.admin_panel_settings_outlined,
              size: 44,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 12),
            Text(
              'Konfiguracja połączenia jest chroniona',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Dane serwera, klucz publiczny i ustawienia dostępu są widoczne dopiero po potwierdzeniu UAC administratora.',
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: controller.isBusy
                  ? null
                  : controller.unlockConnectionSettings,
              icon: const Icon(Icons.lock_open_outlined),
              label: const Text('Odblokuj ustawienia przez UAC'),
            ),
            if (controller.status == 'admin_required') ...[
              const SizedBox(height: 12),
              _StatusLine(controller: controller),
            ],
          ],
        ),
      ),
    );
  }
}

class _SettingsSection extends StatelessWidget {
  const _SettingsSection({
    required this.title,
    required this.description,
    required this.children,
  });
  final String title;
  final String description;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    )),
            const SizedBox(height: 4),
            Text(description),
            const SizedBox(height: 18),
            ...children,
          ],
        ),
      ),
    );
  }
}
