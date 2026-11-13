import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import YAML from 'yaml'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const VERSION = '0.4.1'
const AUTO_GROUP = 'DSH-AUTO'
const SELECT_GROUP = 'DSH'
const RESERVED_NAMES = new Set([AUTO_GROUP, SELECT_GROUP])
const MAX_SUBSCRIPTION_BYTES = 10 * 1024 * 1024
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204'
const DEFAULT_BYPASS_HOSTS = [
  'dsh.r2049.cn', '*.r2049.cn', '*.ts.net', '*.local', '*.lan',
  'deepseek.com', '*.deepseek.com', 'deepseek.ai', '*.deepseek.ai', 'deepseek-ai.github.io'
]
const MODEL_HOSTS = [
  'api.deepseek.com', 'api.anthropic.com', 'api.openai.com', 'chatgpt.com',
  'generativelanguage.googleapis.com', 'openrouter.ai', 'api.groq.com',
  'api.mistral.ai', 'api.x.ai', 'api.siliconflow.cn', 'api.moonshot.cn',
  'dashscope.aliyuncs.com', 'open.bigmodel.cn', 'api.minimax.chat'
]

const CORE_PACKAGES = {
  'win32-x64': 'mihomo-windows-amd64',
  'win32-arm64': 'mihomo-windows-arm64',
  'linux-x64': 'mihomo-linux-amd64',
  'linux-arm64': 'mihomo-linux-arm64',
  'darwin-x64': 'mihomo-darwin-amd64',
  'darwin-arm64': 'mihomo-darwin-arm64'
}

export const name = '@ghfight/dsh-llm-proxy'
export const inject = ['tools', 'webServer']

export const Config = z.object({
  autoStart: z.boolean().default(true),
  subscriptionUrl: z.string().default(''),
  corePath: z.string().default(''),
  testUrl: z.string().default(DEFAULT_TEST_URL),
  testInterval: z.number().step(1).min(30).max(3600).default(300),
  mixedPort: z.number().step(1).min(0).max(65535).default(0),
  dataDir: z.string().default(''),
  downloadCore: z.boolean().default(true),
  proxyScope: z.string().default('all'),
  bypassHosts: z.string().default('')
})

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    autoStart: input.autoStart !== false,
    subscriptionUrl: typeof input.subscriptionUrl === 'string' ? input.subscriptionUrl.trim() : '',
    corePath: typeof input.corePath === 'string' ? input.corePath.trim() : '',
    testUrl: typeof input.testUrl === 'string' && input.testUrl.trim() ? input.testUrl.trim() : DEFAULT_TEST_URL,
    testInterval: Number.isFinite(Number(input.testInterval)) ? Math.max(30, Math.min(3600, Math.trunc(Number(input.testInterval)))) : 300,
    mixedPort: Number.isFinite(Number(input.mixedPort)) ? Math.max(0, Math.min(65535, Math.trunc(Number(input.mixedPort)))) : 0,
    dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : '',
    downloadCore: input.downloadCore !== false,
    proxyScope: input.proxyScope === 'models' ? 'models' : 'all',
    bypassHosts: typeof input.bypassHosts === 'string' ? input.bypassHosts : ''
  }
}

function emptyState() {
  return {
    version: 1,
    enabled: true,
    proxyScope: 'all',
    bypassHosts: DEFAULT_BYPASS_HOSTS.slice(),
    subscription: null,
    ports: { mixed: 0, controller: 0 },
    secret: '',
    corePath: '',
    selected: AUTO_GROUP,
    mode: 'auto',
    lastError: ''
  }
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function tail(text, limit) {
  const value = String(text || '').replace(/\s+$/g, '')
  if (value.length <= limit) return value
  return value.slice(value.length - limit)
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const reason = signal.reason
    throw reason instanceof Error ? reason : new Error('操作已取消')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isDirectHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::' || host === '0.0.0.0') return true
  if (host.endsWith('.local') || host.endsWith('.lan')) return true
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false
  const octets = parts.map(Number)
  if (octets.some((value) => value > 255)) return false
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

function normalizeHostPattern(value) {
  let host = String(value || '').trim().toLowerCase()
  if (!host || host.startsWith('#')) return ''
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  if (host.startsWith('.')) host = '*.' + host.slice(1)
  if (host === '*') return '*'
  return host.replace(/^\[|\]$/g, '')
}

function normalizeBypassList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/)
  const seen = new Set()
  const out = []
  for (const item of list) {
    const host = normalizeHostPattern(item)
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push(host)
    if (out.length >= 200) break
  }
  return out
}

function hostMatchesPattern(hostname, pattern) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  const rule = normalizeHostPattern(pattern)
  if (!rule) return false
  if (rule === '*') return true
  if (rule.startsWith('*.')) {
    const base = rule.slice(2)
    return host === base || host.endsWith('.' + base)
  }
  return host === rule
}

function isModelHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return MODEL_HOSTS.some((item) => host === item || host.endsWith('.' + item))
}

function binaryName() {
  return process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
}

function corePackageName() {
  return CORE_PACKAGES[process.platform + '-' + process.arch] || ''
}

function displaySource(source) {
  if (/^https?:\/\//i.test(source)) {
    try {
      return new URL(source).host
    } catch {
      return 'subscription'
    }
  }
  try {
    return path.basename(source.startsWith('file://') ? fileURLToPath(source) : source)
  } catch {
    return 'local-file'
  }
}

function isHttpSource(source) {
  return /^https?:\/\//i.test(source)
}

function readCString(buffer, start, length) {
  let end = start
  const limit = start + length
  while (end < limit && buffer[end] !== 0) end += 1
  return buffer.subarray(start, end).toString('utf8')
}

