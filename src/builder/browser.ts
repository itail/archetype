/**
 * BrowserHarness — live-browser primitive for coder personas that
 * build browser-rendered artifacts (games, forms, dashboards). Lets the
 * model actually see the page and interact with it instead of inferring
 * behavior from code alone.
 *
 * Contract:
 * — `open` navigate to a path under the allowed origin
 * — `click` click by visible text (primary) or CSS selector (fallback)
 * — `type` type literal text into the focused element
 * — `key`  press one named key (ArrowUp, Enter, etc) once
 * — `screenshot` capture a PNG (bytes + base64)
 * — `getConsoleEntries` read captured console output
 * — `close` terminate the browser + clean up the profile dir
 *
 * What belongs here (archetype layer):
 * — `BrowserHarness` interface + all result types
 * — `PlaywrightBrowser` default impl using playwright chromium
 * — Origin-allowlist enforcement (route blocker + navigation check)
 * — Ephemeral profile directory lifecycle
 *
 * What does NOT belong here:
 * — Evidence-file persistence. `screenshot()` returns bytes and base64;
 *   the host app decides whether to write a PNG file, upload, attach
 *   the bytes to the next prompt turn, etc.
 * — Tool-action wiring (archetype/builder/actions.ts owns the action
 *   contracts; the executor dispatch maps them to BrowserHarness calls).
 *
 * Node-only. Playwright is a runtime dep of the *host app* (not
 * archetype) — we dynamically import `playwright` inside the default
 * impl, so archetype ships without pulling chromium binaries.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ─── Result types ────────────────────────────────────────────────────

export interface BrowserOpenResult {
  ok: boolean
  url: string
  title: string
}

export interface BrowserScreenshotResult {
  ok: boolean
  /** Raw PNG bytes. Use these when you want to persist the file yourself. */
  bytes: Buffer
  /** Base64-encoded PNG. Pass as `ChatAttachment.data` for multimodal prompts. */
  base64: string
}

export interface BrowserClickResult {
  ok: boolean
  matched: 'text' | 'selector' | 'none'
  detail: string
}

export interface BrowserTypeResult {
  ok: boolean
  detail: string
}

export interface BrowserKeyResult {
  ok: boolean
  detail: string
}

export interface BrowserConsoleEntry {
  type: string
  text: string
  location: {
    url?: string
    lineNumber?: number
    columnNumber?: number
  }
}

// ─── Interface ───────────────────────────────────────────────────────

export interface BrowserHarness {
  open(relativePath?: string): Promise<BrowserOpenResult>
  screenshot(label?: string): Promise<BrowserScreenshotResult>
  click(input: { text?: string; selector?: string }): Promise<BrowserClickResult>
  type(input: { text: string; selector?: string }): Promise<BrowserTypeResult>
  key(input: { key: string; selector?: string }): Promise<BrowserKeyResult>
  getConsoleEntries(): BrowserConsoleEntry[]
  close(): Promise<void>
}

// ─── Minimal playwright-shaped interfaces ────────────────────────────
// Keeps archetype free of a playwright devDep at install time. Host app
// installs playwright — the runtime dynamic import wires up the real
// types.

interface PlaywrightPage {
  url(): string
  title(): Promise<string>
  goto(url: string, opts?: { waitUntil?: string }): Promise<{ ok(): boolean } | null>
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>
  getByText(text: string, opts?: { exact?: boolean }): { first(): PlaywrightLocator }
  click(selector: string, opts?: { timeout?: number }): Promise<void>
  focus(selector: string, opts?: { timeout?: number }): Promise<void>
  keyboard: {
    type(text: string): Promise<void>
    press(key: string): Promise<void>
  }
  on(event: 'console', fn: (msg: PlaywrightConsoleMessage) => void): void
}

interface PlaywrightLocator {
  click(opts?: { timeout?: number }): Promise<void>
}

interface PlaywrightContext {
  close(): Promise<void>
  pages(): PlaywrightPage[]
  newPage(): Promise<PlaywrightPage>
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
}

interface PlaywrightRoute {
  request(): { url(): string }
  continue(): Promise<void>
  abort(): Promise<void>
}

