<template>
    <transition name="fade">
        <div v-if="visible && entry" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div class="bg-dark-surface border border-dark-border rounded-2xl max-w-5xl w-full max-h-full overflow-y-auto shadow-2xl custom-scrollbar">
                <div class="flex items-center justify-between border-b border-dark-border px-6 py-4 sticky top-0 bg-dark-surface z-10">
                    <h3 class="text-xl font-bold text-dark-text flex items-center gap-2">📝 作品详情</h3>
                    <BaseButton @click="$emit('close')" variant="secondary" class="text-sm py-1 px-3">✖️ 关闭</BaseButton>
                </div>
                <div class="p-6 space-y-6">
                    <div class="w-full bg-dark-bg rounded-xl border border-dark-border p-1">
                        <img :src="entry.imagePath" :alt="entry.prompt" class="w-full h-auto rounded-lg" />
                    </div>
                    <div class="grid md:grid-cols-2 gap-6 text-sm">
                        <div class="space-y-3 bg-dark-bg p-4 rounded-xl border border-dark-border">
                            <p class="text-dark-muted flex justify-between items-center">
                                <span>🏷️ 出图模式</span>
                                <span :class="['text-xs font-bold px-2 py-0.5 rounded-full', modeBadgeClass(entry.mode)]">{{ modeLabel(entry.mode) }}</span>
                            </p>
                            <p class="text-dark-muted flex justify-between"><span>🕒 生图时间</span> <span class="font-bold text-dark-text">{{ formatDate(entry.createdAt) }}</span></p>
                            <p class="text-dark-muted flex justify-between"><span>🔑 使用 API</span> <span class="font-bold text-dark-text">{{ entry.configLabel }}</span></p>
                            <p class="text-dark-muted flex justify-between"><span>🧠 使用模型</span> <span class="font-bold text-dark-text">{{ entry.modelId || '未记录' }}</span></p>
                        </div>
                        <div class="space-y-3 bg-dark-bg p-4 rounded-xl border border-dark-border">
                            <p class="text-dark-muted flex justify-between"><span>📐 画幅比</span> <span class="font-bold text-dark-text">{{ entry.aspectRatio || '未记录' }}</span></p>
                            <p class="text-dark-muted flex justify-between"><span>🖼️ 分辨率</span> <span class="font-bold text-dark-text">{{ entry.imageSize || '未记录' }}</span></p>
                            <BaseButton
                                @click="download(entry.imagePath)"
                                variant="primary"
                                block
                                icon="⬇️"
                            >
                                下载原图
                            </BaseButton>
                        </div>
                    </div>
                    <div>
                        <h4 class="font-bold mb-2 text-dark-text flex items-center gap-2">🎯 提示词</h4>
                        <p class="bg-dark-bg border border-dashed border-dark-border rounded-lg p-4 text-sm text-dark-muted whitespace-pre-line leading-relaxed">{{ entry.prompt }}</p>
                    </div>
                    <div v-if="entry.responseText">
                        <h4 class="font-bold mb-2 text-dark-text flex items-center gap-2">🤖 模型返回</h4>
                        <p class="bg-dark-bg border border-dashed border-dark-border rounded-lg p-4 text-sm text-dark-muted whitespace-pre-line leading-relaxed">{{ entry.responseText }}</p>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script setup lang="ts">
import BaseButton from './BaseButton.vue'
import type { GalleryEntry } from '../types'

const props = defineProps<{
    visible: boolean
    entry: GalleryEntry | null
}>()

defineEmits<{
    close: []
}>()

const modeLabel = (mode?: string) => (mode === 'brand' ? '品牌模式' : '标准模式')
const modeBadgeClass = (mode?: string) =>
    mode === 'brand' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'bg-dark-bg text-dark-muted border border-dark-border'

const formatDate = (value: string) => {
    try {
        const date = new Date(value)
        return date.toLocaleString()
    } catch {
        return value
    }
}

const download = async (path: string) => {
    if (!path) return
    const link = document.createElement('a')
    link.href = path
    link.download = `gallery-${Date.now()}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
}
</script>
