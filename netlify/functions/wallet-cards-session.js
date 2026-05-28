import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';

const PAGE_SIZE = [1050, 600];
const frontTemplatePath = path.resolve(
  process.cwd(),
  'server/templates/cards/3.png'
);
const backTemplatePath = path.resolve(
  process.cwd(),
  'server/templates/cards/4.png'
);
const bowmanFrontTemplatePath = path.resolve(
  process.cwd(),
  'server/templates/cards/BowmanFront.png'
);
const bowmanBackTemplatePath = path.resolve(
  process.cwd(),
  'server/templates/cards/BowmanBack.png'
);
const CARD_FONT_PATHS = {
  oswaldBold: path.resolve(
    process.cwd(),
    'server/templates/cards/fonts/Oswald-Bold.ttf'
  ),
  montserratBold: path.resolve(
    process.cwd(),
    'server/templates/cards/fonts/Montserrat-Bold.ttf'
  ),
};
const CARD_FONTS = {
  oswaldBold: 'Oswald-Bold',
  montserratBold: 'Montserrat-Bold',
};
const CARD_LAYOUT = {
  front: {
    contentMask: {
      x: 146,
      y: 0,
      width: 904,
      height: 524,
      color: '#f7f7f6',
    },
    templateRegions: {
      logo: {
        source: { x: 185, y: 28, width: 234, height: 182 },
        target: { x: 184, y: 46, width: 184, height: 143 },
      },
      calendarIcon: {
        source: { x: 206, y: 439, width: 66, height: 66 },
        target: { x: 206, y: 452, width: 47, height: 47 },
      },
      shieldIcon: {
        source: { x: 635, y: 446, width: 64, height: 66 },
        target: { x: 635, y: 448, width: 49, height: 51 },
      },
    },
    title: {
      x: 414,
      y: 60,
      width: 560,
      fontSize: 54,
      lineHeight: 1.06,
      color: '#000000',
      font: CARD_FONTS.oswaldBold,
    },
    lines: [
      { x: 197, y: 224, width: 794, color: '#8fb3ad', lineWidth: 2 },
      { x: 197, y: 333, width: 794, color: '#c8caca', lineWidth: 2 },
      { x: 197, y: 426, width: 794, color: '#c8caca', lineWidth: 2 },
      { x: 582, y: 427, height: 84, color: '#d2d2d2', lineWidth: 2 },
    ],
    labels: {
      name: {
        text: 'NAME',
        x: 207,
        y: 243,
        width: 220,
        fontSize: 18,
        color: '#036f5e',
        font: CARD_FONTS.montserratBold,
      },
      course: {
        text: 'COURSE',
        x: 207,
        y: 346,
        width: 220,
        fontSize: 18,
        color: '#036f5e',
        font: CARD_FONTS.montserratBold,
      },
    },
    studentName: {
      x: 207,
      y: 274,
      width: 760,
      fontSize: 46,
      minFontSize: 32,
      align: 'left',
      color: '#000000',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1.11,
    },
    courseName: {
      x: 207,
      y: 378,
      width: 760,
      fontSize: 33,
      minFontSize: 23,
      align: 'left',
      color: '#000000',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1.11,
    },
    completedLabel: {
      x: 285,
      y: 450,
      width: 260,
      fontSize: 19,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    completedDate: {
      x: 285,
      y: 482,
      width: 190,
      fontSize: 19,
      align: 'left',
      color: '#000000',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0,
      lineHeight: 1.4,
    },
    validThroughLabel: {
      x: 755,
      y: 450,
      width: 260,
      fontSize: 19,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    validThrough: {
      x: 755,
      y: 482,
      width: 190,
      fontSize: 19,
      align: 'left',
      color: '#000000',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0,
      lineHeight: 1.4,
    },
  },
  back: {
    shell: {
      header: {
        x: 0,
        y: 0,
        width: 1050,
        height: 82,
        color: '#036f5e',
      },
      headerText: {
        x: 0,
        y: 25,
        width: 1050,
        fontSize: 30,
        align: 'center',
        color: '#ffffff',
        font: CARD_FONTS.montserratBold,
      },
      content: {
        x: 0,
        y: 82,
        width: 1050,
        height: 442,
        color: '#ffffff',
      },
      divider: {
        x: 470,
        y: 110,
        height: 360,
        color: '#d6d6d6',
        lineWidth: 2,
      },
      signatureLine: {
        x: 540,
        y: 392,
        width: 390,
        color: '#8f8f8f',
        lineWidth: 2,
      },
      signatureImage: {
        x: 555,
        y: 326,
        width: 360,
        height: 48,
      },
      footer: {
        x: 0,
        y: 524,
        width: 1050,
        height: 76,
        color: '#036f5e',
      },
      footerText: {
        x: 0,
        y: 548,
        width: 1050,
        fontSize: 22,
        align: 'center',
        color: '#ffffff',
        font: CARD_FONTS.montserratBold,
      },
    },
    labels: [
      { text: 'COURSE:', x: 60, y: 154 },
      { text: 'INSTRUCTOR:', x: 60, y: 218 },
      { text: 'INSTRUCTOR CERTIFICATION:', x: 60, y: 282 },
      { text: 'SIGNATURE:', x: 60, y: 346 },
      { text: 'DATE ISSUED:', x: 60, y: 410 },
      { text: 'VALID THROUGH:', x: 60, y: 474 },
    ],
    labelText: {
      width: 360,
      fontSize: 17,
      align: 'left',
      color: '#000000',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    courseName: {
      x: 540,
      y: 154,
      width: 430,
      fontSize: 16,
      minFontSize: 11,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    instructor: {
      x: 540,
      y: 218,
      width: 430,
      fontSize: 16,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    instructorCertification: {
      x: 540,
      y: 282,
      width: 430,
      fontSize: 16,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    signature: {
      x: 540,
      y: 334,
      width: 430,
      fontSize: 16,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    dateIssued: {
      x: 540,
      y: 410,
      width: 430,
      fontSize: 16,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
    validThrough: {
      x: 540,
      y: 474,
      width: 430,
      fontSize: 16,
      align: 'left',
      color: '#036f5e',
      font: CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
  },
};
const BOWMAN_CARD_LAYOUT = {
  front: {
    studentName: {
      x: 0,
      y: 242,
      width: 1050,
      fontSize: 60.4,
      minFontSize: 44,
      align: 'center',
      color: '#000000',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1,
    },
    courseName: {
      x: 70,
      y: 348,
      width: 910,
      fontSize: 52.4,
      minFontSize: 36,
      align: 'center',
      color: '#00195f',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1,
    },
  },
  back: {
    textColor: '#00195f',
    instructorName: {
      x: 164,
      y: 333,
      width: 320,
      fontSize: 32.4,
      minFontSize: 24,
      align: 'left',
      color: '#00195f',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1,
    },
    signatureImage: {
      x: 725,
      y: 334,
      width: 160,
      height: 52,
    },
    dateIssued: {
      x: 164,
      y: 499,
      width: 230,
      fontSize: 32.4,
      minFontSize: 24,
      align: 'left',
      color: '#00195f',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1,
    },
    validThrough: {
      x: 687,
      y: 499,
      width: 230,
      fontSize: 32.4,
      minFontSize: 24,
      align: 'left',
      color: '#00195f',
      font: CARD_FONTS.oswaldBold,
      lineHeight: 1,
    },
  },
};

function jsonResponse(statusCode, error) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error }),
  };
}

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseServerKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseServerKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServerKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getSupabaseAuthClient(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return null;
  }

  return createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

function hasImportedAsset(user, assetName) {
  const importedAssets = user?.user_metadata?.imported_assets;

  if (!importedAssets) return true;

  return Boolean(importedAssets[assetName]);
}

async function downloadTemplateFile(supabase, filePath) {
  const { data, error } = await supabase.storage
    .from('instructor-templates')
    .download(filePath);

  if (error || !data) {
    throw error || new Error('Template file could not be loaded.');
  }

  return Buffer.from(await data.arrayBuffer());
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatDate(value) {
  if (!value) return 'N/A';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(date);
}

function addYearsToDate(value, years) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;

  date.setFullYear(date.getFullYear() + years);
  return date.toISOString().split('T')[0];
}

function formatStudentName(name) {
  const value = String(name || '').trim();

  if (!value) return 'Student';

  return value
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return part;

      return part
        .split('-')
        .map((namePart) => {
          if (!namePart) return namePart;

          const lowerNamePart = namePart.toLowerCase();
          return lowerNamePart.charAt(0).toUpperCase() + lowerNamePart.slice(1);
        })
        .join('-');
    })
    .join('');
}

function toCardDisplayText(value, fallback = '') {
  const text = String(value || fallback).trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanFileName(value, fallback = 'wallet-cards', separator = '-') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, 'g'), separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, 'g'), '')
    .slice(0, 90);

  return cleaned || fallback;
}

