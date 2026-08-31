const CONFIG = Object.freeze({
  owner: "interojo-160907",
  repo: "lfp",
  branch: "main",
  path: "web/data/lidding-delivery-management.json",
  allowedOrigin: "https://interojo-160907.github.io",
  maxBodyBytes: 256_000,
  maxRows: 1_000,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === CONFIG.allowedOrigin ? origin : CONFIG.allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function jsonResponse(origin, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders(origin),
  });
}

function secureEqual(left, right) {
  const a = encoder.encode(String(left || ""));
  const b = encoder.encode(String(right || ""));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] || 0) ^ (b[index % Math.max(b.length, 1)] || 0);
  }
  return mismatch === 0;
}

function normalizeText(value, maxLength = 1_000) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

function recordKey(itemCode, spec) {
  return `${normalizeText(itemCode, 80).toUpperCase()}|${normalizeText(spec, 120).toUpperCase()}`;
}

function validIsoDate(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeText(item, 120)).filter(Boolean))].sort();
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToText(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return decoder.decode(bytes);
}

function githubHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "lfp-schedule-relay",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function contentsUrl(path = CONFIG.path) {
  return `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`;
}

async function readSchedule(env) {
  const response = await fetch(`${contentsUrl()}?ref=${encodeURIComponent(CONFIG.branch)}`, {
    headers: githubHeaders(env),
  });
  if (response.status === 404) {
    return { sha: "", payload: { updatedAt: "", records: {} } };
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub read failed (${response.status}): ${result.message || "unknown error"}`);
  }
  let payload;
  try {
    payload = JSON.parse(base64ToText(result.content));
  } catch (_) {
    throw new Error("Stored schedule JSON is invalid.");
  }
  if (!payload || typeof payload !== "object") payload = {};
  if (!payload.records || typeof payload.records !== "object" || Array.isArray(payload.records)) payload.records = {};
  return { sha: normalizeText(result.sha, 100), payload };
}

async function readRepositoryJson(env, path) {
  const response = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(CONFIG.branch)}`, {
    headers: githubHeaders(env),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}): ${result.message || "unknown error"}`);
  try {
    return JSON.parse(base64ToText(result.content));
  } catch (_) {
    throw new Error(`Stored JSON is invalid: ${path}`);
  }
}

async function writeSchedule(env, sha, payload, message) {
  const content = bytesToBase64(encoder.encode(`${JSON.stringify(payload, null, 2)}\n`));
  const body = {
    message,
    content,
    branch: CONFIG.branch,
  };
  if (sha) body.sha = sha;
  const response = await fetch(contentsUrl(), {
    method: "PUT",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

async function mutateSchedule(env, mutate, message) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { sha, payload } = await readSchedule(env);
    const outcome = mutate(payload);
    if (!outcome.changed) return { ...outcome.result, committed: false };
    payload.updatedAt = new Date().toISOString();
    const { response, result } = await writeSchedule(env, sha, payload, message);
    if (response.ok) {
      return { ...outcome.result, committed: true, commit: result.commit?.sha || "" };
    }
    if (![409, 422].includes(response.status) || attempt === 3) {
      throw new Error(`GitHub write failed (${response.status}): ${result.message || "unknown error"}`);
    }
  }
  throw new Error("GitHub write conflict.");
}

function updateRows(payload, rows, importStats) {
  const records = payload.records;
  const now = new Date().toISOString();
  let updated = 0;
  let noted = 0;
  let unchanged = 0;
  let changed = false;

  for (const raw of rows) {
    const itemCode = normalizeText(raw?.itemCode, 80);
    const spec = normalizeText(raw?.spec, 120);
    const adjustedDate = normalizeText(raw?.adjustedDate, 10);
    const note = normalizeText(raw?.note, 1_000);
    if (!itemCode || (!adjustedDate && !note)) continue;
    if (adjustedDate && !validIsoDate(adjustedDate)) {
      throw new Error(`invalid_adjusted_date:${itemCode}`);
    }

    const key = recordKey(itemCode, spec);
    const record = records[key] || {
      itemCode,
      spec,
      confirmedDate: "",
      history: [],
    };
    if (!Array.isArray(record.history)) record.history = [];

    if (adjustedDate) {
      const previous = normalizeText(record.confirmedDate || raw?.confirmedDate, 10);
      if (previous !== adjustedDate) {
        const requested = normalizeText(raw?.requestedDate, 10);
        record.history.push({
          at: now,
          type: "date",
          text: previous
            ? `납기일 수정 ${previous} → ${adjustedDate}`
            : `납기요청일 ${requested || "-"} → 납기확정일 ${adjustedDate}`,
        });
        updated += 1;
        changed = true;
      } else {
        unchanged += 1;
      }
      record.confirmedDate = adjustedDate;
    }

    if (note) {
      const duplicate = record.history.some((entry) => entry?.type === "note" && normalizeText(entry?.text) === note);
      if (!duplicate) {
        record.history.push({ at: now, type: "note", text: note });
        noted += 1;
        changed = true;
      } else {
        unchanged += 1;
      }
    }

    record.itemCode = itemCode;
    record.spec = spec;
    record.requestNos = normalizeStringList(raw?.requestNos);
    record.orderNos = normalizeStringList(raw?.orderNos);
    record.waitingStatus = normalizeText(raw?.waitingStatus, 80);
    records[key] = record;
  }

  return {
    changed,
    result: {
      ok: true,
      ...(importStats && typeof importStats === "object" ? importStats : {}),
      updated,
      noted,
      unchanged,
    },
  };
}

function appendNote(payload, body) {
  const itemCode = normalizeText(body?.itemCode, 80);
  const spec = normalizeText(body?.spec, 120);
  const note = normalizeText(body?.note, 1_000);
  if (!itemCode || !note) throw new Error("invalid_note");
  const key = recordKey(itemCode, spec);
  const record = payload.records[key] || {
    itemCode,
    spec,
    confirmedDate: "",
    history: [],
  };
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push({ at: new Date().toISOString(), type: "note", text: note });
  payload.records[key] = record;
  return { changed: true, result: { ok: true, record } };
}

function reconcileRecords(payload, keys) {
  if (!Array.isArray(keys)) throw new Error("invalid_keys");
  let removed = 0;
  for (const key of keys.slice(0, CONFIG.maxRows)) {
    if (delete payload.records[normalizeText(key, 220).toUpperCase()]) removed += 1;
  }
  return { changed: removed > 0, result: { ok: true, removed } };
}

async function reconcileFromPurchase(env) {
  const purchase = await readRepositoryJson(env, "web/data/lidding-purchase-inbound.json");
  if (!Array.isArray(purchase?.items)) throw new Error("Purchase data has an invalid shape.");
  const activeKeys = new Set(purchase.items
    .filter((item) => Number(item?.inboundWaitQty || 0) > 0 || Number(item?.purchaseWaitQty || 0) > 0)
    .map((item) => recordKey(item?.itemCode, item?.specification)));
  return mutateSchedule(env, (payload) => {
    const keys = Object.keys(payload.records || {}).filter((key) => !activeKeys.has(key));
    return reconcileRecords(payload, keys);
  }, "data: reset completed delivery schedules");
}

async function parseBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > CONFIG.maxBodyBytes) throw new Error("request_too_large");
  const raw = await request.text();
  if (encoder.encode(raw).length > CONFIG.maxBodyBytes) throw new Error("request_too_large");
  try {
    return JSON.parse(raw || "{}");
  } catch (_) {
    throw new Error("invalid_json");
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (origin && origin !== CONFIG.allowedOrigin) return jsonResponse(origin, 403, { ok: false, error: "origin_not_allowed" });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/data") {
        if (!env.GITHUB_TOKEN) return jsonResponse(origin, 500, { ok: false, error: "missing_worker_secrets" });
        try {
          await reconcileFromPurchase(env);
          const { payload } = await readSchedule(env);
          return jsonResponse(origin, 200, { ok: true, ...payload });
        } catch (error) {
          return jsonResponse(origin, 502, { ok: false, error: "relay_failed", detail: normalizeText(error?.message || error, 500) });
        }
      }
      return jsonResponse(origin, 200, { ok: true, service: "lfp-schedule-relay" });
    }
    if (request.method !== "POST") return jsonResponse(origin, 405, { ok: false, error: "method_not_allowed" });
    if (origin && origin !== CONFIG.allowedOrigin) return jsonResponse(origin, 403, { ok: false, error: "origin_not_allowed" });
    if (!env.GITHUB_TOKEN || !env.UPLOAD_PASSWORD) return jsonResponse(origin, 500, { ok: false, error: "missing_worker_secrets" });

    try {
      const body = await parseBody(request);
      if (!secureEqual(body.password, env.UPLOAD_PASSWORD)) {
        return jsonResponse(origin, 401, { ok: false, error: "invalid_password", detail: "업데이트 비밀번호가 올바르지 않습니다." });
      }

      let result;
      if (url.pathname === "/update") {
        if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > CONFIG.maxRows) throw new Error("invalid_rows");
        result = await mutateSchedule(
          env,
          (payload) => updateRows(payload, body.rows, body.importStats),
          "data: update delivery schedule",
        );
      } else if (url.pathname === "/note") {
        result = await mutateSchedule(env, (payload) => appendNote(payload, body), "data: append delivery note");
      } else if (url.pathname === "/reconcile") {
        result = await mutateSchedule(env, (payload) => reconcileRecords(payload, body.keys), "data: reconcile completed deliveries");
      } else {
        return jsonResponse(origin, 404, { ok: false, error: "not_found" });
      }
      return jsonResponse(origin, 200, result);
    } catch (error) {
      const message = normalizeText(error?.message || error, 500);
      const isClientError = /^(invalid_|request_too_large)/.test(message);
      return jsonResponse(origin, isClientError ? 400 : 502, {
        ok: false,
        error: isClientError ? message.split(":")[0] : "relay_failed",
        detail: message,
      });
    }
  },
};
