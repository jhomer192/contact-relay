// Tiny Cloudflare Worker that receives contact-form POSTs from
// jhomer192.github.io and pushes a notification to Telegram.
//
// No DB, no email. The Telegram message IS the notification — Jack reads it
// on his phone and replies via the embedded mailto link.
//
// Endpoints:
//   POST /         JSON { name, email, message } → fires Telegram, returns 204
//   OPTIONS /      CORS preflight
//   GET /          200 OK with a stub body (lets us verify deploys + see in browser)

interface Env {
  TELEGRAM_BOT_TOKEN: string  // secret — set via `wrangler secret put`
  TELEGRAM_CHAT_ID: string    // secret — Jack's numeric chat id
  ALLOWED_ORIGINS: string     // comma-separated, e.g. "https://jhomer192.github.io"
}

const MAX_NAME = 200
const MAX_EMAIL = 320          // RFC 5321 cap
const MAX_MESSAGE = 4000       // form has same hard limit
const TELEGRAM_MAX = 4096      // single sendMessage cap

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin') ?? ''
    const allowed = (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const corsOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*'
    const corsHeaders = {
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (request.method === 'GET') {
      return new Response('contact-relay ok', {
        status: 200,
        headers: { 'content-type': 'text/plain', ...corsHeaders },
      })
    }

    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: corsHeaders })
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ error: 'invalid_json' }, 400, corsHeaders)
    }

    const validation = validate(payload)
    if (!validation.ok) {
      return json({ error: validation.error }, 400, corsHeaders)
    }
    const { name, email, message } = validation.value

    // Compose Telegram message. Markdown V2 escaping is a pain; HTML mode is
    // simpler and safer — only `<`, `>`, and `&` need escaping.
    const text = renderTelegramMessage({ name, email, message, origin })

    const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`
    const tgRes = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })

    if (!tgRes.ok) {
      const detail = await tgRes.text().catch(() => '')
      console.error('telegram send failed', tgRes.status, detail)
      return json({ error: 'telegram_send_failed' }, 502, corsHeaders)
    }

    return new Response(null, { status: 204, headers: corsHeaders })
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function validate(
  payload: unknown,
): { ok: true; value: { name: string; email: string; message: string } } | { ok: false; error: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload_not_object' }
  }
  const p = payload as Record<string, unknown>
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const email = typeof p.email === 'string' ? p.email.trim() : ''
  const message = typeof p.message === 'string' ? p.message.trim() : ''

  if (!name || name.length > MAX_NAME) return { ok: false, error: 'invalid_name' }
  if (!email || email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'invalid_email' }
  }
  if (!message || message.length > MAX_MESSAGE) return { ok: false, error: 'invalid_message' }

  return { ok: true, value: { name, email, message } }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  )
}

export function renderTelegramMessage(args: {
  name: string
  email: string
  message: string
  origin: string
}): string {
  const { name, email, message, origin } = args
  const replyHref = `mailto:${email}?subject=${encodeURIComponent('Re: your message')}`

  const header = `📬 <b>New contact form message</b>`
  const meta =
    `<b>From:</b> ${escapeHtml(name)} ` +
    `&lt;<a href="${escapeHtml(replyHref)}">${escapeHtml(email)}</a>&gt;` +
    (origin ? `\n<b>Origin:</b> ${escapeHtml(origin)}` : '')
  const body = `\n\n${escapeHtml(message)}`

  let out = `${header}\n${meta}${body}`
  if (out.length > TELEGRAM_MAX) {
    // Trim the body, not the metadata — we always want sender + email visible.
    const overflow = out.length - TELEGRAM_MAX + 20
    out = `${header}\n${meta}\n\n${escapeHtml(message.slice(0, message.length - overflow))}…`
  }
  return out
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json' },
  })
}