function cleanPdfFileName(value, fallback = 'Student') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);

  return cleaned || fallback;
}

function getUniquePdfName(studentName, usedNames, side) {
  const baseName = `${cleanPdfFileName(
    studentName,
    'Student'
  )}_wallet_card_${side}`;
  let fileName = `${baseName}.pdf`;
  let index = 2;

  while (usedNames.has(fileName.toLowerCase())) {
    fileName = `${baseName}-${index}.pdf`;
    index += 1;
  }

  usedNames.add(fileName.toLowerCase());
  return fileName;
}

async function loadCardTemplates(supabase, user) {
  const customTemplates = user?.user_metadata?.custom_templates?.walletCards;
  const templateDesigns = user?.user_metadata?.template_designs || {};
  const walletCardDesign =
    templateDesigns.walletCardDesign === 'bowman' ? 'bowman' : 'excourse';
  const legacyWalletDesign =
    templateDesigns.walletCards === 'different' ? 'different' : 'same';
  const useCustomFront =
    (templateDesigns.walletFront || legacyWalletDesign) === 'different' &&
    customTemplates?.front?.path;
  const useCustomBack =
    (templateDesigns.walletBack || legacyWalletDesign) === 'different' &&
    customTemplates?.back?.path;

  if (useCustomFront || useCustomBack) {
    if (
      (useCustomFront && customTemplates.front.extension === 'pdf') ||
      (useCustomBack && customTemplates.back.extension === 'pdf')
    ) {
      throw new Error(
        'Custom PDF wallet card templates are uploaded, but PDF background rendering is not enabled yet. Use PNG or JPG images for generated wallet cards.'
      );
    }

    const [front, back] = await Promise.all([
      useCustomFront
        ? downloadTemplateFile(supabase, customTemplates.front.path)
        : fs.readFile(frontTemplatePath),
      useCustomBack
        ? downloadTemplateFile(supabase, customTemplates.back.path)
        : fs.readFile(backTemplatePath),
    ]);

    return {
      front,
      back,
      customFront: Boolean(useCustomFront),
      customBack: Boolean(useCustomBack),
      design: walletCardDesign === 'bowman' ? 'bowman' : 'custom',
    };
  }

  const hasBuiltInBowmanTemplates =
    (await fileExists(bowmanFrontTemplatePath)) &&
    (await fileExists(bowmanBackTemplatePath));

  if (walletCardDesign === 'bowman' && hasBuiltInBowmanTemplates) {
    const [front, back] = await Promise.all([
      fs.readFile(bowmanFrontTemplatePath),
      fs.readFile(bowmanBackTemplatePath),
    ]);

    return {
      front,
      back,
      customFront: true,
      customBack: true,
      design: 'bowman',
    };
  }

  const [front, back] = await Promise.all([
    fs.readFile(frontTemplatePath),
    fs.readFile(backTemplatePath),
  ]);

  return { front, back, customFront: false, customBack: false, design: 'default' };
}

