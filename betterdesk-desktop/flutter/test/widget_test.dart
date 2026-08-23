import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:betterdesk_desktop/main.dart';

void main() {
  testWidgets('renders the operator overview', (tester) async {
    final controller = AppController(null);
    await tester.pumpWidget(BetterDeskApp(controller: controller));

    expect(find.text('Przegląd'), findsNothing);
    expect(find.text('Połącz z urządzeniem'), findsOneWidget);
    expect(find.text('Szybkie połączenie'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Ostatnie połączenia'),
      300,
      scrollable: find
          .descendant(
            of: find.byKey(const ValueKey('peers-scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.text('Ostatnie połączenia'), findsOneWidget);
  });

  testWidgets('settings page exposes administrator boundary', (tester) async {
    final controller = AppController(null);
    await tester.pumpWidget(BetterDeskApp(controller: controller));
    controller.selectPage(ClientPage.settings);
    await tester.pumpAndSettle();

    expect(find.text('Konfiguracja połączenia jest chroniona'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Ustawienia systemowe'),
      300,
      scrollable: find
          .descendant(
            of: find.byKey(const ValueKey('settings-scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    final lockedSwitches =
        tester.widgetList<Switch>(find.byType(Switch)).toList();
    expect(lockedSwitches.last.onChanged, isNull);
    expect(
      tester
          .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Zarządzaj'))
          .onPressed,
      isNull,
    );
    controller.settingsUnlocked = true;
    controller.notifyListeners();
    await tester.pumpAndSettle();
    expect(find.text('Serwer ID'), findsOneWidget);
    expect(find.text('Serwer pośredniczący'), findsOneWidget);
    expect(find.text('Serwer API'), findsOneWidget);
    expect(find.text('Klucz publiczny serwera'), findsOneWidget);
    expect(find.text('Testuj połączenie'), findsOneWidget);
    expect(find.text('Tryb zgodności RustDesk: HTTP bez TLS'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Ustawienia systemowe'),
      300,
      scrollable: find
          .descendant(
            of: find.byKey(const ValueKey('settings-scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.text('Ustawienia systemowe'), findsOneWidget);
    expect(
      find.text('Te ustawienia wymagają zgody administratora.'),
      findsOneWidget,
    );
    final unlockedSwitches =
        tester.widgetList<Switch>(find.byType(Switch)).toList();
    expect(unlockedSwitches.last.onChanged, isNotNull);
    expect(
      tester
          .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Zarządzaj'))
          .onPressed,
      isNotNull,
    );
  });

  testWidgets('keeps the peer ID cursor stable while the app rebuilds',
      (tester) async {
    final controller = AppController(null);
    await tester.pumpWidget(BetterDeskApp(controller: controller));

    final field = find.byType(TextField).first;
    await tester.enterText(field, '123456');
    final fieldController = tester.widget<TextField>(field).controller!;
    fieldController.selection = const TextSelection.collapsed(offset: 3);
    controller.notifyListeners();
    await tester.pump();

    expect(tester.widget<TextField>(field).controller, same(fieldController));
    expect(fieldController.text, '123456');
    expect(fieldController.selection.baseOffset, 3);
  });

  test('validates and stores complete server configuration', () {
    final controller = AppController(null);
    controller.settingsUnlocked = true;

    expect(
      controller.saveConnection(
        idServerValue: 'desk.example.test:21116',
        relayServerValue: 'desk.example.test:21117',
        apiUrlValue: 'https://desk.example.test',
        serverKeyValue: List.filled(32, 'ab').join(),
      ),
      isTrue,
    );
    expect(controller.idServer, 'desk.example.test:21116');
    expect(controller.relayServer, 'desk.example.test:21117');
    expect(controller.apiUrl, 'https://desk.example.test');

    expect(
      controller.saveConnection(
        idServerValue: 'desk.example.test:21116',
        relayServerValue: 'desk.example.test:21117',
        apiUrlValue: 'http://desk.example.test',
        serverKeyValue: '',
      ),
      isTrue,
    );

    expect(
      controller.saveConnection(
        idServerValue: '',
        relayServerValue: '',
        apiUrlValue: '',
        serverKeyValue: '',
      ),
      isFalse,
    );
  });
}
