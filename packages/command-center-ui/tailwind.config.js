/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        ink: { 950: '#0b0c10', 900: '#101116', 850: '#14151a', 800: '#1a1b21', 700: '#25262e', 600: '#33343d', 500: '#4a4b55', 400: '#7a7b85', 300: '#a3a4ad', 200: '#c9cad1', 100: '#ecedf1' },
        flame: { 400: '#ff8a4c', 500: '#ff6a1f', 600: '#e85a12' },
        series: { monthly: '#3987e5', annual: '#d95926' },
        status: { good: '#22b07d', warn: '#eda100', critical: '#d03b3b' },
      },
    },
  },
  plugins: [],
};