function registerCardFonts(doc) {
  doc.registerFont(CARD_FONTS.oswaldBold, CARD_FONT_PATHS.oswaldBold);
  doc.registerFont(CARD_FONTS.montserratBold, CARD_FONT_PATHS.montserratBold);
}

function getFittingFontSize(doc, text, layout) {
  let size = layout.fontSize;
  const minSize = layout.minFontSize || layout.fontSize;

  doc.font(layout.font);

  while (size > minSize) {
    doc.fontSize(size);

    if (
      doc.widthOfString(text, {
        characterSpacing: layout.characterSpacing || 0,
      }) <= layout.width * 0.98
    ) {
      break;
    }

    size -= 1;
  }

  return size;
}

function getLineGap(layout, size) {
  return layout.lineHeight ? size * (layout.lineHeight - 1) : 0;
}

function drawText(doc, text, layout) {
  const size = layout.minFontSize
    ? getFittingFontSize(doc, text, layout)
    : layout.fontSize;

  doc
    .fillColor(layout.color)
    .font(layout.font)
    .fontSize(size)
    .text(text, layout.x, layout.y, {
      width: layout.width,
      align: layout.align,
      characterSpacing: layout.characterSpacing || 0,
      lineGap: getLineGap(layout, size),
      lineBreak: true,
    });
}

