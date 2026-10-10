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

// --- BEAUTIFUL & ORGANIZED INTERVAL-AGGREGATED EXCEL EXPORT ENGINE ---
app.get('/api/tallies/:tallier_id/export-excel', (req, res) => {
    const tallierId = req.params.tallier_id;

    db.get(`SELECT value FROM system_config WHERE key = 'interval'`, [], (err, configRow) => {
        const configIntervalMinutes = configRow ? Number(configRow.value) : 15;

        db.all(`SELECT * FROM tally_records WHERE tallier_id = ? ORDER BY timestamp ASC`, [tallierId], async (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Traffic Tallying System';
            const worksheet = workbook.addWorksheet('Traffic Analytics Summary', {
                views: [{ showGridLines: true }]
            });

            // 1. Title Banner
            worksheet.mergeCells('A1:E1');
            const titleCell = worksheet.getCell('A1');
            titleCell.value = `TRAFFIC TALLY ANALYTICS REPORT - TALLIER: ${tallierId.toUpperCase()}`;
            titleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFF' } };
            titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1D6FA5' } };
            titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
            worksheet.getRow(1).height = 40;

            worksheet.addRow([]); // Blank spacing row

            // 2. Table Column Headers
            const headerRow = worksheet.addRow(['Junction', 'Route', 'Vehicle Category', 'Time Interval', 'Aggregated Count']);
            headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2B3E50' } };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
            worksheet.getRow(headerRow.number).height = 25;

            // Group records by junction
            let groupedByJunction = {};
            rows.forEach(r => {
                const junction = r.junction || 'Unknown Junction';
                if (!groupedByJunction[junction]) groupedByJunction[junction] = [];
                groupedByJunction[junction].push(r);
            });

            let overallTotal = 0;
            let junctionIndex = 1;

            for (const [junction, jRecords] of Object.entries(groupedByJunction)) {
                // Junction Section Header Row
                const jHeaderRow = worksheet.addRow([`${junctionIndex}. Junction: ${junction}`, '', '', '', '']);
                worksheet.mergeCells(`A${jHeaderRow.number}:E${jHeaderRow.number}`);
                jHeaderRow.font = { bold: true, size: 11, color: { argb: '1D6FA5' } };
                jHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EEF2F7' } };
                jHeaderRow.alignment = { vertical: 'middle', horizontal: 'left' };
                worksheet.getRow(jHeaderRow.number).height = 22;

                let junctionTotal = 0;
                let intervalMs = configIntervalMinutes * 60 * 1000;
                let sessionStartTime = jRecords.length > 0 ? new Date(jRecords[0].timestamp).getTime() : Date.now();
                
                let intervalsMap = {};
                jRecords.forEach(rec => {
                    const recTime = rec.timestamp ? new Date(rec.timestamp).getTime() : Date.now();
                    const intervalIdx = Math.floor((recTime - sessionStartTime) / intervalMs);
                    
                    if (!intervalsMap[intervalIdx]) {
                        const intStart = new Date(sessionStartTime + (intervalIdx * intervalMs));
                        const intEnd = new Date(sessionStartTime + ((intervalIdx + 1) * intervalMs));
                        intervalsMap[intervalIdx] = {
                            label: `${intStart.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${intEnd.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`,
                            aggregates: {}
                        };
                    }

                    const route = rec.route || 'N/A';
                    const category = rec.category || 'N/A';
                    const mapKey = `${route}__${category}`;
                    const count = Number(rec.count || 0);

                    if (!intervalsMap[intervalIdx].aggregates[mapKey]) {
                        intervalsMap[intervalIdx].aggregates[mapKey] = { route, category, count: 0 };
                    }
                    intervalsMap[intervalIdx].aggregates[mapKey].count += count;
                });

                let cumulativeRunningTotal = 0;
                let intervalKeys = Object.keys(intervalsMap).sort((a, b) => Number(a) - Number(b));

                intervalKeys.forEach((intKey) => {
                    const intervalObj = intervalsMap[intKey];
                    let intervalTotalCount = 0;

                    for (const [mapKey, agg] of Object.entries(intervalObj.aggregates)) {
                        intervalTotalCount += agg.count;
                        junctionTotal += agg.count;
                        overallTotal += agg.count;

                        const dataRow = worksheet.addRow([
                            junction,
                            agg.route,
                            agg.category,
                            intervalObj.label,
                            agg.count
                        ]);
                        dataRow.getCell(1).alignment = { horizontal: 'left' };
                        dataRow.getCell(2).alignment = { horizontal: 'left' };
                        dataRow.getCell(3).alignment = { horizontal: 'left' };
                        dataRow.getCell(4).alignment = { horizontal: 'center' };
                        dataRow.getCell(5).alignment = { horizontal: 'right' };
                        dataRow.getCell(5).font = { bold: true, color: { argb: '1D6FA5' } };
                    }

                    cumulativeRunningTotal += intervalTotalCount;

                    // Interval Summary Row with Cumulative Total
                    const summaryRow = worksheet.addRow([
                        `[${configIntervalMinutes}-Min Interval Summary - Cumulative Total]:`, '', '', '', cumulativeRunningTotal
                    ]);
                    worksheet.mergeCells(`A${summaryRow.number}:D${summaryRow.number}`);
                    summaryRow.font = { bold: true, color: { argb: '1D6FA5' } };
                    summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8F9FA' } };
                    summaryRow.getCell(1).alignment = { horizontal: 'right' };
                    summaryRow.getCell(5).alignment = { horizontal: 'right' };
                    summaryRow.getCell(5).font = { bold: true, color: { argb: '1D6FA5' } };

                    // Blank separator row between intervals
                    worksheet.addRow([]);
                });

                // Junction Subtotal Row
                const subRow = worksheet.addRow(['Junction Total Count', '', '', '', junctionTotal]);
                worksheet.mergeCells(`A${subRow.number}:D${subRow.number}`);
                subRow.font = { bold: true, color: { argb: '333333' } };
                subRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E9ECEF' } };
                subRow.getCell(1).alignment = { horizontal: 'right' };
                subRow.getCell(5).alignment = { horizontal: 'right' };

                worksheet.addRow([]); // Blank row between junctions
                junctionIndex++;
            }

            // Overall Total Grand Summary Row
            const overallRow = worksheet.addRow(['Overall Total Count', '', '', '', overallTotal]);
            worksheet.mergeCells(`A${overallRow.number}:D${overallRow.number}`);
            overallRow.font = { bold: true, size: 12, color: { argb: 'FFFFFF' } };
            overallRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '28A745' } };
            overallRow.getCell(1).alignment = { horizontal: 'right' };
            overallRow.getCell(5).alignment = { horizontal: 'right' };
            overallRow.getCell(5).font = { bold: true, size: 12, color: { argb: 'FFFFFF' } };
            worksheet.getRow(overallRow.number).height = 25;

            // Auto-fit column widths gracefully
            worksheet.columns = [
                { width: 28 }, // Junction
                { width: 28 }, // Route
                { width: 22 }, // Category
                { width: 22 }, // Time Interval
                { width: 18 }  // Aggregated Count
            ];

            const todayStr = new Date().toISOString().split('T')[0];
            const filename = `${tallierId}_Analytics_${todayStr}.xlsx`;

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            await workbook.xlsx.write(res);
            res.end();
        });
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