require('dotenv').config();

const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const { Client } = require('pg');
const sgMail = require('@sendgrid/mail');
const { DateTime } = require('luxon');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const SENSOR_ID = 'sensor1';

const context = new TuyaContext({
  baseUrl: process.env.TUYA_API_URL,
  accessKey: process.env.TUYA_CLIENT_ID,
  secretKey: process.env.TUYA_CLIENT_SECRET,
});

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    /* ---------- LECTURA TUYA ---------- */
    console.log('🚀 Iniciando lectura de Tuya…');
    const tuyaRes = await context.request({
      method: 'GET',
      path: `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/status`,
    });

    const raw = tuyaRes.result?.find(x => x.code === 'temp_current_external')?.value;
    if (raw === undefined) {
      console.error('⛔ No se encontró temperatura externa.');
      return;
    }

    const temperatura   = raw / 10;
    const nowUTC        = DateTime.utc();                       // referencia absoluta
    const nowMadrid     = nowUTC.setZone('Europe/Madrid');      // solo para mostrar

    console.log(`🌡️ Temp: ${temperatura} °C  @ ${nowMadrid.toFormat('yyyy-MM-dd HH:mm:ss')}`);

    await db.connect();

    /* ---------- GUARDAR LECTURA (UTC) ---------- */
    await db.query(
      `INSERT INTO lecturas (sensor_id, fecha, temperatura)
       VALUES ($1, $2, $3)`,
      [SENSOR_ID, nowUTC.toISO(), temperatura]
    );

    /* ---------- CONFIGURACIÓN SENSOR ---------- */
    const conf = await db.query(
      `SELECT s.umbral_min, s.umbral_max, c.email
         FROM sensores s
         JOIN clientes c ON c.id = s.cliente_id
        WHERE s.id = $1`,
      [SENSOR_ID]
    );
    if (!conf.rows.length) {
      console.warn(`⚠️ Sin configuración para ${SENSOR_ID}`);
      return;
    }
    const { umbral_min, umbral_max, email } = conf.rows[0];

    /* ---------- VALIDACIÓN UMBRAL ---------- */
    if (temperatura >= umbral_min && temperatura <= umbral_max) {
      console.log('✅ Temperatura dentro de rango.');
      return;
    }
    console.log(`⚠️ TEMP FUERA DE RANGO: ${temperatura} °C  (rango: ${umbral_min}–${umbral_max})`);
    console.log(`📧 Destinatario: ${email}`);

    /* ---------- CONTROL 1 ALERTA / 12 h ---------- */
    const ultima = await db.query(
      `SELECT fecha
         FROM alertas_enviadas
        WHERE sensor_id = $1
     ORDER BY fecha DESC
        LIMIT 1`,
      [SENSOR_ID]
    );

    if (ultima.rows.length) {
      const ultimaUTC = DateTime.fromISO(ultima.rows[0].fecha, { zone: 'utc' });
      if (nowUTC.diff(ultimaUTC, 'hours').hours < 12) {
        console.log('⏱️ Ya se envió una alerta en las últimas 12 h.');
        await db.end();
        return;
      }
    }

    /* ---------- ENVÍO DE CORREO ---------- */
    const msg = {
      to:   email,
      from: email,
      subject: `⚠️ TempGuard – Alerta de temperatura (${SENSOR_ID})`,
      html: `
        <p>Se ha detectado una temperatura fuera de rango:</p>
        <ul>
          <li><strong>Sensor:</strong> ${SENSOR_ID}</li>
          <li><strong>Temperatura:</strong> ${temperatura} °C</li>
          <li><strong>Fecha (local):</strong> ${nowMadrid.toFormat('yyyy-MM-dd HH:mm:ss')}</li>
          <li><strong>Rango permitido:</strong> ${umbral_min} – ${umbral_max} °C</li>
        </ul>
      `,
    };

    try {
      await sgMail.send(msg);
      console.log('📤 Alerta enviada correctamente.');
    } catch (e) {
      console.error('⛔ Error al enviar correo:', e.message);
    }

    /* ---------- REGISTRAR ALERTA (UTC) ---------- */
    await db.query(
      `INSERT INTO alertas_enviadas (sensor_id, fecha, tipo, valor)
       VALUES ($1, $2, $3, $4)`,
      [SENSOR_ID, nowUTC.toISO(), 'temp_fuera_rango', temperatura]
    );
  } catch (err) {
    console.error('⛔ Error general:', err.message);
  } finally {
    await db.end();
  }
})();
