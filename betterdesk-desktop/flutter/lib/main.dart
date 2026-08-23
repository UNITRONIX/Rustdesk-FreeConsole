import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'account_api.dart';
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
  bool allowUntrustedTls = false;
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
  String accountUsername = '';
  String accountRole = '';
  final List<BetterDeskDevice> accountDevices = [];
  String accountMessage = '';
  bool _accountBusy = false;
  bool _allowClose = false;
  bool _registrationWatcherActive = false;
  bool _enrollmentFallbackInProgress = false;
  bool _probeInProgress = false;
  bool _unlockInProgress = false;
  bool _adminOperationInProgress = false;
  static const _storage = FlutterSecureStorage();
  static const _accountApi = BetterDeskAccountApi();
  static const passwordRotationPeriod = Duration(minutes: 15);
  static const rotatingPasswordLength = 8;

  String get serverUrl => apiUrl;
  bool get configured => idServer.trim().isNotEmpty || apiUrl.trim().isNotEmpty;
  bool get isBusy => _probeInProgress || _unlockInProgress;
  bool get unlockInProgress => _unlockInProgress;
  bool get accountLoggedIn => accountUsername.isNotEmpty;
  bool get accountBusy => _accountBusy;

  String get registrationStatusLabel {
    if (registrationStatus == 'idle') return 'Nie uruchomiono';
    if (registrationStatus == 'registering') return 'Rejestracja w toku';
    if (registrationStatus.startsWith('registered:')) return 'Zarejestrowane';
    if (registrationStatus == 'pending_approval') {
      return 'Oczekuje na akceptację';
    }
    if (registrationStatus
        .contains('device registration refused with result 6')) {
      return 'Serwer wymaga zgody na urządzenie';
    }
    if (registrationStatus.startsWith('failed:')) {
      return 'Rejestracja nieudana';
    }
    if (registrationStatus.startsWith('invalid_')) {
      return 'Nieprawidłowe dane';
    }
    if (registrationStatus == 'unavailable') return 'Wymaga konfiguracji';
    if (registrationStatus == 'native_unavailable') {
      return 'Brak modułu klienta';
    }
    return 'Niedostępne';
  }

  Future<void> loadPersistentSettings() async {
    try {
      final values = await _storage.readAll();
      idServer = values['connection.id_server'] ?? '';
      relayServer = values['connection.relay_server'] ?? '';
      apiUrl = values['connection.api_url'] ?? '';
      serverKey = values['connection.server_key'] ?? '';
      allowUntrustedTls = values['connection.allow_untrusted_tls'] == 'true';
      darkMode = values['ui.dark_mode'] == 'true';
      deviceId = values['identity.device_id'] ?? '';
      rotatingPassword = values['identity.rotating_password'] ?? '';
      identityPrivateKey = values['identity.private_key'] ?? '';
      identityPublicKey = values['identity.public_key'] ?? '';
      passwordRotatedAt =
          DateTime.tryParse(values['identity.rotated_at'] ?? '');
      accountUsername = values['account.username'] ?? '';
      accountRole = values['account.role'] ?? '';
      final accountToken = values['account.access_token'] ?? '';
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
        _startRegistration();
        if (accountToken.isNotEmpty) {
          unawaited(_restoreAccount(accountToken));
        }
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
      await _storage.write(
        key: 'connection.allow_untrusted_tls',
        value: allowUntrustedTls.toString(),
      );
    } catch (_) {
      status = 'failed';
      statusMessage =
          'Konfiguracja nie została zapisana w magazynie systemowym.';
      notifyListeners();
    }
  }

  Future<void> _ensureIdentity() async {
    final now = DateTime.now().toUtc();
    final needsPassword = rotatingPassword.length != rotatingPasswordLength ||
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
    if (nativeCore == null) {
      registrationStatus = 'native_unavailable';
      return false;
    }
    if (idServer.trim().isEmpty ||
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
        'allow_untrusted_tls': allowUntrustedTls,
      },
      deviceId: deviceId,
      publicKey: identityPublicKey,
    );
    registrationStatus = nativeCore!.registrationStatus();
    _watchRegistration();
    return started;
  }

  Future<void> _prepareAndStartRegistration() async {
    await _ensureIdentity();
    _startRegistration();
    notifyListeners();
  }

  void setAllowUntrustedTls(bool value) {
    allowUntrustedTls = value;
    status = 'idle';
    statusMessage = value
        ? 'Uwaga: certyfikat TLS nie będzie sprawdzany. Używaj tylko na serwerze testowym.'
        : 'Weryfikacja certyfikatu TLS jest włączona.';
    unawaited(_persistSettings());
    notifyListeners();
    if (configured) {
      unawaited(_prepareAndStartRegistration());
    }
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
          if (!next.startsWith('registering')) {
            await _submitPendingEnrollmentIfNeeded();
            break;
          }
        }
      } finally {
        _registrationWatcherActive = false;
      }
    }());
  }

  Future<String> _waitForRegistration() async {
    if (nativeCore == null) return registrationStatus;
    for (var attempt = 0; attempt < 30; attempt++) {
      if (!registrationStatus.startsWith('registering')) {
        return registrationStatus;
      }
      await Future<void>.delayed(const Duration(milliseconds: 500));
      registrationStatus = nativeCore!.registrationStatus();
      notifyListeners();
    }
    return registrationStatus;
  }

  Future<void> _submitPendingEnrollmentIfNeeded() async {
    if (_enrollmentFallbackInProgress ||
        !registrationStatus.contains('result 6')) {
      return;
    }
    final baseUri = _enrollmentBaseUri();
    if (baseUri == null || deviceId.trim().isEmpty) return;
    _enrollmentFallbackInProgress = true;
    try {
      final result = await _accountApi.requestEnrollment(
        baseUri: baseUri,
        deviceId: deviceId,
        publicKey: identityPublicKey,
      );
      if (result.status == 'pending') {
        registrationStatus = 'pending_approval';
        status = 'pending_approval';
        statusMessage =
            'Urządzenie czeka na akceptację administratora w panelu BetterDesk.';
        notifyListeners();
      }
    } catch (_) {
      // Keep the signal result when the optional HTTP metadata endpoint is
      // unavailable.
    } finally {
      _enrollmentFallbackInProgress = false;
    }
  }

  Future<bool> unlockConnectionSettings() async {
    if (_unlockInProgress) return false;
    _unlockInProgress = true;
    status = 'authorizing';
    statusMessage = 'Potwierdź uprawnienia administratora w oknie Windows.';
    notifyListeners();
    try {
      final authorized =
          await nativeCore?.requestAdminAsync('change_server_endpoint') ??
              false;
      if (authorized) {
        settingsUnlocked = true;
        status = 'idle';
        statusMessage = 'Ustawienia zostały odblokowane.';
      } else {
        status = 'admin_required';
        statusMessage = nativeCore == null
            ? 'Brak lokalnego modułu uprawnień. Uruchom pełny pakiet klienta.'
            : 'Uprawnienia nie zostały nadane.';
      }
      return authorized;
    } catch (_) {
      status = 'admin_required';
      statusMessage = 'Nie udało się uzyskać uprawnień administratora.';
      return false;
    } finally {
      _unlockInProgress = false;
      notifyListeners();
    }
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
      unawaited(_prepareAndStartRegistration());
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
    if (!configured || _probeInProgress || _unlockInProgress) return;
    _probeInProgress = true;
    status = 'connecting';
    statusMessage = 'Testowanie ID servera, relay i API…';
    notifyListeners();

    try {
      if (nativeCore != null) {
        await _ensureIdentity();
      }
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
      if (_startRegistration() || registrationStatus == 'registering') {
        await _waitForRegistration();
        await _submitPendingEnrollmentIfNeeded();
        checks.add('rejestracja: $registrationStatusLabel');
      }
      if (registrationStatus == 'pending_approval') {
        status = 'pending_approval';
        statusMessage =
            'Urządzenie czeka na akceptację administratora w panelu BetterDesk.';
        return;
      }
      if (registrationStatus.startsWith('failed:')) {
        final reason = registrationStatus.substring('failed:'.length).trim();
        status = 'failed';
        statusMessage = reason.isEmpty
            ? 'Rejestracja na serwerze nie powiodła się.'
            : 'Rejestracja na serwerze nie powiodła się: ${_safeError(reason)}';
        return;
      }
      status = 'online';
      statusMessage = 'Połączenie poprawne: ${checks.join(', ')}.';
      _recordPeer(peerId);
    } catch (error) {
      status = 'failed';
      statusMessage = 'Test połączenia nieudany: ${_safeError(error)}';
    } finally {
      _probeInProgress = false;
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
    peerId = value;
  }

  void connectToPeer(String value) {
    setPeer(value);
    startSession();
  }

  Future<void> loginAccount({
    required String username,
    required String password,
  }) async {
    if (_accountBusy) return;
    final baseUri = _accountBaseUri();
    if (baseUri == null) {
      accountMessage = 'Najpierw ustaw adres API BetterDesk.';
      notifyListeners();
      return;
    }
    if (baseUri.scheme != 'https' && !_isLoopbackHost(baseUri.host)) {
      accountMessage = 'Logowanie do konta wymaga bezpiecznego HTTPS.';
      notifyListeners();
      return;
    }
    _accountBusy = true;
    accountMessage = 'Logowanie…';
    notifyListeners();
    try {
      final result = await _accountApi.login(
        baseUri: baseUri,
        username: username.trim(),
        password: password,
        deviceId: deviceId,
      );
      accountUsername = result.username;
      accountRole = result.role;
      await Future.wait([
        _storage.write(key: 'account.access_token', value: result.accessToken),
        _storage.write(key: 'account.username', value: result.username),
        _storage.write(key: 'account.role', value: result.role),
      ]);
      await _syncAccountDevices(result.accessToken);
      accountMessage = 'Zalogowano. Książka urządzeń jest aktualna.';
    } on BetterDeskAccountException catch (error) {
      accountMessage = _safeError(error);
    } catch (_) {
      accountMessage = 'Nie można połączyć z serwerem konta.';
    } finally {
      _accountBusy = false;
      notifyListeners();
    }
  }

  Future<void> syncAccountDevices() async {
    if (_accountBusy || !accountLoggedIn) return;
    final token = await _storage.read(key: 'account.access_token');
    if (token == null || token.isEmpty) {
      await logoutAccount();
      return;
    }
    _accountBusy = true;
    accountMessage = 'Pobieranie urządzeń…';
    notifyListeners();
    try {
      await _syncAccountDevices(token);
      accountMessage = 'Książka urządzeń jest aktualna.';
    } on BetterDeskAccountException catch (error) {
      if (error.message.contains('Invalid') ||
          error.message.contains('Unauthorized')) {
        await logoutAccount();
      } else {
        accountMessage = _safeError(error);
      }
    } catch (_) {
      accountMessage = 'Nie można pobrać książki urządzeń.';
    } finally {
      _accountBusy = false;
      notifyListeners();
    }
  }

  Future<void> logoutAccount() async {
    accountUsername = '';
    accountRole = '';
    accountDevices.clear();
    accountMessage = 'Wylogowano.';
    await Future.wait([
      _storage.delete(key: 'account.access_token'),
      _storage.delete(key: 'account.username'),
      _storage.delete(key: 'account.role'),
    ]);
    notifyListeners();
  }

  Future<void> _syncAccountDevices(
    String token, {
    bool silent = false,
  }) async {
    final baseUri = _accountBaseUri();
    if (baseUri == null) return;
    final devices = await _accountApi.devices(
      baseUri: baseUri,
      accessToken: token,
    );
    accountDevices
      ..clear()
      ..addAll(devices);
    if (!silent) notifyListeners();
  }

  Future<void> _restoreAccount(String token) async {
    try {
      await _syncAccountDevices(token, silent: true);
    } catch (_) {
      accountUsername = '';
      accountRole = '';
      accountDevices.clear();
      accountMessage = 'Sesja konta wygasła. Zaloguj się ponownie.';
      await _storage.delete(key: 'account.access_token');
      notifyListeners();
    }
  }

  Uri? _accountBaseUri() {
    final raw = apiUrl.trim();
    if (raw.isEmpty) return null;
    final parsed = Uri.tryParse(
      raw.contains('://') ? raw : 'https://$raw',
    );
    if (parsed == null || parsed.host.isEmpty) return null;
    return parsed.replace(path: '', query: '', fragment: '');
  }

  Uri? _enrollmentBaseUri() {
    final baseUri = _accountBaseUri();
    if (baseUri == null || baseUri.port != 21121) return baseUri;
    return baseUri.replace(port: 21114);
  }

  static bool _isLoopbackHost(String host) {
    return host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        host == '[::1]';
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

  Future<void> requestAdminSetting(
    String operation, {
    required String label,
  }) async {
    if (!settingsUnlocked) {
      status = 'admin_required';
      statusMessage = 'Najpierw odblokuj ustawienia przyciskiem powyżej.';
      notifyListeners();
      return;
    }
    if (_adminOperationInProgress) return;
    _adminOperationInProgress = true;
    status = 'authorizing';
    statusMessage = 'Potwierdź zmianę ustawienia „$label”.';
    notifyListeners();
    try {
      final authorized =
          await nativeCore?.requestAdminAsync(operation) ?? false;
      status = authorized ? 'idle' : 'admin_required';
      statusMessage = authorized
          ? 'Ustawienie „$label” zostało odblokowane.'
          : nativeCore == null
              ? 'Brak lokalnego modułu uprawnień.'
              : 'Zmiana ustawienia „$label” została anulowana.';
    } catch (_) {
      status = 'admin_required';
      statusMessage = 'Nie udało się zmienić ustawienia „$label”.';
    } finally {
      _adminOperationInProgress = false;
      notifyListeners();
    }
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

  String _fallbackDeviceId() {
    final random = math.Random.secure();
    return (100000000 + random.nextInt(900000000)).toString();
  }

  String _fallbackPassword() {
    const alphabet =
        'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@\$%';
    final random = math.Random.secure();
    return List.generate(
      rotatingPasswordLength,
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

class _ConnectionCard extends StatefulWidget {
  const _ConnectionCard({required this.controller});
  final AppController controller;

  @override
  State<_ConnectionCard> createState() => _ConnectionCardState();
}

class _ConnectionCardState extends State<_ConnectionCard> {
  late final TextEditingController _peerController;

  @override
  void initState() {
    super.initState();
    _peerController = TextEditingController(text: widget.controller.peerId);
  }

  @override
  void didUpdateWidget(covariant _ConnectionCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    final externalValue = widget.controller.peerId;
    if (externalValue != _peerController.text) {
      _peerController.value = TextEditingValue(
        text: externalValue,
        selection: TextSelection.collapsed(offset: externalValue.length),
      );
    }
  }

  @override
  void dispose() {
    _peerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
                    controller: _peerController,
                    onChanged: (value) {
                      widget.controller.setPeer(value);
                      setState(() {});
                    },
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.computer_outlined),
                      hintText: 'ID urządzenia, np. BD-1234',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: widget.controller.configured &&
                          _peerController.text.trim().isNotEmpty
                      ? widget.controller.startSession
                      : null,
                  icon: widget.controller.isBusy
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
            _StatusLine(controller: widget.controller),
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
        _AccountCard(controller: controller),
        const SizedBox(height: 16),
        _IdentityCard(controller: controller),
        const SizedBox(height: 16),
        _RecentPeersCard(controller: controller),
      ],
    );
  }
}

class _AccountCard extends StatefulWidget {
  const _AccountCard({required this.controller});

  final AppController controller;

  @override
  State<_AccountCard> createState() => _AccountCardState();
}

class _AccountCardState extends State<_AccountCard> {
  late final TextEditingController _usernameController;
  late final TextEditingController _passwordController;
  bool _obscurePassword = true;

  @override
  void initState() {
    super.initState();
    _usernameController =
        TextEditingController(text: widget.controller.accountUsername);
    _passwordController = TextEditingController();
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    await widget.controller.loginAccount(
      username: _usernameController.text,
      password: _passwordController.text,
    );
    if (widget.controller.accountLoggedIn) {
      _passwordController.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    if (controller.accountLoggedIn) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.account_circle_outlined,
                      color: Theme.of(context).colorScheme.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Konto BetterDesk',
                            style: Theme.of(context).textTheme.titleLarge),
                        Text(
                          '${controller.accountUsername}${controller.accountRole.isEmpty ? '' : ' · ${controller.accountRole}'}',
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Odśwież urządzenia',
                    onPressed: controller.accountBusy
                        ? null
                        : controller.syncAccountDevices,
                    icon: controller.accountBusy
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh),
                  ),
                  TextButton(
                    onPressed: controller.accountBusy
                        ? null
                        : controller.logoutAccount,
                    child: const Text('Wyloguj'),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (controller.accountDevices.isEmpty)
                const Text('Brak urządzeń dostępnych dla tego konta.')
              else ...[
                Text('Urządzenia',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                ...controller.accountDevices.take(20).map(
                      (device) => ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        leading: Icon(
                          device.online ? Icons.circle : Icons.circle_outlined,
                          size: 14,
                          color: device.online ? Colors.green : Colors.grey,
                        ),
                        title: Text(
                          device.hostname.isEmpty ? device.id : device.hostname,
                        ),
                        subtitle: Text(
                          device.hostname.isEmpty
                              ? device.id
                              : '${device.id}${device.platform.isEmpty ? '' : ' · ${device.platform}'}',
                        ),
                        trailing: const Icon(Icons.arrow_forward),
                        onTap: controller.isBusy
                            ? null
                            : () => controller.connectToPeer(device.id),
                      ),
                    ),
              ],
              if (controller.accountMessage.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(controller.accountMessage),
              ],
            ],
          ),
        ),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Konto BetterDesk',
                style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            const Text(
              'Zaloguj się, aby synchronizować książkę urządzeń i łączyć się jednym kliknięciem.',
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _usernameController,
                    enabled: !controller.accountBusy,
                    decoration: const InputDecoration(
                      labelText: 'Nazwa użytkownika',
                      prefixIcon: Icon(Icons.person_outline),
                    ),
                    onChanged: (_) => setState(() {}),
                    onSubmitted: (_) => _login(),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _passwordController,
                    enabled: !controller.accountBusy,
                    obscureText: _obscurePassword,
                    decoration: InputDecoration(
                      labelText: 'Hasło',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        tooltip:
                            _obscurePassword ? 'Pokaż hasło' : 'Ukryj hasło',
                        onPressed: () => setState(
                          () => _obscurePassword = !_obscurePassword,
                        ),
                        icon: Icon(
                          _obscurePassword
                              ? Icons.visibility_outlined
                              : Icons.visibility_off_outlined,
                        ),
                      ),
                    ),
                    onChanged: (_) => setState(() {}),
                    onSubmitted: (_) => _login(),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: controller.accountBusy ||
                          _usernameController.text.trim().isEmpty ||
                          _passwordController.text.isEmpty
                      ? null
                      : _login,
                  icon: controller.accountBusy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.login),
                  label: const Text('Zaloguj'),
                ),
              ],
            ),
            if (controller.accountMessage.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(controller.accountMessage),
            ],
          ],
        ),
      ),
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
              subtitle: Text(controller.registrationStatusLabel),
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

