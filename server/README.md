# Certificate Server

The admin page calls `POST /api/certificates/session/:sessionId` to generate
one PDF certificate per student and return a ZIP file.

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` is recommended.
- If the service role key is not present, the server falls back to
  `VITE_SUPABASE_ANON_KEY` for read-only certificate generation.

The service role key stays on the server and must not be exposed to the Vite
frontend.

PDF files are generated directly in Node with `pdfkit`; no local desktop script
or LibreOffice installation is required. The renderer reads
`server/templates/certificate_template.docx` and uses its embedded certificate
artwork as the PDF background.
