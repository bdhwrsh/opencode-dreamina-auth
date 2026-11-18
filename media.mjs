import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureCanvas, getVideoTask, newNodeId, saveVideoTask } from "./canvas-state.mjs"
import { CliError, hasCliRunnerForTests, isAbortError, isCliInstalled, redactSensitiveText, runCli } from "./cli.mjs"
import { ModelParamError, fetchLiveModels, resolveImageParams, resolveVideoParams } from "./models.mjs"

export const DEFAULT_CREDIT_CEILING = 200

const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"])

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  })
}

export function errorResponse(status, message, { type, code, extra, headers } = {}) {
  const errType =
    type ??
    (status === 400
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : "api_error")
  const outHeaders = { ...(headers ?? {}) }
  if (status === 401 && !outHeaders["X-Magpie-Sign-In"] && !outHeaders["x-magpie-sign-in"]) {
    outHeaders["X-Magpie-Sign-In"] = "expired"
  }
  return jsonResponse(
    status,
    {
      error: {
        message: redactSensitiveText(String(message || "Unknown Dreamina error")),
        type: errType,
        ...(code ? { code } : {}),
        ...(extra ?? {}),
      },
    },
    outHeaders,
  )
}

function errorToResponse(err) {
  if (isAbortError(err)) throw err
  if (err instanceof ModelParamError) {
    return errorResponse(err.status, err.message, { code: err.code })
  }
  if (err instanceof CliError) {
    return errorResponse(err.status, err.message, {
      code: err.code,
      headers: err.signIn ? { "X-Magpie-Sign-In": err.signIn } : undefined,
    })
  }
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 502
  return errorResponse(status, err?.message || String(err), { code: err?.code })
}

function headerValue(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return headers.get(name) ?? ""
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return String(v ?? "")
  }
  return ""
}

async function readRawRequest(input, init = {}) {
  const req = input instanceof Request ? input : null
  const method = String(init.method ?? req?.method ?? "GET").toUpperCase()
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : req?.url ?? ""
  const headers = new Headers(init.headers ?? req?.headers ?? undefined)
  const signal = init.signal ?? req?.signal
  const body = init.body !== undefined ? init.body : req ? req : undefined
  return { method, url, headers, signal, body }
}

function parseScalarValue(raw) {
  if (typeof raw !== "string") return raw
  const t = raw.trim()
  if (t === "true") return true
  if (t === "false") return false
  return raw
}

function isMultipartContentType(ct) {
  return /\bmultipart\/form-data\b/i.test(ct)
}

function sniffMultipartBoundary(body) {
  let head = ""
  if (typeof body === "string") head = body.slice(0, 256)
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    head = Buffer.from(body.buffer ?? body, body.byteOffset ?? 0, Math.min(body.byteLength ?? 0, 256)).toString("latin1")
  }
  const m = /^--([^\r\n]{1,128})\r?\nContent-Disposition:/i.exec(head)
  return m ? m[1] : ""
}

async function parseRequestPayload(rawReq) {
  const { body, headers } = rawReq
  const contentType = headerValue(headers, "content-type")

  if (body instanceof FormData) {
    return formDataToRequest(body)
  }

  if (body instanceof Request) {
    if (isMultipartContentType(contentType || body.headers.get("content-type") || "")) {
      const fd = await body.formData()
      return formDataToRequest(fd)
    }
    const text = await body.text()
    return parseJsonText(text)
  }

  if (isMultipartContentType(contentType)) {
    const fd = await new Response(body ?? "", {
      headers: { "content-type": contentType },
    }).formData()
    return formDataToRequest(fd)
  }

  if (!contentType) {
    const sniffed = sniffMultipartBoundary(body)
    if (sniffed) {
      const fd = await new Response(body, {
        headers: { "content-type": `multipart/form-data; boundary=${sniffed}` },
      }).formData()
      return formDataToRequest(fd)
    }
  }

  if (body == null || body === "") return {}
  if (typeof body === "string") return parseJsonText(body)
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return parseJsonText(new TextDecoder().decode(body))
  }
  if (typeof body === "object" && !(body instanceof ReadableStream)) {
    return body
  }
  const text = await new Response(body).text()
  return parseJsonText(text)
}

