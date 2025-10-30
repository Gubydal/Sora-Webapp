import fs from 'fs/promises';
import path from 'path';

import { composeSlideSVG } from '../slide-svg.js';

async function main() {
  const { svg } = await composeSlideSVG({
    width: 1280,
    height: 720,
    orientation: '16:9',
    headline: 'Font Debug Headline',
    paragraphs: [
      'This paragraph should render with the exact same Outfit styling.',
      'If you see a different font here, Resvg is falling back.',
      'Use this file to inspect the raw SVG and confirm font attributes.'
    ]
  });

  const outDir = path.resolve('tmp');
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, 'debug-slide.svg');
  await fs.writeFile(outputPath, svg, 'utf8');
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
