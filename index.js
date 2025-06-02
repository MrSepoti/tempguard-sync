/***************************
 * TempGuard – Backend MVP *
 ***************************/
require('dotenv').config();

const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const { Client }     = require('pg');
const sgMail         = require('@sendgrid/mail');
const { DateTime }   = require('luxon');

/* ---------- SendGrid ---------- */
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/* ---------- Tuya ---------- */
const context = new TuyaContext({
  baseUrl:    process.env.TUYA_API_URL,
  accessKey:  process.env.TUYA_CLIENT_ID,
  secretKey:  process.env.TUYA_CLIENT_SECRET,
});
const TUYA_DEVICE_ID = process.env.TUYA_DEVICE_ID;

/* ---------- PostgreSQL ---------- */
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ---------- Constantes ---------- */
const SENSOR_ID   = 'sensor1';          // Id lógico interno
const ZONE_MADRID = 'Europe/Madrid';    // Para mostrar hora local

/* ---------- Main ---------- */
(async () => {
  try {
    console.log('🚀 Iniciando lectura de Tuya…');

    /* 1. Obtener temperatura del sensor */
    const tRes = await context.request({
      method: 'GET',
      path:   `/v1.0/devices/${TUYA_DEVICE_ID}/status`
    });

    const raw = tRes.result?.find(x => x.code === 'temp_current_external')?.value;
    if (raw === undefined) {
      console.error('⛔ No se encontró la temperatura.');
      return;
    }
    const temperatura = raw / 10;

    /* 2. Timestamps */
    const nowUTC    = DateTime.utc();                 // Referencia absoluta
    const nowLocal  = nowUTC.setZone(ZONE_MADRID);    // Solo para visualizar
    console.log(`🌡️ Temp: ${temperatura} °C  @ ${nowLocal.toFormat('yyyy-MM-dd HH:mm:ss')}`);

    await db.connect();

    /* 3. Guardar lectura */
    await db.query(
      `INSERT INTO lecturas (sensor_id, fecha, temperatura)
       VALUES ($1, $2, $3)`,
      [SENSOR_ID, nowUTC.toISO(), temperatura]
    );

    /* 4. Obtener umbrales y correo */
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

    /* 5. ¿Fuera de rango? */
    if (temperatura >= umbral_min && temperatura <= umbral_max) {
      console.log('✅ Temperatura dentro del rango.');
      return;
    }
    console.log(
      `⚠️ TEMP FUERA DE RANGO: ${temperatura} °C  (rango: ${umbral_min} – ${umbral_max})`
    );

    /* 6. ¿Ya hubo alerta en las últimas 12 h?  (todo en UTC) */
    const existe = await db.query(
      `SELECT 1
         FROM alertas_enviadas
        WHERE sensor_id = $1
          AND fecha >= (NOW() AT TIME ZONE 'UTC' - INTERVAL '12 hours')
        LIMIT 1`,
      [SENSOR_ID]
    );
    if (existe.rows.length) {
      console.log('⏱️ Ya se envió una alerta en las últimas 12 h.');
      return;
    }

    /* 7. Enviar correo */
    const msg = {
      to:   email,
      from: email,
      subject: `⚠️ TempGuard – Alerta de temperatura (${SENSOR_ID})`,
      html: `
        <p>Se ha detectado una temperatura fuera de rango:</p>
        <ul>
          <li><strong>Sensor:</strong> ${SENSOR_ID}</li>
          <li><strong>Temperatura:</strong> ${temperatura} °C</li>
          <li><strong>Fecha (local):</strong> ${nowLocal.toFormat('yyyy-MM-dd HH:mm:ss')}</li>
          <li><strong>Rango permitido:</strong> ${umbral_min} – ${umbral_max} °C</li>
        </ul>
      `
    };

    try {
      await sgMail.send(msg);
      console.log('📤 Alerta enviada correctamente.');
    } catch (e) {
      console.error('⛔ Error al enviar correo:', e.message);
    }

    /* 8. Registrar alerta */
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
