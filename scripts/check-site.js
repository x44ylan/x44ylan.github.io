// E2E checks for missing assets, stale study routes, clipped controls, overflow,
// broken themes, unintended mountain motion, WebGL failure and leaked scene resources.
// Run against a built preview with playwright-cli run-code --filename.
async page => {
  const origin = await page.evaluate(() => location.origin)
  const screenshots = '/tmp/landing-check'
  const failures = []
  const runtimeErrors = []
  page.on('pageerror', error => runtimeErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    window.__sceneDraws = 0
    const draw = WebGL2RenderingContext.prototype.drawElements
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      window.__sceneDraws++
      return draw.apply(this, args)
    }
  })

  const routes = await page.evaluate(async () => {
    const text = await fetch('/sitemap.xml').then(response => response.text())
    return [...new DOMParser().parseFromString(text, 'application/xml').querySelectorAll('loc')]
      .map(node => new URL(node.textContent).pathname)
  })
  if (routes.length !== 1 || routes[0] !== '/') failures.push(`Unexpected pages: ${routes.join(', ')}`)

  for (const width of [320, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(origin + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await page.locator('.home-scenery[data-scene="ready"]').waitFor()
    if (!await page.locator('.home-heading h1').isVisible()) failures.push(`Identity missing: ${width}px`)
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) failures.push(`Overflow: ${width}px`)
    if (await page.locator('.home-socials a:visible').count() !== 3) failures.push(`Social controls missing: ${width}px`)
    if (!await page.locator('.appearance .VPSwitchAppearance').isVisible()) failures.push(`Theme switch missing: ${width}px`)
    if (await page.locator('.VPNavBarHamburger:visible, .VPSidebar:visible, .VPNavBarMenu a:visible, .VPNavBarSearch button:visible').count()) failures.push(`Study navigation remains: ${width}px`)
    const placement = await page.locator('.home-heading').evaluate(heading => {
      const title = heading.querySelector('h1').getBoundingClientRect()
      const socials = heading.querySelector('.home-socials').getBoundingClientRect()
      const links = [...heading.querySelectorAll('.home-socials a')]
      return {
        below: socials.top >= title.bottom + 12,
        centered: Math.abs((socials.left + socials.width / 2) - (title.left + title.width / 2)) < 1,
        usable: links.every(link => {
          const box = link.getBoundingClientRect()
          const icon = link.querySelector('span')
          const mask = icon && getComputedStyle(icon).maskImage
          return box.width >= 44 && box.height >= 44 && mask && mask !== 'none'
        }),
      }
    })
    if (!placement.below || !placement.centered || !placement.usable) failures.push(`Social icon placement incorrect: ${width}px ${JSON.stringify(placement)}`)
    if (await page.locator('.home-interests, .VPNavBar').count()) failures.push(`Old text or navbar remains: ${width}px`)
    const appearance = await page.locator('.appearance').boundingBox()
    if (!appearance || appearance.x + appearance.width > width || appearance.y < 0) failures.push(`Theme control clipped: ${width}px`)
    const socials = await page.locator('.home-socials a').evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('aria-label'), url: element.href })))
    if (socials.map(link => link.label).join(',') !== 'GitHub,LinkedIn,Discord' || socials.some(link => !link.url.startsWith('https://'))) failures.push(`Social links incorrect: ${width}px`)

    for (const dark of [false, true]) {
      if (await page.evaluate(() => document.documentElement.classList.contains('dark')) !== dark) {
        await page.locator('.appearance .VPSwitchAppearance').click()
      }
      const theme = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        bg: getComputedStyle(document.documentElement).getPropertyValue('--vp-c-bg').trim(),
        chrome: document.querySelector('meta[name="theme-color"]').content,
      }))
      if (theme.dark !== dark || theme.bg !== (dark ? '#0d1117' : '#fff') || theme.chrome !== (dark ? '#0d1117' : '#ffffff')) failures.push(`Theme mismatch: ${width}px ${JSON.stringify(theme)}`)
      if (width === 1440) await page.screenshot({ path: `${screenshots}/desktop-${dark ? 'dark' : 'light'}.png` })
    }
    if (width === 390) await page.screenshot({ path: `${screenshots}/phone.png` })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.locator('.home-scenery[data-scene="ready"]').waitFor()
  await page.waitForTimeout(250)
  const staticDraws = await page.evaluate(() => window.__sceneDraws)
  await page.waitForTimeout(200)
  if (await page.evaluate(() => window.__sceneDraws) !== staticDraws) failures.push('Static mountain redraws while idle')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForTimeout(250)
  const idleDraws = await page.evaluate(() => window.__sceneDraws)
  await page.mouse.move(100, 700)
  await page.mouse.move(1300, 300)
  await page.waitForTimeout(500)
  if (await page.evaluate(() => window.__sceneDraws) !== idleDraws) failures.push('Mountain still animates or follows the cursor')
  await page.evaluate(() => {
    const gl = document.querySelector('.home-scenery canvas').getContext('webgl2')
    window.__loseScene = gl.getExtension('WEBGL_lose_context')
    window.__loseScene.loseContext()
  })
  await page.locator('.home-scenery[data-scene="fallback"]').waitFor()
  await page.evaluate(() => window.__loseScene.restoreContext())
  await page.locator('.home-scenery[data-scene="ready"]').waitFor()

  for (const path of ['/labs/', '/gyms/', '/blogs/', '/labs/mobile/']) {
    const response = await page.goto(origin + path, { waitUntil: 'networkidle' })
    await page.getByText('Page not found', { exact: true }).waitFor()
    if (await page.locator('.vp-doc').count()) failures.push(`Study page remains: ${path}`)
    if (response && response.status() !== 404 && !await page.locator('.NotFound').count()) failures.push(`Old route still resolves: ${path}`)
  }

  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.locator('.home-scenery[data-scene="ready"]').waitFor()
  // Exercise the client-side route teardown rather than a full page reload.
  await page.evaluate(() => {
    const link = document.createElement('a')
    link.href = '/missing-page'
    link.textContent = 'Route check'
    link.id = 'route-check'
    document.body.appendChild(link)
  })
  await page.locator('#route-check').click()
  await page.getByText('Page not found', { exact: true }).waitFor()
  await page.locator('.home-scenery').waitFor({ state: 'detached' })
  const stoppedDraws = await page.evaluate(() => window.__sceneDraws)
  await page.waitForTimeout(150)
  if (await page.evaluate(() => window.__sceneDraws) !== stoppedDraws) failures.push('Scene continues drawing after leaving home')
  await page.getByRole('link', { name: 'Go home' }).click()
  await page.locator('.home-scenery[data-scene="ready"]').waitFor()
  if (await page.locator('.home-scenery canvas').count() !== 1) failures.push('Scene duplicated after returning home')
  await page.evaluate(() => document.querySelector('#route-check')?.remove())

  const fallbackPage = await page.context().newPage()
  fallbackPage.on('pageerror', error => runtimeErrors.push(error.message))
  await fallbackPage.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return String(type).startsWith('webgl') ? null : getContext.call(this, type, ...args)
    }
  })
  await fallbackPage.goto(origin + '/', { waitUntil: 'networkidle' })
  await fallbackPage.locator('.home-scenery[data-scene="fallback"]').waitFor()
  if (!await fallbackPage.locator('.home-heading h1').isVisible() || !await fallbackPage.locator('.appearance .VPSwitchAppearance').isVisible()) failures.push('WebGL fallback hides homepage controls')
  await fallbackPage.close()

  failures.push(...runtimeErrors.map(error => `Browser error: ${error}`))
  const report = { origin, pages: routes.length, widths: [320, 390, 768, 1440, 1920], failures, screenshots }
  if (failures.length) throw new Error(JSON.stringify(report, null, 2))
  return report
}
