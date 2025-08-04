const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const chalk = require('chalk');
const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Allow all origins (you can restrict later)
});

app.use(express.json());

let shadow;
let isWhatsAppConnected = false;

// Helper to emit logs to all connected clients
const emitLog = (message) => {
    console.log(message);
    io.emit('console', message);
};

// Start WhatsApp session
const startSesi = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const connectionOptions = {
        version,
        keepAliveIntervalMs: 30000,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: ['Mac OS', 'Safari', '10.15.7'],
        getMessage: async () => ({ conversation: 'P' }),
    };

    shadow = makeWASocket(connectionOptions);
    shadow.ev.on('creds.update', saveCreds);

    shadow.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            isWhatsAppConnected = true;
            emitLog('🟢 WHATSAPP: ONLINE');
        }

        if (connection === 'close') {
            isWhatsAppConnected = false;
            emitLog('🔴 WHATSAPP: DISCONNECTED');
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                emitLog('↻ RECONNECTING...');
                startSesi();
            }
        }
    });
};

// Generate pairing code
app.post('/pair', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).json({ error: 'Number is required' });

        if (!shadow) await startSesi();

        emitLog(`Requesting pairing code for ${number}...`);
        const code = await shadow.requestPairingCode(number);

        emitLog(`✅ Pairing Code for ${number}: ${code}`);
        return res.json({ code });
    } catch (err) {
        emitLog(`Error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to generate pairing code' });
    }
});

// Root route
app.get('/', (req, res) => res.send('Backend is running with Socket.IO'));

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startSesi(); // Initialize WhatsApp session on startup
});

// Handle socket connections
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('console', 'System Ready...');
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});
