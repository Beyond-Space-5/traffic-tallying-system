require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Configure Nodemailer transporter using your .env SMTP variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Store reset codes temporarily in memory (Map: email -> { code, expiresAt })
const passwordResetStore = new Map();

// Initialize SQLite Database
const dbPath = path.resolve(__dirname, 'traffic_tally.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT,
            password TEXT
        )`, () => {
            db.run(`ALTER TABLE admins ADD COLUMN email TEXT`, (err) => {});
        });

        db.run(`CREATE TABLE IF NOT EXISTS talliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER,
            username TEXT,
            password TEXT,
            location TEXT,
            active INTEGER DEFAULT 1,
            last_sync TEXT DEFAULT 'Never',
            FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS config (
            admin_id INTEGER PRIMARY KEY,
            interval INTEGER DEFAULT 15,
            FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS tally_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER,
            tallier_id TEXT,
            junction TEXT,
            route TEXT,
            category TEXT,
            count INTEGER,
            timestamp TEXT,
            FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`);
    });
}

// ================= ADMIN AUTHENTICATION & PASSWORD RESET =================

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    db.get(
        `SELECT * FROM admins WHERE username = ? AND password = ?`,
        [username, password],
        (err, row) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!row) return res.status(401).json({ success: false, error: 'Invalid admin credentials.' });
            
            res.json({ success: true, adminId: row.id, username: row.username });
        }
    );
});

app.post('/api/admin/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    db.run(
        `INSERT INTO admins (username, email, password) VALUES (?, ?, ?)`,
        [username, email || '', password],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: 'Username already exists or database error.' });
            res.json({ success: true, adminId: this.lastID });
        }
    );
});

app.post('/api/admin/forgot-password', (req, res) => {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    if (!identifier) {
        return res.status(400).json({ success: false, error: 'Username or email is required' });
    }

    db.get(
        `SELECT * FROM admins WHERE username = ? OR email = ?`,
        [identifier, identifier],
        async (err, row) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!row || !row.email) {
                return res.json({ success: true, message: 'If the account exists, a reset code has been sent.' });
            }

            const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
            passwordResetStore.set(row.email.toLowerCase(), {
                code: resetCode,
                expiresAt: Date.now() + 10 * 60 * 1000
            });

            const mailOptions = {
                from: process.env.EMAIL_FROM || process.env.SMTP_USER,
                to: row.email,
                subject: 'Traffic Tallying System - Password Reset Code',
                text: `Hello ${row.username},\n\nYour 6-digit password reset code is: ${resetCode}\n\nThis code will expire in 10 minutes.`
            };

            try {
                await transporter.sendMail(mailOptions);
                res.json({ success: true, message: 'Reset code sent successfully.' });
            } catch (mailErr) {
                res.status(500).json({ success: false, error: 'Failed to send email.' });
            }
        }
    );
});

app.post('/api/admin/verify-code', (req, res) => {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    const code = req.body.code;

    db.get(
        `SELECT email FROM admins WHERE username = ? OR email = ?`,
        [identifier, identifier],
        (err, row) => {
            if (err || !row) return res.status(400).json({ success: false, error: 'Invalid account or code.' });

            const record = passwordResetStore.get(row.email.toLowerCase());
            if (!record || Date.now() > record.expiresAt || record.code !== code.toString().trim()) {
                return res.status(400).json({ success: false, error: 'Invalid or expired verification code.' });
            }

            res.json({ success: true, message: 'Code verified successfully.' });
        }
    );
});

app.post('/api/admin/reset-password-confirmed', (req, res) => {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    const code = req.body.code;
    const newPassword = req.body.newPassword || req.body.password;

    db.get(
        `SELECT email FROM admins WHERE username = ? OR email = ?`,
        [identifier, identifier],
        (err, row) => {
            if (err || !row) return res.status(400).json({ success: false, error: 'Account not found.' });

            const record = passwordResetStore.get(row.email.toLowerCase());
            if (!record || record.code !== code.toString().trim() || Date.now() > record.expiresAt) {
                return res.status(400).json({ success: false, error: 'Invalid or expired reset session.' });
            }

            db.run(
                `UPDATE admins SET password = ? WHERE email = ?`,
                [newPassword, row.email],
                function(err) {
                    if (err) return res.status(500).json({ success: false, error: err.message });
                    passwordResetStore.delete(row.email.toLowerCase());
                    res.json({ success: true, message: 'Password updated successfully!' });
                }
            );
        }
    );
});

// ================= CONFIGURATION & TALLIERS =================

app.get('/api/config', (req, res) => {
    const adminId = req.query.admin_id;
    const tallierId = req.query.tallier_id;

    if (adminId) {
        db.get(`SELECT interval FROM config WHERE admin_id = ?`, [adminId], (err, row) => {
            res.json({ success: true, interval: row ? row.interval : 15 });
        });
    } else if (tallierId) {
        db.get(
            `SELECT config.interval FROM config JOIN talliers ON config.admin_id = talliers.admin_id WHERE talliers.username = ?`,
            [tallierId],
            (err, row) => {
                res.json({ success: true, interval: row ? row.interval : 15 });
            }
        );
    } else {
        db.get(`SELECT interval FROM config LIMIT 1`, [], (err, row) => {
            res.json({ success: true, interval: row ? row.interval : 15 });
        });
    }
});

app.post('/api/config', (req, res) => {
    const { admin_id, interval } = req.body;
    db.run(
        `INSERT INTO config (admin_id, interval) VALUES (?, ?) ON CONFLICT(admin_id) DO UPDATE SET interval = ?`,
        [admin_id, interval, interval],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, interval });
        }
    );
});

app.get('/api/talliers', (req, res) => {
    const adminId = req.query.admin_id;
    db.all(`SELECT * FROM talliers WHERE admin_id = ?`, [adminId], (err, rows) => {
        res.json({ success: true, talliers: rows });
    });
});

app.post('/api/talliers', (req, res) => {
    const { admin_id, username, password, location } = req.body;
    db.run(
        `INSERT INTO talliers (admin_id, username, password, location, active) VALUES (?, ?, ?, ?, 1)`,
        [admin_id, username, password, location],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.post('/api/talliers/:id/toggle', (req, res) => {
    db.get(`SELECT active FROM talliers WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, error: 'Tallier not found' });
        const newStatus = row.active ? 0 : 1;
        db.run(`UPDATE talliers SET active = ? WHERE id = ?`, [newStatus, req.params.id], () => {
            res.json({ success: true, active: newStatus });
        });
    });
});