function extractTarEntry(tarball, wantedName) {
  const archive = zlib.gunzipSync(tarball)
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    let allZero = true
    for (const byte of header) {
      if (byte !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break
    const name = readCString(header, 0, 100)
    const prefix = readCString(header, 345, 155)
    const fullName = prefix ? prefix + '/' + name : name
    const sizeText = readCString(header, 124, 12).trim()
    const size = sizeText ? parseInt(sizeText, 8) : 0
    const type = String.fromCharCode(header[156] || 48)
    const dataStart = offset + 512
    const normalized = fullName.replace(/\\/g, '/')
    if ((type === '0' || type === '\0') && normalized.endsWith('/' + wantedName)) {
      return archive.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  throw new Error('下载的核心压缩包中未找到 ' + wantedName)
}

function parseSubscription(text) {
  let doc
  try {
    doc = YAML.parse(text)
  } catch (error) {
    const compact = String(text || '').replace(/\s+/g, '')
    if (compact.length > 0 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
      try {
        doc = YAML.parse(Buffer.from(compact, 'base64').toString('utf8'))
      } catch {
        throw new Error('订阅不是有效的 Clash YAML: ' + messageOf(error))
      }
    } else {
      throw new Error('订阅不是有效的 Clash YAML: ' + messageOf(error))
    }
  }
  let rows
  if (Array.isArray(doc)) rows = doc
  else if (doc && Array.isArray(doc.proxies)) rows = doc.proxies
  else if (doc && doc['proxy-providers']) throw new Error('该订阅只包含 proxy-providers，没有内联 proxies；请换用返回完整 Clash 配置的订阅链接')
  else throw new Error('订阅中没有 proxies 列表；请确认链接返回的是 Clash / Mihomo 配置')
  const seen = new Set()
  const proxies = []
  let skipped = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      skipped += 1
      continue
    }
    const type = typeof row.type === 'string' ? row.type.trim() : ''
    const server = typeof row.server === 'string' ? row.server.trim() : ''
    const port = Number(row.port)
    let proxyName = typeof row.name === 'string' ? row.name.trim() : ''
    if (!type || !server || !Number.isInteger(port) || port < 1 || port > 65535 || !proxyName) {
      skipped += 1
      continue
    }
    if (RESERVED_NAMES.has(proxyName)) proxyName = proxyName + ' (node)'
    let base = proxyName
    let suffix = 2
    while (seen.has(proxyName)) {
      proxyName = base + ' (' + suffix + ')'
      suffix += 1
    }
    seen.add(proxyName)
    proxies.push({ ...row, name: proxyName, type, server, port })
  }
  return { proxies, skipped, doc }
}

function historyDelay(entry) {
  if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) return 0
  const last = entry.history[entry.history.length - 1]
  return Number(last && last.delay) || 0
}

function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, properties }
}

function stringField(description) {
  return { type: 'string', required: true, description }
}

function numberField(description) {
  return { type: 'number', required: true, description }
}

function booleanField(description) {
  return { type: 'boolean', required: true, description }
}

const nodeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: stringField('节点名称'),
    type: stringField('协议类型'),
    delay: numberField('最近一次延迟（毫秒，0 表示未知）'),
    selected: booleanField('当前是否被手动选中')
  }
}

const summaryProperties = {
  running: booleanField('核心是否正在运行'),
  subscription: stringField('订阅显示名'),
  subscriptionHost: stringField('订阅来源主机或文件名'),
  nodeCount: numberField('节点数量'),
  mode: stringField('auto 或 manual'),
  selected: stringField('当前选中的节点或 DSH-AUTO'),
  mixedPort: numberField('本机混合代理端口'),
  coreVersion: stringField('Mihomo 版本'),
  message: stringField('人类可读的结果摘要')
}

function textBlock(value) {
  return [{ type: 'text', text: String(value == null ? '' : value) }]
}

function summaryText(args, value) {
  return textBlock(value && value.message ? value.message : '操作完成')
}

