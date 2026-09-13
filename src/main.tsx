import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import './style.css';
import './platform.css';
import { isDesktop } from './lib/transport';

document.documentElement.dataset.platform = isDesktop ? 'desktop' : 'web';
const Router = isDesktop ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>,
);
