import type { Config } from 'tailwindcss';

// Tailwind v4 config (TypeScript). The Vite plugin `@tailwindcss/vite`
// will auto-detect and load this file. No `content` field is required in v4.
export default {
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#7C3AED',
          dark: '#5B21B6',
          light: '#A78BFA',
        },
      },
      boxShadow: {
        card: '0 6px 20px rgba(0,0,0,0.08)',
      },
      borderRadius: {
        xl: '12px',
      },
    },
  },
  plugins: [],
} satisfies Config;