interface PlaywrightConsoleMessage {
  type(): string
  text(): string
  location(): { url?: string; lineNumber?: number; columnNumber?: number }
}

interface PlaywrightChromium {
  launchPersistentContext(
    userDataDir: string,
    options: {
      headless?: boolean
      viewport?: { width: number; height: number }
      acceptDownloads?: boolean
    },
  ): Promise<PlaywrightContext>
}

// ─── Default impl ────────────────────────────────────────────────────

export interface PlaywrightBrowserOptions {
  /** Origin the browser is restricted to (e.g. `http://127.0.0.1:4317`). */
  allowedOrigin: string
  /** Viewport width in pixels. Default 1440. */
  viewportWidth?: number
  /** Viewport height in pixels. Default 960. */
  viewportHeight?: number
  /**
   * User-data / profile directory. If omitted, a temp directory is
   * created and cleaned up on `close()`.
   */
  profileDir?: string
}

export class PlaywrightBrowser implements BrowserHarness {
  private readonly allowedOrigin: string
  private readonly profileDir: string
  private readonly ownsProfileDir: boolean
  private readonly viewport: { width: number; height: number }
  private context: PlaywrightContext | null = null
  private page: PlaywrightPage | null = null
  private readonly consoleEntries: BrowserConsoleEntry[] = []

  constructor(options: PlaywrightBrowserOptions) {
    this.allowedOrigin = normalizeOrigin(options.allowedOrigin)
    if (options.profileDir) {
      this.profileDir = path.resolve(options.profileDir)
      this.ownsProfileDir = false
      fs.mkdirSync(this.profileDir, { recursive: true })
    } else {
      this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archetype-browser-profile-'))
      this.ownsProfileDir = true
    }
    this.viewport = {
      width: options.viewportWidth ?? 1440,
      height: options.viewportHeight ?? 960,
    }
  }

  async open(relativePath: string = '/'): Promise<BrowserOpenResult> {
    const page = await this.ensurePage()
    const targetUrl = new URL(relativePath, `${this.allowedOrigin}/`).toString()
    enforceAllowedUrl(targetUrl, this.allowedOrigin)

    this.consoleEntries.length = 0
    const response = await page.goto(targetUrl, { waitUntil: 'networkidle' })
    if (!response) {
      throw new Error(`Browser failed to load ${targetUrl}`)
    }
    return {
      ok: response.ok(),
      url: page.url(),
      title: await page.title(),
    }
  }

  async screenshot(_label: string = 'page'): Promise<BrowserScreenshotResult> {
    const page = await this.ensurePage()
    const bytes = await page.screenshot({ fullPage: true })
    return { ok: true, bytes, base64: bytes.toString('base64') }
  }

  /**
   * Type literal text into the focused element (or a specified selector).
   * Mirrors playwright's `keyboard.type` — sends key-by-key so form/game
   * handlers fire. If `selector` is given, focus it first.
   */
  async type(input: { text: string; selector?: string }): Promise<BrowserTypeResult> {
    const page = await this.ensurePage()
    if (!input.text || input.text.length === 0) {
      return { ok: false, detail: 'browserType requires a non-empty `text` param.' }
    }
    try {
      if (input.selector && input.selector.trim().length > 0) {
        await page.focus(input.selector, { timeout: 3000 })
      }
      await page.keyboard.type(input.text)
      const scope = input.selector ? ` into "${input.selector}"` : ''
      return { ok: true, detail: `typed ${JSON.stringify(input.text)}${scope}` }
    } catch (err) {
      return { ok: false, detail: firstLineOf(err) }
    }
  }

  /**
   * Press a single named key (ArrowUp, Enter, Escape, Tab, Space, a-z,
   * 0-9, etc). Mirrors playwright's `keyboard.press` — one keydown +
   * keyup so game handlers fire once.
   */
  async key(input: { key: string; selector?: string }): Promise<BrowserKeyResult> {
    const page = await this.ensurePage()
    if (!input.key || input.key.length === 0) {
      return { ok: false, detail: 'browserKey requires a non-empty `key` param.' }
    }
    try {
      if (input.selector && input.selector.trim().length > 0) {
        await page.focus(input.selector, { timeout: 3000 })
      }
      await page.keyboard.press(input.key)
      const scope = input.selector ? ` (focus "${input.selector}")` : ''
      return { ok: true, detail: `pressed ${JSON.stringify(input.key)}${scope}` }
    } catch (err) {
      return { ok: false, detail: firstLineOf(err) }
    }
  }