function parseJsonText(text) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ModelParamError("Request JSON body must be an object.")
    }
    return parsed
  } catch (err) {
    if (err instanceof ModelParamError) throw err
    throw new ModelParamError(`Invalid JSON request body: ${err?.message || err}`)
  }
}

const REF_ARRAY_KEYS = new Set([
  "image",
  "image[]",
  "images",
  "images[]",
  "reference_images",
  "reference_images[]",
  "input_reference",
  "input_reference[]",
  "refs",
  "refs[]",
])

function formDataToRequest(fd) {
  const out = {}
  for (const [key, val] of fd.entries()) {
    const cleanKey = key.endsWith("[]") ? key.slice(0, -2) : key
    if (REF_ARRAY_KEYS.has(key)) {
      out[cleanKey] ??= []
      out[cleanKey].push(val)
      continue
    }
    if (key === "first_frame" || key === "first_frame_image" || key === "last_frame" || key === "last_frame_image") {
      out[key] = val
      continue
    }
    if (typeof val === "string") {
      out[cleanKey] = parseScalarValue(val)
    }
  }
  return out
}

function extFromMime(mime) {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim()
  if (m === "image/png") return ".png"
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg"
  if (m === "image/webp") return ".webp"
  if (m === "image/gif") return ".gif"
  if (m === "image/bmp") return ".bmp"
  return ".png"
}

function extFromName(name) {
  const ext = path.extname(String(name ?? "")).toLowerCase()
  return ALLOWED_IMAGE_EXTS.has(ext) ? ext : ""
}

function normalizeRefInputList(raw) {
  if (raw == null) return []
  return Array.isArray(raw) ? raw : [raw]
}

function collectRefInputs(req) {
  const items = []
  const first = req.first_frame ?? req.first_frame_image
  const last = req.last_frame ?? req.last_frame_image
  if (first != null) items.push(first)
  if (last != null) items.push(last)
  for (const key of ["input_reference", "image", "images", "reference_images", "refs"]) {
    for (const entry of normalizeRefInputList(req[key])) {
      if (entry != null && entry !== "") items.push(entry)
    }
  }
  return items
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  if (!match) {
    throw new ModelParamError("Unsupported data: URL format; expected base64-encoded image data URL.")
  }
  const mime = (match[1] || "image/png").toLowerCase()
  if (!mime.startsWith("image/") && mime !== "application/octet-stream") {
    throw new ModelParamError(`Unsupported reference MIME type: ${mime}`)
  }
  const buf = Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  if (!buf.length) throw new ModelParamError("Empty base64 image data URL.")
  return { buf, ext: extFromMime(mime) }
}

