import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { v4 as uuid } from 'uuid'
import sharp from 'sharp'
import XLSX from 'xlsx'
import { isOpenAIImageModel, normalizeModelId, supportsGoogleSearch, supportsImageSize } from '../src/shared/modelCapabilities.js'
import { assembleStyleInstruction } from '../src/shared/instructionAssembly.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CONFIG_PATH = path.join(__dirname, 'config', 'app.config.json')
const CONFIG_EXAMPLE_PATH = path.join(__dirname, 'config', 'app.config.example.json')
const DATA_DIR = path.join(__dirname, 'data')
const GALLERY_DATA_PATH = path.join(DATA_DIR, 'gallery.json')
const TASKS_DATA_PATH = path.join(DATA_DIR, 'tasks.json')
const GALLERY_DIR = path.join(__dirname, 'gallery')
const DIST_DIR = path.join(__dirname, '..', 'dist')
const THUMBNAILS_DIR = path.join(GALLERY_DIR, 'thumbnails')

const PORT = process.env.PORT || 51130

const app = express()

const DEFAULT_UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 900_000)
const DEFAULT_UPSTREAM_RETRIES = Number(process.env.UPSTREAM_RETRIES || 1)
const DEFAULT_UPSTREAM_RETRY_DELAY_MS = Number(process.env.UPSTREAM_RETRY_DELAY_MS || 800)
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS || 1)
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE || 10)
const TASK_TTL_MS = Number(process.env.TASK_TTL_MS || 24 * 60 * 60 * 1000)
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15_000)
const LOG_BUFFER_LIMIT = Number(process.env.LOG_BUFFER_LIMIT || 2000)

const logBuffer = []
const logListeners = new Set()

function pushLog(level, scope, message, extra, requestId) {
    const entry = {
        id: uuid(),
        time: new Date().toISOString(),
        level,
        scope,
        message,
        requestId: requestId || '',
        extra: extra ?? null
    }

    logBuffer.push(entry)
    if (logBuffer.length > LOG_BUFFER_LIMIT) {
        logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT)
    }

    for (const res of logListeners) {
        try {
            res.write(`event: log\n`)
            res.write(`data: ${JSON.stringify(entry)}\n\n`)
        } catch {
            // ignore
        }
    }
}

function isTransientNetworkError(error) {
    if (!error) return false
    const message = error instanceof Error ? error.message : String(error)
    const cause = error instanceof Error ? error.cause : undefined
    const causeCode = cause && typeof cause === 'object' ? cause.code : undefined
    const code = error instanceof Error ? error.code : undefined
    const anyCode = code || causeCode
    if (anyCode && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(anyCode)) return true
    return /terminated|socket hang up|network timeout|timed out|ECONNRESET/i.test(message)
}

function isRetryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status)
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs)
    try {
        const combinedSignal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
        return await fetch(url, { ...options, signal: combinedSignal })
    } finally {
        clearTimeout(timer)
    }
}

async function fetchWithRetry(url, options, { timeoutMs, retries, retryDelayMs } = {}) {
    const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_UPSTREAM_TIMEOUT_MS
    const effectiveRetries = Number.isFinite(retries) ? retries : DEFAULT_UPSTREAM_RETRIES
    const effectiveDelay = Number.isFinite(retryDelayMs) ? retryDelayMs : DEFAULT_UPSTREAM_RETRY_DELAY_MS

    let lastError
    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, options, effectiveTimeout)
            if (!response.ok && isRetryableStatus(response.status) && attempt < effectiveRetries) {
                await delay(effectiveDelay * (attempt + 1))
                continue
            }
            return response
        } catch (error) {
            lastError = error
            const retryable = isTransientNetworkError(error)
            if (!retryable || attempt >= effectiveRetries) {
                throw error
            }
            await delay(effectiveDelay * (attempt + 1))
        }
    }
    throw lastError || new Error('upstream request failed')
}

function logInfo(scope, message, extra, requestId) {
    const time = new Date().toISOString()
    const prefix = requestId ? `[${time}][${scope}][${requestId}]` : `[${time}][${scope}]`
    if (extra) {
        console.log(`${prefix} ${message}`, extra)
    } else {
        console.log(`${prefix} ${message}`)
    }
    pushLog('info', scope, message, extra, requestId)
}

function logError(scope, message, error, requestId) {
    const time = new Date().toISOString()
    const prefix = requestId ? `[${time}][${scope}][${requestId}]` : `[${time}][${scope}]`
    console.error(`${prefix} ${message}`, error)
    const extra = error instanceof Error ? { message: error.message, stack: error.stack } : error
    pushLog('error', scope, message, extra, requestId)
}

app.use(cors())
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true }))
app.use((req, res, next) => {
    req.requestId = uuid().slice(0, 8)
    req._startAt = Date.now()
    res.setHeader('x-request-id', req.requestId)
    next()
})

morgan.token('id', req => req.requestId || '-')
app.use(
    morgan('[HTTP][:id] :method :url -> :status :response-time ms', {
        stream: {
            write: message => process.stdout.write(message)
        }
    })
)

app.use((req, res, next) => {
    const start = Date.now()
    logInfo('HTTP', `收到请求 ${req.method} ${req.originalUrl}`, { ip: req.ip }, req.requestId)
    res.on('finish', () => {
        logInfo('HTTP', `请求结束 ${req.method} ${req.originalUrl} -> ${res.statusCode}，耗时 ${Date.now() - start}ms`, null, req.requestId)
    })
    next()
})
app.use('/gallery', express.static(GALLERY_DIR))
if (fs.existsSync(DIST_DIR)) {
    app.use('/webui', express.static(DIST_DIR))
}

ensureDirectories()
ensureThumbnails()
ensureTasksStore()

function ensureDirectories() {
    if (!fs.existsSync(path.dirname(CONFIG_PATH))) {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
        logInfo('初始化', '已创建配置目录')
    }

    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE_PATH)) {
        fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH)
        logInfo('初始化', '已复制 app.config.example.json -> app.config.json')
    }

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        logInfo('初始化', '已创建 data/')
    }

    if (!fs.existsSync(GALLERY_DIR)) {
        fs.mkdirSync(GALLERY_DIR, { recursive: true })
        logInfo('初始化', '已创建 gallery/')
    }

    if (!fs.existsSync(THUMBNAILS_DIR)) {
        fs.mkdirSync(THUMBNAILS_DIR, { recursive: true })
        logInfo('初始化', '已创建 gallery/thumbnails/')
    }

    if (!fs.existsSync(GALLERY_DATA_PATH)) {
        fs.writeFileSync(GALLERY_DATA_PATH, JSON.stringify([]))
        logInfo('初始化', '已创建 data/gallery.json')
    }
}

function ensureTasksStore() {
    if (!fs.existsSync(TASKS_DATA_PATH)) {
        try {
            fs.writeFileSync(TASKS_DATA_PATH, JSON.stringify([]))
            logInfo('初始化', '已创建 data/tasks.json')
        } catch (error) {
            logError('初始化', '创建 data/tasks.json 失败', error)
        }
    }
}

async function ensureThumbnails() {
    try {
        logInfo('初始化', '正在检查并生成缺失的缩略图...')
        const entries = await loadGallery()
        let changed = false

        for (const entry of entries) {
            // 检查数据字段
            if (!entry.thumbnailPath && entry.fileName) {
                entry.thumbnailPath = `/gallery/thumbnails/thumb-${entry.fileName}`
                changed = true
            }

            // 检查物理文件
            if (entry.fileName) {
                const originalPath = path.join(GALLERY_DIR, entry.fileName)
                const thumbnailFileName = `thumb-${entry.fileName}`
                const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFileName)

                if (fs.existsSync(originalPath) && !fs.existsSync(thumbnailPath)) {
                    try {
                        await sharp(originalPath)
                            .resize(400, 400, {
                                fit: 'cover',
                                position: 'center'
                            })
                            .toFile(thumbnailPath)
                        logInfo('初始化', `已生成缩略图: ${thumbnailFileName}`)
                    } catch (err) {
                        logError('初始化', `生成缩略图失败: ${thumbnailFileName}`, err)
                    }
                }
            }
        }

        if (changed) {
            await saveGallery(entries)
            logInfo('初始化', '已更新 gallery.json 中的缩略图路径')
        }
        logInfo('初始化', '缩略图检查完成')
    } catch (error) {
        logError('初始化', '缩略图检查失败', error)
    }
}

// ---- Generate task queue (single-instance) ----
const tasks = new Map()
const taskQueue = []
const taskListeners = new Map()
let runningTasks = 0
let tasksPersistTimer = null

function serializeTask(task) {
    const { token, abortController, ...rest } = task
    return rest
}

function schedulePersistTasks() {
    if (tasksPersistTimer) return
    tasksPersistTimer = setTimeout(() => {
        tasksPersistTimer = null
        persistTasksStore().catch(() => null)
    }, 300)
}

async function persistTasksStore() {
    try {
        const list = Array.from(tasks.values()).map(serializeTask)
        await fs.promises.writeFile(TASKS_DATA_PATH, JSON.stringify(list, null, 2))
    } catch (error) {
        logError('任务', '写入 tasks.json 失败', error)
    }
}

loadTasksStore()
startTaskCleanup()

