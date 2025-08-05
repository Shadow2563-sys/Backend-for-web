const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Ensure session directory exists
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

app.use(express.json());

let shadow;
let isWhatsAppConnected = false;

const emitLog = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    io.emit('console', logMessage);
};

const startSesi = async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        shadow = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            auth: state,
            printQRInTerminal: false,
            browser: ['Mac OS', 'Safari', '10.15.7'],
            keepAliveIntervalMs: 30000
        });

        shadow.ev.on('creds.update', saveCreds);

        shadow.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                isWhatsAppConnected = true;
                emitLog('🟢 WHATSAPP: CONNECTED');
            }

            if (connection === 'close') {
                isWhatsAppConnected = false;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                emitLog(`🔴 WHATSAPP: DISCONNECTED${shouldReconnect ? ' - Reconnecting...' : ''}`);
                if (shouldReconnect) setTimeout(startSesi, 5000);
            }
        });

    } catch (err) {
        emitLog(`❌ Error: ${err.message}`);
        setTimeout(startSesi, 10000);
    }
};

// Pairing endpoint
app.post('/pair', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).json({ error: 'Number is required' });

        if (!shadow || !isWhatsAppConnected) {
            return res.status(503).json({ error: 'WhatsApp not connected' });
        }

        const cleanedNumber = number.replace(/\D/g, '');
        emitLog(`Requesting pairing code for ${cleanedNumber}...`);
        
        const code = await shadow.requestPairingCode(cleanedNumber);
        if (!code) throw new Error('No code received');

        emitLog(`✅ Pairing Code: ${code}`);
        return res.json({ success: true, code });

    } catch (err) {
        emitLog(`❌ Pairing Error: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsappConnected: isWhatsAppConnected });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    emitLog(`Server running on port ${PORT}`);
    startSesi();
});

io.on('connection', (socket) => {
    emitLog(`Client connected: ${socket.id}`);
    socket.emit('console', 'System Ready...');
});
