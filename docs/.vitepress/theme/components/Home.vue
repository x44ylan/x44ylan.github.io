<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useData } from 'vitepress'
import VPSocialLinks from 'vitepress/dist/client/theme-default/components/VPSocialLinks.vue'
import Scenery from './Scenery.vue'
import { pickRandomScene, type PixelScene } from '../scenery/engine'

const { theme } = useData()
const scene = ref<PixelScene>('forest')

let clicks = 0
let resetTimer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  scene.value = pickRandomScene()
})

onUnmounted(() => {
  if (resetTimer) clearTimeout(resetTimer)
})

function onNameClick() {
  clicks += 1
  if (resetTimer) clearTimeout(resetTimer)
  if (clicks >= 5) {
    clicks = 0
    scene.value = pickRandomScene(scene.value)
    return
  }
  resetTimer = setTimeout(() => {
    clicks = 0
  }, 1800)
}
</script>

<template>
  <main class="home">
    <Scenery :scene="scene" />
    <header class="home-heading">
      <h1 @click="onNameClick">x44ylan<span>.</span></h1>
      <VPSocialLinks class="home-socials" :links="theme.socialLinks" />
    </header>
  </main>
</template>