function drawTemplateRegion(doc, template, region) {
  const scale = region.target.width / region.source.width;

  doc
    .save()
    .rect(
      region.target.x,
      region.target.y,
      region.target.width,
      region.target.height
    )
    .clip();

  doc.image(template, region.target.x - region.source.x * scale, region.target.y - region.source.y * scale, {
    width: PAGE_SIZE[0] * scale,
    height: PAGE_SIZE[1] * scale,
  });

  doc.restore();
}

function drawFrontCardShell(doc, template) {
  const { contentMask, templateRegions, title, lines, labels } = CARD_LAYOUT.front;

  doc
    .save()
    .rect(contentMask.x, contentMask.y, contentMask.width, contentMask.height)
    .fillColor(contentMask.color)
    .fill()
    .restore();

  drawTemplateRegion(doc, template, templateRegions.logo);
  drawTemplateRegion(doc, template, templateRegions.calendarIcon);
  drawTemplateRegion(doc, template, templateRegions.shieldIcon);

  doc
    .fillColor(title.color)
    .font(title.font)
    .fontSize(title.fontSize)
    .text('TRAINING\nCERTIFICATION CARD', title.x, title.y, {
      width: title.width,
      align: 'left',
      lineGap: getLineGap(title, title.fontSize),
    });

  lines.forEach((line) => {
    doc
      .save()
      .lineWidth(line.lineWidth)
      .strokeColor(line.color);

    if (line.height) {
      doc.moveTo(line.x, line.y).lineTo(line.x, line.y + line.height);
    } else {
      doc.moveTo(line.x, line.y).lineTo(line.x + line.width, line.y);
    }

    doc.stroke().restore();
  });

  drawText(doc, labels.name.text, labels.name);
  drawText(doc, labels.course.text, labels.course);
}

