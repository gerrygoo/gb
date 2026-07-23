import { mount } from 'svelte'
import './app.css'
import GifApp from './GifApp.svelte'

const app = mount(GifApp, {
  target: document.getElementById('app')!,
})

export default app
