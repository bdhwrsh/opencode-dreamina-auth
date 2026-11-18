import { hasCliRunnerForTests, isCliInstalled, runCli } from "./cli.mjs"
import { createMediaFetch } from "./media.mjs"
import { BASE_URL, LIVE_META, NPM_IMAGE, configModels, fetchLiveModels, openCodeModelOf } from "./models.mjs"

const PROVIDER_ID = "dreamina"
const PROVIDER_NAME = "Dreamina (即梦)"
const DEFAULT_PROFILE = "default"
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function normalizeProfile(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return DEFAULT_PROFILE
  if (!PROFILE_PATTERN.test(s)) {
    throw new Error("Invalid Dreamina profile name. Use letters, digits, '.', '_', or '-' (max 64 chars).")
  }
  return s
}

function profileOfAuth(auth) {
  const raw = auth?.metadata?.profile ?? auth?.profile ?? DEFAULT_PROFILE
  const s = String(raw ?? "").trim()
  return s && PROFILE_PATTERN.test(s) ? s : DEFAULT_PROFILE
}

function parseExpiresMs(expiresAt) {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt < 1e11 ? Math.round(expiresAt * 1000) : Math.round(expiresAt)
  }
  if (typeof expiresAt === "string") {
    const trimmed = expiresAt.trim()
    if (!trimmed) return 0
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      return Number.isFinite(n) && n > 0 ? (n < 1e11 ? Math.round(n * 1000) : Math.round(n)) : 0
    }
    const ms = Date.parse(trimmed)
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  }
  return 0
}

function cliReady() {
  return hasCliRunnerForTests() || isCliInstalled()
}

function cliMissingFailure() {
  return {
    type: "failed",
    error: "dreamina-canvas CLI not found on this machine. Install dreamina-canvas and ensure it is on PATH (or set DREAMINA_CANVAS_BIN).",
  }
}

function isAuthExpiredResult(res) {
  if (!res) return false
  if (res.exitCode === 11) return true
  if (res.ok && res.data?.loggedIn === false) return true
  const cls = String(res.error?.class || "").toLowerCase()
  const action = String(res.error?.requiredAction || "").toLowerCase()
  const code = String(res.error?.code || "").toLowerCase()
  const msg = String(res.error?.message || "")
  return (
    cls === "auth" ||
    action === "reauth" ||
    action === "login" ||
    /auth|unauthenticated|unauthorized|not_logged_in/.test(code) ||
    /not (?:logged|signed) in|unauthenticated|unauthorized|login required|session.*expired|token.*expired/i.test(msg)
  )
}

async function finalizeProfileSignIn(profile, { statusData, signal } = {}) {
  let finalStatus = statusData
  if (!finalStatus) {
    const statusRes = await runCli(profile, ["auth", "status"], { signal, timeoutMs: 15_000, check: false })
    if (!statusRes.ok || !statusRes.data?.loggedIn) {
      return {
        type: "failed",
        error: statusRes.error?.message || `Profile "${profile}" is not signed in to dreamina-canvas.`,
      }
    }
    finalStatus = statusRes.data
  }

  const accountRes = await runCli(profile, ["auth", "account"], { signal, timeoutMs: 15_000, check: false })
  const acct = accountRes?.ok ? accountRes.data : null
  const userId = acct?.userId != null ? String(acct.userId) : ""

  const accountLabel = userId ? `${profile} (${userId})` : profile

  return {
    type: "success",
    access: `dreamina-profile:${profile}`,
    refresh: `dreamina-profile:${profile}`,
    expires: parseExpiresMs(finalStatus?.expiresAt),
    accountId: accountLabel,
    account: accountLabel,
    ...(userId ? { uid: userId } : {}),
    metadata: {
      profile,
      region: typeof finalStatus?.region === "string" && finalStatus.region ? finalStatus.region : "cn",
      isVip: Boolean(acct?.isVip),
      vipLevel: typeof acct?.vipLevel === "string" ? acct.vipLevel : "",
    },
  }
}

const PROFILE_PROMPTS = [
  {
    type: "text",
    key: "profile",
    message: "dreamina-canvas profile name (leave blank for default)",
    messages: {
      zh: "dreamina-canvas profile 名称（留空则使用 default）",
      "zh-TW": "dreamina-canvas profile 名稱（留空則使用 default）",
    },
    placeholder: DEFAULT_PROFILE,
    required: false,
    validate: (value) => {
      const v = String(value ?? "").trim()
      if (!v) return null
      if (!PROFILE_PATTERN.test(v)) {
        return "Profile name must use letters, digits, '.', '_', or '-' (max 64 chars)"
      }
      return null
    },
  },
]

