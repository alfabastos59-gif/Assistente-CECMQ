import "dotenv/config";
import express, { type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { analyzeReferenceVoice, getAiClient } from "./src/server/ai.ts";
import { executeEliCommand } from "./src/server/commands.ts";
import {
  createRateLimiter,
  isValidHttpUrl,
  sanitizeText,
} from "./src/server/security.ts";
import { resolveOrCreateSession } from "./src/server/session.ts";
import { createSessionStore } from "./src/server/storage.ts";
import {
  DEFAULT_VOICE_PROFILE,
  type PendingIntent,
  type SessionData,
} from "./src/server/types.ts";
import {
  buildLocationConfirmationPrompt,
  extractClientIp,
  getEffectiveTimeZone,
  getHourInTimeZone,
  getNowInBrazil,
  isPrivateOrLocalIp,
  lookupLocationByIp,
  resolveManualLocationData,
  reverseGeocodeCoords,
  formatDateDDMMYYYY,
  formatTimeHHMM,
} from "./src/server/weather.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = "0.0.0.0";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb" }));

const store = createSessionStore();

function formatServerAiError(
  err: unknown,
  fallbackMessage: string
): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err || "");
  if (
    /\b429\b/.test(raw) ||
    /RESOURCE_EXHAUSTED/i.test(raw) ||
    /quota/i.test(raw)
  ) {
    return {
      status: 429,
      message:
        "Limite temporário de requisições da API atingido. Tente novamente em instantes.",
    };
  }
  if (/GEMINI_API_KEY/i.test(raw)) {
    return {
      status: 500,
      message: "Chave da API Gemini não configurada no servidor.",
    };
  }
  return { status: 500, message: fallbackMessage };
}

const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 90,
  keyPrefix: "api",
});
const ttsLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 45,
  keyPrefix: "tts",
});

app.use("/api/eli", apiLimiter);

function serializeClientState(session: SessionData) {
  return {
    memory: session.memory,
    notes: session.notes,
    privateMode: session.privateMode,
    playlists: session.playlists,
    voiceProfile: session.voiceProfile,
    userName: session.userName,
    userLocation: session.userLocation,
    storage: store.info,
  };
}

// ==== ROTAS DE SESSÃO ISOLADA E ESTADO ====
app.post("/api/eli/session", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    res.json({
      sessionToken: resolved.issuedToken,
      state: serializeClientState(resolved.session),
    });
  } catch {
    res.status(500).json({ error: "Falha ao inicializar sessão isolada." });
  }
});

app.get("/api/eli/state", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    res.json({
      ...serializeClientState(resolved.session),
      ...(resolved.issuedToken ? { sessionToken: resolved.issuedToken } : {}),
    });
  } catch {
    res.status(500).json({ error: "Falha ao carregar estado da sessão." });
  }
});

// ==== GEOLOCALIZAÇÃO POR SESSÃO ====
app.post("/api/eli/location/resolve", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    const lat = req.body?.lat;
    const lon = req.body?.lon;
    const allowIpFallback = Boolean(req.body?.allowIpFallback);
    const timeZone =
      typeof req.body?.timeZone === "string" && req.body.timeZone
        ? sanitizeText(req.body.timeZone, 80)
        : undefined;

    if (
      typeof lat === "number" &&
      typeof lon === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    ) {
      // Coordenadas usadas apenas transitoriamente para geocodificação reversa; nunca armazenadas
      const geo = await reverseGeocodeCoords(lat, lon, timeZone);
      if (geo) {
        session.userLocation = geo;
        await store.set(session);
        res.json({
          location: session.userLocation,
          approximate: false,
          source: "geolocation",
        });
        return;
      }
    }

    if (allowIpFallback) {
      const clientIp =
        typeof req.body?.clientIp === "string" &&
        !isPrivateOrLocalIp(req.body.clientIp)
          ? req.body.clientIp.trim().slice(0, 64)
          : extractClientIp(req);

      if (clientIp) {
        const ipLoc = await lookupLocationByIp(clientIp);
        if (ipLoc) {
          session.userLocation = ipLoc;
          await store.set(session);
          res.json({
            location: session.userLocation,
            approximate: true,
            source: "ip",
          });
          return;
        }
      }
    }

    res.json({
      location: session.userLocation,
      approximate: false,
      source: session.userLocation ? session.userLocation.source : "none",
    });
  } catch {
    res.json({
      location: null,
      approximate: false,
      source: "none",
    });
  }
});

