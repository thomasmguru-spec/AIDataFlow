const FOLDER_ID = '1-gOSrPpQrGIZX632qumhwIz3Jj57ihoj';

(async () => {
  // Try embedded folder view
  const url = `https://drive.google.com/embeddedfolderview?id=${FOLDER_ID}`;
  console.log('Fetching folder:', url);
  const res = await fetch(url, { redirect: 'follow' });
  console.log('Status:', res.status);
  const html = await res.text();
  console.log('Page length:', html.length);
  console.log('Contains flip-entry:', html.includes('flip-entry'));
  
  // Try to find file IDs using a simple pattern
  const regex = /data-id="([^"]+)"/g;
  const ids = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.push(match[1]);
  }
  console.log('File IDs found:', ids.length);
  ids.slice(0, 10).forEach(id => console.log(' -', id));

  // Also try the official API without key
  console.log('\n--- Trying Drive API without auth ---');
  const apiUrl = `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=20`;
  const apiRes = await fetch(apiUrl);
  console.log('API status:', apiRes.status);
  if (apiRes.ok) {
    const data = await apiRes.json();
    console.log('Files:', data.files?.length || 0);
    data.files?.forEach(f => console.log(' -', f.name, f.mimeType));
  } else {
    const err = await apiRes.text();
    console.log('API error:', err.substring(0, 200));
  }
})();
