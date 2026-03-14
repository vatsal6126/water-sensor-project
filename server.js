// local run check for .env file
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require("express");
const http = require("http");
const axios = require("axios");

const FIREBASE_DB = "https://water-sensor-project-default-rtdb.asia-southeast1.firebasedatabase.app";
const RESET_PASSWORD = process.env.RESET_PASSWORD || "LDCHEMICAL";
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NTFY_TOPIC = "chemeleon_water_alerts";

const app = express();
const server = http.createServer(app);

app.use(express.static("public"));
app.use(express.json({ limit: "64kb" })); 

server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
  if (!GROQ_API_KEY) {
    console.log("⚠️  WARNING: GROQ_API_KEY is missing. Add it to Render Environment Variables.");
  } else {
    console.log("🦙 Groq Llama 3.3 API Key loaded successfully.");
  }
});

// distance rules for mapping on pi
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

//mobile apps alert systems
async function sendNtfyAlert(entry, deviceId) {
  try {
    await axios.post(
      `https://ntfy.sh/${NTFY_TOPIC}`,
      `🚨 CRITICAL WATER ALERT 🚨\nDevice: ${deviceId}\nLocation: ${entry.lat}, ${entry.lng}\npH: ${entry.pH}\nTDS: ${entry.tds} ppm\nTemp: ${entry.temp} °C\nTurbidity: ${entry.turb} NTU\nTime: ${entry.time}`,
      {
        headers: {
          Title: "Chemeleon: Contamination Detected!",
          Tags: "warning,skull,droplet",
          Priority: "high",
          "Content-Type": "text/plain",
        },
      }
    );
    console.log("🚨 Ntfy alert sent!");
  } catch (error) {
    console.error("Failed to send ntfy alert:", error.message);
  }
}

//llmama 3.3 api
app.post("/api/ai-summary", async (req, res) => {
  const { ph, tds, temp, turb } = req.body;
  console.log(`🦙 AI request — pH:${ph} TDS:${tds} Temp:${temp} Turb:${turb}`);

  if (!GROQ_API_KEY) {
    console.error("❌ Missing GROQ_API_KEY");
    return res.status(500).json({ error: "Server missing API Key configuration in Render." });
  }

  const prompt = `You are a professional environmental scientist. Analyze this water data: 
  pH: ${ph}, TDS: ${tds} mg/L, Temp: ${temp}°C, Turbidity: ${turb} NTU.
  Provide a concise 4-sentence summary: 
  1. Overall health of the water.
  2. The most concerning parameter (if any).
  3. A practical recommendation for the user.
  4. What problem it leads to if this water is used in any way.
  Use simple, friendly language. Format it nicely. Keep it small and easy to understand.`;

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
      }
    );
    const output = response.data.choices[0].message.content;
    console.log("✅ Llama 3.3 response generated.");
    res.json({ summary: output });
  } catch (error) {
    console.error("❌ Groq API Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    res.status(500).json({ error: "Failed to generate AI summary. You may have hit a rate limit." });
  }
});

