import type { Request, RequestHandler } from "express";

const JSON_MEDIA_TYPE = /^application\/json$/;
const JSON_SUFFIX_MEDIA_TYPE = /^application\/[a-z0-9!#$&^_.+-]+\+json$/;

/**
 * Forces the request's `Content-Type` to `application/json`.
 *
 * The SDK transport reads Node's `rawHeaders`, so both the parsed header map
 * and the raw header list have to be updated.
 */
function normalizeContentType(req: Request): void {
  const value = "application/json";
  req.headers["content-type"] = value;

  const rawHeaders = req.rawHeaders;
  let found = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "content-type") {
      rawHeaders[i + 1] = value;
      found = true;
    }
  }
  if (!found) {
    rawHeaders.push("Content-Type", value);
  }
}

/**
 * Returns whether a request body may be parsed as JSON.
 *
 * A missing `Content-Type` header is allowed for command-line MCP clients that
 * omit it. When the header is present, only `application/json` and
 * `application/*+json` media types are accepted, ignoring parameters such as
 * `charset=utf-8`.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return true;
  }

  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return JSON_MEDIA_TYPE.test(mediaType) ||
    JSON_SUFFIX_MEDIA_TYPE.test(mediaType);
}

/**
 * Rejects `POST /mcp` requests that declare a non-JSON content type, so
 * clients cannot smuggle other encodings into the JSON-RPC endpoint.
 *
 * Accepted requests are normalized to `application/json` before the SDK
 * transport sees them: the transport rejects a missing header and structured
 * suffixes such as `application/vnd.api+json`, both of which this endpoint
 * deliberately supports (the former for CLI clients).
 */
export function createJsonContentTypeMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!isJsonContentType(req.headers["content-type"])) {
      res.status(415).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Unsupported Media Type: expected application/json or application/*+json.",
        },
        id: null,
      });
      return;
    }

    normalizeContentType(req);
    next();
  };
}
