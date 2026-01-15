const axios = require("axios");

// ✅ Change this if you want to test ngrok too
const URL = "http://localhost:3000/update";

function random(min, max) {
  return (Math.random() * (max - min) + min).toFixed(2);
}

setInterval(async () => {
  // Mix of SAFE + UNSAFE random values
  const pH = random(4.5, 9.5);
  const tds = Math.floor(Math.random() * 1000);
  const temp = random(25, 45);

  try {
    await axios.get(`${URL}?pH=${pH}&tds=${tds}&temp=${temp}`);
    console.log("✅ Sent:", { pH, tds, temp });
  } catch (err) {
    console.log("❌ Error:", err.message);
  }
}, 5000);
