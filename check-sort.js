const https = require('https');
const dns = require('dns');

function resolve(h) {
  return new Promise((r, j) => { dns.resolve4(h, (e, a) => e ? j(e) : r(a[0])); });
}

function req(ip, path, body, hdrs = {}) {
  return new Promise((r, j) => {
    const p = JSON.stringify(body);
    const o = https.request({
      hostname: ip, port: 443, path, method: 'POST',
      servername: 'api.usesilo.com',
      headers: { 'Host': 'api.usesilo.com', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p), ...hdrs }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r(d)); });
    o.on('error', j); o.write(p); o.end();
  });
}

async function main() {
  const ip = await resolve('api.usesilo.com');
  const lr = await req(ip, '/api/login', { email: 'rsahni@thecodewiz.com', password: 'Sahnir2026#' });
  const { token } = JSON.parse(lr);

  // Check available orderBy fields for salesOrders
  const introspect = `{
    salesOrder: __type(name: "SalesOrderOrderField") { enumValues { name } }
    purchaseOrder: __type(name: "PurchaseOrderOrderField") { enumValues { name } }
  }`;
  
  const r1 = await req(ip, '/graphql', { query: introspect }, { 'Authorization': 'Bearer ' + token });
  console.log('=== Available OrderBy Fields ===');
  console.log(r1);
  
  // Test CREATED_AT sort
  console.log('\n=== Testing CREATED_AT sort ===');
  const q2 = '{salesOrders(first:3, orderBy:[{field: CREATED_AT, direction: DESC}]){edges{node{createdAt requestedDate customer{companyName}}}}}';
  const r2 = await req(ip, '/graphql', { query: q2 }, { 'Authorization': 'Bearer ' + token });
  console.log(r2);
  
  // Test REQUESTED_DATE sort (known working)
  console.log('\n=== Testing REQUESTED_DATE sort ===');
  const q3 = '{salesOrders(first:3, orderBy:[{field: REQUESTED_DATE, direction: DESC}]){edges{node{createdAt requestedDate customer{companyName}}}}}';
  const r3 = await req(ip, '/graphql', { query: q3 }, { 'Authorization': 'Bearer ' + token });
  console.log(r3);
}

main().catch(console.error);
