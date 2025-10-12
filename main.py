
import sqlite3
from nicegui import ui

# Ścieżka do pliku bazy danych SQLite
DB_PATH = 'db_v2.sqlite3'

dark = ui.dark_mode(True)

# Funkcja pobierająca dane z bazy
def fetch_db_data():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT guid, id, uuid, pk, created_at, user, status, note, info FROM peer')
    rows = cursor.fetchall()
    conn.close()
    return rows

    rows = get_rows()
    table = ui.table(
        columns=columns,
        rows=rows,
        row_key='guid',
        column_defaults={
            'align': 'left',
            'headerClasses': 'uppercase text-primary',
        }
    )

    # Automatyczne odświeżanie danych co 500ms
    def refresh_table():
        table.rows = get_rows()
        table.update()

    ui.timer(0.5, refresh_table, repeat=True)

    ui.run(title='Rustdesk FreeConsole')





# Definicja kolumn widocznych cały czas
columns = [
    {'name': 'id', 'label': 'ID', 'field': 'id'},
    {'name': 'note', 'label': 'Note', 'field': 'note'},
    {'name': 'status', 'label': 'Status', 'field': 'status'},
]

def get_rows():
    db_rows = fetch_db_data()
    all_keys = ['guid', 'id', 'uuid', 'pk', 'created_at', 'user', 'status', 'note', 'info']
    def convert_value(val, col):
        blob_cols = {'guid', 'uuid', 'pk', 'user'}
        if col in blob_cols:
            if isinstance(val, bytes):
                return val.hex()
            return str(val)
        if col == 'created_at':
            if isinstance(val, str):
                return val
            try:
                return str(val)
            except Exception:
                return val
        if col == 'status':
            return int(val) if val is not None else None
        if isinstance(val, bytes):
            try:
                return val.decode('utf-8')
            except Exception:
                return val.hex()
        return val
    result = []
    for row in db_rows:
        row_dict = {k: convert_value(v, k) for k, v in zip(all_keys, row)}
        # Widoczne kolumny
        visible = {k: row_dict[k] for k in ['id', 'note', 'status']}
        # Ukryte kolumny do rozwinięcia
        hidden = {k: row_dict[k] for k in all_keys if k not in visible}
        visible['__hidden'] = hidden
        result.append(visible)
    return result







# Usuwamy globalny dialog, każdy wiersz ma swój dialog

rows = get_rows()
with ui.row().classes('grid grid-cols-3 w-full'):
    table = ui.table(
        columns=columns,
        rows=rows,
        row_key='id',
        selection='single',
        column_defaults={
            'align': 'left',
            'headerClasses': 'uppercase text-primary',
        },
        pagination={'rowsPerPage': 10, 'rowsPerPageOptions': [5, 10, 20, 50, 100]}
    ).classes('w-full col-span-2')

    with ui.card().classes('w-full h-full'):
        ui.label('Rustdesk FreeConsole').classes('text-h4 text-center q-pa-md w-full')
        ui.separator()
        ui.label('Functions:').classes('text-h6 q-mb-md')
        def show_private_key():
            import glob
            import os
            pub_files = glob.glob(os.path.join(os.path.dirname(__file__), '*.pub'))
            if not pub_files:
                content = 'No .pub file in directory.'
            else:
                with open(pub_files[0], 'r', encoding='utf-8') as f:
                    content = f.read()
            with ui.dialog() as dialog, ui.card():
                ui.label('Your private key:').classes('text-h6 q-mb-md')
                ui.label(content).classes('q-mb-md')
                ui.button('Close', on_click=dialog.close)
            dialog.open()
        ui.button('Show private key', on_click=show_private_key)

        ui.separator()


# Slot nagłówka
table.add_slot('header', r'''
    <q-tr :props="props">
        <q-th auto-width />
        <q-th v-for="col in props.cols" :key="col.name" :props="props">
            {{ col.label }}
        </q-th>
    </q-tr>
''')

# Slot wiersza z kolorowaniem statusu, edycją i rozwijaniem szczegółów
table.add_slot('body', r'''
    <q-tr :props="props">
        <q-td auto-width>
            <q-btn size="sm" color="accent" round dense
                @click="props.expand = !props.expand"
                :icon="props.expand ? 'remove' : 'add'" />
        </q-td>
        <q-td v-for="col in props.cols" :key="col.name" :props="props">
            <template v-if="col.name === 'status'">
                <div :style="`background:${props.row.status === 1 ? 'limegreen' : (props.row.status === 0 ? 'red' : 'gray')};color:white;padding:2px 8px;border-radius:6px;`">
                    {{ props.row.status }}
                </div>
            </template>
            <template v-else-if="col.name === 'edit'">
                <q-btn size='sm' color='primary' icon='edit' @click="$parent.$parent.$parent.$parent.$emit('edit-row', props.row)" />
            </template>
            <template v-else>
                {{ props.row[col.field] }}
            </template>
        </q-td>
    </q-tr>
    <q-tr v-show="props.expand" :props="props">
        <q-td colspan="100%">
            <div class="text-left q-pa-md" style="background:#1d1d1d;border-radius:8px;">
                <div v-for="(val, key) in props.row.__hidden" :key="key" style="margin-bottom: 16px;">
                    <div style="padding-bottom: 8px; border-bottom: 1px solid #e0e0e0; margin-bottom: 8px;">
                        <b style="font-size:1.1em; color:#1976d2;">{{ key }}:</b> <span style="font-size:1.1em;">{{ val }}</span>
                    </div>
                </div>
            </div>
        </q-td>
    </q-tr>
''')

# Obsługa kliknięcia przycisku edycji wiersza
def handle_edit_row(event):
    open_edit_dialog(event.args)
table.on('edit-row', handle_edit_row)

# Automatyczne odświeżanie danych co 500ms
def refresh_table():
    table.rows = get_rows()
    table.update()

ui.timer(0.5, refresh_table)

ui.run(title='Rustdesk FreeConsole', port=9000)
