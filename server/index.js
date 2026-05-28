import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import PizZip from 'pizzip';
import JSZip from 'jszip';
import { handler as instructorUsersHandler } from '../netlify/functions/instructor-users.js';
import { handler as attendanceRecordsHandler } from '../netlify/functions/attendance-records.js';
import { handler as certificatesSessionHandler } from '../netlify/functions/certificates-session.js';
import { handler as savedQuizLibraryHandler } from '../netlify/functions/saved-quiz-library.js';
import { handler as walletCardsSessionHandler } from '../netlify/functions/wallet-cards-session.js';

const app = express();
const port = Number(process.env.PORT || 3001);

app.use((request, response, next) => {
  const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  const origin = request.headers.origin;

  if (allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }

  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: '25mb' }));

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServerKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;
const templatePath = path.resolve('server/templates/certificate_template.docx');
const walletCardFrontTemplatePath = path.resolve('server/templates/cards/3.png');
const walletCardBackTemplatePath = path.resolve('server/templates/cards/4.png');
const walletCardFontPaths = {
  oswaldBold: path.resolve('server/templates/cards/fonts/Oswald-Bold.ttf'),
  montserratBold: path.resolve(
    'server/templates/cards/fonts/Montserrat-Bold.ttf'
  ),
};
const WALLET_CARD_FONTS = {
  oswaldBold: 'Oswald-Bold',
  montserratBold: 'Montserrat-Bold',
};
const CERT_LAYOUT = {
  studentName: {
    x: 162,
    y: 272,
    width: 474,
    height: 60,
    fontSize: 48,
    minFontSize: 36,
  },
  courseName: {
    x: 173,
    y: 388,
    width: 454,
    height: 58,
    fontSize: 20,
    minFontSize: 14,
  },
  date: {
    x: 90,
    y: 520,
    width: 170,
    height: 18,
    fontSize: 11,
  },
  signatureImage: {
    x: 480,
    y: 414,
    width: 210,
    height: 66,
  },
  signatureLine: {
    x: 500,
    y: 485,
    width: 170,
  },
  printedName: {
    x: 500,
    y: 505,
    width: 170,
    height: 18,
    fontSize: 11,
  },
  instructorLabel: {
    x: 500,
    y: 525,
    width: 170,
    height: 18,
    fontSize: 11,
  },
};
const WALLET_CARD_PAGE_SIZE = [1050, 600];
const WALLET_CARD_LAYOUT = {
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
      font: WALLET_CARD_FONTS.oswaldBold,
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
        font: WALLET_CARD_FONTS.montserratBold,
      },
      course: {
        text: 'COURSE',
        x: 207,
        y: 346,
        width: 220,
        fontSize: 18,
        color: '#036f5e',
        font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.oswaldBold,
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
      font: WALLET_CARD_FONTS.oswaldBold,
      lineHeight: 1.11,
    },
    completedLabel: {
      x: 285,
      y: 450,
      width: 260,
      fontSize: 19,
      align: 'left',
      color: '#036f5e',
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
        font: WALLET_CARD_FONTS.montserratBold,
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
        font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
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
      font: WALLET_CARD_FONTS.montserratBold,
      characterSpacing: 0.35,
      lineHeight: 1.4,
    },
  },
};

function getSupabaseClient() {
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

function cleanFileName(value, fallback = 'certificate') {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);

  return cleaned || fallback;
}

function cleanWalletZipFileName(value, fallback = 'training-session') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

  return cleaned || fallback;
}

function cleanWalletPdfFileName(value, fallback = 'Student') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);

  return cleaned || fallback;
}

function getUniquePdfName(studentName, usedNames) {
  const baseName = cleanFileName(studentName, 'student');
  let fileName = `${baseName}.pdf`;
  let index = 2;

  while (usedNames.has(fileName.toLowerCase())) {
    fileName = `${baseName}-${index}.pdf`;
    index += 1;
  }

  usedNames.add(fileName.toLowerCase());
  return fileName;
}