class SettingsPage extends StatefulWidget {
  const SettingsPage({required this.controller, super.key});
  final AppController controller;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final TextEditingController _idServerController;
  late final TextEditingController _relayServerController;
  late final TextEditingController _apiController;
  late final TextEditingController _keyController;

  @override
  void initState() {
    super.initState();
    _idServerController =
        TextEditingController(text: widget.controller.idServer);
    _relayServerController =
        TextEditingController(text: widget.controller.relayServer);
    _apiController = TextEditingController(text: widget.controller.apiUrl);
    _keyController = TextEditingController(text: widget.controller.serverKey);
  }

  @override
  void didUpdateWidget(covariant SettingsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncField(_idServerController, widget.controller.idServer);
    _syncField(_relayServerController, widget.controller.relayServer);
    _syncField(_apiController, widget.controller.apiUrl);
    _syncField(_keyController, widget.controller.serverKey);
  }

  void _syncField(TextEditingController field, String value) {
    if (field.text == value) return;
    field.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
  }

  @override
  void dispose() {
    _idServerController.dispose();
    _relayServerController.dispose();
    _apiController.dispose();
    _keyController.dispose();
    super.dispose();
  }

  void _save() {
    widget.controller.saveConnection(
      idServerValue: _idServerController.text,
      relayServerValue: _relayServerController.text,
      apiUrlValue: _apiController.text,
      serverKeyValue: _keyController.text,
    );
  }

