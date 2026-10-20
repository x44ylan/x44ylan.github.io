<script setup lang="ts">
import Scenery from './Scenery.vue'
import type { SceneTheme } from '../sharks/scenes'
import { useData } from 'vitepress'
import VPSocialLinks from 'vitepress/dist/client/theme-default/components/VPSocialLinks.vue'

defineProps<{ scene?: SceneTheme | 'sharks' }>()
const { theme } = useData()
</script>

<template>
  <main class="home">
    <Scenery :theme="scene" />
    <header class="home-heading">
      <h1>x44ylan<span>.</span></h1>
      <VPSocialLinks class="home-socials" :links="theme.socialLinks" />
    </header>
  </main>
</template>