// ================= ADD ROUTE (Manual link / form) =================
app.get("/add", async (req, res) => {
  const id   = req.query.id || "device1";
  const pH   = parseFloat(req.query.pH);
  const tds  = parseFloat(req.query.tds);
  const temp = parseFloat(req.query.temp);
  const turb = parseFloat(req.query.turb);
  const lat  = parseFloat(req.query.lat);
  const lng  = parseFloat(req.query.lng);

  if ([pH, tds, temp, turb, lat, lng].some(isNaN))
    return res.status(400).send("Invalid values");

  const status =
    pH < 6.5 || pH > 8.5 || tds > 500 || temp > 35 || turb > 10
      ? "WARNING" : "SAFE";

  const entry = {
    ts: Date.now(),
    time: new Date().toLocaleString("en-IN"),
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

// ================= PING =================
app.get("/ping", (req, res) => res.status(200).send("Server alive"));

// ================= UPDATE ROUTE (ESP32 → Firebase) =================

async function handleUpdate(fields, res) {
  const {
    id = "device1",
    pH, tds, temp, turb,
    lat, lng,
    samples = null, // ADDED: optional 40-point sample arrays from new ESP32 firmware
    tsRaw   = null,
  } = fields;

  if ([pH, tds, temp, turb].some(v => isNaN(parseFloat(v))))
    return res.status(400).send("Invalid sensor values");

  const phF   = parseFloat(pH);
  const tdsF  = parseFloat(tds);
  const tempF = parseFloat(temp);
  const turbF = parseFloat(turb);
  const latF  = parseFloat(lat);
  const lngF  = parseFloat(lng);

  
  const tsRaw_ = parseInt(tsRaw);
  const ts = (!isNaN(tsRaw_) && tsRaw_ > 1000000000)
    ? tsRaw_ * 1000
    : Date.now();

  const status =
    phF < 6.5 || phF > 8.5 || tdsF > 500 || tempF > 35 || turbF > 10
      ? "WARNING" : "SAFE";


  let cleanSamples = null;
  if (samples && typeof samples === "object") {
    cleanSamples = {};
    for (const key of ["pH", "tds", "turb", "temp"]) {
      if (Array.isArray(samples[key]) && samples[key].length > 0) {
        cleanSamples[key] = samples[key]
          .slice(0, 40)
          .map(v => {
            const n = parseFloat(v);
            return isNaN(n) ? 0 : Math.round(n * 100) / 100;
          });
      }
    }
    if (Object.keys(cleanSamples).length === 0) cleanSamples = null;
  }

  const entry = {
    ts,
    time: new Date(ts).toLocaleString("en-IN"),
    pH: phF, tds: tdsF, temp: tempF, turb: turbF,
    status,
    lat: isNaN(latF) ? null : latF,
    lng: isNaN(lngF) ? null : lngF,
    ...(cleanSamples ? { samples: cleanSamples } : {}), // ADDED: spread samples into entry only if present
  };

  try {
    // UNCHANGED: same Firebase writes as original
    await axios.patch(`${FIREBASE_DB}/devices/${id}/latest.json`, entry);
    await axios.post(`${FIREBASE_DB}/devices/${id}/history.json`, entry);

    // UNCHANGED: same pin management logic as original
    if (entry.lat !== null && entry.lng !== null) {
      const pinsRes = await axios.get(`${FIREBASE_DB}/devices/${id}/pins.json`);
      const pins = pinsRes.data || {};
      let nearestId = null, nearestDist = Infinity;

      for (const pinId in pins) {
        const p = pins[pinId];
        if (!p.lat || !p.lng) continue;
        const dist = distanceMeters(entry.lat, entry.lng, p.lat, p.lng);
        if (dist < nearestDist) { nearestDist = dist; nearestId = pinId; }
      }

      if (nearestId && nearestDist <= 25) {
        await axios.patch(`${FIREBASE_DB}/devices/${id}/pins/${nearestId}.json`, entry);
      } else {
        await axios.post(`${FIREBASE_DB}/devices/${id}/pins.json`, entry);
      }
    }

    if (status === "WARNING") {
      sendNtfyAlert(entry, id);
    }

    
    const sampleInfo = cleanSamples
      ? `+samples(${Object.values(cleanSamples)[0]?.length ?? 0} pts each)`
      : "no-samples";
    console.log(`✅ [${id}] pH:${phF} TDS:${tdsF} Turb:${turbF} Temp:${tempF} → ${status} | ts:${ts} | ${sampleInfo}`);

    res.send("Data Stored Successfully");
  } catch (err) {
    console.error("Firebase Error:", err.message);
    res.status(500).send("Firebase Error");
  }
}

// 
  app.post("/update", async (req, res) => {
  const { id, pH, tds, temp, turb, wqi, lat, lng, samples, ts } = req.body;
  await handleUpdate({ id, pH, tds, temp, turb, wqi, lat, lng, samples, tsRaw: ts }, res);
});
// update is used for manual entry

app.get("/update", async (req, res) => {
  const { id, pH, tds, temp, turb, wqi, lat, lng, ts } = req.query;
  await handleUpdate({ id, pH, tds, temp, turb, wqi, lat, lng, samples: null, tsRaw: ts }, res);
});

// ================= RESET =================
app.get("/reset", async (req, res) => {
  const pass = req.query.password;
  const id   = req.query.id || "device1";

  if (pass !== RESET_PASSWORD)
    return res.status(401).send("Wrong password");

  try {
    await axios.delete(`${FIREBASE_DB}/devices/${id}.json`);
    res.send("Firebase reset successful");
  } catch (err) {
    res.status(500).send("Reset failed");
  }
});