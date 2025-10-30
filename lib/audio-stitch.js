import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

ffmpeg.setFfmpegPath(ffmpegPath);

async function padClipToTenSeconds(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters('apad')
      .duration(10)
      .outputOptions('-y')
      .audioCodec('libmp3lame')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

export async function buildVoiceover(clips, { workingDir, outputPath }) {
  if (!clips.length) {
    throw new Error('No audio clips provided for voiceover');
  }

  const paddedPaths = [];
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const paddedPath = path.join(workingDir, `clip-${i + 1}-10s.mp3`);
    await padClipToTenSeconds(clip.filePath, paddedPath);
    paddedPaths.push(paddedPath);
  }

  const concatListPath = path.join(workingDir, 'voiceover-concat.txt');
  const concatBody = paddedPaths
    .map((p) => `file '${p.replace(/\\/g, '/')}'`)
    .join('\n');
  await fs.writeFile(concatListPath, concatBody, 'utf8');

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy', '-y'])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });

  return { filePath: outputPath, duration: clips.length * 10 };
}
