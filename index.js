const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const chalk = require('chalk');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let shadow;
let isWhatsAppConnected = false;
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

async function startSesi() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    shadow = makeWASocket({
        version,
        keepAliveIntervalMs: 30000,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: ['Mac OS', 'Safari', '10.15.7'],
        getMessage: async () => ({ conversation: 'P' }),
    });

    shadow.ev.on('creds.update', saveCreds);
    store.bind(shadow.ev);

    shadow.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            isWhatsAppConnected = true;
            io.emit('console', '🟢 WHATSAPP: ONLINE');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            io.emit('console', '🔴 WHATSAPP: DISCONNECTED');
            if (shouldReconnect) {
                io.emit('console', '↻ RECONNECTING...');
                startSesi();
            }
            isWhatsAppConnected = false;
        }
    });
}

app.post('/pair', async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });

    io.emit('console', `Requesting pairing code for ${number}...`);
    try {
        const code = await shadow.requestPairingCode(number);
        io.emit('console', `Pairing Code: ${code}`);
        res.json({ code });
    } catch (error) {
        io.emit('console', `Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to generate code' });
    }
});

server.listen(5000, () => {
    console.log('Server running on port 5000');
    startSesi();
});
