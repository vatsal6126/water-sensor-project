// Conditionally load .env only in local development, not on Render
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require("express");
const http = require("http");
const axios = require("axios");

const FIREBASE_DB = "https://water-sensor-project-default-rtdb.asia-southeast1.firebasedatabase.app";
const RESET_PASSWORD = "LDCHEMICAL";
const PORT = process.env.PORT || 3000;

// Uses Render Environment Variable if available, otherwise uses your provided fallback key
const GROQ_API_KEY = process.env.GROQ_API_KEY; 

const NTFY_TOPIC = "chemeleon_water_alerts"; 

const app = express();
const server = http.createServer(app);

app.use(express.static("public"));
app.use(express.json()); 

server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
  if (!GROQ_API_KEY) {
      console.log("⚠️ WARNING: GROQ_API_KEY is missing. Add it to Render Environment Variables.");
  } else {
      console.log("🦙 Groq Llama 3.3 API Key loaded successfully.");
  }
});

// ================= DISTANCE FUNCTION =================
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

// ================= NTFY ALERT FUNCTION =================
async function sendNtfyAlert(entry, deviceId) {
  try {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
      `🚨 CRITICAL WATER ALERT 🚨\nDevice: ${deviceId}\nLocation: ${entry.lat}, ${entry.lng}\npH: ${entry.pH}\nTDS: ${entry.tds} ppm\nTemp: ${entry.temp} °C\nTurbidity: ${entry.turb} NTU`,
      {
        headers: {
          "Title": "Chemeleon: Contamination Detected!",
          "Tags": "warning,skull,droplet",
          "Priority": "high" 
        }
      }
    );
    console.log("🚨 Ntfy warning sent successfully!");
  } catch (error) {
    console.error("Failed to send ntfy alert:", error.message);
  }
}

// ================= AI SUMMARY ROUTE (GROQ LLAMA 3.3) =================
app.post("/api/ai-summary", async (req, res) => {
  const { ph, tds, temp, turb } = req.body;

  console.log(`🦙 Received AI request for pH:${ph}, TDS:${tds}, Temp:${temp}, Turb:${turb}`);

  if (!GROQ_API_KEY) {
    console.error("❌ Server missing GROQ_API_KEY");
    return res.status(500).json({ error: "Server missing API Key configuration in Render." });
  }

  const prompt = `You are a professional environmental scientist. Analyze this water data: 
  pH: ${ph}, TDS: ${tds} mg/L, Temp: ${temp}°C, Turbidity: ${turb} NTU.
  Provide a concise 4-sentence summary: 
  1. Overall health of the water.
  2. The most concerning parameter (if any).
  3. A practical recommendation for the user.
  4. What problem it leads to if this water is used in anyway.
  Use simple, friendly language. Format it nicely. Try to keep it small and easy to understand.`;

  try {
    // UPDATED TO USE GROQ LLAMA 3.3 70B
    const response = await axios.post(
      `https://api.groq.com/openai/v1/chat/completions`,
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      },
      {
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        }
      }
    );

    const output = response.data.choices[0].message.content;
    console.log("✅ Successfully generated Llama 3.3 response.");
    res.json({ summary: output });
  } catch (error) {
    console.error("❌ Groq API Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    res.status(500).json({ error: "Failed to generate AI summary. You may have hit a rate limit." });
  }
});

// ================= ADD ROUTE (MANUAL LINK ADD) =================
app.get("/add", async (req, res) => {
  const id = req.query.id || "device1";

  const pH = parseFloat(req.query.pH);
  const tds = parseFloat(req.query.tds);
  const temp = parseFloat(req.query.temp);
  const turb = parseFloat(req.query.turb);
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if ([pH, tds, temp, turb, lat, lng].some(isNaN)) {
    return res.status(400).send("Invalid values");
  }

  const status =
    pH < 6.5 || pH > 8.5 || tds > 500 || temp > 35 || turb > 10
      ? "WARNING"
      : "SAFE";

  const entry = {
    ts: Date.now(),
    time: new Date().toLocaleString(),
    pH, tds, temp, turb, status, lat, lng,
  };

  try {
    await axios.post(`${FIREBASE_DB}/devices/${id}/history.json`, entry);
    await axios.post(`${FIREBASE_DB}/devices/${id}/pins.json`, entry);

    if (status === "WARNING") {
      sendNtfyAlert(entry, id);
    }
    res.send("Pin added successfully");
  } catch (err) {
    res.status(500).send("Firebase Error");
  }
});

// ================= UPDATE ROUTE (ESP32) =================
app.get("/ping", (req, res) => {
  res.status(200).send("Server alive");
});

app.get("/update", async (req, res) => {
  const id = req.query.id || "device1";

  const pH = parseFloat(req.query.pH);
  const tds = parseFloat(req.query.tds);
  const temp = parseFloat(req.query.temp);
  const turb = parseFloat(req.query.turb);
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if ([pH, tds, temp, turb].some(isNaN)) {
    return res.status(400).send("Invalid sensor values");
  }

  const status =
    pH < 6.5 || pH > 8.5 || tds > 500 || temp > 35 || turb > 10
      ? "WARNING"
      : "SAFE";

  const entry = {
    ts: Date.now(),
    time: new Date().toLocaleString(),
    pH, tds, temp, turb, status,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
  };

  try {
    await axios.patch(`${FIREBASE_DB}/devices/${id}/latest.json`, entry);
    await axios.post(`${FIREBASE_DB}/devices/${id}/history.json`, entry);

    if (entry.lat !== null && entry.lng !== null) {
      const pinsRes = await axios.get(`${FIREBASE_DB}/devices/${id}/pins.json`);
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
        await axios.patch(`${FIREBASE_DB}/devices/${id}/pins/${nearestPinId}.json`, entry);
      } else {
        await axios.post(`${FIREBASE_DB}/devices/${id}/pins.json`, entry);
      }
    }

    if (status === "WARNING") {
      sendNtfyAlert(entry, id);
    }
    res.send("Data Stored Successfully");
  } catch (err) {
    res.status(500).send("Firebase Error");
  }
});

// ================= RESET =================
app.get("/reset", async (req, res) => {
  const pass = req.query.password;
  const id = req.query.id || "device1";

  if (pass !== RESET_PASSWORD) {
    return res.status(401).send("Wrong password");
  }

  try {
    await axios.delete(`${FIREBASE_DB}/devices/${id}.json`);
    res.send("Firebase reset successful");
  } catch (err) {
    res.status(500).send("Reset failed");
  }
});