function drawBackCardShell(doc) {
  const { shell, labels, labelText } = CARD_LAYOUT.back;

  doc
    .save()
    .rect(shell.header.x, shell.header.y, shell.header.width, shell.header.height)
    .fillColor(shell.header.color)
    .fill()
    .rect(shell.content.x, shell.content.y, shell.content.width, shell.content.height)
    .fillColor(shell.content.color)
    .fill()
    .rect(shell.footer.x, shell.footer.y, shell.footer.width, shell.footer.height)
    .fillColor(shell.footer.color)
    .fill()
    .restore();

  drawText(doc, 'TRAINING VERIFICATION', shell.headerText);
  drawText(doc, 'EXCEED SAFETY  •  exceedsafety.com', shell.footerText);

  doc
    .save()
    .lineWidth(shell.divider.lineWidth)
    .strokeColor(shell.divider.color)
    .moveTo(shell.divider.x, shell.divider.y)
    .lineTo(shell.divider.x, shell.divider.y + shell.divider.height)
    .stroke()
    .lineWidth(shell.signatureLine.lineWidth)
    .strokeColor(shell.signatureLine.color)
    .moveTo(shell.signatureLine.x, shell.signatureLine.y)
    .lineTo(shell.signatureLine.x + shell.signatureLine.width, shell.signatureLine.y)
    .stroke()
    .restore();

  labels.forEach((label) => {
    drawText(doc, label.text, { ...labelText, x: label.x, y: label.y });
  });
}

function getPngCrcTable() {
  if (getPngCrcTable.table) return getPngCrcTable.table;

  getPngCrcTable.table = Array.from({ length: 256 }, (_, index) => {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    return value >>> 0;
  });

  return getPngCrcTable.table;
}

function getPngCrc(buffer) {
  const table = getPngCrcTable();
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);

  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(getPngCrc(Buffer.concat([typeBuffer, data])), data.length + 8);

  return chunk;
}

function unfilterPngScanlines(data, width, height) {
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = data[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = rowOffset - stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = data[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[previousRowOffset + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? pixels[previousRowOffset + x - bytesPerPixel]
          : 0;
      let value = raw;

      if (filter === 1) value = raw + left;
      if (filter === 2) value = raw + up;
      if (filter === 3) value = raw + Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = raw + predictor;
      }

      pixels[rowOffset + x] = value & 0xff;
    }

    sourceOffset += stride;
  }

  return pixels;
}

function encodeRgbaPng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    pixels.copy(raw, rawOffset + 1, y * stride, y * stride + stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makePngChunk('IHDR', header),
    makePngChunk('IDAT', zlib.deflateSync(raw)),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function trimSignaturePngWhitespace(buffer) {
  try {
    if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return buffer;
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    const idatChunks = [];

    while (offset < buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      const data = buffer.subarray(offset + 8, offset + 8 + length);

      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        colorType = data[9];
      } else if (type === 'IDAT') {
        idatChunks.push(data);
      } else if (type === 'IEND') {
        break;
      }

      offset += length + 12;
    }

    if (!width || !height || colorType !== 6 || idatChunks.length === 0) {
      return buffer;
    }

    const pixels = unfilterPngScanlines(
      zlib.inflateSync(Buffer.concat(idatChunks)),
      width,
      height
    );
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelOffset = (y * width + x) * 4;
        const red = pixels[pixelOffset];
        const green = pixels[pixelOffset + 1];
        const blue = pixels[pixelOffset + 2];
        const alpha = pixels[pixelOffset + 3];
        const isInk = alpha > 20 && (red < 245 || green < 245 || blue < 245);

        if (isInk) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (maxX < minX || maxY < minY) return buffer;

    const padding = 8;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(width - 1, maxX + padding);
    maxY = Math.min(height - 1, maxY + padding);

    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;
    const croppedPixels = Buffer.alloc(cropWidth * cropHeight * 4);

    for (let y = 0; y < cropHeight; y += 1) {
      const sourceStart = ((minY + y) * width + minX) * 4;
      pixels.copy(
        croppedPixels,
        y * cropWidth * 4,
        sourceStart,
        sourceStart + cropWidth * 4
      );
    }

    return encodeRgbaPng(cropWidth, cropHeight, croppedPixels);
  } catch (error) {
    console.error('Signature crop error:', error);
    return buffer;
  }
}

