Build a Cloudflare Worker (TypeScript) to power a user-initiated WhatsApp screening bot via Twilio WhatsApp Sandbox.

GOAL
- Twilio WhatsApp Sandbox sends inbound messages to our Worker via webhook (HTTP POST).
- Worker parses x-www-form-urlencoded payload (From, To, Body, etc.).
- Bot runs a 5-question screening flow with simple text replies and numeric choices.
- Store per-user session state in Cloudflare KV with TTL 7 days.
- On PASS/FAIL, POST results to MAKE_WEBHOOK_URL (fire-and-forget) and clear session.
- Return TwiML XML response to Twilio on every inbound message to send the user a reply.

TECH
- Cloudflare Workers TypeScript
- KV namespace binding: BOT_KV
- Env vars:
  - MAKE_WEBHOOK_URL (optional; if unset just skip)
  - MARIA_WHATSAPP_HANDOFF_TEXT (text to display on PASS, e.g. “Thanks! Please message Maria at +1... or book: ...”)
  - MIN_WEEKLY_HOURS (default 15)

ENDPOINTS
- POST /whatsapp (Twilio webhook hits here)
- GET /health returns “ok”

INBOUND FORMAT
Twilio will send application/x-www-form-urlencoded with keys like:
- From: "whatsapp:+15551234567"
- To: "whatsapp:+14155238886"
- Body: "START"
We must parse it using await request.text() + URLSearchParams.

BOT FLOW (text-based with numbered choices)
- If no session exists:
  - If Body contains "START" (case-insensitive), begin screening.
  - Else reply: "Hi! Reply START to begin the 2-minute screening."
Questions (store answers):
Q1) Are you looking for a TEAM role (not marketplace/freelance italki/Preply)?
  1) Yes
  2) No  -> FAIL
Q2) Weekly availability?
  1) Full-time (30+ hrs/wk)
  2) Part-time (15–29 hrs/wk)
  3) Less than 15 hrs/wk -> FAIL (or below MIN_WEEKLY_HOURS)
Q3) When can you start?
  1) Immediately
  2) 1–2 weeks
  3) 1 month+
Q4) Do you have stable internet + quiet teaching setup?
  1) Yes
  2) No -> FAIL
Q5) Willing to follow curriculum/SOPs?
  1) Yes
  2) No -> FAIL

PASS MESSAGE
- "✅ You passed screening. Next step: {MARIA_WHATSAPP_HANDOFF_TEXT}"

FAIL MESSAGE
- "Thanks for your time — not the best fit right now. Reason: <reason>"

RESULT WEBHOOK
On completion (pass/fail), send POST to MAKE_WEBHOOK_URL:
{
  applicant_token: "", (blank for sandbox)
  whatsapp_from: "whatsapp:+1...",
  result: "pass"|"fail",
  reason: "",
  answers: {...},
  completed_at: ISO
}
If MAKE_WEBHOOK_URL is missing, skip.

OTHER REQUIREMENTS
- Always respond 200 with TwiML content-type "text/xml".
- Add /restart: if Body is "RESTART" reset session.
- Rate limit: 5 messages per 10 seconds per user (store a short sliding window in KV).
- Robust error handling: never throw; on error, respond with generic help message.

DELIVERABLES
- src/index.ts Worker
- wrangler.toml example with KV binding and vars
- package.json + tsconfig.json for Wrangler
- Deployment commands (wrangler login, kv create, secret put, deploy)
