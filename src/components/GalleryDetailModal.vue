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
                            <div class="flex gap-2">
                                <BaseButton
                                    @click="download(entry.imagePath)"
                                    variant="primary"
                                    block
                                    icon="⬇️"
                                >
                                    下载原图
                                </BaseButton>
                                <BaseButton @click="$emit('edit-image')" variant="secondary" block icon="🖌️">
                                    编辑
                                </BaseButton>
                            </div>
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

                    <div class="bg-dark-bg border border-dark-border rounded-xl p-4 space-y-3">
                        <div class="flex items-center justify-between flex-wrap gap-2">
                            <h4 class="font-bold text-dark-text flex items-center gap-2">✅ 人工审核</h4>
                            <span :class="['text-xs font-bold px-2 py-0.5 rounded-full', reviewBadgeClass(entry.reviewStatus)]">
                                {{ reviewLabel(entry.reviewStatus) }}
                            </span>
                        </div>

                        <div v-if="!entry.reviewStatus || entry.reviewStatus === 'pending'" class="flex flex-col gap-3">
                            <div class="flex gap-2">
                                <BaseButton variant="primary" class="flex-1" :loading="submitting" @click="handleApprove">
                                    ✅ 通过
                                </BaseButton>
                                <BaseButton variant="secondary" class="flex-1" @click="showRejectForm = !showRejectForm">
                                    ❌ 驳回
                                </BaseButton>
                            </div>
                            <div v-if="showRejectForm" class="flex flex-col gap-2 bg-dark-surface border border-dashed border-dark-border rounded-lg p-3">
                                <p class="text-xs font-bold text-dark-muted">请选择驳回原因（必选）</p>
                                <label v-for="reason in REJECT_REASONS" :key="reason" class="flex items-center gap-2 text-sm text-dark-text cursor-pointer">
                                    <input type="radio" name="reject-reason" :value="reason" v-model="selectedReason" />
                                    {{ reason }}
                                </label>
                                <BaseInput
                                    type="textarea"
                                    v-model="noteText"
                                    label="补充说明（选填）"
                                    :rows="2"
                                    placeholder="比如具体哪里色彩偏了、构图哪里不对"
                                />
                                <BaseButton
                                    variant="primary"
                                    :disabled="!selectedReason"
                                    :loading="submitting"
                                    @click="handleReject"
                                >
                                    提交驳回
                                </BaseButton>
                            </div>
                        </div>

                        <div v-else class="text-sm text-dark-muted space-y-1">
                            <p v-if="entry.reviewStatus === 'rejected'">驳回原因：<span class="text-dark-text font-semibold">{{ entry.rejectReason }}</span></p>
                            <p v-if="entry.reviewNote">补充说明：{{ entry.reviewNote }}</p>
                            <p v-if="entry.reviewedAt">审核时间：{{ formatDate(entry.reviewedAt) }}</p>
                            <BaseButton variant="secondary" class="text-xs py-1 px-2 mt-1" @click="resetToPending">
                                🔁 重新评审
                            </BaseButton>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import { REJECT_REASONS } from '../types'
import type { GalleryEntry } from '../types'

const props = defineProps<{
    visible: boolean
    entry: GalleryEntry | null
    submitting: boolean
}>()

const emit = defineEmits<{
    close: []
    review: [payload: { id: string; status: 'approved' | 'rejected' | 'pending'; rejectReason?: string; note?: string }]
    'edit-image': []
}>()

const showRejectForm = ref(false)
const selectedReason = ref('')
const noteText = ref('')

watch(
    () => props.entry?.id,
    () => {
        showRejectForm.value = false
        selectedReason.value = ''
        noteText.value = ''
    }
)

const handleApprove = () => {
    if (!props.entry) return
    emit('review', { id: props.entry.id, status: 'approved' })
}

const handleReject = () => {
    if (!props.entry || !selectedReason.value) return
    emit('review', { id: props.entry.id, status: 'rejected', rejectReason: selectedReason.value, note: noteText.value })
}

const resetToPending = () => {
    if (!props.entry) return
    emit('review', { id: props.entry.id, status: 'pending' })
}

const modeLabel = (mode?: string) => (mode === 'brand' ? '品牌模式' : '标准模式')
const modeBadgeClass = (mode?: string) =>
    mode === 'brand' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'bg-dark-bg text-dark-muted border border-dark-border'

const reviewLabel = (status?: string) => {
    if (status === 'approved') return '已通过'
    if (status === 'rejected') return '已驳回'
    return '待审核'
}
const reviewBadgeClass = (status?: string) => {
    if (status === 'approved') return 'bg-green-500/20 text-green-400 border border-green-500/40'
    if (status === 'rejected') return 'bg-red-500/20 text-red-400 border border-red-500/40'
    return 'bg-dark-bg text-dark-muted border border-dark-border'
}

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