app.delete('/api/talliers/:id', (req, res) => {
    db.run(`DELETE FROM talliers WHERE id = ?`, [req.params.id], function(err) {
        res.json({ success: true, deleted: this.changes });
    });
});

app.post('/api/tallier/login', (req, res) => {
    const { username, password } = req.body;
    db.get(
        `SELECT * FROM talliers WHERE username = ? AND password = ? AND active = 1`,
        [username, password],
        (err, row) => {
            if (err || !row) return res.status(401).json({ success: false, error: 'Invalid credentials or account inactive.' });
            res.json({ success: true, username: row.username, location: row.location });
        }
    );
});

// ================= TALLIES & EXCEL EXPORT ENDPOINT =================

app.get('/api/tallies/:tallier_id', (req, res) => {
    const tallierId = req.params.tallier_id;
    const adminId = req.query.admin_id;

    if (!adminId) {
        db.all(`SELECT * FROM tally_records WHERE tallier_id = ?`, [tallierId], (err, rows) => {
            return res.json({ success: true, records: rows });
        });
        return;
    }

    db.all(
        `SELECT * FROM tally_records WHERE tallier_id = ? AND admin_id = ?`,
        [tallierId, adminId],
        (err, rows) => {
            res.json({ success: true, records: rows });
        }
    );
});

