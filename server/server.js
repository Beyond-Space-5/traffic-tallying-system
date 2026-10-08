const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Initialize SQLite Database at the project root level
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

// Create tables for config, talliers, and interval-bucketed traffic records
function initDb() {
    db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS talliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        location TEXT,
        status TEXT DEFAULT 'Active',
        last_sync DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS traffic_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tallier_id INTEGER,
        location TEXT,
        start_time DATETIME,
        end_time DATETIME,
        motorcycles INTEGER DEFAULT 0,
        cars INTEGER DEFAULT 0,
        matatus INTEGER DEFAULT 0,
        buses INTEGER DEFAULT 0,
        trucks INTEGER DEFAULT 0,
        bicycles INTEGER DEFAULT 0,
        pedestrians INTEGER DEFAULT 0,
        FOREIGN KEY(tallier_id) REFERENCES talliers(id)
    )`, () => {
        // Set default interval to 15 minutes if not exists
        db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('tts_analytics_interval', '15')`);
    });
}

// --- CONFIGURATION API ---
app.get('/api/config', (req, res) => {
    db.get(`SELECT value FROM config WHERE key = 'tts_analytics_interval'`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ interval: row ? parseInt(row.value) : 15 });
    });
});

app.post('/api/config', (req, res) => {
    const { interval } = req.body;
    db.run(`UPDATE config SET value = ? WHERE key = 'tts_analytics_interval'`, [interval], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, interval });
    });
});

// --- AUTOMATIC TALLY SYNC API ---
// Automatically buckets counts into the correct time interval window based on admin settings
app.post('/api/tally/sync', (req, res) => {
    const { tallier_id, location, timestamp, counts } = req.body;
    
    db.get(`SELECT value FROM config WHERE key = 'tts_analytics_interval'`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const intervalMinutes = row ? parseInt(row.value) : 15;
        const eventTime = new Date(timestamp || Date.now());

        // Calculate interval start and end boundaries (e.g., 7:00 to 7:15)
        const minutes = eventTime.getMinutes();
        const intervalIndex = Math.floor(minutes / intervalMinutes);
        
        const startTime = new Date(eventTime);
        startTime.setMinutes(intervalIndex * intervalMinutes, 0, 0);

        const endTime = new Date(startTime);
        endTime.setMinutes(startTime.getMinutes() + intervalMinutes);

        // Check if an interval record already exists for this tallier and time window
        db.get(
            `SELECT id FROM traffic_records WHERE tallier_id = ? AND start_time = ? AND end_time = ?`,
            [tallier_id, startTime.toISOString(), endTime.toISOString()],
            (err, existing) => {
                if (err) return res.status(500).json({ error: err.message });

                if (existing) {
                    // Update existing interval row by accumulating counts
                    db.run(`UPDATE traffic_records SET 
                        motorcycles = motorcycles + ?,
                        cars = cars + ?,
                        matatus = matatus + ?,
                        buses = buses + ?,
                        trucks = trucks + ?,
                        bicycles = bicycles + ?,
                        pedestrians = pedestrians + ?
                        WHERE id = ?`,
                        [
                            counts.motorcycles || 0,
                            counts.cars || 0,
                            counts.matatus || 0,
                            counts.buses || 0,
                            counts.trucks || 0,
                            counts.bicycles || 0,
                            counts.pedestrians || 0,
                            existing.id
                        ],
                        (updateErr) => {
                            if (updateErr) return res.status(500).json({ error: updateErr.message });
                            res.json({ success: true, interval_id: existing.id, action: 'updated' });
                        }
                    );
                } else {
                    // Create a new interval section row
                    db.run(`INSERT INTO traffic_records 
                        (tallier_id, location, start_time, end_time, motorcycles, cars, matatus, buses, trucks, bicycles, pedestrians)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            tallier_id,
                            location,
                            startTime.toISOString(),
                            endTime.toISOString(),
                            counts.motorcycles || 0,
                            counts.cars || 0,
                            counts.matatus || 0,
                            counts.buses || 0,
                            counts.trucks || 0,
                            counts.bicycles || 0,
                            counts.pedestrians || 0
                        ],
                        function(insertErr) {
                            if (insertErr) return res.status(500).json({ error: insertErr.message });
                            res.json({ success: true, interval_id: this.lastID, action: 'created' });
                        }
                    );
                }
            }
        );
    });
});

// --- ANALYTICS API FOR ADMIN APPLICATION ---
app.get('/api/analytics', (req, res) => {
    const query = ` 
        SELECT tr.*, t.username as tallier_name 
        FROM traffic_records tr
        LEFT JOIN talliers t ON tr.tallier_id = t.id
        ORDER BY tr.start_time DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Traffic Tallying Backend running on port ${PORT}`);
});