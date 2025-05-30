const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const { Client } = require('pg');

// Configuración
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
    const res = await context.request({
      method: 'GET',
      path: `/v1.0/devices/${DEVICE_ID}/status`,
    });

    const temperatura = res.result.find(x => x.code === 'temp_current_external')?.value;
    const timestamp = new Date().toISOString();

    console.log(`🌡️ Temperatura: ${temperatura / 10} °C @ ${timestamp}`);

    await db.connect();

    const insert = `
      INSERT INTO lecturas (sensor_id, fecha, temperatura)
      VALUES ($1, $2, $3)
    `;
    await db.query(insert, [SENSOR_ID, timestamp, temperatura / 10]);

    console.log('✅ Guardado en la base de datos');
  } catch (err) {
    console.error('⛔ Error:', err.message);
  } finally {
    await db.end();
  }
})();
