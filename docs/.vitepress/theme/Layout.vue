<script setup lang="ts">
import VPSwitchAppearance from 'vitepress/dist/client/theme-default/components/VPSwitchAppearance.vue'
import { onMounted, watch } from 'vue'
import { Content, useData } from 'vitepress'

const { isDark, page } = useData()
const setThemeColour = () => document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark.value ? '#0d1117' : '#ffffff')
watch(isDark, setThemeColour)
onMounted(setThemeColour)
</script>

<template>
  <div class="landing-layout">
    <div class="appearance"><VPSwitchAppearance /></div>
    <Content v-if="!page.isNotFound" />
    <main v-else class="NotFound">
      <h1>Page not found</h1>
      <a href="/">Go home</a>
    </main>
  </div>
</template>
