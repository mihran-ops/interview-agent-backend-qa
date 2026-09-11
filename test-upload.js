require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  const response = await fetch("https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
  const buffer = await response.buffer();

  const { data, error } = await supabase.storage
    .from('videos')
    .upload('interviews/test.mp4', buffer, {
      contentType: 'video/mp4',
      upsert: true
    });

  console.log('Upload result:', { data, error });
})();
