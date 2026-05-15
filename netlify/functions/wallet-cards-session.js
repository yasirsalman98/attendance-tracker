import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
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
const CARD_LAYOUT = {
  front: {
    studentName: {
      x: 170,
      y: 260,
      width: 710,
      fontSize: 40,
      minFontSize: 28,
      align: 'center',
      color: '#000000',
      font: 'Helvetica-Bold',
    },
    courseName: {
      x: 170,
      y: 375,
      width: 710,
      fontSize: 28,
      minFontSize: 18,
      align: 'center',
      color: '#000000',
      font: 'Helvetica-Bold',
    },
    completedDate: {
      x: 245,
      y: 498,
      width: 190,
      fontSize: 16,
      align: 'center',
      color: '#000000',
      font: 'Helvetica-Bold',
    },
    validThrough: {
      x: 655,
      y: 498,
      width: 190,
      fontSize: 16,
      align: 'center',
      color: '#000000',
      font: 'Helvetica-Bold',
    },
  },
  back: {
    courseName: {
      x: 540,
      y: 160,
      width: 380,
      fontSize: 14,
      minFontSize: 10,
      align: 'center',
      color: '#036f5e',
      font: 'Helvetica-Bold',
    },
    instructor: {
      x: 540,
      y: 230,
      width: 380,
      fontSize: 14,
      align: 'center',
      color: '#036f5e',
      font: 'Helvetica-Bold',
    },
    instructorCertification: {
      x: 540,
      y: 300,
      width: 380,
      fontSize: 14,
      align: 'center',
      color: '#036f5e',
      font: 'Helvetica-Bold',
    },
    signature: {
      x: 540,
      y: 360,
      width: 380,
      fontSize: 16,
      align: 'center',
      color: '#036f5e',
      font: 'Helvetica-Bold',
    },
    dateIssued: {
      x: 540,
      y: 430,
      width: 380,
      fontSize: 14,
      align: 'center',
      color: '#036f5e',
      font: 'Helvetica-Bold',
    },
    validThrough: {
      x: 540,
      y: 500,
      width: 380,
      fontSize: 14,
      align: 'center',
      color: '#036f5e',
      font: 'Helvetica-Bold',
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
  const supabaseServerKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function getUniquePdfName(studentName, usedNames) {
  const baseName = `${cleanPdfFileName(studentName, 'Student')}_wallet_card`;
  let fileName = `${baseName}.pdf`;
  let index = 2;

  while (usedNames.has(fileName.toLowerCase())) {
    fileName = `${baseName}_${index}.pdf`;
    index += 1;
  }

  usedNames.add(fileName.toLowerCase());
  return fileName;
}

async function loadCardTemplates() {
  const [front, back] = await Promise.all([
    fs.readFile(frontTemplatePath),
    fs.readFile(backTemplatePath),
  ]);

  return { front, back };
}

function getFittingFontSize(doc, text, layout) {
  let size = layout.fontSize;
  const minSize = layout.minFontSize || layout.fontSize;

  doc.font(layout.font);

  while (size > minSize && doc.widthOfString(text, { size }) > layout.width * 0.96) {
    size -= 1;
  }

  return size;
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
      lineBreak: true,
    });
}

function createWalletCardPdfBuffer(session, record, templates) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE_SIZE,
      margin: 0,
    });
    const chunks = [];
    const studentName = formatStudentName(record.student_name);
    const courseName = session.course_name || 'Training Session';
    const completedDate = formatDate(session.training_date);
    const validThrough = formatDate(addYearsToDate(session.training_date, 3));
    const instructorName = session.trainer_name || 'N/A';

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.image(templates.front, 0, 0, {
      width: PAGE_SIZE[0],
      height: PAGE_SIZE[1],
    });

    drawText(doc, studentName, CARD_LAYOUT.front.studentName);
    drawText(doc, courseName, CARD_LAYOUT.front.courseName);
    drawText(doc, completedDate, CARD_LAYOUT.front.completedDate);
    drawText(doc, validThrough, CARD_LAYOUT.front.validThrough);

    doc.addPage({
      size: PAGE_SIZE,
      margin: 0,
    });

    doc.image(templates.back, 0, 0, {
      width: PAGE_SIZE[0],
      height: PAGE_SIZE[1],
    });

    drawText(doc, courseName, CARD_LAYOUT.back.courseName);
    drawText(doc, instructorName, CARD_LAYOUT.back.instructor);
    drawText(
      doc,
      'Instructor Certification',
      CARD_LAYOUT.back.instructorCertification
    );
    drawText(doc, instructorName, CARD_LAYOUT.back.signature);
    drawText(doc, completedDate, CARD_LAYOUT.back.dateIssued);
    drawText(doc, validThrough, CARD_LAYOUT.back.validThrough);

    doc.end();
  });
}

async function generateWalletCardPdfs(session, records) {
  const templates = await loadCardTemplates();
  const usedNames = new Set();
  const pdfFiles = [];

  for (const record of records) {
    const studentName = formatStudentName(record.student_name);
    const buffer = await createWalletCardPdfBuffer(session, record, templates);

    pdfFiles.push({
      name: getUniquePdfName(studentName, usedNames),
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

    const pdfFiles = await generateWalletCardPdfs(sessionResult.data, records);
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
