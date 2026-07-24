import sharp from "sharp";

export const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0d1117"/>
  <g fill="none" stroke="#f78166" stroke-width="34" stroke-linecap="round">
    <path d="M150 120 L190 300"/>
    <path d="M256 110 L256 300"/>
    <path d="M362 120 L322 300"/>
  </g>
  <g fill="#f78166">
    <circle cx="188" cy="330" r="26"/>
    <circle cx="256" cy="342" r="26"/>
    <circle cx="324" cy="330" r="26"/>
  </g>
</svg>`;

export const WEB_MANIFEST = JSON.stringify({
  name: "Claws",
  short_name: "Claws",
  description: "Claws GitHub automation dashboard",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0d1117",
  theme_color: "#0d1117",
  icons: [
    { src: "/static/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/static/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
});

const iconCache = new Map<number, Promise<Buffer>>();

export function getAppIconPng(size: number): Promise<Buffer> {
  let p = iconCache.get(size);
  if (!p) {
    p = sharp(Buffer.from(APP_ICON_SVG)).resize(size, size).png().toBuffer();
    iconCache.set(size, p);
  }
  return p;
}
