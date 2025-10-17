
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
            'align': 'center',
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
    {'name': 'connect', 'label': 'Connect', 'field': 'connect'},
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
        # Dodaj pole connect jako HTML link (zastępuje ui.link)
        # Używamy bezpiecznego linku protokołu rustdesk://{id}
        rid = row_dict.get('id')
        if rid is None:
            connect_html = ''
        else:
            connect_html = f'<a href="rustdesk://{rid}" onclick="location.href=\'rustdesk://{rid}\'; return false;" style="background:#1976d2;color:white;padding:6px 10px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;">Connect</a>'
        visible['connect'] = connect_html
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
            'align': 'center',
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
        ui.button('Show private key', on_click=show_private_key).classes('w-full')
       
        # --- Edycja rekordu: prompt + dialog ---
        def edit_row_by_id(row_id: int):
            # pobierz wiersz z bazy
            conn = sqlite3.connect(DB_PATH)
            cur = conn.cursor()
            cur.execute('SELECT id, status, note FROM peer WHERE id=?', (row_id,))
            r = cur.fetchone()
            conn.close()
            if not r:
                with ui.dialog() as d, ui.card():
                    ui.label(f'Record with id={row_id} not found.')
                    ui.button('Close', on_click=d.close)
                d.open()
                return

            rid, rstatus, rnote = r
            with ui.dialog() as d, ui.card():
                ui.label(f'Edit record id={rid}').classes('text-h6 q-mb-md')
                note_input = ui.input('Note', value=(rnote or '')).props('outlined').classes('w-full')
                status_select = ui.select(['0','1'], label='Status', value=str(rstatus) if rstatus is not None else '0').props('outlined').classes('w-full')
                with ui.row():
                    def save():
                        try:
                            sval = int(status_select.value) if status_select.value is not None else 0
                        except Exception:
                            sval = 0
                        conn2 = sqlite3.connect(DB_PATH)
                        cur2 = conn2.cursor()
                        cur2.execute('UPDATE peer SET note=?, status=? WHERE id=?', (note_input.value, sval, rid))
                        conn2.commit()
                        conn2.close()
                        d.close()
                        refresh_table()
                    ui.button('Save', on_click=save).props('color=primary')
                    ui.button('Cancel', on_click=d.close).props('color=secondary')
            d.open()

        def edit_row_prompt():
            # now show a select populated from DB ids and a note input
            def get_all_ids():
                conn = sqlite3.connect(DB_PATH)
                cur = conn.cursor()
                cur.execute('SELECT id FROM peer')
                ids = [str(r[0]) for r in cur.fetchall()]
                conn.close()
                return ids

            ids = get_all_ids()
            with ui.dialog() as pd, ui.card():
                ui.label('Select ID to edit:').classes('text-h6 q-mb-md')
                id_select = ui.select(ids, label='ID', value=ids[0] if ids else None).props('outlined').classes('w-full')
                note_input = ui.input('Note').props('outlined').classes('w-full')
                with ui.row():
                    def go():
                        try:
                            iid = int(id_select.value) if id_select.value is not None else None
                        except Exception:
                            iid = None
                        pd.close()
                        if iid is not None:
                            # apply note directly
                            conn = sqlite3.connect(DB_PATH)
                            cur = conn.cursor()
                            cur.execute('UPDATE peer SET note=? WHERE id=?', (note_input.value, iid))
                            conn.commit()
                            conn.close()
                            refresh_table()
                    ui.button('Apply', on_click=go).props('color=green')
                    ui.button('Cancel', on_click=pd.close).props('color=red')
            pd.open()
        ui.button('Edit note', on_click=lambda: edit_row_prompt()).classes('w-full')

        ui.button('Edit status (coming soon)').classes('w-full')

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

# Slot wiersza — prosty render: pokazujemy wartości bez dodatkowych wskaźników
table.add_slot('body', r'''
    <q-tr :props="props">
        <q-td auto-width>
            <q-btn color="accent"
                @click="props.expand = !props.expand"
                :icon="props.expand ? 'remove' : 'add'" />
        </q-td>
        <q-td v-for="col in props.cols" :key="col.name" :props="props">
            <template v-if="col.name === 'status'">
                <template v-if="props.row.status === null || props.row.status === undefined || props.row.status === ''">
                    <span style="background:black;color:white;padding:4px 10px;border-radius:6px;display:inline-block;font-weight:600;">Undefined</span>
                </template>
                <template v-else-if="props.row.status == 0">
                    <span style="background:red;color:black;padding:4px 10px;border-radius:6px;display:inline-block;font-weight:600;">Blocked</span>
                </template>
                <template v-else-if="props.row.status == 1">
                    <span style="background:green;color:white;padding:4px 10px;border-radius:6px;display:inline-block;font-weight:600;">Active</span>
                </template>
                <template v-else>
                    <span>{{ props.row.status }}</span>
                </template>
            </template>
            <template v-else-if="col.name === 'connect'">
                <span v-html="props.row.connect"></span>
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

# Automatyczne odświeżanie danych co 500ms
def refresh_table():
    table.rows = get_rows()
    table.update()

ui.timer(0.5, refresh_table)

ui.run(title='Rustdesk FreeConsole', port=9000)
