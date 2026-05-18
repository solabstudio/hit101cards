// generate-icons.mjs
// Android Chrome PWA インストール用の icon-192.png / icon-512.png を生成。
// (apple-touch-icon.png と og-image.png は既存のものを利用。)
// 使い方: cd client && npm install --no-save sharp && node scripts/generate-icons.mjs

import sharp from 'sharp';

// favicon.svg と同じデザインで PWA 用アイコンを生成
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="80" fill="#1e293b"/>
  <rect x="48" y="48" width="416" height="416" rx="48" fill="#f8fafc"/>
  <text x="256" y="336" font-family="'Helvetica Neue', Arial, sans-serif" font-size="208" font-weight="900" text-anchor="middle" fill="#dc2626">101</text>
</svg>`;

await sharp(Buffer.from(iconSvg))
  .resize(192, 192)
  .png()
  .toFile('public/icon-192.png');
console.log('✓ public/icon-192.png');

await sharp(Buffer.from(iconSvg))
  .resize(512, 512)
  .png()
  .toFile('public/icon-512.png');
console.log('✓ public/icon-512.png');