function drawSignatureImage(doc, imageBuffer, layout) {
  if (!imageBuffer) return;

  try {
    const trimmedImage = trimSignaturePngWhitespace(imageBuffer);

    doc.image(trimmedImage, layout.x, layout.y, {
      fit: [layout.width, layout.height],
      align: 'left',
      valign: 'center',
    });
  } catch (error) {
    console.error('Wallet card signature render error:', error);
  }
}

async function fetchSignatureImage(signatureSource, supabase) {
  if (signatureSource?.signature_path) {
    try {
      const { data, error } = await supabase.storage
        .from('signatures')
        .download(signatureSource.signature_path);

      if (error) {
        throw error;
      }

      if (data) {
        return Buffer.from(await data.arrayBuffer());
      }
    } catch (error) {
      console.error('Private signature download error:', error);
    }
  }

  if (!signatureSource?.signature_url) return null;

  try {
    const response = await fetch(signatureSource.signature_url);

    if (!response.ok) return null;

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error('Signature image load error:', error);
    return null;
  }
}

function getTrainerSignatureSource(session) {
  return {
    signature_path: session.trainer_signature_path,
    signature_url: session.trainer_signature_url,
  };
}

function getWalletCardData(session, record) {
  const studentName = toCardDisplayText(
    formatStudentName(record.student_name),
    'STUDENT'
  );
  const courseName = toCardDisplayText(session.course_name, 'TRAINING SESSION');
  const completedDate = formatDate(session.training_date);
  const validThrough = formatDate(addYearsToDate(session.training_date, 3));
  const instructorName = toCardDisplayText(session.trainer_name, 'N/A');
  const instructorNameTitle = formatStudentName(session.trainer_name || 'N/A');

  return {
    studentName,
    courseName,
    completedDate,
    validThrough,
    instructorName,
    instructorNameTitle,
  };
}

function drawBowmanFrontFields(doc, data) {
  drawText(doc, data.studentName, BOWMAN_CARD_LAYOUT.front.studentName);
  drawText(doc, data.courseName, BOWMAN_CARD_LAYOUT.front.courseName);
}

function drawBowmanBackFields(doc, data, signatureImage) {
  drawText(
    doc,
    data.instructorNameTitle,
    BOWMAN_CARD_LAYOUT.back.instructorName
  );
  drawSignatureImage(
    doc,
    signatureImage,
    BOWMAN_CARD_LAYOUT.back.signatureImage
  );
  drawText(doc, data.completedDate, BOWMAN_CARD_LAYOUT.back.dateIssued);
  drawText(doc, data.validThrough, BOWMAN_CARD_LAYOUT.back.validThrough);
}

function createWalletCardPdfBuffer(session, record, templates, side, signatureImage) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE_SIZE,
      margin: 0,
    });
    const chunks = [];
    const data = getWalletCardData(session, record);
    const {
      studentName,
      courseName,
      completedDate,
      validThrough,
      instructorName,
    } = data;

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    registerCardFonts(doc);

    if (side === 'front') {
      doc.image(templates.front, 0, 0, {
        width: PAGE_SIZE[0],
        height: PAGE_SIZE[1],
      });

      if (templates.design === 'bowman') {
        drawBowmanFrontFields(doc, data);
      } else {
        if (!templates.customFront) {
          drawFrontCardShell(doc, templates.front);
        }

        drawText(doc, studentName, CARD_LAYOUT.front.studentName);
        drawText(doc, courseName, CARD_LAYOUT.front.courseName);
        drawText(doc, 'COMPLETED', CARD_LAYOUT.front.completedLabel);
        drawText(doc, completedDate, CARD_LAYOUT.front.completedDate);
        drawText(doc, 'VALID THROUGH', CARD_LAYOUT.front.validThroughLabel);
        drawText(doc, validThrough, CARD_LAYOUT.front.validThrough);
      }
    } else {
      doc.image(templates.back, 0, 0, {
        width: PAGE_SIZE[0],
        height: PAGE_SIZE[1],
      });

      if (templates.design === 'bowman') {
        drawBowmanBackFields(doc, data, signatureImage);
      } else {
        if (!templates.customBack) {
          drawBackCardShell(doc);
        }

        drawText(doc, courseName, CARD_LAYOUT.back.courseName);
        drawText(doc, instructorName, CARD_LAYOUT.back.instructor);
        drawText(
          doc,
          'INSTRUCTOR CERTIFICATION',
          CARD_LAYOUT.back.instructorCertification
        );
        drawSignatureImage(
          doc,
          signatureImage,
          CARD_LAYOUT.back.shell.signatureImage
        );
        drawText(doc, completedDate, CARD_LAYOUT.back.dateIssued);
        drawText(doc, validThrough, CARD_LAYOUT.back.validThrough);
      }
    }

    doc.end();
  });
}

