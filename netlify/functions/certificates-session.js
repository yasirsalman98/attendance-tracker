import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';
import PizZip from 'pizzip';

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
    x: 500,
    y: 430,
    width: 170,
    height: 46,
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
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

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
    name: record.student_name || 'Student',
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

function drawSignatureImage(doc, imageBuffer, layout) {
  if (!imageBuffer) return;

  doc
    .save()
    .rect(layout.x, layout.y, layout.width, layout.height)
    .fillColor('#ffffff')
    .fillOpacity(0.85)
    .fill()
    .restore();

  doc.image(imageBuffer, layout.x, layout.y, {
    fit: [layout.width, layout.height],
    align: 'center',
    valign: 'center',
  });
}

async function fetchSignatureImage(record, supabase) {
  let signatureUrl = record.signature_url;

  if (!signatureUrl && record.signature_path) {
    const publicUrlResult = supabase.storage
      .from('signatures')
      .getPublicUrl(record.signature_path);

    signatureUrl = publicUrlResult.data?.publicUrl;
  }

  if (!signatureUrl) return null;

  try {
    const response = await fetch(signatureUrl);

    if (!response.ok) return null;

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error('Signature image load error:', error);
    return null;
  }
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

  for (const record of records) {
    const data = getTemplateData(session, record);
    const signatureImage = await fetchSignatureImage(record, supabase);
    const buffer = await createCertificatePdfBuffer(data, template, signatureImage);

    pdfFiles.push({
      name: getUniquePdfName(record.student_name, usedNames),
      buffer,
    });
  }

  return pdfFiles;
}

function zipFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    files.forEach((file) => {
      archive.append(file.buffer, { name: file.name });
    });

    archive.finalize();
  });
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