function loadTasksStore() {
    try {
        if (!fs.existsSync(TASKS_DATA_PATH)) return
        const raw = fs.readFileSync(TASKS_DATA_PATH, 'utf-8')
        const list = JSON.parse(raw)
        if (!Array.isArray(list)) return
        for (const item of list) {
            if (!item?.id) continue
            const restored = { ...item, token: '', abortController: null, cancelRequested: false }
            if (restored.status === 'running' || restored.status === 'queued') {
                restored.status = 'failed'
                restored.stage = 'failed'
                restored.error = '服务重启导致任务中断，请重新生成'
                restored.finishedAt = new Date().toISOString()
            }
            tasks.set(restored.id, restored)
        }
        if (tasks.size) {
            logInfo('初始化', `已加载历史任务 ${tasks.size} 条`)
        }
    } catch (error) {
        logError('初始化', '加载 tasks.json 失败', error)
    }
}

function startTaskCleanup() {
    setInterval(() => {
        const now = Date.now()
        let changed = false
        for (const [id, task] of tasks.entries()) {
            const createdAt = Date.parse(task.createdAt || '') || 0
            if (createdAt && now - createdAt > TASK_TTL_MS) {
                tasks.delete(id)
                changed = true
            }
        }
        if (changed) schedulePersistTasks()
    }, 60_000)
}

function publicTaskView(task) {
    if (!task) return null
    const { token, abortController, ...rest } = task
    return rest
}

function sseSend(res, event, data) {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function sseComment(res, comment) {
    res.write(`: ${comment}\n\n`)
}

function addTaskListener(taskId, res) {
    if (!taskListeners.has(taskId)) {
        taskListeners.set(taskId, new Set())
    }
    taskListeners.get(taskId).add(res)
}

function removeTaskListener(taskId, res) {
    const set = taskListeners.get(taskId)
    if (!set) return
    set.delete(res)
    if (set.size === 0) {
        taskListeners.delete(taskId)
    }
}

function broadcastTaskEvent(taskId, event, payload) {
    const listeners = taskListeners.get(taskId)
    if (!listeners) return
    for (const res of listeners) {
        try {
            sseSend(res, event, payload)
        } catch {
            // ignore
        }
    }
}

function updateTask(taskId, patch, event = 'status') {
    const task = tasks.get(taskId)
    if (!task) return null
    Object.assign(task, patch)
    schedulePersistTasks()
    broadcastTaskEvent(taskId, event, publicTaskView(task))
    return task
}

function createTaskState({ requestId, token, payload }) {
    const id = uuid()
    return {
        id,
        requestId: requestId || '',
        status: 'queued',
        stage: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: '',
        finishedAt: '',
        error: '',
        cancelRequested: false,
        token: token || '',
        abortController: null,
        rawPayload: payload,
        payload: {
            configId: payload.configId,
            model: payload.model || '',
            aspectRatio: payload.aspectRatio || '',
            imageSize: payload.imageSize || '',
            enableGoogleSearch: Boolean(payload.enableGoogleSearch),
            outputFormat: payload.outputFormat || '',
            quality: payload.quality || '',
            background: payload.background || '',
            size: payload.size || '',
            promptLength: typeof payload.prompt === 'string' ? payload.prompt.length : 0,
            imagesCount: Array.isArray(payload.images) ? payload.images.length : 0,
            mode: payload.mode || 'standard',
            styleId: payload.styleId || ''
        },
        result: null
    }
}

function enqueueTask(task) {
    if (taskQueue.length >= MAX_QUEUE_SIZE) {
        throw new Error('任务队列已满，请稍后重试')
    }
    tasks.set(task.id, task)
    taskQueue.push(task.id)
    schedulePersistTasks()
    drainQueue()
}

function drainQueue() {
    while (runningTasks < MAX_CONCURRENT_TASKS && taskQueue.length) {
        const nextId = taskQueue.shift()
        const task = tasks.get(nextId)
        if (!task || task.status !== 'queued') continue
        runningTasks += 1
        runTask(nextId)
            .catch(() => null)
            .finally(() => {
                runningTasks -= 1
                drainQueue()
            })
    }
}

async function runTask(taskId) {
    const task = tasks.get(taskId)
    if (!task) return

    if (task.cancelRequested) {
        updateTask(
            taskId,
            {
                status: 'canceled',
                stage: 'canceled',
                finishedAt: new Date().toISOString()
            },
            'canceled'
        )
        return
    }

    updateTask(taskId, { status: 'running', stage: 'calling_upstream', startedAt: new Date().toISOString() }, 'status')

    const abortController = new AbortController()
    task.abortController = abortController

    try {
        const config = await loadConfig()
        const apiConfig = (config.apiConfigs || []).find(item => item.id === task.rawPayload.configId)
        if (!apiConfig) {
            throw new Error('找不到对应的 API 配置')
        }
        const resolvedModel = task.rawPayload.model || apiConfig.model
        if (isOpenAIImageModel(resolvedModel)) {
            const openAIImageError = validateOpenAIImagePayload(task.rawPayload)
            if (openAIImageError) {
                throw new Error(openAIImageError)
            }
        }

        const upstreamStart = Date.now()
        logInfo(
            '生成',
            '开始调用上游模型',
            {
                apiConfigId: apiConfig.id,
                apiConfigLabel: apiConfig.label,
                model: resolvedModel,
                promptLength: task.payload?.promptLength || 0,
                imagesCount: task.payload?.imagesCount || 0,
                aspectRatio: task.rawPayload.aspectRatio || '',
                imageSize: task.rawPayload.imageSize || '',
                enableGoogleSearch: Boolean(task.rawPayload.enableGoogleSearch),
                outputFormat: task.rawPayload.outputFormat || '',
                quality: task.rawPayload.quality || '',
                background: task.rawPayload.background || '',
                size: task.rawPayload.size || ''
            },
            task.requestId
        )
        const result = await generateImage(
            {
                apiConfig,
                prompt: task.rawPayload.prompt,
                images: task.rawPayload.images || [],
                model: resolvedModel,
                aspectRatio: task.rawPayload.aspectRatio,
                imageSize: task.rawPayload.imageSize,
                enableGoogleSearch: task.rawPayload.enableGoogleSearch,
                outputFormat: task.rawPayload.outputFormat,
                quality: task.rawPayload.quality,
                background: task.rawPayload.background,
                size: task.rawPayload.size
            },
            task.requestId,
            abortController.signal
        )

        updateTask(
            taskId,
            {
                stage: 'saving',
                upstreamMs: Date.now() - upstreamStart,
                candidates: Array.isArray(result.imageCandidates) ? result.imageCandidates.length : 0
            },
            'status'
        )
        logInfo(
            '生成',
            '上游返回完成',
            {
                apiConfigId: apiConfig.id,
                durationMs: task.upstreamMs,
                candidates: task.candidates
            },
            task.requestId
        )

        const { entry: savedEntry } = await persistGalleryEntry(
            {
                prompt: task.rawPayload.prompt,
                responseText: result.textResponse,
                imageSource: result.imageUrl,
                imageCandidates: result.imageCandidates,
                configLabel: apiConfig.label,
                configId: apiConfig.id,
                modelId: result.modelUsed,
                aspectRatio: result.aspectRatioUsed,
                imageSize: result.imageSizeUsed,
                mode: task.rawPayload.mode || 'standard',
                styleId: task.rawPayload.styleId || '',
                brandBrief: task.rawPayload.brandBrief || null
            },
            task.requestId,
            { includeImageData: false },
            stage => updateTask(taskId, { stage }, 'status')
        )

        updateTask(
            taskId,
            {
                status: 'done',
                stage: 'done',
                finishedAt: new Date().toISOString(),
                result: { galleryEntry: savedEntry }
            },
            'done'
        )
    } catch (error) {
        if (task.cancelRequested) {
            updateTask(taskId, { status: 'canceled', stage: 'canceled', error: '已取消' }, 'canceled')
        } else {
            updateTask(taskId, { status: 'failed', stage: 'failed', error: error instanceof Error ? error.message : String(error) }, 'error')
        }
        updateTask(taskId, { finishedAt: new Date().toISOString() }, task.cancelRequested ? 'canceled' : 'error')
    } finally {
        task.abortController = null
    }
}


async function loadConfig() {
    const raw = await fs.promises.readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
}

async function saveConfig(config) {
    await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4))
}

async function loadGallery() {
    const raw = await fs.promises.readFile(GALLERY_DATA_PATH, 'utf-8')
    return JSON.parse(raw)
}

async function saveGallery(entries) {
    await fs.promises.writeFile(GALLERY_DATA_PATH, JSON.stringify(entries, null, 4))
}

function sanitizeConfig(apiConfig) {
    const { apiKey, ...rest } = apiConfig
    return rest
}

// 风格库六字段：风格名称/主体特征/环境基调/构图规则/色彩分级/禁用项。
// 兼容旧版 {title,prompt,description} 扁平模板：整段 prompt 迁移进"主体特征"，避免历史数据丢失。
function normalizeStyleTemplate(raw) {
    if (!raw) return raw
    const isLegacyShape = typeof raw.prompt === 'string' && raw.subject === undefined
    if (isLegacyShape) {
        return {
            id: raw.id,
            name: raw.title || '',
            subject: raw.prompt || '',
            environment: '',
            composition: '',
            colorGrading: '',
            forbidden: '',
            image: raw.image || ''
        }
    }
    return {
        id: raw.id,
        name: raw.name || '',
        subject: raw.subject || '',
        environment: raw.environment || '',
        composition: raw.composition || '',
        colorGrading: raw.colorGrading || '',
        forbidden: raw.forbidden || '',
        image: raw.image || ''
    }
}

