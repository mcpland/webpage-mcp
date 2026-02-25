import App from './App.vue';
import { mountVueInReact } from '../shared/react/mount-vue-in-react';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';

void mountVueInReact(App);
