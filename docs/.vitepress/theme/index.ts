import type { Theme } from 'vitepress'
import Layout from './Layout.vue'
import Home from './components/Home.vue'
import 'vitepress/dist/client/theme-default/styles/base.css'
import 'vitepress/dist/client/theme-default/styles/icons.css'
import './style.css'

export default {
  Layout,
  enhanceApp({ app }) {
    app.component('LandingPage', Home)
  },
} satisfies Theme
