import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

ffmpeg.setFfmpegPath(ffmpegPath);

export async function renderLocalVideo({ slides, voiceoverPath, outputPath, fps }) {
  if (!slides.length) {
    throw new Error('No slides provided for local render');
  }
  const concatPath = path.join(path.dirname(outputPath), 'slides.txt');
  const lines = [];
  slides.forEach((entry, idx) => {
    const imgPath = entry.localPath.replace(/\\/g, '/');
    const duration =
      Number.isFinite(entry.duration) && entry.duration > 0 ? Number(entry.duration) : 10;
    lines.push(`file '${imgPath}'`);
    lines.push(`duration ${duration}`);
  });
  const lastPath = slides[slides.length - 1].localPath.replace(/\\/g, '/');
  lines.push(`file '${lastPath}'`);
  await fs.writeFile(concatPath, lines.join('\n'), 'utf8');

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatPath)
      .inputOptions(['-f concat', '-safe 0'])
      .input(voiceoverPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-pix_fmt yuv420p', `-r ${fps}`, '-shortest', '-movflags +faststart'])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });

  return outputPath;
}
