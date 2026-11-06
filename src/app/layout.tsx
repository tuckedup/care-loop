import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CareLoop",
  description:
    "Portfolio demo of an AI-assisted psychiatric prescription-renewal loop. Synthetic data only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <div
          role="note"
          className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900"
          data-testid="synthetic-banner"
        >
          Demo auth · Synthetic data only · HIPAA-aligned design, synthetic data
        </div>
        {children}
      </body>
    </html>
  );
}
