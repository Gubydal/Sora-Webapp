import { fontCSS, fontMeta } from "./src/font-embed.js";
import { renderSvgToPng } from "./src/svg-render.js";

const BG_COLOR = "#204EA3";
const FG_COLOR = "#F5EF77";
const PAD = 64;
const FONT_FAMILY = "Outfit";

export async function composeSlideSVG(options = {}) {
  const width = Number.isFinite(options.width) ? options.width : 1920;
  const height = Number.isFinite(options.height) ? options.height : 1080;
  const orientation = normalizeOrientation(
    options.orientation ?? (width >= height ? "16:9" : "9:16")
  );
  const headline = String(options.headline ?? options.title ?? "").trim();

  const paragraphs = sanitizeParagraphs(
    Array.isArray(options.paragraphs)
      ? options.paragraphs
      : Array.isArray(options.textBlocks)
        ? options.textBlocks
        : Array.isArray(options.bullets)
          ? options.bullets
          : options.body
            ? String(options.body).split(/\n+/)
            : []
  );

  const imageBuffer = options.imageBuffer instanceof Buffer ? options.imageBuffer : null;
  const css = await fontCSS();
  const meta = await fontMeta();
  const headlineFontWeight = meta.headlineWeight;
  const bodyFontWeight = meta.bodyWeight;
  const isVariableFont = meta.isVariable;
  const showFrame = options.showFrame !== false;
  const showBullets = options.showBullets !== false;

  const headlineFontSize = orientation === "16:9" ? 72 : 68;
  const bodyFontSize = orientation === "16:9" ? 32 : 30;
  const headlineLines =
    orientation === "16:9"
      ? wrapHeadlineWithWidth(headline, width, headlineFontSize)
      : wrapText(headline, 20);

  const layout =
    orientation === "16:9"
      ? layoutHorizontal({
          width,
          height,
          headlineLines,
          paragraphs,
          headlineFontSize,
          bodyFontSize,
          headlineFontWeight,
          bodyFontWeight,
          isVariableFont,
          showBullets
        })
      : layoutVertical({
          width,
          height,
          headlineLines,
          paragraphs,
          headlineFontSize,
          bodyFontSize,
          headlineFontWeight,
          bodyFontWeight,
          isVariableFont,
          showBullets
        });

  const imageTag = imageBuffer
    ? `\n    <image href="data:image/png;base64,${imageBuffer.toString("base64")}"\n           x="${layout.frame.x + 6}" y="${layout.frame.y + 6}"\n           width="${layout.frame.width - 12}" height="${layout.frame.height - 12}"\n           preserveAspectRatio="xMidYMid meet"\n           clip-path="url(#imgClip)" filter="url(#softShadow)"/>\n`
    : "";
  const frameRect = showFrame
    ? `\n      <rect x="${layout.frame.x}" y="${layout.frame.y}" width="${layout.frame.width}" height="${layout.frame.height}" rx="28" ry="28" fill="none" stroke="${FG_COLOR}" stroke-width="6"/>\n`
    : "";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <style><![CDATA[
        ${css}
      ]]></style>
      <defs>
        <clipPath id="imgClip">
          <rect x="${layout.frame.x + 6}" y="${layout.frame.y + 6}" width="${layout.frame.width - 12}" height="${layout.frame.height - 12}" rx="22" ry="22"/>
        </clipPath>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity=".25"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="${BG_COLOR}"/>
      ${layout.textSvg}
      ${frameRect}
      ${imageTag}
    </svg>
  `;

  return { svg, width, height, background: BG_COLOR };
}

export async function renderSlideSVG(options = {}) {
  const { svg, width, height, background } = await composeSlideSVG(options);
  return renderSvgToPng(svg, { width, height, background, flatten: true });
}

function layoutHorizontal({
  width,
  height,
  headlineLines,
  paragraphs,
  headlineFontSize,
  bodyFontSize,
  headlineFontWeight,
  bodyFontWeight,
  isVariableFont,
  showBullets
}) {
  const textWidth = Math.round(width * 0.44);
  const textX = PAD;
  const headlineLineHeight = headlineFontSize * 1.05;
  const headlineGap = Math.max(bodyFontSize * 1.5, headlineFontSize * 0.9);

  const headlineSvg = renderTextBlock({
    x: textX,
    y: PAD,
    lines: headlineLines,
    fontSize: headlineFontSize,
    className: "hl",
    lineHeight: headlineLineHeight,
    fontWeight: headlineFontWeight,
    isVariable: isVariableFont
  });

  const textAfterHeadlineY = PAD + headlineLineHeight * headlineLines.length + headlineGap;

  const paragraphsResult = renderParagraphs({
    x: textX,
    startY: textAfterHeadlineY,
    width: textWidth,
    paragraphs,
    fontSize: bodyFontSize,
    lineHeight: bodyFontSize * 1.4,
    fontWeight: bodyFontWeight,
    isVariable: isVariableFont,
    includeBullets: showBullets
  });

  const frameWidth = Math.round(width - textWidth - PAD * 3);
  const frameHeight = Math.round(height - PAD * 2);
  const frameX = width - PAD - frameWidth;
  const frameY = PAD + Math.max(0, (height - PAD * 2 - frameHeight) / 2);

  return {
    textSvg: `${headlineSvg}${paragraphsResult.svg}`,
    frame: { x: frameX, y: frameY, width: frameWidth, height: frameHeight }
  };
}

function layoutVertical({
  width,
  height,
  headlineLines,
  paragraphs,
  headlineFontSize,
  bodyFontSize,
  headlineFontWeight,
  bodyFontWeight,
  isVariableFont,
  showBullets
}) {
  const textWidth = width - PAD * 2;
  const headlineLineHeight = headlineFontSize * 1.05;
  const headlineGap = Math.max(bodyFontSize * 1.6, headlineFontSize * 0.95);

  const headlineSvg = renderTextBlock({
    x: PAD,
    y: PAD,
    lines: headlineLines,
    fontSize: headlineFontSize,
    className: "hl",
    lineHeight: headlineLineHeight,
    align: "center",
    width: textWidth,
    fontWeight: headlineFontWeight,
    isVariable: isVariableFont
  });

  const textAfterHeadlineY = PAD + headlineLineHeight * headlineLines.length + headlineGap;

  const paragraphsResult = renderParagraphs({
    x: PAD,
    startY: textAfterHeadlineY,
    width: textWidth,
    paragraphs,
    fontSize: bodyFontSize,
    lineHeight: bodyFontSize * 1.45,
    align: "center",
    fontWeight: bodyFontWeight,
    isVariable: isVariableFont,
    includeBullets: showBullets
  });

  const frameY = Math.max(paragraphsResult.endY + 40, Math.round(height * 0.55));
  const frameHeight = Math.max(240, height - frameY - PAD);
  const frameWidth = width - PAD * 2;
  const frameX = PAD;

  return {
    textSvg: `${headlineSvg}${paragraphsResult.svg}`,
    frame: { x: frameX, y: frameY, width: frameWidth, height: frameHeight }
  };
}

function renderParagraphs({
  x,
  startY,
  width,
  paragraphs,
  fontSize,
  lineHeight,
  align = "left",
  fontWeight,
  isVariable,
  includeBullets = true
}) {
  let cursorY = startY;
  let svg = "";

  if (align !== "left") {
    const maxWidth = Math.max(0, width);
    paragraphs.forEach((paragraph) => {
      const wrapped = wrapTextByWidth(paragraph, maxWidth, fontSize);
      if (!wrapped.length) return;

      const renderedLines = includeBullets ? addBulletPrefix(wrapped) : wrapped;
      svg += renderTextBlock({
        x,
        y: cursorY,
        lines: renderedLines,
        fontSize,
        className: "body",
        lineHeight,
        align,
        width,
        fontWeight,
        isVariable
      });
      cursorY += lineHeight * renderedLines.length + fontSize * 0.9;
    });
    return { svg, endY: cursorY };
  }

  const bulletRadius = fontSize * 0.22;
  const bulletGap = fontSize * 0.7;
  const bulletX = x + bulletRadius + 2;
  const textX = x + bulletRadius * 2 + bulletGap;
  const adjustedWidth = Math.max(0, width - (textX - x));

  paragraphs.forEach((paragraph) => {
    const wrappedLines = wrapTextByWidth(paragraph, adjustedWidth, fontSize);
    if (!wrappedLines.length) return;

    if (includeBullets) {
      const circleY = cursorY + fontSize * 0.9;
      svg += `<circle cx="${bulletX}" cy="${circleY}" r="${bulletRadius}" fill="${FG_COLOR}"/>`;
      svg += renderTextBlock({
        x: textX,
        y: cursorY,
        lines: wrappedLines,
        fontSize,
        className: "body",
        lineHeight,
        align,
        width: adjustedWidth,
        fontWeight,
        isVariable
      });
    } else {
      svg += renderTextBlock({
        x,
        y: cursorY,
        lines: wrappedLines,
        fontSize,
        className: "body",
        lineHeight,
        align,
        width: width,
        fontWeight,
        isVariable
      });
    }
    cursorY += lineHeight * wrappedLines.length + fontSize * 0.85;
  });

  return { svg, endY: cursorY };
}

function renderTextBlock({
  x,
  y,
  lines,
  fontSize,
  className,
  lineHeight,
  align = "left",
  width,
  fontWeight,
  isVariable
}) {
  if (!lines.length) return "";
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const textX =
    align === "center" ? x + (width || 0) / 2 : align === "right" ? x + (width || 0) : x;
  const resolvedWeight =
    fontWeight ?? (className === "hl" ? "700" : "400");
  const variationSettings =
    isVariable && resolvedWeight
      ? `font-variation-settings:'wght' ${resolvedWeight};`
      : "";

  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? fontSize : lineHeight;
      return `<tspan x="${textX}" dy="${dy}" xml:space="preserve">${escapeXML(line)}</tspan>`;
    })
    .join("");

  const styleAttr = variationSettings ? ` style="${variationSettings}"` : "";

  return `<text class="${className}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${resolvedWeight}"${styleAttr} text-anchor="${anchor}" dominant-baseline="hanging" x="${textX}" y="${y}">${tspans}</text>`;
}

function wrapText(text, maxChars) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  });
  if (current) lines.push(current);
  return lines;
}

function wrapHeadlineWithWidth(text, totalWidth, fontSize) {
  const usableWidth = Math.max(0, totalWidth * 0.44 - PAD * 1.5);
  if (!usableWidth) return [];

  const lines = wrapTextByWidth(text, usableWidth, fontSize, 2);
  if (lines.length <= 2) {
    return lines;
  }

  const first = lines[0];
  const remainder = lines.slice(1).join(" ").trim();
  return [first, remainder];
}

function wrapTextByWidth(text, maxWidth, fontSize, maxLines = Infinity) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return [];

  if (maxWidth <= 0) {
    return wrapText(text, Math.max(8, Math.floor(fontSize * 0.9)));
  }

  const lines = [];
  let current = "";

  words.forEach((word) => {
    if (lines.length >= maxLines) {
      current = current ? `${current} ${word}` : word;
      return;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (estimateLineWidth(candidate, fontSize) <= maxWidth || !current) {
      current = candidate;
      return;
    }

    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) {
        current = word;
        return;
      }
    }

    if (estimateLineWidth(word, fontSize) <= maxWidth) {
      current = word;
      return;
    }

    const segments = splitWordToFit(word, maxWidth, fontSize);
    if (segments.length) {
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (lines.length >= maxLines) {
          current = `${current} ${segments[i]}`.trim();
          continue;
        }
        lines.push(segments[i]);
      }
      current = segments[segments.length - 1] || "";
    } else {
      current = "";
    }
  });

  if (current) lines.push(current);
  return lines;
}

function splitWordToFit(word, maxWidth, fontSize) {
  if (maxWidth <= 0) return [word];
  const segments = [];
  let buffer = "";
  for (const char of word) {
    const candidate = buffer ? buffer + char : char;
    if (estimateLineWidth(candidate, fontSize) <= maxWidth || !buffer) {
      buffer = candidate;
    } else {
      segments.push(buffer);
      buffer = char;
    }
  }
  if (buffer) segments.push(buffer);
  return segments;
}

function estimateLineWidth(value, fontSize) {
  let width = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 32) {
      width += fontSize * 0.34;
    } else if (code >= 65 && code <= 90) {
      width += fontSize * 0.68;
    } else if (code >= 48 && code <= 57) {
      width += fontSize * 0.58;
    } else if ((code >= 97 && code <= 122) || (code >= 224 && code <= 255)) {
      width += fontSize * 0.56;
    } else if (",.;:!?".includes(value[index])) {
      width += fontSize * 0.3;
    } else if ("-+/".includes(value[index])) {
      width += fontSize * 0.45;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width + Math.max(0, value.length - 1) * fontSize * 0.04;
}

function addBulletPrefix(lines) {
  return lines.map((line, index) => (index === 0 ? `\u2022 ${line}` : `  ${line}`));
}

function sanitizeParagraphs(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

function escapeXML(value) {
  return String(value || "").replace(/[&<>]/g, (ch) => {
    return ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : '&quot;';
  });
}

function normalizeOrientation(value) {
  return value === "16:9" ? "16:9" : "9:16";
}













