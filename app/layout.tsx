import type { Metadata, Viewport } from "next";
import { Zen_Kaku_Gothic_New, DM_Mono } from "next/font/google";
import { BottomTabBar } from "../components/BottomTabBar";
import { PullToRefresh } from "../components/PullToRefresh";
import "./globals.css";

const zenKaku = Zen_Kaku_Gothic_New({
  variable: "--font-zen-kaku",
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "競輪予想",
  description: "ライン・脚質実力・データ統計の3本柱で競輪を予想する個人用アプリ",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "競輪予想",
  },
  icons: {
    icon: [
      { url: "/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#06070A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${zenKaku.variable} ${dmMono.variable} h-full antialiased`}
    >
      {/* pb-16はBottomTabBar（固定表示、下部セーフエリア込み）の高さぶんの余白。
          ページ本文がタブに隠れないようにbody側で確保する。 */}
      <body className="min-h-full flex flex-col bg-gray-50 dark:bg-gray-950 pb-16">
        <PullToRefresh>{children}</PullToRefresh>
        <BottomTabBar />
      </body>
    </html>
  );
}
