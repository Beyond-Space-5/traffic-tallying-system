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

// Configure Nodemailer Transporter
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Verify SMTP Connection safely on startup without crashing or flooding logs
transporter.verify((error) => {
    if (error) {
        console.warn('⚠️ SMTP Warning: Email configuration error or invalid credentials. Password resets may fail until .env is updated:', error.message);
    } else {
        console.log('✅ SMTP Mailer is ready to send messages.');
    }
});

// Create Database Tables with Multi-Admin Isolation
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        reset_code TEXT,
        reset_expires TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS talliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        location TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        last_sync TEXT DEFAULT 'Never',
        FOREIGN KEY(admin_id) REFERENCES admins(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tally_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        tallier_id TEXT NOT NULL,
        junction TEXT NOT NULL,
        route TEXT NOT NULL,
        category TEXT NOT NULL,
        count INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY(admin_id) REFERENCES admins(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        UNIQUE(admin_id, key),
        FOREIGN KEY(admin_id) REFERENCES admins(id)
    )`);
});

// --- ADMIN AUTHENTICATION APIs ---

app.post('/api/admin/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO admins (username, email, password) VALUES (?, ?, ?)`,
            [username, email, hashedPassword],
            function (err) {
                if (err) {
                    return res.status(400).json({ success: false, error: 'Username or email already exists' });
                }
                const newAdminId = this.lastID;
                db.run(`INSERT INTO system_config (admin_id, key, value) VALUES (?, 'interval', '15')`, [newAdminId]);
                res.json({ success: true, message: 'Admin account created successfully' });
            }
        );
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error processing registration' });
    }
});

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    db.get(`SELECT * FROM admins WHERE username = ?`, [username], async (err, admin) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!admin) {
            return res.status(401).json({ success: false, error: 'Invalid username or password' });
        }

        try {
            const isMatch = await bcrypt.compare(password, admin.password);
            if (!isMatch) {
                return res.status(401).json({ success: false, error: 'Invalid username or password' });
            }
            res.json({ success: true, adminId: admin.id, username: admin.username, email: admin.email });
        } catch (compareErr) {
            res.status(500).json({ success: false, error: 'Authentication error' });
        }
    });
});

// --- ADMIN PASSWORD RECOVERY MULTI-STEP APIs ---

app.post('/api/admin/forgot-password', (req, res) => {
    const { identifier } = req.body;
    if (!identifier) {
        return res.status(400).json({ success: false, error: 'Username or email is required' });
    }

    db.get(`SELECT * FROM admins WHERE username = ? OR email = ?`, [identifier, identifier], (err, admin) => {
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
                res.json({ success: true, message: 'Reset code sent to registered email.', identifier: admin.username });
            } catch (mailErr) {
                console.warn('⚠️ Non-blocking email dispatch failure:', mailErr.message);
                res.status(500).json({ success: false, error: 'Failed to send recovery email. Check SMTP configuration in .env.' });
            }
        });
    });
});

app.post('/api/admin/verify-code', (req, res) => {
    const { identifier, code } = req.body;
    if (!identifier || !code) {
        return res.status(400).json({ success: false, error: 'Identifier and reset code are required' });
    }

    db.get(`SELECT * FROM admins WHERE (username = ? OR email = ?) AND reset_code = ?`, [identifier, identifier, code], (err, admin) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!admin) {
            return res.status(400).json({ success: false, error: 'Invalid reset code' });
        }

        if (new Date() > new Date(admin.reset_expires)) {
            return res.status(400).json({ success: false, error: 'Reset code has expired. Please request a new one.' });
        }

        res.json({ success: true, message: 'Code verified successfully.' });
    });
});