// 风格库 Excel 导出/导入：列名与团队线下模板保持一致，Excel 只是临时编辑载体。
const STYLE_EXPORT_HEADERS = ['风格名称', '主体特征', '环境基调', '构图规则', '色彩分级', '禁用项']
const STYLE_FIELD_BY_HEADER = {
    风格名称: 'name',
    主体特征: 'subject',
    环境基调: 'environment',
    构图规则: 'composition',
    色彩分级: 'colorGrading',
    禁用项: 'forbidden'
}

function buildStyleWorkbook(templates) {
    const rows = templates.map(template => ({
        风格名称: template.name || '',
        主体特征: template.subject || '',
        环境基调: template.environment || '',
        构图规则: template.composition || '',
        色彩分级: template.colorGrading || '',
        禁用项: template.forbidden || ''
    }))
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: STYLE_EXPORT_HEADERS })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, '风格库')
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

// 团队线下模板首行是标题、第二行是填写说明，真正的列头（风格名称...）在第三行才出现，
// 所以先按原始网格读取，定位包含"风格名称"的那一行作为表头，再按表头文字取值，
// 而不是假设第一行就是表头——这样无论表头前有几行说明文字都能正确解析。
function parseStyleWorkbook(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return []
    const sheet = workbook.Sheets[sheetName]
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

    const headerRowIndex = grid.findIndex(row => Array.isArray(row) && row.some(cell => String(cell || '').trim() === '风格名称'))
    if (headerRowIndex === -1) return []

    const headerRow = grid[headerRowIndex].map(cell => String(cell || '').trim())
    const columnIndexByField = {}
    headerRow.forEach((header, index) => {
        const field = STYLE_FIELD_BY_HEADER[header]
        if (field) columnIndexByField[field] = index
    })

    const records = []
    for (let i = headerRowIndex + 1; i < grid.length; i++) {
        const row = grid[i]
        if (!row) continue
        const record = {}
        for (const [field, index] of Object.entries(columnIndexByField)) {
            const value = row[index]
            record[field] = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
        }
        if (record.name) records.push(record)
    }
    return records
}

// 模块①-b 批量导入：每一行 = 一个出图任务（参考图链接 + 风格库标签 + 标准/品牌模式）。
// 表头定位逻辑与风格库表格一致，容忍表头前有说明行。
const TASK_IMPORT_HEADERS = ['参考图链接', '风格名称', '模式', '特殊要求']
const TASK_IMPORT_FIELD_BY_HEADER = {
    参考图链接: 'imageUrl',
    风格名称: 'styleName',
    模式: 'mode',
    特殊要求: 'note'
}

function buildTaskImportTemplateWorkbook() {
    const rows = [
        {
            参考图链接: 'https://example.com/reference.jpg',
            风格名称: '法式复古街拍',
            模式: '标准',
            特殊要求: ''
        }
    ]
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: TASK_IMPORT_HEADERS })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, '批量导入')
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

function parseTaskImportWorkbook(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return []
    const sheet = workbook.Sheets[sheetName]
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

    const headerRowIndex = grid.findIndex(row => Array.isArray(row) && row.some(cell => String(cell || '').trim() === '参考图链接'))
    if (headerRowIndex === -1) return []

    const headerRow = grid[headerRowIndex].map(cell => String(cell || '').trim())
    const columnIndexByField = {}
    headerRow.forEach((header, index) => {
        const field = TASK_IMPORT_FIELD_BY_HEADER[header]
        if (field) columnIndexByField[field] = index
    })

    const records = []
    for (let i = headerRowIndex + 1; i < grid.length; i++) {
        const row = grid[i]
        if (!row) continue
        const record = {}
        for (const [field, index] of Object.entries(columnIndexByField)) {
            const value = row[index]
            record[field] = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
        }
        if (record.imageUrl) records.push(record)
    }
    return records
}

function authMiddleware(req, res, next) {
    const header = req.headers.authorization
    if (!header) {
        logInfo('鉴权', '缺少 Authorization 请求头', null, req.requestId)
        return res.status(401).json({ message: '未提供 Authorization 头' })
    }

    const [, token] = header.split(' ')
    if (!token) {
        return res.status(401).json({ message: '无效的认证信息' })
    }

    loadConfig()
        .then(config => {
            const secret = config?.auth?.jwtSecret
            if (!secret) {
                return res.status(500).json({ message: '服务器未配置 jwtSecret' })
            }
            jwt.verify(token, secret, (err, decoded) => {
                if (err) {
                    return res.status(401).json({ message: '认证失效，请重新登录' })
                }
                req.user = decoded
                next()
            })
        })
        .catch(error => {
            logError('鉴权', '读取配置失败', error, req.requestId)
            res.status(500).json({ message: '无法读取配置' })
        })
}

app.post('/api/login', async (req, res) => {
    logInfo('登录', '收到登录请求', null, req.requestId)
    const { password } = req.body
    if (!password) {
        return res.status(400).json({ message: '密码不能为空' })
    }

    try {
        const config = await loadConfig()
        const authConfig = config.auth || {}
        const jwtSecret = authConfig.jwtSecret

        if (!jwtSecret) {
            return res.status(500).json({ message: '服务器未配置 jwtSecret' })
        }

        let isValid = false
        if (authConfig.passwordHash) {
            isValid = await bcrypt.compare(password, authConfig.passwordHash)
        } else if (authConfig.password) {
            isValid = password === authConfig.password
        }

        if (!isValid) {
            logInfo('登录', '密码错误', null, req.requestId)
            return res.status(401).json({ message: '密码错误' })
        }

        const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: authConfig.tokenExpiresIn || '12h' })
        logInfo('登录', '登录成功，已签发 Token', null, req.requestId)
        res.json({ token })
    } catch (error) {
        logError('登录', '登录失败', error, req.requestId)
        res.status(500).json({ message: '服务器异常，无法登录' })
    }
})

app.get('/api/session', authMiddleware, (req, res) => {
    res.json({ ok: true })
})

app.get('/api/api-configs', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const configs = (config.apiConfigs || []).map(sanitizeConfig)
        const defaultConfigId = config.defaultApiConfigId || ''
        logInfo('API 配置', `读取配置成功，共 ${configs.length} 条`, null, req.requestId)
        res.json({ configs, defaultConfigId })
    } catch (error) {
        logError('API 配置', '读取配置失败', error, req.requestId)
        res.status(500).json({ message: '???? API ??' })
    }
})

app.post('/api/api-configs', authMiddleware, async (req, res) => {
    const payload = req.body || {}
    if (!payload.id || !payload.label || !payload.endpoint || !payload.model || !payload.apiKey) {
        return res.status(400).json({ message: 'id????endpoint?model?apiKey ????' })
    }
    try {
        const config = await loadConfig()
        const list = config.apiConfigs || []
        if (list.find(item => item.id === payload.id)) {
            return res.status(409).json({ message: 'ID ??????????' })
        }
        const newItem = {
            id: String(payload.id).trim(),
            label: String(payload.label).trim(),
            endpoint: String(payload.endpoint).trim(),
            model: String(payload.model).trim(),
            description: payload.description ? String(payload.description).trim() : '',
            apiKey: String(payload.apiKey).trim()
        }
        list.push(newItem)
        config.apiConfigs = list
        if (!config.defaultApiConfigId) {
            config.defaultApiConfigId = newItem.id
        }
        await saveConfig(config)
        logInfo('API 配置', `已新增配置 ${newItem.id}`, { label: newItem.label }, req.requestId)
        res.json({ config: sanitizeConfig(newItem) })
    } catch (error) {
        logError('API 配置', '新增配置失败', error, req.requestId)
        res.status(500).json({ message: '???? API ??' })
    }
})

app.put('/api/api-configs/:id', authMiddleware, async (req, res) => {
    const payload = req.body || {}
    try {
        const config = await loadConfig()
        const list = config.apiConfigs || []
        const index = list.findIndex(item => item.id === req.params.id)
        if (index === -1) {
            return res.status(404).json({ message: '?????' })
        }
        const current = list[index]
        const nextConfig = {
            ...current,
            label: payload.label ? String(payload.label).trim() : current.label,
            endpoint: payload.endpoint ? String(payload.endpoint).trim() : current.endpoint,
            model: payload.model ? String(payload.model).trim() : current.model,
            description: payload.description !== undefined ? String(payload.description).trim() : current.description
        }
        if (payload.apiKey && String(payload.apiKey).trim()) {
            nextConfig.apiKey = String(payload.apiKey).trim()
        }
        list[index] = nextConfig
        config.apiConfigs = list
        await saveConfig(config)
        logInfo('API 配置', `已更新配置 ${nextConfig.id}`, { label: nextConfig.label }, req.requestId)
        res.json({ config: sanitizeConfig(nextConfig) })
    } catch (error) {
        logError('API 配置', '更新配置失败', error, req.requestId)
        res.status(500).json({ message: '???? API ??' })
    }
})

