import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
// Sync system dark mode to <html> class
const mq = window.matchMedia('(prefers-color-scheme: dark)');
document.documentElement.classList.toggle('dark', mq.matches);
mq.addEventListener('change', (e) => document.documentElement.classList.toggle('dark', e.matches));
ReactDOM.createRoot(document.getElementById('root')).render(_jsx(React.StrictMode, { children: _jsx(App, {}) }));