class ClashProxyRuntime {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    this.dataDir = config.dataDir || path.join(this.home, 'clash-proxy')
    this.stateFile = path.join(this.dataDir, 'state.json')
    this.configPath = path.join(this.dataDir, 'config.yaml')
    this.proxiesFile = path.join(this.dataDir, 'proxies.json')
    this.subscriptionFile = path.join(this.dataDir, 'subscription.yaml')
    this.state = emptyState()
    this.proxies = []
    this.child = null
    this.ports = { mixed: 0, controller: 0 }
    this.secret = ''
    this.active = false
    this.dispatcherInstalled = false
    this.previousDispatcher = null
    this.agent = null
    this.directAgent = null
    this.undici = null
    this.proxyAgent = null
    this.proxyAgentPort = 0
    this.nativeFetch = globalThis.fetch
    this.wrappedFetch = null
    this.previousFetch = null
    this.ready = null
    this.coreVersion = ''
    this.lastError = ''
    this.stderrTail = []
    this.lock = Promise.resolve()
  }

  log(level, message) {
    const logger = this.ctx && this.ctx.logger
    if (!logger) return
    const fn = logger[level] || logger.info
    if (typeof fn === 'function') {
      try {
        fn.call(logger, '[dsh-llm-proxy] ' + message)
      } catch {
        // logging must never break the proxy
      }
    }
  }

  runExclusive(fn) {
    const next = this.lock.then(fn, fn)
    this.lock = next.catch(() => {})
    return next
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      const base = emptyState()
      this.state = {
        ...base,
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        ports: {
          mixed: Number(parsed && parsed.ports && parsed.ports.mixed) || 0,
          controller: Number(parsed && parsed.ports && parsed.ports.controller) || 0
        },
        subscription: parsed && parsed.subscription && typeof parsed.subscription === 'object' ? parsed.subscription : null,
        proxyScope: parsed && (parsed.proxyScope === 'all' || parsed.proxyScope === 'models')
          ? parsed.proxyScope
          : (this.config.proxyScope === 'models' ? 'models' : 'all'),
        bypassHosts: parsed && Array.isArray(parsed.bypassHosts)
          ? normalizeBypassList(parsed.bypassHosts)
          : normalizeBypassList(this.config.bypassHosts || DEFAULT_BYPASS_HOSTS)
      }
    } catch {
      this.state = emptyState()
    }
    if (!this.state.secret) this.state.secret = randomBytes(24).toString('hex')
    this.secret = this.state.secret
    this.ports = { ...this.state.ports }
    this.coreVersion = ''
    this.lastError = this.state.lastError || ''
  }

  async saveState() {
    await fs.mkdir(this.dataDir, { recursive: true })
    this.state.ports = { ...this.ports }
    this.state.secret = this.secret || this.state.secret
    this.state.lastError = this.lastError || ''
    const tmp = this.stateFile + '.tmp'
    const body = JSON.stringify(this.state, null, 2)
    try {
      await fs.writeFile(tmp, body, { mode: 0o600 })
      await fs.rename(tmp, this.stateFile)
    } catch {
      await fs.writeFile(this.stateFile, body, { mode: 0o600 })
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  async loadProxies() {
    try {
      const raw = await fs.readFile(this.proxiesFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.proxies = parsed
        return
      }
    } catch {
      // fall back to the saved subscription
    }
    try {
      const text = await fs.readFile(this.subscriptionFile, 'utf8')
      const parsed = parseSubscription(text)
      this.proxies = parsed.proxies
    } catch {
      throw new Error('没有可用的节点配置，请先调用 clash_subscribe 导入订阅')
    }
    if (this.proxies.length === 0) throw new Error('没有可用的节点配置，请重新导入订阅')
  }

  async persistSubscription(text) {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.writeFile(this.subscriptionFile, text, { mode: 0o600 })
    await fs.writeFile(this.proxiesFile, JSON.stringify(this.proxies, null, 2), { mode: 0o600 })
    await fs.chmod(this.subscriptionFile, 0o600).catch(() => {})
    await fs.chmod(this.proxiesFile, 0o600).catch(() => {})
  }

  async readSource(source, signal) {
    throwIfAborted(signal)
    if (isHttpSource(source)) {
      return { text: await this.fetchSubscription(source, signal), sourceType: 'url' }
    }
    let file = source
    if (source.startsWith('file://')) file = fileURLToPath(source)
    try {
      const stat = await fs.stat(file)
      if (stat.size > MAX_SUBSCRIPTION_BYTES) throw new Error('订阅文件过大')
      const text = await fs.readFile(file, 'utf8')
      return { text, sourceType: 'file' }
    } catch (error) {
      throw new Error('读取本地订阅失败: ' + messageOf(error))
    }
  }

  async getUndici() {
    if (this.undici) return this.undici
    try {
      this.undici = await import('undici')
    } catch (error) {
      this.log('warn', 'undici 不可用: ' + messageOf(error))
      this.undici = null
    }
    return this.undici
  }

  async getDirectAgent() {
    if (this.directAgent) return this.directAgent
    const undici = await this.getUndici()
    if (!undici) return null
    this.directAgent = new undici.Agent({ connections: 8 })
    return this.directAgent
  }

  async getProxyAgent() {
    const undici = await this.getUndici()
    if (!undici || !this.ports.mixed) return null
    if (this.proxyAgent && this.proxyAgentPort === this.ports.mixed) return this.proxyAgent
    await this.closeProxyAgent()
    this.proxyAgent = new undici.ProxyAgent({ uri: 'http://127.0.0.1:' + this.ports.mixed, connections: 64 })
    this.proxyAgentPort = this.ports.mixed
    return this.proxyAgent
  }

  async closeProxyAgent() {
    const agent = this.proxyAgent
    this.proxyAgent = null
    this.proxyAgentPort = 0
    if (!agent) return
    try {
      if (typeof agent.close === 'function') await agent.close()
    } catch {
      // ignore shutdown races
    }
  }

  async request(url, init, dispatcher) {
    const undici = await this.getUndici()
    const options = { ...(init || {}) }
    if (dispatcher && options.dispatcher === undefined) options.dispatcher = dispatcher
    if (undici && typeof undici.fetch === 'function') return await undici.fetch(url, options)
    return await this.nativeFetch(url, options)
  }

  async fetchText(url, headers, signal, dispatcher) {
    const timeout = AbortSignal.timeout(30000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await this.request(url, {
      method: 'GET',
      redirect: 'follow',
      headers,
      signal: combined,
      ...(dispatcher ? { dispatcher } : {})
    })
    if (!response.ok) throw new Error('订阅地址返回 HTTP ' + response.status)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_SUBSCRIPTION_BYTES) throw new Error('订阅内容超过 10MB 限制')
    const text = await response.text()
    if (text.length > MAX_SUBSCRIPTION_BYTES) throw new Error('订阅内容超过 10MB 限制')
    return text
  }

  async fetchSubscription(url, signal) {
    const headers = {
      'user-agent': 'clash.meta/1.19.34',
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br'
    }
    const direct = await this.getDirectAgent()
    try {
      return await this.fetchText(url, headers, signal, direct)
    } catch (firstError) {
      if (this.active) {
        try {
          const proxy = await this.getProxyAgent()
          return await this.fetchText(url, headers, signal, proxy || undefined)
        } catch (secondError) {
          throw new Error('下载订阅失败: ' + messageOf(secondError))
        }
      }
      throw new Error('下载订阅失败: ' + messageOf(firstError))
    }
  }

  async fetchDirect(url, options) {
    const direct = await this.getDirectAgent()
    return await this.request(url, options, direct || undefined)
  }

  async isFileExecutable(file) {
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) return false
      await fs.access(file, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  coreCandidates() {
    const result = []
    if (this.config.corePath) result.push(this.config.corePath)
    if (process.env.DSH_CLASH_CORE) result.push(process.env.DSH_CLASH_CORE)
    if (this.state.corePath) result.push(this.state.corePath)
    result.push(path.join(this.dataDir, 'bin', binaryName()))
    const pkg = corePackageName()
    if (pkg) {
      try {
        const require = createRequire(import.meta.url)
        const entry = require.resolve('@pkgship/' + pkg)
        result.push(path.join(path.dirname(entry), 'bin', binaryName()))
      } catch {
        // package not installed; the downloader handles it
      }
    }
    return [...new Set(result)]
  }

  async resolveCore(allowDownload, signal) {
    throwIfAborted(signal)
    for (const candidate of this.coreCandidates()) {
      if (candidate && (await this.isFileExecutable(candidate))) return candidate
    }
    if (allowDownload && this.config.downloadCore) {
      const installed = await this.installCore(signal)
      return installed.path
    }
    throw new Error('未找到 Mihomo 核心。请调用 clash_install_core 自动下载，或在插件配置 corePath 中指定 mihomo 可执行文件')
  }

  async installCore(signal) {
    throwIfAborted(signal)
    const pkg = corePackageName()
    if (!pkg) throw new Error('当前平台不受支持: ' + process.platform + '-' + process.arch)
    const metaUrl = 'https://registry.npmjs.org/' + encodeURIComponent('@pkgship/' + pkg) + '/latest'
    const metaResponse = await this.fetchDirect(metaUrl, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-llm-proxy/' + VERSION },
      signal
    })
    if (!metaResponse.ok) throw new Error('获取核心版本信息失败: HTTP ' + metaResponse.status)
    const meta = await metaResponse.json()
    const tarballUrl = meta && meta.dist && meta.dist.tarball
    const integrity = meta && meta.dist && meta.dist.integrity
    if (!tarballUrl) throw new Error('核心包元数据缺少 tarball 地址')
    this.log('info', 'downloading ' + pkg + '@' + (meta.version || 'latest'))
    const response = await this.fetchDirect(tarballUrl, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-llm-proxy/' + VERSION },
      signal
    })
    if (!response.ok) throw new Error('下载核心失败: HTTP ' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 100 * 1024 * 1024) throw new Error('核心压缩包超过 100MB，已中止')
    if (integrity && integrity.startsWith('sha512-')) {
      const actual = createHash('sha512').update(bytes).digest('base64')
      if (actual !== integrity.slice('sha512-'.length)) throw new Error('核心包完整性校验失败')
    }
    const wanted = 'bin/' + binaryName()
    const binary = extractTarEntry(bytes, wanted)
    const dest = path.join(this.dataDir, 'bin', binaryName())
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, binary, { mode: 0o755 })
    await fs.chmod(dest, 0o755).catch(() => {})
    const version = await this.probeCore(dest)
    this.state.corePath = dest
    await this.saveState()
    return { path: dest, version }
  }

  async probeCore(core) {
    try {
      const result = await execFileAsync(core, ['-v'], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 })
      const line = String(result.stdout || '').split(/\r?\n/).find((row) => row.trim().length > 0) || ''
      return line.trim()
    } catch (error) {
      throw new Error('核心无法执行: ' + messageOf(error))
    }
  }

  async freePort() {
    return await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = address && typeof address === 'object' ? address.port : 0
        server.close(() => resolve(port))
      })
    })
  }

  async portFree(port) {
    if (!port) return false
    return await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
  }

  async ensurePorts() {
    const saved = this.state.ports || {}
    if (saved.mixed && saved.controller && (await this.portFree(saved.mixed)) && (await this.portFree(saved.controller))) {
      return { mixed: saved.mixed, controller: saved.controller }
    }
    let mixed = 0
    if (this.config.mixedPort > 0 && (await this.portFree(this.config.mixedPort))) mixed = this.config.mixedPort
    if (!mixed) mixed = await this.freePort()
    let controller = await this.freePort()
    let guard = 0
    while ((controller === mixed || !(await this.portFree(controller))) && guard < 20) {
      controller = await this.freePort()
      guard += 1
    }
    return { mixed, controller }
  }

  buildConfig() {
    const names = this.proxies.map((proxy) => proxy.name)
    if (names.length === 0) throw new Error('没有可用节点，无法生成配置')
    return {
      'mixed-port': this.ports.mixed,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      'unified-delay': true,
      'tcp-concurrent': true,
      'find-process-mode': 'off',
      'external-controller': '127.0.0.1:' + this.ports.controller,
      secret: this.secret,
      'geodata-mode': false,
      'geo-auto-update': false,
      profile: { 'store-selected': true, 'store-fake-ip': false },
      dns: { enable: false },
      proxies: this.proxies,
      'proxy-groups': [
        {
          name: AUTO_GROUP,
          type: 'url-test',
          url: this.config.testUrl,
          interval: this.config.testInterval,
          tolerance: 50,
          lazy: false,
          proxies: names
        },
        {
          name: SELECT_GROUP,
          type: 'select',
          proxies: [AUTO_GROUP, ...names]
        }
      ],
      rules: ['MATCH,' + SELECT_GROUP]
    }
  }

  async writeConfig() {
    await fs.mkdir(this.dataDir, { recursive: true })
    const body = YAML.stringify(this.buildConfig(), { lineWidth: 0 })
    await fs.writeFile(this.configPath, body, { mode: 0o600 })
    await fs.chmod(this.configPath, 0o600).catch(() => {})
  }

  async testConfig(core) {
    try {
      const result = await execFileAsync(core, ['-t', '-d', this.dataDir, '-f', this.configPath], {
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      })
      this.log('debug', 'config test ok: ' + tail(result.stdout || '', 200))
    } catch (error) {
      const output = [error && error.stdout, error && error.stderr].filter(Boolean).map(String).join('\n')
      throw new Error('Mihomo 配置校验失败: ' + tail(output || messageOf(error), 1200))
    }
  }

  async spawnCore(core) {
    this.stderrTail = []
    this.lastError = ''
    const child = spawn(core, ['-d', this.dataDir, '-f', this.configPath], {
      cwd: this.dataDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => this.log('debug', String(chunk).trim()))
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (!line) return
      this.stderrTail.push(line)
      if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40)
      this.log('debug', line)
    })
    child.once('error', (error) => {
      this.lastError = 'Mihomo 进程错误: ' + messageOf(error)
      if (this.child === child) {
        this.child = null
        this.active = false
      }
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this.active = false
      }
      this.log('warn', 'mihomo exited code=' + String(code) + ' signal=' + String(signal))
    })
    const deadline = Date.now() + 20000
    let last = ''
    while (Date.now() < deadline) {
      if (this.child !== child) {
        throw new Error('Mihomo 启动失败: ' + (this.lastError || tail(this.stderrTail.join(' | '), 1200)))
      }
      try {
        const response = await fetch(this.controllerUrl('/version'), {
          headers: { Authorization: 'Bearer ' + this.secret },
          signal: AbortSignal.timeout(800)
        })
        if (response.ok) {
          const info = await response.json().catch(() => ({}))
          this.coreVersion = String(info.version || '')
          return
        }
        last = 'HTTP ' + response.status
      } catch (error) {
        last = messageOf(error)
      }
      await sleep(100)
    }
    throw new Error('Mihomo 控制器未就绪: ' + last + ' ' + tail(this.stderrTail.join(' | '), 800))
  }

  controllerUrl(pathname) {
    return 'http://127.0.0.1:' + this.ports.controller + pathname
  }

  async api(pathname, init) {
    const options = { ...(init || {}) }
    const headers = { Authorization: 'Bearer ' + this.secret }
    if (options.body) headers['content-type'] = 'application/json'
    options.headers = { ...headers, ...(options.headers || {}) }
    if (!options.signal) options.signal = AbortSignal.timeout(6000)
    const response = await fetch(this.controllerUrl(pathname), options)
    const text = await response.text()
    if (!response.ok) {
      throw new Error('Mihomo API ' + pathname + ' 返回 HTTP ' + response.status + (text ? ': ' + text.slice(0, 300) : ''))
    }
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      if (pathname === '/proxies' && parsed && typeof parsed === 'object' && parsed.proxies && typeof parsed.proxies === 'object') {
        return parsed.proxies
      }
      return parsed
    } catch {
      return { raw: text }
    }
  }

  async health() {
    if (!this.child || !this.ports.controller) return false
    try {
      const response = await fetch(this.controllerUrl('/version'), {
        headers: { Authorization: 'Bearer ' + this.secret },
        signal: AbortSignal.timeout(1500)
      })
      return response.ok
    } catch {
      return false
    }
  }

  shouldBypass(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
    if (isDirectHost(host)) return true
    if (DEFAULT_BYPASS_HOSTS.some((rule) => hostMatchesPattern(host, rule))) return true
    if (this.state.proxyScope === 'models' && !isModelHost(host)) return true
    const rules = Array.isArray(this.state.bypassHosts) ? this.state.bypassHosts : []
    return rules.some((rule) => hostMatchesPattern(host, rule))
  }

  installFetchWrapper() {
    if (this.wrappedFetch) return
    const previous = globalThis.fetch
    if (typeof previous !== 'function') return
    this.previousFetch = previous
    const runtime = this
    const wrapped = async function (input, init) {
      if (!runtime.active) return await previous(input, init)
      let hostname
      try {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url
        hostname = new URL(raw).hostname
      } catch {
        return await previous(input, init)
      }
      if (runtime.shouldBypass(hostname)) return await previous(input, init)
      const agent = await runtime.getProxyAgent()
      if (!agent) return await previous(input, init)
      const options = { ...(init || {}) }
      if (options.dispatcher === undefined) options.dispatcher = agent
      return await runtime.request(input, options)
    }
    this.wrappedFetch = wrapped
    globalThis.fetch = wrapped
  }

  uninstallFetchWrapper() {
    if (this.wrappedFetch && globalThis.fetch === this.wrappedFetch) {
      globalThis.fetch = this.previousFetch || this.nativeFetch
    }
    this.wrappedFetch = null
    this.previousFetch = null
  }

  async installDispatcher() {
    this.installFetchWrapper()
    this.active = true
    if (!this.wrappedFetch) this.log('warn', '无法安装 DSH fetch 代理包装器')
    else this.log('info', 'DSH 的网络请求已指向 127.0.0.1:' + this.ports.mixed)
  }

  async uninstallDispatcher() {
    this.active = false
    await this.closeProxyAgent()
  }

  async killChild(child) {
    if (!child || child.exitCode !== null) return
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(async () => {
        try {
          if (process.platform === 'win32' && child.pid) {
            await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
          } else {
            child.kill('SIGKILL')
          }
        } catch {
          // ignore
        }
        finish()
      }, 4000)
      child.once('exit', finish)
      try {
        child.kill()
      } catch {
        finish()
      }
    })
  }

  async _stop(options) {
    const persist = !options || options.persist !== false
    await this.uninstallDispatcher()
    const child = this.child
    this.child = null
    if (child) await this.killChild(child)
    this.active = false
    if (persist) {
      this.state.enabled = false
      await this.saveState().catch(() => {})
    }
    return { running: false, message: 'DSH LLM Proxy 已停止；DSH 的网络请求已恢复直连，系统代理未改动。' }
  }

  async _start(options) {
    const selection = options && options.selection ? options.selection : 'auto'
    const signal = options && options.signal
    throwIfAborted(signal)
    await this._stop({ persist: false })
    try {
      if (this.proxies.length === 0) await this.loadProxies()
      const core = await this.resolveCore(true, signal)
      this.ports = await this.ensurePorts()
      this.secret = this.state.secret || randomBytes(24).toString('hex')
      this.state.secret = this.secret
      await this.writeConfig()
      await this.testConfig(core)
      await this.spawnCore(core)
      this.active = true
      await this.installDispatcher()
      let target = selection
      if (target !== 'auto' && target !== AUTO_GROUP && !this.proxies.some((proxy) => proxy.name === target)) target = 'auto'
      try {
        await this.selectInternal(target, signal)
      } catch (error) {
        this.lastError = '节点选择失败，已回退自动: ' + messageOf(error)
        this.log('warn', this.lastError)
        await this.selectInternal('auto', signal).catch(() => {})
      }
      this.state.enabled = true
      this.state.lastError = this.lastError
      await this.saveState()
      return this.summary('已启动 DSH LLM Proxy')
    } catch (error) {
      this.lastError = messageOf(error)
      this.state.enabled = false
      this.state.lastError = this.lastError
      await this.saveState().catch(() => {})
      await this._stop({ persist: false }).catch(() => {})
      throw error
    }
  }

  async selectInternal(name, signal) {
    throwIfAborted(signal)
    const target = name === 'auto' || name === AUTO_GROUP ? AUTO_GROUP : name
    if (target !== AUTO_GROUP && !this.proxies.some((proxy) => proxy.name === target)) {
      throw new Error('节点不存在: ' + target)
    }
    await this.api('/proxies/' + encodeURIComponent(SELECT_GROUP), {
      method: 'PUT',
      body: JSON.stringify({ name: target }),
      signal
    })
    this.state.selected = target
    this.state.mode = target === AUTO_GROUP ? 'auto' : 'manual'
  }

  async _subscribe(source, displayName, signal) {
    const trimmed = String(source || '').trim()
    if (!trimmed) throw new Error('订阅链接不能为空')
    throwIfAborted(signal)
    const loaded = await this.readSource(trimmed, signal)
    const parsed = parseSubscription(loaded.text)
    if (parsed.proxies.length === 0) throw new Error('订阅中没有可用的代理节点')
    this.proxies = parsed.proxies
    const host = displaySource(trimmed)
    this.state.subscription = {
      source: trimmed,
      sourceType: loaded.sourceType,
      host,
      name: displayName && displayName.trim() ? displayName.trim() : host,
      updatedAt: new Date().toISOString(),
      nodeCount: parsed.proxies.length,
      skipped: parsed.skipped
    }
    await this.persistSubscription(loaded.text)
    await this.saveState()
    this.log('info', 'imported ' + parsed.proxies.length + ' nodes from ' + host)
    return await this._start({ selection: 'auto', signal })
  }

  async subscribe(source, displayName, signal) {
    await this.ready
    return await this.runExclusive(async () => {
      const result = await this._subscribe(source, displayName, signal)
      return {
        ...result,
        imported: true,
        message: '已导入 ' + result.nodeCount + ' 个节点并启动代理；DSH 的请求将走 127.0.0.1:' + result.mixedPort + '，系统代理未改动。'
      }
    })
  }

  async update(signal) {
    await this.ready
    return await this.runExclusive(async () => {
      const subscription = this.state.subscription
      if (!subscription || !subscription.source) throw new Error('尚未导入订阅，请先调用 clash_subscribe')
      const previousMode = this.state.mode
      const previousSelected = this.state.selected
      const loaded = await this.readSource(subscription.source, signal)
      const parsed = parseSubscription(loaded.text)
      if (parsed.proxies.length === 0) throw new Error('订阅中没有可用的代理节点')
      this.proxies = parsed.proxies
      subscription.updatedAt = new Date().toISOString()
      subscription.nodeCount = parsed.proxies.length
      subscription.skipped = parsed.skipped
      await this.persistSubscription(loaded.text)
      await this.saveState()
      const selection = previousMode === 'manual' && parsed.proxies.some((proxy) => proxy.name === previousSelected) ? previousSelected : 'auto'
      const result = await this._start({ selection, signal })
      return {
        ...result,
        updated: true,
        message: '订阅已更新，共 ' + result.nodeCount + ' 个节点；' + result.message
      }
    })
  }

  async start(signal) {
    await this.ready
    return await this.runExclusive(async () => {
      const selection = this.state.mode === 'manual' ? this.state.selected : 'auto'
      return await this._start({ selection, signal })
    })
  }

  async stop() {
    await this.ready
    return await this.runExclusive(async () => await this._stop({ persist: true }))
  }

  summary(prefix) {
    const subscription = this.state.subscription || {}
    return {
      running: true,
      subscription: String(subscription.name || ''),
      subscriptionHost: String(subscription.host || ''),
      nodeCount: this.proxies.length,
      mode: this.state.mode || 'auto',
      selected: this.state.selected || AUTO_GROUP,
      mixedPort: this.ports.mixed,
      coreVersion: this.coreVersion,
      message: prefix + '：' + this.proxies.length + ' 个节点，混合端口 127.0.0.1:' + this.ports.mixed + '，当前 ' + (this.state.mode === 'manual' ? '手动节点 ' + this.state.selected : '自动选择 ' + AUTO_GROUP) + '。系统代理未改动。'
    }
  }

  async status() {
    await this.ready
    const subscription = this.state.subscription
    const configured = Boolean(subscription)
    const running = await this.health()
    let selected = this.state.selected || AUTO_GROUP
    let mode = running ? (selected === AUTO_GROUP ? 'auto' : 'manual') : 'off'
    let coreVersion = this.coreVersion
    if (running) {
      try {
        const group = await this.api('/proxies/' + encodeURIComponent(SELECT_GROUP))
        if (group && group.now) selected = String(group.now)
        mode = selected === AUTO_GROUP ? 'auto' : 'manual'
        const version = await this.api('/version')
        coreVersion = String((version && version.version) || coreVersion)
      } catch (error) {
        this.lastError = messageOf(error)
      }
    }
    return {
      configured,
      running,
      mode,
      selected,
      subscription: String(subscription && subscription.name ? subscription.name : ''),
      subscriptionHost: String(subscription && subscription.host ? subscription.host : ''),
      updatedAt: String(subscription && subscription.updatedAt ? subscription.updatedAt : ''),
      nodeCount: subscription && Number(subscription.nodeCount) ? Number(subscription.nodeCount) : this.proxies.length,
      mixedPort: this.ports.mixed || 0,
      controllerPort: this.ports.controller || 0,
      coreVersion,
      pid: this.child && this.child.pid ? this.child.pid : 0,
      autoGroup: AUTO_GROUP,
      testUrl: this.config.testUrl,
      lastError: this.lastError || this.state.lastError || ''
    }
  }

  policy() {
    const saved = Array.isArray(this.state.bypassHosts) ? this.state.bypassHosts : []
    return {
      proxyScope: this.state.proxyScope === 'models' ? 'models' : 'all',
      bypassHosts: normalizeBypassList([...DEFAULT_BYPASS_HOSTS, ...saved]),
      defaultBypassHosts: DEFAULT_BYPASS_HOSTS.slice(),
      modelHosts: MODEL_HOSTS.slice()
    }
  }

  async setPolicy(input) {
    const body = input && typeof input === 'object' ? input : {}
    this.state.proxyScope = body.proxyScope === 'models' ? 'models' : 'all'
    this.state.bypassHosts = normalizeBypassList(body.bypassHosts)
    await this.saveState()
    this.log('info', '代理范围已更新: ' + this.state.proxyScope + '，绕行规则 ' + this.state.bypassHosts.length + ' 条')
    return { policy: this.policy(), message: '代理范围与绕行规则已保存，立即生效。' }
  }

  async uiState() {
    await this.ready
    if (this.proxies.length === 0 && this.state.subscription) await this.loadProxies().catch(() => {})
    const status = await this.status()
    let activeNode = status.selected
    let list = this.proxies.map((proxy) => ({
      name: proxy.name,
      type: String(proxy.type || ''),
      delay: 0,
      selected: proxy.name === status.selected
    }))
    if (status.running) {
      try {
        const all = await this.api('/proxies')
        const group = all[SELECT_GROUP] || {}
        const auto = all[AUTO_GROUP] || {}
        if (group.now === AUTO_GROUP && auto.now) activeNode = String(auto.now)
        if (group.now && group.now !== AUTO_GROUP) activeNode = String(group.now)
        list = list.map((node) => ({
          ...node,
          delay: historyDelay(all[node.name]),
          selected: node.name === group.now
        }))
      } catch (error) {
        this.lastError = messageOf(error)
      }
    }
    return { status: { ...status, activeNode }, nodes: list, policy: this.policy() }
  }

  async nodes(options) {
    await this.ready
    if (!(await this.health())) throw new Error('代理未运行，请先调用 clash_start 或 clash_subscribe')
    const all = await this.api('/proxies')
    const group = all[SELECT_GROUP] || {}
    let list = this.proxies.map((proxy) => ({
      name: proxy.name,
      type: String(proxy.type || ''),
      delay: historyDelay(all[proxy.name]),
      selected: proxy.name === group.now
    }))
    if (options && options.test === true) {
      const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(50, Math.trunc(Number(options.limit)))) : 12
      const names = list.slice(0, limit).map((node) => node.name)
      const delays = await this.testMany(names, options.signal)
      list = list.map((node) => (delays.has(node.name) ? { ...node, delay: delays.get(node.name) } : node))
    }
    return {
      count: list.length,
      selected: String(group.now || ''),
      auto: group.now === AUTO_GROUP,
      nodes: list
    }
  }

  async testMany(names, signal) {
    const unique = [...new Set(names.filter((name) => this.proxies.some((proxy) => proxy.name === name)))]
    const results = new Map()
    let cursor = 0
    const workers = Array.from({ length: Math.min(8, unique.length) }, async () => {
      while (cursor < unique.length) {
        throwIfAborted(signal)
        const name = unique[cursor]
        cursor += 1
        results.set(name, await this.testNode(name, signal).catch(() => 0))
      }
    })
    await Promise.all(workers)
    return results
  }

  async testNode(name, signal) {
    const url = '/proxies/' + encodeURIComponent(name) + '/delay?url=' + encodeURIComponent(this.config.testUrl) + '&timeout=5000'
    const result = await this.api(url, { signal })
    return Number(result && result.delay) || 0
  }

  async test(names, limit, signal) {
    await this.ready
    if (!(await this.health())) throw new Error('代理未运行，请先调用 clash_start 或 clash_subscribe')
    let requested = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()) : []
    if (requested.length === 0) {
      const capped = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Math.trunc(Number(limit)))) : 12
      requested = this.proxies.slice(0, capped).map((proxy) => proxy.name)
    }
    const delays = await this.testMany(requested, signal)
    const all = await this.api('/proxies')
    const group = all[SELECT_GROUP] || {}
    const list = this.proxies.map((proxy) => ({
      name: proxy.name,
      type: String(proxy.type || ''),
      delay: delays.has(proxy.name) ? delays.get(proxy.name) : historyDelay(all[proxy.name]),
      selected: proxy.name === group.now
    }))
    const tested = list.filter((node) => delays.has(node.name))
    const best = tested.slice().sort((a, b) => (a.delay || 999999) - (b.delay || 999999))[0]
    return {
      tested: tested.length,
      nodes: list,
      message: '已测试 ' + tested.length + ' 个节点' + (best ? '，当前最快 ' + best.name + '（' + best.delay + 'ms）' : '') + '。'
    }
  }

  async select(name, signal) {
    await this.ready
    return await this.runExclusive(async () => {
      if (!(await this.health())) throw new Error('代理未运行，请先调用 clash_start 或 clash_subscribe')
      const target = String(name || '').trim()
      if (!target) throw new Error('节点名称不能为空')
      await this.selectInternal(target, signal)
      await this.saveState()
      return {
        selected: this.state.selected,
        mode: this.state.mode,
        message: this.state.mode === 'auto' ? '已切换为自动选择（DSH-AUTO）' : '已切换到节点 ' + this.state.selected
      }
    })
  }

  async auto(signal) {
    return await this.select('auto', signal)
  }

  async installCoreTool(signal) {
    await this.ready
    return await this.runExclusive(async () => {
      const installed = await this.installCore(signal)
      return {
        installed: true,
        path: installed.path,
        version: installed.version,
        message: 'Mihomo 核心已安装到 ' + installed.path + '（' + installed.version + '）'
      }
    })
  }

  async boot() {
    try {
      await this.loadState()
      if (!this.config.autoStart) return
      if (this.state.enabled === false) return
      if (!this.state.subscription && this.config.subscriptionUrl) {
        await this.runExclusive(async () => {
          await this._subscribe(this.config.subscriptionUrl, '', undefined)
        })
        return
      }
      if (!this.state.subscription) return
      await this.runExclusive(async () => {
        const selection = this.state.mode === 'manual' ? this.state.selected : 'auto'
        await this._start({ selection })
      })
    } catch (error) {
      this.lastError = messageOf(error)
      this.state.lastError = this.lastError
      this.log('warn', '自动启动失败: ' + this.lastError)
      await this.saveState().catch(() => {})
    }
  }

  async dispose() {
    try {
      await this.runExclusive(async () => {
        await this._stop({ persist: false })
      })
    } catch {
      // ignore
    }
    this.uninstallFetchWrapper()
    await this.closeProxyAgent()
    if (this.directAgent) {
      try {
        if (typeof this.directAgent.destroy === 'function') this.directAgent.destroy()
        else await this.directAgent.close()
      } catch {
        // ignore
      }
      this.directAgent = null
    }
  }
}