async function uploadRefItems(profile, projectId, items, { signal }) {
  if (!items.length) return []
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreamina-refs-"))
  const refTokens = []

  try {
    for (let i = 0; i < items.length; i++) {
      let item = items[i]
      const isBlobLike = item instanceof Blob || (item && typeof item === "object" && typeof item.arrayBuffer === "function")
      if (item && typeof item === "object" && !isBlobLike) {
        if (typeof item.b64_json === "string") {
          item = { b64: item.b64_json, ext: extFromMime(item.mime_type || item.mimeType) }
        } else if (typeof item.data === "string" && !item.data.startsWith("data:") && !item.data.startsWith("http")) {
          item = { b64: item.data, ext: extFromMime(item.mime_type || item.mimeType) }
        } else {
          const urlVal = item.url ?? item.image_url?.url ?? item.image_url ?? item.data
          if (typeof urlVal === "string") item = urlVal
        }
      }

      if (typeof item === "string") {
        const s = item.trim()
        if (/^(?:res|node|vid):/i.test(s)) {
          refTokens.push(s)
          continue
        }
        if (/^https:\/\//i.test(s)) {
          const resourceId = randomUUID()
          const up = await runCli(
            profile,
            ["resource", "upload", "--source-url", s, "--type", "image", "--project-id", projectId, "--resource-id", resourceId],
            { signal },
          )
          const rid = up.data?.resourceId || resourceId
          refTokens.push(`res:${rid}`)
          continue
        }
        if (/^data:/i.test(s)) {
          const { buf, ext } = parseDataUrl(s)
          const filePath = path.join(tmpDir, `ref-${i}${ext}`)
          fs.writeFileSync(filePath, buf, { mode: 0o600 })
          const resourceId = randomUUID()
          const up = await runCli(
            profile,
            ["resource", "upload", "--file", filePath, "--type", "image", "--project-id", projectId, "--resource-id", resourceId],
            { signal },
          )
          const rid = up.data?.resourceId || resourceId
          refTokens.push(`res:${rid}`)
          continue
        }
        throw new ModelParamError("Reference image strings must be https:// URLs, data: URLs, or Dreamina res:/node:/vid: identifiers.")
      }

      if (item && typeof item === "object" && typeof item.b64 === "string") {
        const buf = Buffer.from(item.b64.replace(/\s+/g, ""), "base64")
        if (!buf.length) throw new ModelParamError("Empty b64_json reference image.")
        const filePath = path.join(tmpDir, `ref-${i}${item.ext || ".png"}`)
        fs.writeFileSync(filePath, buf, { mode: 0o600 })
        const resourceId = randomUUID()
        const up = await runCli(
          profile,
          ["resource", "upload", "--file", filePath, "--type", "image", "--project-id", projectId, "--resource-id", resourceId],
          { signal },
        )
        const rid = up.data?.resourceId || resourceId
        refTokens.push(`res:${rid}`)
        continue
      }

      if (item instanceof Blob || (item && typeof item === "object" && typeof item.arrayBuffer === "function")) {
        const bytes = Buffer.from(await item.arrayBuffer())
        if (!bytes.length) throw new ModelParamError("Uploaded reference image file is empty.")
        const ext = extFromName(item.name) || extFromMime(item.type)
        const filePath = path.join(tmpDir, `ref-${i}${ext}`)
        fs.writeFileSync(filePath, bytes, { mode: 0o600 })
        const resourceId = randomUUID()
        const up = await runCli(
          profile,
          ["resource", "upload", "--file", filePath, "--type", "image", "--project-id", projectId, "--resource-id", resourceId],
          { signal },
        )
        const rid = up.data?.resourceId || resourceId
        refTokens.push(`res:${rid}`)
        continue
      }

      throw new ModelParamError("Unsupported reference image entry type.")
    }
    return refTokens
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}

function parseBoolOption(value, fallback) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const t = value.trim().toLowerCase()
    if (t === "true" || t === "1" || t === "yes") return true
    if (t === "false" || t === "0" || t === "no") return false
  }
  return fallback
}

function parseCeilingValue(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new ModelParamError(`Invalid credit_ceiling "${raw}". Must be a non-negative integer.`)
  }
  return n
}

function resolveCreditPolicy(req, getOption) {
  const quoteOnly = req.quote_only !== undefined
    ? parseBoolOption(req.quote_only, false)
    : Boolean(getOption?.("quote_only") === true)

  const explicitCeiling = parseCeilingValue(req.credit_ceiling)
  if (explicitCeiling !== undefined) {
    return { quoteOnly, creditCeiling: explicitCeiling }
  }

  const guardOpt = getOption?.("credit_guard")
  const guardEnabled = guardOpt === undefined ? true : Boolean(guardOpt)
  if (!guardEnabled) {
    return { quoteOnly, creditCeiling: null }
  }

  const envRaw = process.env.DREAMINA_CREDIT_CEILING
  const envCeiling = envRaw !== undefined && envRaw !== "" ? parseCeilingValue(envRaw) : undefined
  return {
    quoteOnly,
    creditCeiling: envCeiling ?? DEFAULT_CREDIT_CEILING,
  }
}

function isSucceededState(state) {
  return ["succeeded", "success", "completed"].includes(String(state ?? "").toLowerCase())
}

function isFailedState(state) {
  return ["failed", "error", "cancelled", "canceled", "rejected"].includes(String(state ?? "").toLowerCase())
}

