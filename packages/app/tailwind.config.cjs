/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        // Semantic status (docs/design-system.md): amber only ever means
        // "needs you"; mint doubles as ok; error covers failures/destructive.
        status: {
          needsYou: "hsl(var(--status-needs-you))",
          ok: "hsl(var(--status-ok))",
          error: "hsl(var(--status-error))",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          '"Segoe UI"',
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          '"JetBrains Mono"',
          "Menlo",
          "SFMono-Regular",
          "monospace",
        ],
      },
      transitionDuration: {
        DEFAULT: "120ms",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0, 0, 0.2, 1)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