app.post('/api/admin/reset-password-confirmed', async (req, res) => {
    const { identifier, code, newPassword } = req.body;
    if (!identifier || !code || !newPassword) {
        return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    db.get(`SELECT * FROM admins WHERE (username = ? OR email = ?) AND reset_code = ?`, [identifier, identifier, code], async (err, admin) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!admin) {
            return res.status(400).json({ success: false, error: 'Invalid verification session or code' });
        }

        if (new Date() > new Date(admin.reset_expires)) {
            return res.status(400).json({ success: false, error: 'Reset code has expired.' });
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

// --- ISOLATED TALLIER MANAGEMENT APIs ---

app.post('/api/talliers', (req, res) => {
    const { admin_id, username, password, location } = req.body;
    if (!admin_id || !username || !password || !location) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    db.run(
        `INSERT INTO talliers (admin_id, username, password, location, active, last_sync) 
         VALUES (?, ?, ?, ?, 1, 'Never') 
         ON CONFLICT(username) DO UPDATE SET password = excluded.password, location = excluded.location, admin_id = excluded.admin_id`,
        [admin_id, username, password, location],
        function (err) {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, id: this.lastID || username });
        }
    );
});

app.get('/api/talliers', (req, res) => {
    const adminId = req.query.admin_id;
    if (!adminId) {
        return res.status(400).json({ success: false, error: 'Admin ID required' });
    }

    db.all(`SELECT * FROM talliers WHERE admin_id = ?`, [adminId], (err, talliers) => {
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
        res.json({ success: true, username: row.username, location: row.location, admin_id: row.admin_id });
    });
});

app.post('/api/talliers/:id/toggle', (req, res) => {
    const tallierId = req.params.id;
    const { admin_id } = req.body;

    db.get(`SELECT active, admin_id FROM talliers WHERE id = ?`, [tallierId], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, error: 'Tallier not found' });
        if (admin_id && Number(row.admin_id) !== Number(admin_id)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to tallier' });
        }

        const newStatus = row.active ? 0 : 1;
        db.run(`UPDATE talliers SET active = ? WHERE id = ?`, [newStatus, tallierId], (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, active: newStatus });
        });
    });
});

app.delete('/api/talliers/:id', (req, res) => {
    const tallierId = req.params.id;
    const adminId = req.query.admin_id;

    db.get(`SELECT admin_id FROM talliers WHERE id = ?`, [tallierId], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, error: 'Tallier not found' });
        if (adminId && Number(row.admin_id) !== Number(adminId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized deletion' });
        }

        db.run(`DELETE FROM talliers WHERE id = ?`, [tallierId], (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true });
        });
    });
});

// --- ISOLATED TALLY SUBMISSION & ANALYTICS APIs ---

