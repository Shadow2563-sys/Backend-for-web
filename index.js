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

// Create session directory if not exists
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir);
}

app.use(express.json());
app.use(express.static('public'));

let shadow;
let isWhatsAppConnected = false;

// Simplified logger without chalk
const emitLog = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    io.emit('console', logMessage);
};

// WhatsApp connection handler
const startSesi = async (retryCount = 0) => {
    const MAX_RETRIES = 5;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const connectionOptions = {
            version,
            logger: pino({ level: "silent" }),
            auth: state,
            printQRInTerminal: false,
            browser: ['Mac OS', 'Safari', '10.15.7'],
            keepAliveIntervalMs: 30000,
            getMessage: async () => ({ conversation: 'P' })
        };

        shadow = makeWASocket(connectionOptions);
        shadow.ev.on('creds.update', saveCreds);

        shadow.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                isWhatsAppConnected = true;
                emitLog('🟢 WHATSAPP: ONLINE');
                io.emit('connection-status', true);
            }

            if (connection === 'close') {
                isWhatsAppConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                emitLog(`🔴 WHATSAPP: DISCONNECTED (Code: ${statusCode || 'unknown'})`);
                io.emit('connection-status', false);
                
                if (statusCode !== 401 && retryCount < MAX_RETRIES - 1) {
                    const delay = Math.min(10000, (retryCount + 1) * 2000);
                    emitLog(`↻ RECONNECTING in ${delay/1000} seconds...`);
                    setTimeout(() => startSesi(retryCount + 1), delay);
                }
            }
        });

    } catch (err) {
        emitLog(`❌ Initialization Error: ${err.message}`);
        if (retryCount < MAX_RETRIES - 1) {
            const delay = 5000;
            setTimeout(() => startSesi(retryCount + 1), delay);
        }
    }
};

// Pairing endpoint
app.post('/pair', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).json({ error: 'Number is required' });

        if (!shadow || !isWhatsAppConnected) {
            await startSesi();
            return res.status(503).json({ error: 'WhatsApp connection not ready' });
        }

        emitLog(`Requesting pairing code for ${number}...`);
        const cleanedNumber = number.replace(/\D/g, '');
        const code = await shadow.requestPairingCode(cleanedNumber);

        if (!code) throw new Error('No code received from WhatsApp');
        
        emitLog(`✅ Pairing Code for ${number}: ${code}`);
        return res.json({ code });
    } catch (err) {
        emitLog(`❌ Error: ${err.message}`);
        return res.status(500).json({ 
            error: 'Failed to generate pairing code',
            details: err.message 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsappConnected: isWhatsAppConnected
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    emitLog(`Server running on port ${PORT}`);
    startSesi();
});

io.on('connection', (socket) => {
    emitLog(`Client connected: ${socket.id}`);
    socket.emit('console', '[System] Ready...');
    socket.on('disconnect', () => {
        emitLog(`Client disconnected: ${socket.id}`);
    });
});
