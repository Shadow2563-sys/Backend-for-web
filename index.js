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

// Enhanced logger
const emitLog = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    
    const coloredMessage = 
        message.includes('🟢') ? chalk.green(logMessage) :
        message.includes('🔴') ? chalk.red(logMessage) :
        message.includes('↻') ? chalk.yellow(logMessage) :
        message.includes('❌') ? chalk.redBright(logMessage) :
        message.includes('✅') ? chalk.greenBright(logMessage) :
        chalk.cyan(logMessage);
    
    console.log(coloredMessage);
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
            browser: ['BlueX Bot', 'Chrome', '120.0.0'],
            keepAliveIntervalMs: 30000
        };

        shadow = makeWASocket(connectionOptions);
        shadow.ev.on('creds.update', saveCreds);

        shadow.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                isWhatsAppConnected = true;
                emitLog('🟢 WHATSAPP: CONNECTED');
                io.emit('connection-status', true);
            }

            if (connection === 'close') {
                isWhatsAppConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                
                emitLog(`🔴 WHATSAPP: DISCONNECTED (Code: ${statusCode || 'unknown'}, Reason: ${errorMessage})`);
                io.emit('connection-status', false);
                
                if (statusCode !== 401 && retryCount < MAX_RETRIES - 1) {
                    const delay = Math.min(10000, (retryCount + 1) * 2000);
                    emitLog(`↻ Attempting reconnect in ${delay/1000} seconds...`);
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
        
        if (!number || typeof number !== 'string') {
            return res.status(400).json({ 
                success: false,
                error: 'Valid number is required'
            });
        }

        const cleanedNumber = number.replace(/\D/g, '');
        if (!cleanedNumber.startsWith('234') || cleanedNumber.length !== 13) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Nigerian number format'
            });
        }

        if (!shadow || !isWhatsAppConnected) {
            await startSesi();
            return res.status(503).json({
                success: false,
                error: 'WhatsApp connection initializing'
            });
        }

        emitLog(`Requesting pairing code for ${cleanedNumber}...`);
        
        const code = await shadow.requestPairingCode(cleanedNumber);
        
        if (!code) {
            throw new Error('No pairing code received');
        }
        
        emitLog(`✅ Pairing Code for ${cleanedNumber}: ${code}`);
        return res.json({ 
            success: true,
            code,
            number: cleanedNumber
        });
        
    } catch (err) {
        emitLog(`❌ Pairing Error: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: 'Failed to generate pairing code'
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

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    emitLog(`🚀 Server running on port ${PORT}`);
    startSesi();
});

// Socket.IO
io.on('connection', (socket) => {
    socket.emit('console', '[System] Ready...');
});