app.delete('/api/api-configs/:id', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const list = config.apiConfigs || []
        const index = list.findIndex(item => item.id === req.params.id)
        if (index === -1) {
            return res.status(404).json({ message: '?????' })
        }
        const removed = list.splice(index, 1)[0]
        config.apiConfigs = list
        if (config.defaultApiConfigId === removed.id) {
            config.defaultApiConfigId = list[0]?.id || ''
        }
        await saveConfig(config)
        logInfo('API 配置', `已删除配置 ${removed.id}`, { label: removed.label }, req.requestId)
        res.json({ config: sanitizeConfig(removed) })
    } catch (error) {
        logError('API 配置', '删除配置失败', error, req.requestId)
        res.status(500).json({ message: '???? API ??' })
    }
})


app.post('/api/api-configs/:id/default', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const list = config.apiConfigs || []
        const exists = list.find(item => item.id === req.params.id)
        if (!exists) {
            return res.status(404).json({ message: '??????' })
        }
        config.defaultApiConfigId = exists.id
        await saveConfig(config)
        logInfo('API 配置', `已设置默认配置 ${exists.id}`, { label: exists.label }, req.requestId)
        res.json({ defaultConfigId: exists.id })
    } catch (error) {
        logError('API 配置', '设置默认配置失败', error, req.requestId)
        res.status(500).json({ message: '?????????? API ?????' })
    }
})

app.get('/api/api-configs/:id/models', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const apiConfig = (config.apiConfigs || []).find(item => item.id === req.params.id)
        if (!apiConfig) {
            return res.status(404).json({ message: '?????? API ??' })
        }

        const models = await fetchModels(apiConfig)
        res.json({ models })
    } catch (error) {
        logError('models', '????????', error)
        res.status(500).json({ message: error.message || '????????' })
    }
})

app.get('/api/logs', authMiddleware, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 2000))
    const slice = logBuffer.slice(-limit)
    res.json({ logs: slice })
})

app.get('/api/logs/events', authMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const heartbeatTimer = setInterval(() => {
        try {
            res.write(`: ping\n\n`)
        } catch {
            // ignore
        }
    }, SSE_HEARTBEAT_MS)

    logListeners.add(res)

    req.on('close', () => {
        clearInterval(heartbeatTimer)
        logListeners.delete(res)
    })
})

app.get('/api/templates', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        logInfo('模板', `读取模板成功，共 ${templates.length} 条`, null, req.requestId)
        res.json({ templates })
    } catch (error) {
        logError('模板', '读取模板失败', error, req.requestId)
        res.status(500).json({ message: '无法读取模板' })
    }
})

app.post('/api/templates', authMiddleware, async (req, res) => {
    const template = req.body
    if (!template?.name) {
        return res.status(400).json({ message: '风格名称不能为空' })
    }

    try {
        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        const newTemplate = {
            id: template.id || uuid(),
            name: template.name,
            subject: template.subject || '',
            environment: template.environment || '',
            composition: template.composition || '',
            colorGrading: template.colorGrading || '',
            forbidden: template.forbidden || '',
            image: template.image || ''
        }
        templates.push(newTemplate)
        config.templates = templates
        await saveConfig(config)
        logInfo('模板', `已新增模板 ${newTemplate.id}`, { name: newTemplate.name }, req.requestId)
        res.json({ template: newTemplate })
    } catch (error) {
        logError('模板', '新增模板失败', error, req.requestId)
        res.status(500).json({ message: '无法保存模板' })
    }
})

app.put('/api/templates/:id', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        const index = templates.findIndex(item => item.id === req.params.id)
        if (index === -1) {
            return res.status(404).json({ message: '模板不存在' })
        }
        const payload = req.body || {}
        const current = templates[index]
        templates[index] = {
            ...current,
            name: payload.name !== undefined ? payload.name : current.name,
            subject: payload.subject !== undefined ? payload.subject : current.subject,
            environment: payload.environment !== undefined ? payload.environment : current.environment,
            composition: payload.composition !== undefined ? payload.composition : current.composition,
            colorGrading: payload.colorGrading !== undefined ? payload.colorGrading : current.colorGrading,
            forbidden: payload.forbidden !== undefined ? payload.forbidden : current.forbidden,
            image: payload.image !== undefined ? payload.image : current.image
        }
        config.templates = templates
        await saveConfig(config)
        logInfo('模板', `已更新模板 ${templates[index].id}`, { name: templates[index].name }, req.requestId)
        res.json({ template: templates[index] })
    } catch (error) {
        logError('模板', '更新模板失败', error, req.requestId)
        res.status(500).json({ message: '无法更新模板' })
    }
})

app.delete('/api/templates/:id', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        const index = templates.findIndex(item => item.id === req.params.id)
        if (index === -1) {
            return res.status(404).json({ message: '模板不存在' })
        }
        const removed = templates.splice(index, 1)[0]
        config.templates = templates
        await saveConfig(config)
        logInfo('模板', `已删除模板 ${removed.id}`, { name: removed.name }, req.requestId)
        res.json({ template: removed })
    } catch (error) {
        logError('模板', '删除模板失败', error, req.requestId)
        res.status(500).json({ message: '无法删除模板' })
    }
})

app.get('/api/templates/export', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        const buffer = buildStyleWorkbook(templates)
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="style-library.xlsx"')
        logInfo('模板', `导出风格库 Excel，共 ${templates.length} 条`, null, req.requestId)
        res.send(buffer)
    } catch (error) {
        logError('模板', '导出风格库失败', error, req.requestId)
        res.status(500).json({ message: '导出失败' })
    }
})

app.post('/api/templates/import', authMiddleware, async (req, res) => {
    const { fileBase64 } = req.body || {}
    if (!fileBase64 || typeof fileBase64 !== 'string') {
        return res.status(400).json({ message: '缺少文件内容' })
    }

    try {
        const base64Data = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64
        const buffer = Buffer.from(base64Data, 'base64')
        const rows = parseStyleWorkbook(buffer)
        if (!rows.length) {
            return res.status(400).json({ message: '未解析到有效数据，请确认"风格名称"列已填写' })
        }

        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        let created = 0
        let updated = 0
        for (const row of rows) {
            const existing = templates.find(item => item.name === row.name)
            if (existing) {
                Object.assign(existing, row)
                updated += 1
            } else {
                templates.push({ id: uuid(), image: '', ...row })
                created += 1
            }
        }
        config.templates = templates
        await saveConfig(config)
        logInfo('模板', `导入风格库 Excel：新增 ${created} 条，更新 ${updated} 条`, null, req.requestId)
        res.json({ templates, created, updated })
    } catch (error) {
        logError('模板', '导入风格库失败', error, req.requestId)
        res.status(400).json({ message: '文件解析失败，请确认文件格式是否正确' })
    }
})

app.post('/api/brief/extract', authMiddleware, async (req, res) => {
    const { configId, model, briefText } = req.body || {}
    if (!configId) {
        return res.status(400).json({ message: '必须指定 API 配置' })
    }
    const text = typeof briefText === 'string' ? briefText.trim() : ''
    if (!text) {
        return res.status(400).json({ message: '请先粘贴或上传品牌 Brief 内容' })
    }

    try {
        const config = await loadConfig()
        const apiConfig = (config.apiConfigs || []).find(item => item.id === configId)
        if (!apiConfig) {
            return res.status(400).json({ message: '找不到对应的 API 配置' })
        }
        const resolvedModel = model || apiConfig.model
        if (isOpenAIImageModel(resolvedModel)) {
            return res.status(400).json({ message: '当前模型是纯图像生成模型，不支持解析文本 Brief，请切换到支持文本对话的模型或配置' })
        }

        const fields = await extractBrandBriefFields({ apiConfig, model: resolvedModel, briefText: text }, req.requestId)
        logInfo('品牌Brief', 'Brief 解析成功', { configId, briefLength: text.length }, req.requestId)
        res.json(fields)
    } catch (error) {
        logError('品牌Brief', 'Brief 解析失败', error, req.requestId)
        res.status(500).json({ message: error instanceof Error ? error.message : 'Brief 解析失败' })
    }
})

app.get('/api/gallery', authMiddleware, async (req, res) => {
    try {
        const entries = await loadGallery()
        logInfo('图库', `读取图库成功，共 ${entries.length} 条`, null, req.requestId)
        res.json({ entries })
    } catch (error) {
        logError('图库', '读取图库失败', error, req.requestId)
        res.status(500).json({ message: '无法读取图库' })
    }
})

