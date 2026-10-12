import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AELUNE · Beauty, seen differently",
  description:
    "Explore your personal palette, makeup, hair and jewelry ideas, with matching lip shades registered by your store.",
  icons: { icon: "/brand/aelune-mark.svg" },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
