import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const command = process.argv[2] ?? 'upload-verify'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const localAppData = process.env.LOCALAPPDATA

function loadLocalAgentConfig() {
  if (!localAppData) return null
  const configPath = join(localAppData, 'lxbridge-agent', 'config.json')
  if (!existsSync(configPath)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析本机配置文件 ${configPath}（JSON 无效）：${error.message}`)
  }
  const songloftHost = parsed.songloftHost
  if (typeof songloftHost !== 'string' || songloftHost.trim() === '') {
    throw new Error(`本机配置文件 ${configPath} 缺少有效的 songloftHost 字段`)
  }
  return { configPath, songloftHost: songloftHost.trim() }
}

function normalizeBaseUrl(value, source) {
  const trimmed = value.replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${source} 提供的地址不是合法 URL：${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${source} 提供的地址协议必须是 http 或 https：${trimmed}`)
  }
  return trimmed
}

function resolveBaseUrl() {
  const envHost = process.env.SONGLOFT_HOST
  if (typeof envHost === 'string' && envHost.trim() !== '') {
    return normalizeBaseUrl(envHost, '环境变量 SONGLOFT_HOST')
  }
  const localConfig = loadLocalAgentConfig()
  if (localConfig) {
    return normalizeBaseUrl(localConfig.songloftHost, `本机配置 ${localConfig.configPath}`)
  }
  return 'http://127.0.0.1:58091'
}

const baseUrl = resolveBaseUrl()
const profileDir = process.env.SONGLOFT_BROWSER_PROFILE ??
  (localAppData ? join(localAppData, 'lxbridge-agent', 'chrome-profile') : '')
