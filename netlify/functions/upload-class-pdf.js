const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function sanitizeFileName(fileName) {
  return String(fileName || 'class-archive.pdf').replace(/[<>:"/\\|?*]/g, '-');
}

function getRequiredConfig() {
  const config = {
    tenantId: process.env.MS_TENANT_ID,
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    hostname: process.env.SP_HOSTNAME,
    sitePath: process.env.SP_SITE_PATH,
    folderPath: process.env.SP_FOLDER_PATH,
  };
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing SharePoint configuration: ${missing.join(', ')}`);
  }

  return config;
}

function encodeDrivePath(folderPath, fileName) {
  const parts = String(folderPath || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  parts.push(fileName);

  return parts.map((part) => encodeURIComponent(part)).join('/');
}

async function getGraphToken(config) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
    config.tenantId
  )}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    throw new Error(
      `Microsoft Graph token request failed: ${
        data?.error_description || data?.error || response.statusText
      }`
    );
  }

  return data.access_token;
}

async function getSharePointSite(config, accessToken) {
  const siteUrl = `${GRAPH_BASE_URL}/sites/${config.hostname}:${config.sitePath}`;
  const response = await fetch(siteUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.id) {
    throw new Error(
      `SharePoint site lookup failed: ${
        data?.error?.message || response.statusText
      }`
    );
  }

  return data;
}

async function uploadPdf(config, accessToken, site, fileName, pdfBuffer) {
  const drivePath = encodeDrivePath(config.folderPath, fileName);
  const uploadUrl = `${GRAPH_BASE_URL}/sites/${site.id}/drive/root:/${drivePath}:/content`;
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/pdf',
    },
    body: pdfBuffer,
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.name) {
    throw new Error(
      `SharePoint PDF upload failed: ${
        data?.error?.message || response.statusText
      }`
    );
  }

  return data;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  try {
    const { fileName, pdfBase64 } = JSON.parse(event.body || '{}');

    if (!fileName || !pdfBase64) {
      return jsonResponse(400, { error: 'fileName and pdfBase64 are required.' });
    }

    const config = getRequiredConfig();
    const safeFileName = sanitizeFileName(fileName);
    const base64 = String(pdfBase64).includes(',')
      ? String(pdfBase64).split(',').pop()
      : String(pdfBase64);
    const pdfBuffer = Buffer.from(base64, 'base64');

    if (pdfBuffer.length === 0) {
      return jsonResponse(400, { error: 'pdfBase64 is empty or invalid.' });
    }

    const accessToken = await getGraphToken(config);
    const site = await getSharePointSite(config, accessToken);
    const uploadedFile = await uploadPdf(
      config,
      accessToken,
      site,
      safeFileName,
      pdfBuffer
    );

    return jsonResponse(200, {
      success: true,
      name: uploadedFile.name,
      webUrl: uploadedFile.webUrl,
    });
  } catch (error) {
    console.error('SharePoint class PDF upload error:', error);
    return jsonResponse(500, {
      error: error?.message || 'SharePoint PDF upload failed.',
    });
  }
}
