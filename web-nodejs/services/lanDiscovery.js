/**
 * BetterDesk Console - LAN Discovery Service
 *
 * UDP broadcast responder on port 21119.
 * Clients send a JSON probe; the server replies with its identity
 * (name, version, public key, console URL, API port).
 *
 * Protocol:
 *   Client → broadcast 255.255.255.255:21119
 *     { "type": "betterdesk-discover", "version": 1 }
 *
 *   Server → unicast reply to client
 *     { "type": "betterdesk-announce", "version": 1, "server": { ... } }
 *
 * @module services/lanDiscovery
 */

const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const config = require('../config/config');

const DISCOVERY_PORT = parseInt(process.env.DISCOVERY_PORT, 10) || 21119;
const PROTOCOL_VERSION = 1;

let udpServer = null;

/**
 * Build the server announcement payload.
 * @returns {object} Server info for discovery response
 */
function buildAnnouncement() {
    // Read public key (base64) if available
    let publicKey = '';
    try {
        if (fs.existsSync(config.pubKeyPath)) {
            publicKey = fs.readFileSync(config.pubKeyPath, 'utf8').trim();
        }
    } catch (_) { /* ignore */ }

    // Gather local IP addresses
    const addresses = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }

    const host = process.env.PANEL_PUBLIC_HOST || config.host || 'localhost';
    const port = config.port;
    const protocol = config.httpsEnabled ? 'https' : 'http';
    const panelUrl = process.env.PANEL_PUBLIC_URL
        || `${protocol}://${host}${(protocol === 'https' && port === 443) || (protocol === 'http' && port === 80) ? '' : `:${port}`}`;

    return {
        type: 'betterdesk-announce',
        version: PROTOCOL_VERSION,
        server: {
            name: os.hostname(),
            version: config.appVersion,
            port: config.port,
            apiPort: config.apiPort,
            protocol,
            publicKey,
            addresses,
            discoveryPort: DISCOVERY_PORT,
            panelUrl,
        },
    };
}

/**
 * Start the UDP discovery responder.
 * @returns {{ server: dgram.Socket, port: number }} Handle for the running service
 */
function startDiscoveryService() {
    if (udpServer) {
        return { server: udpServer, port: DISCOVERY_PORT };
    }

    udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpServer.on('message', (msg, rinfo) => {
        try {
            const data = JSON.parse(msg.toString('utf8'));
            if (data.type !== 'betterdesk-discover') return;

            const announcement = buildAnnouncement();
            const reply = Buffer.from(JSON.stringify(announcement), 'utf8');

            udpServer.send(reply, 0, reply.length, rinfo.port, rinfo.address, (err) => {
                if (err) {
                    console.warn('LAN Discovery: failed to send reply:', err.message);
                }
            });
        } catch (_) {
            // Ignore non-JSON or malformed packets silently
        }
    });

    udpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`LAN Discovery: port ${DISCOVERY_PORT} already in use, service disabled`);
        } else {
            console.error('LAN Discovery error:', err.message);
        }
        udpServer = null;
    });

    udpServer.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        console.log(`  LAN Discovery active on UDP port ${DISCOVERY_PORT}`);
    });

    return { server: udpServer, port: DISCOVERY_PORT };
}

/**
 * Stop the UDP discovery service.
 */
function stopDiscoveryService() {
    if (udpServer) {
        udpServer.close();
        udpServer = null;
    }
}

module.exports = {
    DISCOVERY_PORT,
    startDiscoveryService,
    stopDiscoveryService,
    buildAnnouncement,
};