const packagePath = resolve(projectRoot, process.env.LXBRIDGE_PACKAGE ?? 'dist/lxbridge.jsplugin.zip')
const manifestPath = join(projectRoot, 'plugin.json')
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function loadManifest() {
  requireCondition(existsSync(manifestPath), `plugin.json not found: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const field of ['entryPath', 'version', 'entryHash', 'zipHash']) {
    requireCondition(typeof manifest[field] === 'string' && manifest[field].length > 0,
      `plugin.json is missing ${field}`)
  }
  return manifest
}

function validateLocalInputs() {
  requireCondition(process.platform === 'win32', 'The dedicated browser workflow currently supports Windows only.')
  requireCondition(profileDir && isAbsolute(profileDir), 'A profile path under LOCALAPPDATA is required.')
  requireCondition(!profileDir.startsWith(projectRoot), 'The browser profile must stay outside the repository.')
  requireCondition(existsSync(chromePath), `System Chrome not found: ${chromePath}`)
  requireCondition(existsSync(packagePath), `Built plugin package not found: ${packagePath}`)
  return loadManifest()
}

async function launchDedicatedBrowser(headless = false) {
  mkdirSync(profileDir, { recursive: true })
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection',
      '--no-default-browser-check',
    ],
  })
}

async function getPrimaryPage(context) {
  const pages = context.pages()
  return pages.length > 0 ? pages[0] : context.newPage()
}

async function enableFlutterAccessibility(page) {
  const enableButton = page.getByRole('button', { name: 'Enable accessibility', exact: true })
  if (await enableButton.count() === 1 && await enableButton.isVisible()) {
    await enableButton.click()
    await page.waitForTimeout(300)
  }
}

async function exposePluginManagement(page) {
  await enableFlutterAccessibility(page)
  const uploadButton = page.getByRole('button', { name: '上传插件', exact: true })
  if (await uploadButton.count() === 1 && await uploadButton.isVisible()) return uploadButton

  const extensionButton = page.getByRole('button', { name: '扩展 插件管理', exact: true })
  if (await extensionButton.count() === 1 && await extensionButton.isVisible()) {
    await extensionButton.click()
    await page.waitForTimeout(500)
  }
  if (await uploadButton.count() === 1 && await uploadButton.isVisible()) return uploadButton
  return null
}

async function openAuthenticatedPluginManagement(page, { interactive, timeoutMs }) {
  await page.goto(`${baseUrl}/#/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  const deadline = Date.now() + timeoutMs
  let prompted = false

  while (Date.now() < deadline) {
    const uploadButton = await exposePluginManagement(page)
    if (uploadButton) return uploadButton
    if (!interactive) {
      throw new Error("Dedicated Songloft browser is not signed in. Run 'npm run browser:init' first.")
    }
    if (!prompted) {
      console.log('请在打开的专用 Chrome 窗口中登录 Songloft。不要让 Chrome 保存密码。')
      console.log('登录完成后保持窗口打开，脚本会自动识别插件管理页面。')
      prompted = true
    }
    if (!page.url().includes('/login') && !page.url().includes('#/settings')) {
      await page.goto(`${baseUrl}/#/settings`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    await sleep(1500)
  }
  throw new Error('Timed out waiting for an authenticated Songloft plugin-management page.')
}

function attachDiagnostics(page, issues) {
  page.on('pageerror', error => issues.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error' && /uncaught|\[lx\]|401|403|503|plugin_unavailable/i.test(message.text())) {
      issues.push(`console: ${message.text().slice(0, 300)}`)
    }
  })
  page.on('response', response => {
    const status = response.status()
    const url = response.url()
    if ((status === 401 || status === 403 || status >= 500) && url.startsWith(baseUrl)) {
      issues.push(`http ${status}: ${new URL(url).pathname}`)
    }
  })
}

async function verifyInstalledCard(page, manifest) {
  await page.waitForTimeout(900)
  const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const card = page.getByRole('group', {
    name: new RegExp(`^LX音乐桥 已启用 v${escapedVersion}(?: |$)`),
  })
  requireCondition(await card.count() === 1,
    `Could not uniquely verify the enabled LX音乐桥 v${manifest.version} management card.`)
}

async function uploadPackage(page, manifest) {
  const uploadButton = await exposePluginManagement(page)
  requireCondition(uploadButton, 'Upload button is not available on the plugin-management page.')
  await uploadButton.click()

  const dialog = page.getByRole('alertdialog')
  await dialog.waitFor({ state: 'visible' })
  const filePicker = dialog.getByRole('button', { name: /选择插件文件上传/ })
  requireCondition(await filePicker.count() === 1, 'Expected exactly one plugin file-picker button.')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    filePicker.click(),
  ])
  await chooser.setFiles(packagePath)

  const submit = dialog.getByRole('button', { name: '上传', exact: true })
  await submit.waitFor({ state: 'visible' })
  const enableDeadline = Date.now() + 15_000
  while (!(await submit.isEnabled()) && Date.now() < enableDeadline) await sleep(250)
  requireCondition(await submit.isEnabled(), 'Upload button did not become enabled after selecting the ZIP.')
  await submit.click()
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 })
  await verifyInstalledCard(page, manifest)
}

