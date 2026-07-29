import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'assets/codexy-icon-source.png');
const outputDirectory = resolve(root, 'public');
const source = PNG.sync.read(readFileSync(sourcePath));

if (source.width !== source.height) {
  throw new Error('Codexy icon source must be square');
}

function sample(channel, x, y) {
  const clampedX = Math.max(0, Math.min(source.width - 1, x));
  const clampedY = Math.max(0, Math.min(source.height - 1, y));
  return source.data[(clampedY * source.width + clampedX) * 4 + channel];
}

function resize(size) {
  const output = new PNG({ width: size, height: size });
  const scale = source.width / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x + 0.5) * scale - 0.5;
      const sourceY = (y + 0.5) * scale - 0.5;
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const fx = sourceX - x0;
      const fy = sourceY - y0;
      const offset = (y * size + x) * 4;

      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          sample(channel, x0, y0) * (1 - fx) +
          sample(channel, x1, y0) * fx;
        const bottom =
          sample(channel, x0, y1) * (1 - fx) +
          sample(channel, x1, y1) * fx;
        output.data[offset + channel] = Math.round(
          top * (1 - fy) + bottom * fy,
        );
      }
    }
  }
  return PNG.sync.write(output);
}

mkdirSync(outputDirectory, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(resolve(outputDirectory, `icon-${size}.png`), resize(size));
}
console.log('Generated Codexy PWA icons from the approved source artwork.');
