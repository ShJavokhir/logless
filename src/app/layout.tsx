import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "logless · Muse",
  description:
    "Explore aggregate assistant workflows. A frontend prototype with authored mock data.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
