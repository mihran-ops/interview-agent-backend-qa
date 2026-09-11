'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  MAX_RESUME_BYTES,
  ResumeUploadError,
  inspectResumeFile,
  uploadResumeObject
} = require('../src/services/resumeUpload');

const REPORTLAB_XREF_PDF_BASE64 = `
JVBERi0xLjQKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+
CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlw
ZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA2MTIgNzkyIF0g
L1BhcmVudCA2IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSIC9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdl
SSBdCj4+IC9Sb3RhdGUgMCAvVHJhbnMgPDwKCj4+IAogIC9UeXBlIC9QYWdlCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9QYWdlTW9kZSAvVXNlTm9u
ZSAvUGFnZXMgNiAwIFIgL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0F1dGhvciAoYW5vbnltb3VzKSAvQ3JlYXRpb25EYXRl
IChEOjIwMjYwNzI3MTYzMDM4LTA2JzAwJykgL0NyZWF0b3IgKGFub255bW91cykgL0tleXdvcmRzICgpIC9Nb2REYXRlIChEOjIwMjYwNzI3MTYz
MDM4LTA2JzAwJykgL1Byb2R1Y2VyIChSZXBvcnRMYWIgUERGIExpYnJhcnkgLSBcKG9wZW5zb3VyY2VcKSkgCiAgL1N1YmplY3QgKHVuc3BlY2lm
aWVkKSAvVGl0bGUgKFN5bnRoZXRpYyBSZXN1bWUgUGFyc2VyIENvbXBhdGliaWxpdHkgRml4dHVyZSkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9i
ago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9B
U0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMjgyCj4+CnN0cmVhbQpHYXJvO2MiWz44JSMiKHBNRS8qa1VpP1loNGYxR2ouXSNA
WSFTPUJzV24+bTNiSFVtOzIsK1U4O0MkdV9NInI8S0QoRzRbNHAjcERmOkBLR18lJjByYm9aUWJPKjkoOWslRkAhZjZSZkRFVWdhZypEK3JFb25Z
T1YyJWo1Iy9zTD8vRUg5MkQqKj0jITREVzJgJDJZJFVvZilBWkhPZEQtKFxIXWs6ZjtPMGw4VE1UUCdTJCRcZjpnOyFpOSVuIWgoUWIvZS5bKEA7
OTFGLVBTTDk9PnAyYyVWT0EhXmVJYThtdWpqJFstLTlwMi1ZdTJVcURGbTlVKEdcKFZqYUgqOD0sTGQjUjJKNmdebFFjLCZaUURJLWtCfj5lbmRz
dHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAw
MDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAwMDM5MiAwMDAwMCBuIAowMDAwMDAwNDYwIDAwMDAwIG4gCjAwMDAwMDA3NTggMDAwMDAgbiAKMDAwMDAw
MDgxNyAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzwwZTk1MDg0OTg5YzE0MzQ0NWIzNzNjZDBiYjg0NTBhYz48MGU5NTA4NDk4OWMxNDM0NDVi
MzczY2QwYmI4NDUwYWM+XQolIFJlcG9ydExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDUg
MCBSCi9Sb290IDQgMCBSCi9TaXplIDgKPj4Kc3RhcnR4cmVmCjExODkKJSVFT0YK
`;

const ENCRYPTED_PDF_BASE64 = `
JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGY2NDcyN2MwMTE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwov
Q291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0
IDAgb2JqCjw8Ci9Db250ZW50cyA1IDAgUgovTWVkaWFCb3ggWyAwIDAgNjEyIDc5MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgNiAwIFIKL1Byb2NT
ZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4KL1JvdGF0ZSAwCi9UcmFucyA8PAo+PgovVHlwZSAvUGFnZQovUGFy
ZW50IDIgMCBSCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXQovTGVuZ3RoIDI4Mgo+
PgpzdHJlYW0KD1BhikPsri2ariq62ZCqrSqpIjTD8D3NV1lgyFP86cvdzQF6PC1CeT6CY3Zu6WYwMXE1GZmxgu+KG2Mj9DzLM3nFs1lsxX647LAk
ZEvpzuZC938PDpdRvFp3Cv4/uHFUDfhUgA28MIO5NrpZdaqbv6TwIas32wAJ7T1UB4sW5m+4Z/z9aG0ZAU3pJACUCl+pOaKa4y2HbDutqI2Wv+
rQIbAs6nuoePAJlItgTZt28PfgQUJWGK7z9v9UuDSDV/t34WplcDPSXMQwqV7kkBhmJydiwFeK/axU86N2a/S5+ORNq9jeT5y4ZhMxsJNpXlpW2
00QHg5z9o+h/csVl0rdHbdmrdJ0eTtpyFOzkxFDwMM9T6gwWdabDQ+JCmVuZHN0cmVhbQplbmRvYmoKNiAwIG9iago8PAovRjEgNyAwIFIKPj4K
ZW5kb2JqCjcgMCBvYmoKPDwKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKL05hbWUgL0YxCi9TdWJ0eXBl
IC9UeXBlMQovVHlwZSAvRm9udAo+PgplbmRvYmoKOCAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVy
IC9TdGFuZGFyZAovTyA8YWJhNjE5NGY5ODI5ZWRhOTM3MTk0NDJjMjE5NTUwMTU3ZWQwNTBjMDRhZjRiYWMyZTEwOTkyMzY2MDcyZGU0MD4KL1Ug
PGY0YWEwNGE0NWQwNGUzYTNiNjc2Zjk3ZmZjMzVkODA1MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAg
OQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAw
MDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDM1NiAwMDAwMCBuIAowMDAwMDAwNzI5IDAwMDAwIG4gCjAwMDAwMDA3NjAgMDAwMDAgbiAKMDAwMDAw
MDg2NyAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDkKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDY1NjUzMzY0MzA2NTMyMzMzNzYy
MzQzNzM3MzI2MjY2NjUzODM3MzU2MjM1MzQzMDMwMzMzNjY1MzY2NTM5MzA+IDw2NTY1MzM2NDMwNjUzMjMzMzc2MjM0MzczNzMyNjI2NjY1Mzgz
NzM1NjIzNTM0MzAzMDMzMzY2NTM2NjUzOTMwPiBdCi9FbmNyeXB0IDggMCBSCj4+CnN0YXJ0eHJlZgoxMDgyCiUlRU9GCg==
`;

