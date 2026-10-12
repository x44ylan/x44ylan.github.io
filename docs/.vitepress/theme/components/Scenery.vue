<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useData } from 'vitepress'

const { isDark } = useData()
const host = ref<HTMLDivElement>()
const state = ref('loading')
let disposed = false
let cleanup = () => {}
let updateTheme = () => {}
watch(isDark, () => updateTheme())

onMounted(async () => {
  try {
    // Only homepage visitors load Three.js; nothing touches WebGL during SSR.
    const THREE = await import('three')
    if (disposed || !host.value) return
    const element = host.value
    const touch = window.matchMedia('(pointer: coarse)')
    const renderer = new THREE.WebGLRenderer({ antialias: !touch.matches, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, touch.matches ? 1 : 1.5))
    element.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 650)
    const geometry = new THREE.PlaneGeometry(360, 350, touch.matches ? 96 : 160, touch.matches ? 84 : 140)
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(0, 0, -85)
    const positions = geometry.attributes.position
    const peaks = [
      [-110, -65, 54, 36], [-65, -145, 67, 40], [12, -205, 63, 38],
      [88, -140, 78, 40], [125, -40, 58, 38], [-100, 65, 34, 45], [115, 65, 35, 45],
    ]
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i)
      const z = positions.getZ(i)
      let height = 0
      for (const [px, pz, elevation, spread] of peaks) {
        height += elevation * Math.exp(-((x - px) ** 2 + (z - pz) ** 2) / (2 * spread ** 2))
      }
      const ridge = Math.sin(x * .12 + z * .04) * Math.cos(z * .1)
        + .5 * Math.sin(x * .28 - z * .19) + .25 * Math.cos(x * .57 + z * .32)
      positions.setY(i, height + ridge * Math.min(height * .16, 5))
    }
    geometry.computeVertexNormals()
    const colours = new THREE.BufferAttribute(new Float32Array(positions.count * 3), 3)
    geometry.setAttribute('color', colours)
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 })
    scene.add(new THREE.Mesh(geometry, material))
    const ambient = new THREE.HemisphereLight(0xffffff, 0x475569, 2)
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(-100, 140, 30)
    scene.add(ambient, sun)

    let contextLost = false
    camera.position.set(0, 27, 95)
    camera.lookAt(0, 66, -110)
    const render = () => {
      if (disposed || contextLost) return
      renderer.render(scene, camera)
      state.value = 'ready'
    }
    updateTheme = () => {
      const dark = isDark.value
      const background = new THREE.Color(dark ? '#0d1117' : '#ffffff')
      scene.background = background
      scene.fog = new THREE.Fog(background, 95, dark ? 330 : 360)
      ambient.intensity = dark ? 1.1 : 2
      sun.intensity = dark ? 1.4 : 2
      const low = new THREE.Color(dark ? '#192735' : '#9eacbb')
      const high = new THREE.Color(dark ? '#6e8298' : '#e7edf3')
      const colour = new THREE.Color()
      for (let i = 0; i < positions.count; i++) {
        colour.copy(low).lerp(high, Math.min(1, positions.getY(i) / 90))
        colours.setXYZ(i, colour.r, colour.g, colour.b)
      }
      colours.needsUpdate = true
      render()
    }
    const resize = () => {
      const { width, height } = element.getBoundingClientRect()
      if (!width || !height) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      render()
    }
    const lost = (event: Event) => {
      event.preventDefault()
      contextLost = true
      state.value = 'fallback'
    }
    const restored = () => { contextLost = false; resize(); updateTheme() }
    const resizeObserver = new ResizeObserver(resize)
    cleanup = () => {
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      renderer.domElement.removeEventListener('webglcontextrestored', restored)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
    renderer.domElement.addEventListener('webglcontextlost', lost)
    renderer.domElement.addEventListener('webglcontextrestored', restored)
    resizeObserver.observe(element)
    updateTheme()
    resize()
  } catch {
    cleanup()
    if (!disposed) state.value = 'fallback'
  }
})

onUnmounted(() => { disposed = true; cleanup(); updateTheme = () => {} })
</script>

<template>
  <div ref="host" class="home-scenery" :data-scene="state" aria-hidden="true" />
</template>
