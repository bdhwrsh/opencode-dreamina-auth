import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCli } from "./cli.mjs"

const STATE_FILENAME = "dreamina-canvas-state.json"
const CANVAS_NAME = "Magpie Gateway"
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"
const MAX_VIDEO_RECORDS = 500

const writeQueues = new Map()
const inflightCanvases = new Map()

export function newNodeId() {
  const bytes = randomBytes(10)
  let suffix = ""
  for (let i = 0; i < 10; i++) {
    suffix += CROCKFORD[bytes[i] & 31]
  }
  return `node_${suffix}`
}

function defaultState() {
  return { version: 1, canvases: {}, videos: {} }
}

function normalizeState(raw) {
  const state = defaultState()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state
  if (raw.canvases && typeof raw.canvases === "object" && !Array.isArray(raw.canvases)) {
    for (const [k, v] of Object.entries(raw.canvases)) {
      if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue
      if (v && typeof v === "object" && typeof v.projectId === "string" && v.projectId) {
        state.canvases[k] = {
          projectId: v.projectId,
          name: typeof v.name === "string" ? v.name : CANVAS_NAME,
          createdAt: Number.isFinite(v.createdAt) ? v.createdAt : Date.now(),
        }
      }
    }
  }
  if (raw.videos && typeof raw.videos === "object" && !Array.isArray(raw.videos)) {
    for (const [k, v] of Object.entries(raw.videos)) {
      if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue
      if (v && typeof v === "object" && typeof v.submitId === "string" && v.submitId) {
        state.videos[k] = {
          profile: typeof v.profile === "string" && v.profile ? v.profile : "default",
          projectId: typeof v.projectId === "string" ? v.projectId : "",
          nodeId: typeof v.nodeId === "string" ? v.nodeId : "",
          submitId: v.submitId,
          model: typeof v.model === "string" ? v.model : "",
          duration: Number.isFinite(v.duration) ? v.duration : 5,
          createdAt: Number.isFinite(v.createdAt) ? v.createdAt : Date.now(),
          ...(typeof v.size === "string" && v.size ? { size: v.size } : {}),
        }
      }
    }
  }
  return state
}

function candidatePaths(directory) {
  const fallback = path.join(os.tmpdir(), STATE_FILENAME)
  const dir = typeof directory === "string" ? directory.trim() : ""
  if (!dir) return [fallback]
  const primary = path.join(path.resolve(dir), STATE_FILENAME)
  return primary === fallback ? [fallback] : [primary, fallback]
}

function tryReadState(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8")
    return normalizeState(JSON.parse(text))
  } catch {
    return null
  }
}

function writeAtomic0600(filePath, data) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    const payload = JSON.stringify(data, null, 2) + "\n"
    fs.writeFileSync(tmp, payload, { mode: 0o600, encoding: "utf8" })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {}
    fs.renameSync(tmp, filePath)
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {}
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

function pruneVideos(state) {
  const entries = Object.entries(state.videos)
  if (entries.length <= MAX_VIDEO_RECORDS) return
  entries.sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0))
  const dropCount = entries.length - MAX_VIDEO_RECORDS
  for (let i = 0; i < dropCount; i++) {
    delete state.videos[entries[i][0]]
  }
}

export function resolveStatePath(directory) {
  const paths = candidatePaths(directory)
  for (const p of paths) {
    if (fs.existsSync(p)) return p
  }
  return paths[0]
}

export function readCanvasState(directory) {
  const paths = candidatePaths(directory)
  for (const p of paths) {
    const parsed = tryReadState(p)
    if (parsed) return parsed
  }
  return defaultState()
}

export function writeCanvasState(directory, state) {
  const clean = normalizeState(state)
  pruneVideos(clean)
  const paths = candidatePaths(directory)
  let lastErr = null
  for (const p of paths) {
    try {
      writeAtomic0600(p, clean)
      return p
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error("Unable to write dreamina-canvas-state.json")
}

async function mutateCanvasState(directory, mutator) {
  const key = path.resolve(directory || os.tmpdir())
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const next = prev.then(async () => {
    const state = readCanvasState(directory)
    const result = await mutator(state)
    writeCanvasState(directory, state)
    return result
  })
  const settled = next.then(() => {}, () => {})
  writeQueues.set(key, settled)
  return next
}

export async function ensureCanvas(profile = "default", { directory, signal } = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const state = readCanvasState(directory)
  const existing = Object.hasOwn(state.canvases, safeProfile) ? state.canvases[safeProfile] : null
  if (existing?.projectId) {
    return existing.projectId
  }

  const inflightKey = `${path.resolve(directory || os.tmpdir())}\0${safeProfile}`
  const pending = inflightCanvases.get(inflightKey)
  if (pending) return pending

  const createPromise = (async () => {
    const freshState = readCanvasState(directory)
    const rechecked = Object.hasOwn(freshState.canvases, safeProfile) ? freshState.canvases[safeProfile] : null
    if (rechecked?.projectId) return rechecked.projectId

    const candidateProjectId = randomUUID()
    const res = await runCli(
      safeProfile,
      ["canvas", "create", CANVAS_NAME, "--project-id", candidateProjectId],
      { signal },
    )
    const createdProjectId = res.data?.project?.projectId || candidateProjectId
    await mutateCanvasState(directory, (s) => {
      s.canvases[safeProfile] = {
        projectId: createdProjectId,
        name: res.data?.project?.name || CANVAS_NAME,
        createdAt: Date.now(),
      }
    })
    return createdProjectId
  })()

  inflightCanvases.set(inflightKey, createPromise)
  try {
    return await createPromise
  } finally {
    if (inflightCanvases.get(inflightKey) === createPromise) {
      inflightCanvases.delete(inflightKey)
    }
  }
}

export async function saveVideoTask(directory, videoTaskId, record) {
  if (!videoTaskId || typeof videoTaskId !== "string") {
    throw new Error("videoTaskId is required")
  }
  await mutateCanvasState(directory, (state) => {
    state.videos[videoTaskId] = {
      profile: String(record.profile ?? "").trim() || "default",
      projectId: String(record.projectId || ""),
      nodeId: String(record.nodeId || ""),
      submitId: String(record.submitId || ""),
      model: String(record.model || ""),
      duration: Number.isFinite(record.duration) ? record.duration : 5,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
      ...(typeof record.size === "string" && record.size ? { size: record.size } : {}),
    }
  })
}

export function getVideoTask(directory, videoTaskId) {
  if (!videoTaskId || typeof videoTaskId !== "string") return null
  const state = readCanvasState(directory)
  if (Object.hasOwn(state.videos, videoTaskId)) {
    return { videoTaskId, ...state.videos[videoTaskId] }
  }
  // Fallback lookup by submitId
  for (const [id, rec] of Object.entries(state.videos)) {
    if (rec.submitId === videoTaskId) {
      return { videoTaskId: id, ...rec }
    }
  }
  return null
}
