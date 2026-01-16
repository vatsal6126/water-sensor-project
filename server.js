const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const axios = require("axios");

// --- CONFIGURATION ---
const NTFY_TOPIC = "water-project-group-rrdv";
const FIREBASE_DB = "https://water-sensor-project-default-rtdb.asia-southeast1.firebasedatabase.app"; // ✅ your Firebase
// ---------------------

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let history = [];
let lastAlertTime = 0;
const ALERT_COOLDOWN = 2 * 60 * 1000;

// ✅ Use Render/Cloud port if available, else 3000
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

// ✅ Ping route
app.get("/ping", (req, res) => res.send("ok"));

// ✅ Snapshot route
app.get("/snapshot", (req, res) => {
  if (history.length === 0) return res.json({});
  res.json(history[history.length - 1]);
});

// ✅ Distance formula (meters)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ✅ Firebase Helpers
async function fbGET(path) {
  const url = `${FIREBASE_DB}${path}.json`;
  const res = await axios.get(url);
  return res.data;
}

async function fbPUT(path, data) {
  const url = `${FIREBASE_DB}${path}.json`;
  await axios.put(url, data);
}

async function fbPOST(path, data) {
  const url = `${FIREBASE_DB}${path}.json`;
  await axios.post(url, data);
}

// --- HANDLE DATA FROM ESP32 ---
app.get("/update", async (req, res) => {
  const deviceId = req.query.id || "device1";

  const phVal = parseFloat(req.query.pH);
  const tdsVal = parseFloat(req.query.tds);
  const tempVal = parseFloat(req.query.temp);
  const turbVal = parseFloat(req.query.turb);

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  // ✅ Reject invalid sensor values
  if (isNaN(phVal) || isNaN(tdsVal) || isNaN(tempVal) || isNaN(turbVal)) {
    return res.status(400).send("❌ Invalid sensor values");
  }

  // ✅ Decide SAFE / UNSAFE
  let currentStatus = "SAFE";
  if (phVal < 6.5 || phVal > 8.5 || tdsVal > 500 || tempVal > 35 || turbVal > 10) {
    currentStatus = "UNSAFE";
  }

  const entry = {
    time: new Date().toLocaleString(),
    pH: phVal,
    tds: tdsVal,
    temp: tempVal,
    turb: turbVal,
    status: currentStatus,
  };

  // ✅ Save to RAM history for live graph
  history.push(entry);
  if (history.length > 50) history.shift();

  // ✅ Send live update to website
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "reading", data: entry }));
    }
  });

  console.log("✅ Data Received:", deviceId, entry);

  // ✅ SAVE EVERYTHING TO FIREBASE (Permanent)
  try {
    // 1) Save latest
    await fbPUT(`/devices/${deviceId}/latest`, {
      ...entry,
      lat: isNaN(lat) ? null : lat,
      lng: isNaN(lng) ? null : lng,
      deviceId
    });

    // 2) Save history (auto-id)
    await fbPOST(`/devices/${deviceId}/history`, {
      ...entry,
      lat: isNaN(lat) ? null : lat,
      lng: isNaN(lng) ? null : lng,
      deviceId
    });

    // 3) PIN LOGIC (only if lat/lng provided)
    if (!isNaN(lat) && !isNaN(lng)) {
      const lastPin = await fbGET(`/devices/${deviceId}/lastPin`);

      if (!lastPin || !lastPin.lat || !lastPin.lng) {
        // ✅ first pin
        const pinData = {
          lat, lng,
          ...entry,
          createdAt: entry.time,
          updatedAt: entry.time
        };
        const created = await axios.post(`${FIREBASE_DB}/devices/${deviceId}/pins.json`, pinData);
        const pinId = created.data.name;

        await fbPUT(`/devices/${deviceId}/lastPin`, { pinId, lat, lng });
      } else {
        // ✅ check distance
        const dist = distanceMeters(lastPin.lat, lastPin.lng, lat, lng);

        if (dist > 25) {
          // ✅ new pin if moved > 25m
          const pinData = {
            lat, lng,
            ...entry,
            createdAt: entry.time,
            updatedAt: entry.time
          };
          const created = await axios.post(`${FIREBASE_DB}/devices/${deviceId}/pins.json`, pinData);
          const pinId = created.data.name;

          await fbPUT(`/devices/${deviceId}/lastPin`, { pinId, lat, lng });

        } else {
          // ✅ update existing pin if within 25m
          await fbPUT(`/devices/${deviceId}/pins/${lastPin.pinId}`, {
            lat, lng,
            ...entry,
            createdAt: entry.time,
            updatedAt: entry.time
          });

          // update lastPin location too
          await fbPUT(`/devices/${deviceId}/lastPin`, {
            pinId: lastPin.pinId,
            lat,
            lng
          });
        }
      }
    }
  } catch (err) {
    console.log("❌ Firebase save error:", err.message);
  }

  // ✅ Send NTFY alert
  if (currentStatus === "UNSAFE") {
    const now = Date.now();
    if (now - lastAlertTime > ALERT_COOLDOWN) {
      try {
        await axios.post(
          `https://ntfy.sh/${NTFY_TOPIC}`,
          `⚠️ DANGER: Water is UNSAFE!\n\n🧪 pH: ${entry.pH}\n💧 TDS: ${entry.tds}\n🌡️ Temp: ${entry.temp}\n🌫️ Turb: ${entry.turb}`,
          { headers: { Title: "Water Sensor Alert", Tags: "warning,skull", Priority: "high" } }
        );
        lastAlertTime = now;
      } catch (err) {
        console.log("❌ NTFY error:", err.message);
      }
    }
  }

  res.send("✅ Data Received + Firebase Updated");
});

// ✅ history for new users
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "history", data: history }));
});
