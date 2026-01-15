const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const axios = require("axios");

// --- CONFIGURATION ---
const NTFY_TOPIC = "water-project-group-rrdv";
// ---------------------

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DATA_FILE = "data.csv";
let history = [];
let lastAlertTime = 0;
const ALERT_COOLDOWN = 2 * 60 * 1000; // ✅ 2 minutes

// ✅ Create CSV file if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "time,pH,tds,temp,status\n");
}

// ✅ Use Render/Cloud port if available, else use 3000 (Laptop)
const PORT = process.env.PORT || 3000;

// ✅ Start Server
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

// ✅ Ping route (for UptimeRobot / keep server awake)
app.get("/ping", (req, res) => {
  res.send("ok");
});

// ✅ Snapshot route (for "Fetch Latest Reading" button)
app.get("/snapshot", (req, res) => {
  if (history.length === 0) return res.json({});
  res.json(history[history.length - 1]);
});

// --- HANDLE DATA FROM ESP32/ARDUINO ---
app.get("/update", async (req, res) => {
  const phVal = parseFloat(req.query.pH);
  const tdsVal = parseFloat(req.query.tds);
  const tempVal = parseFloat(req.query.temp);

  // ✅ Reject invalid values
  if (isNaN(phVal) || isNaN(tdsVal) || isNaN(tempVal)) {
    return res.status(400).send("❌ Invalid sensor values (missing/NaN)");
  }

  // ✅ Decide SAFE / UNSAFE
  let currentStatus = "SAFE";
  if (phVal < 6.5 || phVal > 8.5 || tdsVal > 500 || tempVal > 35) {
    currentStatus = "UNSAFE";
  }

  const entry = {
    time: new Date().toLocaleString(),
    pH: phVal,
    tds: tdsVal,
    temp: tempVal,
    status: currentStatus,
  };

  // ✅ Save to history (max 50)
  history.push(entry);
  if (history.length > 50) history.shift();

  // ✅ Save to CSV
  fs.appendFileSync(
    DATA_FILE,
    `${entry.time},${entry.pH},${entry.tds},${entry.temp},${entry.status}\n`
  );

  // ✅ Send live update to website
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "reading", data: entry }));
    }
  });

  console.log("✅ Data Received:", entry);

  // ✅ Send NTFY alert (cooldown)
  if (currentStatus === "UNSAFE") {
    const now = Date.now();

    if (now - lastAlertTime > ALERT_COOLDOWN) {
      console.log("⚠️ Sending Phone Alert...");

      try {
        await axios.post(
          `https://ntfy.sh/${NTFY_TOPIC}`,
          `⚠️ DANGER: Water is UNSAFE!\n\n🧪 pH: ${entry.pH}\n💧 TDS: ${entry.tds}\n🌡️ Temp: ${entry.temp}`,
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
