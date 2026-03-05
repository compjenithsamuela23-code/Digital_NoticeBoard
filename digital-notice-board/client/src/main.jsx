import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { API_BASE_URL } from './config/api'

function ensureApiPreconnect() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }
  let apiOrigin = ''
  try {
    apiOrigin = new URL(API_BASE_URL).origin
  } catch {
    return
  }
  if (!apiOrigin || apiOrigin === window.location.origin) {
    return
  }

  const relValues = ['dns-prefetch', 'preconnect']
  relValues.forEach((rel) => {
    const existing = document.querySelector(`link[rel="${rel}"][href="${apiOrigin}"]`)
    if (existing) return
    const link = document.createElement('link')
    link.rel = rel
    link.href = apiOrigin
    if (rel === 'preconnect') {
      link.crossOrigin = 'anonymous'
    }
    document.head.appendChild(link)
  })
}

ensureApiPreconnect()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