function mapOpenAiVideoStatus(state) {
  const s = String(state ?? "").toLowerCase()
  if (isSucceededState(s)) return "completed"
  if (isFailedState(s)) return "failed"
  if (s === "running" || s === "processing" || s === "in_progress") return "in_progress"
  return "queued"
}

function estimateVideoDimensions(ratio, resolution) {
  const baseHeight = /4k/i.test(resolution) ? 2160 : /1080/i.test(resolution) ? 1080 : /480/i.test(resolution) ? 480 : 720
  const [rw, rh] = String(ratio || "16:9").split(":").map(Number)
  if (!rw || !rh) return "1280x720"
  if (rw >= rh) {
    const h = baseHeight
    const w = Math.round((h * rw) / rh)
    return `${w}x${h}`
  }
  const w = baseHeight
  const h = Math.round((w * rh) / rw)
  return `${w}x${h}`
}

function findDownloadedFile(tmpDir, dlData) {
  const rawPath = dlData?.path
  if (typeof rawPath === "string" && rawPath.trim()) {
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(tmpDir, rawPath)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
    if (fs.existsSync(rawPath) && fs.statSync(rawPath).isFile()) return rawPath
  }
  const entries = fs.readdirSync(tmpDir)
  for (const name of entries) {
    const full = path.join(tmpDir, name)
    if (fs.statSync(full).isFile()) return full
  }
  throw new CliError("dreamina-canvas resource download produced no readable output file.", {
    status: 502,
    code: "download_missing_file",
  })
}

async function quoteConfirmAndRun(profile, projectId, nodeId, policy, { signal }) {
  const quoteRes = await runCli(
    profile,
    ["node", "quote", "--project-id", projectId, "--node-id", nodeId],
    { signal },
  )
  const quoteData = quoteRes.data ?? {}
  const quoteItems = Array.isArray(quoteData.items) ? quoteData.items : []
  const quoteItem = quoteItems.find((x) => x?.nodeId === nodeId) ?? quoteItems[0]

  if (quoteItem?.error) {
    const qErr = quoteItem.error
    throw new CliError(qErr.message || "Dreamina node quote failed.", {
      status: 400,
      code: qErr.validation?.reasonCode || "quote_failed",
    })
  }

  const totalMaxCredits = quoteData.totalMaxCredits ?? quoteItem?.maxCredits
  if (totalMaxCredits == null || !Number.isFinite(Number(totalMaxCredits))) {
    throw new CliError("Dreamina node quote returned no valid totalMaxCredits.", {
      status: 502,
      code: "invalid_quote",
    })
  }
  const quotedCredits = Number(totalMaxCredits)

  if (policy.quoteOnly) {
    return {
      blockedResponse: errorResponse(
        403,
        `Dreamina quote_only is enabled: estimated max cost is ${quotedCredits} credits (totalMaxCredits=${quotedCredits}). Generation was not confirmed or run.`,
        {
          code: "quote_only",
          extra: { totalMaxCredits: quotedCredits, projectId, nodeId },
        },
      ),
    }
  }

  if (policy.creditCeiling !== null && quotedCredits > policy.creditCeiling) {
    return {
      blockedResponse: errorResponse(
        403,
        `Dreamina quoted cost (${quotedCredits} credits) exceeds credit ceiling (${policy.creditCeiling} credits).`,
        {
          code: "credit_ceiling_exceeded",
          extra: {
            totalMaxCredits: quotedCredits,
            creditCeiling: policy.creditCeiling,
            projectId,
            nodeId,
          },
        },
      ),
    }
  }

  // Keep creditConfirmationToken strictly in local memory and clear immediately after node run.
  let creditToken = null
  try {
    const confirmRes = await runCli(
      profile,
      ["node", "confirm", "--project-id", projectId, "--node-id", nodeId, "--credit-ceiling", String(quotedCredits)],
      { signal },
    )
    creditToken = confirmRes.data?.creditConfirmationToken
    if (!creditToken || typeof creditToken !== "string") {
      throw new CliError("Dreamina node confirm did not return a creditConfirmationToken.", {
        status: 502,
        code: "missing_credit_token",
      })
    }

    const submitId = randomUUID()
    const runRes = await runCli(
      profile,
      ["node", "run", "--project-id", projectId, "--node-id", nodeId, "--submit-id", submitId, "--credit-token", creditToken],
      { signal },
    )
    const runItems = Array.isArray(runRes.data?.items) ? runRes.data.items : []
    const runItem = runItems.find((x) => x?.nodeId === nodeId) ?? runItems[0]
    if (runItem?.state === "rejected" || runItem?.error) {
      throw new CliError(runItem?.error?.message || `Dreamina node run rejected (${runItem?.state || "rejected"})`, {
        status: runItem?.error?.validation ? 400 : 502,
        code: "node_run_rejected",
      })
    }
    return {
      submitId: runItem?.submitId || submitId,
      runState: runItem?.state || "accepted",
      quotedCredits,
    }
  } finally {
    creditToken = null
  }
}

