import "./globals.css";

export const metadata = {
  title: "Life Log",
  description: "주간 업무 정리 대시보드",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
