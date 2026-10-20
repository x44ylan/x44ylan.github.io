import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'x44ylan',
  description: 'Hello World',
  lang: 'en',
  cleanUrls: true,
  appearance: 'dark',
  // Theme preview routes (/fireflies, /sharks, ...) stay reachable but unlisted.
  sitemap: {
    hostname: 'https://x44ylan.com',
    transformItems: (items) => items.filter((item) => new URL(item.url, 'https://x44ylan.com').pathname === '/'),
  },
  head: [
    ['link', { rel: 'icon', href: '/assets/img/r.png', type: 'image/png' }],
    ['meta', { name: 'theme-color', content: '#0d1117' }],
  ],
  transformHead() {
    return [['link', { rel: 'canonical', href: 'https://x44ylan.com/' }]]
  },
  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/x44ylan', ariaLabel: 'GitHub' },
      { icon: 'linkedin', link: 'https://www.linkedin.com/in/dylan-liew/', ariaLabel: 'LinkedIn' },
      { icon: 'discord', link: 'https://discordapp.com/users/424807602304843776', ariaLabel: 'Discord' },
    ],
  },
})