function extractSucceededResources(opData) {
  const resources = Array.isArray(opData?.resources) ? opData.resources : []
  const topSucceeded = isSucceededState(opData?.state)
  return resources.filter((r) => {
    if (!r?.resourceId) return false
    return r.state ? isSucceededState(r.state) : topSucceeded
  })
}

async function handleImageRequest(req, { profile, directory, getOption, signal, forceEdit = false }) {
  const policy = resolveCreditPolicy(req, getOption)
  const refInputs = collectRefInputs(req)
  if (forceEdit && refInputs.length === 0) {
    throw new ModelParamError("At least one reference image is required for /images/edits.")
  }

  const catalog = await fetchLiveModels(profile, { signal }).catch(() => null)
  const reqWithMode = forceEdit && !req.mode ? { ...req, mode: "i2i" } : req
  const params = resolveImageParams(req.model || "seedream_5.5", reqWithMode, refInputs.length, { catalog })

  const projectId = await ensureCanvas(profile, { directory, signal })
  const refTokens = await uploadRefItems(profile, projectId, refInputs, { signal })

  const nodeId = newNodeId()
  const createArgs = [
    "node",
    "create",
    "image",
    "--project-id",
    projectId,
    "--node-id",
    nodeId,
    "--mode",
    params.mode,
    "--prompt",
    params.prompt,
    "--model",
    params.model,
    "--ratio",
    params.ratio,
    "--resolution",
    params.resolution,
    "--count",
    String(params.count),
  ]
  if (!params.prompt.trim()) {
    createArgs.push("--title", "Magpie Image")
  }
  for (const ref of refTokens) {
    createArgs.push("--ref", ref)
  }

  await runCli(profile, createArgs, { signal })

  const exec = await quoteConfirmAndRun(profile, projectId, nodeId, policy, { signal })
  if (exec.blockedResponse) return exec.blockedResponse

  const waitRes = await runCli(
    profile,
    ["operation", "wait", exec.submitId, "--project-id", projectId, "--timeout", "10m", "--interval", "3s"],
    { signal, timeoutMs: 620_000, check: false },
  )

  if (waitRes.timedOut || waitRes.exitCode === 20) {
    return errorResponse(504, `Dreamina image generation timed out (submitId=${exec.submitId}).`, { code: "timeout" })
  }
  if (!waitRes.ok) {
    throw new CliError(waitRes.error?.message || "Dreamina image generation failed while waiting.", {
      status: waitRes.exitCode === 11 ? 401 : 502,
      code: waitRes.error?.code || "operation_wait_failed",
      signIn: waitRes.exitCode === 11 ? "expired" : undefined,
    })
  }

  const opData = waitRes.data ?? {}
  if (isFailedState(opData.state) || opData.submissionError) {
    const errMsg = opData.submissionError?.message || `Dreamina image generation failed (state=${opData.state || "failed"}).`
    return errorResponse(502, errMsg, { code: "generation_failed" })
  }

  const okResources = extractSucceededResources(opData)
  if (!okResources.length) {
    return errorResponse(502, `Dreamina image generation produced no succeeded output resources (state=${opData.state || "unknown"}).`, {
      code: "empty_output",
    })
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreamina-img-"))
  try {
    const data = []
    for (let i = 0; i < okResources.length; i++) {
      const rid = okResources[i].resourceId
      const outDir = path.join(tmpDir, `item-${i}`)
      fs.mkdirSync(outDir, { recursive: true })
      const dlRes = await runCli(
        profile,
        ["resource", "download", rid, "--project-id", projectId, "--output", outDir],
        { signal },
      )
      const filePath = findDownloadedFile(outDir, dlRes.data)
      const b64_json = fs.readFileSync(filePath).toString("base64")
      data.push({ b64_json })
    }
    return jsonResponse(200, {
      created: Math.floor(Date.now() / 1000),
      data,
    })
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}

async function handleVideoCreate(req, { profile, directory, getOption, signal }) {
  const policy = resolveCreditPolicy(req, getOption)
  const refInputs = collectRefInputs(req)
  const catalog = await fetchLiveModels(profile, { signal }).catch(() => null)
  const params = resolveVideoParams(req.model || "seedance_2.5", req, refInputs.length, { catalog })

  const projectId = await ensureCanvas(profile, { directory, signal })
  const refTokens = await uploadRefItems(profile, projectId, refInputs, { signal })

  const nodeId = newNodeId()
  const createArgs = [
    "node",
    "create",
    "video",
    "--project-id",
    projectId,
    "--node-id",
    nodeId,
    "--mode",
    params.mode,
    "--prompt",
    params.prompt,
    "--model",
    params.model,
    "--ratio",
    params.ratio,
    "--resolution",
    params.resolution,
    "--duration",
    String(params.duration),
    "--count",
    String(params.count),
  ]
  if (!params.prompt.trim()) {
    createArgs.push("--title", "Magpie Video")
  }
  for (const ref of refTokens) {
    createArgs.push("--ref", ref)
  }

  await runCli(profile, createArgs, { signal })

  const exec = await quoteConfirmAndRun(profile, projectId, nodeId, policy, { signal })
  if (exec.blockedResponse) return exec.blockedResponse

  const createdAt = Date.now()
  const size = estimateVideoDimensions(params.ratio, params.resolution)
  const videoTaskId = `video_${exec.submitId.replace(/-/g, "")}`
  await saveVideoTask(directory, videoTaskId, {
    profile,
    projectId,
    nodeId,
    submitId: exec.submitId,
    model: params.model,
    duration: params.duration,
    createdAt,
    size,
  })

  return jsonResponse(200, {
    id: videoTaskId,
    object: "video",
    created_at: Math.floor(createdAt / 1000),
    status: mapOpenAiVideoStatus(exec.runState),
    model: params.model,
    progress: 0,
    seconds: String(params.duration),
    size,
  })
}

async function queryVideoOperation(task, { signal }) {
  const statusRes = await runCli(
    task.profile,
    ["operation", "status", task.submitId, "--project-id", task.projectId],
    { signal, check: false },
  )
  if (!statusRes.ok) {
    throw new CliError(statusRes.error?.message || "Dreamina operation status query failed.", {
      status: statusRes.exitCode === 11 ? 401 : 502,
      code: statusRes.error?.code || "operation_status_failed",
      signIn: statusRes.exitCode === 11 ? "expired" : undefined,
    })
  }
  return statusRes.data ?? {}
}

async function handleVideoStatus(videoId, { directory, signal }) {
  const task = getVideoTask(directory, videoId)
  if (!task) {
    return errorResponse(404, `Video task not found: ${videoId}`, { code: "video_not_found" })
  }

  const opData = await queryVideoOperation(task, { signal })
  let status = mapOpenAiVideoStatus(opData.state)
  const okResources = extractSucceededResources(opData)
  let errorObj = null

  if (opData.submissionError || isFailedState(opData.state)) {
    status = "failed"
    errorObj = {
      code: opData.submissionError?.reason || "generation_failed",
      message: redactSensitiveText(opData.submissionError?.message || `Dreamina video generation failed (state=${opData.state || "failed"})`),
    }
  } else if (status === "completed" && !okResources.length) {
    status = "failed"
    errorObj = {
      code: "empty_output",
      message: "Dreamina video operation completed without a succeeded video resource.",
    }
  }

  return jsonResponse(200, {
    id: task.videoTaskId,
    object: "video",
    created_at: Math.floor((task.createdAt || Date.now()) / 1000),
    status,
    model: task.model,
    progress: status === "completed" ? 100 : status === "in_progress" ? 50 : 0,
    seconds: String(task.duration ?? 5),
    ...(task.size ? { size: task.size } : {}),
    ...(status === "completed" ? { completed_at: Math.floor(Date.now() / 1000) } : {}),
    ...(errorObj ? { error: errorObj } : {}),
  })
}

async function handleVideoContent(videoId, { directory, signal }) {
  const task = getVideoTask(directory, videoId)
  if (!task) {
    return errorResponse(404, `Video task not found: ${videoId}`, { code: "video_not_found" })
  }

  const opData = await queryVideoOperation(task, { signal })
  const status = mapOpenAiVideoStatus(opData.state)
  if (status === "failed" || opData.submissionError) {
    return errorResponse(400, opData.submissionError?.message || "Dreamina video generation failed.", {
      code: "generation_failed",
    })
  }
  const okResources = extractSucceededResources(opData)
  if (status !== "completed" || !okResources.length) {
    return errorResponse(409, `Dreamina video ${task.videoTaskId} is not completed yet (status=${status}).`, {
      code: "video_not_ready",
    })
  }

  const rid = okResources[0].resourceId
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreamina-vid-"))
  try {
    const dlRes = await runCli(
      task.profile,
      ["resource", "download", rid, "--project-id", task.projectId, "--output", tmpDir],
      { signal },
    )
    const filePath = findDownloadedFile(tmpDir, dlRes.data)
    const bytes = fs.readFileSync(filePath)
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `inline; filename="${task.videoTaskId}.mp4"`,
      },
    })
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}

