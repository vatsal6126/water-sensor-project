const express = require("express");
const http = require("http");
const axios = require("axios");

// ================= CONFIG =================
const FIREBASE_DB =
  "https://water-sensor-project-default-rtdb.asia-southeast1.firebasedatabase.app";

const RESET_PASSWORD = "LDCHEMICAL";
const NTFY_TOPIC = "water-project-group-rrdv";

const ALERT_COOLDOWN = 2 * 60 * 1000; // 2 minutes
let lastAlertTime = 0;
// ==========================================

const app = express();
const server = http.createServer(app);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ================= KEEP ALIVE =================
app.get("/ping", (req, res) => {
  res.send("ok");
});

// ================= RESET =================
app.get("/reset", async (req, res) => {
  const pass = req.query.password;
  const id = req.query.id || "device1";

  if (pass !== RESET_PASSWORD) {
    return res.status(401).send("❌ Wrong password");
  }

  try {
    await axios.delete(`${FIREBASE_DB}/devices/${id}.json`);
    return res.send("✅ Firebase reset successful");
  } catch (err) {
    return res.status(500).send("❌ Reset failed: " + err.message);
  }
});

// ================= DISTANCE (25m rule) =================
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ================= UPDATE ROUTE =================
app.get("/update", async (req, res) => {
  const id = req.query.id || "device1";

  const pH = parseFloat(req.query.pH);
  const tds = parseFloat(req.query.tds);
  const temp = parseFloat(req.query.temp);
  const turb = parseFloat(req.query.turb);

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(pH) || isNaN(tds) || isNaN(temp) || isNaN(turb)) {
    return res.status(400).send("❌ Invalid sensor values");
  }

  let status = "SAFE";
  if (pH < 6.5 || pH > 8.5 || tds > 500 || temp > 35 || turb > 10) {
    status = "UNSAFE";
  }

  const entry = {
    ts: Date.now(),
    time: new Date().toLocaleString(),
    pH,
    tds,
    temp,
    turb,
    status,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
  };

  console.log("📡 Data Received:", entry);

  try {
    // Save latest
    await axios.patch(`${FIREBASE_DB}/devices/${id}/latest.json`, entry);

    // Save history
    await axios.post(`${FIREBASE_DB}/devices/${id}/history.json`, entry);

    // ================= MULTI PIN SYSTEM =================
    if (entry.lat !== null && entry.lng !== null) {
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

      if (nearestPinId && nearestDist <= 25) {
        await axios.patch(
          `${FIREBASE_DB}/devices/${id}/pins/${nearestPinId}.json`,
          entry
        );
        console.log(`📍 Updated pin (${nearestDist.toFixed(1)}m)`);
      } else {
        await axios.post(
          `${FIREBASE_DB}/devices/${id}/pins.json`,
          entry
        );
        console.log("📍 Created new pin");
      }
    }

    // ================= ALERT SYSTEM =================
    if (status === "UNSAFE") {
      const now = Date.now();

      if (now - lastAlertTime > ALERT_COOLDOWN) {
        await axios.post(
          `https://ntfy.sh/${NTFY_TOPIC}`,
          `⚠️ Water is UNSAFE!\n\n🧪 pH: ${pH}\n💧 TDS: ${tds}\n🌡 Temp: ${temp}\n🌫 Turbidity: ${turb}`,
          {
            headers: {
              Title: "Water Quality Alert",
              Priority: "high",
            },
          }
        );

        lastAlertTime = now;
      }
    }

    res.send("✅ Data Stored Successfully");
  } catch (err) {
    console.log("❌ Firebase error:", err.message);
    res.status(500).send("Firebase Error");
  }
});