// --- 异步任务接口 ---
app.post('/api/generate/task', authMiddleware, async (req, res) => {
    const payload = req.body || {}
    if (!payload.configId) {
        return res.status(400).json({ message: '必须指定 API 配置' })
    }

    // 模块③指令组装：选中风格时，用风格库六字段按"主体→环境→构图→风格→特殊要求"拼装最终提示词，
    // 而不是直接使用前端传来的整段 prompt。未选风格（纯自定义提示词/文生图）则保持原样。
    if (payload.styleId) {
        try {
            const config = await loadConfig()
            const templates = (config.templates || []).map(normalizeStyleTemplate)
            const style = templates.find(item => item.id === payload.styleId)
            if (!style) {
                return res.status(400).json({ message: '找不到所选风格，请重新选择' })
            }
            payload.prompt = assembleStyleInstruction(style, payload.specialRequirements)
        } catch (error) {
            logError('生成', '指令组装失败', error, req.requestId)
            return res.status(500).json({ message: '指令组装失败，请稍后重试' })
        }
    }

    // 模块①-c 品牌Brief解析：人工确认过的品牌要点作为额外约束，追加在风格库字段之后一起参与指令组装。
    if (payload.brandBrief) {
        const brief = payload.brandBrief
        const briefLines = []
        if (typeof brief.coreRequirement === 'string' && brief.coreRequirement.trim()) {
            briefLines.push(`品牌核心诉求：${brief.coreRequirement.trim()}`)
        }
        if (typeof brief.visualTone === 'string' && brief.visualTone.trim()) {
            briefLines.push(`品牌视觉基调：${brief.visualTone.trim()}`)
        }
        if (typeof brief.forbidden === 'string' && brief.forbidden.trim()) {
            briefLines.push(`品牌禁忌项：${brief.forbidden.trim()}`)
        }
        if (briefLines.length) {
            payload.prompt = [payload.prompt, ...briefLines].filter(Boolean).join('\n')
        }
    }

    const payloadError = validateGeneratePayload(payload)
    if (payloadError) {
        return res.status(400).json({ message: payloadError })
    }
    try {
        const summary = {
            configId: payload.configId || '',
            model: payload.model || '',
            promptLength: typeof payload.prompt === 'string' ? payload.prompt.length : 0,
            imagesCount: Array.isArray(payload.images) ? payload.images.length : 0,
            aspectRatio: payload.aspectRatio || '',
            imageSize: payload.imageSize || '',
            enableGoogleSearch: Boolean(payload.enableGoogleSearch),
            outputFormat: payload.outputFormat || '',
            quality: payload.quality || '',
            background: payload.background || '',
            size: payload.size || '',
            mode: payload.mode || 'standard',
            styleId: payload.styleId || ''
        }
        logInfo('生成', '收到生成任务请求', summary, req.requestId)
        const task = createTaskState({ requestId: req.requestId, token: '', payload })
        enqueueTask(task)
        logInfo('任务', '已创建生成任务', { taskId: task.id, configId: payload.configId }, req.requestId)
        res.status(202).json({ taskId: task.id, status: task.status })
    } catch (error) {
        logError('任务', '创建任务失败', error, req.requestId)
        res.status(429).json({ message: error instanceof Error ? error.message : '任务队列繁忙，请稍后重试' })
    }
})

app.get('/api/generate/tasks/import-template', authMiddleware, async (req, res) => {
    try {
        const buffer = buildTaskImportTemplateWorkbook()
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="batch-import-template.xlsx"')
        res.send(buffer)
    } catch (error) {
        logError('任务', '导出批量导入模板失败', error, req.requestId)
        res.status(500).json({ message: '导出失败' })
    }
})

// 模块①-b：批量导入 Excel，每一行转换成一个独立任务，喂给现有排队处理（enqueueTask），
// 队列本身不用改——原来一次提交一个任务，现在只是循环提交多次。
app.post('/api/generate/tasks/import', authMiddleware, async (req, res) => {
    const { fileBase64, ...common } = req.body || {}
    if (!fileBase64 || typeof fileBase64 !== 'string') {
        return res.status(400).json({ message: '缺少文件内容' })
    }
    if (!common.configId) {
        return res.status(400).json({ message: '必须指定 API 配置' })
    }

    try {
        const base64Data = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64
        const buffer = Buffer.from(base64Data, 'base64')
        const rows = parseTaskImportWorkbook(buffer)
        if (!rows.length) {
            return res.status(400).json({ message: '未解析到有效数据，请确认"参考图链接"列已填写' })
        }

        const config = await loadConfig()
        const templates = (config.templates || []).map(normalizeStyleTemplate)
        const styleByName = new Map(templates.map(item => [item.name, item]))

        const taskIds = []
        const failed = []

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]
            const rowNum = i + 2 // 表头占一行，行号从数据第一行=2开始，方便对照 Excel
            const style = row.styleName ? styleByName.get(row.styleName) : null
            if (row.styleName && !style) {
                failed.push({ row: rowNum, reason: `找不到风格"${row.styleName}"` })
                continue
            }

            const payload = {
                ...common,
                images: [row.imageUrl],
                mode: row.mode === '品牌' ? 'brand' : 'standard'
            }
            if (style) {
                payload.styleId = style.id
                payload.specialRequirements = row.note || ''
                payload.prompt = assembleStyleInstruction(style, payload.specialRequirements)
            } else {
                payload.prompt = row.note || ''
            }

            const payloadError = validateGeneratePayload(payload)
            if (payloadError) {
                failed.push({ row: rowNum, reason: payloadError })
                continue
            }

            try {
                const task = createTaskState({ requestId: req.requestId, token: '', payload })
                enqueueTask(task)
                taskIds.push(task.id)
            } catch (error) {
                failed.push({ row: rowNum, reason: error instanceof Error ? error.message : '任务队列繁忙' })
            }
        }

        logInfo('任务', `批量导入完成：成功 ${taskIds.length} 条，失败 ${failed.length} 条`, { failed }, req.requestId)
        res.json({ imported: taskIds.length, failed, taskIds })
    } catch (error) {
        logError('任务', '批量导入失败', error, req.requestId)
        res.status(400).json({ message: '文件解析失败，请确认文件格式是否正确' })
    }
})

app.get('/api/generate/task/:id', authMiddleware, (req, res) => {
    const task = tasks.get(req.params.id)
    if (!task) {
        return res.status(404).json({ message: '任务不存在' })
    }
    res.json(publicTaskView(task))
})

app.get('/api/generate/task/:id/events', authMiddleware, (req, res) => {
    const task = tasks.get(req.params.id)
    if (!task) {
        return res.status(404).end()
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const sendHeartbeat = () => sseComment(res, 'ping')
    const heartbeatTimer = setInterval(sendHeartbeat, SSE_HEARTBEAT_MS)
    addTaskListener(task.id, res)

    // 先推送当前状态
    sseSend(res, 'status', publicTaskView(task))

    req.on('close', () => {
        clearInterval(heartbeatTimer)
        removeTaskListener(task.id, res)
    })
})

app.get('/api/tasks', authMiddleware, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 2000))
    const list = Array.from(tasks.values())
        .map(publicTaskView)
        .sort((a, b) => {
            const ta = Date.parse(a.createdAt || '') || 0
            const tb = Date.parse(b.createdAt || '') || 0
            return tb - ta
        })
        .slice(0, limit)
    res.json({ tasks: list })
})

app.delete('/api/generate/task/:id', authMiddleware, (req, res) => {
    const task = tasks.get(req.params.id)
    if (!task) {
        return res.status(404).json({ message: '任务不存在' })
    }
    task.cancelRequested = true
    if (task.abortController) {
        task.abortController.abort()
    }
    task.status = 'canceled'
    task.stage = 'canceled'
    task.error = '已取消'
    task.finishedAt = new Date().toISOString()
    schedulePersistTasks()
    broadcastTaskEvent(task.id, 'canceled', publicTaskView(task))
    logInfo('任务', '已取消任务', { taskId: task.id }, req.requestId)
    res.json(publicTaskView(task))
})

app.post('/api/generate/task/:id/retry', authMiddleware, (req, res) => {
    const task = tasks.get(req.params.id)
    if (!task) {
        return res.status(404).json({ message: '任务不存在' })
    }
    if (task.status !== 'failed' && task.status !== 'canceled') {
        return res.status(400).json({ message: '只有失败或已取消的任务才能重试' })
    }
    try {
        const retryTask = createTaskState({ requestId: req.requestId, token: '', payload: task.rawPayload })
        enqueueTask(retryTask)
        logInfo('任务', '已重试任务', { originalTaskId: task.id, newTaskId: retryTask.id }, req.requestId)
        res.status(202).json({ taskId: retryTask.id, status: retryTask.status })
    } catch (error) {
        logError('任务', '重试任务失败', error, req.requestId)
        res.status(429).json({ message: error instanceof Error ? error.message : '任务队列繁忙，请稍后重试' })
    }
})

