import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const mountNode = document.getElementById('app');
if (!mountNode) {
  throw new Error('Cannot find #app mount node');
}

createRoot(mountNode).render(createElement(App));