app.post('/api/tallies/submit', (req, res) => {
    const { tallier_id, records } = req.body;
    if (!tallier_id || !records || !Array.isArray(records)) {
        return res.status(400).json({ success: false, error: 'Invalid payload' });
    }

    db.get(`SELECT admin_id FROM talliers WHERE username = ?`, [tallier_id], (err, tallierRow) => {
        if (err || !tallierRow) {
            return res.status(404).json({ success: false, error: 'Tallier not registered to any admin' });
        }
        const adminId = tallierRow.admin_id;

        const stmt = db.prepare(`INSERT INTO tally_records (admin_id, tallier_id, junction, route, category, count, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            records.forEach(r => {
                stmt.run(adminId, tallier_id, r.junction || r.location, r.route, r.category || r.vehicle, r.count, r.timestamp || new Date().toISOString());
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
});

app.get('/api/tallies/:tallier_id', (req, res) => {
    const tallierId = req.params.tallier_id;
    const adminId = req.query.admin_id;

    db.get(`SELECT admin_id FROM talliers WHERE username = ?`, [tallierId], (err, tallier) => {
        if (err || !tallier) return res.status(404).json({ success: false, error: 'Tallier not found' });
        if (adminId && Number(tallier.admin_id) !== Number(adminId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized access to analytics' });
        }

        db.all(`SELECT * FROM tally_records WHERE tallier_id = ? ORDER BY id DESC`, [tallierId], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, records: rows });
        });
    });
});

// --- EXCEL EXPORT ENGINE ---
app.get('/api/tallies/:tallier_id/export-excel', (req, res) => {
    const tallierId = req.params.tallier_id;
    const adminId = req.query.admin_id;

    db.get(`SELECT admin_id FROM talliers WHERE username = ?`, [tallierId], (err, tallier) => {
        if (err || !tallier) return res.status(404).send('Tallier not found');
        if (adminId && Number(tallier.admin_id) !== Number(adminId)) {
            return res.status(403).send('Unauthorized export');
        }

        db.get(`SELECT value FROM system_config WHERE admin_id = ? AND key = 'interval'`, [tallier.admin_id], (err, configRow) => {
            const configIntervalMinutes = configRow ? Number(configRow.value) : 15;

            db.all(`SELECT * FROM tally_records WHERE tallier_id = ? ORDER BY timestamp ASC`, [tallierId], async (err, rows) => {
                if (err) return res.status(500).send('Database error');

                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet('Traffic Analytics Summary', { views: [{ showGridLines: true }] });

                worksheet.mergeCells('A1:E1');
                const titleCell = worksheet.getCell('A1');
                titleCell.value = `TRAFFIC TALLY ANALYTICS REPORT - TALLIER: ${tallierId.toUpperCase()}`;
                titleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFF' } };
                titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1D6FA5' } };
                titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
                worksheet.getRow(1).height = 40;

                worksheet.addRow([]);

                const headerRow = worksheet.addRow(['Junction', 'Route', 'Vehicle Category', 'Time Interval', 'Aggregated Count']);
                headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
                headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2B3E50' } };
                headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

                let groupedByJunction = {};
                rows.forEach(r => {
                    const junction = r.junction || 'Unknown Junction';
                    if (!groupedByJunction[junction]) groupedByJunction[junction] = [];
                    groupedByJunction[junction].push(r);
                });

                let overallTotal = 0;
                let junctionIndex = 1;

                for (const [junction, jRecords] of Object.entries(groupedByJunction)) {
                    const jHeaderRow = worksheet.addRow([`${junctionIndex}. Junction: ${junction}`, '', '', '', '']);
                    worksheet.mergeCells(`A${jHeaderRow.number}:E${jHeaderRow.number}`);
                    jHeaderRow.font = { bold: true, color: { argb: '1D6FA5' } };
                    jHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EEF2F7' } };

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
                            overallTotal += agg.count;

                            worksheet.addRow([junction, agg.route, agg.category, intervalObj.label, agg.count]);
                        }

                        cumulativeRunningTotal += intervalTotalCount;
                        const summaryRow = worksheet.addRow([`[${configIntervalMinutes}-Min Interval Summary - Cumulative Total]:`, '', '', '', cumulativeRunningTotal]);
                        worksheet.mergeCells(`A${summaryRow.number}:D${summaryRow.number}`);
                        summaryRow.font = { bold: true, color: { argb: '1D6FA5' } };
                        summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8F9FA' } };
                    });
                    junctionIndex++;
                }

                const overallRow = worksheet.addRow(['Overall Total Count', '', '', '', overallTotal]);
                worksheet.mergeCells(`A${overallRow.number}:D${overallRow.number}`);
                overallRow.font = { bold: true, size: 12, color: { argb: 'FFFFFF' } };
                overallRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '28A745' } };

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${tallierId}_Analytics.xlsx"`);

                await workbook.xlsx.write(res);
                res.end();
            });
        });
    });
});

// --- ISOLATED SYSTEM CONFIGURATION APIs ---
app.get('/api/config', (req, res) => {
    const adminId = req.query.admin_id;
    if (!adminId) return res.status(400).json({ success: false, error: 'Admin ID required' });

    db.get(`SELECT value FROM system_config WHERE admin_id = ? AND key = 'interval'`, [adminId], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, interval: row ? Number(row.value) : 15 });
    });
});

app.post('/api/config', (req, res) => {
    const { admin_id, interval } = req.body;
    if (!admin_id) return res.status(400).json({ success: false, error: 'Admin ID required' });

    db.run(`INSERT OR REPLACE INTO system_config (admin_id, key, value) VALUES (?, 'interval', ?)`, [admin_id, String(interval)], (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, interval });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});