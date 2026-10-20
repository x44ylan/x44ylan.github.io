<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import { OceanEngine, type SharkSpec } from '../sharks'
import { SceneEngine, type SceneTheme } from '../sharks/scenes'

const props = withDefaults(defineProps<{ theme?: SceneTheme | 'sharks' }>(), { theme: 'debris' })

const { isDark } = useData()
const host = ref<HTMLDivElement>()
const state = ref('loading')
let disposed = false
let cleanup = () => {}
let updateTheme = () => {}
watch(isDark, () => updateTheme())

const APEX_SHARKS: SharkSpec[] = [
  { kind: 'classic', size: 1 },
  { kind: 'thresher', size: 0.92 },
  { kind: 'tiger', size: 0.85 },
  { kind: 'mako', size: 0.78 },
]

onMounted(() => {
  try {
    if (disposed || !host.value) return
    const element = host.value
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    element.appendChild(canvas)

    const engine = props.theme === 'sharks'
      ? new OceanEngine(canvas, APEX_SHARKS, isDark.value)
      : new SceneEngine(canvas, props.theme, isDark.value)
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
