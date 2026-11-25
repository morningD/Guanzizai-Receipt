import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appDirectory, receiptDataRoot } from "../scripts/portable/update-layout.mjs";
import { createDataLibraryApi } from "./data-library-api";
import { createAppUpdateHandler } from "./app-update";

const host = "127.0.0.1";
const dist = fileURLToPath(new URL("../", import.meta.url));
const dataRoot = receiptDataRoot();
const installRoot = process.env.RECEIPT_INSTALL_ROOT;
const pairedInstall = installRoot && path.resolve(dist) === path.resolve(installRoot, appDirectory, "dist");
const update = createAppUpdateHandler(pairedInstall ? { installRoot, dataRoot } : {});
const dataLibrary = pairedInstall && installRoot && process.env.RECEIPT_DATA_LIBRARY === "1"
  ? createDataLibraryApi(installRoot, dataRoot) : null;
const accessToken = randomBytes(32).toString("hex");
const sessionCookie = `receipt_local_session=${accessToken}`;
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

if (!existsSync(path.join(dist, "index.html"))) throw new Error("缺少构建后的票据簿页面");
await mkdir(path.join(dataRoot, "data"), { recursive: true });
await mkdir(path.join(dataRoot, "01_报销材料"), { recursive: true });

// The compatibility middleware resolves legacy data-relative paths on import.
process.env.RECEIPT_DATA_ROOT = dataRoot;
process.env.RECEIPT_RUNTIME = "portable";
const { createLocalMaterialsMiddleware, diagnostics } = await import("./local-materials");
const serveApi = createLocalMaterialsMiddleware();

const server = createServer(async (request, response) => {
  const authority = `${host}:${request.socket.localPort}`;
  const origin = `http://${authority}`;
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.headers.host !== authority
    || (request.headers.origin && request.headers.origin !== origin)
    || request.headers["sec-fetch-site"] === "cross-site") {
    response.writeHead(403).end();
    return;
  }

  try {
    const url = new URL(request.url || "/", origin);
    if (request.method === "GET" && url.pathname === "/start" && url.searchParams.get("session") === accessToken) {
      response.writeHead(303, {
        Location: "/",
        "Cache-Control": "no-store",
        "Set-Cookie": `${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`,
      }).end();
      return;
    }
    if (!request.headers.cookie?.split(";").some((value) => value.trim() === sessionCookie)) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end("请通过启动脚本打开票据簿。");
      return;
    }
    if (url.pathname === "/api/data-library" && dataLibrary) {
      await dataLibrary(request, response);
      return;
    }
    if (url.pathname === "/api/app-update") {
      await diagnostics.track(request, response, url.pathname, () => update(request, response));
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/materials/")) {
      await serveApi(request, response, () => response.writeHead(404).end());
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    if (request.method !== "GET" || (pathname !== "/" && !pathname.startsWith("/assets/"))) {
      response.writeHead(404).end();
      return;
    }
    const file = path.resolve(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    const assets = path.join(dist, "assets") + path.sep;
    if ((pathname !== "/" && !file.startsWith(assets)) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    createReadStream(file).on("error", () => response.destroy()).pipe(response);
  } catch (error) {
    console.error(error);
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end();
  }
});
server.listen(0, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  const url = `http://${host}:${address.port}/start?session=${accessToken}`;
  console.log(`票据簿数据目录：${dataRoot}\n打开票据簿：${url}`);
  if (process.argv.includes("--no-browser")) return;

  const command = process.platform === "win32" ? "rundll32.exe" : "open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  execFile(command, args, (error) => {
    if (error) console.error("无法自动打开浏览器，请复制上面的地址。");
  });
});

process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
