import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "./_components/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "CareLoop",
  description:
    "Portfolio demo of an AI-assisted psychiatric prescription-renewal loop. Synthetic data only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-surface px-4 py-2 font-semibold text-ink shadow-card focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to main content
        </a>
        <div
          role="note"
          className="bg-brand-900 px-4 py-1.5 text-center text-xs font-medium text-brand-50"
          data-testid="synthetic-banner"
        >
          Demo auth · Synthetic data only · HIPAA-aligned design, synthetic data
        </div>
        <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3 sm:px-8">
            <Link href="/" className="flex items-center gap-2.5 rounded-lg">
              <BrandMark />
              <span className="font-display text-xl font-semibold tracking-tight">CareLoop</span>
            </Link>
            <span className="rounded-full border border-line-strong bg-surface px-2.5 py-0.5 text-xs font-semibold text-muted">
              Synthetic demo
            </span>
          </div>
        </header>
        <div id="main" tabIndex={-1} className="outline-none">
          {children}
        </div>
      </body>
    </html>
  );
}