async function fetchModels(apiConfig) {
    const endpoint = resolveModelsEndpoint(apiConfig.endpoint)
    logInfo('模型', `获取模型列表：${apiConfig.id}`, { endpoint })
    const response = await fetchWithRetry(
        endpoint,
        {
            headers: {
                Authorization: `Bearer ${apiConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        },
        { timeoutMs: 30_000, retries: 1, retryDelayMs: 500 }
    )

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`获取模型列表失败 ${response.status}: ${text}`)
    }

    const data = await response.json()
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null
    if (!list) {
        throw new Error('模型列表返回格式不符合预期')
    }

    logInfo('模型', `模型列表获取成功，共 ${list.length} 条`, { endpoint })
    return list
}


function resolveModelsEndpoint(endpoint) {
    try {
        const url = new URL(endpoint)
        const segments = url.pathname.split('/').filter(Boolean)
        if (!segments.length) {
            url.pathname = '/models'
            return url.toString()
        }

        const last = segments[segments.length - 1]
        if (last === 'models') {
            return url.toString()
        }

        if (['completions', 'complete', 'generate'].includes(last)) {
            segments.pop()
        }

        if (segments[segments.length - 1] === 'chat') {
            segments[segments.length - 1] = 'models'
        } else {
            segments.push('models')
        }

        url.pathname = '/' + segments.join('/')
        return url.toString()
    } catch (error) {
        console.warn('[models] 无法解析 endpoint，将采用默认规则', error)
        return endpoint.replace(/\/$/, '') + '/models'
    }
}

const OPENAI_IMAGE_SIZE_PRESETS = new Set([
    'auto',
    '1024x1024',
    '1536x1024',
    '1024x1536',
    '2048x2048',
    '2048x1152',
    '3840x2160',
    '2160x3840'
])
const OPENAI_IMAGE_QUALITY_OPTIONS = new Set(['auto', 'low', 'medium', 'high'])
const OPENAI_IMAGE_FORMAT_OPTIONS = new Set(['png', 'jpeg', 'webp'])
const OPENAI_IMAGE_BACKGROUND_OPTIONS = new Set(['auto', 'opaque', 'transparent'])
const MIN_OPENAI_IMAGE_PIXELS = 655_360
const MAX_OPENAI_IMAGE_PIXELS = 8_294_400
const MAX_OPENAI_IMAGE_EDGE = 3840
const MAX_OPENAI_IMAGE_RATIO = 3

function validateGeneratePayload(payload) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    const images = Array.isArray(payload.images) ? payload.images : []
    if (!prompt && !images.length) {
        return '缺少提示词或参考图像'
    }
    if (payload.images !== undefined && !Array.isArray(payload.images)) {
        return 'images 必须是数组'
    }

    if (!isOpenAIImageModel(payload.model || '')) {
        return ''
    }

    return validateOpenAIImagePayload(payload)
}

function validateOpenAIImagePayload(payload) {
    const sizeError = validateOpenAIImageSize(payload.size || 'auto')
    if (sizeError) return sizeError

    const quality = payload.quality || 'auto'
    if (!OPENAI_IMAGE_QUALITY_OPTIONS.has(quality)) {
        return 'OpenAI 图像质量参数不支持'
    }

    const outputFormat = payload.outputFormat || 'png'
    if (!OPENAI_IMAGE_FORMAT_OPTIONS.has(outputFormat)) {
        return 'OpenAI 输出格式仅支持 png、jpeg、webp'
    }

    const background = payload.background || 'auto'
    if (!OPENAI_IMAGE_BACKGROUND_OPTIONS.has(background)) {
        return 'OpenAI 背景参数不支持'
    }
    if (background === 'transparent') {
        return '当前 gpt-image 模型暂不支持透明背景'
    }

    return ''
}

function validateOpenAIImageSize(size) {
    if (!size || OPENAI_IMAGE_SIZE_PRESETS.has(size)) {
        return ''
    }

    const match = String(size).match(/^(\d+)x(\d+)$/)
    if (!match) {
        return 'OpenAI 图像尺寸格式必须是 auto 或 宽x高'
    }

    const width = Number(match[1])
    const height = Number(match[2])
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        return 'OpenAI 图像宽高必须是正整数'
    }
    if (width % 16 !== 0 || height % 16 !== 0) {
        return 'OpenAI 图像宽高都必须是 16 的倍数'
    }
    if (Math.max(width, height) > MAX_OPENAI_IMAGE_EDGE) {
        return 'OpenAI 图像最大边不能超过 3840px'
    }
    if (Math.max(width, height) / Math.min(width, height) > MAX_OPENAI_IMAGE_RATIO) {
        return 'OpenAI 图像长边与短边比例不能超过 3:1'
    }

    const pixels = width * height
    if (pixels < MIN_OPENAI_IMAGE_PIXELS || pixels > MAX_OPENAI_IMAGE_PIXELS) {
        return 'OpenAI 图像总像素数必须在 655360 到 8294400 之间'
    }

    return ''
}

function resolveOpenAIImageEndpoint(endpoint, mode) {
    const target = mode === 'edit' ? 'edits' : 'generations'
    try {
        const url = new URL(endpoint)
        const pathname = url.pathname.replace(/\/+$/, '')

        if (/\/images\/(generations|edits)$/i.test(pathname)) {
            url.pathname = pathname.replace(/\/images\/(generations|edits)$/i, `/images/${target}`)
            return url.toString()
        }
        if (/\/chat\/completions$/i.test(pathname)) {
            url.pathname = pathname.replace(/\/chat\/completions$/i, `/images/${target}`)
            return url.toString()
        }
        if (/\/responses$/i.test(pathname)) {
            url.pathname = pathname.replace(/\/responses$/i, `/images/${target}`)
            return url.toString()
        }
        if (/\/images$/i.test(pathname)) {
            url.pathname = `${pathname}/${target}`
            return url.toString()
        }
        if (/\/v\d+$/i.test(pathname)) {
            url.pathname = `${pathname}/images/${target}`
            return url.toString()
        }

        url.pathname = `${pathname}/images/${target}`
        return url.toString()
    } catch (error) {
        console.warn('[openai-images] 无法解析 endpoint，将采用默认拼接规则', error)
        return `${endpoint.replace(/\/+$/, '')}/images/${target}`
    }
}

async function generateImage({ apiConfig, prompt, images, model, aspectRatio, imageSize, enableGoogleSearch, outputFormat, quality, background, size }, requestId, signal) {
    if (!prompt && (!images || !images.length)) {
        throw new Error('缺少提示词或参考图像')
    }

    const resolvedModel = model || apiConfig.model
    const normalizedModelId = normalizeModelId(resolvedModel)
    if (isOpenAIImageModel(normalizedModelId)) {
        return generateOpenAIImage(
            {
                apiConfig,
                prompt,
                images: images || [],
                model: resolvedModel,
                outputFormat: outputFormat || 'png',
                quality: quality || 'auto',
                background: background || 'auto',
                size: size || 'auto'
            },
            requestId,
            signal
        )
    }

    return generateChatCompatibleImage(
        {
            apiConfig,
            prompt,
            images: images || [],
            model: resolvedModel,
            aspectRatio,
            imageSize,
            enableGoogleSearch
        },
        signal
    )
}

async function generateOpenAIImage({ apiConfig, prompt, images, model, outputFormat, quality, background, size }, requestId, signal) {
    const mode = images.length ? 'edit' : 'generation'
    const endpoint = resolveOpenAIImageEndpoint(apiConfig.endpoint, mode)
    const commonFields = {
        model,
        prompt,
        size,
        quality,
        output_format: outputFormat
    }

    if (background && background !== 'auto') {
        commonFields.background = background
    }

    const requestOptions = images.length
        ? await buildOpenAIImageEditRequest(commonFields, images, apiConfig.apiKey, signal)
        : {
              method: 'POST',
              headers: {
                  Authorization: `Bearer ${apiConfig.apiKey}`,
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify(commonFields),
              signal
          }

    const response = await fetchWithRetry(
        endpoint,
        requestOptions,
        { timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS, retries: DEFAULT_UPSTREAM_RETRIES, retryDelayMs: DEFAULT_UPSTREAM_RETRY_DELAY_MS }
    )

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenAI Images API 请求失败 ${response.status}: ${text}`)
    }

    const data = await response.json()
    const imageCandidates = extractImagesFromOpenAIImagesResponse(data, outputFormat)
    if (!imageCandidates.length) {
        throw new Error('OpenAI Images API 未返回图像')
    }

    const revisedPrompts = Array.isArray(data.data) ? data.data.map(item => item?.revised_prompt).filter(Boolean) : []
    logInfo(
        '生成',
        'OpenAI Images API 返回完成',
        { endpoint, mode, outputFormat, quality, size, candidates: imageCandidates.length },
        requestId
    )

    return {
        imageUrl: imageCandidates[0],
        imageCandidates,
        textResponse: revisedPrompts.join('\n'),
        modelUsed: model,
        aspectRatioUsed: '',
        imageSizeUsed: size
    }
}

async function buildOpenAIImageEditRequest(fields, images, apiKey, signal) {
    const form = new FormData()
    Object.entries(fields).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            form.append(key, String(value))
        }
    })

    for (let index = 0; index < images.length; index++) {
        const file = await createImageUploadFile(images[index], index)
        form.append('image[]', file.blob, file.fileName)
    }

    return {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`
        },
        body: form,
        signal
    }
}

async function createImageUploadFile(imageSource, index) {
    const image = await downloadImage(imageSource)
    const mimeType = image.mimeType || getMimeTypeByExtension(image.extension)
    return {
        blob: new Blob([image.buffer], { type: mimeType }),
        fileName: `reference-${index + 1}.${image.extension || 'png'}`
    }
}

function extractImagesFromOpenAIImagesResponse(data, outputFormat) {
    if (!Array.isArray(data?.data)) return []

    const mimeType = getMimeTypeByExtension(outputFormat || 'png')
    return data.data
        .flatMap(item => {
            if (typeof item?.url === 'string' && item.url.trim()) {
                return [item.url.trim()]
            }
            if (typeof item?.b64_json === 'string' && item.b64_json.trim()) {
                return [toDataUrl(item.b64_json.trim(), mimeType)]
            }
            return []
        })
        .filter(Boolean)
}

async function generateChatCompatibleImage({ apiConfig, prompt, images, model, aspectRatio, imageSize, enableGoogleSearch }, signal) {
    const normalizedModelId = normalizeModelId(model)
    const messageContent =
        !images || images.length === 0
            ? prompt
            : [
                  { type: 'text', text: prompt },
                  ...images.map(url => ({
                      type: 'image_url',
                      image_url: { url }
                  }))
              ]

    const messages = [{ role: 'user', content: messageContent }]
    const payload = {
        model,
        messages,
        modalities: ['image', 'text']
    }

    const imageConfig = {}
    if (aspectRatio) {
        imageConfig.aspect_ratio = aspectRatio
    }
    if (supportsImageSize(normalizedModelId) && imageSize) {
        imageConfig.image_size = imageSize
    }
    if (Object.keys(imageConfig).length > 0) {
        payload.image_config = imageConfig
    }
    if (supportsGoogleSearch(normalizedModelId) && enableGoogleSearch) {
        payload.tools = [{ google_search: {} }]
    }

    const response = await fetchWithRetry(
        apiConfig.endpoint,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiConfig.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal
        },
        { timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS, retries: DEFAULT_UPSTREAM_RETRIES, retryDelayMs: DEFAULT_UPSTREAM_RETRY_DELAY_MS }
    )

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`API 请求失败 ${response.status}: ${text}`)
    }

    const data = await response.json()
    const choice = data.choices?.[0]?.message
    if (!choice) {
        throw new Error('API 返回内容为空')
    }

    const imageCandidates = extractImagesFromChoice(choice)
    const imageUrl = imageCandidates[0] || null

    if (!imageUrl) {
        const textResponse = extractTextResponse(choice.content)
        throw new Error(textResponse || '模型未返回图像')
    }

    const textResponseRaw = extractTextResponse(choice.content)
    const textResponse = filterTextResponse(textResponseRaw)
    return {
        imageUrl,
        imageCandidates,
        textResponse,
        modelUsed: model,
        aspectRatioUsed: aspectRatio,
        imageSizeUsed: imageSize
    }
}

// 模块①-c 品牌Brief解析：复用当前选中的 API 配置做一次纯文本对话调用（不请求图像），
// 让模型把品牌方 brief 提炼成三项结构化要点，交由人工确认后再参与模块③指令组装。
async function extractBrandBriefFields({ apiConfig, model, briefText }, requestId, signal) {
    const prompt = `你是广告/摄影行业的品牌需求分析助手。请阅读下面的品牌方 brief 文档，提炼出三项结构化要点，严格以 JSON 格式输出（不要包含 JSON 以外的任何文字，也不要用 markdown 代码块包裹），字段如下：
{"coreRequirement": "核心诉求：一到两句话概括这次拍摄/出图要达成的核心目的和重点", "visualTone": "视觉基调：整体氛围、光线、质感、构图倾向等描述", "forbidden": "禁忌项：明确不能出现的元素、风格、竞品相关内容等，没有则填空字符串"}

品牌方 brief 原文：
${briefText}`

    const response = await fetchWithRetry(
        apiConfig.endpoint,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiConfig.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }]
            }),
            signal
        },
        { timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS, retries: DEFAULT_UPSTREAM_RETRIES, retryDelayMs: DEFAULT_UPSTREAM_RETRY_DELAY_MS }
    )

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Brief 解析请求失败 ${response.status}: ${text}`)
    }

    const data = await response.json()
    const choice = data.choices?.[0]?.message
    const textContent = extractTextResponse(choice?.content)
    if (!textContent) {
        throw new Error('模型未返回解析结果')
    }
    logInfo('品牌Brief', 'Brief 解析上游调用成功', { model }, requestId)
    return parseBriefJson(textContent)
}

