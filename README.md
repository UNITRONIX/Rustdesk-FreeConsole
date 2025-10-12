# Rustdesk FreeConsole
![App Screenshot]([freeconsole.png](https://github.com/UNITRONIX/Rustdesk-FreeConsole/blob/main/freeconsole.png?raw=true))
## Project Description

Rustdesk FreeConsole is a web panel for viewing and managing data from an SQLite database (`db_v2.sqlite3`). The interface is built using the NiceGUI framework and provides:

- Viewing records from the `peer` table in the database
- Dynamic table refresh every 0.5 seconds
- Status coloring and expandable record details
- Record editing (edit button prepared for further development)

## Required Python Modules

To run the application, you need to install the following modules:

- `nicegui`
- `sqlite3` (built into Python)

Install dependencies:

```bash
pip install nicegui
```

## Running the Application

1. Place the `main.py` file in the `/opt/rustdesk` directory on your Linux server.
2. Make sure you have Python 3.8+ and the required modules installed.
3. Start the application with the command:

```bash
python3 /opt/rustdesk/main.py
```

The application starts by default on port 9000.

## systemd Service Configuration (Linux)

To run the application as a system service with administrator privileges:

1. Create the service file `/etc/systemd/system/rustdesk-freeconsole.service` with the following content:

```ini
[Unit]
Description=Rustdesk FreeConsole Web Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/rustdesk
ExecStart=/usr/bin/python3 /opt/rustdesk/main.py
Restart=always

[Install]
WantedBy=multi-user.target
```

2. Reload systemd and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable rustdesk-freeconsole
sudo systemctl start rustdesk-freeconsole
```

3. Check the service status:

```bash
sudo systemctl status rustdesk-freeconsole
```

**Note:**
- The script should be located in the `/opt/rustdesk` directory.
- The service runs with administrator privileges (`User=root`).
- Make sure port 9000 is open in your firewall.

## Author
UNITRONIX (Krzysztof Nienartowicz)
Project: Rustdesk FreeConsole
