// Mobile E2E: the mountain must stay static without ongoing rendering,
// survive touch theme changes, resize, and recover after context loss.
async page => {
  const origin = await page.evaluate(() => location.origin)
  const context = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, reducedMotion: 'no-preference',
  })
  const mobile = await context.newPage()
  const errors = []
  mobile.on('pageerror', error => errors.push(error.message))
  await mobile.addInitScript(() => {
    window.__sceneDraws = 0
    const draw = WebGL2RenderingContext.prototype.drawElements
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      window.__sceneDraws++
      return draw.apply(this, args)
    }
  })
  try {
    await mobile.goto(origin + '/', { waitUntil: 'networkidle' })
    await mobile.locator('.home-scenery[data-scene="ready"]').waitFor()
    await mobile.evaluate(() => document.fonts.ready)
    await mobile.waitForTimeout(500)
    const before = await mobile.evaluate(() => window.__sceneDraws)
    const first = await mobile.screenshot({ path: '/tmp/landing-check/mobile-static-before.png' })
    await mobile.waitForTimeout(1500)
    const last = await mobile.screenshot({ path: '/tmp/landing-check/mobile-static-after.png' })
    const idleDraws = await mobile.evaluate(before => window.__sceneDraws - before, before)
    if (idleDraws !== 0 || !first.equals(last)) throw new Error(`Mobile mountain is not static: ${idleDraws} idle draws`)
    const wasDark = await mobile.evaluate(() => document.documentElement.classList.contains('dark'))
    await mobile.locator('.appearance .VPSwitchAppearance').tap()
    if (await mobile.evaluate(() => document.documentElement.classList.contains('dark')) === wasDark) throw new Error('Touch theme switch failed')
    await mobile.locator('.home-scenery[data-scene="ready"]').waitFor()
    if (await mobile.evaluate(() => window.__sceneDraws) <= before) throw new Error('Mountain did not redraw for theme change')
    await mobile.setViewportSize({ width: 844, height: 390 })
    await mobile.waitForFunction(() => {
      const canvas = document.querySelector('.home-scenery canvas')
      return canvas.width === 844 && canvas.height === 390
    })
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.waitForFunction(() => document.querySelector('.home-scenery canvas').width === 390)
    await mobile.evaluate(() => {
      window.__lostContext = document.querySelector('.home-scenery canvas').getContext('webgl2').getExtension('WEBGL_lose_context')
      window.__lostContext.loseContext()
    })
    await mobile.locator('.home-scenery[data-scene="fallback"]').waitFor()
    await mobile.evaluate(() => window.__lostContext.restoreContext())
    await mobile.locator('.home-scenery[data-scene="ready"]').waitFor()
    if (errors.length) throw new Error(errors.join('\n'))
    return { origin, mobile: true, idleDraws, framesIdentical: true, touchThemeSwitch: 'passed', resize: 'passed', contextRecovery: 'passed', errors }
  } finally { await context.close() }
}
