import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'assets/codexy-icon-source.png');
const source = PNG.sync.read(readFileSync(sourcePath));

if (source.width !== source.height) {
  throw new Error('Codexy icon source must be square');
}

function sample(channel, x, y) {
  const clampedX = Math.max(0, Math.min(source.width - 1, x));
  const clampedY = Math.max(0, Math.min(source.height - 1, y));
  return source.data[(clampedY * source.width + clampedX) * 4 + channel];
}

function sampleBilinear(channel, sourceX, sourceY) {
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = sourceX - x0;
  const fy = sourceY - y0;
  const top =
    sample(channel, x0, y0) * (1 - fx) +
    sample(channel, x1, y0) * fx;
  const bottom =
    sample(channel, x0, y1) * (1 - fx) +
    sample(channel, x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function resizeForAppIcon(size) {
  const output = new PNG({ width: size, height: size });
  const scale = source.width / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x + 0.5) * scale - 0.5;
      const sourceY = (y + 0.5) * scale - 0.5;
      const offset = (y * size + x) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        output.data[offset + channel] = Math.round(
          sampleBilinear(channel, sourceX, sourceY),
        );
      }
      // Keep the supplied RGB artwork unchanged while making platform exports
      // opaque. iOS app icons cannot retain the source PNG's alpha channel.
      output.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(output);
}

function resizeForTransparentMark(size, color) {
  const output = new PNG({ width: size, height: size });
  const scale = source.width / size;
  // The supplied artwork is a black mark on a nearly white background.
  // Mapping luminance to alpha preserves its antialiased edges while removing
  // the pale backdrop required to make Android adaptive/themed icons work.
  const blackPoint = 24;
  const whitePoint = 240;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x + 0.5) * scale - 0.5;
      const sourceY = (y + 0.5) * scale - 0.5;
      const offset = (y * size + x) * 4;
      const red = sampleBilinear(0, sourceX, sourceY);
      const green = sampleBilinear(1, sourceX, sourceY);
      const blue = sampleBilinear(2, sourceX, sourceY);
      const sourceAlpha =
        sampleBilinear(3, sourceX, sourceY) / 255;
      const luminance =
        red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const markAlpha = Math.max(
        0,
        Math.min(1, (whitePoint - luminance) / (whitePoint - blackPoint)),
      );

      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
      output.data[offset + 3] = Math.round(
        255 * sourceAlpha * markAlpha,
      );
    }
  }
  return PNG.sync.write(output);
}

function solidColor(size, color) {
  const output = new PNG({ width: size, height: size });
  for (let offset = 0; offset < output.data.length; offset += 4) {
    output.data[offset] = color[0];
    output.data[offset + 1] = color[1];
    output.data[offset + 2] = color[2];
    output.data[offset + 3] = 255;
  }
  return PNG.sync.write(output);
}

const outputs = [
  ['assets/icon.png', 1024],
  ['assets/favicon.png', 64],
  ['assets/splash-icon.png', 512],
  ['public/apple-touch-icon-180.png', 180],
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
];

for (const [relativePath, size] of outputs) {
  const outputPath = resolve(root, relativePath);
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, resizeForAppIcon(size));
}
writeFileSync(
  resolve(root, 'assets/android-icon-foreground.png'),
  resizeForTransparentMark(1024, [0, 0, 0]),
);
writeFileSync(
  resolve(root, 'assets/android-icon-monochrome.png'),
  resizeForTransparentMark(432, [255, 255, 255]),
);
writeFileSync(
  resolve(root, 'assets/android-icon-background.png'),
  solidColor(512, [255, 255, 255]),
);
console.log(
  'Generated all Codexy app and PWA icons from the approved source artwork.',
);