app.post('/api/tallies/submit', (req, res) => {
    const { tallier_id, records } = req.body;
    db.get(`SELECT admin_id FROM talliers WHERE username = ?`, [tallier_id], (err, tallierRow) => {
        if (err || !tallierRow) return res.status(404).json({ success: false, error: 'Tallier not found' });

        const adminId = tallierRow.admin_id;
        const stmt = db.prepare(`INSERT INTO tally_records (admin_id, tallier_id, junction, route, category, count, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`);

        db.serialize(() => {
            records.forEach(r => {
                stmt.run(adminId, tallier_id, r.junction, r.route, r.category, r.count, r.timestamp || new Date().toISOString());
            });
            stmt.finalize(() => {
                db.run(`UPDATE talliers SET last_sync = ? WHERE username = ?`, [new Date().toLocaleString(), tallier_id]);
                res.json({ success: true, message: 'Records successfully synced.' });
            });
        });
    });
});

app.delete('/api/tallies/:tallier_id', (req, res) => {
    const tallierId = req.params.tallier_id;
    const adminId = req.query.admin_id;

    const query = adminId ? `DELETE FROM tally_records WHERE tallier_id = ? AND admin_id = ?` : `DELETE FROM tally_records WHERE tallier_id = ?`;
    const params = adminId ? [tallierId, adminId] : [tallierId];

    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, deletedCount: this.changes });
    });
});