function registerTool(ctx, definition) {
  ctx.tools.register(defineTool(definition))
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('请求体过大')
        error.statusCode = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        const error = new Error('请求体不是有效 JSON')
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function isTrustedBrowserRequest(req) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin) {
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') return false
  return true
}

function panelUrlForExternalBrowser(value) {
  let parsed
  try {
    parsed = new URL(String(value || '').trim())
  } catch {
    const error = new Error('页面地址无效')
    error.statusCode = 400
    throw error
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error('只允许打开 http(s) 页面')
    error.statusCode = 400
    throw error
  }
  if (parsed.username || parsed.password || !isDirectHost(parsed.hostname)) {
    const error = new Error('只允许打开本机 DSH 页面')
    error.statusCode = 400
    throw error
  }
  if (parsed.pathname !== '/clash-proxy' && parsed.pathname !== '/clash-proxy/') {
    const error = new Error('只能打开 Clash 控制面板')
    error.statusCode = 400
    throw error
  }
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function spawnDefaultBrowser(url) {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows'
    const rundll = path.join(root, 'System32', 'rundll32.exe')
    const explorer = path.join(root, 'explorer.exe')
    const comspec = process.env.ComSpec || 'cmd.exe'
    return spawnDetached(comspec, ['/d', '/s', '/c', 'start', '', url])
      .catch(() => spawnDetached(rundll, ['url.dll,FileProtocolHandler', url]))
      .catch(() => spawnDetached(explorer, [url]))
  }
  return spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

async function openInSystemBrowser(url) {
  if (process.versions && process.versions.electron) {
    try {
      const electron = createRequire(import.meta.url)('electron')
      if (electron && electron.shell && typeof electron.shell.openExternal === 'function') {
        await electron.shell.openExternal(url)
        return 'electron'
      }
    } catch {}
  }
  await spawnDefaultBrowser(url)
  return 'spawn'
}

function registerWebUi(ctx, runtime) {
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return
  let pageCache = ''
  const pageFile = new URL('./ui.html', import.meta.url)
  const loadPage = async () => {
    if (!pageCache) pageCache = await fs.readFile(pageFile, 'utf8')
    return pageCache
  }
  const api = {
    open: async (body) => {
      const url = panelUrlForExternalBrowser(body.url)
      const via = await openInSystemBrowser(url)
      return { opened: true, url, via, message: '已在系统默认浏览器中打开' }
    },
    state: async () => ({ state: await runtime.uiState() }),
    settings: async (body) => {
      const result = await runtime.setPolicy(body)
      return { state: await runtime.uiState(), message: result.message }
    },
    subscribe: async (body) => {
      const url = String(body.url || '').trim()
      if (!url) throw new Error('订阅链接不能为空')
      await runtime.subscribe(url, body.name ? String(body.name).trim() : undefined)
      return { state: await runtime.uiState() }
    },
    select: async (body) => {
      const name = String(body.name || '').trim()
      if (!name) throw new Error('节点名称不能为空')
      await runtime.select(name)
      return { state: await runtime.uiState() }
    },
    auto: async () => {
      await runtime.auto()
      return { state: await runtime.uiState() }
    },
    start: async () => {
      await runtime.start()
      return { state: await runtime.uiState() }
    },
    stop: async () => {
      await runtime.stop()
      return { state: await runtime.uiState() }
    },
    update: async () => {
      await runtime.update()
      return { state: await runtime.uiState() }
    },
    test: async (body) => {
      const result = await runtime.test(Array.isArray(body.names) ? body.names : undefined, body.limit)
      return { state: await runtime.uiState(), tested: result.tested, nodes: result.nodes }
    },
    installCore: async () => {
      await runtime.installCoreTool()
      return { state: await runtime.uiState() }
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/clash-proxy',
    handler: async (req, res) => {
      try {
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        if (pathname === '/clash-proxy' || pathname === '/clash-proxy/') {
          if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } }); return }
          const page = await loadPage()
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'SAMEORIGIN',
            'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
          })
          res.end(page)
          return
        }
        const prefix = '/clash-proxy/api/'
        if (!pathname.startsWith(prefix)) { writeJson(res, 404, { ok: false, error: { message: 'not found' } }); return }
        if (!isTrustedBrowserRequest(req)) { writeJson(res, 403, { ok: false, error: { message: 'forbidden' } }); return }
        const method = pathname.slice(prefix.length)
        if (!method || method.includes('/') || !Object.hasOwn(api, method) || typeof api[method] !== 'function') {
          writeJson(res, 404, { ok: false, error: { message: 'unknown api method' } }); return
        }
        if (req.method !== 'GET' && req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } }); return }
        if (method === 'state' && req.method !== 'GET') { writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } }); return }
        if (method !== 'state' && req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { message: 'method not allowed' } }); return }
        const body = req.method === 'POST' ? await readJsonBody(req) : {}
        const result = await api[method](body)
        writeJson(res, 200, { ok: true, ...result })
      } catch (error) {
        writeJson(res, Number(error && error.statusCode) || 500, { ok: false, error: { message: messageOf(error) } })
      }
    }
  }), 'dsh-llm-proxy: web UI')
}

