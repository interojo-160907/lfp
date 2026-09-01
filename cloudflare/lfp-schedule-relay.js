const CONFIG = Object.freeze({
  owner: "interojo-160907",
  repo: "lfp",
  branch: "main",
  path: "web/data/lidding-delivery-management.json",
  automationStatePath: "web/data/automation-state.json",
  dispatchStatePath: ".github/lfp-dispatch-state.json",
  apiBaseUrl: "https://plan.interojo.net",
  automaticEventType: "lfp-auto-collect",
  productionEventType: "lfp-production-collect",
  productionCron: "0 23 * * *",
  regularIntervalMs: 16 * 60 * 60 * 1_000,
  dispatchCooldownMs: 10 * 60 * 1_000,
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

async function readRepositoryDocument(env, path, fallback = null) {
  const response = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(CONFIG.branch)}`, {
    headers: githubHeaders(env),
  });
  if (response.status === 404 && fallback !== null) {
    return { sha: "", payload: structuredClone(fallback) };
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}): ${result.message || "unknown error"}`);
  try {
    return {
      sha: normalizeText(result.sha, 100),
      payload: JSON.parse(base64ToText(result.content)),
    };
  } catch (_) {
    throw new Error(`Stored JSON is invalid: ${path}`);
  }
}

async function writeRepositoryJson(env, path, sha, payload, message) {
  const body = {
    message,
    content: bytesToBase64(encoder.encode(`${JSON.stringify(payload, null, 2)}\n`)),
    branch: CONFIG.branch,
  };
  if (sha) body.sha = sha;
  const response = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

async function mutateDispatchState(env, mutate, message) {
  const fallback = {
    version: 1,
    lastAutoDispatchAt: "",
    lastAutoSignature: "",
    lastProductionDate: "",
    lastProductionDispatchAt: "",
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { sha, payload } = await readRepositoryDocument(env, CONFIG.dispatchStatePath, fallback);
    const state = payload && typeof payload === "object" ? payload : structuredClone(fallback);
    const outcome = mutate(state);
    if (!outcome.changed) return outcome.result;
    const { response, result } = await writeRepositoryJson(env, CONFIG.dispatchStatePath, sha, state, message);
    if (response.ok) return outcome.result;
    if (![409, 422].includes(response.status) || attempt === 3) {
      throw new Error(`GitHub lock write failed (${response.status}): ${result.message || "unknown error"}`);
    }
  }
  throw new Error("GitHub dispatch lock conflict.");
}

async function dispatchRepositoryEvent(env, eventType, clientPayload) {
  const response = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/dispatches`, {
    method: "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  if (response.status !== 204) {
    const result = await response.json().catch(() => ({}));
    throw new Error(`GitHub dispatch failed (${response.status}): ${result.message || "unknown error"}`);
  }
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function koreaDate(now = new Date()) {
  return new Date(now.getTime() + (9 * 60 * 60 * 1_000)).toISOString().slice(0, 10);
}

async function fetchApsSourceVersion(env) {
  const baseUrl = normalizeText(env.LFP_API_BASE_URL || CONFIG.apiBaseUrl, 500).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/aps-plan?oper=45&limit=1`, {
    headers: { Accept: "application/json", "User-Agent": "LFP-Cloudflare-Monitor/1.0" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`APS check failed (${response.status})`);
  const version = normalizeText(payload.source_refreshed_at, 100);
  if (!version) throw new Error("APS source_refreshed_at is missing.");
  return version;
}

async function acquireAutoDispatch(env, signature, now) {
  return mutateDispatchState(env, (state) => {
    const previousAt = parseTimestamp(state.lastAutoDispatchAt);
    if (state.lastAutoSignature === signature && previousAt !== null && now.getTime() - previousAt < CONFIG.dispatchCooldownMs) {
      return { changed: false, result: false };
    }
    state.version = 1;
    state.lastAutoDispatchAt = now.toISOString();
    state.lastAutoSignature = signature;
    return { changed: true, result: true };
  }, "automation: lock dashboard collection dispatch");
}

async function acquireProductionDispatch(env, dateKey, now) {
  return mutateDispatchState(env, (state) => {
    if (state.lastProductionDate === dateKey) return { changed: false, result: false };
    state.version = 1;
    state.lastProductionDate = dateKey;
    state.lastProductionDispatchAt = now.toISOString();
    return { changed: true, result: true };
  }, "automation: lock production collection dispatch");
}

async function runAutomaticMonitor(env, now = new Date()) {
  if (!env.GITHUB_TOKEN) throw new Error("missing_worker_secrets");
  const [automationResult, apsResult] = await Promise.allSettled([
    readRepositoryJson(env, CONFIG.automationStatePath),
    fetchApsSourceVersion(env),
  ]);
  if (automationResult.status !== "fulfilled") throw automationResult.reason;
  const state = automationResult.value || {};
  const lastRegularAt = parseTimestamp(state.lastRegularCollectionAt);
  const regularDue = lastRegularAt === null || now.getTime() - lastRegularAt >= CONFIG.regularIntervalMs;
  let reason = "";
  let observedVersion = "";

  if (apsResult.status === "fulfilled") {
    observedVersion = apsResult.value;
    if (observedVersion !== normalizeText(state.lastHandledApsVersion, 100)) reason = "aps_changed";
    else if (regularDue) reason = "regular_16h";
  } else if (regularDue) {
    reason = "regular_16h_aps_check_failed";
  }

  if (!reason) {
    if (apsResult.status === "rejected") throw apsResult.reason;
    return { dispatched: false, reason: "aps_unchanged", observedVersion };
  }

  const signature = `${reason}:${observedVersion || state.lastRegularCollectionAt || "unknown"}`;
  if (!(await acquireAutoDispatch(env, signature, now))) {
    return { dispatched: false, reason: "cooldown", signature };
  }
  await dispatchRepositoryEvent(env, CONFIG.automaticEventType, {
    reason,
    observedVersion,
    checkedAt: now.toISOString(),
  });
  return { dispatched: true, reason, observedVersion };
}

async function runProductionSchedule(env, now = new Date()) {
  if (!env.GITHUB_TOKEN) throw new Error("missing_worker_secrets");
  const dateKey = koreaDate(now);
  if (!(await acquireProductionDispatch(env, dateKey, now))) {
    return { dispatched: false, reason: "already_dispatched", date: dateKey };
  }
  await dispatchRepositoryEvent(env, CONFIG.productionEventType, {
    reason: "daily_08_kst",
    date: dateKey,
    checkedAt: now.toISOString(),
  });
  return { dispatched: true, reason: "daily_08_kst", date: dateKey };
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
      return jsonResponse(origin, 200, {
        ok: true,
        service: "lfp-schedule-relay",
        automation: "cron-ready",
        schedules: ["every-minute APS monitor", "08:00 Asia/Seoul production"],
      });
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

  async scheduled(controller, env) {
    const result = controller.cron === CONFIG.productionCron
      ? await runProductionSchedule(env)
      : await runAutomaticMonitor(env);
    console.log(JSON.stringify({ cron: controller.cron, ...result }));
  },
};

export const __test = Object.freeze({
  koreaDate,
  parseTimestamp,
  runAutomaticMonitor,
  runProductionSchedule,
});
