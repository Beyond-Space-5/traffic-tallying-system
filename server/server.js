const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Serve static files from root and subdirectories (Fixes "Cannot GET" errors)
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