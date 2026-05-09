// index.js — Full Stack: Audio + Imagen + Texto + Supabase + Google Calendar
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Clientes ───────────────────────────────────────────────
const claude   = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Google Calendar ────────────────────────────────────────
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(JSON.parse(process.env.GOOGLE_TOKEN));

const MESES = {enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11};

function parsearFechaHora(fecha, hora) {
  let dia, mes, anio = new Date().getFullYear();
  const fL = fecha.toLowerCase().trim();
  const mM = fL.match(/(\d{1,2})[^\w]*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  if (mM) { dia=parseInt(mM[1]); mes=MESES[mM[2]]; }
  else { const nM=fL.match(/(\d{1,2})[\/\-](\d{1,2})/); if(nM){dia=parseInt(nM[1]);mes=parseInt(nM[2])-1;} }
  let horas=10, minutos=0;
  const hL = hora.toLowerCase().replace(/\s/g,"");
  const hM = hL.match(/(\d{1,2})(?::(\d{2}))?(am|pm)?/);
  if (hM) {
    horas=parseInt(hM[1]); minutos=hM[2]?parseInt(hM[2]):0;
    if(hM[3]==="pm"&&horas<12) horas+=12;
    if(hM[3]==="am"&&horas===12) horas=0;
  }
  const d = new Date(anio, mes??4, dia??new Date().getDate()+1, horas, minutos);
  return isNaN(d)?null:d;
}

async function crearEventoCalendar(datos) {
  try {
    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
    const inicio = parsearFechaHora(datos.fecha, datos.hora) || (() => {
      const d=new Date(); d.setDate(d.getDate()+1); d.setHours(10,0,0,0); return d;
    })();
    const fin = new Date(inicio.getTime() + 60*60*1000);
    const evento = {
      summary: `🦷 ${datos.servicio} — ${datos.nombre}`,
      description: `Paciente: ${datos.nombre}\nServicio: ${datos.servicio}\nTeléfono: ${datos.telefono}`,
      start: { dateTime: inicio.toISOString(), timeZone: "America/Bogota" },
      end:   { dateTime: fin.toISOString(),   timeZone: "America/Bogota" },
      reminders: { useDefault: false, overrides: [{ method:"email",minutes:60 },{ method:"popup",minutes:30 }] },
    };
    const res = await calendar.events.insert({ calendarId:"primary", resource:evento });
    console.log("📅 Evento en Calendar:", res.data.htmlLink);
    return res.data.htmlLink;
  } catch(e) { console.error("❌ Calendar:", e.message); return null; }
}

// ── Historial ──────────────────────────────────────────────
const conversaciones = {};

// ── Descargar archivo de UltraMsg ──────────────────────────
async function descargarMedia(mediaUrl) {
  try {
    const url = mediaUrl.includes("?") 
      ? `${mediaUrl}&token=${process.env.ULTRAMSG_TOKEN}`
      : `${mediaUrl}?token=${process.env.ULTRAMSG_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.buffer();
    return buffer;
  } catch(e) { console.error("❌ Error descargando media:", e.message); return null; }
}

// ── Transcribir audio con Whisper ──────────────────────────
async function transcribirAudio(buffer, extension = "ogg") {
  try {
    const tmpPath = `/tmp/audio_${Date.now()}.${extension}`;
    fs.writeFileSync(tmpPath, buffer);
    const form = new FormData();
    form.append("file", fs.createReadStream(tmpPath), { filename: `audio.${extension}`, contentType: "audio/ogg" });
    form.append("model", "whisper-1");
    form.append("language", "es");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_KEY}`, ...form.getHeaders() },
      body: form,
    });
    fs.unlinkSync(tmpPath);
    if (!res.ok) { const err=await res.text(); throw new Error(err); }
    const data = await res.json();
    console.log("🎙️ Transcripción:", data.text);
    return data.text;
  } catch(e) { console.error("❌ Whisper:", e.message); return null; }
}

// ── Analizar imagen con Claude Vision ─────────────────────
async function analizarImagen(buffer, from, historial) {
  try {
    const base64 = buffer.toString("base64");
    const messages = [
      ...historial,
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: "El paciente te envió esta imagen. Analízala en el contexto de una clínica dental y responde de forma útil y profesional." }
        ]
      }
    ];
    const res = await claude.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: buildSystemPrompt(from),
      messages,
    });
    return res.content[0].text;
  } catch(e) { console.error("❌ Vision:", e.message); return null; }
}

// ── System prompt ──────────────────────────────────────────
function buildSystemPrompt(from) {
  return `Eres Sofía, asistente virtual de la Clínica Dental Silva.
Eres amable, profesional y concisa (máximo 3 oraciones por respuesta).

Servicios: limpieza ($80), blanqueamiento ($150), ortodoncia (consulta gratis), extracciones ($60).
Horarios: lunes a viernes 8am-6pm, sábados 8am-2pm.

Cuando el paciente quiera agendar, pídele paso a paso:
1. Nombre completo
2. Servicio que necesita
3. Fecha y hora preferida

Cuando tengas los 3 datos incluye al final (invisible al usuario):
AGENDAR:{"nombre":"X","servicio":"X","fecha":"X","hora":"X","telefono":"${from}"}

Responde siempre en español.`;
}

