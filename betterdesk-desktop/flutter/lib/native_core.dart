import 'dart:ffi';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

typedef _VersionNative = Pointer<Utf8> Function();
typedef _ValidateNative = Uint8 Function(Pointer<Utf8>);
typedef _RequestAdminNative = Uint8 Function(Pointer<Utf8>);
typedef _GenerateStringNative = Pointer<Utf8> Function();
typedef _CaptureNative = IntPtr Function(Pointer<Uint8>, IntPtr);
typedef _InjectNative = Uint8 Function(Pointer<Utf8>);
typedef _StartRegistrationNative = Uint8 Function(
    Pointer<Utf8>, Pointer<Utf8>, Pointer<Utf8>);

class NativeCore {
  NativeCore._(DynamicLibrary library)
      : _version = library
            .lookup<NativeFunction<_VersionNative>>('bd_client_version')
            .asFunction(),
        _validate = library
            .lookup<NativeFunction<_ValidateNative>>('bd_validate_server_url')
            .asFunction(),
        _requestAdmin = library
            .lookup<NativeFunction<_RequestAdminNative>>('bd_request_admin')
            .asFunction(),
        _generateDeviceId = library
            .lookup<NativeFunction<_GenerateStringNative>>(
                'bd_generate_device_id')
            .asFunction(),
        _generatePassword = library
            .lookup<NativeFunction<_GenerateStringNative>>(
              'bd_generate_rotating_password',
            )
            .asFunction(),
        _generateKeypair = library
            .lookup<NativeFunction<_GenerateStringNative>>(
              'bd_generate_identity_keypair',
            )
            .asFunction(),
        _capture = library
            .lookup<NativeFunction<_CaptureNative>>('bd_capture_screen_jpeg')
            .asFunction(),
        _inject = library
            .lookup<NativeFunction<_InjectNative>>('bd_inject_input')
            .asFunction(),
        _startRegistration = library
            .lookup<NativeFunction<_StartRegistrationNative>>(
                'bd_start_registration')
            .asFunction(),
        _registrationStatus = library
            .lookup<NativeFunction<_GenerateStringNative>>(
                'bd_registration_status')
            .asFunction();

  final Pointer<Utf8> Function() _version;
  final int Function(Pointer<Utf8>) _validate;
  final int Function(Pointer<Utf8>) _requestAdmin;
  final Pointer<Utf8> Function() _generateDeviceId;
  final Pointer<Utf8> Function() _generatePassword;
  final Pointer<Utf8> Function() _generateKeypair;
  final int Function(Pointer<Uint8>, int) _capture;
  final int Function(Pointer<Utf8>) _inject;
  final int Function(Pointer<Utf8>, Pointer<Utf8>, Pointer<Utf8>)
      _startRegistration;
  final Pointer<Utf8> Function() _registrationStatus;

  static NativeCore? tryLoad() {
    final names = Platform.isWindows
        ? const ['betterdesk_desktop.dll']
        : const ['libbetterdesk_desktop.so'];
    final executableDirectory = File(Platform.resolvedExecutable).parent.path;
    final candidates = <String>[
      ...names,
      ...names.map(
        (name) => '$executableDirectory${Platform.pathSeparator}$name',
      ),
    ];
    for (final name in candidates) {
      try {
        return NativeCore._(DynamicLibrary.open(name));
      } catch (_) {
        // The Flutter shell remains usable while running from source before
        // the Rust library has been copied by build.py.
      }
    }
    return null;
  }

  String get version => _version().toDartString();

  bool validateServerUrl(String value) {
    final pointer = value.toNativeUtf8();
    try {
      return _validate(pointer) != 0;
    } finally {
      calloc.free(pointer);
    }
  }

  bool requestAdmin(String operation) {
    final pointer = operation.toNativeUtf8();
    try {
      return _requestAdmin(pointer) != 0;
    } finally {
      calloc.free(pointer);
    }
  }

  Future<bool> requestAdminAsync(String operation) {
    return Isolate.run(() {
      try {
        return NativeCore.tryLoad()?.requestAdmin(operation) ?? false;
      } catch (_) {
        return false;
      }
    });
  }

  String generateDeviceId() => _generateDeviceId().toDartString();

  String generateRotatingPassword() => _generatePassword().toDartString();

  String generateIdentityKeypair() => _generateKeypair().toDartString();

  Uint8List? captureScreenJpeg({int capacity = 8 * 1024 * 1024}) {
    final buffer = calloc<Uint8>(capacity);
    try {
      final length = _capture(buffer, capacity);
      if (length <= 0 || length > capacity) return null;
      return Uint8List.fromList(buffer.asTypedList(length));
    } finally {
      calloc.free(buffer);
    }
  }

  bool injectInput(Map<String, dynamic> input) {
    final pointer = jsonEncode(input).toNativeUtf8();
    try {
      return _inject(pointer) != 0;
    } finally {
      calloc.free(pointer);
    }
  }

  bool startRegistration({
    required Map<String, dynamic> config,
    required String deviceId,
    required String publicKey,
  }) {
    final configPointer = jsonEncode(config).toNativeUtf8();
    final devicePointer = deviceId.toNativeUtf8();
    final keyPointer = publicKey.toNativeUtf8();
    try {
      return _startRegistration(configPointer, devicePointer, keyPointer) != 0;
    } finally {
      calloc
        ..free(configPointer)
        ..free(devicePointer)
        ..free(keyPointer);
    }
  }

  String registrationStatus() => _registrationStatus().toDartString();
}
