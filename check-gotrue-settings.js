const https = require('https');

// Check GoTrue settings to find any hook configuration
function apiGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'lacasqqbamfbtontddfi.supabase.co',
      path: path,
      method: 'GET',
      headers: {
        'apikey': 'sb_publishable_tKHqArjNrA7b2_NGui1lJg_aM4WFGMZ',
        'Authorization': 'Bearer sb_publishable_tKHqArjNrA7b2_NGui1lJg_aM4WFGMZ'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[${path}] Status:`, res.statusCode);
        try { console.log(JSON.stringify(JSON.parse(data), null, 2)); }
        catch { console.log(data.substring(0, 500)); }
        resolve(data);
      });
    });
    req.on('error', e => { console.log(`[${path}] Error:`, e.message); resolve(null); });
    req.end();
  });
}

async function main() {
  console.log('=== GoTrue Settings ===\n');
  await apiGet('/auth/v1/settings');
  
  console.log('\n=== GoTrue Health ===\n');
  await apiGet('/auth/v1/health');
}

main();
