import { mount } from 'svelte'
import './app.css'
import WebmApp from './WebmApp.svelte'

const app = mount(WebmApp, {
  target: document.getElementById('app')!,
})

export default app