export const DreaminaAuthPlugin = async (input = {}) => {
  const directory = input?.directory || process.cwd()
  const magpie = input?.magpie

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const existing = cfg.provider[PROVIDER_ID] ?? {}
      cfg.provider[PROVIDER_ID] = {
        ...existing,
        id: PROVIDER_ID,
        name: existing.name ?? PROVIDER_NAME,
        npm: existing.npm ?? NPM_IMAGE,
        api: existing.api ?? BASE_URL,
        models: { ...configModels(), ...(existing.models ?? {}) },
      }
    },
    auth: {
      provider: PROVIDER_ID,
      maxConcurrency: 4,
      cli: {
        name: "Dreamina Canvas CLI (dreamina-canvas)",
        manual: "Install dreamina-canvas locally and ensure it is on PATH (or set DREAMINA_CANVAS_BIN).",
        installed: async () => isCliInstalled(),
        install: async () => {
          if (isCliInstalled()) return
          throw new Error("dreamina-canvas is not installed automatically. Install dreamina-canvas locally and ensure it is on PATH (or set DREAMINA_CANVAS_BIN).")
        },
      },
      options: [
        {
          key: "quote_only",
          label: "Quote only (dry-run)",
          labels: { zh: "仅报价（不消耗积分）", "zh-TW": "僅報價（不消耗積分）" },
          description: "Estimate credit cost via node quote (returns HTTP 403 with totalMaxCredits) without confirming or running generation.",
          descriptions: {
            zh: "仅调用 node quote 估算积分并返回提示（HTTP 403），不执行确认扣费与实际生成。",
            "zh-TW": "僅呼叫 node quote 估算積分並回傳提示（HTTP 403），不執行確認扣費與實際生成。",
          },
          default: false,
          placement: "top",
        },
        {
          key: "credit_guard",
          label: "Credit ceiling guard (200)",
          labels: { zh: "积分上限保护（默认 200）", "zh-TW": "積分上限保護（預設 200）" },
          description: "Block generation when quoted totalMaxCredits exceeds 200 credits (or the request credit_ceiling).",
          descriptions: {
            zh: "当 node quote 报价超过 200 积分（或请求指定 credit_ceiling）时阻止扣费运行。",
            "zh-TW": "當 node quote 報價超過 200 積分（或請求指定 credit_ceiling）時阻止扣費執行。",
          },
          default: true,
          placement: "top",
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "Use existing dreamina-canvas CLI profile",
          labels: {
            zh: "使用本机已有 dreamina-canvas 登录配置",
            "zh-TW": "使用本機已有 dreamina-canvas 登入設定",
          },
          prompts: PROFILE_PROMPTS,
          authorize: async (inputs = {}, opts = {}) => {
            if (!cliReady()) return cliMissingFailure()
            let profile
            try {
              profile = normalizeProfile(inputs?.profile)
            } catch (err) {
              return { type: "failed", error: err.message }
            }

            const statusRes = await runCli(profile, ["auth", "status"], {
              signal: opts?.signal,
              timeoutMs: 15_000,
              check: false,
            })
            if (!statusRes.ok || !statusRes.data?.loggedIn) {
              return {
                type: "failed",
                error:
                  statusRes.error?.message ||
                  `dreamina-canvas profile "${profile}" is not signed in. Use browser sign-in or run \`dreamina-canvas --profile ${profile} auth login\`.`,
              }
            }

            return {
              url: "",
              instructions: "",
              method: "auto",
              callback: async (_code, cbOpts = {}) =>
                finalizeProfileSignIn(profile, {
                  statusData: statusRes.data,
                  signal: cbOpts?.signal ?? opts?.signal,
                }),
            }
          },
        },
        {
          type: "oauth",
          label: "Sign in with Dreamina (browser)",
          labels: {
            zh: "使用即梦浏览器登录",
            "zh-TW": "使用即夢瀏覽器登入",
          },
          prompts: PROFILE_PROMPTS,
          authorize: async (inputs = {}, opts = {}) => {
            if (!cliReady()) return cliMissingFailure()
            let profile
            try {
              profile = normalizeProfile(inputs?.profile)
            } catch (err) {
              return { type: "failed", error: err.message }
            }

            const loginRes = await runCli(profile, ["auth", "login"], {
              signal: opts?.signal,
              timeoutMs: 30_000,
              check: false,
            })
            if (!loginRes.ok) {
              return {
                type: "failed",
                error: loginRes.error?.message || "Failed to start Dreamina browser sign-in.",
              }
            }

            const data = loginRes.data ?? {}
            if (data.state?.loggedIn === true && !data.challenge?.deviceCode) {
              return {
                url: "",
                instructions: "",
                method: "auto",
                callback: async (_code, cbOpts = {}) =>
                  finalizeProfileSignIn(profile, {
                    statusData: { ...data, ...data.state },
                    signal: cbOpts?.signal ?? opts?.signal,
                  }),
              }
            }

            const challenge = data.challenge
            if (!challenge?.deviceCode) {
              return {
                type: "failed",
                error: "dreamina-canvas auth login did not return a deviceCode challenge.",
              }
            }

            const url = challenge.verificationUriComplete || challenge.verificationUri || ""
            const instructions = challenge.userCode
              ? `Open the link in your browser to sign in to Dreamina (user code: ${challenge.userCode}).`
              : "Open the link in your browser to sign in to Dreamina."

            return {
              url,
              instructions,
              method: "auto",
              callback: async (_code, cbOpts = {}) => {
                const waitSignal =
                  opts?.signal && cbOpts?.signal
                    ? AbortSignal.any([opts.signal, cbOpts.signal])
                    : cbOpts?.signal ?? opts?.signal
                const waitRes = await runCli(
                  profile,
                  ["auth", "wait", "--device-code", challenge.deviceCode, "--timeout", "10m"],
                  { signal: waitSignal, timeoutMs: 610_000, check: false },
                )
                if (!waitRes.ok || !waitRes.data?.state?.loggedIn) {
                  return {
                    type: "failed",
                    error: waitRes.error?.message || "Dreamina browser sign-in did not complete.",
                  }
                }
                return finalizeProfileSignIn(profile, {
                  statusData: { ...waitRes.data, ...waitRes.data.state },
                  signal: waitSignal,
                })
              },
            }
          },
        },
      ],
      refresh: async (auth) => {
        if (!cliReady()) {
          throw new Error("dreamina-canvas CLI not found on this machine.")
        }
        const profile = profileOfAuth(auth)
        const res = await runCli(profile, ["auth", "refresh"], {
          timeoutMs: 30_000,
          check: false,
        })
        if (res.ok && res.data?.loggedIn) {
          return {
            access: `dreamina-profile:${profile}`,
            refresh: `dreamina-profile:${profile}`,
            expires: parseExpiresMs(res.data.expiresAt),
            metadata: {
              ...(auth?.metadata ?? {}),
              profile,
              region: typeof res.data.region === "string" && res.data.region ? res.data.region : auth?.metadata?.region || "cn",
            },
          }
        }
        if (isAuthExpiredResult(res)) {
          throw Object.assign(
            new Error(res.error?.message || `Dreamina profile "${profile}" session expired; sign in again.`),
            { signIn: "expired" },
          )
        }
        throw new Error(res.error?.message || "Failed to refresh Dreamina session.")
      },
      usage: async (getAuth, _provider, opts = {}) => {
        if (!cliReady()) {
          return { error: "dreamina-canvas CLI not found on this machine.", signIn: "kept" }
        }
        const auth = await getAuth()
        const profile = profileOfAuth(auth)
        const statusRes = await runCli(profile, ["auth", "status"], {
          signal: opts?.signal,
          timeoutMs: 15_000,
          check: false,
        })
        if (!statusRes.ok || !statusRes.data?.loggedIn) {
          return {
            error: statusRes.error?.message || `Profile "${profile}" is not signed in to Dreamina.`,
            signIn: "expired",
          }
        }
        const accountRes = await runCli(profile, ["auth", "account"], {
          signal: opts?.signal,
          timeoutMs: 15_000,
          check: false,
        })
        const acct = accountRes?.ok ? accountRes.data : null
        const plan = acct?.isVip ? (acct.vipLevel ? `VIP (${acct.vipLevel})` : "VIP") : "Free / Standard"
        const user = acct?.userId != null ? `${profile} (${acct.userId})` : profile
        return {
          plan,
          user,
          ...(statusRes.data.expiresAt ? { until: statusRes.data.expiresAt } : {}),
          windows: [],
          signIn: "kept",
        }
      },
      loader: async (getAuth) => {
        const auth = await getAuth()
        const initialProfile = profileOfAuth(auth)
        return {
          baseURL: BASE_URL,
          apiKey: "dreamina-local",
          fetch: createMediaFetch({
            profile: initialProfile,
            getProfile: async () => profileOfAuth(await getAuth()),
            directory,
            getOption: (key) => (typeof magpie?.option === "function" ? magpie.option(PROVIDER_ID, key) : undefined),
          }),
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_IMAGE,
      models: async (_given, ctx) => {
        const profile = profileOfAuth(ctx?.auth)
        const specs = await fetchLiveModels(profile, { signal: ctx?.signal })
        const out = {}
        for (const [id, spec] of Object.entries(specs)) {
          out[id] = openCodeModelOf(PROVIDER_ID, spec)
        }
        if (specs?.[LIVE_META]?.fellBack) {
          out[Symbol.for("magpie.fellBack")] = true
        }
        return out
      },
    },
  }
}

export default { id: PROVIDER_ID, server: DreaminaAuthPlugin }
