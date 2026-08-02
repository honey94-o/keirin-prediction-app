import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "競輪予想アプリ",
    short_name: "競輪予想",
    description: "ライン・脚質実力・データ統計の3本柱で競輪を予想する個人用アプリ",
    start_url: "/",
    display: "standalone",
    background_color: "#0d5c3f",
    theme_color: "#0d5c3f",
    orientation: "portrait",
    icons: [
      {
        src: "/icon-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
