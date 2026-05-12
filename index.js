// index.js
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import { google } from "googleapis";
import fs from "fs";
import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Clientes ───────────────────────────────────────────────
const claude   = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Google Calendar OAuth ──────────────────────────────────
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_PATH = "token.json";
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

async function getCalendarAuth() {
  const token = JSON.parse(process.env.GOOGLE_TOKEN);
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

const MESES = {enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11};

function parsearFechaHora(fecha, hora) {
  // Parsear fecha: "8 de mayo", "8 mayo", "8/5"
  let dia, mes, anio = new Date().getFullYear();
  const fLower = fecha.toLowerCase().trim();
  const mMatch = fLower.match(/(\d{1,2})[^\w]*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  if (mMatch) { dia = parseInt(mMatch[1]); mes = MESES[mMatch[2]]; }
  else {
    const nMatch = fLower.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (nMatch) { dia = parseInt(nMatch[1]); mes = parseInt(nMatch[2]) - 1; }
  }

  // Parsear hora: "2pm", "2:00 pm", "14:00", "2 pm"
  let horas = 10, minutos = 0;
  const hLower = hora.toLowerCase().replace(/\s/g,"");
  const hMatch = hLower.match(/(\d{1,2})(?::(\d{2}))?(am|pm)?/);
  if (hMatch) {
    horas = parseInt(hMatch[1]);
    minutos = hMatch[2] ? parseInt(hMatch[2]) : 0;
    if (hMatch[3] === "pm" && horas < 12) horas += 12;
    if (hMatch[3] === "am" && horas === 12) horas = 0;
  }

  const d = new Date(anio, mes ?? 4, dia ?? new Date().getDate() + 1, horas, minutos);
  return isNaN(d) ? null : d;
}

async function crearEventoCalendar(datos) {
  try {
    const auth = await getCalendarAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const inicio = parsearFechaHora(datos.fecha, datos.hora) || (() => {
      const d = new Date(); d.setDate(d.getDate()+1); d.setHours(10,0,0,0); return d;
    })();
    console.log(`📅 Fecha parseada: ${inicio.toLocaleString("es-CO")}`);
    const fin = new Date(inicio.getTime() + 60 * 60 * 1000); // 1 hora después

    const evento = {
      summary: `🦷 ${datos.servicio} — ${datos.nombre}`,
      description: `Paciente: ${datos.nombre}\nServicio: ${datos.servicio}\nTeléfono: ${datos.telefono}`,
      start: { dateTime: inicio.toISOString(), timeZone: "America/Bogota" },
      end:   { dateTime: fin.toISOString(),   timeZone: "America/Bogota" },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email",  minutes: 60 },
          { method: "popup",  minutes: 30 },
        ],
      },
    };

    const res = await calendar.events.insert({ calendarId: "primary", resource: evento });
    console.log("📅 Evento creado en Google Calendar:", res.data.htmlLink);
    return res.data.htmlLink;
  } catch (err) {
    console.error("❌ Error Google Calendar:", err.message);
    return null;
  }
}

// ── Historial de conversaciones ────────────────────────────
const conversaciones = {};

// ── Webhook WhatsApp ───────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
  const data = req.body.data;
  if (!data || data.fromMe) return res.sendStatus(200);

  const from    = data.from;
  const mensaje = data.body;
  console.log(`📩 [${from}]: ${mensaje}`);

  if (!conversaciones[from]) conversaciones[from] = [];
  conversaciones[from].push({ role: "user", content: mensaje });

  try {
    const respuesta = await claude.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: `Eres Sofía, asistente virtual de la Clínica Dental Silva.
Eres amable, profesional y concisa (máximo 3 oraciones).

Servicios: limpieza ($80), blanqueamiento ($150), ortodoncia (consulta gratis), extracciones ($60).
Horarios: lunes a viernes 8am-6pm, sábados 8am-2pm.

Cuando el paciente quiera agendar, pídele paso a paso:
1. Nombre completo
2. Servicio que necesita
3. Fecha y hora preferida

Cuando tengas los 3 datos incluye al final (invisible):
AGENDAR:{"nombre":"X","servicio":"X","fecha":"X","hora":"X","telefono":"${from}"}

Responde siempre en español.`,
      messages: conversaciones[from],
    });

    let texto = respuesta.content[0].text;

    const match = texto.match(/AGENDAR:(\{.*?\})/s);
    if (match) {
      const datos = JSON.parse(match[1]);
      await guardarCita(datos);
      await crearEventoCalendar(datos);
      texto = texto.replace(/AGENDAR:\{.*?\}/s, "").trim();
    }

    conversaciones[from].push({ role: "assistant", content: texto });
    await enviarMensaje(from, texto);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.sendStatus(500);
  }
});

// ── Enviar mensaje UltraMsg ────────────────────────────────
async function enviarMensaje(to, mensaje) {
  await fetch(`https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: process.env.ULTRAMSG_TOKEN, to, body: mensaje }),
  });
}

// ── Guardar en Supabase ────────────────────────────────────
async function guardarCita(datos) {
  const { nombre, servicio, fecha, hora, telefono } = datos;
  const nota = `Cita: ${servicio} — ${fecha} a las ${hora}`;

  const { data: existente } = await supabase
    .from("leads").select("id, notes").eq("phone", telefono).maybeSingle();

  if (existente) {
    await supabase.from("leads").update({
      status: "qualified",
      notes: [...(existente.notes || []), nota],
    }).eq("id", existente.id);
    console.log(`✅ Lead actualizado: ${nombre}`);
  } else {
    await supabase.from("leads").insert({
      name: nombre, phone: telefono, company: "Paciente",
      status: "contacted", value: 80, notes: [nota],
    });
    console.log(`✅ Nuevo lead creado: ${nombre}`);
  }
}

// ── Iniciar servidor ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  await getCalendarAuth(); // Autoriza Google Calendar al arrancar
});