function parseBriefJson(text) {
    const cleaned = text
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim()

    let parsed
    try {
        parsed = JSON.parse(cleaned)
    } catch {
        const match = cleaned.match(/\{[\s\S]*\}/)
        if (!match) {
            throw new Error('AI 返回内容无法解析为结构化字段，请重试或手动填写')
        }
        try {
            parsed = JSON.parse(match[0])
        } catch {
            throw new Error('AI 返回内容无法解析为结构化字段，请重试或手动填写')
        }
    }

    return {
        coreRequirement: typeof parsed.coreRequirement === 'string' ? parsed.coreRequirement.trim() : '',
        visualTone: typeof parsed.visualTone === 'string' ? parsed.visualTone.trim() : '',
        forbidden: typeof parsed.forbidden === 'string' ? parsed.forbidden.trim() : ''
    }
}

function extractImagesFromChoice(choice) {
    const candidates = []

    if (!choice) return candidates

    if (Array.isArray(choice.images)) {
        for (const item of choice.images) {
            const url = item?.image_url?.url
            if (typeof url === 'string' && url.trim()) {
                candidates.push(url.trim())
            }
        }
    }

    const fromContent = extractAllImagesFromContent(choice.content)
    candidates.push(...fromContent)

    // Some providers nest images elsewhere on the message
    const fromChoice = extractAllImagesFromContent(choice)
    candidates.push(...fromChoice)

    // De-dup while keeping order
    const seen = new Set()
    return candidates.filter(item => {
        if (!item) return false
        if (seen.has(item)) return false
        seen.add(item)
        return true
    })
}

function extractImageFromContent(content) {
    if (!content) return null

    // Plain string content that may embed a data URL or markdown link
    if (typeof content === 'string') {
        return extractImageFromString(content)
    }

    // Walk array parts
    if (Array.isArray(content)) {
        for (const part of content) {
            const found = extractImageFromContent(part)
            if (found) return found
        }
        return null
    }

    // Object content with possible image carriers
    if (typeof content === 'object') {
        // Common OpenAI/OpenRouter style
        if (content.type === 'image_url' && content.image_url?.url) {
            return content.image_url.url
        }
        if (content.type === 'response_image_url' && typeof content.url === 'string') {
            return content.url
        }
        if (content.image_url?.url) {
            return content.image_url.url
        }
        if (content.url && typeof content.url === 'string' && isLikelyImageUrl(content.url)) {
            return content.url
        }

        // Gemini style inline_data
        if (content.inline_data?.data) {
            const mime = content.inline_data.mimeType || 'image/png'
            return toDataUrl(content.inline_data.data, mime)
        }

        // Generic base64 fields
        const base64Fields = [content.base64, content.b64_json, content.image_base64, content.data]
        for (const candidate of base64Fields) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return toDataUrl(candidate.trim(), content.mimeType || 'image/png')
            }
        }

        // Text fields that may embed data URL
        if (typeof content.text === 'string') {
            const found = extractImageFromString(content.text)
            if (found) return found
        }

        // Nested collections
        if (content.parts) {
            const found = extractImageFromContent(content.parts)
            if (found) return found
        }
        if (content.content) {
            const found = extractImageFromContent(content.content)
            if (found) return found
        }
    }

    return null
}

function extractAllImagesFromContent(content) {
    if (!content) return []

    if (typeof content === 'string') {
        const found = extractImageFromString(content)
        return found ? [found] : []
    }

    if (Array.isArray(content)) {
        return content.flatMap(part => extractAllImagesFromContent(part))
    }

    if (typeof content === 'object') {
        const hits = []

        if (content.type === 'image_url' && content.image_url?.url) {
            hits.push(content.image_url.url)
        }
        if (content.type === 'response_image_url' && typeof content.url === 'string') {
            hits.push(content.url)
        }
        if (content.image_url?.url) {
            hits.push(content.image_url.url)
        }
        if (typeof content.url === 'string' && isLikelyImageUrl(content.url)) {
            hits.push(content.url)
        }

        if (content.inline_data?.data) {
            const mime = content.inline_data.mimeType || 'image/png'
            hits.push(toDataUrl(content.inline_data.data, mime))
        }

        const base64Fields = [content.base64, content.b64_json, content.image_base64, content.data]
        for (const candidate of base64Fields) {
            if (typeof candidate === 'string' && candidate.trim()) {
                hits.push(toDataUrl(candidate.trim(), content.mimeType || 'image/png'))
            }
        }

        if (typeof content.text === 'string') {
            const fromText = extractImageFromString(content.text)
            if (fromText) hits.push(fromText)
        }

        if (content.parts) {
            hits.push(...extractAllImagesFromContent(content.parts))
        }
        if (content.content) {
            hits.push(...extractAllImagesFromContent(content.content))
        }

        return hits.filter(Boolean)
    }

    return []
}

function extractImageFromString(value) {
    if (!value || typeof value !== 'string') return null

    // Markdown style: ![Generated Image](data:image/...)
    const markdownMatch = value.match(/\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+)\)/)
    if (markdownMatch?.[1]) {
        return markdownMatch[1]
    }

    // Direct data URL
    const dataUrlMatch = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/)
    if (dataUrlMatch?.[0]) {
        return dataUrlMatch[0]
    }

    // Plain URL that might already be hosted
    const httpMatch = value.match(/https?:\/\/[^\s)]+/i)
    if (httpMatch?.[0] && isLikelyImageUrl(httpMatch[0])) {
        return httpMatch[0]
    }

    return null
}

function isLikelyImageUrl(url) {
    return /^https?:\/\//i.test(url) || url.startsWith('data:image/')
}

function getMimeTypeByExtension(extension = 'png') {
    const normalized = String(extension).toLowerCase().replace(/^jpg$/, 'jpeg')
    if (normalized === 'jpeg') return 'image/jpeg'
    if (normalized === 'webp') return 'image/webp'
    if (normalized === 'gif') return 'image/gif'
    return 'image/png'
}

