import type { ReactNode } from "react";
import "./globals.css";
import "streamdown/styles.css";

export const metadata = {
  title: "Lume",
  description: "Lume Desktop Agent"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