export function createMediaFetch({ profile = "default", getProfile, directory, getOption } = {}) {
  return async (input, init = {}) => {
    let signal
    try {
      const rawReq = await readRawRequest(input, init)
      signal = rawReq.signal
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError")
      }

      if (!hasCliRunnerForTests() && !isCliInstalled()) {
        return errorResponse(503, "dreamina-canvas CLI not found on this machine. Install it or set DREAMINA_CANVAS_BIN.", {
          code: "cli_not_found",
        })
      }

      const activeProfile = (typeof getProfile === "function" ? await getProfile() : profile) || "default"
      const parsedUrl = new URL(rawReq.url || "/", "http://dreamina.local")
      const pathname = parsedUrl.pathname

      if (rawReq.method === "POST" && /(?:^|\/)images\/generations$/i.test(pathname)) {
        const payload = await parseRequestPayload(rawReq)
        return await handleImageRequest(payload, { profile: activeProfile, directory, getOption, signal, forceEdit: false })
      }

      if (rawReq.method === "POST" && /(?:^|\/)images\/edits$/i.test(pathname)) {
        const payload = await parseRequestPayload(rawReq)
        return await handleImageRequest(payload, { profile: activeProfile, directory, getOption, signal, forceEdit: true })
      }

      if (rawReq.method === "POST" && /(?:^|\/)videos$/i.test(pathname)) {
        const payload = await parseRequestPayload(rawReq)
        return await handleVideoCreate(payload, { profile: activeProfile, directory, getOption, signal })
      }

      const contentMatch = rawReq.method === "GET" && /(?:^|\/)videos\/([^/]+)\/content$/i.exec(pathname)
      if (contentMatch) {
        const videoId = decodeURIComponent(contentMatch[1])
        return await handleVideoContent(videoId, { directory, signal })
      }

      const statusMatch = rawReq.method === "GET" && /(?:^|\/)videos\/([^/]+)$/i.exec(pathname)
      if (statusMatch) {
        const videoId = decodeURIComponent(statusMatch[1])
        return await handleVideoStatus(videoId, { directory, signal })
      }

      return errorResponse(404, `Unsupported Dreamina route: ${rawReq.method} ${pathname}`, {
        code: "unsupported_route",
      })
    } catch (err) {
      return errorToResponse(err)
    }
  }
}
