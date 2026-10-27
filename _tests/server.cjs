// Server statico con gzip, come GitHub Pages. Uso: node server.cjs [cartella] [porta]
const http = require("http"), fs = require("fs"), path = require("path"), zlib = require("zlib");
const root = path.resolve(process.argv[2] || path.join(__dirname, "..")), port = +process.argv[3] || 8766;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".wasm": "application/wasm", ".bcmap": "application/octet-stream", ".icc": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf" };
const gz = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".wasm"]);
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = path.join(root, p);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end("404"); }
  const ext = path.extname(f);
  let body = fs.readFileSync(f);
  const headers = { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "max-age=600" };
  if (req.method === "POST") { res.writeHead(405); return res.end(); }
  if (gz.has(ext) && /gzip/.test(req.headers["accept-encoding"] || "")) { body = zlib.gzipSync(body, { level: 6 }); headers["Content-Encoding"] = "gzip"; }
  res.writeHead(200, headers); res.end(body);
}).listen(port, "127.0.0.1", () => console.log(`Lettore su http://127.0.0.1:${port}/pdf/`));