async function openPluginFrame(page, manifest) {
  const pluginUrl = `${baseUrl}/api/v1/jsplugin/${manifest.entryPath}`
  const route = `${baseUrl}/#/plugin?url=${encodeURIComponent(pluginUrl)}&name=${encodeURIComponent('LX音乐桥')}`
  await page.goto(route, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await enableFlutterAccessibility(page)

  const iframe = page.locator('iframe')
  requireCondition(await iframe.count() === 1, 'Songloft did not render exactly one plugin iframe.')
  const frame = page.frameLocator('iframe')
  await frame.locator('.topbar-ver').waitFor({ state: 'visible', timeout: 30_000 })
  return frame
}

async function verifyRuntime(frame, manifest) {
  const visibleVersion = (await frame.locator('.topbar-ver').innerText()).trim()
  requireCondition(visibleVersion === `v${manifest.version}`,
    `Running plugin version is '${visibleVersion}', expected 'v${manifest.version}'.`)

  const miotStatus = (await frame.locator('.miot-status').innerText()).trim()
  requireCondition(/MIoT/.test(miotStatus) && !/未安装|失败|error/i.test(miotStatus),
    `MIoT status is not healthy: ${miotStatus}`)

  await frame.locator('.nav-item[data-page="search"]').click()
  const input = frame.locator('#searchInput')
  await input.waitFor({ state: 'visible' })
  await input.fill('周杰伦')
  await input.press('Enter')
  const results = frame.locator('#searchResults .song-item')
  await results.first().waitFor({ state: 'visible', timeout: 30_000 })
  const resultCount = await results.count()
  requireCondition(resultCount > 0, 'Read-only search returned no rendered song results.')

  // v2.6.0: 诊断中心功能验收
  await frame.locator('.nav-item[data-page="diagnostics"]').click()
  await frame.locator('#page-diagnostics').waitFor({ state: 'visible', timeout: 15_000 })
  await frame.locator('#diagnosticsContent .status-banner').waitFor({ state: 'visible', timeout: 15_000 })
  const bannerText = (await frame.locator('#diagnosticsContent .status-banner').innerText()).trim()
  requireCondition(/系统正常|系统可用|需关注|系统存在异常/.test(bannerText),
    `Diagnostics banner did not render system status: ${bannerText}`)
  const sectionCount = await frame.locator('#diagnosticsContent .diag-card').count()
  requireCondition(sectionCount === 4, `Diagnostics rendered unexpected summary count: ${sectionCount}`)
  const disclosureCount = await frame.locator('#diagnosticsContent .diag-disclosure').count()
  requireCondition(disclosureCount === 2, `Diagnostics rendered unexpected disclosure count: ${disclosureCount}`)
  const report = await frame.locator('body').evaluate(() =>
    window.API.getDiagnosticsReport().then(r =>
      r && r.success && r.data && r.data.report ? r.data.report : null))
  requireCondition(typeof report === 'string' && report.length > 0 && /系统诊断报告/.test(report),
    'Diagnostics report endpoint did not return a report.')
  requireCondition(!/https?:\/\//.test(report), 'Diagnostics report leaked a URL.')

  return { miotStatus, searchResultCount: resultCount, diagnosticsSections: sectionCount }
}

async function initializeBrowser() {
  validateLocalInputs()
  const context = await launchDedicatedBrowser(false)
  try {
    const page = await getPrimaryPage(context)
    await openAuthenticatedPluginManagement(page, { interactive: true, timeoutMs: 10 * 60_000 })
    console.log(`专用 Songloft 浏览器会话已就绪：${profileDir}`)
  } finally {
    await context.close()
  }
}

async function uploadAndVerify() {
  const manifest = validateLocalInputs()
  const context = await launchDedicatedBrowser(process.env.SONGLOFT_HEADLESS === '1')
  const issues = []
  try {
    const page = await getPrimaryPage(context)
    attachDiagnostics(page, issues)
    await openAuthenticatedPluginManagement(page, { interactive: false, timeoutMs: 30_000 })
    console.log(`[1/3] 上传 ${manifest.entryPath} v${manifest.version}`)
    await uploadPackage(page, manifest)
    console.log('[2/3] 管理页面版本与启用状态已确认')
    const frame = await openPluginFrame(page, manifest)
    const runtime = await verifyRuntime(frame, manifest)
    console.log('[3/3] 运行页面、MIoT 状态、只读搜索与诊断中心已确认')

    const criticalIssues = [...new Set(issues)]
    requireCondition(criticalIssues.length === 0,
      `Deployment produced critical browser errors:\n${criticalIssues.join('\n')}`)
    console.log(JSON.stringify({
      success: true,
      host: baseUrl,
      entryPath: manifest.entryPath,
      version: manifest.version,
      miotStatus: runtime.miotStatus,
      searchResultCount: runtime.searchResultCount,
      diagnosticsSections: runtime.diagnosticsSections,
      verifiedAt: new Date().toISOString(),
    }, null, 2))
  } finally {
    await context.close()
  }
}

function selfTest() {
  const manifest = validateLocalInputs()
  console.log(JSON.stringify({
    success: true,
    host: baseUrl,
    chrome: chromePath,
    profileDir,
    packagePath,
    entryPath: manifest.entryPath,
    version: manifest.version,
  }, null, 2))
}

try {
  if (command === 'init') await initializeBrowser()
  else if (command === 'upload-verify') await uploadAndVerify()
  else if (command === 'self-test') selfTest()
  else throw new Error(`Unknown command: ${command}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
