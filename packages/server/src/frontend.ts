import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";

const FRONTEND_ROOT = fileURLToPath(new URL("../../web", import.meta.url));
const FRONTEND_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const FRONTEND_INDEX = join(FRONTEND_ROOT, "index.html");
const BUILT_INDEX = join(FRONTEND_DIST, "index.html");
const FRONTEND_SRC = fileURLToPath(new URL("../../web/src", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

interface FrontendHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

function isApiRequest(pathname: string): boolean {
  return (
    pathname.startsWith("/api") ||
    pathname === "/openapi.json" ||
    pathname === "/ws"
  );
}

function isGetLike(method?: string): boolean {
  return method === "GET" || method === "HEAD";
}

function isHtmlRoute(pathname: string): boolean {
  if (pathname.startsWith("/@")) {
    return false;
  }
  return pathname.endsWith("/") || extname(pathname) === "";
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string
): Promise<void> {
  const body = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(filePath));
  res.setHeader("Cache-Control", filePath.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable");

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(body);
}

async function resolveBuiltAsset(pathname: string): Promise<string | null> {
  const relativePath = pathname.replace(/^\/+/, "");
  const requestedPath = resolve(FRONTEND_DIST, relativePath || "index.html");

  if (!requestedPath.startsWith(FRONTEND_DIST)) {
    return null;
  }

  try {
    const info = await stat(requestedPath);
    if (info.isFile()) {
      return requestedPath;
    }
  } catch {
    // Ignore and fall back to the SPA entry below.
  }

  if (isHtmlRoute(pathname)) {
    return BUILT_INDEX;
  }

  return null;
}

export async function createFrontendHandler(
  server: Server
): Promise<FrontendHandler> {
  if (process.env.WORKHORSE_DEV_SERVER === "1") {
    const reactPlugin = (await import("@vitejs/plugin-react")).default;
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: FRONTEND_ROOT,
      configFile: false,
      appType: "spa",
      plugins: [reactPlugin()],
      resolve: {
        alias: {
          "@": FRONTEND_SRC
        }
      },
      server: {
        middlewareMode: {
          server
        }
      }
    });

    return {
      async handle(req, res) {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!isGetLike(req.method) || isApiRequest(url.pathname)) {
          return false;
        }

        if (isHtmlRoute(url.pathname)) {
          const template = await readFile(FRONTEND_INDEX, "utf8");
          const html = await vite.transformIndexHtml(url.pathname, template);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
          return true;
        }

        await new Promise<void>((resolveRequest, rejectRequest) => {
          vite.middlewares(req, res, (error?: unknown) => {
            if (error) {
              rejectRequest(error);
              return;
            }
            resolveRequest();
          });
        });

        if (res.writableEnded) {
          return true;
        }

        return false;
      }
    };
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!isGetLike(req.method) || isApiRequest(url.pathname)) {
        return false;
      }

      try {
        await access(BUILT_INDEX, constants.F_OK);
      } catch {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "FRONTEND_NOT_BUILT",
              message: "Web assets are missing. Run `npm run build` first."
            }
          })
        );
        return true;
      }

      const assetPath = await resolveBuiltAsset(url.pathname);
      if (!assetPath) {
        return false;
      }

      await sendFile(req, res, assetPath);
      return true;
    }
  };
}
