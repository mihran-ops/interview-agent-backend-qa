'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { parseBufferToText } = require('../src/render/jdParser');

test('PDF JD parser preserves legitimate repeated letters in the regression fixture', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'jd-parser-repeated-letters.pdf');
  const text = await parseBufferToText(
    fs.readFileSync(fixturePath),
    'application/pdf',
    path.basename(fixturePath)
  );

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    'The office supports effective communication.',
    'Coffee committee staff assess successful follow-up.',
    'Bookkeeping accuracy matters in a dental office.'
  ]);
  assert.match(text, /office/);
  assert.match(text, /Coffee committee/);
  assert.match(text, /Bookkeeping/);
  assert.doesNotMatch(text, /Thee|officce|cofffee|commmittee|bookkkeeping/);
});
