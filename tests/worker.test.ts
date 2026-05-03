import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker, { validate, escapeHtml, renderTelegramMessage } from '../src/index'

const env = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: '12345',
  ALLOWED_ORIGINS: 'https://jhomer192.github.io,http://localhost:4321',
}

describe('validate', () => {
  it('accepts a well-formed payload', () => {
    const r = validate({ name: 'Jack', email: 'a@b.co', message: 'hi' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ name: 'Jack', email: 'a@b.co', message: 'hi' })
  })

  it('trims whitespace', () => {
    const r = validate({ name: '  Jack  ', email: ' a@b.co ', message: '  hi  ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.name).toBe('Jack')
  })

  it('rejects non-object payloads', () => {
    expect(validate(null).ok).toBe(false)
    expect(validate('string').ok).toBe(false)
    expect(validate(42).ok).toBe(false)
  })

  it('rejects empty fields', () => {
    expect(validate({ name: '', email: 'a@b.co', message: 'hi' }).ok).toBe(false)
    expect(validate({ name: 'x', email: '', message: 'hi' }).ok).toBe(false)
    expect(validate({ name: 'x', email: 'a@b.co', message: '' }).ok).toBe(false)
  })

  it('rejects malformed emails', () => {
    expect(validate({ name: 'x', email: 'not-an-email', message: 'hi' }).ok).toBe(false)
    expect(validate({ name: 'x', email: 'a@b', message: 'hi' }).ok).toBe(false)
    expect(validate({ name: 'x', email: '@b.co', message: 'hi' }).ok).toBe(false)
  })

  it('rejects oversized fields', () => {
    expect(validate({ name: 'x'.repeat(201), email: 'a@b.co', message: 'hi' }).ok).toBe(false)
    expect(validate({ name: 'x', email: 'a@b.co', message: 'x'.repeat(4001) }).ok).toBe(false)
  })
})

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('does not escape quotes (HTML mode tolerates them in text)', () => {
    expect(escapeHtml(`"quoted" 'single'`)).toBe(`"quoted" 'single'`)
  })
})

describe('renderTelegramMessage', () => {
  it('produces a Telegram-safe HTML message', () => {
    const out = renderTelegramMessage({
      name: 'Jack',
      email: 'jack@example.com',
      message: 'hello world',
      origin: 'https://jhomer192.github.io',
    })
    expect(out).toContain('📬')
    expect(out).toContain('<b>From:</b> Jack')
    expect(out).toContain('jack@example.com')
    expect(out).toContain('hello world')
    expect(out).toContain('https://jhomer192.github.io')
  })

  it('escapes user-supplied HTML', () => {
    const out = renderTelegramMessage({
      name: '<script>alert(1)</script>',
      email: 'a@b.co',
      message: 'evil & stuff < >',
      origin: '',
    })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('evil &amp; stuff &lt; &gt;')
  })

  it('truncates messages over the Telegram cap', () => {
    const giant = 'x'.repeat(5000)
    const out = renderTelegramMessage({
      name: 'Jack',
      email: 'a@b.co',
      message: giant,
      origin: '',
    })
    expect(out.length).toBeLessThanOrEqual(4096)
    // Header + sender info preserved
    expect(out).toContain('<b>From:</b> Jack')
    // Trailing ellipsis indicates truncation
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('worker.fetch', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('GET / returns 200 ok', async () => {
    const res = await worker.fetch(new Request('https://relay.example/'), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('contact-relay ok')
  })

  it('OPTIONS / returns CORS preflight', async () => {
    const res = await worker.fetch(
      new Request('https://relay.example/', {
        method: 'OPTIONS',
        headers: { origin: 'https://jhomer192.github.io' },
      }),
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://jhomer192.github.io')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('CORS reflects only allowed origins; falls back for unknown origin', async () => {
    const res = await worker.fetch(
      new Request('https://relay.example/', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
      env,
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://jhomer192.github.io')
  })

  it('POST with valid body fires Telegram and returns 204', async () => {
    const res = await worker.fetch(
      new Request('https://relay.example/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://jhomer192.github.io' },
        body: JSON.stringify({ name: 'Jack', email: 'jack@example.com', message: 'hi there' }),
      }),
      env,
    )
    expect(res.status).toBe(204)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.chat_id).toBe('12345')
    expect(body.parse_mode).toBe('HTML')
    expect(body.text).toContain('Jack')
    expect(body.text).toContain('hi there')
  })

  it('POST with invalid JSON returns 400', async () => {
    const res = await worker.fetch(
      new Request('https://relay.example/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_json' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('POST with invalid email returns 400 and skips Telegram', async () => {
    const res = await worker.fetch(
      new Request('https://relay.example/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', email: 'bogus', message: 'hi' }),
      }),
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_email' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 502 when Telegram fails', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as typeof fetch
    const res = await worker.fetch(
      new Request('https://relay.example/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', email: 'a@b.co', message: 'hi' }),
      }),
      env,
    )
    expect(res.status).toBe(502)
  })

  it('rejects non-POST/GET/OPTIONS methods', async () => {
    const res = await worker.fetch(
      new Request('https://relay.example/', { method: 'DELETE' }),
      env,
    )
    expect(res.status).toBe(405)
  })
})
