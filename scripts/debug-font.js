import fs from 'fs/promises';
import path from 'path';

import { renderSlideSVG } from '../slide-svg.js';

async function main() {
  const outputDir = path.resolve('tmp');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'font-debug.png');

  const buffer = await renderSlideSVG({
    width: 1080,
    height: 1080,
    orientation: '16:9',
    headline: 'Outfit font check',
    paragraphs: [
      'This line should render with Outfit Bold.',
      'Bold headline above uses the same embedded font.',
      'If you see a different typeface, the embed is not taking effect.'
    ]
  });

  await fs.writeFile(outputPath, buffer);
  console.log(`Wrote font debug image to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

