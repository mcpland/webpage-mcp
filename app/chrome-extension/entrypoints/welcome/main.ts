import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { getMessage } from '@/utils/i18n';
import App from './App';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';

const mountNode = document.getElementById('app');
if (!mountNode) {
  throw new Error('Cannot find #app mount node');
}

document.title = getMessage(
  'welcomePageTitle',
  undefined,
  'Welcome - Webpage MCP Connector',
);

createRoot(mountNode).render(createElement(App));
