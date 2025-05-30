const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const { Client } = require('pg');

// Log para confirmar que el script se lanza
console.log("🚀 Iniciando lectura de Tuya...");

const context = new TuyaContext({
  baseUrl: process.env.TUYA_API_URL,
  accessKey: process.env.TUYA_CLIENT_ID,
  secretKey: process.env.TUYA_CLIENT_SECRET,
});

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEVICE_ID = process.env.TUYA_DEVICE_ID;
const SENSOR_ID = 'sensor1';

(async () => {
  try {
    console.log("📡 Pidiendo datos a Tuya...");
    const res = await context.request({
      method: 'GET',
      path: `/v1.0/devices/${DEVICE_ID}/status`,
    });

    console.log("🔍 Respuesta de Tuya:", JSON.stringify(res, null, 2));

    const temperatura = res.result?.find(x => x.code === 'temp_current_external')?.value;

    if (temperatura === undefined) {
      console.error("⛔ No se pudo encontrar la temperatura.");
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`🌡️ Temperatura obtenida: ${temperatura / 10} °C @ ${timestamp}`);

    await db.connect();

    const insert = `
      INSERT INTO lecturas (sensor_id, fecha, temperatura)
      VALUES ($1, $2, $3)
    `;
    await db.query(insert, [SENSOR_ID, timestamp, temperatura / 10]);

    console.log('✅ Guardado en la base de datos');
  } catch (err) {
    console.error('⛔ Error general:', err.message);
  } finally {
    await db.end();
  }
})();
