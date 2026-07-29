import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { PNG } from 'pngjs';
import { toQR } from 'toqr';

const previewUrl = process.argv[2] ?? process.env.CODEXY_PREVIEW_URL;
const outputPath = resolve(
  process.argv[3] ?? '.expo/codexy-iphone-preview-qr.png',
);

if (!previewUrl || !/^https?:\/\/\S+$/i.test(previewUrl)) {
  console.error(
    'Usage: node scripts/generate-test-qr.mjs http://YOUR_LAN_IP:8084 [output.png]',
  );
  process.exit(1);
}

const matrix = toQR(previewUrl);
const matrixSize = Math.sqrt(matrix.length);
if (!Number.isInteger(matrixSize)) {
  throw new Error('QR encoder returned an invalid matrix');
}

const quietZone = 4;
const scale = 10;
const imageSize = (matrixSize + quietZone * 2) * scale;
const png = new PNG({
  width: imageSize,
  height: imageSize,
  colorType: 6,
});

png.data.fill(255);
for (let row = 0; row < matrixSize; row += 1) {
  for (let column = 0; column < matrixSize; column += 1) {
    if (!matrix[row * matrixSize + column]) continue;
    const startX = (column + quietZone) * scale;
    const startY = (row + quietZone) * scale;
    for (let y = startY; y < startY + scale; y += 1) {
      for (let x = startX; x < startX + scale; x += 1) {
        const offset = (y * imageSize + x) * 4;
        png.data[offset] = 17;
        png.data[offset + 1] = 17;
        png.data[offset + 2] = 17;
        png.data[offset + 3] = 255;
      }
    }
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, PNG.sync.write(png));
console.log(`QR ready: ${outputPath}`);
console.log(`Target: ${previewUrl}`);