async function generateWalletCardPdfs(session, records, supabase, user) {
  const templates = await loadCardTemplates(supabase, user);
  const usedNames = new Set();
  const pdfFiles = [];
  const trainerSignatureImage = await fetchSignatureImage(
    getTrainerSignatureSource(session),
    supabase
  );

  for (const record of records) {
    const studentName = formatStudentName(record.student_name);
    const frontBuffer = await createWalletCardPdfBuffer(
      session,
      record,
      templates,
      'front',
      trainerSignatureImage
    );
    const backBuffer = await createWalletCardPdfBuffer(
      session,
      record,
      templates,
      'back',
      trainerSignatureImage
    );

    pdfFiles.push({
      name: getUniquePdfName(studentName, usedNames, 'front'),
      buffer: frontBuffer,
    });
    pdfFiles.push({
      name: getUniquePdfName(studentName, usedNames, 'back'),
      buffer: backBuffer,
    });
  }

  return pdfFiles;
}

function zipFiles(files) {
  const zip = new JSZip();

  files.forEach((file) => {
    zip.file(file.name, file.buffer);
  });

  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, 'Method not allowed.');
  }

  const sessionId = event.queryStringParameters?.sessionId;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!sessionId) {
    return jsonResponse(400, 'Missing session ID.');
  }

  if (!accessToken) {
    return jsonResponse(401, 'Login required.');
  }

  const authClient = getSupabaseAuthClient(accessToken);
  const supabase = getSupabaseClient();

  if (!authClient || !supabase) {
    return jsonResponse(500, 'Server is missing Supabase configuration.');
  }

  try {
    const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      return jsonResponse(401, 'Login required.');
    }

    if (!hasImportedAsset(userData.user, 'walletCards')) {
      return jsonResponse(403, 'Wallet card access was not included for this email.');
    }

    const sessionResult = await supabase
      .from('training_sessions')
      .select('*')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionResult.error) {
      throw sessionResult.error;
    }

    if (!sessionResult.data) {
      return jsonResponse(404, 'Training session not found.');
    }

    if (sessionResult.data.owner_user_id !== userData.user.id) {
      return jsonResponse(403, 'You do not have access to this training session.');
    }

    const recordsResult = await supabase
      .from('attendance_records')
      .select('*')
      .eq('training_session_id', sessionId)
      .order('student_name', { ascending: true });

    if (recordsResult.error) {
      throw recordsResult.error;
    }

    const records = recordsResult.data || [];

    if (records.length === 0) {
      return jsonResponse(400, 'No students found for this session.');
    }

    const pdfFiles = await generateWalletCardPdfs(
      sessionResult.data,
      records,
      supabase,
      userData.user
    );
    const zipBuffer = await zipFiles(pdfFiles);
    const zipName = `${cleanFileName(
      sessionResult.data.course_name,
      'training-session'
    )}-wallet-cards.zip`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
      },
      body: zipBuffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Wallet card generation error:', error);
    return jsonResponse(500, error?.message || 'Failed to generate wallet cards.');
  }
}