// ── Webhook principal ──────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
  const data = req.body.data;
  if (!data || data.fromMe) return res.sendStatus(200);

  const from  = data.from;
  const tipo  = data.type || "chat";
  const body  = data.body || "";
  const media = data.media || data.mediaUrl || "";

  console.log(`📩 [${from}] tipo=${tipo}`);

  if (!conversaciones[from]) conversaciones[from] = [];

  try {
    let mensajeTexto = "";
    let respuestaDirecta = null;

    // ── AUDIO o NOTA DE VOZ ────────────────────────────────
    if (tipo === "audio" || tipo === "ptt") {
      await enviarMensaje(from, "🎙️ Escuché tu mensaje de voz, déjame transcribirlo...");
      const buffer = await descargarMedia(media || body);
      if (buffer) {
        const transcripcion = await transcribirAudio(buffer, "ogg");
        if (transcripcion) {
          mensajeTexto = transcripcion;
          console.log("🎙️ Procesando audio como:", transcripcion);
        } else {
          await enviarMensaje(from, "😅 No pude entender el audio. ¿Puedes escribirme tu consulta?");
          return res.sendStatus(200);
        }
      } else {
        await enviarMensaje(from, "😅 No pude descargar el audio. ¿Puedes escribirme?");
        return res.sendStatus(200);
      }
    }

    // ── IMAGEN ─────────────────────────────────────────────
    else if (tipo === "image") {
      await enviarMensaje(from, "📸 Viendo tu imagen, un momento...");
      const buffer = await descargarMedia(media || body);
      if (buffer) {
        respuestaDirecta = await analizarImagen(buffer, from, conversaciones[from]);
        if (!respuestaDirecta) {
          await enviarMensaje(from, "😅 No pude analizar la imagen. ¿Puedes describirme qué necesitas?");
          return res.sendStatus(200);
        }
      } else {
        await enviarMensaje(from, "😅 No pude descargar la imagen. ¿Puedes escribirme?");
        return res.sendStatus(200);
      }
    }

    // ── VIDEO / DOCUMENTO ──────────────────────────────────
    else if (tipo === "video" || tipo === "document") {
      await enviarMensaje(from, "📎 Recibí tu archivo. Por el momento solo proceso texto e imágenes. ¿En qué te puedo ayudar? 😊");
      return res.sendStatus(200);
    }

    // ── TEXTO ──────────────────────────────────────────────
    else if (tipo === "chat" || tipo === "text") {
      if (!body.trim()) return res.sendStatus(200);
      mensajeTexto = body;
    }

    else {
      return res.sendStatus(200);
    }

    // ── Procesar con Claude ────────────────────────────────
    let textoFinal = respuestaDirecta;

    if (!textoFinal && mensajeTexto) {
      conversaciones[from].push({ role: "user", content: mensajeTexto });
      const respuesta = await claude.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: buildSystemPrompt(from),
        messages: conversaciones[from],
      });
      textoFinal = respuesta.content[0].text;
    }

    // ── Detectar agendamiento ──────────────────────────────
    const match = textoFinal.match(/AGENDAR:(\{.*?\})/s);
    if (match) {
      const datos = JSON.parse(match[1]);
      await guardarCita(datos);
      await crearEventoCalendar(datos);
      textoFinal = textoFinal.replace(/AGENDAR:\{.*?\}/s, "").trim();
    }

    // ── Guardar respuesta y enviar ─────────────────────────
    if (mensajeTexto) conversaciones[from].push({ role:"assistant", content:textoFinal });
    await enviarMensaje(from, textoFinal);
    res.sendStatus(200);

  } catch(e) {
    console.error("❌ Error general:", e.message);
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

// ── Guardar cita en Supabase ───────────────────────────────
async function guardarCita(datos) {
  const { nombre, servicio, fecha, hora, telefono } = datos;
  const nota = `Cita: ${servicio} — ${fecha} a las ${hora}`;
  const { data: existente } = await supabase.from("leads").select("id,notes").eq("phone",telefono).maybeSingle();
  if (existente) {
    await supabase.from("leads").update({ status:"qualified", notes:[...(existente.notes||[]),nota] }).eq("id",existente.id);
    console.log(`✅ Lead actualizado: ${nombre}`);
  } else {
    await supabase.from("leads").insert({ name:nombre, phone:telefono, company:"Paciente", status:"contacted", value:80, notes:[nota] });
    console.log(`✅ Nuevo lead creado: ${nombre}`);
  }
}

// ── Servidor ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));