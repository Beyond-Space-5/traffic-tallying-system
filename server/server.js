const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use('/admin-web', express.static(path.join(__dirname, 'admin-web')));
app.use('/tallier-web', express.static(path.join(__dirname, 'tallier-web')));

// Initialize SQLite Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// Configure Nodemailer Transporter using environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Create Database Tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS talliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        location TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        last_sync TEXT DEFAULT 'Never'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tally_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tallier_id TEXT NOT NULL,
        junction TEXT NOT NULL,
        route TEXT NOT NULL,
        category TEXT NOT NULL,
        count INTEGER NOT NULL,
        timestamp TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        reset_code TEXT,
        reset_expires TEXT
    )`);

    db.run(`INSERT OR IGNORE INTO system_config (key, value) VALUES ('interval', '15')`);
});

// --- AUTHENTICATION & TALLIER MANAGEMENT APIs ---

app.post('/api/talliers', (req, res) => {
    const { username, password, location } = req.body;
    if (!username || !password || !location) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    db.run(
        `INSERT INTO talliers (username, password, location, active, last_sync) 
         VALUES (?, ?, ?, 1, 'Never') 
         ON CONFLICT(username) DO UPDATE SET password = excluded.password, location = excluded.location`,
        [username, password, location],
        function (err) {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, id: this.lastID || username });
        }
    );
});

app.get('/api/talliers', (req, res) => {
    db.all(`SELECT * FROM talliers`, [], (err, talliers) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, talliers });
    });
});

app.post('/api/tallier/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM talliers WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        if (!row) {
            return res.status(401).json({ success: false, error: 'Invalid username or password' });
        }
        if (row.active === 0) {
            return res.status(403).json({ success: false, error: 'Account is deactivated by admin' });
        }
        res.json({ success: true, username: row.username, location: row.location });
    });
});

app.post('/api/talliers/:id/toggle', (req, res) => {
    const tallierId = req.params.id;
    db.get(`SELECT active FROM talliers WHERE id = ?`, [tallierId], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, error: 'Tallier not found' });
        const newStatus = row.active ? 0 : 1;
        db.run(`UPDATE talliers SET active = ? WHERE id = ?`, [newStatus, tallierId], (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, active: newStatus });
        });
    });
});

app.delete('/api/talliers/:id', (req, res) => {
    const tallierId = req.params.id;
    db.run(`DELETE FROM talliers WHERE id = ?`, [tallierId], (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// --- ADMIN FORGOT & RESET PASSWORD APIs ---

app.post('/api/admin/forgot-password', (req, res) => {
    const { identifier } = req.body;
    if (!identifier) {
        return res.status(400).json({ success: false, error: 'Username or email is required' });
    }

    db.get(`SELECT * FROM admins WHERE username = ? OR email = ?`, [identifier, identifier], async (err, admin) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!admin) {
            return res.json({ success: true, message: 'If the account exists, a reset code has been sent.' });
        }

        const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        db.run(`UPDATE admins SET reset_code = ?, reset_expires = ? WHERE id = ?`, [resetCode, expiresAt, admin.id], async (updateErr) => {
            if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });

            try {
                await transporter.sendMail({
                    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
                    to: admin.email,
                    subject: 'Traffic Tallying System - Password Reset Code',
                    html: `
                        <h3>Password Reset Request</h3>
                        <p>Hello <b>${admin.username}</b>,</p>
                        <p>Your 6-digit password reset code is:</p>
                        <h2 style="color: #1d6fa5; letter-spacing: 3px;">${resetCode}</h2>
                        <p>This code expires in 15 minutes.</p>
                    `
                });
                res.json({ success: true, message: 'Reset code sent to registered email.' });
            } catch (mailErr) {
                console.error('Mail send error:', mailErr);
                res.status(500).json({ success: false, error: 'Failed to send recovery email.' });
            }
        });
    });
});

app.post('/api/admin/reset-password', async (req, res) => {
    const { identifier, code, newPassword } = req.body;
    if (!identifier || !code || !newPassword) {
        return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    db.get(`SELECT * FROM admins WHERE (username = ? OR email = ?) AND reset_code = ?`, [identifier, identifier, code], async (err, admin) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!admin) {
            return res.status(400).json({ success: false, error: 'Invalid reset code or identifier' });
        }

        if (new Date() > new Date(admin.reset_expires)) {
            return res.status(400).json({ success: false, error: 'Reset code has expired. Please request a new one.' });
        }

        try {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            db.run(`UPDATE admins SET password = ?, reset_code = NULL, reset_expires = NULL WHERE id = ?`, [hashedPassword, admin.id], (updateErr) => {
                if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });
                res.json({ success: true, message: 'Password successfully updated.' });
            });
        } catch (hashErr) {
            res.status(500).json({ success: false, error: 'Error hashing password' });
        }
    });
});

// --- TALLY SUBMISSION & ANALYTICS APIs ---

app.post('/api/tallies/submit', (req, res) => {
    const { tallier_id, records } = req.body;
    if (!tallier_id || !records || !Array.isArray(records)) {
        return res.status(400).json({ success: false, error: 'Invalid payload' });
    }

    const stmt = db.prepare(`INSERT INTO tally_records (tallier_id, junction, route, category, count, timestamp) VALUES (?, ?, ?, ?, ?, ?)`);
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        records.forEach(r => {
            stmt.run(tallier_id, r.junction || r.location, r.route, r.category || r.vehicle, r.count, r.timestamp || new Date().toISOString());
        });
        stmt.finalize();

        const nowFormatted = new Date().toLocaleTimeString();
        db.run(`UPDATE talliers SET last_sync = ? WHERE username = ?`, [nowFormatted, tallier_id]);

        db.run('COMMIT', (err) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, message: 'Records successfully stored.' });
        });
    });
});

app.get('/api/tallies/:tallier_id', (req, res) => {
    const tallierId = req.params.tallier_id;
    db.all(`SELECT * FROM tally_records WHERE tallier_id = ? ORDER BY id DESC`, [tallierId], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, records: rows });
    });
});

// --- PROFESSIONAL EXCEL EXPORT FOR INDIVIDUAL TALLIER ---
app.get('/api/tallies/:tallier_id/export-excel', (req, res) => {
    const tallierId = req.params.tallier_id;

    db.all(`SELECT * FROM tally_records WHERE tallier_id = ? ORDER BY timestamp ASC`, [tallierId], async (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Traffic Analytics');

        // Header and Title Formatting
        worksheet.mergeCells('A1:E1');
        const titleRow = worksheet.getCell('A1');
        titleRow.value = `Traffic Tally Report - Tallier: ${tallierId}`;
        titleRow.font = { size: 16, bold: true, color: { argb: 'FFFFFF' } };
        titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1D6FA5' } };
        titleRow.alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getRow(1).height = 40;

        // Table Column Headers
        worksheet.addRow([]);
        const headerRow = worksheet.addRow(['Junction', 'Route', 'Vehicle Category', 'Time', 'Total Count']);
        headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2B3E50' } };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

        let overallTotal = 0;
        rows.forEach(r => {
            const count = Number(r.count || 0);
            overallTotal += count;
            const row = worksheet.addRow([
                r.junction || 'N/A',
                r.route || 'N/A',
                r.category || 'N/A',
                r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : 'N/A',
                count
            ]);
            row.getCell(5).alignment = { horizontal: 'right' };
        });

        // Summary Total Row
        const summaryRow = worksheet.addRow(['Overall Total Count', '', '', '', overallTotal]);
        summaryRow.font = { bold: true };
        summaryRow.getCell(5).alignment = { horizontal: 'right' };

        // Column widths
        worksheet.columns = [
            { width: 25 },
            { width: 25 },
            { width: 20 },
            { width: 15 },
            { width: 15 }
        ];

        const todayStr = new Date().toISOString().split('T')[0];
        const filename = `${tallierId}_Analytics_${todayStr}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();
    });
});

// --- SYSTEM CONFIGURATION APIs ---
app.get('/api/config', (req, res) => {
    db.get(`SELECT value FROM system_config WHERE key = 'interval'`, [], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, interval: row ? Number(row.value) : 15 });
    });
});

app.post('/api/config', (req, res) => {
    const { interval } = req.body;
    db.run(`INSERT OR REPLACE INTO system_config (key, value) VALUES ('interval', ?)`, [String(interval)], (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, interval });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});