import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'x44ylan',
  description: 'Personal site of Dylan Liew.',
  lang: 'en',
  cleanUrls: true,
  appearance: 'dark',
  sitemap: { hostname: 'https://x44ylan.com' },
  head: [
    ['link', { rel: 'icon', href: '/assets/img/r.png', type: 'image/png' }],
    ['meta', { name: 'theme-color', content: '#0d1117' }],
  ],
  transformHead({ pageData }) {
    const path = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '')
    return [['link', { rel: 'canonical', href: `https://x44ylan.com/${path}` }]]
  },
  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/x44ylan', ariaLabel: 'GitHub' },
      { icon: 'linkedin', link: 'https://www.linkedin.com/in/dylan-liew/', ariaLabel: 'LinkedIn' },
      { icon: 'discord', link: 'https://discordapp.com/users/424807602304843776', ariaLabel: 'Discord' },
    ],
  },
})
