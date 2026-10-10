import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { initVConsole } from './lib/vconsole.js';
import './styles/tokens.css';
import './styles/app.css';

function mount() {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <BrowserRouter basename="/h5">
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

/* vConsole 就绪（或不需要）后再挂页面，保证进站日志能看见 */
initVConsole().finally(mount);
