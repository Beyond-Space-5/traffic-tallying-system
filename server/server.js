const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../')));

// Initialize SQLite Database
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database 11:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDatabase();
    }
});

// Create necessary tables if they do not exist
function initDatabase() {
    db.serialize(() => {
        // Configuration table for system settings (like analytics interval)
        db.run(`CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        )`, (err) => {
            if (!err) {
                // Set default interval to 15 minutes if not already set
                db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('interval', '15')`);
            }
        });

        // Tally records table
        db.run(`CREATE TABLE IF NOT EXISTS tally_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tallier_id TEXT,
            location TEXT,
            route TEXT,
            category TEXT,
            count INTEGER,
            timestamp TEXT
        )`);

        // Interval snapshots / summaries table for tracking X-minute boundaries
        db.run(`CREATE TABLE IF NOT EXISTS interval_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location TEXT,
            interval_start TEXT,
            interval_end TEXT,
            cumulative_total INTEGER,
            summary_data TEXT,
            timestamp TEXT
        )`);
    });
}

// ==========================
// CONFIGURATION ENDPOINTS
// ==========================

// Get configuration (e.g., analytics interval)
app.get('/api/config', (req, res) => {
    db.all(`SELECT key, value FROM config`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        let config = {};
        rows.forEach(row => {
            config[row.key] = isNaN(row.value) ? row.value : Number(row.value);
        });
        res.json({ success: true, ...config });
    });
});

// Update configuration (e.g., interval in minutes)
app.post('/api/config', (req, res) => {
    const { interval } = req.body;
    if (interval === undefined || interval <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid interval value.' });
    }

    db.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('interval', ?)`, [interval], function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, interval: Number(interval) });
    });
});

// ==========================
// TALLY SYNC ENDPOINTS
// ==========================

// Sync tally counts from field devices
app.post('/api/tally/sync', (req, res) => {
    const { tallier_id, location, timestamp, counts } = req.body;

    if (!counts || typeof counts !== 'object') {
        return res.status(400).json({ success: false, error: 'Invalid counts payload.' });
    }

    const recordTimestamp = timestamp || new Date().toISOString();
    const locationName = location || 'Station Alpha';
    const tallierId = tallier_id || 1;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const stmt = db.prepare(`INSERT INTO tally_records (tallier_id, location, route, category, count, timestamp) VALUES (?, ?, ?, ?, ?, ?)`);

        // Counts object contains incremental categories/values
        for (const [category, count] of Object.entries(counts)) {
            if (count > 0) {
                stmt.run(tallierId, locationName, 'Default Route', category, count, recordTimestamp);
            }
        }
        stmt.finalize();

        db.run('COMMIT', (err) => {
            if (err) {
                console.error('Transaction commit error:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, message: 'Counts synchronized successfully.' });
        });
    });
});

// Get all stored tally records
app.get('/api/tallies', (req, res) => {
    db.all(`SELECT * FROM tally_records ORDER BY id DESC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, records: rows });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Traffic Tallying System backend running on http://localhost:${PORT}`);
});