function pdfFile(buffer, name = 'resume.pdf') {
  return {
    originalname: name,
    mimetype: 'application/pdf',
    buffer,
    size: buffer.length
  };
}

function mammothFixture(name) {
  return fs.readFileSync(path.join(path.dirname(require.resolve('mammoth')), '..', 'test', 'test-data', name));
}

test('resume inspection accepts a ReportLab PDF rejected by the legacy XRef parser', async () => {
  const buffer = Buffer.from(REPORTLAB_XREF_PDF_BASE64, 'base64');
  const result = await inspectResumeFile(pdfFile(buffer));
  assert.equal(result.extension, 'pdf');
  assert.equal(result.parse_status, 'parsed');
  assert.ok(result.extracted_text_length >= 20);
});

test('resume inspection accepts an existing ordinary PDF fixture', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'jd-parser-repeated-letters.pdf'));
  const result = await inspectResumeFile(pdfFile(buffer));
  assert.equal(result.extension, 'pdf');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('resume inspection rejects malformed and encrypted PDFs with bounded errors', async () => {
  await assert.rejects(
    inspectResumeFile(pdfFile(Buffer.from('%PDF-1.4\nnot a complete document'))),
    (error) => error instanceof ResumeUploadError
      && error.code === 'RESUME_UNREADABLE'
      && error.detail === 'The PDF could not be read.'
  );

  const encrypted = Buffer.from(ENCRYPTED_PDF_BASE64, 'base64');
  await assert.rejects(
    inspectResumeFile(pdfFile(encrypted)),
    (error) => error instanceof ResumeUploadError
      && error.code === 'RESUME_UNREADABLE'
      && error.detail === 'The PDF is encrypted or password-protected.'
  );
});

test('resume inspection preserves empty, oversized, and non-PDF rejection policy', async () => {
  await assert.rejects(
    inspectResumeFile(pdfFile(Buffer.alloc(0))),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_EMPTY'
  );
  await assert.rejects(
    inspectResumeFile(pdfFile(Buffer.alloc(MAX_RESUME_BYTES + 1))),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_UNREADABLE'
  );
  await assert.rejects(
    inspectResumeFile(pdfFile(Buffer.from('not a PDF'), 'resume.txt')),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_UNREADABLE'
  );
});

test('resume parser failures do not emit filenames, document text, or raw parser errors', async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const emitted = [];
  console.error = (...args) => emitted.push(args);
  console.warn = (...args) => emitted.push(args);
  try {
    await assert.rejects(inspectResumeFile(pdfFile(Buffer.from('%PDF-1.4\nprivate synthetic marker'))));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.deepEqual(emitted, []);
});

test('resume inspection rejects zero-byte and invalid DOCX files', async () => {
  await assert.rejects(
    inspectResumeFile({ originalname: 'resume.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.alloc(0), size: 0 }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_EMPTY'
  );
  await assert.rejects(
    inspectResumeFile({ originalname: 'resume.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not-a-docx') }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_UNREADABLE'
  );
});

test('resume inspection rejects a valid but blank DOCX', async () => {
  await assert.rejects(
    inspectResumeFile({
      originalname: 'blank.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: mammothFixture('empty.docx')
    }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_EMPTY'
  );
});

test('resume inspection accepts a readable DOCX and records metadata', async () => {
  const result = await inspectResumeFile({
    originalname: 'resume.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: mammothFixture('single-paragraph.docx')
  });
  assert.equal(result.extension, 'docx');
  assert.equal(result.parse_status, 'parsed');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.extracted_text_length >= 20);
});

test('resume upload does not report success when storage rejects the write', async () => {
  const storage = {
    from() {
      return { upload: async () => ({ error: { message: 'blocked' } }) };
    }
  };
  await assert.rejects(
    uploadResumeObject({
      storage,
      bucket: 'resumes',
      objectPath: 'candidate.docx',
      file: { buffer: Buffer.from('x') },
      inspection: { mime_type: 'application/octet-stream' }
    }),
    (error) => error instanceof ResumeUploadError && error.code === 'RESUME_UPLOAD_FAILED'
  );
});