app.post("/api/eli/location", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    const cityText = sanitizeText(req.body?.location, 120);
    const timeZone =
      typeof req.body?.timeZone === "string"
        ? sanitizeText(req.body.timeZone, 80)
        : undefined;
    if (!cityText) {
      res.status(400).json({ error: "Informe a cidade e o estado." });
      return;
    }

    const updated = await resolveManualLocationData(cityText, timeZone);
    session.userLocation = updated;
    await store.set(session);
    res.json({ userLocation: session.userLocation });
  } catch {
    res.status(500).json({ error: "Erro ao atualizar localização." });
  }
});

app.post("/api/eli/reset-location", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    resolved.session.userLocation = null;
    await store.set(resolved.session);
    res.json({ userLocation: null });
  } catch {
    res.status(500).json({ error: "Erro ao redefinir localização." });
  }
});

// ==== BOAS-VINDAS INTELIGENTES ====
app.post("/api/eli/greeting", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    const timeZone = getEffectiveTimeZone(session, req.body?.timeZone);
    const now = getNowInBrazil(req.body?.clientIso);
    const hour = getHourInTimeZone(now, timeZone);
    const saudacao =
      hour < 12 ? "Bom dia!" : hour < 18 ? "Boa tarde!" : "Boa noite!";

    const locationText = session.userLocation?.confirmed
      ? ` Vejo que você está em ${session.userLocation.city}${session.userLocation.state ? `, ${session.userLocation.state}` : ""}.`
      : "";

    const greetingText = session.userName
      ? `${saudacao} Bom te ver de volta, ${session.userName}! Eu sou o Buiu, seu assistente virtual.${locationText}`
      : `${saudacao} Eu sou o Buiu, seu assistente virtual.${locationText}`;

    res.json({
      text: greetingText,
      userName: session.userName,
      userLocation: session.userLocation,
      ...(resolved.issuedToken ? { sessionToken: resolved.issuedToken } : {}),
    });
  } catch {
    res.status(500).json({ error: "Erro ao gerar saudação inicial." });
  }
});

app.post("/api/eli/welcome-next", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    if (!session.userName) {
      res.json({
        text: "Antes de começarmos, como posso chamar você?",
        pendingIntent: "nome" as PendingIntent,
        userName: session.userName,
        userLocation: session.userLocation,
      });
      return;
    }

    if (session.userLocation && !session.userLocation.confirmed) {
      res.json({
        text: buildLocationConfirmationPrompt(session.userLocation),
        pendingIntent: "confirmar_localizacao" as PendingIntent,
        userName: session.userName,
        userLocation: session.userLocation,
      });
      return;
    }

    if (!session.userLocation) {
      res.json({
        text: "Para oferecer informações mais precisas, poderia me dizer de qual cidade e estado você está falando comigo?",
        pendingIntent: "informar_localizacao" as PendingIntent,
        userName: session.userName,
        userLocation: session.userLocation,
      });
      return;
    }

    res.json({
      text: `Em que posso ajudar você hoje, ${session.userName}?`,
      pendingIntent: null as PendingIntent,
      userName: session.userName,
      userLocation: session.userLocation,
    });
  } catch {
    res.status(500).json({ error: "Erro no fluxo de boas-vindas." });
  }
});

app.post("/api/eli/reset-name", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    resolved.session.userName = null;
    await store.set(resolved.session);
    res.json({ userName: null });
  } catch {
    res.status(500).json({ error: "Erro ao redefinir nome." });
  }
});

// ==== COMANDOS NATURAIS POR VOZ OU TEXTO ====
app.post("/api/eli/command", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    const rawInput = sanitizeText(req.body?.command, 1200);
    if (!rawInput) {
      res.status(400).json({ error: "Comando vazio." });
      return;
    }

    const pendingIntent: PendingIntent = req.body?.pendingIntent ?? null;
    const timeZone = getEffectiveTimeZone(session, req.body?.timeZone);
    const freeChatMode = Boolean(req.body?.freeChatMode);
    const helperConnected = Boolean(req.body?.helperConnected);

    const result = await executeEliCommand({
      session,
      rawCommand: rawInput,
      pendingIntent,
      timeZone,
      freeChatMode,
      helperConnected,
    });

    await store.set(session);

    res.json({
      reply: result.reply,
      pendingIntent: result.pendingIntent,
      action: result.action,
      state: serializeClientState(session),
      ...(resolved.issuedToken ? { sessionToken: resolved.issuedToken } : {}),
    });
  } catch (err) {
    const formatted = formatServerAiError(err, "Erro ao processar comando.");
    res.status(formatted.status).json({ error: formatted.message });
  }
});

// ==== TEXT-TO-SPEECH DE BAIXA LATÊNCIA COM GEMINI 3.8 TTS + STREAMING + CACHE ====
const ttsPcmCache = new Map<string, Buffer>();
const TTS_CACHE_MAX = 40;

