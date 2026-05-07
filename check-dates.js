const https = require('https');
const dns = require('dns');

function resolveHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses[0]);
    });
  });
}

function httpsReq(method, ip, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: ip, port: 443, path, method,
      servername: 'api.usesilo.com',
      headers: {
        'Host': 'api.usesilo.com', 'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const ip = await resolveHost('api.usesilo.com');
  
  // Login
  const loginRes = await httpsReq('POST', ip, '/api/login', {
    email: 'rsahni@thecodewiz.com',
    password: 'Sahnir2026#'
  });
  const { token } = JSON.parse(loginRes.body);
  
  // Fetch orders
  const query = `{
    salesOrders(first: 10, orderBy: [{ field: REQUESTED_DATE, direction: DESC }]) {
      edges {
        node {
          id requestedDate createdAt
          customer { companyName }
        }
      }
    }
  }`;
  
  const res = await httpsReq('POST', ip, '/graphql', { query }, {
    'Authorization': 'Bearer ' + token
  });
  
  const json = JSON.parse(res.body);
  if (json.errors) { console.error('GraphQL errors:', JSON.stringify(json.errors)); return; }
  
  const edges = json.data?.salesOrders?.edges || [];
  console.log('=== Sales Orders (top 10 by requestedDate DESC) ===');
  console.log('Today is:', new Date().toISOString());
  console.log('');
  edges.forEach((e, i) => {
    const n = e.node;
    const rd = new Date(n.requestedDate);
    const ca = new Date(n.createdAt);
    console.log(`${i+1}. requestedDate raw: "${n.requestedDate}"`);
    console.log(`   requestedDate parsed: ${rd.toISOString()} -> formatted: ${String(rd.getMonth()+1).padStart(2,'0')}/${String(rd.getDate()).padStart(2,'0')}/${rd.getFullYear()}`);
    console.log(`   createdAt raw: "${n.createdAt}"`);
    console.log(`   createdAt parsed: ${ca.toISOString()}`);
    console.log(`   customer: ${n.customer?.companyName}`);
    console.log(`   isFuture: ${rd > new Date()}`);
    console.log('');
  });
}

main().catch(console.error);
