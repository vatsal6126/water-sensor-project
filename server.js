const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const axios = require("axios");

// --- CONFIGURATION ---
const NTFY_TOPIC = "water-project-group-rrdv";

// ✅ Firebase Database URL (NO ending slash)
const FIREBASE_DB =
  "https://water-sensor-project-default-rtdb.asia-southeast1.firebasedatabase.app";

// ✅ Reset password (server side secure)
const RESET_PASSWORD = "LDCHEMICAL";
// ---------------------

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DATA_FILE = "data.csv";
let history = [];
let lastAlertTime = 0;
const ALERT_COOLDOWN = 2 * 60 * 1000; // ✅ 2 minutes

// ✅ Create CSV file if it doesn't exist (local only)
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "ts,time,pH,tds,temp,turb,status,lat,lng\n");
}

// ✅ Use Render/Cloud port if available, else 3000
const PORT = process.env.PORT || 3000;

// ✅ Start Server
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

// ✅ Ping route (UptimeRobot)
app.get("/ping", (req, res) => {
  res.send("ok");
});

// ✅ Snapshot route (optional local RAM snapshot)
app.get("/snapshot", (req, res) => {
  if (history.length === 0) return res.json({});
  res.json(history[history.length - 1]);
});

/* ✅ RESET ROUTE (SECURE)
   Delete Firebase data using server-side password
   Example:
   /reset?password=LDCHEMICAL&id=device1
*/
app.get("/reset", async (req, res) => {
  const pass = req.query.password;
  const id = req.query.id || "device1";

  if (pass !== RESET_PASSWORD) {
    return res.status(401).send("❌ Wrong password");
  }

  try {
    // ✅ Delete entire device data from Firebase
    await axios.delete(`${FIREBASE_DB}/devices/${id}.json`);

    // ✅ Also clear server RAM history (graph history)
    history = [];

    // ✅ Notify all connected clients to clear UI instantly
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "reset" }));
      }
    });

    return res.send("✅ Firebase reset successful");
  } catch (err) {
    return res.status(500).send("❌ Reset failed: " + err.message);
  }
});

// ✅ Distance calculator (meters) for 25m pin rule
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --- HANDLE DATA FROM ESP32/ARDUINO ---
app.get("/update", async (req, res) => {
  const id = req.query.id || "device1";

  const phVal = parseFloat(req.query.pH);
  const tdsVal = parseFloat(req.query.tds);
  const tempVal = parseFloat(req.query.temp);
  const turbVal = parseFloat(req.query.turb);

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  // ✅ Reject invalid sensor values
  if (isNaN(phVal) || isNaN(tdsVal) || isNaN(tempVal) || isNaN(turbVal)) {
    return res.status(400).send("❌ Invalid sensor values (missing/NaN)");
  }

  // ✅ Decide SAFE / UNSAFE
  let currentStatus = "SAFE";
  if (
    phVal < 6.5 ||
    phVal > 8.5 ||
    tdsVal > 500 ||
    tempVal > 35 ||
    turbVal > 10
  ) {
    currentStatus = "UNSAFE";
  }

  // ✅ ADD ts timestamp
  const entry = {
    ts: Date.now(),
    time: new Date().toLocaleString(),
    pH: phVal,
    tds: tdsVal,
    temp: tempVal,
    turb: turbVal,
    status: currentStatus,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
  };

  // ✅ Save to history (max 50)
  history.push(entry);
  if (history.length > 50) history.shift();

  // ✅ Save to CSV (works locally, Render may reset file)
  fs.appendFileSync(
    DATA_FILE,
    `${entry.ts},${entry.time},${entry.pH},${entry.tds},${entry.temp},${entry.turb},${entry.status},${entry.lat},${entry.lng}\n`
  );

  // ✅ Send live update to website
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "reading", data: entry }));
    }
  });

  console.log("✅ Data Received:", entry);

  // ✅ Save into Firebase (latest + history + MULTI pins)
  try {
    // ✅ Save latest
    await axios.patch(`${FIREBASE_DB}/devices/${id}/latest.json`, entry);

    // ✅ Save history (auto unique key)
    await axios.post(`${FIREBASE_DB}/devices/${id}/history.json`, entry);

    // ✅ MULTI PIN SYSTEM (25 meter rule)
    if (entry.lat !== null && entry.lng !== null) {
      try {
        const pinsRes = await axios.get(
          `${FIREBASE_DB}/devices/${id}/pins.json`
        );
        const pins = pinsRes.data || {};

        let nearestPinId = null;
        let nearestDist = Infinity;

        for (const pinId in pins) {
          const p = pins[pinId];
          if (!p.lat || !p.lng) continue;

          const dist = distanceMeters(entry.lat, entry.lng, p.lat, p.lng);

          if (dist < nearestDist) {
            nearestDist = dist;
            nearestPinId = pinId;
          }
        }

        // ✅ If nearest pin within 25m → update it
        if (nearestPinId && nearestDist <= 25) {
          await axios.patch(
            `${FIREBASE_DB}/devices/${id}/pins/${nearestPinId}.json`,
            entry
          );
          console.log(
            `📍 Updated pin ${nearestPinId} (${nearestDist.toFixed(1)}m)`
          );
        } 
        // ✅ Else create a new pin
        else {
          const newPin = await axios.post(
            `${FIREBASE_DB}/devices/${id}/pins.json`,
            entry
          );
          console.log(`📍 Created new pin: ${newPin.data.name}`);
        }
      } catch (pinErr) {
        console.log("❌ Pin save error:", pinErr.message);
      }
    }
  } catch (e) {
    console.log("❌ Firebase save error:", e.message);
  }

  // ✅ Send NTFY alert (cooldown)
  if (currentStatus === "UNSAFE") {
    const now = Date.now();

    if (now - lastAlertTime > ALERT_COOLDOWN) {
      console.log("⚠️ Sending Phone Alert...");

      try {
        await axios.post(
          `https://ntfy.sh/${NTFY_TOPIC}`,
          `⚠️ DANGER: Water is UNSAFE!\n\n🧪 pH: ${entry.pH}\n💧 TDS: ${entry.tds}\n🌡️ Temp: ${entry.temp}\n🌫️ Turb: ${entry.turb}`,
          {
            headers: {
              Title: "Water Sensor Alert",
              Tags: "warning,skull",
              Priority: "high",
            },
          }
        );

        console.log("✅ Alert sent!");
        lastAlertTime = now;
      } catch (err) {
        console.error("❌ Alert Failed:", err.message);
      }
    }
  }

  res.send("✅ Data Received");
});

// --- SEND OLD HISTORY TO NEW VISITORS ---
wss.on("connection", (ws) => {
  console.log("✅ WebSocket Client Connected");
  ws.send(JSON.stringify({ type: "history", data: history }));
});


