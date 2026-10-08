import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { initVConsole } from './lib/vconsole.js';
import './styles/tokens.css';
import './styles/app.css';

initVConsole();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename="/h5">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