function saveTtsPcmCache(key: string, pcm: Buffer) {
  if (pcm.length === 0) return;
  if (ttsPcmCache.size >= TTS_CACHE_MAX) {
    const oldest = ttsPcmCache.keys().next().value;
    if (oldest) ttsPcmCache.delete(oldest);
  }
  ttsPcmCache.set(key, pcm);
}

function wrapPcmAsWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const TTS_MODELS = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"] as const;

function isQuotaError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || "");
  return (
    /\b429\b/.test(raw) ||
    /RESOURCE_EXHAUSTED/i.test(raw) ||
    /quota/i.test(raw)
  );
}

app.post("/api/eli/tts-stream", ttsLimiter, async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;

    const text = sanitizeText(req.body?.text, 1500);
    if (!text) {
      res.status(400).json({ error: "Texto para síntese está vazio." });
      return;
    }

    const voiceName = DEFAULT_VOICE_PROFILE.voiceName;
    const style = DEFAULT_VOICE_PROFILE.style;
    const cacheKey = `${voiceName}|${style}|${text}`;

    const cachedPcm = ttsPcmCache.get(cacheKey);
    if (cachedPcm) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-TTS-Cache", "HIT");
      res.send(cachedPcm);
      return;
    }

    const ai = getAiClient();
    let headersSent = false;
    const pcmChunks: Buffer[] = [];
    let lastError: unknown = null;

    for (let i = 0; i < TTS_MODELS.length; i++) {
      const model = TTS_MODELS[i];
      try {
        const responseStream = await ai.models.generateContentStream({
          model,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text,
                  speechMetadata: { style },
                },
              ],
            },
          ],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });

        for await (const chunk of responseStream) {
          const data = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (data) {
            const buf = Buffer.from(data, "base64");
            if (buf.length > 0) {
              if (!headersSent) {
                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader("Cache-Control", "no-store");
                headersSent = true;
              }
              pcmChunks.push(buf);
              res.write(buf);
            }
          }
        }
        lastError = null;
        break;
      } catch (modelErr) {
        lastError = modelErr;
        if (!headersSent && isQuotaError(modelErr) && i < TTS_MODELS.length - 1) {
          continue;
        }
        throw modelErr;
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!headersSent) {
      res.status(502).json({ error: "O modelo TTS não retornou áudio." });
      return;
    }

    saveTtsPcmCache(cacheKey, Buffer.concat(pcmChunks));
    res.end();
  } catch (err) {
    const formatted = formatServerAiError(
      err,
      "Voz Charon temporariamente indisponível."
    );
    if (!res.headersSent) {
      res.status(formatted.status).json({ error: formatted.message });
    } else {
      res.end();
    }
  }
});

app.post("/api/eli/tts", ttsLimiter, async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;

    const text = sanitizeText(req.body?.text, 1500);
    if (!text) {
      res.status(400).json({ error: "Texto para síntese está vazio." });
      return;
    }

    const voiceName = DEFAULT_VOICE_PROFILE.voiceName;
    const style = DEFAULT_VOICE_PROFILE.style;
    const cacheKey = `${voiceName}|${style}|${text}`;

    const cachedPcm = ttsPcmCache.get(cacheKey);
    if (cachedPcm) {
      res.json({
        audioBase64: wrapPcmAsWav(cachedPcm).toString("base64"),
        mimeType: "audio/wav",
        cached: true,
      });
      return;
    }

    const ai = getAiClient();
    let base64Audio: string | undefined;

    for (let i = 0; i < TTS_MODELS.length; i++) {
      const model = TTS_MODELS[i];
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text,
                  speechMetadata: { style },
                },
              ],
            },
          ],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });
        base64Audio =
          response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) break;
      } catch (modelErr) {
        if (isQuotaError(modelErr) && i < TTS_MODELS.length - 1) {
          continue;
        }
        throw modelErr;
      }
    }

    if (!base64Audio) {
      res.status(502).json({ error: "O modelo TTS não retornou áudio." });
      return;
    }

    const wavBuf = Buffer.from(base64Audio, "base64");
    if (
      wavBuf.length > 44 &&
      wavBuf.subarray(0, 4).toString("ascii") === "RIFF"
    ) {
      saveTtsPcmCache(cacheKey, wavBuf.subarray(44));
    }

    res.json({
      audioBase64: base64Audio,
      mimeType: "audio/wav",
    });
  } catch (err) {
    const formatted = formatServerAiError(
      err,
      "Voz Charon temporariamente indisponível."
    );
    res.status(formatted.status).json({ error: formatted.message });
  }
});

