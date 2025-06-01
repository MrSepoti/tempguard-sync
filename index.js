require('dotenv').config(); // Cargar variables del archivo .env

const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const { Client } = require('pg');
const sgMail = require('@sendgrid/mail');
const { DateTime } = require('luxon'); // Añadido Luxon

// Configuración SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
sgMail.setApiKey(SENDGRID_API_KEY);

const SENSOR_ID = 'sensor1'; // ID lógico que usamos internamente

const context = new TuyaContext({
  baseUrl: process.env.TUYA_API_URL,
  accessKey: process.env.TUYA_CLIENT_ID,
  secretKey: process.env.TUYA_CLIENT_SECRET,
});

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    console.log("🚀 Iniciando lectura de Tuya...");

    const res = await context.request({
      method: 'GET',
      path: `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/status`,
    });

    const raw = res.result?.find(x => x.code === 'temp_current_external')?.value;
    if (raw === undefined) {
      console.error("⛔ No se encontró temperatura externa.");
      return;
    }

    const temperatura = raw / 10;
    const timestamp = DateTime.now().setZone('Europe/Madrid').toJSDate(); // Hora en España
    console.log(`🌡️ Temp: ${temperatura} °C @ ${timestamp.toISOString()}`);

    await db.connect();

    // 1. Guardar lectura
    await db.query(
      `INSERT INTO lecturas (sensor_id, fecha, temperatura) VALUES ($1, $2, $3)`,
      [SENSOR_ID, timestamp.toISOString(), temperatura]
    );

    // 2. Obtener configuración del sensor y correo del cliente
    const confRes = await db.query(`
      SELECT s.umbral_min, s.umbral_max, c.email
      FROM sensores s
      JOIN clientes c ON c.id = s.cliente_id
      WHERE s.id = $1
    `, [SENSOR_ID]);

    if (confRes.rows.length === 0) {
      console.warn(`⚠️ No se encontró configuración para el sensor ${SENSOR_ID}`);
      return;
    }

    const { umbral_min, umbral_max, email } = confRes.rows[0];
    const fueraDeRango = temperatura < umbral_min || temperatura > umbral_max;

    if (!fueraDeRango) {
      console.log("✅ Temperatura dentro del rango.");
      return;
    }

    // TEMP fuera de rango:
    console.log(`⚠️ TEMP FUERA DE RANGO: ${temperatura} ºC (rango: ${umbral_min} – ${umbral_max})`);
    console.log(`📧 Preparando envío a: ${email}`);

    // 3. Verificar alertas en las últimas 24h
    const desde = DateTime.fromJSDate(timestamp).minus({ hours: 24 }).toJSDate();
    const countRes = await db.query(`
      SELECT COUNT(*) FROM alertas_enviadas
      WHERE sensor_id = $1 AND fecha >= $2
    `, [SENSOR_ID, desde.toISOString()]);

    if (parseInt(countRes.rows[0].count) >= 2) {
      console.log("⏱️ Ya se enviaron 2 alertas en las últimas 24h.");
      return;
    }

    // 4. Enviar correo
    const mensaje = {
      to: email,
      from: email,
      subject: `⚠️ TempGuard – Alerta de temperatura (${SENSOR_ID})`,
      html: `
        <p>Se ha detectado una temperatura fuera de rango:</p>
        <ul>
          <li><strong>Sensor:</strong> ${SENSOR_ID}</li>
          <li><strong>Temperatura:</strong> ${temperatura} °C</li>
          <li><strong>Fecha:</strong> ${timestamp.toISOString()}</li>
          <li><strong>Rango permitido:</strong> ${umbral_min} – ${umbral_max} °C</li>
        </ul>
      `
    };

    try {
      await sgMail.send(mensaje);
      console.log("📤 Alerta enviada correctamente.");
    } catch (err) {
      console.error("⛔ Error al enviar correo:", err.message);
    }

    // 5. Registrar alerta
    await db.query(
      `INSERT INTO alertas_enviadas (sensor_id, fecha, tipo, valor) VALUES ($1, $2, $3, $4)`,
      [SENSOR_ID, timestamp.toISOString(), 'temp_fuera_rango', temperatura]
    );

  } catch (err) {
    console.error("⛔ Error general:", err.message);
  } finally {
    await db.end();
  }
})();
