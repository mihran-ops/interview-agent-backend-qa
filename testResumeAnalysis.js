const path = require('path');
const analyzeResume = require('./src/services/analyzeResume');

const candidate = {
  id: '201ad371-c8b5-4be4-81a3-38289017a6c6',
  name: 'Test Candidate',
  email: 'test@example.com'
};

const role = {
  description: `We are hiring a Senior Backend Developer with experience in Node.js, REST APIs, and PostgreSQL.`
};

const resumePath = path.join(__dirname, 'JG 2025 Resume.pdf');

analyzeResume(candidate, resumePath, role)
  .then(result => {
    console.log('✅ Resume Analysis Result:', result);
  })
  .catch(err => {
    console.error('❌ Error analyzing resume:', err.message);
  });
