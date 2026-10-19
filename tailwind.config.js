/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          dark: "#0f5132",
          DEFAULT: "#1a7a4f",
          light: "#2a9d6f",
        },
      },
      fontFamily: {
        sans: ["PingFang SC", "Microsoft YaHei", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
