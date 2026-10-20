<script setup lang="ts">
// Unlisted explorer for the scenery themes. Not linked from the site, excluded
// from the sitemap and marked noindex in docs/themes.md.
const themes = [
  { path: 'debris', name: 'Orbital debris', note: 'Planet, space station and satellites', current: true },
  { path: 'train', name: 'Night train', note: 'City skyline from a moving train' },
  { path: 'sharks', name: 'Sharks', note: 'Sharks hunting schools of fish' },
  { path: 'fireflies', name: 'Fireflies', note: 'Meadow, pond and blinking fireflies' },
  { path: 'rain', name: 'Rainy alley', note: 'Neon signs, puddles and a passing car' },
]
</script>

<template>
  <main class="themes">
    <header class="themes-head">
      <a class="themes-back" href="/">x44ylan<span>.</span></a>
      <h1>themes</h1>
      <p>Hidden scenery previews. The homepage uses the one marked <em>live</em>.</p>
    </header>
    <ol class="themes-list">
      <li v-for="(t, i) in themes" :key="t.path">
        <a :href="`/${t.path}`">
          <span class="themes-num">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="themes-name">{{ t.name }}</span>
          <span class="themes-note">{{ t.note }}</span>
          <span class="themes-path">/{{ t.path }}<b v-if="t.current">live</b></span>
        </a>
      </li>
    </ol>
  </main>
</template>
