<template>
    <transition name="fade">
        <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div class="bg-dark-surface border border-dark-border rounded-2xl max-w-3xl w-full max-h-full overflow-y-auto shadow-2xl custom-scrollbar">
                <div class="flex items-center justify-between border-b border-dark-border px-5 py-3 sticky top-0 bg-dark-surface z-10">
                    <h3 class="text-lg font-bold text-dark-text flex items-center gap-2">🖌️ 图片编辑</h3>
                    <BaseButton @click="handleClose" variant="secondary" class="text-sm py-1 px-3">✖️ 关闭</BaseButton>
                </div>

                <div class="p-5 flex flex-col gap-4">
                    <div class="flex bg-dark-bg rounded-lg p-1 border border-dark-border w-fit">
                        <button
                            type="button"
                            @click="mode = 'crop'"
                            :class="['py-1.5 px-4 rounded-md font-bold text-sm transition-all', mode === 'crop' ? 'bg-dark-surfaceHighlight text-dark-accent' : 'text-dark-muted hover:text-dark-text']"
                        >
                            ✂️ 裁剪
                        </button>
                        <button
                            type="button"
                            @click="mode = 'erase'"
                            :class="['py-1.5 px-4 rounded-md font-bold text-sm transition-all', mode === 'erase' ? 'bg-dark-surfaceHighlight text-dark-accent' : 'text-dark-muted hover:text-dark-text']"
                        >
                            🧽 涂抹去除
                        </button>
                    </div>

                    <p class="text-xs text-dark-muted">
                        {{ mode === 'crop' ? '在图片上拖拽画出要保留的区域，确认后直接裁剪。' : '用画笔涂抹想去除的部分（比如杂物、水印），AI 会智能去除并填充背景。' }}
                    </p>

                    <div
                        ref="stageRef"
                        class="relative mx-auto bg-dark-bg rounded-lg overflow-hidden border border-dark-border touch-none select-none"
                        :style="stageStyle"
                        @pointerdown="handlePointerDown"
                        @pointermove="handlePointerMove"
                        @pointerup="handlePointerUp"
                        @pointerleave="handlePointerUp"
                    >
                        <canvas ref="baseCanvasRef" class="absolute inset-0 w-full h-full"></canvas>
                        <canvas v-if="mode === 'erase'" ref="paintCanvasRef" class="absolute inset-0 w-full h-full opacity-50 pointer-events-none"></canvas>
                        <div
                            v-if="mode === 'crop' && cropRect"
                            class="absolute border-2 border-dark-accent bg-dark-accent/10 pointer-events-none"
                            :style="cropRectStyle"
                        ></div>
                    </div>

                    <div v-if="mode === 'erase'" class="flex items-center gap-3">
                        <label class="text-xs font-bold text-dark-muted flex-shrink-0">画笔粗细</label>
                        <input type="range" min="10" max="80" v-model.number="brushSize" class="flex-1" />
                        <BaseButton variant="secondary" class="text-xs py-1 px-2" @click="clearPaint">🗑 清空涂抹</BaseButton>
                    </div>

                    <div class="flex items-center gap-2 justify-end">
                        <BaseButton variant="secondary" @click="handleClose">取消</BaseButton>
                        <BaseButton
                            v-if="mode === 'crop'"
                            variant="primary"
                            :disabled="!cropRect"
                            @click="confirmCrop"
                        >
                            确认裁剪
                        </BaseButton>
                        <BaseButton
                            v-else
                            variant="primary"
                            :disabled="!hasPainted"
                            :loading="submitting"
                            @click="confirmErase"
                        >
                            确认去除
                        </BaseButton>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'

const props = defineProps<{
    visible: boolean
    imageSrc: string
    submitting?: boolean
}>()

const emit = defineEmits<{
    close: []
    'confirm-crop': [dataUrl: string]
    'confirm-erase': [payload: { annotatedDataUrl: string; maskDataUrl: string }]
}>()

const mode = ref<'crop' | 'erase'>('crop')
const stageRef = ref<HTMLDivElement>()
const baseCanvasRef = ref<HTMLCanvasElement>()
const paintCanvasRef = ref<HTMLCanvasElement>()
const brushSize = ref(30)
const hasPainted = ref(false)

const naturalWidth = ref(0)
const naturalHeight = ref(0)
const displayWidth = ref(0)
const displayHeight = ref(0)

const stageStyle = ref<Record<string, string>>({})

const isPointerDown = ref(false)
const cropStart = ref<{ x: number; y: number } | null>(null)
const cropRect = ref<{ x: number; y: number; w: number; h: number } | null>(null)

const cropRectStyle = computed(() => {
    if (!cropRect.value) return {}
    return {
        left: `${cropRect.value.x}px`,
        top: `${cropRect.value.y}px`,
        width: `${cropRect.value.w}px`,
        height: `${cropRect.value.h}px`
    }
})

const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = src
    })