// ==== PERFIL VOCAL POR SESSÃO ====
app.post("/api/eli/analyze-voice", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;

    const audioBase64 =
      typeof req.body?.audioBase64 === "string" ? req.body.audioBase64 : "";
    const mimeType =
      typeof req.body?.mimeType === "string" ? req.body.mimeType : "audio/mp3";

    if (!audioBase64) {
      res.status(400).json({ error: "Arquivo de áudio não enviado." });
      return;
    }

    const analyzed = await analyzeReferenceVoice(
      audioBase64,
      mimeType,
      resolved.session.voiceProfile
    );
    resolved.session.voiceProfile = analyzed;
    await store.set(resolved.session);

    res.json({ voiceProfile: resolved.session.voiceProfile });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Erro ao analisar o áudio de referência.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/eli/voice-profile", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    session.voiceProfile = { ...DEFAULT_VOICE_PROFILE };
    await store.set(session);
    res.json({ voiceProfile: session.voiceProfile });
  } catch {
    res.status(500).json({ error: "Erro ao atualizar perfil de voz." });
  }
});

// ==== MODO PRIVADO POR SESSÃO ====
app.post("/api/eli/private-mode", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    session.privateMode = Boolean(req.body?.enabled);
    await store.set(session);
    const reply = session.privateMode
      ? "Modo privado ativado. Não irei registrar histórico nem anotações."
      : "Modo privado desativado. Voltarei a registrar suas interações.";
    res.json({ privateMode: session.privateMode, reply });
  } catch {
    res.status(500).json({ error: "Erro ao alterar modo privado." });
  }
});

// ==== PLAYLISTS VALIDADAS POR SESSÃO ====
app.post("/api/eli/playlists", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

    if (!(name in session.playlists)) {
      res.status(400).json({ error: "Playlist desconhecida." });
      return;
    }

    if (url !== "" && !isValidHttpUrl(url)) {
      res
        .status(400)
        .json({ error: "Informe uma URL válida iniciando com http:// ou https://." });
      return;
    }

    session.playlists[name] = url;
    await store.set(session);
    res.json({ playlists: session.playlists });
  } catch {
    res.status(500).json({ error: "Erro ao atualizar playlist." });
  }
});

// ==== ANOTAÇÕES ISOLADAS POR SESSÃO ====
app.post("/api/eli/notes", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    if (session.privateMode) {
      res.status(403).json({
        error: "Modo privado ativo: novas anotações estão bloqueadas.",
      });
      return;
    }

    const text = sanitizeText(req.body?.text, 500);
    if (!text) {
      res.status(400).json({ error: "Conteúdo da anotação vazio." });
      return;
    }

    const timeZone = getEffectiveTimeZone(session, req.body?.timeZone);
    const now = new Date();
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: `${formatDateDDMMYYYY(now, timeZone)} ${formatTimeHHMM(now, timeZone)}`,
      text,
    };
    session.notes.push(item);
    await store.set(session);
    res.json({ notes: session.notes, note: item });
  } catch {
    res.status(500).json({ error: "Erro ao salvar anotação." });
  }
});

app.patch("/api/eli/notes/:id", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    if (session.privateMode) {
      res.status(403).json({
        error: "Modo privado ativo: edição de registros bloqueada.",
      });
      return;
    }

    const text = sanitizeText(req.body?.text, 500);
    if (!text) {
      res.status(400).json({ error: "Conteúdo da anotação vazio." });
      return;
    }

    const note = session.notes.find((n) => n.id === req.params.id);
    if (!note) {
      res.status(404).json({ error: "Anotação não encontrada nesta sessão." });
      return;
    }

    note.text = text;
    await store.set(session);
    res.json({ notes: session.notes, note });
  } catch {
    res.status(500).json({ error: "Erro ao editar anotação." });
  }
});

app.delete("/api/eli/notes/:id", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const { session } = resolved;

    const idx = session.notes.findIndex((n) => n.id === req.params.id);
    if (idx !== -1) {
      session.notes.splice(idx, 1);
      await store.set(session);
    }
    res.json({ notes: session.notes });
  } catch {
    res.status(500).json({ error: "Erro ao excluir anotação." });
  }
});

app.get("/api/eli/notes/export", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveOrCreateSession(req, res, store);
    if (!resolved) return;
    const content = resolved.session.notes
      .map((n) => `[${n.timestamp}] ${n.text}`)
      .join("\n");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="notas_eli.txt"');
    res.send(content || "Nenhuma anotação registrada.");
  } catch {
    res.status(500).json({ error: "Erro ao exportar anotações." });
  }
});

// ==== INICIALIZAÇÃO VITE / PRODUÇÃO ====
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (_req: Request, res: Response) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  app.listen(PORT, HOST, () => {
    console.log(
      `BUIU server running on http://${HOST}:${PORT} (storage: ${store.info.provider})`
    );
  });
}

startServer();
