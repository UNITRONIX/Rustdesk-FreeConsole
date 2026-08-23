import 'dart:convert';
import 'dart:io';

class BetterDeskDevice {
  const BetterDeskDevice({
    required this.id,
    required this.hostname,
    required this.platform,
    required this.online,
    required this.lastOnline,
  });

  final String id;
  final String hostname;
  final String platform;
  final bool online;
  final String lastOnline;

  factory BetterDeskDevice.fromJson(Map<String, dynamic> json) {
    return BetterDeskDevice(
      id: json['id'] as String? ?? '',
      hostname: json['hostname'] as String? ?? '',
      platform: json['platform'] as String? ?? '',
      online: json['online'] == true,
      lastOnline: json['last_online'] as String? ?? '',
    );
  }
}

class BetterDeskLoginResult {
  const BetterDeskLoginResult({
    required this.accessToken,
    required this.username,
    required this.role,
  });

  final String accessToken;
  final String username;
  final String role;
}

class BetterDeskEnrollmentResult {
  const BetterDeskEnrollmentResult({
    required this.status,
    required this.message,
  });

  final String status;
  final String message;
}

class BetterDeskAccountApi {
  const BetterDeskAccountApi();

  Future<BetterDeskEnrollmentResult> requestEnrollment({
    required Uri baseUri,
    required String deviceId,
    required String publicKey,
    String platform = 'windows',
    String version = 'betterdesk-desktop',
  }) async {
    final response = await _request(
      baseUri,
      '/api/devices/register',
      method: 'POST',
      body: {
        'device_id': deviceId,
        'public_key': publicKey,
        'platform': platform,
        'version': version,
        'device_type': 'betterdesk',
      },
    );
    return BetterDeskEnrollmentResult(
      status: response['status'] as String? ?? 'unknown',
      message: response['message'] as String? ?? '',
    );
  }

  Future<BetterDeskLoginResult> login({
    required Uri baseUri,
    required String username,
    required String password,
    String deviceId = '',
  }) async {
    final response = await _request(
      baseUri,
      '/api/bd/operator/login',
      method: 'POST',
      body: {
        'username': username,
        'password': password,
        if (deviceId.isNotEmpty) 'device_id': deviceId,
      },
    );
    final token = response['access_token'] as String? ?? '';
    final user = response['user'] as Map<String, dynamic>? ?? const {};
    if (token.isEmpty) {
      throw const BetterDeskAccountException('Serwer nie zwrócił tokenu.');
    }
    return BetterDeskLoginResult(
      accessToken: token,
      username: user['name'] as String? ?? username,
      role: user['role'] as String? ?? '',
    );
  }

  Future<List<BetterDeskDevice>> devices({
    required Uri baseUri,
    required String accessToken,
  }) async {
    final response = await _request(
      baseUri,
      '/api/bd/operator/devices',
      headers: {'Authorization': 'Bearer $accessToken'},
    );
    final values = response['devices'];
    if (values is! List<dynamic>) return const [];
    return values
        .whereType<Map<String, dynamic>>()
        .map(BetterDeskDevice.fromJson)
        .where((device) => device.id.isNotEmpty)
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> _request(
    Uri baseUri,
    String path, {
    String method = 'GET',
    Map<String, String> headers = const {},
    Map<String, dynamic>? body,
  }) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      final request = await client.openUrl(
        method,
        baseUri.replace(path: path, query: '', fragment: ''),
      );
      request.headers.contentType = ContentType.json;
      headers.forEach(request.headers.set);
      if (body != null) {
        request.write(jsonEncode(body));
      }
      final response = await request.close().timeout(
            const Duration(seconds: 12),
          );
      final raw = await response.transform(utf8.decoder).join();
      Map<String, dynamic> decoded = const {};
      if (raw.trim().isNotEmpty) {
        final value = jsonDecode(raw);
        if (value is Map<String, dynamic>) decoded = value;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final message = decoded['error'] as String? ?? 'Błąd serwera.';
        throw BetterDeskAccountException(message);
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }
}

class BetterDeskAccountException implements Exception {
  const BetterDeskAccountException(this.message);

  final String message;

  @override
  String toString() => message;
}
