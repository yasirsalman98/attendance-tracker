import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import PizZip from 'pizzip';
import JSZip from 'jszip';

const templatePath = path.resolve(
  process.cwd(),
  'server/templates/certificate_template.docx'
);
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

function cleanFileName(value, fallback = 'certificate') {
  const cleaned = String(value || fallback)
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
    console.error('Certificate signature crop error:', error);
    return buffer;
  }
}

function drawSignatureImage(doc, imageBuffer, layout) {
  if (!imageBuffer) return;

  try {
    doc.image(cleanTrainerSignaturePng(imageBuffer), layout.x, layout.y, {
      fit: [layout.width, layout.height],
      align: 'center',
      valign: 'center',
    });
  } catch (error) {
    console.error('Certificate signature render error:', error);
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

    drawSignatureImage(doc, signatureImage, CERT_LAYOUT.signatureImage);

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

async function generateCertificatePdfs(session, records, supabase) {
  const template = await loadCertificateTemplate();
  const usedNames = new Set();
  const pdfFiles = [];
  const trainerSignatureImage = await fetchSignatureImage(
    getTrainerSignatureSource(session),
    supabase
  );

  for (const record of records) {
    const data = getTemplateData(session, record);
    const buffer = await createCertificatePdfBuffer(
      data,
      template,
      trainerSignatureImage
    );

    pdfFiles.push({
      name: getUniquePdfName(data.name, usedNames),
      buffer,
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

  if (!sessionId) {
    return jsonResponse(400, 'Missing session ID.');
  }

  const supabase = getSupabaseClient();

  if (!supabase) {
    return jsonResponse(500, 'Server is missing Supabase configuration.');
  }

  try {
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

    const pdfFiles = await generateCertificatePdfs(
      sessionResult.data,
      records,
      supabase
    );
    const zipBuffer = await zipFiles(pdfFiles);
    const zipName = `${cleanFileName(
      sessionResult.data.course_name,
      'Training_Session'
    )}_Certificates.zip`;

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
    console.error('Certificate generation error:', error);
    return jsonResponse(500, error?.message || 'Failed to generate certificates.');
  }
}