// Professional Styled Excel Report Generator Endpoint (Warning-Free Direct Open)
app.get('/api/tallies/:tallier_id/export-excel', (req, res) => {
    const tallierId = req.params.tallier_id;
    const adminId = req.query.admin_id;

    const query = adminId 
        ? `SELECT * FROM tally_records WHERE tallier_id = ? AND admin_id = ? ORDER BY timestamp ASC`
        : `SELECT * FROM tally_records WHERE tallier_id = ? ORDER BY timestamp ASC`;
    const params = adminId ? [tallierId, adminId] : [tallierId];

    db.all(query, params, (err, records) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const configQuery = adminId ? `SELECT interval FROM config WHERE admin_id = ?` : `SELECT interval FROM config LIMIT 1`;
        const configParams = adminId ? [adminId] : [];

        db.get(configQuery, configParams, (configErr, configRow) => {
            const configIntervalMinutes = configRow && configRow.interval ? Number(configRow.interval) : 15;

            let groupedByJunction = {};
            (records || []).forEach(rec => {
                const junction = rec.junction || 'Unknown Junction';
                if (!groupedByJunction[junction]) groupedByJunction[junction] = [];
                groupedByJunction[junction].push(rec);
            });

            let tableRowsHTML = '';
            let overallTotal = 0;
            let junctionIndex = 1;

            const categoryColors = {
                'Car': '#1d6fa5',
                'Truck': '#d9534f',
                'Bus': '#d97706',
                'Motorcycle': '#16a34a',
                'Bicycle': '#7c3aed',
                'Pedestrian': '#db2777'
            };

            for (const [junction, jRecords] of Object.entries(groupedByJunction)) {
                tableRowsHTML += `
                    <tr style="background-color: #eef2f7; color: #1d6fa5; font-weight: bold; font-size: 11pt;">
                        <td colspan="5" style="border: 1px solid #cbd5e1; padding: 10px 12px; mso-number-format:'\\@';"><strong>${junctionIndex}. Junction: ${junction}</strong></td>
                    </tr>
                `;

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

                        const catColor = categoryColors[agg.category] || '#334155';

                        tableRowsHTML += `
                            <tr>
                                <td style="text-align: center; width: 40px; color: #94a3b8; border: 1px solid #e2e8f0; padding: 8px 12px; mso-number-format:'\\@';">↳</td>
                                <td style="border: 1px solid #e2e8f0; padding: 8px 12px; color: #0f172a; mso-number-format:'\\@';"><strong>${agg.route}</strong></td>
                                <td style="border: 1px solid #e2e8f0; padding: 8px 12px; font-weight: bold; color: ${catColor}; mso-number-format:'\\@';">${agg.category}</td>
                                <td style="border: 1px solid #e2e8f0; padding: 8px 12px; color: #475569; mso-number-format:'\\@';">${intervalObj.label}</td>
                                <td style="text-align: right; color: ${catColor}; font-weight: bold; border: 1px solid #e2e8f0; padding: 8px 12px; mso-number-format:'0';">${agg.count}</td>
                            </tr>
                        `;
                    }

                    cumulativeRunningTotal += intervalTotalCount;

                    tableRowsHTML += `
                        <tr style="background-color: #f1f5f9; font-weight: bold; border-top: 1.5px dashed #1d6fa5;">
                            <td colspan="4" style="text-align: right; color: #1d6fa5; border: 1px solid #e2e8f0; padding: 8px 12px; mso-number-format:'\\@';">[${configIntervalMinutes}-Min Interval Summary - Cumulative Total]:</td>
                            <td style="text-align: right; color: #1d6fa5; border: 1px solid #e2e8f0; padding: 8px 12px; mso-number-format:'0';">${cumulativeRunningTotal}</td>
                        </tr>
                    `;
                });
                junctionIndex++;
            }

            tableRowsHTML += `
                <tr style="background-color: #dcfce7; font-weight: bold; font-size: 11pt; color: #166534;">
                    <td colspan="4" style="text-align: right; border: 1px solid #bbf7d0; padding: 12px; mso-number-format:'\\@';">Overall Total Count:</td>
                    <td style="text-align: right; border: 1px solid #bbf7d0; padding: 12px; mso-number-format:'0';">${overallTotal}</td>
                </tr>
            `;

            const excelHTML = `
                <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
                <head>
                    <meta charset="UTF-8">
                    <!--[if gte mso 9]>
                    <xml>
                        <x:ExcelWorkbook>
                            <x:ExcelWorksheets>
                                <x:ExcelWorksheet>
                                    <x:Name>Traffic Analytics</x:Name>
                                    <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
                                </x:ExcelWorksheet>
                            </x:ExcelWorksheets>
                        </x:ExcelWorkbook>
                    </xml>
                    <![endif]-->
                    <style>
                        body { font-family: Arial, sans-serif; color: #334155; }
                        table { border-collapse: collapse; width: 100%; }
                        th { background-color: #2b3e50; color: #ffffff; padding: 12px; border: 1px solid #1e293b; text-align: left; font-weight: bold; }
                        td { padding: 10px 12px; border: 1px solid #e2e8f0; }
                    </style>
                </head>
                <body>
                    <h2 style="color: #2b3e50; margin-bottom: 5px;">Traffic Tally Analytics Report</h2>
                    <p style="color: #64748b; margin-top: 0; font-size: 10pt;">
                        <strong>Tallier:</strong> ${tallierId} &nbsp;|&nbsp; 
                        <strong>Generated on:</strong> ${new Date().toLocaleString()} &nbsp;|&nbsp; 
                        <strong>Interval:</strong> ${configIntervalMinutes} mins
                    </p>
                    <br/>
                    <table>
                        <thead>
                            <tr>
                                <th style="width: 40px; text-align: center; mso-number-format:'\\@';">&nbsp;</th>
                                <th style="mso-number-format:'\\@';">Route</th>
                                <th style="mso-number-format:'\\@';">Vehicle Category</th>
                                <th style="mso-number-format:'\\@';">Time Interval</th>
                                <th style="text-align: right; mso-number-format:'\\@';">Aggregated Count</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${tableRowsHTML}
                        </tbody>
                    </table>
                </body>
                </html>
            `;

            // Using application/octet-stream bypasses Excel extension mismatch warnings while preserving formatting
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename=${tallierId}_Analytics_${new Date().toISOString().split('T')[0]}.xls`);
            res.status(200).send('\ufeff' + excelHTML);
        });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});