function getUniqueWalletCardPdfName(studentName, usedNames, side) {
  const baseName = `${cleanWalletPdfFileName(
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

function getTemplateData(session, record) {
  return {
    name: formatStudentName(record.student_name),
    completed: session.course_name || 'Training Session',
    date: formatDate(session.training_date),
    printedName: session.trainer_name || 'N/A',
  };
}

async function loadCertificateTemplate() {
  const templateBuffer = await fs.readFile(templatePath);
  const zip = new PizZip(templateBuffer);
  const background = zip.file('word/media/image1.png')?.asNodeBuffer();

  if (!background) {
    throw new Error('Certificate template background image is missing.');
  }

  return { background };
}

async function loadWalletCardTemplates() {
  const [front, back] = await Promise.all([
    fs.readFile(walletCardFrontTemplatePath),
    fs.readFile(walletCardBackTemplatePath),
  ]);

  return { front, back };
}

function drawCenteredText(doc, text, x, y, width, options = {}) {
  const {
    size = 18,
    font = 'Helvetica-Bold',
    color = '#111827',
    height,
  } = options;

  doc
    .fillColor(color)
    .font(font)
    .fontSize(size)
    .text(text, x, y, {
      width,
      height,
      align: 'center',
      lineBreak: true,
    });
}

function getFittingFontSize(doc, text, width, startSize, minSize) {
  let size = startSize;

  while (size > minSize && doc.widthOfString(text, { size }) > width * 0.96) {
    size -= 1;
  }

  return size;
}

function getWalletCardFittingFontSize(doc, text, layout) {
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

function drawTextBox(doc, text, layout, options = {}) {
  const {
    font = 'Helvetica-Bold',
    color = '#111827',
    fit = false,
  } = options;

  doc.font(font);

  const size = fit
    ? getFittingFontSize(
        doc,
        text,
        layout.width,
        layout.fontSize,
        layout.minFontSize || layout.fontSize
      )
    : layout.fontSize;

  drawCenteredText(doc, text, layout.x, layout.y, layout.width, {
    size,
    font,
    color,
    height: layout.height,
  });
}

function drawWalletCardText(doc, text, layout) {
  const size = layout.minFontSize
    ? getWalletCardFittingFontSize(doc, text, layout)
    : layout.fontSize;

  doc
    .fillColor(layout.color)
    .font(layout.font)
    .fontSize(size)
    .text(text, layout.x, layout.y, {
      width: layout.width,
      align: layout.align,
      characterSpacing: layout.characterSpacing || 0,
      lineGap: getWalletCardLineGap(layout, size),
      lineBreak: true,
    });
}

function getWalletCardLineGap(layout, size) {
  return layout.lineHeight ? size * (layout.lineHeight - 1) : 0;
}

function registerWalletCardFonts(doc) {
  doc.registerFont(WALLET_CARD_FONTS.oswaldBold, walletCardFontPaths.oswaldBold);
  doc.registerFont(
    WALLET_CARD_FONTS.montserratBold,
    walletCardFontPaths.montserratBold
  );
}

function drawWalletTemplateRegion(doc, template, region) {
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

  doc.image(
    template,
    region.target.x - region.source.x * scale,
    region.target.y - region.source.y * scale,
    {
      width: WALLET_CARD_PAGE_SIZE[0] * scale,
      height: WALLET_CARD_PAGE_SIZE[1] * scale,
    }
  );

  doc.restore();
}

function drawWalletFrontShell(doc, template) {
  const { contentMask, templateRegions, title, lines, labels } =
    WALLET_CARD_LAYOUT.front;

  doc
    .save()
    .rect(contentMask.x, contentMask.y, contentMask.width, contentMask.height)
    .fillColor(contentMask.color)
    .fill()
    .restore();

  drawWalletTemplateRegion(doc, template, templateRegions.logo);
  drawWalletTemplateRegion(doc, template, templateRegions.calendarIcon);
  drawWalletTemplateRegion(doc, template, templateRegions.shieldIcon);

  doc
    .fillColor(title.color)
    .font(title.font)
    .fontSize(title.fontSize)
    .text('TRAINING\nCERTIFICATION CARD', title.x, title.y, {
      width: title.width,
      align: 'left',
      lineGap: getWalletCardLineGap(title, title.fontSize),
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

  drawWalletCardText(doc, labels.name.text, labels.name);
  drawWalletCardText(doc, labels.course.text, labels.course);
}

function drawWalletBackShell(doc) {
  const { shell, labels, labelText } = WALLET_CARD_LAYOUT.back;

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

  drawWalletCardText(doc, 'TRAINING VERIFICATION', shell.headerText);
  drawWalletCardText(doc, 'EXCEED SAFETY  •  exceedsafety.com', shell.footerText);

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
    drawWalletCardText(doc, label.text, {
      ...labelText,
      x: label.x,
      y: label.y,
    });
  });
}

function drawSignatureLine(doc, x, y, width) {
  doc
    .moveTo(x, y)
    .lineTo(x + width, y)
    .lineWidth(0.8)
    .strokeColor('#111827')
    .stroke();
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

function cleanTrainerSignaturePng(buffer) {
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
        const isNearWhite = red > 240 && green > 240 && blue > 240;
        const isInk = alpha > 20 && !isNearWhite;

        if (isNearWhite) {
          pixels[pixelOffset + 3] = 0;
        }

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

function drawSignatureImage(doc, imageBuffer, layout, options = {}) {
  if (!imageBuffer) return;

  try {
    if (options.fillBackground !== false) {
      doc
        .save()
        .rect(layout.x, layout.y, layout.width, layout.height)
        .fillColor('#ffffff')
        .fillOpacity(0.85)
        .fill()
        .restore();
    }

    const signatureImage = options.trimWhitespace
      ? cleanTrainerSignaturePng(imageBuffer)
      : imageBuffer;

    doc.image(signatureImage, layout.x, layout.y, {
      fit: [layout.width, layout.height],
      align: options.align || 'center',
      valign: options.valign || 'center',
    });
  } catch (error) {
    console.error('Signature render error:', error);
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

function createCertificatePdfBuffer(data, template, signatureImage) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: 'landscape',
      margin: 0,
    });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.image(template.background, 0, 0, {
      width: doc.page.width,
      height: doc.page.height,
    });

    drawTextBox(doc, data.name, CERT_LAYOUT.studentName, {
      font: 'Times-Italic',
      color: '#111827',
      fit: true,
    });

    drawTextBox(doc, data.completed, CERT_LAYOUT.courseName, {
      font: 'Helvetica-Bold',
      color: '#111827',
      fit: true,
    });

    drawTextBox(doc, data.date, CERT_LAYOUT.date, {
      font: 'Helvetica-Bold',
      color: '#111827',
    });

    drawSignatureImage(doc, signatureImage, CERT_LAYOUT.signatureImage, {
      fillBackground: false,
      trimWhitespace: true,
    });

    drawSignatureLine(
      doc,
      CERT_LAYOUT.signatureLine.x,
      CERT_LAYOUT.signatureLine.y,
      CERT_LAYOUT.signatureLine.width
    );

    drawTextBox(doc, data.printedName, CERT_LAYOUT.printedName, {
      font: 'Helvetica-Bold',
      color: '#111827',
    });

    drawTextBox(doc, 'Instructor Certification', CERT_LAYOUT.instructorLabel, {
      font: 'Helvetica-Bold',
      color: '#111827',
    });

    doc.end();
  });
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

  return {
    studentName,
    courseName,
    completedDate,
    validThrough,
    instructorName,
  };
}

function createWalletCardPdfBuffer(session, record, templates, side, signatureImage) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: WALLET_CARD_PAGE_SIZE,
      margin: 0,
    });
    const chunks = [];
    const {
      studentName,
      courseName,
      completedDate,
      validThrough,
      instructorName,
    } = getWalletCardData(session, record);

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    registerWalletCardFonts(doc);

    if (side === 'front') {
      doc.image(templates.front, 0, 0, {
        width: WALLET_CARD_PAGE_SIZE[0],
        height: WALLET_CARD_PAGE_SIZE[1],
      });

      drawWalletFrontShell(doc, templates.front);
      drawWalletCardText(doc, studentName, WALLET_CARD_LAYOUT.front.studentName);
      drawWalletCardText(doc, courseName, WALLET_CARD_LAYOUT.front.courseName);
      drawWalletCardText(
        doc,
        'COMPLETED',
        WALLET_CARD_LAYOUT.front.completedLabel
      );
      drawWalletCardText(
        doc,
        completedDate,
        WALLET_CARD_LAYOUT.front.completedDate
      );
      drawWalletCardText(
        doc,
        'VALID THROUGH',
        WALLET_CARD_LAYOUT.front.validThroughLabel
      );
      drawWalletCardText(
        doc,
        validThrough,
        WALLET_CARD_LAYOUT.front.validThrough
      );
    } else {
      doc.image(templates.back, 0, 0, {
        width: WALLET_CARD_PAGE_SIZE[0],
        height: WALLET_CARD_PAGE_SIZE[1],
      });

      drawWalletBackShell(doc);
      drawWalletCardText(doc, courseName, WALLET_CARD_LAYOUT.back.courseName);
      drawWalletCardText(doc, instructorName, WALLET_CARD_LAYOUT.back.instructor);
      drawWalletCardText(
        doc,
        'INSTRUCTOR CERTIFICATION',
        WALLET_CARD_LAYOUT.back.instructorCertification
      );
      drawSignatureImage(
        doc,
        signatureImage,
        WALLET_CARD_LAYOUT.back.shell.signatureImage,
        { align: 'left', fillBackground: false, trimWhitespace: true }
      );
      drawWalletCardText(doc, completedDate, WALLET_CARD_LAYOUT.back.dateIssued);
      drawWalletCardText(doc, validThrough, WALLET_CARD_LAYOUT.back.validThrough);
    }

    doc.end();
  });
}

async function generateCertificatePdfs(session, records, workDir, supabase) {
  const template = await loadCertificateTemplate();
  const usedNames = new Set();
  const pdfFiles = [];
  const trainerSignatureImage = await fetchSignatureImage(
    getTrainerSignatureSource(session),
    supabase
  );

  for (const record of records) {
    const data = getTemplateData(session, record);
    const pdfName = getUniquePdfName(data.name, usedNames);
    const pdfBuffer = await createCertificatePdfBuffer(
      data,
      template,
      trainerSignatureImage
    );
    const pdfPath = path.join(workDir, pdfName);

    await fs.writeFile(pdfPath, pdfBuffer);
    pdfFiles.push({ path: pdfPath, name: pdfName });
  }

  return pdfFiles;
}

async function generateWalletCardPdfs(session, records, supabase) {
  const templates = await loadWalletCardTemplates();
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
      name: getUniqueWalletCardPdfName(studentName, usedNames, 'front'),
      buffer: frontBuffer,
    });
    pdfFiles.push({
      name: getUniqueWalletCardPdfName(studentName, usedNames, 'back'),
      buffer: backBuffer,
    });
  }

  return pdfFiles;
}

function sendZipResponse(response, files, fileName, cleanup) {
  const zip = new JSZip();

  files.forEach((file) => {
    zip.file(file.name, fsSync.createReadStream(file.path));
  });

  zip
    .generateAsync({ type: 'nodebuffer' })
    .then((zipBuffer) => {
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      response.send(zipBuffer);
    })
    .catch((error) => {
      console.error('ZIP generation error:', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Failed to create certificate ZIP.' });
      } else {
        response.destroy(error);
      }
    })
    .finally(cleanup);
}

async function sendZipBufferResponse(response, files, fileName) {
  const zip = new JSZip();

  files.forEach((file) => {
    zip.file(file.name, file.buffer);
  });

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  response.setHeader('Content-Type', 'application/zip');
  response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  response.send(zipBuffer);
}

async function runLocalNetlifyFunction(request, response, handler) {
  const result = await handler({
    httpMethod: request.method,
    headers: request.headers,
    body:
      request.method === 'GET' || request.method === 'HEAD'
        ? ''
        : JSON.stringify(request.body || {}),
    queryStringParameters: request.query || {},
  });

  Object.entries(result.headers || {}).forEach(([headerName, headerValue]) => {
    response.setHeader(headerName, headerValue);
  });

  const responseBody = result.isBase64Encoded
    ? Buffer.from(result.body || '', 'base64')
    : result.body || '';

  response.status(result.statusCode || 200).send(responseBody);
}

app.all('/.netlify/functions/instructor-users', async (request, response) => {
  try {
    await runLocalNetlifyFunction(request, response, instructorUsersHandler);
  } catch (error) {
    console.error('Local instructor-users function error:', error);
    response.status(500).json({
      error: error?.message || 'Unable to run instructor users function locally.',
    });
  }
});

app.all('/.netlify/functions/attendance-records', async (request, response) => {
  try {
    await runLocalNetlifyFunction(request, response, attendanceRecordsHandler);
  } catch (error) {
    console.error('Local attendance-records function error:', error);
    response.status(500).json({
      error: error?.message || 'Unable to run attendance records function locally.',
    });
  }
});

app.all('/.netlify/functions/certificates-session', async (request, response) => {
  try {
    await runLocalNetlifyFunction(request, response, certificatesSessionHandler);
  } catch (error) {
    console.error('Local certificates-session function error:', error);
    response.status(500).json({
      error: error?.message || 'Unable to run certificates function locally.',
    });
  }
});

app.all('/.netlify/functions/wallet-cards-session', async (request, response) => {
  try {
    await runLocalNetlifyFunction(request, response, walletCardsSessionHandler);
  } catch (error) {
    console.error('Local wallet-cards-session function error:', error);
    response.status(500).json({
      error: error?.message || 'Unable to run wallet cards function locally.',
    });
  }
});

app.all('/.netlify/functions/saved-quiz-library', async (request, response) => {
  try {
    await runLocalNetlifyFunction(request, response, savedQuizLibraryHandler);
  } catch (error) {
    console.error('Local saved-quiz-library function error:', error);
    response.status(500).json({
      error: error?.message || 'Unable to run saved quiz library function locally.',
    });
  }
});

app.post('/api/certificates/session/:sessionId', async (request, response) => {
  const supabase = getSupabaseClient();

  if (!supabase) {
    response.status(500).json({
      error: 'Server is missing Supabase configuration.',
    });
    return;
  }

  const { sessionId } = request.params;
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `attendance-certificates-${crypto.randomUUID()}-`)
  );
  let cleanupStarted = false;

  const cleanup = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    fs.rm(workDir, { recursive: true, force: true }).catch((error) => {
      console.error('Certificate cleanup error:', error);
    });
  };

  try {
    if (!fsSync.existsSync(templatePath)) {
      response.status(500).json({
        error: 'Certificate template is missing from the server.',
      });
      cleanup();
      return;
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
      response.status(404).json({ error: 'Training session not found.' });
      cleanup();
      return;
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
      response.status(400).json({
        error: 'No students found for this session.',
      });
      cleanup();
      return;
    }

    const pdfFiles = await generateCertificatePdfs(
      sessionResult.data,
      records,
      workDir,
      supabase
    );
    const zipName = `${cleanFileName(
      sessionResult.data.course_name,
      'Training_Session'
    )}_Certificates.zip`;

    sendZipResponse(response, pdfFiles, zipName, cleanup);
  } catch (error) {
    console.error('Certificate generation error:', error);

    if (!response.headersSent) {
      const message = error?.message || 'Failed to generate certificates.';

      response.status(500).json({ error: message });
    }

    cleanup();
  }
});

app.post('/api/wallet-cards/session/:sessionId', async (request, response) => {
  const supabase = getSupabaseClient();

  if (!supabase) {
    response.status(500).json({
      error: 'Server is missing Supabase configuration.',
    });
    return;
  }

  const { sessionId } = request.params;

  try {
    if (
      !fsSync.existsSync(walletCardFrontTemplatePath) ||
      !fsSync.existsSync(walletCardBackTemplatePath)
    ) {
      response.status(500).json({
        error: 'Wallet card templates are missing from the server.',
      });
      return;
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
      response.status(404).json({ error: 'Training session not found.' });
      return;
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
      response.status(400).json({
        error: 'No students found for this session.',
      });
      return;
    }

    const pdfFiles = await generateWalletCardPdfs(
      sessionResult.data,
      records,
      supabase
    );
    const zipName = `${cleanWalletZipFileName(
      sessionResult.data.course_name,
      'training-session'
    )}-wallet-cards.zip`;

    await sendZipBufferResponse(response, pdfFiles, zipName);
  } catch (error) {
    console.error('Wallet card generation error:', error);

    if (!response.headersSent) {
      const message = error?.message || 'Failed to generate wallet cards.';

      response.status(500).json({ error: message });
    }
  }
});

app.listen(port, () => {
  console.log(`Certificate server listening on http://localhost:${port}`);
});
