import "./globals.css";
import { Press_Start_2P } from "next/font/google";

const pixel = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pixel",
});

export const metadata = {
  title: "Life Log",
  description: "주간 업무 정리 대시보드",
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg" },
};

export const viewport = {
  themeColor: "#7c3aed",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body className={pixel.variable}>{children}</body>
    </html>
  );
}
