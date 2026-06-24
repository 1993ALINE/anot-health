import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './pages/landscape-orientation.css'
import './pages/global.css'
import './pages/mobile-responsive-patch.css'
import './components/portal-calendar-strip.css'
import './pages/Admin/admin.css'
import './pages/portal-sidebar-indigo.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