  /**
   * Click an element. Primary: visible text match (matches how the model
   * thinks about UI). Fallback: CSS selector. Returns the match mode
   * + detail so the executor can render a truthful outcome note.
   */
  async click(input: { text?: string; selector?: string }): Promise<BrowserClickResult> {
    const page = await this.ensurePage()
    if (input.text && input.text.trim().length > 0) {
      const locator = page.getByText(input.text, { exact: false }).first()
      try {
        await locator.click({ timeout: 3000 })
        return { ok: true, matched: 'text', detail: `clicked element with text matching "${input.text}"` }
      } catch (err) {
        if (!input.selector) {
          return { ok: false, matched: 'none', detail: `no element with visible text "${input.text}" within 3s — ${firstLineOf(err)}` }
        }
        // text miss; fall through to selector fallback
      }
    }
    if (input.selector && input.selector.trim().length > 0) {
      try {
        await page.click(input.selector, { timeout: 3000 })
        return { ok: true, matched: 'selector', detail: `clicked element matching selector "${input.selector}"` }
      } catch (err) {
        return { ok: false, matched: 'none', detail: `selector "${input.selector}" did not match a clickable element within 3s — ${firstLineOf(err)}` }
      }
    }
    return { ok: false, matched: 'none', detail: 'browserClick requires at least one of `text` or `selector` to be provided' }
  }

  getConsoleEntries(): BrowserConsoleEntry[] {
    return [...this.consoleEntries]
  }

  async close(): Promise<void> {
    await this.context?.close()
    this.context = null
    this.page = null
    if (this.ownsProfileDir) {
      fs.rmSync(this.profileDir, { recursive: true, force: true })
    }
  }

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page

    const { chromium } = await loadPlaywright()
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      viewport: this.viewport,
      acceptDownloads: false,
    })

    await this.context.route('**/*', async route => {
      const requestUrl = route.request().url()
      if (requestUrl.startsWith(this.allowedOrigin)) {
        await route.continue()
        return
      }
      await route.abort()
    })

    const pages = this.context.pages()
    this.page = pages[0] ?? await this.context.newPage()
    this.page.on('console', (message: PlaywrightConsoleMessage) => {
      this.consoleEntries.push(formatConsoleEntry(message))
    })

    return this.page
  }
}

// ─── Internals ───────────────────────────────────────────────────────

async function loadPlaywright(): Promise<{ chromium: PlaywrightChromium }> {
  try {
    // Dynamic import keeps archetype free of a hard playwright dep. The
    // `as never` cast prevents the TS compiler from requiring playwright
    // type declarations at archetype build time — consumers still get
    // correct types via our locally-declared PlaywrightChromium.
    const mod = await import('playwright' as never)
    return mod as unknown as { chromium: PlaywrightChromium }
  } catch (err) {
    throw new Error(
      `PlaywrightBrowser requires the 'playwright' package installed in the host app. Install with: npm install playwright. Underlying error: ${firstLineOf(err)}`,
    )
  }
}

function formatConsoleEntry(message: PlaywrightConsoleMessage): BrowserConsoleEntry {
  const location = message.location()
  return {
    type: message.type(),
    text: message.text(),
    location: {
      url: location.url,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
    },
  }
}

function normalizeOrigin(origin: string) {
  const url = new URL(origin)
  return `${url.protocol}//${url.host}`
}

function enforceAllowedUrl(candidate: string, allowedOrigin: string) {
  const url = new URL(candidate)
  const normalized = `${url.protocol}//${url.host}`
  if (normalized !== allowedOrigin) {
    throw new Error(`Browser navigation blocked outside allowed origin: ${candidate}`)
  }
}

function firstLineOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]
}