  void _test() {
    unawaited(widget.controller.testConnection(
      idServerValue: _idServerController.text,
      relayServerValue: _relayServerController.text,
      apiUrlValue: _apiController.text,
      serverKeyValue: _keyController.text,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final systemSettingsEnabled = controller.settingsUnlocked;
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
                'Podaj adresy serwera. Domyślne porty: ID 21116, relay 21117.',
            children: [
              TextField(
                controller: _idServerController,
                decoration: const InputDecoration(
                  labelText: 'Serwer ID',
                  hintText: 'host lub host:21116',
                  prefixIcon: Icon(Icons.dns_outlined),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _relayServerController,
                decoration: const InputDecoration(
                  labelText: 'Serwer pośredniczący',
                  hintText: 'host lub host:21117',
                  prefixIcon: Icon(Icons.alt_route_outlined),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _apiController,
                decoration: const InputDecoration(
                  labelText: 'Serwer API',
                  hintText: 'https://desk.example.com',
                  prefixIcon: Icon(Icons.language),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _keyController,
                decoration: const InputDecoration(
                  labelText: 'Klucz publiczny serwera',
                  hintText: 'Base64 lub 64 znaki HEX',
                  prefixIcon: Icon(Icons.key_outlined),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Bezpieczne połączenie jest wybierane automatycznie. Klucz sprawdza serwer.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Zezwól na niezaufany certyfikat TLS'),
                subtitle: const Text(
                  'Włącz tylko na serwerze testowym z własnym certyfikatem.',
                ),
                value: controller.allowUntrustedTls,
                onChanged: controller.setAllowUntrustedTls,
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilledButton.icon(
                    onPressed: controller.isBusy ? null : _save,
                    icon: const Icon(Icons.save_outlined),
                    label: const Text('Zapisz konfigurację'),
                  ),
                  OutlinedButton.icon(
                    onPressed: controller.isBusy ? null : _test,
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
                        : () => unawaited(controller.requestAdminSetting(
                              'change_server_key',
                              label: 'klucza serwera',
                            )),
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
          description: 'Te ustawienia wymagają zgody administratora.',
          children: [
            if (!systemSettingsEnabled)
              const Padding(
                padding: EdgeInsets.only(bottom: 12),
                child: Text(
                  'Odblokuj ustawienia przyciskiem powyżej, aby móc je zmieniać.',
                ),
              ),
            AbsorbPointer(
              absorbing: !systemSettingsEnabled,
              child: Opacity(
                opacity: systemSettingsEnabled ? 1 : 0.45,
                child: Column(
                  children: [
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.power_settings_new),
                      title: const Text('Uruchamiaj przy starcie systemu'),
                      subtitle: const Text(
                          'Włącz uruchamianie klienta przy starcie.'),
                      trailing: Switch.adaptive(
                        value: controller.autostart,
                        onChanged: systemSettingsEnabled
                            ? (_) => unawaited(
                                  controller.requestAdminSetting(
                                    'configure_autostart',
                                    label: 'autostartu',
                                  ),
                                )
                            : null,
                      ),
                    ),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.admin_panel_settings_outlined),
                      title: const Text('Usługa i dostęp zdalny'),
                      subtitle:
                          const Text('Wymaga osobnej zgody administratora.'),
                      trailing: OutlinedButton(
                        onPressed: systemSettingsEnabled
                            ? () => unawaited(
                                  controller.requestAdminSetting(
                                    'configure_unattended_access',
                                    label: 'dostępu zdalnego',
                                  ),
                                )
                            : null,
                        child: const Text('Zarządzaj'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (controller.status == 'admin_required' ||
                controller.status == 'authorizing')
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
              'Dane serwera i ustawienia systemowe są ukryte. Kliknij przycisk i potwierdź zgodę administratora.',
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: controller.unlockInProgress
                  ? null
                  : () => unawaited(controller.unlockConnectionSettings()),
              icon: controller.unlockInProgress
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.lock_open_outlined),
              label: Text(controller.unlockInProgress
                  ? 'Czekaj na zgodę administratora'
                  : 'Odblokuj ustawienia'),
            ),
            if (controller.status == 'admin_required' ||
                controller.status == 'authorizing') ...[
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
