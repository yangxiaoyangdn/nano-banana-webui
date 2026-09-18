<template>
    <div class="flex flex-col gap-3">
        <div>
            <h4 class="font-bold text-dark-text">🎯 品牌 Brief 解析</h4>
            <p class="text-xs text-dark-muted">品牌模式专属：粘贴或上传品牌方 brief，AI 提炼要点后人工确认，会跟风格库字段一起参与出图</p>
        </div>

        <BaseInput
            type="textarea"
            v-model="briefText"
            label="拖入品牌方 Brief 文档，或粘贴文字内容"
            placeholder="把品牌方给的需求文档文字粘贴在这里……"
            :rows="4"
        />

        <div class="flex items-center gap-2">
            <input ref="fileInput" type="file" accept=".txt,.md" class="hidden" @change="handleFile" />
            <BaseButton variant="secondary" class="text-sm py-1.5 px-3" @click="fileInput?.click()">
                📄 上传文本文件
            </BaseButton>
            <BaseButton
                variant="primary"
                class="text-sm py-1.5 px-3"
                :disabled="!briefText.trim()"
                :loading="extracting"
                @click="emit('extract', briefText)"
            >
                ✨ {{ fields ? '重新提炼' : '开始提炼' }}
            </BaseButton>
        </div>

        <div v-if="fields" class="flex flex-col gap-3 bg-dark-bg border border-dashed border-dark-border rounded-lg p-4">
            <p class="text-xs font-bold text-dark-accent">✨ AI 提炼结果 · 点击可编辑</p>
            <BaseInput
                type="textarea"
                :modelValue="fields.coreRequirement"
                @update:modelValue="value => updateField('coreRequirement', value)"
                label="核心诉求"
                :rows="2"
            />
            <BaseInput
                type="textarea"
                :modelValue="fields.visualTone"
                @update:modelValue="value => updateField('visualTone', value)"
                label="视觉基调"
                :rows="2"
            />
            <BaseInput
                type="textarea"
                :modelValue="fields.forbidden"
                @update:modelValue="value => updateField('forbidden', value)"
                label="禁忌项"
                :rows="2"
            />
            <p class="text-xs text-dark-muted">
                💡 AI 提炼不保证完全准确，确认无误后再点击"开始生成"，确认内容会同风格库一起参与出图
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import type { BrandBrief } from '../types'

const props = defineProps<{
    extracting: boolean
    fields: BrandBrief | null
}>()

const emit = defineEmits<{
    extract: [briefText: string]
    'update:fields': [value: BrandBrief]
}>()

const briefText = ref('')
const fileInput = ref<HTMLInputElement>()

const handleFile = (event: Event) => {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
        if (typeof e.target?.result === 'string') {
            briefText.value = e.target.result
        }
    }
    reader.readAsText(file)
}

const updateField = (key: keyof BrandBrief, value: string) => {
    if (!props.fields) return
    emit('update:fields', { ...props.fields, [key]: value })
}
</script>
