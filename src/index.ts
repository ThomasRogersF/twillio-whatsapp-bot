// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  BOT_KV: KVNamespace;
  // Twilio credentials (secrets)
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  // Twilio sender number, e.g. "whatsapp:+57xxxxxxxxxx"
  TWILIO_WHATSAPP_FROM: string;
  // Optional
  MAKE_WEBHOOK_URL?: string;
  MARIA_WA_ME_LINK?: string;
  MIN_WEEKLY_HOURS?: string;
}

type ScreeningStep = "INTRO" | "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6";

interface Answers {
  team_role?: "yes" | "no";
  weekly_availability?: "full_time" | "part_time" | "low";
  start_date?: "now" | "soon" | "later";
  setup?: "yes" | "no";
  sop?: "yes" | "no";
  english_level?: "good" | "ok" | "low";
}

interface SessionState {
  step: ScreeningStep;
  answers: Answers;
  startedAt: string;
  lastActivityAt: string;
  completed?: boolean;
}

interface RateLimitRecord {
  timestamps: number[];
}

interface ResultPayload {
  whatsapp_from: string;
  result: "pass" | "fail";
  reason: string;
  answers: Answers;
  completed_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 604_800;   // 7 days
const RATE_LIMIT_WINDOW_MS = 10_000;   // 10 seconds
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_KV_TTL = 60;          // 60 seconds (KV minimum)

const QUESTION_TEXT: Record<ScreeningStep, string> = {
  INTRO: "👋 ¡Hola! Gracias por postularte para ser *Profesor/a de Español* en *SpanishVIP* 🇪🇸✨\n\n🕒 Esto es un *pre-filtro rápido (2 minutos)* para confirmar algunos requisitos básicos.\n\n✅ Para responder, escribe el *número* de la opción (por ejemplo: *1*) o la palabra clave indicada.\n\n💡 _Tip:_ Responde con calma, un mensaje por pregunta 😊\n\n¿List@? Responde:\n1) Empezar 🚀\n2) Salir ❌",
  Q1: "*Q1/6* 🧩\nEn SpanishVIP buscamos un rol de *equipo* (no estilo marketplace como italki/Preply).\n\n¿Buscas un rol fijo y comprometido con el equipo?\n1) ✅ Sí, quiero ser parte del equipo\n2) ❌ No, solo freelance / marketplace",
  Q2: "*Q2/6* 🗓️\n¿Cuántas horas por semana puedes comprometerte de forma constante?\n1) 💪 Tiempo completo (30+ hrs/sem)\n2) 🙂 Medio tiempo (15–29 hrs/sem)\n3) 🥲 Menos de 15 hrs/sem\n\nTambién puedes escribir: FT / PT / LOW",
  Q3: "*Q3/6* ⏱️\n¿Cuándo podrías empezar?\n1) 🚀 Inmediatamente\n2) 📆 En 1–2 semanas\n3) 🗓️ En 1 mes o más\n\nTambién puedes escribir: NOW / 2WEEKS / 1MONTH",
  Q4: "*Q4/6* 💻🎧\n¿Tienes internet estable + un lugar tranquilo para enseñar?\n1) ✅ Sí\n2) ❌ No",
  Q5: "*Q5/6* 📚✨\n¿Estás de acuerdo en seguir el currículum y los SOPs del equipo?\n1) ✅ Sí, claro\n2) ❌ No",
  Q6: "*Q6/6* 🇺🇸🗣️\nPara coordinarnos mejor en el equipo, necesitamos un nivel mínimo de inglés.\n\n¿Cuál es tu nivel de inglés?\n1) ✅ Bueno (puedo conversar con confianza)\n2) 🙂 Me defiendo (puedo comunicarme lo básico)\n3) ❌ No sé mucho",
};

const FAIL_MESSAGES = {
  Q1: "💛 Gracias por tu sinceridad.\nEn este momento estamos buscando *miembros de equipo* con compromiso y disponibilidad constante.\n\n🙏 Te deseamos lo mejor y gracias por postularte.",
  Q2: "💛 ¡Gracias!\nPor ahora necesitamos mínimo *15 horas/semana* de disponibilidad constante.\n\n🙏 Te agradecemos tu tiempo y tu interés en SpanishVIP.",
  Q4: "💛 Gracias por tu respuesta.\nPara poder dar clases con calidad, necesitamos *internet estable* y un *espacio tranquilo*.\n\n🙏 Te agradecemos tu tiempo.",
  Q5: "💛 Gracias por tu sinceridad.\nPara este rol es importante seguir nuestro sistema y procesos.\n\n🙏 Te deseamos lo mejor y gracias por postularte.",
  Q6: "💛 ¡Gracias!\nPor ahora necesitamos al menos un nivel de inglés para comunicarnos en el equipo (aunque sea _“me defiendo”_).\n\n🙏 Te agradecemos tu tiempo y tu interés en SpanishVIP.",
};

const INVALID_INPUT_MESSAGE = "😊 ¡Casi!\nPor favor responde con el *número* de una opción (por ejemplo: *1*) o con la palabra clave.\n\n✨ Si quieres reiniciar, escribe: *RESTART*\n🚀 Para empezar desde cero, escribe: *START*";

// ─── Text Sanitization ────────────────────────────────────────────────────────

// Replaces Unicode characters that can cause Twilio 63013 rendering failures:
//   em dash (U+2014) → hyphen
//   curly single quotes (U+2018/U+2019) → straight apostrophe
//   curly double quotes (U+201C/U+201D) → straight double quote
function sanitize(text: string): string {
  return text
    .replace(/\u2014/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

async function safeKvGet(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch (err) {
    console.error(`KV get failed for key "${key}":`, err);
    return null;
  }
}

async function safeKvPut(
  kv: KVNamespace,
  key: string,
  value: string,
  options?: KVNamespacePutOptions
): Promise<void> {
  try {
    await kv.put(key, value, options);
  } catch (err) {
    console.error(`KV put failed for key "${key}":`, err);
  }
}

async function safeKvDelete(kv: KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch (err) {
    console.error(`KV delete failed for key "${key}":`, err);
  }
}

// ─── Session Helpers ──────────────────────────────────────────────────────────

function createSession(): SessionState {
  const now = new Date().toISOString();
  return { step: "INTRO", answers: {}, startedAt: now, lastActivityAt: now };
}

async function loadSession(
  from: string,
  env: Env
): Promise<SessionState | null> {
  const raw = await safeKvGet(env.BOT_KV, `session:${from}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

async function saveSession(
  from: string,
  session: SessionState,
  env: Env
): Promise<void> {
  session.lastActivityAt = new Date().toISOString();
  await safeKvPut(env.BOT_KV, `session:${from}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

async function checkRateLimit(from: string, env: Env): Promise<boolean> {
  const key = `ratelimit:${from}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const raw = await safeKvGet(env.BOT_KV, key);
  const record: RateLimitRecord = raw
    ? (() => {
      try {
        return JSON.parse(raw) as RateLimitRecord;
      } catch {
        return { timestamps: [] };
      }
    })()
    : { timestamps: [] };

  record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

  if (record.timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }

  record.timestamps.push(now);
  await safeKvPut(env.BOT_KV, key, JSON.stringify(record), {
    expirationTtl: RATE_LIMIT_KV_TTL,
  });
  return true;
}

// ─── TwiML Ack ────────────────────────────────────────────────────────────────

// Returns an empty TwiML <Response/> to acknowledge the webhook immediately.
// All outbound messages are sent via the Twilio REST API (see sendTwilioText
// below) so Twilio does not wait for us to compose a reply.
function twimlAck(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<Response/>', {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ─── Twilio REST API Helpers ──────────────────────────────────────────────────

function twilioBasicAuth(env: Env): string {
  return "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
}

// Sends a plain text WhatsApp message via the Twilio Messages REST API.
// Text is sanitized before sending to avoid 63013 rendering failures.
// Returns true on success, false on failure.
async function sendTwilioText(
  to: string,
  body: string,
  env: Env
): Promise<boolean> {
  const sanitized = sanitize(body);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({
    To: to,
    From: env.TWILIO_WHATSAPP_FROM,
    Body: sanitized,
  });

  console.log(
    `[sendTwilioText] to=${to} from=${env.TWILIO_WHATSAPP_FROM} type=plain`
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: twilioBasicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (res.ok) {
    const data = (await res.json()) as { sid: string };
    console.log(`[sendTwilioText] success MessageSid=${data.sid}`);
    return true;
  } else {
    const text = await res.text().catch(() => "");
    console.error(`[sendTwilioText] error status=${res.status} body=${text}`);
    return false;
  }
}

// ─── Result Webhook ───────────────────────────────────────────────────────────

async function postResultWebhook(
  payload: ResultPayload,
  env: Env
): Promise<void> {
  if (!env.MAKE_WEBHOOK_URL) return;
  try {
    await fetch(env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Result webhook POST failed:", err);
  }
}

// ─── Bot Logic ────────────────────────────────────────────────────────────────

async function passSession(
  from: string,
  session: SessionState,
  env: Env
): Promise<void> {
  session.completed = true;
  const payload: ResultPayload = {
    whatsapp_from: from,
    result: "pass",
    reason: "",
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    saveSession(from, session, env), // Keep session marked as completed
    postResultWebhook(payload, env),
  ]);

  const link = env.MARIA_WA_ME_LINK ?? "https://wa.me/57xxxxxxxxxx";
  const passMsg = `🎉 *¡Excelente! Has pasado el pre-filtro* ✅\n\n🧑💼 Siguiente paso: hablar con una persona del equipo para coordinar tu *primera entrevista*.\n\n👉 Escribe aquí a *Maria Camila* para continuar:\n${link}\n\n💬 _Por favor envía este mensaje cuando le escribas:_\n“Hola Maria, pasé el pre-filtro de SpanishVIP. Mi nombre es ___ y mi correo es ___.”\n\n💛 ¡Gracias y nos vemos pronto!`;

  await sendTwilioText(from, passMsg, env);
}

async function failSession(
  from: string,
  session: SessionState,
  stepKey: keyof typeof FAIL_MESSAGES,
  reason: string,
  env: Env
): Promise<void> {
  session.completed = true;
  const payload: ResultPayload = {
    whatsapp_from: from,
    result: "fail",
    reason,
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    saveSession(from, session, env), // Keep session marked as completed
    postResultWebhook(payload, env),
  ]);

  const failMsg = FAIL_MESSAGES[stepKey];
  await sendTwilioText(from, failMsg, env);
}

// Normalises the input to match known keywords and numeric options.
// Returns a trimmed, uppercase string.
function resolveInput(raw: string): string {
  return raw.trim().toUpperCase();
}

async function handleStep(
  session: SessionState,
  rawInput: string,
  inputSource: "payload" | "buttonText" | "body",
  from: string,
  env: Env
): Promise<void> {
  const stepBefore = session.step;
  const minHours = parseInt(env.MIN_WEEKLY_HOURS ?? "15", 10);
  const input = resolveInput(rawInput);

  console.log(
    `[handleStep] from=${from} step.before=${stepBefore} inputSource=${inputSource} rawInput="${rawInput}"`
  );

  switch (session.step) {
    case "INTRO": {
      if (input === "1" || input === "EMPEZAR" || input === "EMPEZAR 🚀") {
        session.step = "Q1";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q1"], env);
      } else if (input === "2" || input === "SALIR" || input === "SALIR ❌") {
        await safeKvDelete(env.BOT_KV, `session:${from}`);
        await sendTwilioText(from, "Entendido. Si quieres empezar más tarde, simplemente escribe *START*.", env);
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }

    case "Q1": {
      const isYes = ["1", "YES", "SI", "SÍ", "Y"].includes(input);
      const isNo = ["2", "NO", "N"].includes(input);

      if (isYes) {
        session.answers.team_role = "yes";
        session.step = "Q2";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q2"], env);
      } else if (isNo) {
        session.answers.team_role = "no";
        await failSession(from, session, "Q1", "not team role", env);
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }

    case "Q2": {
      const isFT = ["1", "FT", "FULLTIME", "FULL-TIME"].includes(input);
      const isPT = ["2", "PT", "PARTTIME", "PART-TIME"].includes(input);
      const isLow = ["3", "LOW", "<15", "LESS", "MENOS"].includes(input);

      if (isFT) {
        session.answers.weekly_availability = "full_time";
        session.step = "Q3";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q3"], env);
      } else if (isPT) {
        session.answers.weekly_availability = "part_time";
        // If MIN_WEEKLY_HOURS is 30 or more, PT (15-29) fails.
        if (minHours > 29) {
          await failSession(from, session, "Q2", "low", env);
        } else {
          session.step = "Q3";
          await saveSession(from, session, env);
          await sendTwilioText(from, QUESTION_TEXT["Q3"], env);
        }
      } else if (isLow) {
        session.answers.weekly_availability = "low";
        // Threshold check: "low" is < 15. If minHours is 1 or more, "low" fails.
        if (minHours >= 1) {
          await failSession(from, session, "Q2", "low", env);
        } else {
          session.step = "Q3";
          await saveSession(from, session, env);
          await sendTwilioText(from, QUESTION_TEXT["Q3"], env);
        }
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }

    case "Q3": {
      const isNow = ["1", "NOW", "INMEDIATO", "INMEDIATAMENTE"].includes(input);
      const isSoon = ["2", "2WEEKS", "SOON", "PRONTO", "1-2"].includes(input);
      const isLater = ["3", "1MONTH", "LATER", "MAS", "MÁS", "1 MES"].includes(input);

      if (isNow) {
        session.answers.start_date = "now";
        session.step = "Q4";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q4"], env);
      } else if (isSoon) {
        session.answers.start_date = "soon";
        session.step = "Q4";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q4"], env);
      } else if (isLater) {
        session.answers.start_date = "later";
        session.step = "Q4";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q4"], env);
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }

    case "Q4": {
      const isYes = ["1", "YES", "SI", "SÍ"].includes(input);
      const isNo = ["2", "NO"].includes(input);

      if (isYes) {
        session.answers.setup = "yes";
        session.step = "Q5";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q5"], env);
      } else if (isNo) {
        session.answers.setup = "no";
        await failSession(from, session, "Q4", "no stable setup", env);
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }

    case "Q5": {
      const isYes = ["1", "YES", "SI", "SÍ"].includes(input);
      const isNo = ["2", "NO"].includes(input);

      if (isYes) {
        session.answers.sop = "yes";
        session.step = "Q6";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q6"], env);
      } else if (isNo) {
        session.answers.sop = "no";
        await failSession(from, session, "Q5", "not willing to follow SOP", env);
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }

    case "Q6": {
      const isGood = ["1", "GOOD", "BUENO", "B1", "B2", "C1", "C2"].includes(input);
      const isOk = ["2", "DEFENDERME", "ME DEFIENDO", "BASIC", "BASICO", "BÁSICO"].includes(input);
      const isLow = ["3", "POCO", "NO MUCHO", "NO SE", "NO", "NADA"].includes(input);

      if (isGood) {
        session.answers.english_level = "good";
        await passSession(from, session, env);
      } else if (isOk) {
        session.answers.english_level = "ok";
        await passSession(from, session, env);
      } else if (isLow) {
        session.answers.english_level = "low";
        await failSession(from, session, "Q6", "english_low", env);
      } else {
        await sendTwilioText(from, INVALID_INPUT_MESSAGE, env);
      }
      return;
    }
  }
}

// processAndSend runs entirely inside ctx.waitUntil() — the webhook has already
// returned <Response/> before this executes. All user-facing output goes via
// sendTwilioText().
async function processAndSend(
  from: string,
  buttonPayload: string | null,
  buttonText: string | null,
  rawBody: string,
  env: Env
): Promise<void> {
  try {
    // Rate limit
    const allowed = await checkRateLimit(from, env);
    if (!allowed) {
      await sendTwilioText(
        from,
        "Estás enviando mensajes demasiado rápido. Por favor, espera un momento.",
        env
      );
      return;
    }

    // Determine input source for logging and routing.
    // Priority: ButtonPayload > ButtonText > Body
    const inputSource: "payload" | "buttonText" | "body" = buttonPayload
      ? "payload"
      : buttonText
        ? "buttonText"
        : "body";
    const input = (buttonPayload || buttonText || rawBody).trim();
    const upper = input.toUpperCase();

    console.log(
      `[processAndSend] from=${from} inputSource=${inputSource} rawInput="${input}"`
    );

    // START and RESTART both clear the session and begin at INTRO.
    if (upper === "START" || upper === "RESTART") {
      console.log(`[processAndSend] from=${from} command=${upper} — resetting session`);
      await safeKvDelete(env.BOT_KV, `session:${from}`);
      const newSession = createSession();
      await saveSession(from, newSession, env);

      await sendTwilioText(from, QUESTION_TEXT["INTRO"], env);
      return;
    }

    // Load existing session
    const session = await loadSession(from, env);

    if (!session) {
      await sendTwilioText(
        from,
        "👋 ¡Hola! Para comenzar el proceso de pre-filtro para SpanishVIP, por favor escribe *START* 🚀",
        env
      );
      return;
    }

    // If session is already completed, ignore further input unless it's START/RESTART
    if (session.completed) {
      console.log(`[processAndSend] from=${from} session is completed — ignoring input`);
      return;
    }

    await handleStep(session, input, inputSource, from, env);
  } catch (err) {
    console.error("processAndSend error:", err);
    try {
      await sendTwilioText(
        from,
        "Lo sentimos, algo salió mal. Por favor, escribe *RESTART* para empezar de nuevo.",
        env
      );
    } catch {
      // swallow — nothing more we can do
    }
  }
}

// ─── Request Handlers ─────────────────────────────────────────────────────────

async function handleWhatsApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const bodyText = await request.text();
  const params = new URLSearchParams(bodyText);

  const from = params.get("From") ?? "";
  // Twilio button reply params (see Twilio docs — ButtonPayload is preferred)
  const buttonPayload = params.get("ButtonPayload");
  const buttonText = params.get("ButtonText");
  const rawBody = params.get("Body") ?? "";

  if (!from) {
    // No sender — ack and log; we can't send an outbound message without a To
    console.error("Webhook received without From param");
    return twimlAck();
  }

  // Kick off all processing and outbound messaging asynchronously so Twilio
  // receives the HTTP 200 ack immediately without waiting for our logic.
  ctx.waitUntil(processAndSend(from, buttonPayload, buttonText, rawBody, env));

  return twimlAck();
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === "GET" && pathname === "/health") {
    return new Response("ok", { status: 200 });
  }

  if (method === "POST" && pathname === "/whatsapp") {
    return handleWhatsApp(request, env, ctx);
  }

  return new Response("Not Found", { status: 404 });
}

// ─── Worker Export ────────────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("Unhandled error:", err);
      return twimlAck();
    }
  },
};