const setupStage = async () => {
    if (!props.imageSrc) return
    const img = await loadImage(props.imageSrc)
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight

    const maxWidth = Math.min(640, window.innerWidth - 80)
    const maxHeight = Math.min(window.innerHeight * 0.55, 640)
    const scale = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1)
    displayWidth.value = Math.round(img.naturalWidth * scale)
    displayHeight.value = Math.round(img.naturalHeight * scale)
    stageStyle.value = { width: `${displayWidth.value}px`, height: `${displayHeight.value}px` }

    await nextTick()
    ;[baseCanvasRef.value, paintCanvasRef.value].forEach(canvas => {
        if (!canvas) return
        canvas.width = displayWidth.value
        canvas.height = displayHeight.value
    })

    const baseCtx = baseCanvasRef.value?.getContext('2d')
    baseCtx?.drawImage(img, 0, 0, displayWidth.value, displayHeight.value)

    cropRect.value = null
    hasPainted.value = false
    const paintCtx = paintCanvasRef.value?.getContext('2d')
    paintCtx?.clearRect(0, 0, displayWidth.value, displayHeight.value)
}

watch(
    () => [props.visible, props.imageSrc],
    () => {
        if (props.visible) {
            mode.value = 'crop'
            void setupStage()
        }
    },
    { immediate: true }
)

watch(mode, () => {
    if (mode.value === 'erase') {
        nextTick(() => {
            const paintCtx = paintCanvasRef.value?.getContext('2d')
            paintCtx?.clearRect(0, 0, displayWidth.value, displayHeight.value)
            hasPainted.value = false
        })
    }
})

const getStagePoint = (event: PointerEvent) => {
    const rect = stageRef.value?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
        x: Math.min(Math.max(event.clientX - rect.left, 0), displayWidth.value),
        y: Math.min(Math.max(event.clientY - rect.top, 0), displayHeight.value)
    }
}

const handlePointerDown = (event: PointerEvent) => {
    isPointerDown.value = true
    const point = getStagePoint(event)
    if (mode.value === 'crop') {
        cropStart.value = point
        cropRect.value = { x: point.x, y: point.y, w: 0, h: 0 }
    } else {
        paintAt(point)
    }
}

const handlePointerMove = (event: PointerEvent) => {
    if (!isPointerDown.value) return
    const point = getStagePoint(event)
    if (mode.value === 'crop' && cropStart.value) {
        const x = Math.min(cropStart.value.x, point.x)
        const y = Math.min(cropStart.value.y, point.y)
        const w = Math.abs(point.x - cropStart.value.x)
        const h = Math.abs(point.y - cropStart.value.y)
        cropRect.value = { x, y, w, h }
    } else if (mode.value === 'erase') {
        paintAt(point)
    }
}

const handlePointerUp = () => {
    isPointerDown.value = false
    cropStart.value = null
    if (cropRect.value && (cropRect.value.w < 4 || cropRect.value.h < 4)) {
        cropRect.value = null
    }
}

const paintAt = (point: { x: number; y: number }) => {
    const ctx = paintCanvasRef.value?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ef4444'
    ctx.beginPath()
    ctx.arc(point.x, point.y, brushSize.value / 2, 0, Math.PI * 2)
    ctx.fill()
    hasPainted.value = true
}

const clearPaint = () => {
    const ctx = paintCanvasRef.value?.getContext('2d')
    ctx?.clearRect(0, 0, displayWidth.value, displayHeight.value)
    hasPainted.value = false
}

const confirmCrop = async () => {
    if (!cropRect.value) return
    const img = await loadImage(props.imageSrc)
    const scaleX = naturalWidth.value / displayWidth.value
    const scaleY = naturalHeight.value / displayHeight.value

    const output = document.createElement('canvas')
    output.width = Math.round(cropRect.value.w * scaleX)
    output.height = Math.round(cropRect.value.h * scaleY)
    const ctx = output.getContext('2d')
    if (!ctx) return
    ctx.drawImage(
        img,
        cropRect.value.x * scaleX,
        cropRect.value.y * scaleY,
        cropRect.value.w * scaleX,
        cropRect.value.h * scaleY,
        0,
        0,
        output.width,
        output.height
    )
    emit('confirm-crop', output.toDataURL('image/png'))
}

const confirmErase = async () => {
    if (!paintCanvasRef.value) return
    const img = await loadImage(props.imageSrc)

    // 标注版：原图 + 半透明红色涂抹痕迹叠加，给不支持真正蒙版参数的对话式模型当"这里要去掉"的参考图。
    const annotated = document.createElement('canvas')
    annotated.width = naturalWidth.value
    annotated.height = naturalHeight.value
    const annotatedCtx = annotated.getContext('2d')
    if (!annotatedCtx) return
    annotatedCtx.drawImage(img, 0, 0, naturalWidth.value, naturalHeight.value)
    annotatedCtx.globalAlpha = 0.6
    annotatedCtx.drawImage(paintCanvasRef.value, 0, 0, naturalWidth.value, naturalHeight.value)
    annotatedCtx.globalAlpha = 1

    // 蒙版：透明区域 = 要编辑/去除的区域，不透明区域 = 保持原样，符合 OpenAI images/edits 的 mask 语义。
    const mask = document.createElement('canvas')
    mask.width = naturalWidth.value
    mask.height = naturalHeight.value
    const maskCtx = mask.getContext('2d')
    if (!maskCtx) return
    maskCtx.fillStyle = '#ffffff'
    maskCtx.fillRect(0, 0, mask.width, mask.height)
    maskCtx.globalCompositeOperation = 'destination-out'
    maskCtx.drawImage(paintCanvasRef.value, 0, 0, mask.width, mask.height)

    emit('confirm-erase', {
        annotatedDataUrl: annotated.toDataURL('image/png'),
        maskDataUrl: mask.toDataURL('image/png')
    })
}

const handleClose = () => {
    emit('close')
}
</script>
