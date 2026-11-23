import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Automotive Feeds Generator",
  description:
    "Ubah foto studio mobil katalog menjadi foto komersial Instagram Feed (4:5 / 1:1) dengan latar AI yang realistis.",
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className="dark">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