function toDataUrl(base64Content, mimeType = 'image/png') {
    const normalized = base64Content.trim()
    if (normalized.startsWith('data:image/')) {
        return normalized
    }
    const cleaned = normalized.replace(/^base64,/, '')
    return `data:${mimeType};base64,${cleaned}`
}

function extractTextResponse(content) {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content
            .map(part => extractTextResponse(part))
            .filter(Boolean)
            .join('\n')
    }
    if (typeof content === 'object') {
        if (typeof content.text === 'string') return content.text
        if (content.parts) return extractTextResponse(content.parts)
        if (content.content) return extractTextResponse(content.content)
    }
    return ''
}

function filterTextResponse(text) {
    if (!text || typeof text !== 'string') return ''
    const lines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => {
            if (/data:image\//i.test(line)) return false
            if (isLikelyImageUrl(line)) return false
            if (/\[generated\s*image\]/i.test(line)) return false
            // very long base64-like strings
            if (/[A-Za-z0-9+/]{80,}={0,2}/.test(line)) return false
            return true
        })
    return lines.join('\n')
}

async function persistGalleryEntry(
    { prompt, responseText, imageSource, imageCandidates, configLabel, configId, modelId, aspectRatio, imageSize, mode, styleId, brandBrief },
    requestId,
    { includeImageData } = { includeImageData: false },
    onStage
) {
    onStage?.('downloading')
    const candidates = Array.isArray(imageCandidates) && imageCandidates.length ? imageCandidates : [imageSource].filter(Boolean)
    const { fileName, imagePath, thumbnailPath, imageData } = await saveImagesToGallery(
        candidates,
        requestId,
        { includeImageData },
        stage => onStage?.(stage)
    )
    onStage?.('writing_index')
    const entries = await loadGallery()
    const entry = {
        id: uuid(),
        prompt,
        responseText: responseText || '',
        imagePath,
        thumbnailPath,
        fileName,
        configLabel,
        configId,
        modelId: modelId || '',
        aspectRatio: aspectRatio || '',
        imageSize: imageSize || '',
        mode: mode || 'standard',
        styleId: styleId || '',
        brandBrief: brandBrief || null,
        // 模块⑥人工审核：新生成的图默认待审核，通过/驳回后回填结果，驳回原因用于反哺风格库。
        reviewStatus: 'pending',
        rejectReason: '',
        reviewNote: '',
        reviewedAt: '',
        createdAt: new Date().toISOString()
    }
    entries.unshift(entry)
    await saveGallery(entries)
    logInfo('图库', `已写入 gallery.json，记录 ${entry.id}`, { fileName, thumbnailPath }, requestId)
    return { entry, imageData }
}

async function saveImagesToGallery(imageSources, requestId, { includeImageData } = { includeImageData: false }, onStage) {
    onStage?.('downloading')
    const downloads = []
    for (const source of imageSources) {
        try {
            downloads.push(await downloadImage(source))
        } catch (error) {
            logError('图库', '下载候选图片失败，将跳过该候选', error, requestId)
        }
    }

    if (!downloads.length) {
        throw new Error('无法下载生成的图片')
    }

    downloads.sort((a, b) => b.byteLength - a.byteLength)
    onStage?.('selecting_primary')
    const primary = downloads[0]
    const smallest = downloads[downloads.length - 1]
    logInfo(
        '图库',
        `候选图片已下载 ${downloads.length} 张，将选择最大作为主图`,
        { sizes: downloads.map(item => item.byteLength) },
        requestId
    )

    const extension = primary.extension || 'png'
    const fileName = `${Date.now()}-${uuid()}.${extension}`
    const filePath = path.join(GALLERY_DIR, fileName)
    onStage?.('writing_image')
    await fs.promises.writeFile(filePath, primary.buffer)

    const thumbnailFileName = `thumb-${fileName}`
    const thumbnailFsPath = path.join(THUMBNAILS_DIR, thumbnailFileName)

    const hasDistinctSmall = downloads.length > 1 && smallest.byteLength < primary.byteLength * 0.8
    onStage?.('generating_thumbnail')
    if (hasDistinctSmall) {
        try {
            await sharp(smallest.buffer)
                .resize(400, 400, { fit: 'cover', position: 'center' })
                .toFile(thumbnailFsPath)
        } catch (error) {
            logError('图库', '写入候选缩略图失败，将回退为本地生成', error, requestId)
            await generateThumbnailFromPrimary(primary.buffer, thumbnailFsPath, requestId)
        }
    } else {
        await generateThumbnailFromPrimary(primary.buffer, thumbnailFsPath, requestId)
    }
    logInfo(
        '图库',
        '图片已落盘',
        { imagePath: `/gallery/${fileName}`, thumbnailPath: `/gallery/thumbnails/${thumbnailFileName}` },
        requestId
    )

    return {
        fileName,
        imagePath: `/gallery/${fileName}`,
        thumbnailPath: `/gallery/thumbnails/${thumbnailFileName}`,
        imageData: includeImageData ? `data:image/${extension};base64,${primary.buffer.toString('base64')}` : null
    }
}

async function downloadImage(imageSource) {
    let buffer
    let extension = 'png'
    let mimeType = 'image/png'

    if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
        const match = imageSource.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/)
        if (match) {
            extension = match[1]
            mimeType = getMimeTypeByExtension(match[1])
            buffer = Buffer.from(match[2], 'base64')
        } else {
            throw new Error('无法解析 data URL 图片')
        }
    } else {
        const response = await fetch(imageSource)
        if (!response.ok) {
            throw new Error('无法下载生成的图片')
        }
        const contentType = response.headers.get('content-type')
        if (contentType && contentType.includes('/')) {
            extension = contentType.split('/')[1].split(';')[0]
            mimeType = contentType.split(';')[0]
        }
        buffer = Buffer.from(await response.arrayBuffer())
    }

    return { buffer, extension, mimeType, byteLength: buffer.length }
}

async function generateThumbnailFromPrimary(buffer, thumbnailPath, requestId) {
    try {
        await sharp(buffer)
            .resize(400, 400, { fit: 'cover', position: 'center' })
            .toFile(thumbnailPath)
    } catch (error) {
        logError('图库', '生成缩略图失败，将回退为直接写入原图', error, requestId)
        await fs.promises.writeFile(thumbnailPath, buffer).catch(() => {})
    }
}


// 模块⑥人工审核：驳回原因清单固定为这7类，跟发布的团队决议文档保持一致。
const REJECT_REASONS = ['主体特征不符', '环境基调不符', '构图不对', '色彩不对', '出现禁用元素', '主体变形/瑕疵', '其他']

app.patch('/api/gallery/:id/review', authMiddleware, async (req, res) => {
    const { status, rejectReason, note } = req.body || {}
    if (!['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ message: 'status 必须是 approved / rejected / pending' })
    }
    if (status === 'rejected' && !REJECT_REASONS.includes(rejectReason)) {
        return res.status(400).json({ message: '请选择有效的驳回原因分类' })
    }

    try {
        const entries = await loadGallery()
        const index = entries.findIndex(entry => entry.id === req.params.id)
        if (index === -1) {
            return res.status(404).json({ message: '图库记录不存在' })
        }
        entries[index] = {
            ...entries[index],
            reviewStatus: status,
            rejectReason: status === 'rejected' ? rejectReason : '',
            reviewNote: status === 'pending' ? '' : typeof note === 'string' ? note.trim() : '',
            reviewedAt: status === 'pending' ? '' : new Date().toISOString()
        }
        await saveGallery(entries)
        logInfo(
            '审核',
            `图库记录 ${req.params.id} 已${status === 'approved' ? '通过' : '驳回'}`,
            { rejectReason: entries[index].rejectReason },
            req.requestId
        )
        res.json({ entry: entries[index] })
    } catch (error) {
        logError('审核', '更新审核状态失败', error, req.requestId)
        res.status(500).json({ message: '更新审核状态失败' })
    }
})

app.delete('/api/gallery/:id', authMiddleware, async (req, res) => {
    try {
        const entries = await loadGallery()
        const index = entries.findIndex(entry => entry.id === req.params.id)
        if (index === -1) {
            return res.status(404).json({ message: '图库记录不存在' })
        }
        const removed = entries.splice(index, 1)[0]
        await saveGallery(entries)
        if (removed.fileName) {
            const filePath = path.join(GALLERY_DIR, removed.fileName)
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath).catch(() => null)
            }
            const thumbnailPath = path.join(THUMBNAILS_DIR, `thumb-${removed.fileName}`)
            if (fs.existsSync(thumbnailPath)) {
                await fs.promises.unlink(thumbnailPath).catch(() => null)
            }
        }
        logInfo('图库', `已删除图库记录 ${removed.id}`, { fileName: removed.fileName }, req.requestId)
        res.json({ entry: removed })
    } catch (error) {
        logError('图库', '删除图库记录失败', error, req.requestId)
        res.status(500).json({ message: '删除图库记录失败' })
    }
})

if (fs.existsSync(DIST_DIR)) {
    app.get(['/webui', '/webui/*'], (_req, res) => {
        res.sendFile(path.join(DIST_DIR, 'index.html'))
    })
}

app.listen(PORT, () => {
    console.log(`[server] 服务已启动，端口 ${PORT}`)
})