function registerTools(ctx, runtime) {
  registerTool(ctx, {
    name: 'clash_subscribe',
    description: '导入 Clash / Mihomo 订阅链接并启动 DSH 专用代理。订阅只影响 DSH 进程，不修改 Windows 系统代理。支持 http(s) 链接或本地 YAML 文件路径。',
    parameters: {
      url: { type: 'string', required: true, description: 'Clash 订阅链接，或本地 Clash YAML 文件路径' },
      name: { type: 'string', description: '可选的订阅显示名' }
    },
    output: {
      schema: objectSchema({
        imported: booleanField('是否完成导入'),
        ...summaryProperties
      }),
      render: summaryText
    },
    timeoutMs: 180000,
    isConcurrencySafe: false,
    execute: async (args, exec) => await runtime.subscribe(args.url, args.name, exec.signal)
  })

  registerTool(ctx, {
    name: 'clash_status',
    description: '查看 DSH LLM Proxy 状态：是否运行、当前节点、自动/手动模式、端口、订阅和核心版本。',
    parameters: {},
    output: {
      schema: objectSchema({
        configured: booleanField('是否已导入订阅'),
        running: booleanField('核心是否正在运行'),
        mode: stringField('auto / manual / off'),
        selected: stringField('当前节点或 DSH-AUTO'),
        subscription: stringField('订阅显示名'),
        subscriptionHost: stringField('订阅主机或文件名'),
        updatedAt: stringField('订阅更新时间'),
        nodeCount: numberField('节点数量'),
        mixedPort: numberField('混合代理端口'),
        controllerPort: numberField('控制端口'),
        coreVersion: stringField('Mihomo 版本'),
        pid: numberField('核心进程 ID，0 表示未运行'),
        autoGroup: stringField('自动选择组名'),
        testUrl: stringField('自动测速 URL'),
        lastError: stringField('最近一次错误，空表示无')
      }),
      render: (args, value) => textBlock(
        'DSH LLM Proxy：' + (value.running ? '运行中' : '未运行') + '\n' +
        '订阅：' + (value.subscription || '未导入') + (value.subscriptionHost ? '（' + value.subscriptionHost + '）' : '') + '\n' +
        '节点：' + value.nodeCount + '，模式：' + value.mode + '，当前：' + (value.selected || '无') + '\n' +
        '端口：混合 ' + value.mixedPort + ' / 控制 ' + value.controllerPort + '，核心：' + (value.coreVersion || '未知') + '\n' +
        (value.lastError ? '错误：' + value.lastError : '系统代理未改动。')
      )
    },
    timeoutMs: 20000,
    isConcurrencySafe: true,
    execute: async () => await runtime.status()
  })

  registerTool(ctx, {
    name: 'clash_nodes',
    description: '列出订阅中的节点、当前选择和已知延迟；test=true 时会对前 limit 个节点发起延迟测试。',
    parameters: {
      test: { type: 'boolean', description: '是否立即测速' },
      limit: { type: 'number', description: '最多测试多少个节点，默认 12，最大 50' }
    },
    output: {
      schema: objectSchema({
        count: numberField('节点总数'),
        selected: stringField('当前节点或 DSH-AUTO'),
        auto: booleanField('是否处于自动选择'),
        nodes: { type: 'array', required: true, description: '节点列表', items: nodeSchema }
      }),
      render: (args, value) => {
        const rows = value.nodes.slice(0, 30).map((node) => (node.selected ? '* ' : '  ') + node.name + ' [' + node.type + '] ' + (node.delay ? node.delay + 'ms' : '未测速'))
        return textBlock('节点 ' + value.count + ' 个，当前：' + (value.selected || '无') + '\n' + rows.join('\n'))
      }
    },
    timeoutMs: 60000,
    isConcurrencySafe: true,
    execute: async (args, exec) => await runtime.nodes({ test: args.test === true, limit: args.limit, signal: exec.signal })
  })

  registerTool(ctx, {
    name: 'clash_select',
    description: '手动指定 DSH 使用的节点。传节点名称，或传 auto 恢复自动选择。不会影响其他程序。',
    parameters: {
      name: { type: 'string', required: true, description: '节点名称，或 auto' }
    },
    output: {
      schema: objectSchema({
        selected: stringField('当前节点或 DSH-AUTO'),
        mode: stringField('auto 或 manual'),
        message: stringField('结果摘要')
      }),
      render: summaryText
    },
    timeoutMs: 30000,
    isConcurrencySafe: false,
    execute: async (args, exec) => await runtime.select(args.name, exec.signal)
  })

  registerTool(ctx, {
    name: 'clash_auto',
    description: '恢复自动节点调度：Mihomo 的 DSH-AUTO url-test 组会按延迟自动选择并定期切换节点。',
    parameters: {},
    output: {
      schema: objectSchema({
        selected: stringField('当前节点或 DSH-AUTO'),
        mode: stringField('auto 或 manual'),
        message: stringField('结果摘要')
      }),
      render: summaryText
    },
    timeoutMs: 30000,
    isConcurrencySafe: false,
    execute: async (args, exec) => await runtime.auto(exec.signal)
  })

  registerTool(ctx, {
    name: 'clash_test',
    description: '测试节点延迟。可传 names 指定节点；不传则测试前 limit 个节点（默认 12）。',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, description: '要测试的节点名称列表' },
      limit: { type: 'number', description: '未指定 names 时测试前多少个节点，默认 12，最大 50' }
    },
    output: {
      schema: objectSchema({
        tested: numberField('实际测试的节点数'),
        nodes: { type: 'array', required: true, description: '节点列表', items: nodeSchema },
        message: stringField('结果摘要')
      }),
      render: summaryText
    },
    timeoutMs: 90000,
    isConcurrencySafe: true,
    execute: async (args, exec) => await runtime.test(args.names, args.limit, exec.signal)
  })

  registerTool(ctx, {
    name: 'clash_update',
    description: '重新下载当前订阅并热重启代理，尽量保留当前手动选择的节点。',
    parameters: {},
    output: {
      schema: objectSchema({
        updated: booleanField('是否完成更新'),
        ...summaryProperties
      }),
      render: summaryText
    },
    timeoutMs: 180000,
    isConcurrencySafe: false,
    execute: async (args, exec) => await runtime.update(exec.signal)
  })

  registerTool(ctx, {
    name: 'clash_start',
    description: '用已保存的订阅启动 DSH 专用代理。',
    parameters: {},
    output: {
      schema: objectSchema(summaryProperties),
      render: summaryText
    },
    timeoutMs: 60000,
    isConcurrencySafe: false,
    execute: async (args, exec) => await runtime.start(exec.signal)
  })

  registerTool(ctx, {
    name: 'clash_stop',
    description: '停止 DSH 专用代理并恢复直连；不会改动系统代理。',
    parameters: {},
    output: {
      schema: objectSchema({
        running: booleanField('核心是否仍在运行'),
        message: stringField('结果摘要')
      }),
      render: summaryText
    },
    timeoutMs: 30000,
    isConcurrencySafe: false,
    execute: async () => await runtime.stop()
  })

  registerTool(ctx, {
    name: 'clash_install_core',
    description: '下载并安装匹配当前平台的 Mihomo 核心到 DSH 数据目录，用于首次使用或修复核心缺失。',
    parameters: {},
    output: {
      schema: objectSchema({
        installed: booleanField('是否安装成功'),
        path: stringField('核心可执行文件路径'),
        version: stringField('核心版本'),
        message: stringField('结果摘要')
      }),
      render: summaryText
    },
    timeoutMs: 300000,
    isConcurrencySafe: false,
    execute: async (args, exec) => await runtime.installCoreTool(exec.signal)
  })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const runtime = new ClashProxyRuntime(ctx, config)
  runtime.installFetchWrapper()
  registerTools(ctx, runtime)
  registerWebUi(ctx, runtime)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      runtime.dispose().catch(() => {})
    }, 'dsh-llm-proxy: lifecycle')
  }
  runtime.ready = runtime.boot()
}
