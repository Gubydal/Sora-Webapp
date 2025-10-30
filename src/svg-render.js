import fs from 'fs';
import path from 'path';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const FONT_FAMILY = 'Outfit';
const FONT_DIR = path.resolve('assets', 'fonts');
const FONT_FILES = (() => {
  try {
    return fs
      .readdirSync(FONT_DIR)
      .map((name) => path.join(FONT_DIR, name))
      .filter((filePath) => fs.statSync(filePath).isFile());
  } catch (err) {
    return [];
  }
})();
const RESVG_FONT_OPTIONS = {
  loadSystemFonts: false,
  fontDirs: [FONT_DIR],
  fontFiles: FONT_FILES,
  defaultFontFamily: FONT_FAMILY,
  sansSerifFamily: FONT_FAMILY
};

function parseBackground(background) {
  if (!background) {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }
  return background;
}

export async function renderSvgToPng(svg, { width, height, background = '#000000', flatten = true }) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: RESVG_FONT_OPTIONS
  });
  const pngData = resvg.render().asPng();

  let pipeline = sharp(pngData).resize({
    width,
    height,
    fit: 'contain',
    background: parseBackground(background)
  });

  if (flatten && background) {
    pipeline = pipeline.flatten({ background });
  }

  return pipeline.png().toBuffer();
}
