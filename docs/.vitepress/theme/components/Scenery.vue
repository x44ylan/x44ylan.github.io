<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import { OrbitEngine } from '../orbit/engine'

const { isDark } = useData()
const host = ref<HTMLDivElement>()
const state = ref('loading')
let disposed = false
let cleanup = () => {}
let updateTheme = () => {}
watch(isDark, () => updateTheme())

onMounted(() => {
  try {
    if (disposed || !host.value) return
    const element = host.value
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    element.appendChild(canvas)

    const engine = new OrbitEngine(canvas, isDark.value)
    const heading = element.parentElement?.querySelector<HTMLElement>('.home-heading')
    const updateAvoid = () => {
      if (!heading) return
      const sceneBox = canvas.getBoundingClientRect()
      const headingBox = heading.getBoundingClientRect()
      const pad = 18
      engine.setAvoidRect({
        x: headingBox.left - sceneBox.left - pad,
        y: headingBox.top - sceneBox.top - pad,
        width: headingBox.width + pad * 2,
        height: headingBox.height + pad * 2,
      })
    }
    const avoidObserver = new ResizeObserver(updateAvoid)
    avoidObserver.observe(element)
    if (heading) avoidObserver.observe(heading)
    updateAvoid()
    state.value = 'ready'

    updateTheme = () => {
      engine.setTheme(isDark.value)
    }

    cleanup = () => {
      avoidObserver.disconnect()
      engine.destroy()
      canvas.remove()
    }
  } catch {
    cleanup()
    if (!disposed) state.value = 'fallback'
  }
})

onUnmounted(() => {
  disposed = true
  cleanup()
  updateTheme = () => {}
})
</script>

<template>
  <div ref="host" class="home-scenery" :data-scene="state" aria-hidden="true" />
</template>
