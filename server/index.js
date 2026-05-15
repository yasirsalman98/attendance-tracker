import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import PizZip from 'pizzip';
import JSZip from 'jszip';

const app = express();
const port = Number(process.env.PORT || 3001);

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServerKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const templatePath = path.resolve('server/templates/certificate_template.docx');
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
  if (record.signature_path) {
    try {
      const { data, error } = await supabase.storage
        .from('signatures')
        .download(record.signature_path);

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

  if (!record.signature_url) return null;

  try {
    const response = await fetch(record.signature_url);

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

async function generateCertificatePdfs(session, records, workDir, supabase) {
  const template = await loadCertificateTemplate();
  const usedNames = new Set();
  const pdfFiles = [];

  for (const record of records) {
    const data = getTemplateData(session, record);
    const pdfName = getUniquePdfName(data.name, usedNames);
    const signatureImage = await fetchSignatureImage(record, supabase);
    const pdfBuffer = await createCertificatePdfBuffer(
      data,
      template,
      signatureImage
    );
    const pdfPath = path.join(workDir, pdfName);

    await fs.writeFile(pdfPath, pdfBuffer);
    pdfFiles.push({ path: pdfPath, name: pdfName });
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

app.listen(port, () => {
  console.log(`Certificate server listening on http://localhost:${port}`);
});
