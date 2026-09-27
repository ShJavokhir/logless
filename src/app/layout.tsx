import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "logless · Assistant insights",
  description:
    "Explore aggregate assistant workflows. Published WildChat aggregates, live analysis, and fictional user stories.",
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
